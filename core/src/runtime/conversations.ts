import type { Args, EventResult, Frozen } from 'claude-code'
import { coreVersion, dataFolder, isObject, serveSocketPath } from '../records.js'
import { Message, rowOfAppend, type Row } from '../session/context/turn/message/message.js'
import { modNote, Note } from '../session/context/turn/message/note.js'
import { Person } from '../session/context/turn/message/sender.js'
import { createConversation, emptyConversation, ownerOfSpawn, tasksWithAgents, type Conversation, type ConversationState, type ContextData, type SessionChange, type SessionData, type TaskData, type TurnData, type TurnEnding } from '../session/conversation.js'
import { Session, UsageChange, type BeforeEvent, type Surface, type SessionSend, type TaskStartArgs, type ToolCallArgs } from '../session/session.js'
import { GoalChange } from '../session/goal/goal.js'
import { TurnEnd, TurnStart } from '../session/context/turn/turn.js'
import { TaskStart } from '../session/goal/task.js'
import { receivedMatcher } from '../utils/matcher.js'
import { resolve } from '../vendor.js'
import { ifMissing } from '../utils/paths.js'
import { messageOf } from '../utils/text.js'
import { beforeAnswerKeys, foldBefore, installBefore, relayOf, type Decide, type Place } from './before.js'
import type { Claude } from './claude.js'
import { listenerMs } from './deadline.js'
import { cmodPluginName, isNotInstalled } from './dependencies.js'
import { interfaceListeners, readProviders, sessionActs, sessionInterface, sessionStore, type Provider, type SessionListening, type StoreChange } from './interfaces.js'
import { runCmod } from './programs.js'
import { addressCall, connectRpc, RpcError, rpcCodes, type RpcClient } from './rpc.js'
import type { RoutedHook, Router } from './router.js'
import { conversationMethods, everySession, isAct, isHeardBy, isInScope, pickedColor, resultOf, spawnTask, usageOf, type Act, type Listened, type Scope, type SessionColor } from './sessions.js'

type Request = Readonly<Record<string, unknown>>

type Heard = { readonly event: Listened['event']; readonly matcher: unknown }

type Watch = { readonly mod: string; readonly target: string; readonly project: string; readonly list: readonly Listened[] }

type Relay =
  | { readonly kind: 'act'; readonly id: string; readonly from: string; readonly caller: string; readonly action: Act; readonly input: unknown; readonly task?: string }
  | { readonly kind: 'goal'; readonly task?: string; readonly text: string }
  | { readonly kind: 'taskEnd'; readonly task: TaskData }

const relayKinds: ReadonlySet<unknown> = new Set(['act', 'goal', 'taskEnd'] satisfies Relay['kind'][])

const taskVariable = 'CMOD_TASK'

const isRelay = (value: unknown): value is Relay => isObject(value) && relayKinds.has(value['kind'])

const bufferedTaskRows = 200

const askGraceMs = 1000

const providersMs = 30_000

export type Conversations = {
  answer(e: Frozen<Args<'cmod.call'>> & { readonly caller?: string }): Promise<EventResult<'cmod.call'> | undefined>
  moved(): void
  turnClosedBy(rowId: string): TurnData | undefined
  color(): SessionColor
  onColor(listener: (told: SessionColor) => void): void
  listens(): boolean
  onUnreached(listener: () => void): void
  close(): Promise<void>
}

const keptClosings = 200

const keptMessages = 200

type Kept = { readonly subscribed: Readonly<Record<string, Readonly<Record<string, readonly Listened[]>>>>; readonly watched: Readonly<Record<string, Readonly<Record<string, readonly Listened[]>>>> }

type Registered = { remove(): void }

export function serveConversations({
  claude,
  router,
  store,
  project,
  report,
  clear,
  keepsConnecting = true,
}: {
  readonly claude: Claude
  readonly router: Router
  readonly store: string
  readonly project: () => string
  readonly report: (id: string, message: string, error: unknown) => void
  readonly clear: (id: string) => void
  readonly keepsConnecting?: boolean
}): Conversations {
  const folder = dataFolder(store, cmodPluginName)
  const goals = `${folder}/goals`
  const backgroundTasks = `${folder}/tasks`
  const listeners = `${folder}/listeners`
  const heard = new Map<string, Map<string, readonly Heard[]>>()
  const subscribed = new Map<string, Map<string, readonly Listened[]>>()
  const watched = new Map<string, Watch>()
  const registered = new Map<string, Registered[]>()
  let remote: readonly SessionListening[] = []
  let listenerFiles: Promise<unknown> = Promise.resolve()
  let session = ''
  let conversation: Conversation = createConversation(emptyConversation(''))
  let starting: Promise<void> = Promise.resolve()
  let listening: Promise<void> = Promise.resolve()
  let hasHeardListeners = false
  let live: Message[] = []
  const liveIds = new Set<string>()
  const waitingRows = new Map<string, Row[]>()
  const engineTurns = new Map<string, string>()
  let endsAfterTurn = false
  router.add('turn.start', async (e, next) => {
    const agent = (e as typeof e & { readonly agentId?: string }).agentId ?? ''
    engineTurns.set(agent, e.turnId)
    return next(e)
  })
  const endTurn = (ending: TurnEnding, task?: string) => <Below extends { readonly block?: string }>(below: Below, isInterrupted = false): Below => {
    if (below.block !== undefined) return below
    engineTurns.delete(task ?? '')
    if (!isInterrupted) dispatch(session, conversation.endTurn(new Date().toISOString(), ending, task))
    if (task === undefined && endsAfterTurn) claude.clock.after(0, () => void exitNow())
    return below
  }
  router.add('classic.Stop', async (e, next) => endTurn({ reason: 'answer', ...(e.last_assistant_message === undefined ? {} : { answer: e.last_assistant_message }) })(await next(e), next.signal.aborted))
  router.add('classic.StopFailure', async (e, next) => endTurn({ reason: 'error', failure: { type: String(e.error), text: e.error_details ?? e.last_assistant_message ?? String(e.error) } })(await next(e)))
  router.add('classic.SubagentStop', async (e, next) => endTurn({ reason: 'answer', ...(e.last_assistant_message === undefined ? {} : { answer: e.last_assistant_message }) }, e.agent_id)(await next(e), next.signal.aborted))
  router.add('classic.Stop', async (e, next) => {
    const below = await next(e)
    if (below.block === undefined && !next.signal.aborted) void answerTask().catch((error: unknown) => report('task', 'Could not record that this session answered its task', error))
    return below
  })

  const ended = (id: string) => new Error(`session ${id} has ended`)

  const call = (address: string) => addressCall((url, init) => claude.http.fetch(url, init), address)

  const held = interfaceListeners({ report: (error) => report('listen', 'A listener on another session missed an event', error) })

  const handle = async (method: string, params: unknown, signal: AbortSignal): Promise<unknown> => {
    const answered = await held.handler(method, params, signal)
    if (answered !== undefined) return answered.result
    if (method === sessionActs.listeners) {
      const told = params as { readonly session: string; readonly list: readonly SessionListening[] }
      if (told.session === session) remote = told.list
      return null
    }
    if (method === sessionActs.act) {
      const { action, input, caller, task } = params as { readonly action: string; readonly input: unknown; readonly caller?: string; readonly task?: string }
      if (!isAct(action)) throw new RpcError(rpcCodes.methodNotFound, (await unknownTo(`"${action}" action`)).message)
      return perform(caller ?? cmodPluginName, action, input, task)
    }
    throw new RpcError(rpcCodes.methodNotFound, `The cmod plugin of session ${session} answers no ${method}.`)
  }

  const holdHere = async (client: RpcClient) => {
    if (session === '') return
    await client.request(sessionActs.hold, { session, project: project(), cwd: await claude.session.cwd() })
  }

  let storeChanges: Registered | undefined
  let isUnreached = false
  let unreached: () => void = () => undefined
  const local: { readonly client: RpcClient } = {
    client: connectRpc({
      call: call(`unix:${serveSocketPath(store)}`),
      handle,
      onConnect: async (client) => {
        isUnreached = false
        await holdHere(client)
        await held.replay(client)
        await reconcileTasks()
      },
      onError: (error) => {
        claude.ui.warn('serve:connect', `cmod: this session waits for cmod serve: ${messageOf(error)}`)
        isUnreached = true
        unreached()
      },
      wait: (ms) => new Promise<void>((resolve) => void claude.clock.after(ms, resolve)),
      keepsConnecting,
    }),
  }

  const others = new Map<string, { readonly provider: Provider; readonly client: RpcClient }>()
  let othersReadAt = Number.NEGATIVE_INFINITY
  const otherStores = async () => {
    const now = await claude.clock.now()
    if (now - othersReadAt < providersMs) return [...others.values()]
    othersReadAt = now
    const files = { list: (path: string) => claude.fs.list(path).catch(ifMissing([])), read: (path: string) => claude.fs.read(path).catch(ifMissing(undefined)) }
    const found = (await readProviders(files, store, sessionStore)).filter((provider) => provider.mod !== cmodPluginName)
    for (const [key, each] of others) {
      if (found.some((provider) => provider.address === key)) continue
      others.delete(key)
      void each.client.close()
    }
    for (const provider of found) {
      if (others.has(provider.address)) continue
      const client = connectRpc({ call: call(provider.address), handle, onConnect: (connected) => held.replay(connected), wait: (ms) => new Promise<void>((resolve) => void claude.clock.after(ms, resolve)) })
      others.set(provider.address, { provider, client })
    }
    return [...others.values()]
  }

  const stores = async () => [local.client, ...(await otherStores()).map((each) => each.client)]

  const isNotHeld = (error: unknown) => error instanceof RpcError && error.code === rpcCodes.notHeld

  const firstHolding = async <Value>(ask: (client: RpcClient) => Promise<Value>): Promise<{ readonly value: Value; readonly client: RpcClient }> => {
    let last: unknown
    for (const client of await stores()) {
      try {
        return { value: await ask(client), client }
      } catch (error) {
        if (!isNotHeld(error)) throw error
        last = error
      }
    }
    throw last instanceof Error ? last : new Error(String(last))
  }

  const read = async <Value>(id: string, part: string, options: Request = {}): Promise<Value> => (await firstHolding((client) => client.request<Value>(`${sessionStore}.read`, [id, part, { project: project(), ...options }]))).value

  const listAll = async (scope: Request): Promise<SessionData[]> => {
    const lists = await Promise.all((await stores()).map((client) => client.request<SessionData[]>(`${sessionStore}.sessions`, [scope]).catch((error: unknown) => (client === local.client ? Promise.reject(error) : (report('store', 'Lists no sessions of another store', error), [])))))
    const seen = new Set<string>()
    return lists.flat().filter((each) => !seen.has(each.id) && Boolean(seen.add(each.id)))
  }

  const actOn = async (target: string, action: Act, input: unknown, context: Request) => (await firstHolding((client) => client.request(`${sessionInterface}.${action}`, [target, input, { project: project(), ...context }]))).value

  let color: SessionColor = { session: '' }
  let onColor: (told: SessionColor) => void = () => undefined

  const recolor = (id: string, picked: string | undefined) => {
    if (session !== id) return
    color = { session: id, ...(picked === undefined ? {} : { color: picked }) }
    onColor(color)
  }

  const readColor = (id: string) =>
    void listAll({ project: project(), everyProject: true, running: true })
      .then((running) => recolor(id, running.find((each) => each.id === id)?.color))
      .catch((error: unknown) => report('color', `Could not read the color of session ${id}`, error))

  router.add('command.run', async (e, next) => {
    const answer = await next(e)
    if (e.command !== 'color' || session === '') return answer
    if (e.args.trim() === '') readColor(session)
    else recolor(session, pickedColor(e.args))
    return answer
  })

  const isUnderHere = (task: string, ancestor: string) => {
    for (let at: string | undefined = task, steps = 0; at !== undefined && steps < 64; at = conversation.state.tasks[at]?.parent, steps += 1) if (at === ancestor) return true
    return false
  }

  const remoteHears = (listening: SessionListening, change: SessionChange) => {
    const scope = (listening.extra['scope'] ?? {}) as Scope
    return isHeardBy(listening.event as Listened['event'], listening.matcher === undefined ? undefined : receivedMatcher(listening.matcher), change) && isInScope({ ...scope, session }, session, change, isUnderHere)
  }

  let lastTurn: TurnData | undefined
  const closings = new Map<string, TurnData>()
  const dispatch = (to: string, changes: readonly SessionChange[], isInProject = true) => {
    for (const change of changes) {
      if (to === session && (change.type === TurnStart || change.type === TurnEnd) && change.turn.prompt.task === undefined) lastTurn = change.turn
      if (change.type === Message && !liveIds.has(change.message.id) && to === session) {
        live.push(change.message)
        liveIds.add(change.message.id)
        if (live.length > keptMessages) liveIds.delete(live.shift()?.id ?? '')
      }
      for (const [mod, sessions] of heard) {
        const subscriptions = [...(sessions.get(to) ?? []), ...(isInProject ? (sessions.get(everySession) ?? []) : [])]
        if (!subscriptions.some(({ event, matcher }) => isHeardBy(event, matcher, change))) continue
        void claude.cmod.call({ to: mod, method: conversationMethods.changed, input: { session: to, change, isInProject } }).then(
          () => clear(`changed:${mod}`),
          (error: unknown) => (isNotInstalled(mod, error) ? forgetMod(mod) : report(`changed:${mod}`, `Could not tell ${mod} about session ${to}`, error)),
        )
      }
      if (to !== session) continue
      for (const listening of remote) {
        if (listening.kind !== 'on' || !remoteHears(listening, change)) continue
        local.client.notify(sessionActs.emit, { id: listening.id, payload: { session, change, isInProject: listening.isEvery || listening.extra['project'] === project() } })
      }
    }
  }

  const post = async (to: string, relay: unknown) => {
    const sent = await claude.session.send({ to: { sessionId: to }, text: `<cmod-relay>${JSON.stringify(relay)}</cmod-relay>` })
    if (sent.isDelivered !== true) throw ended(to)
  }

  const onListenerFiles = <Value>(work: () => Promise<Value>) => {
    const next = listenerFiles.then(work)
    listenerFiles = next.catch((error: unknown) => claude.ui.warn('listeners:files', `cmod: reading or writing the mods' listeners failed: ${messageOf(error)}`))
    return next
  }

  const keptOf = (): Kept => ({
    subscribed: Object.fromEntries([...subscribed].map(([caller, lists]) => [caller, Object.fromEntries(lists)])),
    watched: [...watched.values()].reduce<Record<string, Record<string, readonly Listened[]>>>((all, watch) => ({ ...all, [watch.mod]: { ...all[watch.mod], [watch.target]: watch.list } }), {}),
  })

  const saveListeners = (isEnding = false) => {
    const at = session
    if (at === '') return Promise.resolve()
    return onListenerFiles(() => claude.fs.write(`${listeners}/${at}.json`, JSON.stringify(isEnding ? ({ subscribed: {}, watched: {} } satisfies Kept) : keptOf())))
  }

  const restoreListeners = () => {
    const at = session
    return onListenerFiles(async () => {
      const read = JSON.parse(await claude.fs.read(`${listeners}/${at}.json`).catch(ifMissing('{}'))) as Partial<Kept>
      for (const [caller, lists] of Object.entries(read.subscribed ?? {})) if (!subscribed.has(caller)) for (const [id, list] of Object.entries(lists)) hear(caller, id, list)
      for (const [caller, targets] of Object.entries(read.watched ?? {})) for (const [target, list] of Object.entries(targets)) if (!watched.has(`${caller}\n${target}`)) watch(caller, target, list)
    })
  }

  const register = (key: string, kind: 'on' | 'before', mod: string, target: string, list: readonly Listened[]) => {
    for (const each of registered.get(`${kind}\n${key}`) ?? []) each.remove()
    registered.delete(`${kind}\n${key}`)
    if (target === session || list.length === 0) return
    const subscriptions = list.map((each) =>
      held.listen(
        local.client,
        {
          interface: sessionInterface,
          event: each.event,
          kind,
          args: [target === everySession ? '*' : target],
          ...(each.matcher === undefined ? {} : { matcher: each.matcher }),
          ...(each.timeoutMs === undefined ? {} : { timeoutMs: each.timeoutMs }),
          ...(each.onFailure === undefined ? {} : { onFailure: each.onFailure }),
          extra: { mod, session, project: project(), ...(each.scope === undefined ? {} : { scope: each.scope }) },
        },
        (payload: { readonly session: string; readonly change: SessionChange; readonly isInProject: boolean; readonly event?: BeforeEvent }) =>
          kind === 'on' ? deliver(mod, payload.session, payload.change, payload.isInProject) : askHere(mod, payload.event ?? (each.event as BeforeEvent), payload.change, payload.session, payload.isInProject),
      ),
    )
    registered.set(`${kind}\n${key}`, subscriptions)
  }

  const deliver = (mod: string, from: string, change: SessionChange, isInProject: boolean) =>
    claude.cmod.call({ to: mod, method: conversationMethods.changed, input: { session: from, change, isInProject } }).then(
      () => clear(`changed:${mod}`),
      (error: unknown) => (isNotInstalled(mod, error) ? forgetMod(mod) : report(`changed:${mod}`, `Could not tell ${mod} about session ${from}`, error)),
    )

  const hear = (caller: string, id: string, list: readonly Listened[]) => {
    const sessions = heard.get(caller) ?? new Map<string, readonly Heard[]>()
    sessions.set(id, list.map(({ event, matcher }) => ({ event, matcher: matcher === undefined ? undefined : receivedMatcher(matcher) })))
    heard.set(caller, sessions)
    const lists = subscribed.get(caller) ?? new Map<string, readonly Listened[]>()
    lists.set(id, list)
    subscribed.set(caller, lists)
    register(`${caller}\n${id}`, 'on', caller, id, list)
  }

  const watch = (caller: string, target: string, list: readonly Listened[]) => {
    const key = `${caller}\n${target}`
    if (list.length === 0) watched.delete(key)
    else watched.set(key, { mod: caller, target, project: project(), list })
    register(key, 'before', caller, target, list)
  }

  const forgetMod = (mod: string) => {
    const wasHeard = heard.delete(mod)
    subscribed.delete(mod)
    clear(`changed:${mod}`)
    for (const [key, each] of registered) {
      if (key.split('\n')[1] !== mod) continue
      for (const subscription of each) subscription.remove()
      registered.delete(key)
    }
    const wasWatching = [...watched.keys()].filter((key) => key.startsWith(`${mod}\n`))
    for (const key of wasWatching) watched.delete(key)
    if (wasHeard || wasWatching.length > 0) void saveListeners().catch((error: unknown) => report('listeners', `Kept the listeners of ${mod}, which left this session`, error))
  }

  const changeGoal = (task: string | undefined, text: string) => dispatch(session, task === undefined ? conversation.changeGoal(text) : [{ type: GoalChange, goal: { text, task } }])

  const place = (): Place => {
    const { context, contextOpenedAt, turn, tasks, taskTurns, openCalls } = conversation.state
    return { session, context, contextOpenedAt, ...(turn === undefined ? {} : { turn }), tasks, taskTurns, ...(openCalls === undefined ? {} : { openCalls }) }
  }

  type Decider = { readonly mod: string; readonly local: true; readonly list: readonly Listened[] } | { readonly mod: string; readonly local: false; readonly listening: SessionListening }

  const deciders = (event: string): Decider[] => {
    const own = [...watched.values()].filter((each) => (each.target === session || each.target === everySession) && each.list.some((listened) => listened.event === event)).map((each): Decider => ({ mod: each.mod, local: true, list: each.list }))
    const unique = [...new Map(own.map((each) => [each.mod, each])).values()]
    return [...unique, ...remote.filter((listening) => listening.kind === 'before' && listening.event === event).map((listening): Decider => ({ mod: String(listening.extra['mod'] ?? ''), local: false, listening }))]
  }

  const askHere = async (mod: string, event: BeforeEvent, change: SessionChange, from = session, isInProject = true) =>
    claude.cmod.call({ to: mod, method: conversationMethods.before, input: { session: from, event, change, isInProject } }).catch((error: unknown) => {
      if (!isNotInstalled(mod, error)) throw error
      forgetMod(mod)
      return undefined
    })

  const askAway = (listening: SessionListening, event: BeforeEvent, change: SessionChange, cancel?: AbortSignal) =>
    new Promise<unknown>((resolve, reject) => {
      const timeoutMs = (listening.timeoutMs ?? listenerMs) + askGraceMs
      const timer = claude.clock.after(timeoutMs, () => reject(new Error(`session ${String(listening.extra['session'])} did not answer within ${timeoutMs / 1000} s`)))
      const stopped = new AbortController()
      cancel?.addEventListener('abort', () => stopped.abort(), { once: true })
      local.client
        .request(sessionActs.ask, { id: listening.id, payload: { session, event, change, isInProject: listening.isEvery || listening.extra['project'] === project() } }, stopped.signal)
        .then(resolve, reject)
        .finally(() => timer.cancel())
    })

  const refuses = (decider: Decider, event: BeforeEvent, change: SessionChange | undefined) => {
    if (!beforeAnswerKeys[event].includes('refuse')) return false
    if (!decider.local) return decider.listening.onFailure === 'refuse' && (change === undefined || remoteHears(decider.listening, change))
    return decider.list.some(({ event: heardEvent, matcher, scope, onFailure }) => onFailure === 'refuse' && (change === undefined ? heardEvent === event : isInScope(scope ?? {}, session, change, isUnderHere) && isHeardBy(heardEvent, matcher === undefined ? undefined : receivedMatcher(matcher), change)))
  }

  const wants = async (event: BeforeEvent) => {
    await listening
    return deciders(event).length > 0
  }

  const failedBefore = (event: BeforeEvent, change: (where: Place) => SessionChange | undefined, error: Error) => {
    if (!hasHeardListeners) return { refuse: `${cmodPluginName}: ${error.message}` }
    const changed = change(place())
    const refusing = deciders(event).find((decider) => refuses(decider, event, changed))
    return refusing === undefined ? undefined : { refuse: `${refusing.mod}: ${error.message}` }
  }

  const decide = (cancel?: AbortSignal): Decide => {
    return (event, change) =>
      foldBefore(
        event,
        change,
        deciders(event).map((decider) => async (latest: SessionChange) => {
          if (cancel?.aborted === true) return undefined
          if (decider.local) return askHere(decider.mod, event, latest)
          if (!remoteHears(decider.listening, latest)) return undefined
          try {
            return await askAway(decider.listening, event, latest, cancel)
          } catch (error) {
            if (refuses(decider, event, latest)) return { refuse: `${decider.mod}: ${messageOf(error)}` }
            throw error
          }
        }),
        (error) => {
          if (cancel?.aborted !== true) report(`before:${event}`, `Passed the ${event} on without a mod's answer`, error)
        },
      )
  }

  const recordCompaction: RoutedHook<'session.compact'> = async (e, next) => {
    const compacted = await next(e)
    if (e.trigger === 'precompute' || compacted.skip !== undefined || session === '') return compacted
    const at = new Date().toISOString()
    const boundary: Row = { id: `compact:${e.agentId ?? session}:${at}`, at, type: 'system', name: 'compact_boundary', isMeta: false, isSummary: false, content: [] }
    void take(boundary, e.agentId).catch((error: unknown) => report('compact', 'Missed a compaction', error))
    return compacted
  }
  router.add('session.compact', recordCompaction, (e, _error, next) => recordCompaction(e, next))

  installBefore({
    claude,
    router,
    hooks: {
      place: async () => {
        await starting
        return place()
      },
      wants,
      fold: decide,
      failedBefore,
    },
  })

  const listenToStore = () => {
    storeChanges?.remove()
    storeChanges = held.listen(local.client, { interface: sessionStore, event: 'Change', kind: 'on', args: [session] }, (change: StoreChange) => {
      if (change.part === 'tasks') void reconcileTasks()
      if (change.part === 'goal') void rereadGoal()
    })
  }

  const start = (id: string, source: string) => {
    if (id === session) return
    const previous = session
    session = id
    live = []
    liveIds.clear()
    waitingRows.clear()
    remote = []
    conversation = createConversation(emptyConversation(id))
    const isNew = source === 'startup' || source === 'clear'
    if (!isNew) readColor(id)
    starting = isNew
      ? Promise.resolve(dispatch(id, conversation.startContext(new Date().toISOString())))
      : read<ConversationState | null>(id, 'state').then(
          (state) => {
            if (session === id && state !== null) conversation = createConversation({ ...emptyConversation(id), ...state })
          },
          (error: unknown) => report('state', `Starts session ${id} without its earlier turns`, error),
        )
    const restored = restoreListeners().catch((error: unknown) => report('listeners', "Could not read back the mods' listeners of this session", error))
    starting = Promise.all([starting, restored]).then(() => undefined)
    hasHeardListeners = false
    const holding = holdHere(local.client).then(
      () => {
        if (session === id) hasHeardListeners = true
      },
      (error: unknown) => claude.ui.warn('serve:hold', `cmod: other sessions reach session ${id} once cmod serve answers: ${messageOf(error)}`),
    )
    listening = Promise.all([restored, holding]).then(() => undefined)
    listenToStore()
    void starting.then(reconcileTasks)
    if (heard.size === 0 && watched.size === 0) return
    const held = [...registered]
    for (const [key, each] of held) {
      const [kind, caller, target] = key.split('\n')
      if (caller === undefined || target === undefined) continue
      for (const subscription of each) subscription.remove()
      registered.delete(key)
      if (kind === 'on') register(`${caller}\n${target}`, 'on', caller, target, subscribed.get(caller)?.get(target) ?? [])
      else register(`${caller}\n${target}`, 'before', caller, target, watched.get(`${caller}\n${target}`)?.list ?? [])
    }
    void Promise.all([previous === '' ? undefined : onListenerFiles(() => claude.fs.write(`${listeners}/${previous}.json`, JSON.stringify({ subscribed: {}, watched: {} } satisfies Kept))), saveListeners()]).catch((error: unknown) => report('follow', 'Kept telling the mods about the session from before', error))
  }

  const reconcileTasks = async () => {
    if (session === '') return
    await starting
    const open = Object.values(conversation.state.tasks).filter((task) => task.isBackground === true && task.closedAt === undefined)
    if (open.length === 0) return
    const saved = await read<TaskData[]>(session, 'tasks').catch((error: unknown) => (report('tasks', 'Could not read whether its background tasks ended', error), []))
    for (const task of saved) {
      const running = conversation.state.tasks[task.id]
      if (running !== undefined && running.closedAt === undefined && task.closedAt !== undefined) dispatch(session, conversation.endTask(task, task.closedAt))
    }
  }

  const rereadGoal = async () => {
    const { text } = await read<{ readonly text: string }>(session, 'goal')
    if (text !== conversation.state.goal) changeGoal(undefined, text)
  }

  const take = async (row: Row, task: string | undefined) => {
    await starting
    if (task !== undefined && conversation.state.tasks[task] === undefined) {
      const waiting = waitingRows.get(task) ?? []
      waiting.push(row)
      waitingRows.set(task, waiting)
      if (waiting.length < bufferedTaskRows) return
      waitingRows.delete(task)
      dispatch(session, conversation.startTask({ id: task, title: '', agentType: 'general-purpose', openedBy: '', openedAt: row.at }))
      for (const each of waiting) dispatch(session, conversation.add(each, task))
      return
    }
    dispatch(session, conversation.add(row, task))
    if (task !== undefined || row.type !== 'system' || row.name !== 'turn_duration' || lastTurn === undefined) return
    closings.set(row.id, lastTurn)
    if (closings.size > keptClosings) closings.delete(closings.keys().next().value as string)
  }

  router.add('classic.SessionStart', async (e, next) => {
    start(e.session_id, e.source)
    return next(e)
  })
  router.add('classic.SessionEnd', async (e, next) => {
    if (subscribed.size > 0 || watched.size > 0) await saveListeners(true).catch((error: unknown) => report('follow', 'Left its listeners registered', error))
    return next(e)
  })

  const recordAppend: RoutedHook<'session.append'> = async (e, next) => {
    const kept = await next(e)
    if (kept.deny !== undefined || session === '' || e.door === 'queue') return kept
    const cwd = e.message.type === 'assistant' ? await claude.session.cwd() : ''
    void take(rowOfAppend({ uuid: kept.uuid, door: e.door, origin: e.origin, message: kept.message }, new Date().toISOString(), cwd), e.agentId).catch((error: unknown) => report('append', 'Missed a message', error))
    return kept
  }
  router.add('session.append', recordAppend, (e, _error, next) => recordAppend(e, next))

  router.add('session.measure', async (e, next) => {
    const measured = await next(e)
    if (session !== '') dispatch(session, [{ type: UsageChange, usage: await usageOf(claude) }])
    return measured
  })

  const recordSpawn: RoutedHook<'agent.spawn'> = async (e, next) => {
    const spawned = await next(e)
    if (spawned.deny !== undefined || spawned.agentId === undefined) return spawned
    const id = spawned.agentId
    await starting
    const opened: TaskData = { id, title: e.description, ...ownerOfSpawn(e.subagentType, session), model: spawned.model, openedBy: e.tool_use_id, openedAt: new Date().toISOString(), ...(e.parentAgentId === undefined ? {} : { parent: e.parentAgentId }) }
    dispatch(session, conversation.startTask(opened))
    const waiting = waitingRows.get(id) ?? []
    waitingRows.delete(id)
    for (const row of waiting) dispatch(session, conversation.add(row, id))
    return spawned
  }
  router.add('agent.spawn', recordSpawn, (e, _error, next) => recordSpawn(e, next))

  router.add('session.receive', async (e, next) => {
    const sent = relayOf(e)
    if (sent === undefined) return next(e)
    const relay = JSON.parse(sent) as unknown
    claude.clock.after(0, () => void (isRelay(relay) ? received(relay) : refuse(relay)).catch((error: unknown) => report('relay', 'Could not answer another session', error)))
    return { consumed: 'cmod relay' }
  })

  const unknownTo = async (what: string) => new Error(`Session ${await claude.session.id()} runs cmod ${coreVersion}, which has no ${what}.`)

  const refuse = async (relay: unknown) => {
    if (!isObject(relay) || typeof relay['id'] !== 'string' || typeof relay['from'] !== 'string') return
    await post(relay['from'], { kind: 'answer', id: relay['id'], deny: (await unknownTo(`"${String(relay['kind'])}" relay`)).message })
  }

  const received = async (relay: Relay) => {
    if (relay.kind === 'goal') {
      await starting
      changeGoal(relay.task, relay.text)
      return
    }
    if (relay.kind === 'taskEnd') {
      await starting
      dispatch(session, conversation.endTask(relay.task, relay.task.closedAt ?? new Date().toISOString()))
      return
    }
    try {
      if (!isAct(relay.action)) throw await unknownTo(`"${String(relay.action)}" action`)
      const value = await perform(relay.caller, relay.action, relay.input, relay.task)
      await post(relay.from, { kind: 'answer', id: relay.id, value: value ?? null })
    } catch (error) {
      await post(relay.from, { kind: 'answer', id: relay.id, deny: messageOf(error) })
    }
  }

  const exitNow = async () => {
    endsAfterTurn = false
    await claude.command.run({ command: 'exit' })
  }

  const perform = async (caller: string, action: Act, input: unknown, task: string | undefined): Promise<unknown> => {
    await starting
    if (action === 'abort') return abortTurn(input, task)
    if (task !== undefined) return performInTask(caller, action, input, task)
    if (action === 'usage') return usageOf(claude)
    if (action === 'surfaces') return [...(await claude.session.surfaces())] satisfies Surface[]
    if (action === 'end') {
      if (engineTurns.has('')) endsAfterTurn = true
      else claude.clock.after(0, () => void exitNow())
      return null
    }
    if (action === 'send') {
      const { type, text, as } = input as SessionSend
      if (as === Session) throw new Error(`session ${session} cannot send as itself to itself.`)
      const delivered = type === Note ? await claude.session.append({ message: { type: 'user', content: [{ type: 'text', text: modNote(caller, text) }] } }) : await claude.prompt.submit({ text, ...(as === Person ? { asUser: true } : {}) })
      if ('deny' in delivered && typeof delivered.deny === 'string') throw new Error(`Claude Code refused the note: ${delivered.deny}`)
      if ('drop' in delivered && typeof delivered.drop === 'string') throw new Error(`Claude Code dropped the prompt: ${delivered.drop}`)
      return null
    }
    if (action === 'startTask') return spawnTask(claude, input as TaskStartArgs)
    if (action === 'startBackgroundTask') return startBackground(input as TaskStartArgs)
    if (action === 'fork' || action === 'clone') {
      const fork = input as TaskStartArgs & { readonly at?: string }
      if (action === 'clone' || fork.isBackground === true) return startBackground(fork, session, fork.at)
      if (fork.at !== undefined) throw new Error('a fork through a message runs as a background session. Add isBackground: true.')
      return spawnTask(claude, fork, session)
    }
    if (action === 'visit' || action === 'delete') return actOn(session, action, input, { caller })
    const { name, input: toolInput } = input as ToolCallArgs
    return resultOf(place(), { name, input: toolInput, cwd: await claude.session.cwd() }, await claude.tool.call({ ...toolInput, tool: name } as never))
  }

  const abortTurn = async (input: unknown, task: string | undefined) => {
    const turnId = engineTurns.get(task ?? '')
    if (turnId === undefined) throw new Error(`no turn is running in ${task === undefined ? `session ${session}` : `task ${task}`}.`)
    const asked = isObject(input) ? input['turn'] : undefined
    const open = task === undefined ? conversation.state.turn : conversation.state.taskTurns[task]
    if (asked !== undefined && open?.prompt.id !== asked) throw new Error(`turn ${String(asked)} has ended, so there is nothing to abort.`)
    await claude.turn.abort({ turnId })
    return null
  }

  const performInTask = async (caller: string, action: Act, input: unknown, task: string): Promise<unknown> => {
    const running = conversation.state.tasks[task]
    if (action === 'usage') return read(session, 'usage', { task })
    if (action === 'surfaces') return running === undefined || running.closedAt !== undefined ? [] : [...(await claude.session.surfaces())]
    if (action !== 'send') throw new Error(`cmod: ${action} runs only on a session's own main loop.`)
    if (running === undefined || running.closedAt !== undefined) throw ended(task)
    const { type, text } = input as SessionSend
    const sent = await claude.session.send({ to: { agentId: task }, text: type === Note ? modNote(caller, text) : text })
    if (sent.isDelivered !== true) throw ended(task)
    return null
  }

  const startBackground = async (task: TaskStartArgs, forkedFrom?: string, at?: string): Promise<TaskData> => {
    if (task.title.trim() === '') throw new Error('a task needs a title.')
    if (task.name !== undefined) throw new Error('a background task takes no name.')
    const fresh: Partial<TaskStartArgs> = forkedFrom === undefined ? task : {}
    const asked: TaskData = { id: '', title: task.title, ...(forkedFrom === undefined ? {} : { forkedFrom }), ...(fresh.agentType === undefined ? {} : { agentType: fresh.agentType }), ...(fresh.model === undefined ? {} : { model: fresh.model }), ...(task.machine === undefined ? {} : { machine: task.machine }), openedBy: '', openedAt: new Date().toISOString(), isBackground: true }
    const answer = (await wants(TaskStart)) ? await decide()(TaskStart, { type: TaskStart, task: { ...asked, context: conversation.state.context } }) : undefined
    if (answer?.refuse !== undefined) throw new Error(`a beforeTaskStart listener refused the task: ${answer.refuse}`)
    if (answer?.result !== undefined) {
      const started: TaskData = { ...asked, id: answer.result, title: answer.title ?? task.title }
      await claude.fs.write(`${backgroundTasks}/${session}/${started.id}.json`, JSON.stringify(started))
      dispatch(session, conversation.startTask(started))
      return started
    }
    if (task.machine !== undefined) {
      const here = await claude.device.read()
      if (task.machine !== here.name && task.machine !== here.id) throw new Error(`no mod starts sessions on ${task.machine}, so the task did not start. Leave machine out to start it on ${here.name}.`)
    }
    const owner = forkedFrom === undefined ? (answer?.owner ?? {}) : {}
    const folder = owner.cwd ?? fresh.cwd
    const here = await claude.session.cwd()
    const args = [
      'task',
      'start',
      '--title',
      answer?.title ?? task.title,
      ...(forkedFrom === undefined ? [] : ['--clone']),
      ...(at === undefined ? [] : ['--at', at]),
      ...textArg('--agent', owner.agentType ?? fresh.agentType),
      ...textArg('--model', owner.model ?? fresh.model),
      '--cwd',
      folder === undefined ? here : resolve(here, folder),
      '--json',
      '--',
      answer?.prompt ?? task.prompt,
    ]
    const started = JSON.parse(await runCmod(claude, args, session)) as TaskData
    dispatch(session, conversation.startTask(started))
    return started
  }

  const answerTask = async () => {
    const { env } = await claude.settings.read()
    const asked = isObject(env) ? env[taskVariable] : undefined
    if (typeof asked !== 'string') return
    const answered = `cmod:task-answered:${session}`
    if ((await claude.store.get(answered)) === true) return
    await claude.store.set(answered, true)
    const { session: from, ...task } = JSON.parse(asked) as TaskData & { readonly session: string }
    const closed: TaskData = { ...task, id: session, closedAt: new Date().toISOString() }
    await claude.fs.write(`${backgroundTasks}/${from}/${session}.json`, JSON.stringify(closed))
    local.client.notify(sessionActs.changed, { session: from, part: 'tasks' })
  }

  const actElsewhere = async (caller: string, target: string, action: Act, input: unknown, task: string | undefined): Promise<unknown> => {
    if (action === 'send' && task === undefined && (input as SessionSend).as === Session) {
      const { type, text } = input as SessionSend
      const sent = await claude.session.send({ to: { sessionId: target }, text })
      if (sent.isDelivered === true) return null
      return actOn(target, action, { type, text }, { caller })
    }
    return actOn(target, action, input, { caller, ...(task === undefined ? {} : { task }) })
  }

  const merged = <Item>(saved: readonly Item[], kept: readonly Item[], key: (item: Item) => string): Item[] => {
    const keptKeys = new Set(kept.map(key))
    return [...saved.filter((item) => !keptKeys.has(key(item))), ...kept]
  }

  const liveTurns = (task: unknown): TurnData[] => {
    const turn = typeof task === 'string' ? conversation.state.taskTurns[task] : conversation.state.turn
    return turn === undefined ? [] : [turn]
  }

  const liveTasks = (): TaskData[] =>
    Object.values(conversation.state.tasks).map((task) => ({
      id: task.id,
      title: task.title,
      ...(task.agentType === undefined ? {} : { agentType: task.agentType }),
      ...(task.model === undefined ? {} : { model: task.model }),
      openedBy: task.openedBy,
      openedAt: task.openedAt,
      ...(task.closedAt === undefined ? {} : { closedAt: task.closedAt }),
      ...(task.parent === undefined ? {} : { parent: task.parent }),
      ...(task.forkedFrom === undefined ? {} : { forkedFrom: task.forkedFrom }),
      ...(task.isBackground === true ? { isBackground: true as const } : {}),
    }))

  const liveContext = (task: unknown): ContextData[] => {
    if (typeof task === 'string') {
      const running = conversation.state.tasks[task]
      return running === undefined ? [] : [{ number: running.context, openedAt: running.contextOpenedAt ?? running.openedAt, task, ...(running.closedAt === undefined ? {} : { closedAt: running.closedAt }) }]
    }
    const { context, contextOpenedAt } = conversation.state
    return context === 0 ? [] : [{ number: context, openedAt: contextOpenedAt }]
  }

  const lastOf = <Item>(items: readonly Item[], last: unknown): Item[] => (typeof last === 'number' ? items.slice(-last) : [...items])

  const isHeld = (kept: readonly unknown[], last: unknown) => typeof last === 'number' && kept.length >= last

  const fields = (request: Request, keys: readonly string[]) => Object.fromEntries(keys.flatMap((key) => (request[key] === undefined ? [] : [[key, request[key]]])))

  const methods: Readonly<Record<string, (request: Request, caller: string | undefined) => Promise<unknown>>> = {
    async [conversationMethods.sessions](request) {
      const found = await listAll({ project: project(), ...fields(request, ['since', 'everyProject', 'running']) })
      return found.map((each) => (each.id === session ? { ...each, isRunning: true } : each))
    },
    async [conversationMethods.session](request) {
      const id = String(request['session'])
      const found = (await listAll({ project: project(), everyProject: true })).find((each) => each.id === id)
      if (found === undefined) throw new Error(`no session ${id} on any of your machines.`)
      return found.id === session ? { ...found, isRunning: true } : found
    },
    async [conversationMethods.search](request) {
      const record = fields(request, ['session', 'task', 'turn', 'context', 'isAgent'])
      const options = { project: project(), ...fields(request, ['since', 'everyProject', 'running', 'before']), record }
      const pages = await Promise.all((await stores()).map((client) => client.request<Message[]>(`${sessionStore}.search`, [String(request['text']), options]).catch((error: unknown) => (client === local.client ? Promise.reject(error) : []))))
      return pages.flat().sort((first, second) => second.at.localeCompare(first.at))
    },
    async [conversationMethods.messages](request) {
      const id = String(request['session'])
      const saved = () => read<Message[]>(id, 'messages', fields(request, ['turn', 'task', 'after', 'last']))
      if (id !== session) return saved()
      await starting
      const fits = (message: Message) => (request['turn'] === undefined || message.turn === request['turn']) && message.task === request['task']
      const after = typeof request['after'] === 'string' ? live.findIndex((message) => message.id === request['after']) : -1
      const kept = live.slice(after + 1).filter(fits)
      if (after >= 0 || isHeld(kept, request['last'])) return lastOf(kept, request['last'])
      return lastOf(merged(await saved(), kept, (message) => message.id), request['last'])
    },
    async [conversationMethods.turns](request) {
      const id = String(request['session'])
      const saved = () => read<TurnData[]>(id, 'turns', fields(request, ['task', 'context', 'last']))
      if (id !== session) return saved()
      await starting
      const kept = liveTurns(request['task']).filter((turn) => request['context'] === undefined || turn.context === request['context'])
      if (isHeld(kept, request['last'])) return lastOf(kept, request['last'])
      return lastOf(merged(await saved(), kept, (turn) => turn.prompt.id), request['last'])
    },
    async [conversationMethods.contexts](request) {
      const id = String(request['session'])
      const saved = await read<ContextData[]>(id, 'contexts', fields(request, ['task'])).catch((error: unknown) => {
        if (id === session && typeof request['task'] === 'string') return []
        throw error
      })
      if (id !== session) return saved
      await starting
      return merged(saved, liveContext(request['task']), (context) => String(context.number))
    },
    async [conversationMethods.tasks](request) {
      const id = String(request['session'])
      const isNested = request['all'] === true
      const saved = await read<TaskData[]>(id, 'tasks', isNested ? { all: true } : fields(request, ['task']))
      if (id !== session) return saved
      await starting
      const kept = liveTasks().filter((task) => isNested || task.parent === request['task'])
      const running = await claude.agent.list().catch((error: unknown) => (claude.ui.warn('tasks:status', `cmod: the tasks show no status, because Claude Code listed no agents: ${messageOf(error)}`), []))
      const background = saved.flatMap(({ id, status }) => (status === undefined ? [] : [{ id, status }]))
      return tasksWithAgents(merged(saved, kept, (task) => task.id), [...running, ...background])
    },
    async [conversationMethods.goal](request) {
      const id = String(request['session'])
      const task = typeof request['task'] === 'string' ? request['task'] : undefined
      if (id === session && task === undefined) {
        await starting
        const text = conversation.state.goal
        if (text !== undefined) return { text }
      }
      return read(id, 'goal', task === undefined ? {} : { task })
    },
    async [conversationMethods.updateGoal](request) {
      const id = String(request['session'])
      const task = typeof request['task'] === 'string' ? request['task'] : undefined
      const text = String(request['text'])
      await claude.fs.write(`${goals}/${task ?? id}.txt`, text)
      await starting
      if (id === session) changeGoal(task, text)
      else {
        dispatch(id, [{ type: GoalChange, goal: { text, ...(task === undefined ? {} : { task }) } }])
        local.client.notify(sessionActs.changed, { session: id, part: 'goal' })
      }
      return null
    },
    async [conversationMethods.subscribe](request, caller) {
      if (caller === undefined) throw new Error('cmod hears no caller for this subscription.')
      const id = String(request['session'])
      const list = Array.isArray(request['subscriptions']) ? (request['subscriptions'] as readonly Listened[]) : []
      hear(caller, id, list)
      await saveListeners()
      return null
    },
    async [conversationMethods.watchBefore](request, caller) {
      if (caller === undefined) throw new Error('cmod hears no caller for this before listener.')
      const target = String(request['session'])
      const list = Array.isArray(request['subscriptions']) ? (request['subscriptions'] as readonly Listened[]) : []
      watch(caller, target, list)
      await saveListeners()
      return null
    },
    async [conversationMethods.act](request, caller) {
      if (caller === undefined) throw new Error('cmod hears no caller for this action.')
      const target = String(request['session'])
      const action = String(request['action']) as Act
      const task = typeof request['task'] === 'string' ? request['task'] : undefined
      if (!isAct(action)) throw new Error(`cmod takes no action named ${action}.`)
      if (target === (await claude.session.id())) return perform(caller, action, request['input'], task)
      return actElsewhere(caller, target, action, request['input'], task)
    },
  }

  return {
    listens: () => [...registered.values()].some((each) => each.length > 0),
    onUnreached(listener) {
      unreached = listener
      if (isUnreached) listener()
    },
    async close() {
      storeChanges?.remove()
      await Promise.all([local.client.close(), ...[...others.values()].map((each) => each.client.close())])
    },
    turnClosedBy: (rowId) => closings.get(rowId),
    color: () => color,
    onColor(listener) {
      onColor = listener
    },
    moved() {
      void holdHere(local.client).catch((error: unknown) => report('hold', 'Other sessions see this session in its old project until cmod serve answers', error))
      for (const [key, each] of watched) watched.set(key, { ...each, project: project() })
      const held = [...registered.keys()]
      for (const key of held) {
        const [kind, caller, target] = key.split('\n')
        if (caller === undefined || target === undefined) continue
        if (kind === 'on') register(`${caller}\n${target}`, 'on', caller, target, subscribed.get(caller)?.get(target) ?? [])
        else register(`${caller}\n${target}`, 'before', caller, target, watched.get(`${caller}\n${target}`)?.list ?? [])
      }
    },
    async answer(e) {
      const method = methods[e.method]
      if (method === undefined) return undefined
      const input = isObject(e.input) ? e.input : {}
      try {
        return { value: await method(input, e.caller) }
      } catch (error) {
        return { deny: messageOf(error) }
      }
    },
  }
}

function textArg(flag: string, value: unknown): string[] {
  return typeof value === 'string' ? [flag, value] : []
}
