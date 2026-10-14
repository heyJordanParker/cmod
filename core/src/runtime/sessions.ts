import type { Disposable } from '../mod.js'
import { ContextEnd, ContextStart, type Context } from '../session/context/context.js'
import { Message } from '../session/context/turn/message/message.js'
import { Note } from '../session/context/turn/message/note.js'
import { Person } from '../session/context/turn/message/sender.js'
import { ToolResult } from '../session/context/turn/message/tool-result.js'
import { TurnEnd, TurnStart, type Turn } from '../session/context/turn/turn.js'
import type { ContextData, GoalData, SessionChange, SessionData, TaskData, TurnData } from '../session/conversation.js'
import { GoalChange, type Goal } from '../session/goal/goal.js'
import { TaskEnd, TaskStart, type Task } from '../session/goal/task.js'
import { Session, type BeforeEvent, type Client, type RecordPart, type SearchOptions, type SessionEvent, type SessionScope, type SessionSend, type Sessions, type TaskStartArgs, type ToolCallArgs, type Usage } from '../session/session.js'
import { matches, sentMatcher, type SentMatcher } from '../utils/matcher.js'
import { foldAnswers, type Answers, type Place } from './before.js'
import type { Claude } from './claude.js'
import { cmodPluginName } from './dependencies.js'

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

export type Act = 'send' | 'startTask' | 'callTool' | 'usage' | 'clients'

const actPermissions: Readonly<Record<Exclude<Act, 'callTool'>, string>> = { send: 'prompt', startTask: 'tasks', usage: 'conversation', clients: 'conversation' }

const startsTurns: readonly string[] = ['CronCreate']

const ownSchedule: readonly string[] = ['CronDelete', 'CronList']

export const beforePermission = (event: BeforeEvent): string => (event === 'toolCall' ? 'tools' : event === TaskStart || event === TaskEnd ? 'tasks' : 'prompt')

export const isAct =(action: string): action is Act => action === 'callTool' || action in actPermissions

export function toolPermission(tool: string): string | undefined {
  return startsTurns.includes(tool) ? 'prompt' : ownSchedule.includes(tool) ? undefined : 'tools'
}

export function actPermission(action: Act, input: unknown): string | undefined {
  return action === 'callTool' ? (toolPermission(String((input as Partial<ToolCallArgs> | null)?.name)) ?? 'tools') : actPermissions[action]
}

export type Scope = { readonly session?: string; readonly context?: number; readonly turn?: string; readonly task?: string; readonly isGoal?: true }

export type SessionsClient = {
  readonly sessions: Sessions
  changed(session: string, change: SessionChange, isInProject: boolean): void
  answerBefore(session: string, event: BeforeEvent, change: SessionChange, isInProject: boolean): Promise<unknown>
  /** An empty title keeps the title the session already has. */
  follow(current: Omit<SessionData, 'isRunning' | 'lastAt'>): void
}

type Listening = { scope: Scope; readonly event: SessionEvent; readonly matcher: unknown; readonly listener: (payload: never) => unknown }

type Owned = { readonly session: string; readonly task: string }

const asked = (action: string) => `cmod: ${action} runs only on a session's own main loop, and Claude Code gives a subagent's tasks no way to start a task or run a tool.`

export async function usageOf(claude: Pick<Claude, 'session'>): Promise<Usage> {
  const [model, usage] = await Promise.all([claude.session.model(), claude.session.usage()])
  const { tokens, window, percent } = usage.context
  return { model, context: { ...(tokens === undefined ? {} : { tokens }), window, ...(percent === undefined ? {} : { percent }) }, ...(usage.cost === undefined ? {} : { cost: { usd: usage.cost.usd } }) }
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
  if (scope.task !== undefined && (task === undefined || !isUnder(task, scope.task))) return false
  if (scope.isGoal === true && change.type !== GoalChange && change.type !== TaskStart && (task === undefined || task === scope.task)) return false
  if (scope.context !== undefined && (contextOfChange(change) !== scope.context || ownerOfChange(change) !== scope.task)) return false
  if (scope.turn === undefined) return true
  if (change.type === Message) return change.message.turn === scope.turn
  return (change.type === TurnStart || change.type === TurnEnd) && change.turn.prompt.id === scope.turn
}

export function createSessionsClient({ name, claude, report, isGranted }: { readonly name: string; readonly claude: Claude; readonly report: (id: string, message: string, error: unknown) => void; readonly isGranted: (permission: string) => boolean }): SessionsClient {
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

  const add = (into: Map<string, Set<Listening>>, scope: Scope, event: SessionEvent, matcherOrListener: unknown, maybeListener: unknown, onChange: (key: string) => void): Disposable => {
    const listener = (maybeListener ?? matcherOrListener) as (payload: never) => unknown
    const matcher = maybeListener === undefined ? undefined : matcherOrListener
    const key = keyOf(scope)
    const entry: Listening = { scope, event, matcher, listener }
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
        const answer = await entry.listener(payloadFor(session, latest) as never)
        if (answer === undefined || isGranted(beforePermission(event))) return answer
        throw new Error(`Its before(${event}) answer changes nothing until ${beforePermission(event)} is turned on for ${name} in /mods.`)
      })
    return foldAnswers(event, change, askers, (error) => report(`before:${event}`, `The before(${event}) listener failed`, error))
  }

  const recordPart = (scope: Scope): RecordPart => ({
    search: (text: string, options: SearchOptions = {}) => call(conversationMethods.search, { text, ...scope, ...optionsOf(options) }),
    on: (event: SessionEvent, matcherOrListener: unknown, maybeListener?: unknown) => add(listening, scope, event, matcherOrListener, maybeListener, subscribe),
    before: (event: BeforeEvent, matcherOrListener: unknown, maybeListener?: unknown) => add(deciding, scope, event, matcherOrListener, maybeListener, subscribe),
  }) as RecordPart

  const turnOf = (scope: Scope, data: TurnData): Turn => {
    const task = data.prompt.task ?? scope.task
    return {
      ...data,
      ...recordPart({ ...scope, ...(task === undefined ? {} : { task }), turn: data.prompt.id }),
      messages: () => call<Message[]>(conversationMethods.messages, { session: scope.session, turn: data.prompt.id, ...(task === undefined ? {} : { task }) }),
    }
  }

  const contextOf = (scope: Scope, data: ContextData): Context => {
    const owned: Scope = { ...(scope.session === undefined ? {} : { session: scope.session }), ...(data.task === undefined ? {} : { task: data.task }) }
    return {
      ...data,
      ...recordPart({ ...owned, context: data.number }),
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
    messages: () => call<Message[]>(conversationMethods.messages, { session, task: data.id }),
  })

  const goalOf = (scope: Scope, data: GoalData): Goal => ({
    ...data,
    ...recordPart({ ...scope, isGoal: true }),
    tasks: async () => (await call<TaskData[]>(conversationMethods.tasks, { session: scope.session, ...(scope.task === undefined ? {} : { task: scope.task }) })).map((task) => taskOf(scope.session ?? current.id, task)),
    update: async ({ text }) => {
      if (text.trim() === '') throw new Error(`${name}: a goal needs text.`)
      await call(conversationMethods.updateGoal, { session: scope.session ?? current.id, ...(scope.task === undefined ? {} : { task: scope.task }), text })
    },
  })

  const payloadFor = (session: string, change: SessionChange): unknown => {
    const scope = { session }
    if (change.type === Message) return change.message
    if ('turn' in change) return turnOf(scope, change.turn)
    if ('context' in change) return contextOf(scope, change.context)
    if ('task' in change) return taskOf(session, change.task)
    if ('usage' in change) return change.usage
    return goalOf({ session, ...(change.goal.task === undefined ? {} : { task: change.goal.task }) }, { text: change.goal.text })
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

  const startHere = async (task: TaskStartArgs): Promise<Task> => {
    const started = await claude.agent.spawn({
      prompt: task.prompt,
      ...(task.name === undefined ? {} : { description: task.name, name: task.name }),
      ...(task.agentType === undefined ? {} : { subagentType: task.agentType }),
      ...(task.model === undefined ? {} : { model: task.model }),
      ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
    })
    if (started.deny !== undefined) throw new Error(`${name}: Claude Code refused the task: ${started.deny}`)
    return taskOf(current.id, { id: started.agentId ?? '', title: task.name ?? '', agentType: task.agentType ?? 'general-purpose', model: started.model, openedBy: '', openedAt: new Date().toISOString() })
  }

  const clientsHere = async (): Promise<Client[]> => [...(await claude.session.surfaces())]

  const sessionOf = (read: () => SessionData, owned?: Owned) => {
    const id = () => read().id
    const isHere = () => owned === undefined && id() === current.id
    const scope = (): Scope => (owned === undefined ? { session: id() } : { session: owned.session, task: owned.task })
    const where = () => (owned === undefined ? { session: id() } : { session: owned.session, task: owned.task })
    const turnsOf = async (options: { readonly last?: number } = {}): Promise<Turn[]> => (await call<TurnData[]>(conversationMethods.turns, { ...where(), ...options })).map((turn) => turnOf(scope(), turn))
    const contextsOf = async (): Promise<Context[]> => (await call<ContextData[]>(conversationMethods.contexts, where())).map((context) => contextOf(scope(), context))
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
      search: (text: string, options: SearchOptions = {}) => recordPart(scope()).search(text, options),
      on: (event: SessionEvent, matcherOrListener: unknown, maybeListener?: unknown) => (recordPart(scope()).on as (...args: unknown[]) => Disposable)(event, matcherOrListener, maybeListener),
      before: (event: BeforeEvent, matcherOrListener: unknown, maybeListener?: unknown) => (recordPart(scope()).before as (...args: unknown[]) => Disposable)(event, matcherOrListener, maybeListener),
      goal: async () => goalOf(scope(), await call<GoalData>(conversationMethods.goal, where())),
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
      messages: (options: { readonly after?: string; readonly last?: number } = {}) => call<Message[]>(conversationMethods.messages, { ...where(), ...options }),
      usage: async (): Promise<Usage> => (isHere() ? usageOf(claude) : act<Usage>(id(), 'usage', null, owned)),
      clients: async (): Promise<Client[]> => (isHere() ? clientsHere() : act<Client[]>(id(), 'clients', null, owned)),
      async send(message: SessionSend) {
        if (message.text.trim() === '') throw new Error(`${name}: send needs text.`)
        if (isHere() && message.as !== Session) return sendHere(message)
        await act(id(), 'send', message, owned)
      },
      async startTask(task: TaskStartArgs): Promise<Task> {
        if (owned !== undefined) throw new Error(asked('startTask'))
        if (isHere()) return startHere(task)
        const started = await act<TaskData>(id(), 'startTask', task)
        return taskOf(id(), started)
      },
      async callTool(toolCall: ToolCallArgs): Promise<ToolResult> {
        if (owned !== undefined) throw new Error(asked('callTool'))
        return act<ToolResult>(id(), 'callTool', toolCall)
      },
    }
    return session as unknown as Sessions['current']
  }

  const ownerOf = (session: string, data: TaskData): Sessions['current'] => {
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

  const currentSession = sessionOf(() => current)
  const every = recordPart({})

  const answerBefore = async (session: string, event: BeforeEvent, change: SessionChange, isInProject: boolean) => (isGranted('conversation') ? combined(session, event, change, isInProject) : undefined)

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
      search: (text, options = {}) => call<Message[]>(conversationMethods.search, { text, ...optionsOf(options), ...(options.running === undefined ? {} : { running: options.running }), ...(options.since === undefined ? {} : { since: options.since }), ...(options.everyProject === undefined ? {} : { everyProject: options.everyProject }) }),
      on: every.on,
      before: every.before,
    },
    changed(session, change, isInProject) {
      remember(session, change)
      for (const key of isInProject ? [session, everySession] : [session]) {
        for (const { scope, event, matcher, listener } of listening.get(key) ?? []) {
          if (!isHeardBy(event, matcher, change) || !isInScope(scope, session, change, isUnderIn(session))) continue
          void Promise.resolve()
            .then(() => listener(payloadFor(session, change) as never))
            .catch((error: unknown) => report(`session:${event}`, `The ${event} listener failed`, error))
        }
      }
    },
    answerBefore,
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

export function resultOf(where: Pick<Place, 'session' | 'context' | 'turn'>, answered: Awaited<ReturnType<Claude['tool']['call']>>): ToolResult {
  const base: Omit<ToolResult, 'text' | 'isError'> = { id: '', type: ToolResult, at: new Date().toISOString(), session: where.session, context: where.context, ...(where.turn === undefined ? {} : { turn: where.turn.prompt.id }), callId: '' }
  if (answered.deny !== undefined) return { ...base, text: answered.deny, isError: true }
  return { ...base, text: answered.text ?? JSON.stringify(answered.result), isError: answered.isError === true }
}

function optionsOf(options: SearchOptions): Readonly<Record<string, unknown>> {
  return { ...(options.limit === undefined ? {} : { limit: options.limit }), ...(options.before === undefined ? {} : { before: { session: options.before.session, id: options.before.id } }) }
}
