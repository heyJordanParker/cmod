import type { Args, EventResult, Frozen } from 'claude-code'
import { coreVersion, dataFolder, isObject, serveSocketPath } from '../records.js'
import { Message, rowOfAppend, type Row } from '../session/context/turn/message/message.js'
import { modNote, Note } from '../session/context/turn/message/note.js'
import { Prompt } from '../session/context/turn/message/prompt.js'
import { Person } from '../session/context/turn/message/sender.js'
import { createConversation, emptyConversation, ownerOfSpawn, tasksWithAgents, type Conversation, type ConversationState, type ContextData, type SessionChange, type SessionData, type TaskData, type TurnData, type TurnEnding } from '../session/conversation.js'
import { Session, UsageChange, type BeforeEvent, type Surface, type SessionSend, type TaskStartArgs, type ToolCallArgs } from '../session/session.js'
import { GoalChange } from '../session/goal/goal.js'
import { TurnEnd, TurnStart } from '../session/context/turn/turn.js'
import { TaskEnd, TaskStart } from '../session/goal/task.js'
import { receivedMatcher } from '../utils/matcher.js'
import { resolve } from '../vendor.js'
import { ifMissing } from '../utils/paths.js'
import { callSummary, firstLine, messageOf, questionOf } from '../utils/text.js'
import { beforeAnswerKeys, foldBefore, installBefore, relayOf, type Decide, type Place } from './before.js'
import type { Claude } from './claude.js'
import { cmodPluginName, isNotInstalled } from './dependencies.js'
import { MissingMachineId } from './device.js'
import { findSession, interfaceListeners, interfaceMethods, providerActs, providerPeer, serveProviders, sessionActs, sessionsInterface, uiInterface, type HeldStatus, type Implementation, type Provided, type KeptListen, type ProvidedHeard, type ProviderIdentity, type SessionsChange, type HeldSession, storeInterface, methodName, listeningOf, type StoreChange, type StorePart } from './interfaces.js'
import { runCmod } from './programs.js'
import { addressCall, connectRpc, isConnectionGone, RpcError, rpcCodes, type RpcClient } from './rpc.js'
import type { RoutedHook, Router } from './router.js'
import { toolInputOf } from './tool-calls.js'
import { conversationMethods, everySession, isAct, isHeardBy, isInScope, pickedColor, resultOf, spawnTask, usageOf, type Act, type Listened, type SessionColor } from './sessions.js'

type Request = Readonly<Record<string, unknown>>

type Heard = { readonly event: Listened['event']; readonly matcher: unknown }

type Watch = { readonly mod: string; readonly target: string; readonly list: readonly Listened[] }

type Relay =
  | { readonly kind: 'act'; readonly id: string; readonly from: string; readonly caller: string; readonly action: Act; readonly input: unknown; readonly task?: string }
  | { readonly kind: 'goal'; readonly task?: string; readonly text: string }
  | { readonly kind: 'taskEnd'; readonly task: TaskData }

const relayKinds: ReadonlySet<unknown> = new Set(['act', 'goal', 'taskEnd'] satisfies Relay['kind'][])

const taskVariable = 'CMOD_TASK'

const isRelay = (value: unknown): value is Relay => isObject(value) && relayKinds.has(value['kind'])

const bufferedTaskRows = 200

const questionTool = 'AskUserQuestion'

const permissionPrompt = 'permission prompt'

const carryOn = 'The conversation was compacted. Carry on with the work from before the compaction.'

export type Conversations = {
  answer(e: Frozen<Args<'cmod.call'>> & { readonly caller?: string }): Promise<EventResult<'cmod.call'> | undefined>
  moved(): void
  turnClosedBy(rowId: string): TurnData | undefined
  onTurnClosed(listener: (turn: TurnData) => void): void
  color(): SessionColor
  onColor(listener: (told: SessionColor) => void): void
  onUnreached(listener: () => void): void
  onStoreChange(listener: (part: StorePart | undefined) => void): void
  tellStore(part: StorePart): void
  serveUi(methods: Implementation): void
  tellUi(event: string, payload: object): void
  tellProviders(names: readonly string[]): void
  provide(name: string, methods: Implementation): Provided
  close(): Promise<void>
}

const keptClosings = 200

const keptMessages = 200

type Kept = { readonly subscribed: Readonly<Record<string, Readonly<Record<string, readonly Listened[]>>>>; readonly watched: Readonly<Record<string, Readonly<Record<string, readonly Listened[]>>>>; readonly provided?: readonly KeptListen[] }

const noneKept: Kept = { subscribed: {}, watched: {}, provided: [] }

type Registered = { remove(): void }

type OtherProvider = { readonly identity: ProviderIdentity; readonly peer: Pick<RpcClient, 'request'> }

export function serveConversations({
  claude,
  router,
  store,
  project,
  report,
  clear,
  keepsConnecting = true,
  sessionCode = () => [],
  provider,
  tell = (caller, heard) => new Promise((resolve) => claude.clock.after(0, () => resolve(claude.cmod.call({ to: caller, method: interfaceMethods.heard, input: heard })))),
}: {
  readonly claude: Claude
  readonly router: Router
  readonly store: string
  readonly project: () => string
  readonly report: (id: string, message: string, error: unknown) => void
  readonly clear: (id: string) => void
  readonly keepsConnecting?: boolean
  readonly sessionCode?: (name: string) => readonly string[]
  readonly provider?: ProviderIdentity
  readonly tell?: (caller: string, heard: ProvidedHeard, signal: AbortSignal) => Promise<unknown>
}): Conversations {
  const folder = dataFolder(store, cmodPluginName)
  const goals = `${folder}/goals`
  const backgroundTasks = `${folder}/tasks`
  const listeners = `${folder}/listeners`
  const heard = new Map<string, Map<string, readonly Heard[]>>()
  const subscribed = new Map<string, Map<string, readonly Listened[]>>()
  const watched = new Map<string, Watch>()
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
  let compactsAfterTurn: { readonly keep?: string } | undefined
  let isWorking = false
  let waitingFor: HeldStatus['waitingFor']
  let waitingOn: string | undefined
  let contextPercent: number | undefined
  let endedTurn: HeldStatus['lastTurn']
  let failedWith: string | undefined
  let repliedWith: string | undefined
  const openCalls = new Map<string, ToolCallArgs>()
  const tellStatus = () => {
    if (session === '') return
    const open = [...openCalls.values()].at(-1)
    const openCall = open === undefined ? undefined : { tool: open.name, summary: callSummary(open.input) }
    local.client.notify(sessionActs.status, { session, status: waitingFor !== undefined ? 'waiting' : isWorking ? 'busy' : 'idle', ...(waitingFor === undefined ? {} : { waitingFor }), ...(contextPercent === undefined ? {} : { contextPercent }), ...(endedTurn === undefined ? {} : { lastTurn: endedTurn }), ...(openCall === undefined ? {} : { openCall }) } satisfies HeldStatus & { readonly session: string })
  }
  const waitFor = (callId: string) => {
    const call = openCalls.get(callId)
    if (call === undefined) return
    const question = call.name === questionTool ? questionOf(call.input) : undefined
    waitingFor = question !== undefined ? { dialog: permissionPrompt, question } : { dialog: permissionPrompt, tool: call.name, input: call.input }
    waitingOn = callId
    tellStatus()
  }
  const turnMoved = (isStarted: boolean) => {
    isWorking = isStarted
    if (isStarted) {
      endedTurn = undefined
      failedWith = undefined
      repliedWith = undefined
    }
    waitingFor = undefined
    waitingOn = undefined
    openCalls.clear()
    tellStatus()
  }
  router.add('turn.start', async (e, next) => {
    const agent = (e as typeof e & { readonly agentId?: string }).agentId ?? ''
    engineTurns.set(agent, e.turnId)
    if (agent === '') turnMoved(true)
    return next(e)
  })
  router.add('turn.complete', async (e, next) => {
    const completed = await next(e)
    if (e.agentId !== undefined) return completed
    const reason = e.reason === 'answer' ? 'answered' : e.reason === 'aborted' ? 'stopped' : 'failed'
    const failure = e.reason === 'refusal' ? (e.refusal.explanation ?? e.refusal.category ?? 'Claude refused to answer.') : failedWith
    endedTurn = { reason, at: new Date().toISOString(), ...(reason === 'failed' && failure !== undefined ? { failure } : {}), ...(reason === 'answered' && repliedWith !== undefined ? { reply: repliedWith } : {}) }
    turnMoved(false)
    return completed
  })
  router.add('tool.call', async (e, next) => {
    if (e.agentId !== undefined) return next(e)
    openCalls.set(e.tool_use_id, { name: e.tool, input: toolInputOf(e) })
    if (e.tool === questionTool) waitFor(e.tool_use_id)
    else tellStatus()
    try {
      return await next(e)
    } finally {
      openCalls.delete(e.tool_use_id)
      if (waitingOn === e.tool_use_id) {
        waitingFor = undefined
        waitingOn = undefined
      }
      tellStatus()
    }
  })
  router.add('classic.Notification', async (e, next) => {
    const last = [...openCalls.keys()].at(-1)
    if (e.notification_type === 'permission_prompt' && last !== undefined) waitFor(last)
    return next(e)
  })
  const endTurn = (ending: TurnEnding, task?: string) => <Below extends { readonly block?: string }>(below: Below, isInterrupted = false): Below => {
    if (below.block !== undefined) return below
    engineTurns.delete(task ?? '')
    if (!isInterrupted) dispatch(conversation.endTurn(new Date().toISOString(), ending, task))
    if (task === undefined && endsAfterTurn) endSoon()
    if (task === undefined && compactsAfterTurn !== undefined && !isInterrupted) claude.clock.after(1, () => void compactNow())
    return below
  }
  const compactNow = async () => {
    const asked = compactsAfterTurn
    compactsAfterTurn = undefined
    if (asked === undefined) return
    try {
      await claude.command.run({ command: 'compact', ...(asked.keep === undefined ? {} : { args: asked.keep }) })
      await claude.prompt.submit({ text: carryOn })
    } catch (error) {
      report('compact', 'Could not compact the conversation', error)
    }
  }
  router.add('classic.Stop', async (e, next) => endTurn({ reason: 'answer', ...(e.last_assistant_message === undefined ? {} : { answer: e.last_assistant_message }) })(await next(e), next.signal.aborted))
  router.add('classic.StopFailure', async (e, next) => {
    const text = e.error_details ?? e.last_assistant_message ?? String(e.error)
    failedWith = text
    if (endedTurn?.reason === 'failed' && endedTurn.failure === undefined) {
      endedTurn = { ...endedTurn, failure: text }
      tellStatus()
    }
    return endTurn({ reason: 'error', failure: { type: String(e.error), text } })(await next(e))
  })
  router.add('classic.SubagentStop', async (e, next) => endTurn({ reason: 'answer', ...(e.last_assistant_message === undefined ? {} : { answer: e.last_assistant_message }) }, e.agent_id)(await next(e), next.signal.aborted))
  router.add('classic.Stop', async (e, next) => {
    const below = await next(e)
    if (below.block === undefined && !next.signal.aborted) {
      repliedWith = firstLine(e.last_assistant_message ?? '') || undefined
      void answerTask(e.last_assistant_message ?? '').catch((error: unknown) => report('task', 'Could not record that this session answered its task', error))
    }
    return below
  })

  const ended = (id: string) => new Error(`session ${id} has ended`)

  const call = (address: string) => addressCall((url, init) => claude.http.fetch(url, init), address)

  const held = interfaceListeners({ report: (error) => report('listen', 'Missed a change a sessions provider told', error) })

  let ui: Implementation = {}

  const liveTasksOver = async (saved: readonly TaskData[], request: Readonly<Record<string, unknown>>): Promise<TaskData[]> => {
    await starting
    const closed = new Map(saved.flatMap((task) => (task.closedAt === undefined ? [] : [[task.id, task] as const])))
    const kept = liveTasks()
      .filter((task) => request['all'] === true || task.parent === request['task'])
      .map((task) => (task.closedAt === undefined ? (closed.get(task.id) ?? task) : task))
    const running = await claude.agent.list().catch((error: unknown) => (claude.ui.warn('tasks:status', `cmod: the tasks show no status, because Claude Code listed no agents: ${messageOf(error)}`), []))
    const background = saved.flatMap(({ id, status, isBackground }) => (status === undefined || isBackground !== true ? [] : [{ id, status }]))
    return tasksWithAgents(merged(saved, kept, (task) => task.id), [...running, ...background])
  }

  const handle = async (method: string, params: unknown, signal: AbortSignal): Promise<unknown> => {
    const answered = await held.handler(method, params, signal)
    if (answered !== undefined) return answered.result
    if (method === sessionActs.tasks) {
      const { saved, options } = (isObject(params) ? params : {}) as { readonly saved?: unknown; readonly options?: unknown }
      return liveTasksOver(Array.isArray(saved) ? (saved as TaskData[]) : [], isObject(options) ? options : {})
    }
    if (method === sessionActs.act) {
      const { action, input, caller, task } = params as { readonly action: string; readonly input: unknown; readonly caller?: string; readonly task?: string }
      if (!isAct(action)) throw new RpcError(rpcCodes.methodNotFound, (await unknownTo(`"${action}" action`)).message)
      return perform(caller ?? cmodPluginName, action, input, task)
    }
    if (method === sessionActs.ui) {
      const { method: called, args } = params as { readonly method: string; readonly args: readonly unknown[] }
      if (args[0] !== session) throw new RpcError(rpcCodes.notHeld, `The cmod plugin of session ${session} shows no UI of session ${String(args[0])}.`)
      const run = Object.hasOwn(ui, called) ? (ui[called] as (...each: readonly unknown[]) => unknown) : undefined
      if (run === undefined) throw new RpcError(rpcCodes.methodNotFound, `The cmod plugin of session ${session} answers no ${uiInterface}.${called}.`)
      return run(...args)
    }
    const provided = served.handler(method, params, signal)
    if (provided !== undefined) return provided
    throw new RpcError(rpcCodes.methodNotFound, `The cmod plugin of session ${session} answers no ${method}.`)
  }

  const holdHere = async (client: RpcClient) => {
    if (session === '') return
    await client.request(sessionActs.hold, { session, project: project(), cwd: await claude.session.cwd() } satisfies HeldSession)
  }

  let serveChanges: Registered | undefined
  let isUnreached = false
  let unreached: () => void = () => undefined
  let storeChanged: (part: StorePart | undefined) => void = () => undefined
  const local: { readonly client: RpcClient } = {
    client: connectRpc({
      call: call(`unix:${serveSocketPath(store)}`),
      handle,
      onConnect: async (client) => {
        isUnreached = false
        await holdHere(client)
        tellStatus()
        await served.replay()
        await held.replay(client)
        storeChanged(undefined)
        await reconcileTasks({ atConnect: true })
      },
      onError: (error) => {
        if (!isUnreached) claude.ui.warn('serve:connect', `cmod: this session waits for cmod serve: ${messageOf(error)}`)
        isUnreached = true
        unreached()
      },
      clock: claude.clock,
      keepsConnecting,
    }),
  }
  held.followProviders(local.client)
  held.listen(local.client, listeningOf(storeInterface, 'on', 'Change', [], undefined), (told: StoreChange) => storeChanged(told.part))

  const served = serveProviders({
    serve: local.client,
    listeners: held,
    ...(provider === undefined ? {} : { provider }),
    tell,
    sessionCode,
    device: async () => {
      const { id, name } = await claude.device.read().catch((error: unknown) => {
        if (error instanceof MissingMachineId) return { id: '', name: '' }
        throw error
      })
      return { id, name }
    },
    after: (ms, run) => claude.clock.after(ms, run),
    report: (error) => report('providers', 'A provider listener failed', error),
    changed: () => void saveListeners().catch((error: unknown) => report('listeners', 'Could not keep the provider listeners of this session', error)),
  })

  const otherProviders = async (): Promise<OtherProvider[]> => (await local.client.request<ProviderIdentity[]>(providerActs.providers, { interface: sessionsInterface })).map((identity) => ({ identity, peer: providerPeer(local.client, identity) }))

  const taskWatches = new Map<string, { readonly runner: OtherProvider; readonly watch: Registered }>()
  const watchTask = (task: string, runner: OtherProvider) => {
    if (taskWatches.has(task)) return
    const listening = { ...listeningOf(sessionsInterface, 'on', 'Change', [task], { part: 'running' }), provider: runner.identity }
    taskWatches.set(task, { runner, watch: held.listen(local.client, listening, () => followTask(runner, task)) })
    void followTask(runner, task)
  }
  const unwatchTask = (task: string) => {
    taskWatches.get(task)?.watch.remove()
    taskWatches.delete(task)
  }

  const providers = async () => [local.client, ...(await otherProviders()).map((other) => other.peer)]

  const isNotHeld = (error: unknown): error is RpcError => error instanceof RpcError && error.code === rpcCodes.notHeld

  const sessionsAsk = (client: Pick<RpcClient, 'request'>) => (method: string, args: readonly unknown[]) => client.request(`${sessionsInterface}.${method}`, args)

  const firstHolding = async <Item, Value>(items: readonly Item[], ask: (item: Item) => Promise<Value>): Promise<Value> => {
    let last = new RpcError(rpcCodes.notHeld, 'No sessions provider answers.')
    for (const item of items) {
      try {
        return await ask(item)
      } catch (error) {
        if (!isNotHeld(error)) throw error
        last = error
      }
    }
    throw last
  }

  const read = async <Value>(id: string, part: string, options: Request = {}): Promise<Value> =>
    firstHolding(await providers(), (client) => client.request<Value>(`${sessionsInterface}.read`, [id, part, { project: project(), ...options }])).catch((error: unknown) => {
      throw isNotHeld(error) ? new Error(`no session ${id} on any of your devices.`) : error
    })

  const listAll = async (scope: Request): Promise<SessionData[]> => {
    const lists = await Promise.all((await providers()).map((client) => client.request<SessionData[]>(`${sessionsInterface}.sessions`, [scope]).catch((error: unknown) => (client === local.client ? Promise.reject(error) : (report('store', 'Lists no sessions of another sessions provider', error), [])))))
    const seen = new Set<string>()
    return lists.flat().filter((each) => !seen.has(each.id) && Boolean(seen.add(each.id)))
  }

  const actOn = async (target: string, action: Act, input: unknown, context: Request) => firstHolding(await providers(), (client) => client.request(`${sessionsInterface}.${action}`, [target, input, { project: project(), ...context }]))

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

  let lastTurn: TurnData | undefined
  const closings = new Map<string, TurnData>()
  let onTurnClosed: (turn: TurnData) => void = () => undefined
  const dispatch = (changes: readonly SessionChange[]) => {
    if (session !== '' && changes.some((change) => change.type === TaskStart || change.type === TaskEnd)) local.client.notify(sessionActs.changed, { session, part: 'tasks' })
    for (const change of changes) {
      if (change.type === TaskEnd) unwatchTask(change.task.id)
      if ((change.type === TurnStart || change.type === TurnEnd) && change.turn.prompt.task === undefined) lastTurn = change.turn
      if (change.type === Message && !liveIds.has(change.message.id)) {
        live.push(change.message)
        liveIds.add(change.message.id)
        if (live.length > keptMessages) liveIds.delete(live.shift()?.id ?? '')
      }
      for (const [mod, sessions] of heard) {
        const subscriptions = [...(sessions.get(session) ?? []), ...(sessions.get(everySession) ?? [])]
        if (!subscriptions.some(({ event, matcher }) => isHeardBy(event, matcher, change))) continue
        void claude.cmod.call({ to: mod, method: conversationMethods.changed, input: { session, change, isInProject: true } }).then(
          () => clear(`changed:${mod}`),
          (error: unknown) => (isNotInstalled(mod, error) ? forgetMod(mod) : report(`changed:${mod}`, `Could not tell ${mod} about session ${session}`, error)),
        )
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
    provided: served.listened(),
  })

  const saveListeners = (isEnding = false) => {
    const at = session
    if (at === '') return Promise.resolve()
    return onListenerFiles(() => claude.fs.write(`${listeners}/${at}.json`, JSON.stringify(isEnding ? noneKept : keptOf())))
  }

  const restoreListeners = () => {
    const at = session
    return onListenerFiles(async () => {
      const read = JSON.parse(await claude.fs.read(`${listeners}/${at}.json`).catch(ifMissing('{}'))) as Partial<Kept>
      for (const [caller, lists] of Object.entries(read.subscribed ?? {})) if (!subscribed.has(caller)) for (const [id, list] of Object.entries(lists)) hear(caller, id, list)
      for (const [caller, targets] of Object.entries(read.watched ?? {})) for (const [target, list] of Object.entries(targets)) if (!watched.has(`${caller}\n${target}`)) watch(caller, target, list)
      const listening = served.listened()
      for (const { caller, listen } of read.provided ?? []) if (!listening.some((each) => each.caller === caller && each.listen.id === listen.id)) void served.answer(interfaceMethods.listen, listen, caller)?.catch((error: unknown) => report('listeners', `Could not listen again for ${caller} on ${listen.interface}`, error))
    })
  }

  const hear = (caller: string, id: string, list: readonly Listened[]) => {
    const sessions = heard.get(caller) ?? new Map<string, readonly Heard[]>()
    sessions.set(id, list.map(({ event, matcher }) => ({ event, matcher: matcher === undefined ? undefined : receivedMatcher(matcher) })))
    heard.set(caller, sessions)
    const lists = subscribed.get(caller) ?? new Map<string, readonly Listened[]>()
    lists.set(id, list)
    subscribed.set(caller, lists)
  }

  const watch = (caller: string, target: string, list: readonly Listened[]) => {
    const key = `${caller}\n${target}`
    if (list.length === 0) watched.delete(key)
    else watched.set(key, { mod: caller, target, list })
  }

  const forgetMod = (mod: string) => {
    const wasProvided = served.listened().some((each) => each.caller === mod)
    served.forget(mod)
    const wasHeard = heard.delete(mod) || wasProvided
    subscribed.delete(mod)
    clear(`changed:${mod}`)
    const wasWatching = [...watched.keys()].filter((key) => key.startsWith(`${mod}\n`))
    for (const key of wasWatching) watched.delete(key)
    if (wasHeard || wasWatching.length > 0) void saveListeners().catch((error: unknown) => report('listeners', `Kept the listeners of ${mod}, which left this session`, error))
  }

  const changeGoal = (task: string | undefined, text: string) => dispatch(task === undefined ? conversation.changeGoal(text) : [{ type: GoalChange, goal: { text, task } }])

  const place = (): Place => {
    const { context, contextOpenedAt, turn, tasks, taskTurns, openCalls } = conversation.state
    return { session, context, contextOpenedAt, ...(turn === undefined ? {} : { turn }), tasks, taskTurns, ...(openCalls === undefined ? {} : { openCalls }) }
  }

  type Decider = { readonly mod: string; readonly list: readonly Listened[] }

  const deciders = (event: string): Decider[] => {
    const own = [...watched.values()].filter((each) => (each.target === session || each.target === everySession) && each.list.some((listened) => listened.event === event))
    return [...new Map(own.map((each) => [each.mod, { mod: each.mod, list: each.list }])).values()]
  }

  const askHere = async (mod: string, event: BeforeEvent, change: SessionChange) =>
    claude.cmod.call({ to: mod, method: conversationMethods.before, input: { session, event, change, isInProject: true } }).catch((error: unknown) => {
      if (!isNotInstalled(mod, error)) throw error
      forgetMod(mod)
      return undefined
    })

  const refuses = (decider: Decider, event: BeforeEvent, change: SessionChange | undefined) => {
    if (!beforeAnswerKeys[event].includes('refuse')) return false
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
        deciders(event).map((decider) => async (latest: SessionChange) => (cancel?.aborted === true ? undefined : askHere(decider.mod, event, latest))),
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

  const listenToServe = () => {
    serveChanges?.remove()
    serveChanges = held.listen(local.client, listeningOf(sessionsInterface, 'on', 'Change', [session], { part: ['tasks', 'goal'] }), (change: SessionsChange) => {
      if (change.part === 'tasks') void reconcileTasks()
      if (change.part === 'goal') void rereadGoal()
    })
  }

  const start = (id: string, source: string, agentType: string | undefined) => {
    if (id === session) return
    const previous = session
    session = id
    for (const task of taskWatches.keys()) unwatchTask(task)
    live = []
    liveIds.clear()
    waitingRows.clear()
    const runsAs = agentType === undefined ? {} : { agentType }
    conversation = createConversation({ ...emptyConversation(id), ...runsAs })
    contextPercent = undefined
    endedTurn = undefined
    failedWith = undefined
    turnMoved(false)
    const isNew = source === 'startup' || source === 'clear'
    if (!isNew) readColor(id)
    starting = isNew
      ? Promise.resolve(dispatch(conversation.startContext(new Date().toISOString())))
      : read<ConversationState | null>(id, 'state').then(
          (state) => {
            if (session === id && state !== null) conversation = createConversation({ ...emptyConversation(id), ...state, ...runsAs })
          },
          (error: unknown) => report('state', `Starts session ${id} without its earlier turns`, error),
        )
    const restored = restoreListeners().catch((error: unknown) => report('listeners', "Could not read back the mods' listeners of this session", error))
    starting = Promise.all([starting, restored]).then(() => undefined)
    hasHeardListeners = false
    const holding = holdHere(local.client).then(
      () => {
        if (session !== id) return
        hasHeardListeners = true
        tellStatus()
      },
      (error: unknown) => claude.ui.warn('serve:hold', `cmod: other sessions reach session ${id} once cmod serve answers: ${messageOf(error)}`),
    )
    listening = Promise.all([restored, holding]).then(() => undefined)
    listenToServe()
    void starting.then(() => reconcileTasks())
    if (heard.size === 0 && watched.size === 0 && served.listened().length === 0) return
    void Promise.all([previous === '' ? undefined : onListenerFiles(() => claude.fs.write(`${listeners}/${previous}.json`, JSON.stringify(noneKept))), saveListeners()]).catch((error: unknown) => report('follow', 'Kept telling the mods about the session from before', error))
  }

  const openTasks = () => liveTasks().filter((task) => task.isBackground === true && task.closedAt === undefined)
  const openTask = (id: string) => openTasks().find((task) => task.id === id)

  const reconcileTasks = async ({ atConnect = false } = {}) => {
    if (session === '') return
    await starting
    if (openTasks().length === 0) return
    const saved = await read<TaskData[]>(session, 'tasks').catch((error: unknown) => (report('tasks', 'Could not read whether its background tasks ended', error), []))
    for (const task of saved) if (task.closedAt !== undefined && openTask(task.id) !== undefined) dispatch(conversation.endTask(task, task.closedAt))
    const open = openTasks().filter((task) => atConnect || !taskWatches.has(task.id))
    const others = open.every((task) => taskWatches.has(task.id)) ? [] : await otherProviders()
    for (const task of open) {
      const watched = taskWatches.get(task.id)
      if (watched !== undefined) await followTask(watched.runner, task.id)
      else await findTask(task.id, others).catch((error: unknown) => report('tasks', 'Could not read whether its tasks on another device ended', error))
    }
  }

  const findTask = async (id: string, others: readonly OtherProvider[]) => {
    if ((await findSession(sessionsAsk(local.client), id)) !== undefined) return
    for (const runner of others) {
      const found = await findSession(sessionsAsk(runner.peer), id).catch((error: unknown) => {
        report('tasks', `Could not ask ${runner.identity.mod} whether it runs task ${id}`, error)
        return undefined
      })
      if (found !== undefined) return watchTask(id, runner)
    }
  }

  const followTask = async (runner: OtherProvider, id: string) => {
    try {
      await starting
      if (openTask(id) === undefined) return
      const found = await findSession(sessionsAsk(runner.peer), id)
      if (found === undefined) return unwatchTask(id)
      const task = openTask(id)
      if (task === undefined || found.isRunning) return
      const closedAt = new Date().toISOString()
      await claude.fs.write(`${backgroundTasks}/${session}/${task.id}.json`, JSON.stringify({ ...task, closedAt } satisfies TaskData))
      dispatch(conversation.endTask(task, closedAt))
    } catch (error) {
      report('tasks', `Could not read whether a task ${runner.identity.mod} runs ended`, error)
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
      dispatch(conversation.startTask({ id: task, title: '', agentType: 'general-purpose', openedBy: '', openedAt: row.at }))
      for (const each of waiting) dispatch(conversation.add(each, task))
      return
    }
    dispatch(conversation.add(row, task))
    if (task !== undefined || row.type !== 'system' || row.name !== 'turn_duration' || lastTurn === undefined) return
    closings.set(row.id, lastTurn)
    if (closings.size > keptClosings) closings.delete(closings.keys().next().value as string)
    onTurnClosed(lastTurn)
  }

  router.add('classic.SessionStart', async (e, next) => {
    start(e.session_id, e.source, e.agent_type)
    return next(e)
  })
  void (async () => {
    const id = await claude.session.id()
    if (id === '') return
    const isRunning = await claude.fs.exists((await claude.session.info()).transcriptPath)
    if (session === '' && isRunning) start(id, 'resume', undefined)
  })().catch((error: unknown) => claude.ui.warn('serve:hold', `cmod: other sessions reach this one after its next prompt: ${messageOf(error)}`))
  router.add('classic.SessionEnd', async (e, next) => {
    if (subscribed.size > 0 || watched.size > 0 || served.listened().length > 0) await saveListeners(true).catch((error: unknown) => report('follow', 'Left its listeners registered', error))
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
    if (session === '') return measured
    const usage = await usageOf(claude)
    dispatch([{ type: UsageChange, usage }])
    if (usage.contextWindow.percent !== contextPercent) {
      contextPercent = usage.contextWindow.percent
      tellStatus()
    }
    return measured
  })

  const recordSpawn: RoutedHook<'agent.spawn'> = async (e, next) => {
    const spawned = await next(e)
    if (spawned.deny !== undefined || spawned.agentId === undefined) return spawned
    const id = spawned.agentId
    await starting
    const opened: TaskData = { id, title: e.description, ...ownerOfSpawn(e.subagentType, session), model: spawned.model, openedBy: e.tool_use_id, openedAt: new Date().toISOString(), ...(e.parentAgentId === undefined ? {} : { parent: e.parentAgentId }) }
    dispatch(conversation.startTask(opened))
    const waiting = waitingRows.get(id) ?? []
    waitingRows.delete(id)
    for (const row of waiting) dispatch(conversation.add(row, id))
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
      dispatch(conversation.endTask(relay.task, relay.task.closedAt ?? new Date().toISOString()))
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
    const { isStopped } = await local.client.request<{ readonly isStopped: boolean }>(sessionActs.stop, {})
    if (!isStopped) await claude.command.run({ command: 'exit' })
  }
  const endSoon = () => claude.clock.after(0, () => void exitNow().catch((error: unknown) => report('end', `Could not end session ${session}`, error)))

  const perform = async (caller: string, action: Act, input: unknown, task: string | undefined): Promise<unknown> => {
    await starting
    if (action === 'abort') return abortTurn(input, task)
    if (task !== undefined) return performInTask(caller, action, input, task)
    if (action === 'usage') return usageOf(claude)
    if (action === 'surfaces') return [...(await claude.session.surfaces())] satisfies Surface[]
    if (action === 'end') {
      if (engineTurns.has('')) {
        endsAfterTurn = true
        return { ends: 'afterTurn' }
      }
      endSoon()
      return { ends: 'now' }
    }
    if (action === 'compact') {
      const { keep } = (isObject(input) ? input : {}) as { readonly keep?: string }
      compactsAfterTurn = typeof keep === 'string' && keep.trim() !== '' ? { keep } : {}
      if (!engineTurns.has('')) claude.clock.after(0, () => void compactNow())
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
    if (action === 'startBackgroundTask') return startBackground(taskStartArgsOf(input))
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
    const asked: TaskData = { id: '', title: task.title, ...(forkedFrom === undefined ? {} : { forkedFrom }), ...(fresh.agentType === undefined ? {} : { agentType: fresh.agentType }), ...(fresh.model === undefined ? {} : { model: fresh.model }), openedBy: '', openedAt: new Date().toISOString(), isBackground: true }
    const answer = (await wants(TaskStart)) ? await decide()(TaskStart, { type: TaskStart, task: { ...asked, context: conversation.state.context } }) : undefined
    if (answer?.refuse !== undefined) throw new Error(`a beforeTaskStart listener refused the task: ${answer.refuse}`)
    const owner = forkedFrom === undefined ? (answer?.owner ?? {}) : {}
    if (task.device !== undefined) {
      const here = await claude.device.read()
      if (task.device !== here.name && task.device !== here.id) {
        const elsewhere: TaskStartArgs = { ...task, ...owner, title: answer?.title ?? task.title, prompt: answer?.prompt ?? task.prompt }
        const others = await otherProviders()
        const onDevice = others.filter(({ identity }) => identity.device !== undefined && (identity.device.name === task.device || identity.device.id === task.device))
        const candidates = onDevice.length > 0 ? onDevice : others
        const { opened, runner } = await firstHolding(candidates, async (runner) => ({ opened: await runner.peer.request<TaskData>(`${sessionsInterface}.startTask`, [session, elsewhere, { project: project() }]), runner })).catch((error: unknown) => {
          throw isNotHeld(error) ? new Error(`no mod starts sessions on ${task.device}, so the task did not start. Leave device out to start it on ${here.name}.`) : error
        })
        const started: TaskData = { ...asked, id: opened.id, title: elsewhere.title }
        await claude.fs.write(`${backgroundTasks}/${session}/${started.id}.json`, JSON.stringify(started))
        dispatch(conversation.startTask(started))
        watchTask(started.id, runner)
        return started
      }
    }
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
    dispatch(conversation.startTask(started))
    return started
  }

  const answerTask = async (answer: string) => {
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
    if (from === '' || answer.trim() === '') return
    await actOn(from, 'send', { type: Prompt, text: answer, from: { session, title: task.title } }, { caller: cmodPluginName })
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
      ...(task.status === undefined ? {} : { status: task.status }),
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

  const sessionNamed = async (id: string): Promise<SessionData> => {
    for (const client of await providers()) {
      const found = await findSession(sessionsAsk(client), id)
      if (found !== undefined) return found.id === session ? { ...found, isRunning: true } : found
    }
    throw new Error(`no session ${id} on any of your devices.`)
  }

  const methods: Readonly<Record<string, (request: Request, caller: string | undefined) => Promise<unknown>>> = {
    async [conversationMethods.sessions](request) {
      const found = await listAll({ project: project(), ...fields(request, ['since', 'everyProject', 'running']) })
      return found.map((each) => (each.id === session ? { ...each, isRunning: true } : each))
    },
    [conversationMethods.session]: (request) => sessionNamed(String(request['session'])),
    async [conversationMethods.search](request) {
      const record = fields(request, ['session', 'task', 'turn', 'context', 'isAgent'])
      const options = { project: project(), ...fields(request, ['since', 'everyProject', 'running', 'before', 'limit']), record }
      const pages = await Promise.all((await providers()).map((client) => client.request<Message[]>(`${sessionsInterface}.search`, [String(request['text']), options]).catch((error: unknown) => (client === local.client ? Promise.reject(error) : []))))
      const found = pages.flat().sort((first, second) => second.at.localeCompare(first.at))
      return typeof request['limit'] === 'number' ? found.slice(0, request['limit']) : found
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
      return read<TaskData[]>(id, 'tasks', request['all'] === true ? { all: true } : fields(request, ['task']))
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
    async [conversationMethods.mail](request) {
      return read(String(request['session']), 'mail', fields(request, ['last']))
    },
    async [conversationMethods.updateGoal](request) {
      const id = String(request['session'])
      const task = typeof request['task'] === 'string' ? request['task'] : undefined
      const text = String(request['text'])
      await claude.fs.write(`${goals}/${task ?? id}.txt`, text)
      await starting
      if (id === session) changeGoal(task, text)
      else local.client.notify(sessionActs.changed, { session: id, part: 'goal' })
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
      const input = action === 'send' && task === undefined ? await fromHere(request['input']) : request['input']
      return actOn(target, action, input, { caller, ...(task === undefined ? {} : { task }) })
    },
  }

  const fromHere = async (input: unknown): Promise<unknown> => {
    if (!isObject(input) || input['as'] !== Session || input['from'] !== undefined) return input
    return { ...input, from: { session, title: (await sessionNamed(session)).title } }
  }

  return {
    onUnreached(listener) {
      unreached = listener
      if (isUnreached) listener()
    },
    onStoreChange(listener) {
      storeChanged = listener
    },
    tellStore(part) {
      void local.client.request(methodName(storeInterface, 'changed'), [part]).catch((error: unknown) => {
        if (!isConnectionGone(error) && !(error instanceof RpcError && error.code === rpcCodes.methodNotFound)) report('store', `Could not tell the other sessions that ${part} changed`, error)
      })
    },
    async close() {
      serveChanges?.remove()
      await local.client.close()
    },
    turnClosedBy: (rowId) => closings.get(rowId),
    onTurnClosed(listener) {
      onTurnClosed = listener
    },
    color: () => color,
    onColor(listener) {
      onColor = listener
    },
    moved() {
      void holdHere(local.client).catch((error: unknown) => report('hold', 'Other sessions see this session in its old project until cmod serve answers', error))
    },
    serveUi(methods) {
      ui = methods
    },
    tellUi(event, payload) {
      if (session !== '') local.client.notify(sessionActs.uiEvent, { event, payload })
    },
    tellProviders(names) {
      for (const name of names) void served.providersChanged(name).catch((error: unknown) => report('providers', `Could not tell the mods that a provider of ${name} came or went`, error))
    },
    provide: (name, methods) => served.provide(name, methods),
    async answer(e) {
      const method = methods[e.method]
      const forProviders = method === undefined ? served.answer(e.method, e.input, e.caller) : undefined
      if (method === undefined && forProviders === undefined) return undefined
      try {
        return { value: method === undefined ? await forProviders : await method(isObject(e.input) ? e.input : {}, e.caller) }
      } catch (error) {
        return { deny: messageOf(error) }
      }
    },
  }
}

function taskStartArgsOf(sent: unknown): TaskStartArgs {
  const { machine, ...task } = sent as TaskStartArgs & { readonly machine?: string }
  return machine === undefined || task.device !== undefined ? task : { ...task, device: machine }
}

function textArg(flag: string, value: unknown): string[] {
  return typeof value === 'string' ? [flag, value] : []
}
