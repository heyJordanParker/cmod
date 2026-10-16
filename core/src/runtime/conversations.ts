import type { Args, EventResult, Frozen } from 'claude-code'
import { consentPath, dataFolder, isObject, parseConsent } from '../records.js'
import { Message, rowOfAppend, type Row } from '../session/context/turn/message/message.js'
import { Note } from '../session/context/turn/message/note.js'
import { Person } from '../session/context/turn/message/sender.js'
import { createConversation, emptyConversation, type Conversation, type ConversationState, type ContextData, type SessionChange, type SessionData, type TaskData, type TurnData } from '../session/conversation.js'
import { Session, UsageChange, type BeforeEvent, type Client, type SessionSend, type TaskStartArgs, type ToolCallArgs } from '../session/session.js'
import { GoalChange } from '../session/goal/goal.js'
import { receivedMatcher } from '../utils/matcher.js'
import { ifMissing } from '../utils/paths.js'
import { formatExit, messageOf } from '../utils/text.js'
import { foldAnswers, installBefore, relayOf, type Place } from './before.js'
import type { Claude } from './claude.js'
import { cmodPluginName } from './dependencies.js'
import { readLines, runCmod } from './programs.js'
import type { Router } from './router.js'
import { actPermission, conversationMethods, everySession, isAct, isHeardBy, resultOf, usageOf, type Act, type Subscription } from './sessions.js'

type Request = Readonly<Record<string, unknown>>

type Heard = { readonly event: Subscription['event']; readonly matcher: unknown }

type Watch = { readonly mod: string; readonly target: string; readonly project: string; readonly events: readonly string[] }

type Watcher = Watch & { readonly from: string }

type Question =
  | { readonly kind: 'act'; readonly caller: string; readonly action: Act; readonly input: unknown; readonly task?: string }
  | { readonly kind: 'before'; readonly mod: string; readonly event: BeforeEvent; readonly change: SessionChange; readonly project: string }

type Relay = (Question & { readonly id: string; readonly from: string }) | { readonly kind: 'answer'; readonly id: string; readonly value?: unknown; readonly deny?: string } | { readonly kind: 'watch' } | { readonly kind: 'goal'; readonly task?: string; readonly text: string }

type Asked = { resolve(value: unknown): void; reject(error: Error): void }


const bufferedTaskRows = 200

const beforeDeadlineMs = 5000

const livenessMs = 5000


export type Conversations = {
  answer(e: Frozen<Args<'cmod.call'>> & { readonly caller?: string }): Promise<EventResult<'cmod.call'> | undefined>
  moved(): void
}

export function serveConversations({ claude, router, store, project, report }: { readonly claude: Claude; readonly router: Router; readonly store: string; readonly project: () => string; readonly report: (id: string, message: string, error: unknown) => void }): Conversations {
  const folder = dataFolder(store, cmodPluginName)
  const goals = `${folder}/goals`
  const watches = `${folder}/before`
  const heard = new Map<string, Map<string, readonly Heard[]>>()
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

  const json = async <Value>(args: readonly string[]): Promise<Value> => JSON.parse(await runCmod(claude, [...args, '--json', '--project', project()], session === '' ? await claude.session.id() : session)) as Value

  const isGranted = async (caller: string | undefined, item: string) => {
    if (caller === cmodPluginName) return true
    if (caller === undefined) return false
    const path = consentPath(store)
    const text = await claude.fs.read(path).catch(ifMissing('{}'))
    return (parseConsent(JSON.parse(text), path)[caller] ?? []).includes(item)
  }

  const ended = (id: string) => new Error(`session ${id} has ended`)

  const isRunning = async (id: string) => (await json<SessionData[]>(['history', 'sessions', '--running', '--all'])).some((each) => each.id === id)

  const dispatch = (to: string, changes: readonly SessionChange[], isInProject = true) => {
    for (const change of changes) {
      if (change.type === Message && !liveIds.has(change.message.id) && to === session) {
        live.push(change.message)
        liveIds.add(change.message.id)
      }
      for (const [mod, sessions] of heard) {
        const subscriptions = [...(sessions.get(to) ?? []), ...(isInProject ? (sessions.get(everySession) ?? []) : [])]
        if (!subscriptions.some(({ event, matcher }) => isHeardBy(event, matcher, change))) continue
        void claude.cmod.call({ to: mod, method: conversationMethods.changed, input: { session: to, change, isInProject } }).catch((error: unknown) => report(`changed:${mod}`, `Could not tell ${mod} about session ${to}`, error))
      }
    }
  }

  const restartFollower = async () => {
    const wantsEvery = [...heard.values()].some((sessions) => (sessions.get(everySession) ?? []).length > 0)
    const named = [...heard.values()].flatMap((sessions) => [...sessions].filter(([id, list]) => id !== session && id !== everySession && list.length > 0).map(([id]) => id))
    const others = [...new Set(named)].sort()
    const args = [...others, ...(wantsEvery ? ['--running'] : [])]
    const wanted = [session, project(), ...args].join(' ')
    if (follower?.sessions === wanted) return
    follower?.stop()
    follower = undefined
    if (args.length === 0) return
    const stream = claude.process.spawn({ argv: ['cmod', 'history', 'follow', ...args, '--json', '--project', project()], env: { CLAUDE_CODE_SESSION_ID: session } })
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

  const ask = (to: string, relay: Question, deadlineMs?: number) =>
    new Promise<unknown>((resolve, reject) => {
      const id = `${session}:${(asks += 1)}`
      const timer =
        deadlineMs === undefined
          ? claude.clock.every(livenessMs, () => {
              void isRunning(to).then((isLive) => {
                if (!isLive) settle.reject(ended(to))
              })
            })
          : claude.clock.after(deadlineMs, () => settle.reject(new Error(`session ${to} did not answer within ${deadlineMs / 1000} s`)))
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

  const readWatchers = async () => {
    const files = await claude.fs.list(watches).catch(ifMissing([]))
    const found: Watcher[] = []
    for (const file of files) {
      const from = file.name.replace(/\.json$/, '')
      if (from === session || !file.name.endsWith('.json')) continue
      const list = JSON.parse(await claude.fs.read(`${watches}/${file.name}`).catch(ifMissing('[]'))) as readonly Watch[]
      found.push(...list.filter((watch) => watch.target === session || (watch.target === everySession && watch.project === project())).map((watch) => ({ ...watch, from })))
    }
    watchers = found
  }

  const changeGoal = (task: string | undefined, text: string) => dispatch(session, task === undefined ? conversation.changeGoal(text) : [{ type: GoalChange, goal: { text, task } }])

  const reloadWatchers = () => {
    watching = readWatchers().catch((error: unknown) => report('before', 'Kept the other sessions’ before listeners from before', error))
  }

  const place = (): Place => {
    const { context, contextOpenedAt, turn, tasks, taskTurns } = conversation.state
    return { session, context, contextOpenedAt, ...(turn === undefined ? {} : { turn }), tasks, taskTurns }
  }

  const deciders = (event: string): Watcher[] => {
    const all = [...[...ownWatches.values()].filter((watch) => watch.target === session || watch.target === everySession).map((watch) => ({ ...watch, from: session })), ...watchers]
    return [...new Map(all.filter((watcher) => watcher.events.includes(event)).map((watcher) => [`${watcher.from}\n${watcher.mod}`, watcher])).values()]
  }

  const askHere = async (mod: string, event: BeforeEvent, change: SessionChange, from = session, isInProject = true) => {
    if (from !== session && !(await isGranted(mod, 'conversation'))) throw new Error(`${mod} needs the conversation permission to change what happens in another session. Turn it on in /mods ${mod}.`)
    return claude.cmod.call({ to: mod, method: conversationMethods.before, input: { session: from, event, change, isInProject } })
  }

  const askAway = async (watcher: Watcher, event: BeforeEvent, change: SessionChange) => {
    try {
      return await ask(watcher.from, { kind: 'before', mod: watcher.mod, event, change, project: project() }, beforeDeadlineMs)
    } catch (error) {
      if (await isRunning(watcher.from)) throw error
      watchers = watchers.filter((each) => each.from !== watcher.from)
      claude.ui.log(`cmod: session ${watcher.from} ended without clearing its before listeners, so they are cleared now`, { to: 'debug' })
      await claude.fs.write(`${watches}/${watcher.from}.json`, '[]')
      return undefined
    }
  }

  installBefore({
    claude,
    router,
    hooks: {
      place: async () => {
        await starting
        return place()
      },
      wants: async (event) => {
        await Promise.all([starting, watching])
        return deciders(event).length > 0
      },
      decide: (event, change) =>
        foldAnswers(
          event,
          change,
          deciders(event).map((watcher) => (latest: SessionChange) => (watcher.from === session ? askHere(watcher.mod, event, latest) : askAway(watcher, event, latest))),
          (error) => report(`before:${event}`, `Passed the ${event} on without a mod's answer`, error),
        ),
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
    starting =
      source === 'startup' || source === 'clear'
        ? Promise.resolve(dispatch(id, conversation.startContext(new Date().toISOString())))
        : json<ConversationState>(['history', 'state', id]).then(
            (state) => {
              if (session === id) conversation = createConversation({ ...emptyConversation(id), ...state })
            },
            (error: unknown) => report('state', `Starts session ${id} without its earlier turns`, error),
          )
    follow()
    reloadWatchers()
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
  }

  router.add('classic.SessionStart', async (e, next) => {
    start(e.session_id, e.source)
    return next(e)
  })
  router.add('classic.SessionEnd', async (e, next) => {
    if (ownWatches.size > 0) await publishWatches(true).catch((error: unknown) => report('before', 'Left its before listeners registered', error))
    return next(e)
  })

  router.add('session.append', async (e, next) => {
    const kept = await next(e)
    if (kept.deny !== undefined || session === '') return kept
    const cwd = e.message.type === 'assistant' ? await claude.session.cwd() : ''
    void take(rowOfAppend({ uuid: kept.uuid, door: e.door, origin: e.origin, message: kept.message }, new Date().toISOString(), cwd), e.agentId).catch((error: unknown) => report('append', 'Missed a message', error))
    return kept
  })

  router.add('session.compact', async (e, next) => {
    const compacted = await next(e)
    if (e.trigger === 'precompute' || compacted.skip !== undefined || session === '') return compacted
    const at = new Date().toISOString()
    const boundary: Row = { id: `compact:${e.agentId ?? session}:${at}`, at, type: 'system', name: 'compact_boundary', isMeta: false, isSummary: false, content: [] }
    void take(boundary, e.agentId).catch((error: unknown) => report('compact', 'Missed a compaction', error))
    return compacted
  })

  router.add('session.measure', async (e, next) => {
    const measured = await next(e)
    if (session !== '') dispatch(session, [{ type: UsageChange, usage: await usageOf(claude) }])
    return measured
  })

  router.add('agent.spawn', async (e, next) => {
    const spawned = await next(e)
    if (spawned.deny !== undefined || spawned.agentId === undefined) return spawned
    const id = spawned.agentId
    const opened: TaskData = { id, title: e.description, agentType: e.subagentType, model: spawned.model, openedBy: e.tool_use_id, openedAt: new Date().toISOString(), ...(e.parentAgentId === undefined ? {} : { parent: e.parentAgentId }) }
    await starting
    dispatch(session, conversation.startTask(opened))
    const waiting = waitingRows.get(id) ?? []
    waitingRows.delete(id)
    for (const row of waiting) dispatch(session, conversation.add(row, id))
    return spawned
  })

  router.add('session.receive', async (e, next) => {
    const sent = relayOf(e)
    if (sent === undefined) return next(e)
    const relay = JSON.parse(sent) as Relay
    claude.clock.after(0, () => void received(relay).catch((error: unknown) => report('relay', 'Could not answer another session', error)))
    return { consumed: 'cmod relay' }
  })

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
    const answered = async (run: () => Promise<unknown>) => {
      try {
        await post(relay.from, { kind: 'answer', id: relay.id, value: (await run()) ?? null })
      } catch (error) {
        await post(relay.from, { kind: 'answer', id: relay.id, deny: messageOf(error) })
      }
    }
    if (relay.kind === 'act') return answered(() => perform(relay.caller, relay.action, relay.input, relay.task))
    return answered(() => askHere(relay.mod, relay.event, relay.change, relay.from, relay.project === project()))
  }

  const checkAct = async (caller: string, action: Act, input: unknown) => {
    const needed = actPermission(action, input)
    if (needed !== undefined && !(await isGranted(caller, needed))) throw new Error(`${caller} needs the ${needed} permission for ${action}. Turn it on in /mods ${caller}.`)
  }

  const perform = async (caller: string, action: Act, input: unknown, task: string | undefined): Promise<unknown> => {
    await checkAct(caller, action, input)
    await starting
    if (task !== undefined) return performInTask(action, input, task)
    if (action === 'usage') return usageOf(claude)
    if (action === 'clients') return [...(await claude.session.surfaces())] satisfies Client[]
    if (action === 'send') {
      const { type, text, as } = input as SessionSend
      if (as === Session) throw new Error(`session ${session} cannot send as itself to itself.`)
      const delivered = type === Note ? await claude.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }) : await claude.prompt.submit({ text, ...(as === Person ? { asUser: true } : {}) })
      if ('deny' in delivered && typeof delivered.deny === 'string') throw new Error(`Claude Code refused the note: ${delivered.deny}`)
      if ('drop' in delivered && typeof delivered.drop === 'string') throw new Error(`Claude Code dropped the prompt: ${delivered.drop}`)
      return null
    }
    if (action === 'startTask') {
      const args = input as TaskStartArgs
      const started = await claude.agent.spawn({
        prompt: args.prompt,
        ...(args.name === undefined ? {} : { description: args.name, name: args.name }),
        ...(args.agentType === undefined ? {} : { subagentType: args.agentType }),
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      })
      if (started.deny !== undefined) throw new Error(`Claude Code refused the task: ${started.deny}`)
      return { id: started.agentId ?? '', title: args.name ?? '', agentType: args.agentType ?? 'general-purpose', model: started.model, openedBy: '', openedAt: new Date().toISOString() } satisfies TaskData
    }
    const { name, input: toolInput } = input as ToolCallArgs
    return resultOf(place(), await claude.tool.call({ ...toolInput, tool: name } as never))
  }

  const performInTask = async (action: Act, input: unknown, task: string): Promise<unknown> => {
    const running = conversation.state.tasks[task]
    if (action === 'usage') return json(['history', 'usage', session, '--task', task])
    if (action === 'clients') return running === undefined || running.closedAt !== undefined ? [] : [...(await claude.session.surfaces())]
    if (action !== 'send') throw new Error(`cmod: ${action} runs only on a session's own main loop.`)
    if (running === undefined || running.closedAt !== undefined) throw ended(task)
    const sent = await claude.session.send({ to: { agentId: task }, text: (input as SessionSend).text })
    if (sent.isDelivered !== true) throw ended(task)
    return null
  }

  const actElsewhere = async (caller: string, target: string, action: Act, input: unknown, task: string | undefined): Promise<unknown> => {
    await checkAct(caller, action, input)
    const isLive = await isRunning(target)
    if (!isLive && action === 'usage') return json(['history', 'usage', target, ...(task === undefined ? [] : ['--task', task])])
    if (!isLive && action === 'clients') return []
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
      agentType: task.agentType,
      ...(task.model === undefined ? {} : { model: task.model }),
      openedBy: task.openedBy,
      openedAt: task.openedAt,
      ...(task.closedAt === undefined ? {} : { closedAt: task.closedAt }),
      ...(task.parent === undefined ? {} : { parent: task.parent }),
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

  const methods: Readonly<Record<string, (request: Request, caller: string | undefined) => Promise<unknown>>> = {
    async [conversationMethods.sessions](request) {
      const found = await json<SessionData[]>(['history', 'sessions', ...scopeArgs(request), ...(request['running'] === true ? ['--running'] : [])])
      return found.map((each) => (each.id === session ? { ...each, isRunning: true } : each))
    },
    async [conversationMethods.search](request) {
      const before = isObject(request['before']) ? request['before'] : undefined
      const record = [...textArg('--session', request['session']), ...textArg('--task', request['task']), ...textArg('--turn', request['turn']), ...countArg('--context', request['context']), ...(request['isGoal'] === true ? ['--goal'] : [])]
      return json(['history', 'search', String(request['text']), ...scopeArgs(request), ...record, ...(request['running'] === true ? ['--running'] : []), ...countArg('--limit', request['limit']), ...(before === undefined ? [] : ['--before', `${String(before['session'])}:${String(before['id'])}`])])
    },
    async [conversationMethods.messages](request) {
      const id = String(request['session'])
      const filters = [...textArg('--turn', request['turn']), ...textArg('--task', request['task']), ...textArg('--after', request['after'])]
      const saved = await json<Message[]>(['history', 'messages', id, ...filters, ...countArg('--last', request['last'])])
      if (id !== session) return saved
      await starting
      const fits = (message: Message) => (request['turn'] === undefined || message.turn === request['turn']) && message.task === request['task']
      const after = typeof request['after'] === 'string' ? live.findIndex((message) => message.id === request['after']) : -1
      const kept = live.slice(after + 1).filter(fits)
      return lastOf(merged(saved, kept, (message) => message.id), request['last'])
    },
    async [conversationMethods.turns](request) {
      const id = String(request['session'])
      const saved = await json<TurnData[]>(['history', 'turns', id, ...textArg('--task', request['task']), ...countArg('--context', request['context']), ...countArg('--last', request['last'])])
      if (id !== session) return saved
      await starting
      const kept = liveTurns(request['task']).filter((turn) => request['context'] === undefined || turn.context === request['context'])
      return lastOf(merged(saved, kept, (turn) => turn.prompt.id), request['last'])
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
      return merged(saved, kept, (task) => task.id)
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
      const list = Array.isArray(request['subscriptions']) ? (request['subscriptions'] as readonly Subscription[]) : []
      const sessions = heard.get(caller) ?? new Map<string, readonly Heard[]>()
      sessions.set(id, list.map(({ event, matcher }) => ({ event, matcher: matcher === undefined ? undefined : receivedMatcher(matcher) })))
      heard.set(caller, sessions)
      follow()
      return null
    },
    async [conversationMethods.watchBefore](request, caller) {
      if (caller === undefined) throw new Error('cmod hears no caller for this before listener.')
      const target = String(request['session'])
      const list = Array.isArray(request['subscriptions']) ? (request['subscriptions'] as readonly Subscription[]) : []
      ownWatches.set(`${caller}\n${target}`, { mod: caller, target, project: project(), events: [...new Set(list.map(({ event }) => event))] })
      await publishWatches()
      return null
    },
    async [conversationMethods.act](request, caller) {
      if (caller === undefined) throw new Error('cmod hears no caller for this action.')
      const target = String(request['session'])
      const action = String(request['action']) as Act
      const task = typeof request['task'] === 'string' ? request['task'] : undefined
      if (!isAct(action)) throw new Error(`cmod takes no action named ${action}.`)
      if (target === session) return perform(caller, action, request['input'], task)
      return actElsewhere(caller, target, action, request['input'], task)
    },
  }

  return {
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
      if (e.method !== conversationMethods.act && input['session'] !== session && !(await isGranted(e.caller, 'conversation'))) return { deny: `${e.caller ?? 'A mod'} reads your conversations without your grant. Turn it on in /mods ${e.caller ?? ''}.`.trim() }
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
