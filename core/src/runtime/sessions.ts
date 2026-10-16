import type { Args, CommandRunResult } from 'claude-code'
import type { Disposable } from '../mod.js'
import { ContextEnd, ContextStart, type Context } from '../session/context/context.js'
import { Message, noFiles } from '../session/context/turn/message/message.js'
import { Note } from '../session/context/turn/message/note.js'
import { Person, senderOf } from '../session/context/turn/message/sender.js'
import { ToolCall } from '../session/context/turn/message/tool-call.js'
import { ToolResult } from '../session/context/turn/message/tool-result.js'
import { TurnEnd, TurnStart, type Turn } from '../session/context/turn/turn.js'
import { searchLimit, type ContextData, type GoalData, type SessionChange, type SessionData, type TaskData, type TurnData } from '../session/conversation.js'
import { GoalChange, type Goal } from '../session/goal/goal.js'
import { TaskEnd, TaskStart, type Task } from '../session/goal/task.js'
import { beforeEvents, processEvents, Session, sessionEvents, type BeforeEvent, type Placement, type BeforeMethods, type Surface, type OnMethods, type ProcessBeforeMethods, type ProcessName, type ProcessOnMethods, type RecordPart, type SearchOptions, type SessionEvent, type SessionScope, type SessionSend, type Sessions, type TaskOwner, type TaskStartArgs, type ToolCallArgs, type Usage } from '../session/session.js'
import { matches, sentMatcher, type Matcher, type SentMatcher } from '../utils/matcher.js'
import { foldAnswers, type Answers, type Place } from './before.js'
import type { Claude } from './claude.js'
import { cmodPluginName } from './dependencies.js'
import { messageOf } from '../utils/text.js'
import { listenerOf, PassedTimeout, withinTime, type ListenOptions, type ListenTime } from './deadline.js'
import { callFiles, type Hook, type HookAnswer } from './hooks.js'

export type Subscription = { readonly event: SessionEvent; readonly matcher: SentMatcher | undefined }

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
  usage: 'cmod:usage',
  subscribe: 'cmod:subscribe',
  watchBefore: 'cmod:watchBefore',
  act: 'cmod:act',
  changed: 'cmod:changed',
  before: 'cmod:before',
} as const

export type Act = 'send' | 'startTask' | 'callTool' | 'usage' | 'surfaces' | 'abort'

const actPermissions: Readonly<Record<Exclude<Act, 'callTool'>, string>> = { send: 'prompt', startTask: 'tasks', usage: 'conversation', surfaces: 'conversation', abort: 'prompt' }

const startsTurns: readonly string[] = ['CronCreate']

const ownSchedule: readonly string[] = ['CronDelete', 'CronList']

export const beforePermission = (event: BeforeEvent): string => (event === 'toolCall' ? 'tools' : event === TaskStart ? 'tasks' : 'prompt')

const methodOf = (prefix: 'on' | 'before', event: SessionEvent): string => `${prefix}${Object.entries(sessionEvents).find(([, each]) => each === event)?.[0] ?? event}`

export const isAct = (action: string): action is Act => action === 'callTool' || action in actPermissions

export function toolPermission(tool: string): string | undefined {
  return startsTurns.includes(tool) ? 'prompt' : ownSchedule.includes(tool) ? undefined : 'tools'
}

export function actPermission(action: Act, input: unknown): string | undefined {
  return action === 'callTool' ? (toolPermission(String((input as Partial<ToolCallArgs> | null)?.name)) ?? 'tools') : actPermissions[action]
}

export type Scope = { readonly session?: string; readonly context?: number; readonly turn?: string; readonly task?: string; readonly isGoal?: true; readonly isAgent?: true }

export type SessionsClient = {
  readonly sessions: Sessions
  changed(session: string, change: SessionChange, isInProject: boolean): void
  answerBefore(session: string, event: BeforeEvent, change: SessionChange, isInProject: boolean): Promise<unknown>
  raise(method: string, payload: Readonly<Record<string, unknown>>): Promise<unknown>
  listen(method: string, args: readonly unknown[]): Disposable
  /** An empty title keeps the title the session already has. */
  follow(current: Omit<SessionData, 'isRunning' | 'lastAt'>): void
}

type Listening = { scope: Scope; readonly event: SessionEvent; readonly method: string; readonly matcher: unknown; readonly listener: (payload: never, time: ListenTime) => unknown; readonly options: ListenOptions }

type Owned = { readonly session: string; readonly task: string }

export async function usageOf(claude: Pick<Claude, 'session'>): Promise<Usage> {
  const [model, usage] = await Promise.all([claude.session.model(), claude.session.usage()])
  const { tokens, window, percent } = usage.context
  return { model, contextWindow: { ...(tokens === undefined ? {} : { tokenCount: tokens }), size: window, ...(percent === undefined ? {} : { percent }) }, ...(usage.cost === undefined ? {} : { cost: { usd: usage.cost.usd } }) }
}

export function payloadOf(change: SessionChange): unknown {
  if (change.type === Message) return change.message
  if ('turn' in change) return change.turn
  if ('context' in change) return change.context
  if ('task' in change) {
    const { id, title, agentType, model, openedBy, openedAt, closedAt } = change.task
    return { id, title, openedBy, openedAt, ...(closedAt === undefined ? {} : { closedAt }), owner: { id, title, agentType, ...(model === undefined ? {} : { model }), startedAt: openedAt } }
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

export function createSessionsClient({ name, claude, report, isGranted, hookOn, routeOn }: { readonly name: string; readonly claude: Claude; readonly report: (id: string, message: string, error: unknown) => void; readonly isGranted: (permission: string) => boolean; readonly hookOn?: (hook: string, listener: (input: unknown) => unknown) => Disposable; readonly routeOn?: RouteOn }): SessionsClient {
  const call = <Answer>(method: string, input: unknown) => claude.cmod.call({ to: cmodPluginName, method, input }) as Promise<Answer>
  const listening = new Map<string, Set<Listening>>()
  const deciding = new Map<string, Set<Listening>>()
  const queued = new Set<string>()
  const parents = new Map<string, Map<string, string | undefined>>()
  const known = new Map<string, SessionData>()
  let current: SessionData = { id: '', title: '', project: '', cwd: '', model: '', startedAt: '', lastAt: '', isRunning: true }

  const keyOf = (scope: Scope) => scope.session ?? everySession

  const subscribe = (key: string) => {
    if (queued.has(key)) return
    queued.add(key)
    void Promise.resolve().then(async () => {
      queued.delete(key)
      const heard = (from: Map<string, Set<Listening>>): Subscription[] => [...(from.get(key) ?? [])].map(({ event, matcher }) => ({ event, matcher: matcher === undefined ? undefined : sentMatcher(matcher) }))
      const tracksTasks = [...(listening.get(key) ?? []), ...(deciding.get(key) ?? [])].some(({ scope }) => scope.task !== undefined || scope.isGoal === true)
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

  const add = (into: Map<string, Set<Listening>>, scope: Scope, event: SessionEvent, method: string, args: readonly unknown[], onChange: (key: string) => void): Disposable => {
    const key = keyOf(scope)
    const entry: Listening = { scope, event, method, ...listenerOf(name, method, args) }
    const set = into.get(key) ?? new Set()
    set.add(entry)
    into.set(key, set)
    if (scope.task !== undefined || scope.isGoal === true) void learnTasks(scope.session ?? current.id).catch((error: unknown) => report(`tasks:${key}`, 'Could not read the tasks it listens under', error))
    onChange(key)
    return {
      dispose() {
        for (const [at, held] of into) {
          if (!held.delete(entry)) continue
          if (held.size === 0) into.delete(at)
          onChange(at)
          return
        }
      },
    }
  }



  const combined = async (session: string, event: BeforeEvent, change: SessionChange, isInProject: boolean): Promise<Partial<Answers> | undefined> => {
    const askers = [...(deciding.get(session) ?? []), ...(isInProject ? (deciding.get(everySession) ?? []) : [])]
      .filter((entry) => entry.event === event)
      .map((entry) => async (latest: SessionChange) => {
        if (!isInScope(entry.scope, session, latest, isUnderIn(session))) return undefined
        if (entry.matcher !== undefined && !matches(payloadOf(latest), entry.matcher)) return undefined
        const payload = await payloadFor(session, latest)
        const answer = await withinTime(claude.clock, entry.method, entry.options, (time) => entry.listener(payload as never, time)).catch((error: unknown) => {
          if (entry.options.onFailure !== 'refuse') throw error
          report(`session:${entry.method}`, `The ${entry.method} listener failed`, error)
          return { refuse: `${name}: ${messageOf(error)}` }
        })
        if (answer === undefined || answer === null || (typeof answer === 'object' && 'refuse' in answer) || isGranted(beforePermission(event))) return answer
        throw new Error(`Its ${entry.method} answer changes nothing until ${beforePermission(event)} is turned on for ${name} in /mods.`)
      })
    return foldAnswers(event, change, askers, (error) => report(`session:${methodOf('before', event)}`, `The ${methodOf('before', event)} listener failed`, error))
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

  const withFiles = async (message: Message): Promise<Message> => {
    if (message.type !== ToolCall && message.type !== ToolResult) return message
    return { ...message, files: await callFiles(name, claude, { tool: message.name, input: message.input }, message.cwd) }
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

  const taskOf = (session: string, data: TaskData): Task => ({
    id: data.id,
    title: data.title,
    openedBy: data.openedBy,
    openedAt: data.openedAt,
    ...(data.closedAt === undefined ? {} : { closedAt: data.closedAt }),
    owner: ownerOf(session, data),
    ...recordPart({ session, task: data.id }),
    tasks: async () => (await call<TaskData[]>(conversationMethods.tasks, { session, task: data.id })).map((task) => taskOf(session, task)),
    messages: () => messagesFrom(conversationMethods.messages, { session, task: data.id }),
  })

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
      const added = await claude.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      if (added.deny !== undefined) throw new Error(`${name}: Claude Code refused the note: ${added.deny}`)
      return
    }
    const submitted = await claude.prompt.submit({ text, ...(as === Person ? { asUser: true } : {}) })
    if ('drop' in submitted && typeof submitted.drop === 'string') throw new Error(`${name}: Claude Code dropped the prompt: ${submitted.drop}`)
  }

  const startHere = async (task: TaskStartArgs): Promise<Task> => taskOf(current.id, await spawnTask(claude, task).catch((error: unknown) => Promise.reject(new Error(`${name}: ${messageOf(error)}`))))

  const surfacesHere = async (): Promise<Surface[]> => [...(await claude.session.surfaces())]

  const sessionOf = (read: () => SessionData, owned?: Owned) => {
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
    if (owned !== undefined) return session as unknown as Sessions['current']
    return Object.assign(session, {
      async startTask(task: TaskStartArgs): Promise<Task> {
        if (isHere()) return startHere(task)
        const started = await act<TaskData>(id(), 'startTask', task)
        return taskOf(id(), started)
      },
      callTool: async (toolCall: ToolCallArgs): Promise<ToolResult> => (await withFiles(await act<ToolResult>(id(), 'callTool', toolCall))) as ToolResult,
    }) as unknown as Sessions['current']
  }

  const ownerOf = (session: string, data: TaskData): TaskOwner => {
    const parent = session === current.id ? current : known.get(session)
    return sessionOf(
      () => ({
        id: data.id,
        title: data.title,
        project: parent?.project ?? '',
        agentType: data.agentType,
        model: data.model ?? '',
        cwd: parent?.cwd ?? '',
        isRunning: data.closedAt === undefined && (parent?.isRunning ?? true),
        startedAt: data.openedAt,
        lastAt: data.closedAt ?? data.openedAt,
      }),
      { session, task: data.id },
    )
  }

  type ProcessListener = { readonly matcher: unknown; readonly listener: (payload: HookFields, time: ListenTime) => unknown; readonly options: ListenOptions }
  const processListeners = new Map<string, Set<ProcessListener>>()

  const raise = async (method: string, payload: HookFields): Promise<HookFields | undefined> => {
    const isBefore = method.startsWith('before')
    const heard = [...(processListeners.get(method) ?? [])].filter(({ matcher }) => payload['task'] === undefined && (matcher === undefined || matches(payload, matcher)))
    if (!isBefore) {
      await Promise.all(
        heard.map(({ listener, options }) =>
          withinTime(claude.clock, method, options, (time) => listener(payload, time)).catch((error: unknown) => {
            if (!(error instanceof PassedTimeout)) report(`session:${method}`, `The ${method} listener failed`, error)
          }),
        ),
      )
      return undefined
    }
    const takes = answerKeys[method.slice('before'.length)] ?? []
    let merged: HookFields | undefined
    for (const { listener, options } of heard) {
      try {
        const answer = (await withinTime(claude.clock, method, options, (time) => listener(payload, time))) as HookFields | null | undefined
        if (answer === undefined || answer === null) continue
        const unread = Object.keys(answer).filter((key) => !takes.includes(key))
        if (unread.length > 0) throw new Error(`it answered ${unread.join(' and ')}, which ${method} does not take. It takes ${takes.map((key) => `{ ${key} }`).join(', ') || 'no answer'}.`)
        const notes = [merged?.['note'], answer['note']].filter((note): note is string => typeof note === 'string')
        merged = { ...merged, ...answer, ...(notes.length === 0 ? {} : { note: notes.join('\n\n') }) }
        if (typeof answer['refuse'] === 'string') return merged
      } catch (error) {
        report(`session:${method}`, `The ${method} listener failed`, error)
        if (options.onFailure === 'refuse' || method === 'beforePermissionRequest') return { refuse: `${name}: ${messageOf(error)}` }
      }
    }
    return merged
  }

  const permissionCheck = (e: ToolCheck, below: ToolCheckVerdict): HookFields => ({ session: current.id, cwd: current.cwd, ...defined({ task: e.agentId, callId: e.tool_use_id, reason: below.reason, rule: below.rule, ceiling: e.ceiling === undefined ? undefined : verdictName(e.ceiling) }), name: e.tool, input: recordOf(e.input), decision: verdictName(below.decision) })

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
    const changes = answer !== undefined && isGranted('prompt') ? answer : undefined
    if (answer !== undefined && changes === undefined) report('session:beforeRun', 'The beforeRun listener failed', new Error(`${name}: its answer changes a command, which needs the prompt permission.`))
    if (typeof changes?.['result'] === 'string') return { text: changes['result'], ...(typeof changes['exitCode'] === 'number' ? { exitCode: changes['exitCode'] } : {}) }
    const args = typeof changes?.['args'] === 'string' ? changes['args'] : e.args
    const ran = await next(args === e.args ? e : { ...e, args })
    void raise('onRun', { ...run, args })
    return typeof changes?.['note'] === 'string' ? { ...ran, context: [...(ran.context ?? []), changes['note']] } : ran
  })

  const listenTo = (method: string, named: string) => {
    if (hookOn === undefined || routeOn === undefined) throw new Error(`${name}: ${method} works only in a mod's own session.`)
    const isBefore = method.startsWith('before')
    if (named === 'PermissionCheck') {
      return routeOn('tool.check', async (e: ToolCheck, next) => {
        const below = (await next(e)) as ToolCheckVerdict
        if (!isBefore) {
          void raise(method, permissionCheck(e, below))
          return below
        }
        const answer = await raise(method, permissionCheck(e, below))
        if (answer === undefined || below.decision === 'deny') return below
        if (typeof answer['refuse'] === 'string') return { decision: 'deny', reason: answer['refuse'] }
        if (typeof answer['ask'] === 'string') return { decision: 'ask', reason: answer['ask'] }
        return answer['allow'] === true ? { decision: 'allow' } : below
      })
    }
    const event: { readonly on: string; readonly before?: string } = processEvents[named as ProcessName]
    const hook = (isBefore ? event.before : undefined) ?? event.on
    return hookOn(hook, async (input: unknown) => {
      const payload = processPayloadOf(named as Exclude<ProcessName, 'PermissionCheck'>, input)
      if (!isBefore) {
        if (named !== 'SessionStart' || payload['source'] !== 'compact') void raise(method, payload)
        return undefined
      }
      const answer = await raise(method, payload)
      return answer === undefined ? undefined : hookAnswerOf(named, hook, answer)
    })
  }

  const listen = (method: string, args: readonly unknown[]): Disposable => {
    const entry = listenerOf(name, method, args) as ProcessListener
    const held = processListeners.get(method) ?? new Set()
    if (!processListeners.has(method)) {
      listenTo(method, method.replace(/^(on|before)/, ''))
      processListeners.set(method, held)
    }
    held.add(entry)
    return { dispose: () => void held.delete(entry) }
  }

  const processMethods = (): ProcessOnMethods & ProcessBeforeMethods =>
    Object.fromEntries(
      Object.entries(processEvents).flatMap(([named, event]) => [`on${named}`, ...('before' in event ? [`before${named}`] : [])]).map((method) => [method, (...args: unknown[]) => listen(method, args)]),
    ) as ProcessOnMethods & ProcessBeforeMethods

  const currentSession = Object.assign(sessionOf(() => current), processMethods())
  const every = eventMethods(() => ({}), false)

  const answerBefore = async (session: string, event: BeforeEvent, change: SessionChange, isInProject: boolean) => (session === current.id || isGranted('conversation') ? combined(session, event, change, isInProject) : undefined)

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
      for (const key of isInProject ? [session, everySession] : [session]) {
        for (const { scope, event, method, matcher, listener, options } of listening.get(key) ?? []) {
          if (!isHeardBy(event, matcher, change) || !isInScope(scope, session, change, isUnderIn(session))) continue
          void payloadFor(session, change)
            .then((payload) => withinTime(claude.clock, method, options, (time) => listener(payload as never, time)))
            .catch((error: unknown) => {
              if (!(error instanceof PassedTimeout)) report(`session:${method}`, `The ${method} listener failed`, error)
            })
        }
      }
    },
    answerBefore,
    raise,
    listen,
    follow(next) {
      const moved = next.id !== current.id && current.id !== ''
      const previous = current.id
      current = { ...next, title: next.title || (next.id === current.id ? current.title : ''), isRunning: true, lastAt: new Date().toISOString() }
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
  }
}

type HookFields = Readonly<Record<string, unknown>>

type ToolCheck = { readonly tool: string; readonly input: unknown; readonly tool_use_id?: string; readonly agentId?: string; readonly ceiling?: 'allow' | 'ask' | 'deny' }

type ToolCheckVerdict = { readonly decision: 'allow' | 'ask' | 'deny'; readonly reason?: string; readonly rule?: string }

export type RouteOn = {
  (event: 'tool.check', hook: (e: ToolCheck, next: (e: ToolCheck) => Promise<unknown>) => Promise<unknown>): Disposable
  (event: 'command.run', hook: (e: Args<'command.run'>, next: (e: Args<'command.run'>) => Promise<CommandRunResult>) => Promise<CommandRunResult>): Disposable
}

const verdictName = (decision: 'allow' | 'ask' | 'deny') => (decision === 'deny' ? 'refuse' : decision)

const recordOf = (value: unknown): Readonly<Record<string, unknown>> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

const defined = (fields: HookFields): HookFields => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))

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
  ProjectSetup: [],
  SessionStart: ['note', 'title', 'reloadSkills', 'firstPrompt'],
  ModelChange: ['ask', 'refuse'],
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

const processFields: { readonly [Name in Exclude<keyof typeof processEvents, 'PermissionCheck'>]: (input: HookFields) => HookFields } = {
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

export async function spawnTask(claude: Pick<Claude, 'agent'>, task: TaskStartArgs): Promise<TaskData> {
  if (task.title.trim() === '') throw new Error('a task needs a title.')
  const started = await claude.agent.spawn({
    prompt: task.prompt,
    description: task.title,
    ...(task.name === undefined ? {} : { name: task.name }),
    ...(task.agentType === undefined ? {} : { subagentType: task.agentType }),
    ...(task.model === undefined ? {} : { model: task.model }),
    ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
  })
  if (started.deny !== undefined) throw new Error(`Claude Code refused the task: ${started.deny}`)
  if (started.agentId === undefined) throw new Error('Claude Code answered without starting a task.')
  return { id: started.agentId, title: task.title, agentType: task.agentType ?? 'general-purpose', model: started.model, openedBy: '', openedAt: new Date().toISOString() }
}

export function processPayloadOf(named: Exclude<keyof typeof processEvents, 'PermissionCheck'>, input: unknown): HookFields {
  const fields = recordOf(input)
  return { ...placementOf(fields), ...defined(processFields[named](fields)) }
}

export function hookAnswerOf(named: string, hook: string, answer: HookFields): HookAnswer | undefined {
  const output = (fields: HookFields): HookAnswer => ({ hookSpecificOutput: { hookEventName: hook as Hook, ...defined(fields) } })
  const refuse = typeof answer['refuse'] === 'string' ? answer['refuse'] : undefined
  if (named === 'SessionStart') return output({ additionalContext: answer['note'], sessionTitle: answer['title'], reloadSkills: answer['reloadSkills'], initialUserMessage: answer['firstPrompt'] })
  if (named === 'ModelChange') {
    if (refuse !== undefined) return output({ permissionDecision: 'deny', permissionDecisionReason: refuse })
    return typeof answer['ask'] === 'string' ? output({ permissionDecision: 'ask', permissionDecisionReason: answer['ask'] }) : undefined
  }
  if (named === 'WorktreeCreate') return output({ worktreePath: answer['result'] })
  if (named === 'PermissionRequest') {
    if (refuse !== undefined) return output({ decision: defined({ behavior: 'deny', message: refuse, interrupt: answer['interrupt'] }) })
    return answer['allow'] === true ? output({ decision: defined({ behavior: 'allow', updatedInput: answer['input'], updatedPermissions: answer['updates'] }) }) : undefined
  }
  if (named === 'PermissionDenial') return output({ retry: answer['retry'] })
  if (named === 'ToolBatch') return output({ additionalContext: answer['note'] })
  if (named === 'ReplyDisplay') return output({ displayContent: answer['text'] })
  return refuse === undefined ? undefined : { decision: 'block', reason: refuse }
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
