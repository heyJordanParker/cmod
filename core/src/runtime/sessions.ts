import type { Args, CommandRunResult, SessionCompactResult } from 'claude-code'
import type { Subscription } from '../utils/subscription.js'
import { ContextEnd, ContextStart, type Context } from '../session/context/context.js'
import { Message, noFiles } from '../session/context/turn/message/message.js'
import { modNote, Note } from '../session/context/turn/message/note.js'
import { Person, senderOf } from '../session/context/turn/message/sender.js'
import { ToolCall } from '../session/context/turn/message/tool-call.js'
import { ToolResult } from '../session/context/turn/message/tool-result.js'
import { TurnEnd, TurnStart, type Turn } from '../session/context/turn/turn.js'
import { forkAgentType, searchLimit, type ContextData, type GoalData, type SessionChange, type SessionData, type TaskData, type TurnData } from '../session/conversation.js'
import { GoalChange, type Goal } from '../session/goal/goal.js'
import { TaskEnd, TaskStart, type Task } from '../session/goal/task.js'
import { beforeEvents, processEvents, Session, sessionEvents, type BeforeEvent, type Placement, type BeforeMethods, type Surface, type OnMethods, type ProcessBeforeMethods, type ProcessName, type ProcessOnMethods, type RecordPart, type SearchOptions, type SessionEvent, type SessionScope, type SessionSend, type Sessions, type TaskOwner, type TaskStartArgs, type ToolCallArgs, type Usage } from '../session/session.js'
import { matches, sentMatcher, type Matcher, type SentMatcher } from '../utils/matcher.js'
import { beforeAnswerKeys, foldAnswers, foldBefore, methodOf, takenAnswer, type Answers, type Place } from './before.js'
import type { Claude } from './claude.js'
import { cmodPluginName } from './dependencies.js'
import { messageOf } from '../utils/text.js'
import { listenerOf, PassedTimeout, withinTime, type ListenOptions, type ListenTime } from './deadline.js'
import { callFiles, type HomeFolders, type HookFields } from './hooks.js'
import type { PermissionRoutes } from './permission-check.js'

export type Listened = { readonly event: SessionEvent; readonly matcher: SentMatcher | undefined; readonly onFailure?: 'refuse'; readonly scope?: Scope }

export const everySession = '*'

export const conversationMethods = {
  sessions: 'cmod:sessions',
  search: 'cmod:search',
  messages: 'cmod:messages',
  turns: 'cmod:turns',
  contexts: 'cmod:contexts',
  tasks: 'cmod:tasks',
  goal: 'cmod:goal',
  updateGoal: 'cmod:updateGoal',
  subscribe: 'cmod:subscribe',
  watchBefore: 'cmod:watchBefore',
  act: 'cmod:act',
  changed: 'cmod:changed',
  before: 'cmod:before',
  sessionColor: 'cmod:sessionColor',
} as const

export type SessionColor = { readonly session: string; readonly color?: string }

const resetColors: readonly string[] = ['default', 'reset', 'none', 'gray', 'grey']

export function pickedColor(args: string): string | undefined {
  const picked = args.trim().toLowerCase()
  return resetColors.includes(picked) ? undefined : picked
}

const acts = ['send', 'startTask', 'fork', 'clone', 'startBackgroundTask', 'callTool', 'usage', 'surfaces', 'abort'] as const

export type Act = (typeof acts)[number]

export const isAct = (action: string): action is Act => (acts as readonly string[]).includes(action)

export type Scope = { readonly session?: string; readonly context?: number; readonly turn?: string; readonly task?: string; readonly isGoal?: true; readonly isAgent?: true }

export type SessionsClient = {
  readonly sessions: Sessions
  changed(session: string, change: SessionChange, isInProject: boolean): void
  answerBefore(session: string, event: BeforeEvent, change: SessionChange, isInProject: boolean): Promise<unknown>
  failedBefore(session: string, event: BeforeEvent, change: SessionChange, isInProject: boolean, error: Error): { readonly refuse: string } | undefined
  raise(method: string, payload: Readonly<Record<string, unknown>>): Promise<unknown>
  listen(method: string, args: readonly unknown[]): Subscription
  turn(data: TurnData): Turn
  /** An empty title keeps the title the session already has. */
  follow(current: Omit<SessionData, 'isRunning' | 'lastAt' | 'color'>): void
  recolor(told: SessionColor): void
}

type Listening = { scope: Scope; readonly event: SessionEvent; readonly method: string; readonly matcher: unknown; readonly listener: (payload: never, time: ListenTime) => unknown; readonly options: ListenOptions }

type Owned = { readonly session: string; readonly task: string }

export async function usageOf(claude: Pick<Claude, 'session'>): Promise<Usage> {
  const [model, usage] = await Promise.all([claude.session.model(), claude.session.usage()])
  const { tokens, window, percent } = usage.context
  const rateLimits = usage.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ type: kind, percent: percentUsed, ...(resetsAt === undefined ? {} : { resetsAt }) }))
  return { model, contextWindow: { ...(tokens === undefined ? {} : { tokenCount: tokens }), size: window, ...(percent === undefined ? {} : { percent }) }, rateLimits, ...(usage.cost === undefined ? {} : { cost: { usd: usage.cost.usd } }) }
}

export function payloadOf(change: SessionChange): unknown {
  if (change.type === Message) return change.message
  if ('turn' in change) return change.turn
  if ('context' in change) return change.context
  if ('task' in change) {
    const { id, title, agentType, model, openedBy, openedAt, closedAt, isBackground, forkedFrom } = change.task
    const owner = { id, title, ...(agentType === undefined ? {} : { agentType }), ...(model === undefined ? {} : { model }), ...(forkedFrom === undefined ? {} : { forkedFrom }), startedAt: openedAt }
    return { id, title, openedBy, openedAt, ...(closedAt === undefined ? {} : { closedAt }), ...(isBackground === true ? { isBackground } : {}), owner }
  }
  if ('usage' in change) return change.usage
  return change.goal
}

export function isHeardBy(event: SessionEvent, matcher: unknown, change: SessionChange): boolean {
  const named = change.type === Message ? event === Message || event === change.message.type : event === change.type
  return named && (matcher === undefined || matches(payloadOf(change), matcher))
}

function taskOfChange(change: SessionChange): string | undefined {
  if (change.type === Message) return change.message.task
  if (change.type === TaskStart || change.type === TaskEnd) return change.task.id === '' ? change.task.parent : change.task.id
  if (change.type === TurnStart || change.type === TurnEnd) return change.turn.prompt.task
  if (change.type === ContextStart || change.type === ContextEnd) return change.context.task
  if (change.type === GoalChange) return change.goal.task
  return undefined
}

function ownerOfChange(change: SessionChange): string | undefined {
  if (change.type === TaskStart || change.type === TaskEnd) return change.task.parent
  return taskOfChange(change)
}

function contextOfChange(change: SessionChange): number | undefined {
  if (change.type === Message) return change.message.context
  if (change.type === TurnStart || change.type === TurnEnd) return change.turn.context
  if (change.type === ContextStart || change.type === ContextEnd) return change.context.number
  if (change.type === TaskStart || change.type === TaskEnd) return change.task.context
  return undefined
}

export function isInScope(scope: Scope, session: string, change: SessionChange, isUnder: (task: string, ancestor: string) => boolean): boolean {
  if (scope.session !== undefined && scope.session !== session) return false
  const task = taskOfChange(change)
  if (scope.isAgent === true) return (change.type === TaskStart || change.type === TaskEnd ? change.task.parent : task) === scope.task
  if (scope.task !== undefined && (task === undefined || !isUnder(task, scope.task))) return false
  if (scope.context !== undefined && (contextOfChange(change) !== scope.context || ownerOfChange(change) !== scope.task)) return false
  if (scope.turn === undefined) return true
  if (change.type === Message) return change.message.turn === scope.turn
  return (change.type === TurnStart || change.type === TurnEnd) && change.turn.prompt.id === scope.turn
}

export function withoutPermissionCheck(name: string, hearer: string): string {
  return `${name}: ${hearer} hears Claude Code's permission check, so hooks/register.ts must call registerPermissionCheck(addHook) after registerMod.`
}

export type HookOn = (hook: string, listener: (input: unknown) => HookFields | undefined | Promise<HookFields | undefined>, failed?: (input: unknown, error: Error) => HookFields | undefined) => Subscription

export function createSessionsClient({ name, claude, report, hookOn, routeOn, permissionRoutes }: { readonly name: string; readonly claude: Claude; readonly report: (id: string, message: string, error: unknown) => void; readonly hookOn?: HookOn; readonly routeOn?: RouteOn; readonly permissionRoutes?: () => PermissionRoutes | undefined }): SessionsClient {
  const call = <Answer>(method: string, input: unknown) => claude.cmod.call({ to: cmodPluginName, method, input }) as Promise<Answer>
  const listening = new Map<string, Set<Listening>>()
  const deciding = new Map<string, Set<Listening>>()
  const queued = new Set<string>()
  const parents = new Map<string, Map<string, string | undefined>>()
  const known = new Map<string, SessionData>()
  let current: SessionData = { id: '', title: '', project: '', cwd: '', model: '', startedAt: '', lastAt: '', isRunning: true }
  let told: SessionColor = { session: '' }

  const colored = ({ color: _color, ...data }: SessionData): SessionData => (told.session === data.id && told.color !== undefined ? { ...data, color: told.color } : data)

  const keyOf = (scope: Scope) => scope.session ?? everySession

  const subscribe = (key: string) => {
    if (queued.has(key)) return
    queued.add(key)
    void Promise.resolve().then(async () => {
      queued.delete(key)
      const heard = (from: Map<string, Set<Listening>>): Listened[] =>
        [...(from.get(key) ?? [])].map(({ event, matcher, options, scope }) => ({ event, matcher: matcher === undefined ? undefined : sentMatcher(matcher), ...(options.onFailure === 'refuse' ? { onFailure: 'refuse' as const, scope } : {}) }))
      const tracksTasks = [...(listening.get(key) ?? []), ...(deciding.get(key) ?? [])].some(({ scope }) => scope.task !== undefined || scope.isGoal === true)
      if (tracksTasks) void learnTasks(key).catch((error: unknown) => report(`tasks:${key}`, 'Could not read the tasks it listens under', error))
      const subscriptions = [...heard(listening), ...(tracksTasks ? [{ event: TaskStart }] : [])]
      await call(conversationMethods.subscribe, { session: key, subscriptions }).catch((error: unknown) => report(`sessions:${key}`, `Hears nothing from ${key === everySession ? 'the other sessions' : `session ${key}`}`, error))
      await call(conversationMethods.watchBefore, { session: key, subscriptions: heard(deciding) }).catch((error: unknown) => report(`before:${key}`, `Changes nothing in ${key === everySession ? 'the other sessions' : `session ${key}`}`, error))
    })
  }

  const learnTasks = async (session: string) => {
    if (parents.has(session)) return
    const tree = new Map<string, string | undefined>()
    parents.set(session, tree)
    for (const task of await call<TaskData[]>(conversationMethods.tasks, { session, all: true })) tree.set(task.id, task.parent)
  }

  const isUnderIn = (session: string) => (task: string, ancestor: string) => {
    const tree = parents.get(session)
    for (let at: string | undefined = task, steps = 0; at !== undefined && steps < 64; at = tree?.get(at), steps += 1) if (at === ancestor) return true
    return false
  }

  const remember = (session: string, change: SessionChange) => {
    if (change.type === TaskStart) parents.get(session)?.set(change.task.id, change.task.parent)
  }

  const add = (into: Map<string, Set<Listening>>, scope: Scope, event: SessionEvent, method: string, args: readonly unknown[], onChange: (key: string) => void): Subscription => {
    const key = keyOf(scope)
    const entry: Listening = { scope, event, method, ...listenerOf(name, method, args) }
    const set = into.get(key) ?? new Set()
    set.add(entry)
    into.set(key, set)
    onChange(key)
    return {
      remove() {
        for (const [at, held] of into) {
          if (!held.delete(entry)) continue
          if (held.size === 0) into.delete(at)
          onChange(at)
          return
        }
      },
    }
  }

  const refusalOf = (options: ListenOptions, takes: readonly string[], error: unknown) => (options.onFailure === 'refuse' && takes.includes('refuse') ? { refuse: `${name}: ${messageOf(error)}` } : undefined)

  const invoke = (method: string, options: ListenOptions, run: (time: ListenTime) => unknown, takes: readonly string[] = []): Promise<unknown> =>
    withinTime(claude.clock, method, options, run).catch((error: unknown) => {
      if (error instanceof PassedTimeout && !method.startsWith('before')) return undefined
      report(`session:${method}`, `The ${method} listener failed`, error)
      return refusalOf(options, takes, error)
    })

  const decidersOf = (session: string, event: BeforeEvent, isInProject: boolean) => [...(deciding.get(session) ?? []), ...(isInProject ? (deciding.get(everySession) ?? []) : [])].filter((entry) => entry.event === event)

  const decides = (entry: Listening, session: string, change: SessionChange) => isInScope(entry.scope, session, change, isUnderIn(session)) && (entry.matcher === undefined || matches(payloadOf(change), entry.matcher))

  const combined = async (session: string, event: BeforeEvent, change: SessionChange, isInProject: boolean): Promise<Partial<Answers> | undefined> => {
    const askers = decidersOf(session, event, isInProject)
      .map((entry) => async (latest: SessionChange) => {
        if (!decides(entry, session, latest)) return undefined
        const payload = await payloadFor(session, latest)
        return invoke(entry.method, entry.options, async (time) => takenAnswer(entry.method, beforeAnswerKeys[event], await entry.listener(payload as never, time)), beforeAnswerKeys[event])
      })
    const answer = await foldBefore(event, change, askers, (error) => report(`session:${methodOf('before', event)}`, `The ${methodOf('before', event)} listener failed`, error))
    return answer?.note === undefined ? answer : { ...answer, note: modNote(name, answer.note) }
  }

  const eventMethods = (scopeOf: () => Scope, hasBefore: boolean, ended?: string): OnMethods & Partial<BeforeMethods> => {
    const method = (into: Map<string, Set<Listening>>, named: string, event: SessionEvent) => (...args: unknown[]) => {
      if (ended !== undefined) throw new Error(`${name}: ${ended} has ended, so its ${named} never fires. Listen on its Session.`)
      return add(into, scopeOf(), event, named, args, subscribe)
    }
    return Object.fromEntries([
      ...Object.entries(sessionEvents).map(([named, event]) => [`on${named}`, method(listening, `on${named}`, event)]),
      ...(hasBefore ? beforeEvents.map((named) => [`before${named}`, method(deciding, `before${named}`, sessionEvents[named])]) : []),
    ]) as OnMethods & Partial<BeforeMethods>
  }

  let folders: Promise<HomeFolders> | undefined
  const withFiles = async (message: Message): Promise<Message> => {
    if (message.type !== ToolCall && message.type !== ToolResult) return message
    folders ??= Promise.all([claude.env.home(), claude.env.configHome()]).then(([home, configRoot]) => ({ home, configRoot }))
    return { ...message, files: await callFiles(name, claude, folders, { tool: message.name, input: message.input }, message.cwd) }
  }

  const messagesFrom = async (method: string, input: unknown) => Promise.all((await call<Message[]>(method, input)).map(withFiles))

  const searched = (request: Readonly<Record<string, unknown>>, matcher: unknown): AsyncIterable<Message> => ({
    async *[Symbol.asyncIterator]() {
      let before = request['before']
      for (;;) {
        const page = await messagesFrom(conversationMethods.search, { ...request, ...(before === undefined ? {} : { before }) })
        for (const message of page) if (matcher === undefined || matches(message, matcher)) yield message
        const last = page.at(-1)
        if (last === undefined || page.length < searchLimit) return
        before = { session: last.session, id: last.id }
      }
    },
  })

  const recordPart = (scope: Scope, ended?: string): RecordPart =>
    ({
      search: (text: string, matcher?: unknown) => searched({ text, ...scope }, matcher),
      ...eventMethods(() => scope, true, ended),
    }) as RecordPart

  const turnOf = (scope: Scope, data: TurnData): Turn => {
    const task = data.prompt.task ?? scope.task
    return {
      ...data,
      ...recordPart({ ...scope, ...(task === undefined ? {} : { task }), turn: data.prompt.id }, data.closedAt === undefined ? undefined : `turn ${data.prompt.id}`),
      messages: () => messagesFrom(conversationMethods.messages, { session: scope.session, turn: data.prompt.id, ...(task === undefined ? {} : { task }) }),
      abort: async () => {
        if (data.closedAt !== undefined) throw new Error(`${name}: turn ${data.prompt.id} has ended, so there is nothing to abort.`)
        const session = scope.session ?? current.id
        await act(session, 'abort', { turn: data.prompt.id }, task === undefined ? undefined : { session, task })
      },
    }
  }

  const contextOf = (scope: Scope, data: ContextData): Context => {
    const owned: Scope = { ...(scope.session === undefined ? {} : { session: scope.session }), ...(data.task === undefined ? {} : { task: data.task }) }
    return {
      ...data,
      ...recordPart({ ...owned, context: data.number }, data.closedAt === undefined ? undefined : `context ${data.number}`),
      turns: async () => (await call<TurnData[]>(conversationMethods.turns, { ...owned, context: data.number })).map((turn) => turnOf(owned, turn)),
    }
  }

  const taskOf = (session: string, data: TaskData): Task => {
    const record = data.isBackground === true ? { session: data.id } : { session, task: data.id }
    return {
      id: data.id,
      title: data.title,
      openedBy: data.openedBy,
      openedAt: data.openedAt,
      ...(data.closedAt === undefined ? {} : { closedAt: data.closedAt }),
      ...(data.status === undefined ? {} : { status: data.status }),
      ...(data.name === undefined ? {} : { name: data.name }),
      ...(data.spawnedBy === undefined ? {} : { spawnedBy: data.spawnedBy }),
      ...(data.isBackground === true ? { isBackground: true } : {}),
      owner: ownerOf(session, data),
      ...recordPart({ session, task: data.id }),
      search: (text: string, matcher?: unknown) => searched({ text, ...record }, matcher),
      tasks: async () => (await call<TaskData[]>(conversationMethods.tasks, record)).map((task) => taskOf(record.session, task)),
      messages: () => messagesFrom(conversationMethods.messages, record),
    }
  }

  const goalOf = (where: () => Scope): Goal =>
    ({
      search: (text: string, matcher?: unknown) => searched({ text, ...where() }, matcher),
      ...eventMethods(() => ({ ...where(), isGoal: true }), true),
      text: async () => (await call<GoalData>(conversationMethods.goal, where())).text,
      tasks: async () => {
        const { session = current.id, task } = where()
        return (await call<TaskData[]>(conversationMethods.tasks, { session, ...(task === undefined ? {} : { task }) })).map((each) => taskOf(session, each))
      },
      update: async ({ text }: { readonly text: string }) => {
        if (text.trim() === '') throw new Error(`${name}: a goal needs text.`)
        const { session = current.id, task } = where()
        await call(conversationMethods.updateGoal, { session, ...(task === undefined ? {} : { task }), text })
      },
    }) as Goal

  const payloadFor = async (session: string, change: SessionChange): Promise<unknown> => {
    const scope = { session }
    if (change.type === Message) return withFiles(change.message)
    if ('turn' in change) return turnOf(scope, change.turn)
    if ('context' in change) return contextOf(scope, change.context)
    if ('task' in change) return taskOf(session, change.task)
    if ('usage' in change) return change.usage
    const { task } = change.goal
    return goalOf(() => ({ session, ...(task === undefined ? {} : { task }) }))
  }

  const act = <Answer>(session: string, action: Act, input: unknown, owned?: Owned) => call<Answer>(conversationMethods.act, { session: owned?.session ?? session, action, input, ...(owned === undefined ? {} : { task: owned.task }) })

  const sendHere = async ({ type, text, as }: SessionSend) => {
    if (type === Note) {
      if (as !== undefined) throw new Error(`${name}: a Note is always from this mod, so it takes no as.`)
      const added = await claude.session.append({ message: { type: 'user', content: [{ type: 'text', text: modNote(name, text) }] } })
      if (added.deny !== undefined) throw new Error(`${name}: Claude Code refused the note: ${added.deny}`)
      return
    }
    const submitted = await claude.prompt.submit({ text, ...(as === Person ? { asUser: true } : {}) })
    if ('drop' in submitted && typeof submitted.drop === 'string') throw new Error(`${name}: Claude Code dropped the prompt: ${submitted.drop}`)
  }

  const surfacesHere = async (): Promise<Surface[]> => [...(await claude.session.surfaces())]

  const sessionOf = (read: () => SessionData, owned?: Owned, isOwner = owned !== undefined) => {
    const id = () => read().id
    const isHere = () => owned === undefined && id() === current.id
    const scope = (): Scope => (owned === undefined ? { session: id(), isAgent: true } : { session: owned.session, task: owned.task, isAgent: true })
    const where = () => (owned === undefined ? { session: id() } : { session: owned.session, task: owned.task })
    const turnsOf = async (options: { readonly last?: number } = {}): Promise<Turn[]> => (await call<TurnData[]>(conversationMethods.turns, { ...where(), ...options })).map((turn) => turnOf(where(), turn))
    const contextsOf = async (): Promise<Context[]> => (await call<ContextData[]>(conversationMethods.contexts, where())).map((context) => contextOf(where(), context))
    const session = {
      get id() {
        return read().id
      },
      get title() {
        return read().title
      },
      get color() {
        return read().color
      },
      get project() {
        return read().project
      },
      get agentType() {
        return read().agentType
      },
      get model() {
        return read().model
      },
      get cwd() {
        return read().cwd
      },
      get isRunning() {
        return read().isRunning
      },
      get startedAt() {
        return read().startedAt
      },
      get lastAt() {
        return read().lastAt
      },
      get forkedFrom() {
        return read().forkedFrom
      },
      search: (text: string, matcher?: Matcher<Message>) => recordPart(scope()).search(text, matcher),
      ...eventMethods(scope, true),
      goal: goalOf(where),
      context: async () => {
        const all = await contextsOf()
        const last = all.at(-1)
        if (last === undefined) throw new Error(`${name}: session ${id()} has no context yet.`)
        return last
      },
      contexts: contextsOf,
      turn: async () => {
        const [last] = await turnsOf({ last: 1 })
        return last?.closedAt === undefined ? last : undefined
      },
      turns: turnsOf,
      messages: (options: { readonly after?: string; readonly last?: number } = {}) => messagesFrom(conversationMethods.messages, { ...where(), ...options }),
      usage: async (): Promise<Usage> => (isHere() ? usageOf(claude) : act<Usage>(id(), 'usage', null, owned)),
      surfaces: async (): Promise<Surface[]> => (isHere() ? surfacesHere() : act<Surface[]>(id(), 'surfaces', null, owned)),
      async send(message: SessionSend) {
        if (message.text.trim() === '') throw new Error(`${name}: send needs text.`)
        if (isHere() && message.as !== Session) return sendHere(message)
        await act(id(), 'send', message, owned)
      },
    }
    if (isOwner) return session as unknown as Sessions['current']
    const started = async (starting: Promise<TaskData>): Promise<Task> => taskOf(id(), await starting.catch((error: unknown) => Promise.reject(new Error(`${name}: ${messageOf(error)}`))))
    return Object.assign(session, {
      startTask: (task: TaskStartArgs): Promise<Task> => started(task.isBackground === true ? act<TaskData>(id(), 'startBackgroundTask', task) : isHere() ? spawnTask(claude, task) : act<TaskData>(id(), 'startTask', task)),
      fork: (task: Pick<TaskStartArgs, 'prompt' | 'title'>): Promise<Task> => started(isHere() ? spawnTask(claude, task, current.id) : act<TaskData>(id(), 'fork', task)),
      clone: (task: Pick<TaskStartArgs, 'prompt' | 'title'>): Promise<Task> => started(act<TaskData>(id(), 'clone', task)),
      callTool: async (toolCall: ToolCallArgs): Promise<ToolResult> => (await withFiles(await act<ToolResult>(id(), 'callTool', toolCall))) as ToolResult,
    }) as unknown as Sessions['current']
  }

  const ownerOf = (session: string, data: TaskData): TaskOwner => {
    const parent = session === current.id ? current : known.get(session)
    const isBackground = data.isBackground === true
    return sessionOf(
      () => ({
        id: data.id,
        title: data.title,
        project: parent?.project ?? '',
        ...(data.agentType === undefined ? {} : { agentType: data.agentType }),
        model: data.model ?? '',
        cwd: parent?.cwd ?? '',
        isRunning: data.closedAt === undefined && (isBackground || (parent?.isRunning ?? true)),
        startedAt: data.openedAt,
        lastAt: data.closedAt ?? data.openedAt,
        ...(data.forkedFrom === undefined ? {} : { forkedFrom: data.forkedFrom }),
      }),
      isBackground ? undefined : { session, task: data.id },
      true,
    )
  }

  type ProcessListener = { readonly matcher: unknown; readonly listener: (payload: HookFields, time: ListenTime) => unknown; readonly options: ListenOptions; readonly isEveryAgent: boolean }
  const processListeners = new Map<string, Set<ProcessListener>>()

  const processHearers = (method: string, payload: HookFields) => [...(processListeners.get(method) ?? [])].filter(({ matcher, isEveryAgent }) => (payload['task'] === undefined || isEveryAgent) && (matcher === undefined || matches(payload, matcher)))

  const raise = async (method: string, payload: HookFields): Promise<HookFields | undefined> => {
    const heard = processHearers(method, payload)
    if (!method.startsWith('before')) {
      await Promise.all(heard.map(({ listener, options }) => invoke(method, options, (time) => listener(payload, time))))
      return undefined
    }
    const takes = takesOf(method)
    const askers = heard.map(({ listener, options }) => () => invoke(method, options, async (time) => takenAnswer(method, takes, await listener(payload, time)), takes))
    return foldAnswers<undefined, HookFields>(method, takes, ['refuse'], undefined, askers, (error) => report(`session:${method}`, `The ${method} listener failed`, error))
  }

  const takesOf = (method: string) => answerKeys[method.slice('before'.length)] ?? []

  const refusalFor = (method: string, payload: HookFields, error: Error) => processHearers(method, payload).map((entry) => refusalOf(entry.options, takesOf(method), error)).find((answer) => answer !== undefined)

  const commandRun = async (e: Args<'command.run'>): Promise<HookFields> => {
    const source = (await claude.command.list()).find((command) => command.name === e.command)?.source
    return { session: current.id, cwd: current.cwd, name: e.command, args: e.args, ...defined({ source }), from: senderOf(e.origin, false) }
  }

  const commandListeners = { beforeRun: new Set<ProcessListener>(), onRun: new Set<ProcessListener>() }
  for (const [method, held] of Object.entries(commandListeners)) processListeners.set(method, held)
  routeOn?.('command.run', async (e, next) => {
    if (commandListeners.beforeRun.size === 0 && commandListeners.onRun.size === 0) return next(e)
    const run = await commandRun(e)
    const answer = commandListeners.beforeRun.size === 0 ? undefined : await raise('beforeRun', run)
    if (typeof answer?.['refuse'] === 'string') return { text: answer['refuse'] }
    if (typeof answer?.['result'] === 'string') return { text: answer['result'], ...(typeof answer['exitCode'] === 'number' ? { exitCode: answer['exitCode'] } : {}) }
    const args = typeof answer?.['args'] === 'string' ? answer['args'] : e.args
    const ran = await next(args === e.args ? e : { ...e, args })
    void raise('onRun', { ...run, args })
    return typeof answer?.['note'] === 'string' ? { ...ran, context: [...(ran.context ?? []), modNote(name, answer['note'])] } : ran
  }, async (e, error) => {
    const refusal = commandListeners.beforeRun.size === 0 ? undefined : refusalFor('beforeRun', await commandRun(e), error)
    return refusal === undefined ? undefined : { text: refusal.refuse }
  })

  const listenTo = (method: string, named: string) => {
    if (hookOn === undefined || routeOn === undefined) throw new Error(`${name}: ${method} works only in a mod's own session.`)
    const isBefore = method.startsWith('before')
    if (named === 'PermissionCheck' || named === 'PermissionRequest') {
      const routes = permissionRoutes?.()
      if (routes === undefined) throw new Error(withoutPermissionCheck(name, method))
      return routes(method, { raise, refusalFor, hookOn, routeOn, current: () => current })
    }
    const event: { readonly on: string; readonly before?: string } = processEvents[named as ProcessName]
    const hook = (isBefore ? event.before : undefined) ?? event.on
    if (method === 'beforeSessionStart') routeOn('session.compact', trackCompaction)
    if (method === 'beforeModelChange') hookOn(event.on, () => {
      const notes = modelNotes.splice(0)
      return notes.length === 0 ? undefined : { additionalContext: notes }
    })
    const failed = (input: unknown, error: Error) => {
      const refusal = refusalFor(method, processPayloadOf(named as ProcessFieldsName, input), error)
      return refusal === undefined ? undefined : hookAnswerOf(name, named, refusal)
    }
    return hookOn(
      hook,
      async (input: unknown) => {
        const payload = processPayloadOf(named as ProcessFieldsName, input)
        if (named === 'SessionStart' && payload['source'] === 'compact') {
          if (!isBefore) return undefined
          const task = compacting?.agentId
          const model = task === undefined ? await claude.session.model() : undefined
          const answer = await raise(method, { ...payload, ...defined({ task, model, title: current.title || undefined }) })
          if (answer === undefined) return undefined
          return hookAnswerOf(name, named, task === undefined ? answer : defined({ note: answer['note'] }))
        }
        if (!isBefore) {
          void raise(method, payload)
          return undefined
        }
        if (named === 'ModelChange') modelNotes.splice(0)
        const answer = await raise(method, payload)
        if (answer === undefined) return undefined
        if (named === 'ModelChange' && typeof answer['note'] === 'string' && answer['refuse'] === undefined) modelNotes.push(modNote(name, answer['note']))
        return hookAnswerOf(name, named, answer)
      },
      isBefore ? failed : undefined,
    )
  }

  const modelNotes: string[] = []

  let compacting: Args<'session.compact'> | undefined

  const trackCompaction = async (e: Args<'session.compact'>, next: (e: Args<'session.compact'>) => Promise<SessionCompactResult>): Promise<SessionCompactResult> => {
    compacting = e
    try {
      return await next(e)
    } finally {
      if (compacting === e) compacting = undefined
    }
  }

  const listen = (method: string, args: readonly unknown[], isEveryAgent = false): Subscription => {
    const heard = listenerOf(name, method, args)
    const entry = { ...heard, options: method === 'beforePermissionRequest' ? { ...heard.options, onFailure: 'refuse' } : heard.options, isEveryAgent } as ProcessListener
    const held = processListeners.get(method) ?? new Set()
    if (!processListeners.has(method)) {
      listenTo(method, method.replace(/^(on|before)/, ''))
      processListeners.set(method, held)
    }
    held.add(entry)
    return { remove: () => void held.delete(entry) }
  }

  const processMethods = (): ProcessOnMethods & ProcessBeforeMethods =>
    Object.fromEntries(
      Object.entries(processEvents).flatMap(([named, event]) => [`on${named}`, ...('before' in event ? [`before${named}`] : [])]).map((method) => [method, (...args: unknown[]) => listen(method, args)]),
    ) as ProcessOnMethods & ProcessBeforeMethods

  const here = sessionOf(() => current)
  const currentSession = Object.assign(here, processMethods(), {
    goal: Object.assign(here.goal, { beforeSessionStart: (...args: unknown[]) => listen('beforeSessionStart', args, true) }),
    async scrollTo(message: Message, options?: { readonly block?: 'start' | 'center' | 'end' | 'nearest' }) {
      const { deny } = await claude.ui.scroll({ to: { requestId: message.id }, ...(options?.block === undefined ? {} : { block: options.block }) })
      if (deny !== undefined) throw new Error(`${name}: Claude Code did not scroll to the message: ${deny}`)
    },
    caption: (toolCall: Message & { readonly type: typeof ToolCall }, text: string | undefined) => claude.ui.notice(toolCall.callId, text),
  })
  const every = eventMethods(() => ({}), false)

  const failedBefore = (session: string, event: BeforeEvent, change: SessionChange, isInProject: boolean, error: Error) => {
    const asked = decidersOf(session, event, isInProject).filter((entry) => decides(entry, session, change))
    return asked.map((entry) => refusalOf(entry.options, beforeAnswerKeys[event], error)).find((answer) => answer !== undefined)
  }

  return {
    sessions: {
      get current() {
        return currentSession
      },
      list: async (scope: SessionScope = {}) =>
        (await call<SessionData[]>(conversationMethods.sessions, scope)).map((data) => {
          if (data.id !== current.id) {
            known.set(data.id, data)
            return sessionOf(() => known.get(data.id) ?? data)
          }
          if (current.title === '') current = { ...current, title: data.title }
          return currentSession
        }),
      search: (text, matcher, options = {}) => searched({ text, ...searchOptionsOf(options) }, matcher),
      ...every,
    },
    changed(session, change, isInProject) {
      remember(session, change)
      let payload: Promise<unknown> | undefined
      for (const key of isInProject ? [session, everySession] : [session]) {
        for (const { scope, event, method, matcher, listener, options } of listening.get(key) ?? []) {
          if (!isHeardBy(event, matcher, change) || !isInScope(scope, session, change, isUnderIn(session))) continue
          payload ??= payloadFor(session, change)
          void payload
            .then((heard) => invoke(method, options, (time) => listener(heard as never, time)))
            .catch((error: unknown) => report(`session:${method}`, `The ${method} listener failed`, error))
        }
      }
    },
    answerBefore: combined,
    failedBefore,
    raise,
    listen,
    turn: (data) => turnOf({ session: current.id }, data),
    follow(next) {
      const moved = next.id !== current.id && current.id !== ''
      const previous = current.id
      current = colored({ ...next, title: next.title || (next.id === current.id ? current.title : ''), isRunning: true, lastAt: new Date().toISOString() })
      if (!moved) return
      for (const into of [listening, deciding]) {
        const kept = into.get(previous)
        if (kept === undefined) continue
        into.delete(previous)
        for (const entry of kept) if (entry.scope.session === previous) entry.scope = { ...entry.scope, session: current.id }
        into.set(current.id, new Set([...(into.get(current.id) ?? []), ...kept]))
      }
      parents.delete(previous)
      subscribe(previous)
      subscribe(current.id)
    },
    recolor(next) {
      told = next
      current = colored(current)
    },
  }
}

export type ToolCheck = { readonly tool: string; readonly input: unknown; readonly tool_use_id?: string; readonly agentId?: string; readonly ceiling?: 'allow' | 'ask' | 'deny' }

export type RouteOn = {
  (event: 'tool.check', hook: (e: ToolCheck, next: (e: ToolCheck) => Promise<unknown>) => Promise<unknown>, failed?: (e: ToolCheck, error: Error, next: (e: ToolCheck) => Promise<unknown>) => Promise<{ readonly decision: 'deny'; readonly reason: string } | undefined>): Subscription
  (event: 'command.run', hook: (e: Args<'command.run'>, next: (e: Args<'command.run'>) => Promise<CommandRunResult>) => Promise<CommandRunResult>, failed?: (e: Args<'command.run'>, error: Error) => Promise<CommandRunResult | undefined>): Subscription
  (event: 'session.compact', hook: (e: Args<'session.compact'>, next: (e: Args<'session.compact'>) => Promise<SessionCompactResult>) => Promise<SessionCompactResult>): Subscription
}

export const recordOf = (value: unknown): Readonly<Record<string, unknown>> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

export const defined = (fields: HookFields): HookFields => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))

const placementOf = (input: HookFields): Placement => defined({ session: input['session_id'], task: input['agent_id'], agentType: input['agent_type'], cwd: input['cwd'], permissionMode: input['permission_mode'] }) as Placement

const mcpServerOf = (server: unknown) => (server === undefined ? undefined : { name: String(recordOf(server)['name']), source: String(recordOf(server)['source']) })

const modelChangeOf = (input: HookFields) => ({
  model: input['to_model'],
  previous: input['from_model'],
  requested: input['requested_model'] ?? undefined,
  source: input['source'],
  contextTokenCount: input['context_tokens'],
  isCacheWarm: input['prompt_cache_warm'],
  cacheTtl: input['cache_ttl'],
  cacheWriteUsd: input['estimated_cache_write_usd'],
  pricing: input['pricing'],
})

const answerKeys: Readonly<Record<string, readonly string[]>> = {
  Run: ['args', 'note', 'result', 'exitCode', 'refuse'],
  ProjectSetup: ['note'],
  SessionStart: ['note', 'title', 'reloadSkills', 'firstPrompt'],
  ModelChange: ['ask', 'refuse', 'note'],
  WorktreeCreate: ['result'],
  Elicitation: ['refuse'],
  ElicitationResponse: ['refuse'],
  PermissionCheck: ['allow', 'ask', 'refuse'],
  PermissionRequest: ['allow', 'input', 'updates', 'refuse', 'interrupt'],
  PermissionDenial: ['retry'],
  ToolBatch: ['note'],
  TodoCreate: ['refuse'],
  TodoComplete: ['refuse'],
  ReplyDisplay: ['text'],
}

const todoOf = (input: HookFields) => ({ id: input['task_id'], subject: input['task_subject'], description: input['task_description'], teammate: input['teammate_name'] })

type ProcessFieldsName = Exclude<ProcessName, 'PermissionCheck'>

const processFields: { readonly [Name in ProcessFieldsName]: (input: HookFields) => HookFields } = {
  ProjectSetup: (input) => ({ trigger: input['trigger'] }),
  SessionStart: (input) => ({
    source: input['source'],
    model: input['model'],
    title: input['session_title'] || undefined,
    idleSeconds: input['seconds_since_last_response'],
    contextTokenCount: input['context_tokens'],
    isCacheWarm: input['prompt_cache_likely_expired'] === undefined ? undefined : input['prompt_cache_likely_expired'] !== true,
    cacheWriteUsd: input['estimated_cache_write_usd'],
  }),
  SessionEnd: (input) => ({ reason: input['reason'] === 'prompt_input_exit' ? 'exit' : input['reason'] }),
  ModelChange: modelChangeOf,
  CwdChange: (input) => ({ cwd: input['new_cwd'] ?? input['cwd'], previous: input['old_cwd'] }),
  DirectoryAdd: (input) => ({ directory: input['directory'], source: input['source'] === 'slash_command' ? 'command' : 'sdk' }),
  WorktreeCreate: (input) => ({ name: input['name'] }),
  WorktreeRemove: (input) => ({ path: input['worktree_path'] }),
  Notification: (input) => ({ text: input['message'], title: input['title'], type: input['notification_type'] }),
  Elicitation: (input) => ({ id: input['elicitation_id'], server: input['mcp_server_name'], text: input['message'], mode: input['mode'], url: input['url'], schema: input['requested_schema'] }),
  ElicitationResponse: (input) => ({ id: input['elicitation_id'], server: input['mcp_server_name'], mode: input['mode'], action: input['action'], content: input['content'] }),
  PermissionRequest: (input) => ({ name: input['tool_name'], input: recordOf(input['tool_input']), suggestions: input['permission_suggestions'] ?? [], mcpServer: mcpServerOf(input['mcp_server']) }),
  PermissionDenial: (input) => ({ name: input['tool_name'], input: recordOf(input['tool_input']), callId: input['tool_use_id'], reason: input['reason'], mcpServer: mcpServerOf(input['mcp_server']) }),
  ToolBatch: (input) => ({
    calls: (Array.isArray(input['tool_calls']) ? input['tool_calls'] : []).map((call: unknown) => {
      const fields = recordOf(call)
      return defined({ callId: fields['tool_use_id'], name: fields['tool_name'], input: recordOf(fields['tool_input']), output: fields['tool_response'] })
    }),
  }),
  TodoCreate: todoOf,
  TodoComplete: todoOf,
  ReplyDisplay: (input) => ({ replyId: input['message_id'], index: input['index'], isLast: input['final'], text: input['delta'] }),
}

export async function spawnTask(claude: Pick<Claude, 'agent'>, task: TaskStartArgs, forkedFrom?: string): Promise<TaskData> {
  if (task.title.trim() === '') throw new Error('a task needs a title.')
  const { name, agentType, model, cwd }: TaskStartArgs = forkedFrom === undefined ? task : { prompt: task.prompt, title: task.title, agentType: forkAgentType }
  const started = await claude.agent.spawn({
    prompt: task.prompt,
    description: task.title,
    ...(name === undefined ? {} : { name }),
    ...(agentType === undefined ? {} : { subagentType: agentType }),
    ...(model === undefined ? {} : { model }),
    ...(cwd === undefined ? {} : { cwd }),
  })
  if (started.deny !== undefined) throw new Error(`Claude Code refused the task: ${started.deny}`)
  if (started.agentId === undefined) throw new Error('Claude Code answered without starting a task.')
  return { id: started.agentId, title: task.title, ...(forkedFrom === undefined ? { agentType: agentType ?? 'general-purpose' } : { forkedFrom }), model: started.model, openedBy: '', openedAt: new Date().toISOString() }
}

export function processPayloadOf(named: ProcessFieldsName, input: unknown): HookFields {
  const fields = recordOf(input)
  return { ...placementOf(fields), ...defined(processFields[named](fields)) }
}

function hookAnswerOf(name: string, named: string, answer: HookFields): HookFields | undefined {
  const refuse = typeof answer['refuse'] === 'string' ? answer['refuse'] : undefined
  const note = typeof answer['note'] === 'string' ? [modNote(name, answer['note'])] : undefined
  if (named === 'SessionStart') return defined({ additionalContext: note, sessionTitle: answer['title'], reloadSkills: answer['reloadSkills'] === true ? true : undefined, initialUserMessage: answer['firstPrompt'] })
  if (named === 'ModelChange') {
    if (refuse !== undefined) return { permissionDecision: 'deny', permissionDecisionReason: refuse }
    return typeof answer['ask'] === 'string' ? { permissionDecision: 'ask', permissionDecisionReason: answer['ask'] } : undefined
  }
  if (named === 'ProjectSetup') return defined({ additionalContext: note })
  if (named === 'WorktreeCreate') return defined({ worktreePath: answer['result'] })
  if (named === 'PermissionDenial') return answer['retry'] === true ? { retry: true } : undefined
  if (named === 'ToolBatch') return defined({ additionalContext: note })
  if (named === 'ReplyDisplay') return defined({ displayContent: answer['text'] })
  return refuse === undefined ? undefined : { block: refuse }
}

export function resultOf(where: Pick<Place, 'session' | 'context' | 'turn'>, call: ToolCallArgs & { readonly cwd: string }, answered: Awaited<ReturnType<Claude['tool']['call']>>): ToolResult {
  const base: Omit<ToolResult, 'output' | 'isError'> = { id: '', type: ToolResult, at: new Date().toISOString(), session: where.session, context: where.context, ...(where.turn === undefined ? {} : { turn: where.turn.prompt.id }), callId: '', name: call.name, input: call.input, cwd: call.cwd, files: noFiles }
  if (answered.deny !== undefined) return { ...base, output: answered.deny, isError: true }
  return { ...base, output: answered.result ?? answered.text, isError: answered.isError === true }
}

function searchOptionsOf({ running, since, everyProject, before }: SearchOptions): Readonly<Record<string, unknown>> {
  return {
    ...(running === undefined ? {} : { running }),
    ...(since === undefined ? {} : { since }),
    ...(everyProject === undefined ? {} : { everyProject }),
    ...(before === undefined ? {} : { before: { session: before.session, id: before.id } }),
  }
}
