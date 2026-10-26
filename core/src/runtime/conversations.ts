import type { Args, EventResult, Frozen } from 'claude-code'
import { consentPath, coreVersion, dataFolder, isObject, parseConsent, readRecord, readSteps } from '../records.js'
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
import { formatExit, messageOf } from '../utils/text.js'
import { beforeAnswerKeys, foldBefore, installBefore, relayOf, type Decide, type Place } from './before.js'
import type { Claude } from './claude.js'
import { cmodPluginName } from './dependencies.js'
import { conversationCalls, refusal } from './grants.js'
import { readLines, runCmod, spawnCmod } from './programs.js'
import type { RoutedHook, Router } from './router.js'
import { PassedTimeout } from './deadline.js'
import { actPermission, conversationMethods, everySession, isAct, isHeardBy, isInScope, pickedColor, resultOf, spawnTask, usageOf, type Act, type Listened, type SessionColor } from './sessions.js'

type Request = Readonly<Record<string, unknown>>

type Heard = { readonly event: Listened['event']; readonly matcher: unknown }

type Watch = { readonly mod: string; readonly target: string; readonly project: string; readonly events: readonly string[]; readonly refusing?: readonly Listened[] }

type Watcher = Watch & { readonly from: string }

type Question =
  | { readonly kind: 'act'; readonly caller: string; readonly action: Act; readonly input: unknown; readonly task?: string }
  | { readonly kind: 'before'; readonly mod: string; readonly event: BeforeEvent; readonly change: SessionChange; readonly project: string }

type Relay =
  | (Question & { readonly id: string; readonly from: string })
  | { readonly kind: 'answer'; readonly id: string; readonly value?: unknown; readonly deny?: string }
  | { readonly kind: 'watch' }
  | { readonly kind: 'goal'; readonly task?: string; readonly text: string }
  | { readonly kind: 'taskEnd'; readonly task: TaskData }

const relayKinds: ReadonlySet<unknown> = new Set(['act', 'before', 'answer', 'watch', 'goal', 'taskEnd'] satisfies Relay['kind'][])

const taskVariable = 'CMOD_TASK'

const isRelay = (value: unknown): value is Relay => isObject(value) && relayKinds.has(value['kind'])

type Asked = { resolve(value: unknown): void; reject(error: Error): void }


const bufferedTaskRows = 200

const beforeDeadlineMs = 5000

const awayFoldMs = 8000

const livenessMs = 5000


export type Conversations = {
  answer(e: Frozen<Args<'cmod.call'>> & { readonly caller?: string }): Promise<EventResult<'cmod.call'> | undefined>
  moved(): void
  turnClosedBy(rowId: string): TurnData | undefined
  color(): SessionColor
  onColor(listener: (told: SessionColor) => void): void
}

const keptClosings = 200

const keptMessages = 200

export function serveConversations({
  claude,
  router,
  store,
  project,
  report,
  clear,
}: {
  readonly claude: Claude
  readonly router: Router
  readonly store: string
  readonly project: () => string
  readonly report: (id: string, message: string, error: unknown) => void
  readonly clear: (id: string) => void
}): Conversations {
  const folder = dataFolder(store, cmodPluginName)
  const goals = `${folder}/goals`
  const backgroundTasks = `${folder}/tasks`
  const watches = `${folder}/before`
  const listeners = `${folder}/listeners`
  const heard = new Map<string, Map<string, readonly Heard[]>>()
  const subscribed = new Map<string, Map<string, readonly Listened[]>>()
  let savingListeners: Promise<unknown> = Promise.resolve()
  const asked = new Map<string, Asked>()
  const ownWatches = new Map<string, Watch>()
  let watchers: readonly Watcher[] = []
  let watching: Promise<void> = Promise.resolve()
  let published = new Set<string>()
  let publishing: Promise<unknown> = Promise.resolve()
  let session = ''
  let asks = 0
  let conversation: Conversation = createConversation(emptyConversation(''))
  let starting: Promise<void> = Promise.resolve()
  let live: Message[] = []
  const liveIds = new Set<string>()
  const waitingRows = new Map<string, Row[]>()
  let follower: { readonly sessions: string; stop(): void } | undefined
  const engineTurns = new Map<string, string>()
  router.add('turn.start', async (e, next) => {
    const agent = (e as typeof e & { readonly agentId?: string }).agentId ?? ''
    engineTurns.set(agent, e.turnId)
    return next(e)
  })
  const endTurn = (ending: TurnEnding, task?: string) => <Below extends { readonly block?: string }>(below: Below): Below => {
    if (below.block !== undefined) return below
    engineTurns.delete(task ?? '')
    dispatch(session, conversation.endTurn(new Date().toISOString(), ending, task))
    return below
  }
  router.add('classic.Stop', async (e, next) => endTurn({ reason: 'answer', ...(e.last_assistant_message === undefined ? {} : { answer: e.last_assistant_message }) })(await next(e)))
  router.add('classic.StopFailure', async (e, next) => endTurn({ reason: 'error', failure: { type: String(e.error), text: e.error_details ?? e.last_assistant_message ?? String(e.error) } })(await next(e)))
  router.add('classic.SubagentStop', async (e, next) => endTurn({ reason: 'answer', ...(e.last_assistant_message === undefined ? {} : { answer: e.last_assistant_message }) }, e.agent_id)(await next(e)))
  router.add('classic.Stop', async (e, next) => {
    const below = await next(e)
    if (below.block === undefined) void answerTask().catch((error: unknown) => report('task', 'Could not record that this session answered its task', error))
    return below
  })

  const json = async <Value>(args: readonly string[]): Promise<Value> => JSON.parse(await runCmod(claude, [...args, '--json', '--project', project()], await claude.session.id())) as Value

  const isGranted = async (caller: string | undefined, item: string) => {
    if (caller === cmodPluginName) return true
    if (caller === undefined) return false
    const path = consentPath(store)
    const text = await claude.fs.read(path).catch(ifMissing('{}'))
    return (parseConsent(JSON.parse(text), path)[caller] ?? []).includes(item)
  }

  const declaredBy = async (caller: string): Promise<readonly string[] | undefined> => {
    const read = (path: string) => claude.fs.read(path).catch(ifMissing(undefined))
    const record = await readRecord(read, store, caller)
    if (record === undefined) return undefined
    if (record.permissions !== null) return record.permissions
    const pkg = await read(`${record.root}/package.json`)
    return pkg === undefined ? undefined : (readSteps(JSON.parse(pkg))?.permissions ?? [])
  }

  const refused = async (caller: string | undefined, call: string, item: string) => {
    const declared =
      caller === undefined
        ? undefined
        : await declaredBy(caller).catch((error: unknown) => {
            claude.ui.log(`cmod: its refusal of ${caller} names the grant, because the permissions ${caller} declares are unreadable: ${messageOf(error)}`, { to: 'debug' })
            return undefined
          })
    return refusal({ name: caller ?? 'A mod', declared: declared ?? [item], home: undefined }, call, item)
  }


  const ended = (id: string) => new Error(`session ${id} has ended`)

  const isRunning = async (id: string) => (await json<SessionData[]>(['history', 'sessions', '--running', '--all'])).some((each) => each.id === id)

  let color: SessionColor = { session: '' }
  let onColor: (told: SessionColor) => void = () => undefined

  const recolor = (id: string, picked: string | undefined) => {
    if (session !== id) return
    color = { session: id, ...(picked === undefined ? {} : { color: picked }) }
    onColor(color)
  }

  const readColor = (id: string) =>
    void json<SessionData[]>(['history', 'sessions', '--running', '--all'])
      .then((running) => recolor(id, running.find((each) => each.id === id)?.color))
      .catch((error: unknown) => report('color', `Could not read the color of session ${id}`, error))

  router.add('command.run', async (e, next) => {
    const answer = await next(e)
    if (e.command !== 'color' || session === '') return answer
    if (e.args.trim() === '') readColor(session)
    else recolor(session, pickedColor(e.args))
    return answer
  })

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
          (error: unknown) => report(`changed:${mod}`, `Could not tell ${mod} about session ${to}`, error),
        )
      }
    }
  }

  const restartFollower = async () => {
    if (session === '') return
    const wantsEvery = [...heard.values()].some((sessions) => (sessions.get(everySession) ?? []).length > 0)
    const named = [...heard.values()].flatMap((sessions) => [...sessions].filter(([id, list]) => id !== session && id !== everySession && list.length > 0).map(([id]) => id))
    const others = [...new Set(named)].sort()
    const args = [...others, ...(wantsEvery ? ['--running'] : [])]
    const wanted = [session, project(), ...args].join(' ')
    if (follower?.sessions === wanted) return
    follower?.stop()
    follower = undefined
    if (args.length === 0) return
    const stream = spawnCmod(claude, ['history', 'follow', ...args, '--json', '--project', project()], session)
    const started = { sessions: wanted, stop: () => void stream.return(undefined as never) }
    follower = started
    void readLines(stream, (line) => {
      if (line.trim() === '') return
      const parsed = JSON.parse(line) as { readonly session: string; readonly isInProject: boolean; readonly change: SessionChange }
      dispatch(parsed.session, [parsed.change], parsed.isInProject)
    })
      .then(({ code, lastError }) => {
        if (follower === started) throw new Error(`cmod history follow ${formatExit(code, lastError)}`)
      })
      .catch((error: unknown) => {
        if (follower !== started) return
        follower = undefined
        report('follow', 'Stopped hearing the other sessions', error)
      })
  }

  const follow = () => void restartFollower().catch((error: unknown) => report('follow', 'Stopped hearing the other sessions', error))

  const post = async (to: string, relay: Relay) => {
    const sent = await claude.session.send({ to: { sessionId: to }, text: `<cmod-relay>${JSON.stringify(relay)}</cmod-relay>` })
    if (sent.isDelivered !== true) throw ended(to)
  }

  const waitingOn = new Map<Asked, string>()
  let liveness: { cancel(): void } | undefined
  let isChecking = false
  const checkLiveness = async () => {
    if (isChecking) return
    isChecking = true
    try {
      const waiting = [...waitingOn]
      const running = new Set((await json<SessionData[]>(['history', 'sessions', '--running', '--all'])).map((each) => each.id))
      for (const [settle, to] of waiting) if (!running.has(to)) settle.reject(ended(to))
    } finally {
      isChecking = false
    }
  }
  const watchLife = (settle: Asked, to: string) => {
    waitingOn.set(settle, to)
    liveness ??= claude.clock.every(livenessMs, () => void checkLiveness().catch((error: unknown) => report('liveness', 'Could not check which sessions still run', error)))
    return {
      cancel() {
        waitingOn.delete(settle)
        if (waitingOn.size > 0) return
        liveness?.cancel()
        liveness = undefined
      },
    }
  }

  const ask = (to: string, relay: Question, deadlineMs?: number) =>
    new Promise<unknown>((resolve, reject) => {
      const id = `${session}:${(asks += 1)}`
      const settle: Asked = {
        resolve(value) {
          if (asked.delete(id)) timer.cancel()
          resolve(value)
        },
        reject(error) {
          if (asked.delete(id)) timer.cancel()
          reject(error)
        },
      }
      const timer = deadlineMs === undefined ? watchLife(settle, to) : claude.clock.after(deadlineMs, () => settle.reject(new PassedTimeout(`session ${to} did not answer within ${deadlineMs / 1000} s`)))
      asked.set(id, settle)
      post(to, { ...relay, id, from: session }).catch((error: unknown) => settle.reject(error instanceof Error ? error : new Error(messageOf(error))))
    })

  const publishWatches = (isEnding = false) => {
    const next = publishing.then(() => publishNow(isEnding))
    publishing = next.catch((error: unknown) => claude.ui.log(`cmod: publishing before listeners failed: ${messageOf(error)}`, { to: 'debug' }))
    return next
  }

  const publishNow = async (isEnding: boolean) => {
    if (session === '') return
    const list = isEnding ? [] : [...ownWatches.values()].filter((watch) => watch.events.length > 0)
    await claude.fs.write(`${watches}/${session}.json`, JSON.stringify(list))
    const targets = new Set([...published, ...list.map((watch) => watch.target)])
    published = new Set(list.map((watch) => watch.target))
    const running = targets.has(everySession) ? (await json<SessionData[]>(['history', 'sessions', '--running'])).map((each) => each.id) : []
    const told = new Set([...running, ...targets].filter((id) => id !== everySession && id !== session))
    await Promise.all([...told].map((id) => post(id, { kind: 'watch' }).catch((error: unknown) => claude.ui.log(`cmod: session ${id} did not hear of a before listener: ${messageOf(error)}`, { to: 'debug' }))))
  }

  const hear = (caller: string, id: string, list: readonly Listened[]) => {
    const sessions = heard.get(caller) ?? new Map<string, readonly Heard[]>()
    sessions.set(id, list.map(({ event, matcher }) => ({ event, matcher: matcher === undefined ? undefined : receivedMatcher(matcher) })))
    heard.set(caller, sessions)
    const lists = subscribed.get(caller) ?? new Map<string, readonly Listened[]>()
    lists.set(id, list)
    subscribed.set(caller, lists)
  }

  const saveListeners = (isEnding = false) => {
    const at = session
    const kept = isEnding ? {} : Object.fromEntries([...subscribed].map(([caller, lists]) => [caller, Object.fromEntries(lists)]))
    const next = savingListeners.then(() => (at === '' ? undefined : claude.fs.write(`${listeners}/${at}.json`, JSON.stringify(kept))))
    savingListeners = next.catch((error: unknown) => claude.ui.log(`cmod: saving the mods' listeners failed: ${messageOf(error)}`, { to: 'debug' }))
    return next
  }

  const restoreListeners = async () => {
    const kept = JSON.parse(await claude.fs.read(`${listeners}/${session}.json`).catch(ifMissing('{}'))) as Readonly<Record<string, Readonly<Record<string, readonly Listened[]>>>>
    for (const [caller, lists] of Object.entries(kept)) if (!subscribed.has(caller)) for (const [id, list] of Object.entries(lists)) hear(caller, id, list)
  }

  const readWatchers = async () => {
    const files = await claude.fs.list(watches).catch(ifMissing([]))
    const found: Watcher[] = []
    for (const file of files) {
      const from = file.name.replace(/\.json$/, '')
      if (!file.name.endsWith('.json')) continue
      const list = JSON.parse(await claude.fs.read(`${watches}/${file.name}`).catch(ifMissing('[]'))) as readonly Watch[]
      if (from === session) {
        for (const watch of list) if (!ownWatches.has(`${watch.mod}\n${watch.target}`)) ownWatches.set(`${watch.mod}\n${watch.target}`, watch)
        continue
      }
      found.push(...list.filter((watch) => watch.target === session || (watch.target === everySession && watch.project === project())).map((watch) => ({ ...watch, from })))
    }
    watchers = found
  }

  const changeGoal = (task: string | undefined, text: string) => dispatch(session, task === undefined ? conversation.changeGoal(text) : [{ type: GoalChange, goal: { text, task } }])

  const reloadWatchers = () => {
    watching = readWatchers().catch((error: unknown) => report('before', 'Kept the other sessions’ before listeners from before', error))
  }

  const place = (): Place => {
    const { context, contextOpenedAt, turn, tasks, taskTurns, openCalls } = conversation.state
    return { session, context, contextOpenedAt, ...(turn === undefined ? {} : { turn }), tasks, taskTurns, ...(openCalls === undefined ? {} : { openCalls }) }
  }

  const deciders = (event: string): Watcher[] => {
    const all = [...[...ownWatches.values()].filter((watch) => watch.target === session || watch.target === everySession).map((watch) => ({ ...watch, from: session })), ...watchers]
    return [...new Map(all.filter((watcher) => watcher.events.includes(event)).map((watcher) => [`${watcher.from}\n${watcher.mod}`, watcher])).values()]
  }

  const askHere = async (mod: string, event: BeforeEvent, change: SessionChange, from = session, isInProject = true) => {
    if (from !== session && !(await isGranted(mod, 'conversation'))) throw new Error(await refused(mod, 'before', 'conversation'))
    return claude.cmod.call({ to: mod, method: conversationMethods.before, input: { session: from, event, change, isInProject } })
  }

  const isUnderHere = (task: string, ancestor: string) => {
    for (let at: string | undefined = task, steps = 0; at !== undefined && steps < 64; at = conversation.state.tasks[at]?.parent, steps += 1) if (at === ancestor) return true
    return false
  }

  const refuses = (watcher: Watcher, event: BeforeEvent, change: SessionChange) =>
    beforeAnswerKeys[event].includes('refuse') && (watcher.refusing ?? []).some(({ event: heard, matcher, scope }) => isInScope(scope ?? {}, session, change, isUnderHere) && isHeardBy(heard, matcher === undefined ? undefined : receivedMatcher(matcher), change))

  const askAway = async (watcher: Watcher, event: BeforeEvent, change: SessionChange, endsAt: number) => {
    try {
      const leftMs = Math.min(beforeDeadlineMs, endsAt - (await claude.clock.now()))
      if (leftMs <= 0) throw new PassedTimeout(`the ${awayFoldMs / 1000} s cmod waits on other sessions ran out before session ${watcher.from} was asked`)
      return await ask(watcher.from, { kind: 'before', mod: watcher.mod, event, change, project: project() }, leftMs)
    } catch (error) {
      if (await isRunning(watcher.from)) {
        if (error instanceof PassedTimeout && refuses(watcher, event, change)) return { refuse: `${watcher.mod}: ${error.message}` }
        throw error
      }
      watchers = watchers.filter((each) => each.from !== watcher.from)
      claude.ui.log(`cmod: session ${watcher.from} ended without clearing its before listeners, so they are cleared now`, { to: 'debug' })
      await claude.fs.write(`${watches}/${watcher.from}.json`, '[]')
      return undefined
    }
  }

  const wants = async (event: BeforeEvent) => {
    await Promise.all([starting, watching])
    return deciders(event).length > 0
  }

  const decide = (): Decide => {
    let endsAt: Promise<number> | undefined
    return (event, change) =>
      foldBefore(
        event,
        change,
        deciders(event).map((watcher) => async (latest: SessionChange) => {
          if (watcher.from === session) return askHere(watcher.mod, event, latest)
          endsAt ??= claude.clock.now().then((now) => now + awayFoldMs)
          return askAway(watcher, event, latest, await endsAt)
        }),
        (error) => report(`before:${event}`, `Passed the ${event} on without a mod's answer`, error),
      )
  }

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
    },
  })

  const start = (id: string, source: string) => {
    if (id === session) return
    const previous = session
    session = id
    live = []
    liveIds.clear()
    waitingRows.clear()
    conversation = createConversation(emptyConversation(id))
    const isNew = source === 'startup' || source === 'clear'
    if (!isNew) readColor(id)
    starting =
      isNew
        ? Promise.resolve(dispatch(id, conversation.startContext(new Date().toISOString())))
        : json<ConversationState>(['history', 'state', id]).then(
            (state) => {
              if (session === id) conversation = createConversation({ ...emptyConversation(id), ...state })
            },
            (error: unknown) => report('state', `Starts session ${id} without its earlier turns`, error),
          )
    const restored = restoreListeners()
      .catch((error: unknown) => report('listeners', "Could not read back the mods' listeners of this session", error))
      .then(follow)
    starting = Promise.all([starting, restored]).then(() => undefined)
    reloadWatchers()
    if (subscribed.size > 0) void Promise.all([previous === '' ? undefined : claude.fs.write(`${listeners}/${previous}.json`, '{}'), saveListeners()]).catch((error: unknown) => report('follow', 'Kept telling the mods about the session from before', error))
    if (ownWatches.size === 0) return
    void Promise.all([previous === '' ? undefined : claude.fs.write(`${watches}/${previous}.json`, '[]'), publishWatches()]).catch((error: unknown) => report('before', 'Kept its before listeners on the session from before', error))
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
    if (ownWatches.size > 0) await publishWatches(true).catch((error: unknown) => report('before', 'Left its before listeners registered', error))
    if (subscribed.size > 0) await saveListeners(true).catch((error: unknown) => report('follow', 'Left its listeners registered', error))
    return next(e)
  })

  const recordAppend: RoutedHook<'session.append'> = async (e, next) => {
    const kept = await next(e)
    if (kept.deny !== undefined || session === '') return kept
    const cwd = e.message.type === 'assistant' ? await claude.session.cwd() : ''
    void take(rowOfAppend({ uuid: kept.uuid, door: e.door, origin: e.origin, message: kept.message }, new Date().toISOString(), cwd), e.agentId).catch((error: unknown) => report('append', 'Missed a message', error))
    return kept
  }
  router.add('session.append', recordAppend, (e, _error, next) => recordAppend(e, next))

  const recordCompaction: RoutedHook<'session.compact'> = async (e, next) => {
    const compacted = await next(e)
    if (e.trigger === 'precompute' || compacted.skip !== undefined || session === '') return compacted
    const at = new Date().toISOString()
    const boundary: Row = { id: `compact:${e.agentId ?? session}:${at}`, at, type: 'system', name: 'compact_boundary', isMeta: false, isSummary: false, content: [] }
    void take(boundary, e.agentId).catch((error: unknown) => report('compact', 'Missed a compaction', error))
    return compacted
  }
  router.add('session.compact', recordCompaction, (e, _error, next) => recordCompaction(e, next))

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
    if (relay.kind === 'answer') {
      const waiting = asked.get(relay.id)
      if (relay.deny === undefined) waiting?.resolve(relay.value)
      else waiting?.reject(new Error(relay.deny))
      return
    }
    if (relay.kind === 'watch') return readWatchers()
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
    const answered = async (run: () => Promise<unknown>) => {
      try {
        await post(relay.from, { kind: 'answer', id: relay.id, value: (await run()) ?? null })
      } catch (error) {
        await post(relay.from, { kind: 'answer', id: relay.id, deny: messageOf(error) })
      }
    }
    if (relay.kind === 'act') return answered(async () => (isAct(relay.action) ? perform(relay.caller, relay.action, relay.input, relay.task) : Promise.reject(await unknownTo(`"${String(relay.action)}" action`))))
    return answered(() => askHere(relay.mod, relay.event, relay.change, relay.from, relay.project === project()))
  }

  const checkAct = async (caller: string, action: Act, input: unknown) => {
    const needed = actPermission(action, input)
    if (needed !== undefined && !(await isGranted(caller, needed))) throw new Error(await refused(caller, action, needed))
  }

  const perform = async (caller: string, action: Act, input: unknown, task: string | undefined): Promise<unknown> => {
    await checkAct(caller, action, input)
    await starting
    if (action === 'abort') return abortTurn(input, task)
    if (task !== undefined) return performInTask(caller, action, input, task)
    if (action === 'usage') return usageOf(claude)
    if (action === 'surfaces') return [...(await claude.session.surfaces())] satisfies Surface[]
    if (action === 'send') {
      const { type, text, as } = input as SessionSend
      if (as === Session) throw new Error(`session ${session} cannot send as itself to itself.`)
      const delivered = type === Note ? await claude.session.append({ message: { type: 'user', content: [{ type: 'text', text: modNote(caller, text) }] } }) : await claude.prompt.submit({ text, ...(as === Person ? { asUser: true } : {}) })
      if ('deny' in delivered && typeof delivered.deny === 'string') throw new Error(`Claude Code refused the note: ${delivered.deny}`)
      if ('drop' in delivered && typeof delivered.drop === 'string') throw new Error(`Claude Code dropped the prompt: ${delivered.drop}`)
      return null
    }
    if (action === 'startTask') return spawnTask(claude, input as TaskStartArgs)
    if (action === 'fork') return spawnTask(claude, input as TaskStartArgs, session)
    if (action === 'startBackgroundTask') return startBackground(input as TaskStartArgs)
    if (action === 'clone') return startBackground(input as TaskStartArgs, session)
    const { name, input: toolInput } = input as ToolCallArgs
    return resultOf(place(), { name, input: toolInput, cwd: await claude.session.cwd() }, await claude.tool.call({ ...toolInput, tool: name } as never))
  }

  const abortTurn = async (input: unknown, task: string | undefined) => {
    const turnId = engineTurns.get(task ?? '')
    if (turnId === undefined) throw new Error(`no turn is running in ${task === undefined ? `session ${session}` : `task ${task}`}.`)
    const asked = isObject(input) ? input['turn'] : undefined
    const open = task === undefined ? conversation.state.turn : conversation.state.taskTurns[task]
    if (open?.prompt.id !== asked) throw new Error(`turn ${String(asked)} has ended, so there is nothing to abort.`)
    await claude.turn.abort({ turnId })
    return null
  }

  const performInTask = async (caller: string, action: Act, input: unknown, task: string): Promise<unknown> => {
    const running = conversation.state.tasks[task]
    if (action === 'usage') return json(['history', 'usage', session, '--task', task])
    if (action === 'surfaces') return running === undefined || running.closedAt !== undefined ? [] : [...(await claude.session.surfaces())]
    if (action !== 'send') throw new Error(`cmod: ${action} runs only on a session's own main loop.`)
    if (running === undefined || running.closedAt !== undefined) throw ended(task)
    const { type, text } = input as SessionSend
    const sent = await claude.session.send({ to: { agentId: task }, text: type === Note ? modNote(caller, text) : text })
    if (sent.isDelivered !== true) throw ended(task)
    return null
  }

  const startBackground = async (task: TaskStartArgs, forkedFrom?: string): Promise<TaskData> => {
    if (task.title.trim() === '') throw new Error('a task needs a title.')
    if (task.name !== undefined) throw new Error('a background task takes no name.')
    const fresh: Partial<TaskStartArgs> = forkedFrom === undefined ? task : {}
    const asked: TaskData = { id: '', title: task.title, ...(forkedFrom === undefined ? {} : { forkedFrom }), ...(fresh.agentType === undefined ? {} : { agentType: fresh.agentType }), ...(fresh.model === undefined ? {} : { model: fresh.model }), openedBy: '', openedAt: new Date().toISOString(), isBackground: true }
    const answer = (await wants(TaskStart)) ? await decide()(TaskStart, { type: TaskStart, task: { ...asked, context: conversation.state.context } }) : undefined
    if (answer?.refuse !== undefined) throw new Error(`a beforeTaskStart listener refused the task: ${answer.refuse}`)
    const owner = forkedFrom === undefined ? (answer?.owner ?? {}) : {}
    const folder = owner.cwd ?? fresh.cwd
    const here = await claude.session.cwd()
    const args = [
      'task',
      'start',
      '--title',
      answer?.title ?? task.title,
      ...(forkedFrom === undefined ? [] : ['--clone']),
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
    const ended: TaskData = { ...task, id: session, closedAt: new Date().toISOString() }
    await claude.fs.write(`${backgroundTasks}/${from}/${session}.json`, JSON.stringify(ended))
    await post(from, { kind: 'taskEnd', task: ended }).catch((error: unknown) => claude.ui.log(`cmod: session ${from} did not hear that its task ${session} answered: ${messageOf(error)}`, { to: 'debug' }))
  }

  const actElsewhere = async (caller: string, target: string, action: Act, input: unknown, task: string | undefined): Promise<unknown> => {
    await checkAct(caller, action, input)
    const isLive = await isRunning(target)
    if (!isLive && action === 'usage') return json(['history', 'usage', target, ...(task === undefined ? [] : ['--task', task])])
    if (!isLive && action === 'surfaces') return []
    if (!isLive) throw ended(task ?? target)
    if (action === 'send' && task === undefined && (input as SessionSend).as === Session) {
      const sent = await claude.session.send({ to: { sessionId: target }, text: (input as SessionSend).text })
      if (sent.isDelivered !== true) throw ended(target)
      return null
    }
    return ask(target, { kind: 'act', caller, action, input, ...(task === undefined ? {} : { task }) })
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

  const methods: Readonly<Record<string, (request: Request, caller: string | undefined) => Promise<unknown>>> = {
    async [conversationMethods.sessions](request) {
      const found = await json<SessionData[]>(['history', 'sessions', ...scopeArgs(request), ...(request['running'] === true ? ['--running'] : [])])
      return found.map((each) => (each.id === session ? { ...each, isRunning: true } : each))
    },
    async [conversationMethods.search](request) {
      const before = isObject(request['before']) ? request['before'] : undefined
      const record = [...textArg('--session', request['session']), ...textArg('--task', request['task']), ...textArg('--turn', request['turn']), ...countArg('--context', request['context']), ...(request['isAgent'] === true ? ['--agent'] : [])]
      return json(['history', 'search', String(request['text']), ...scopeArgs(request), ...record, ...(request['running'] === true ? ['--running'] : []), ...(before === undefined ? [] : ['--before', `${String(before['session'])}:${String(before['id'])}`])])
    },
    async [conversationMethods.messages](request) {
      const id = String(request['session'])
      const filters = [...textArg('--turn', request['turn']), ...textArg('--task', request['task']), ...textArg('--after', request['after'])]
      const saved = () => json<Message[]>(['history', 'messages', id, ...filters, ...countArg('--last', request['last'])])
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
      const saved = () => json<TurnData[]>(['history', 'turns', id, ...textArg('--task', request['task']), ...countArg('--context', request['context']), ...countArg('--last', request['last'])])
      if (id !== session) return saved()
      await starting
      const kept = liveTurns(request['task']).filter((turn) => request['context'] === undefined || turn.context === request['context'])
      if (isHeld(kept, request['last'])) return lastOf(kept, request['last'])
      return lastOf(merged(await saved(), kept, (turn) => turn.prompt.id), request['last'])
    },
    async [conversationMethods.contexts](request) {
      const id = String(request['session'])
      const saved = await json<ContextData[]>(['history', 'contexts', id, ...textArg('--task', request['task'])]).catch((error: unknown) => {
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
      const saved = await json<TaskData[]>(['history', 'tasks', id, ...(isNested ? ['--nested'] : textArg('--task', request['task']))])
      if (id !== session) return saved
      await starting
      const kept = liveTasks().filter((task) => isNested || task.parent === request['task'])
      const running = await claude.agent.list().catch((error: unknown) => (claude.ui.log(`cmod: the tasks show no status, because Claude Code listed no agents: ${messageOf(error)}`, { to: 'debug' }), []))
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
      return json(['history', 'goal', id, ...textArg('--task', task)])
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
        await post(id, { kind: 'goal', ...(task === undefined ? {} : { task }), text }).catch((error: unknown) => claude.ui.log(`cmod: session ${id} keeps its goal until it starts again: ${messageOf(error)}`, { to: 'debug' }))
      }
      return null
    },
    async [conversationMethods.subscribe](request, caller) {
      if (caller === undefined) throw new Error('cmod hears no caller for this subscription.')
      const id = String(request['session'])
      const list = Array.isArray(request['subscriptions']) ? (request['subscriptions'] as readonly Listened[]) : []
      hear(caller, id, list)
      follow()
      await saveListeners()
      return null
    },
    async [conversationMethods.watchBefore](request, caller) {
      if (caller === undefined) throw new Error('cmod hears no caller for this before listener.')
      const target = String(request['session'])
      const list = Array.isArray(request['subscriptions']) ? (request['subscriptions'] as readonly Listened[]) : []
      ownWatches.set(`${caller}\n${target}`, { mod: caller, target, project: project(), events: [...new Set(list.map(({ event }) => event))], refusing: list.filter((each) => each.onFailure === 'refuse') })
      await publishWatches()
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
    turnClosedBy: (rowId) => closings.get(rowId),
    color: () => color,
    onColor(listener) {
      onColor = listener
    },
    moved() {
      for (const [key, watch] of ownWatches) ownWatches.set(key, { ...watch, project: project() })
      void publishWatches().catch((error: unknown) => report('before', 'Kept its before listeners on the project from before', error))
      reloadWatchers()
      follow()
    },
    async answer(e) {
      const method = methods[e.method]
      if (method === undefined) return undefined
      const input = isObject(e.input) ? e.input : {}
      const isDropping = (e.method === conversationMethods.subscribe || e.method === conversationMethods.watchBefore) && Array.isArray(input['subscriptions']) && input['subscriptions'].length === 0
      if (e.method !== conversationMethods.act && !isDropping && input['session'] !== (await claude.session.id()) && !(await isGranted(e.caller, 'conversation'))) return { deny: await refused(e.caller, conversationCalls[e.method] ?? e.method, 'conversation') }
      try {
        return { value: await method(input, e.caller) }
      } catch (error) {
        return { deny: messageOf(error) }
      }
    },
  }
}

function scopeArgs(request: Request): string[] {
  return [...(typeof request['since'] === 'string' ? ['--since', request['since']] : []), ...(request['everyProject'] === true ? ['--all'] : [])]
}

function countArg(flag: string, value: unknown): string[] {
  return typeof value === 'number' ? [flag, String(value)] : []
}

function textArg(flag: string, value: unknown): string[] {
  return typeof value === 'string' ? [flag, value] : []
}
