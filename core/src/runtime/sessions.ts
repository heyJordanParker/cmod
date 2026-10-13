import type { Disposable } from '../mod.js'
import type { Context } from '../session/context/context.js'
import { Message } from '../session/context/turn/message/message.js'
import { Note } from '../session/context/turn/message/note.js'
import { Person } from '../session/context/turn/message/sender.js'
import type { Turn } from '../session/context/turn/turn.js'
import type { ContextData, GoalData, SessionChange, SessionData, TaskData, TurnData } from '../session/conversation.js'
import type { Goal } from '../session/goal/goal.js'
import type { Task } from '../session/goal/task.js'
import { Session, type SessionEvent, type SessionScope, type SessionSend, type Sessions, type TaskStartArgs, type Usage } from '../session/session.js'
import { matches, sentMatcher, type SentMatcher } from '../utils/matcher.js'
import type { Claude } from './claude.js'
import { cmodPluginName } from './dependencies.js'

export type Subscription = { readonly event: SessionEvent; readonly matcher: SentMatcher | undefined }

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
  send: 'cmod:send',
  changed: 'cmod:changed',
} as const

export type SessionsClient = {
  readonly sessions: Sessions
  changed(session: string, change: SessionChange): void
  /** An empty title keeps the title the session already has. */
  follow(current: Omit<SessionData, 'isRunning' | 'lastAt'>): void
}

type Listening = { readonly event: SessionEvent; readonly matcher: unknown; readonly listener: (payload: never) => unknown }

export async function usageOf(claude: Pick<Claude, 'session'>): Promise<Usage> {
  const [model, usage] = await Promise.all([claude.session.model(), claude.session.usage()])
  const { tokens, window, percent } = usage.context
  return { model, context: { ...(tokens === undefined ? {} : { tokens }), window, ...(percent === undefined ? {} : { percent }) }, ...(usage.cost === undefined ? {} : { cost: { usd: usage.cost.usd } }) }
}

export function payloadOf(change: SessionChange): unknown {
  if (change.type === Message) return change.message
  if ('turn' in change) return change.turn
  if ('context' in change) return change.context
  if ('task' in change) return change.task
  return change.goal
}

export function isHeardBy(event: SessionEvent, matcher: unknown, change: SessionChange): boolean {
  const named = change.type === Message ? (event === Message || event === change.message.type) : event === change.type
  return named && (matcher === undefined || matches(payloadOf(change), matcher))
}

export function createSessionsClient({ name, claude, report }: { readonly name: string; readonly claude: Claude; readonly report: (id: string, message: string, error: unknown) => void }): SessionsClient {
  const call = <Answer>(method: string, input: unknown) => claude.cmod.call({ to: cmodPluginName, method, input }) as Promise<Answer>
  const listening = new Map<string, Set<Listening>>()
  const queued = new Set<string>()
  let current: SessionData = { id: '', title: '', project: '', cwd: '', model: '', startedAt: '', lastAt: '', isRunning: true }

  const subscribe = (session: string) => {
    if (queued.has(session)) return
    queued.add(session)
    void Promise.resolve().then(async () => {
      queued.delete(session)
      const subscriptions: Subscription[] = [...(listening.get(session) ?? [])].map(({ event, matcher }) => ({ event, matcher: matcher === undefined ? undefined : sentMatcher(matcher) }))
      await call(conversationMethods.subscribe, { session, subscriptions }).catch((error: unknown) => report(`sessions:${session}`, `Hears nothing from session ${session}`, error))
    })
  }

  const isCurrent = (id: string) => id === current.id

  const refuseElsewhere = (id: string, what: string): never => {
    throw new Error(`${name}: ${what} works on the session this mod runs in, and ${id} runs elsewhere or has ended.`)
  }

  const turnOf = (session: string, data: TurnData): Turn => ({ ...data, messages: () => call<Message[]>(conversationMethods.messages, { session, turn: data.prompt.id }) })

  const contextOf = (session: string, data: ContextData): Context => ({
    ...data,
    turns: async () => (await call<TurnData[]>(conversationMethods.turns, { session, context: data.number })).map((turn) => turnOf(session, turn)),
  })

  const taskOf = (session: string, data: TaskData): Task => ({
    ...data,
    messages: () => call<Message[]>(conversationMethods.messages, { session, task: data.id }),
    tasks: async () => (await call<TaskData[]>(conversationMethods.tasks, { session, task: data.id })).map((task) => taskOf(session, task)),
  })

  const goalOf = (session: string, data: GoalData): Goal => ({
    ...data,
    update: async ({ text }) => {
      if (text.trim() === '') throw new Error(`${name}: a goal needs text.`)
      await call(conversationMethods.updateGoal, { session, text })
    },
    tasks: async () => (await call<TaskData[]>(conversationMethods.tasks, { session })).map((task) => taskOf(session, task)),
  })

  const payloadFor = (session: string, change: SessionChange): unknown => {
    if (change.type === Message) return change.message
    if ('turn' in change) return turnOf(session, change.turn)
    if ('context' in change) return contextOf(session, change.context)
    if ('task' in change) return taskOf(session, change.task)
    return goalOf(session, change.goal)
  }

  const sessionOf = (read: () => SessionData) => {
    const id = () => read().id
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
      get cwd() {
        return read().cwd
      },
      get model() {
        return read().model
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
      get isRunning() {
        return read().isRunning
      },
      async usage(): Promise<Usage> {
        if (!isCurrent(id())) refuseElsewhere(id(), 'usage()')
        return usageOf(claude)
      },
      on(event: SessionEvent, matcherOrListener: unknown, maybeListener?: (payload: never) => unknown): Disposable {
        const listener = (maybeListener ?? matcherOrListener) as (payload: never) => unknown
        const matcher = maybeListener === undefined ? undefined : matcherOrListener
        const owner = id()
        const heard: Listening = { event, matcher, listener }
        const set = listening.get(owner) ?? new Set()
        set.add(heard)
        listening.set(owner, set)
        subscribe(owner)
        return {
          dispose() {
            if (!set.delete(heard)) return
            if (set.size === 0) listening.delete(owner)
            subscribe(owner)
          },
        }
      },
      async send({ type, text, as }: SessionSend) {
        if (text.trim() === '') throw new Error(`${name}: send needs text.`)
        if (isCurrent(id())) {
          if (as === Session) throw new Error(`${name}: send with as: Session messages another session, and this one runs this mod.`)
          if (type === Note) {
            if (as !== undefined) throw new Error(`${name}: a Note is always from this mod, so it takes no as.`)
            const added = await claude.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
            if (added.deny !== undefined) throw new Error(`${name}: Claude Code refused the note: ${added.deny}`)
            return
          }
          const submitted = await claude.prompt.submit({ text, ...(as === Person ? { asUser: true } : {}) })
          if ('drop' in submitted && typeof submitted.drop === 'string') throw new Error(`${name}: Claude Code dropped the prompt: ${submitted.drop}`)
          return
        }
        if (!read().isRunning) throw new Error(`${name}: session ${id()} has ended, so it takes no messages.`)
        if (as === Session) {
          if (type === Note) throw new Error(`${name}: a message from this session reaches Claude as a Prompt, so send it with type: Prompt.`)
          const sent = await claude.session.send({ to: { sessionId: id() }, text })
          if (sent.isDelivered !== true) throw new Error(`${name}: Claude Code could not deliver the message to session ${id()}.`)
          return
        }
        await call(conversationMethods.send, { session: id(), type, text, ...(as === undefined ? {} : { as }) })
      },
      async startTask(task: TaskStartArgs): Promise<Task> {
        if (!isCurrent(id())) refuseElsewhere(id(), 'startTask()')
        const started = await claude.agent.spawn({
          prompt: task.prompt,
          ...(task.name === undefined ? {} : { description: task.name, name: task.name }),
          ...(task.agentType === undefined ? {} : { subagentType: task.agentType }),
          ...(task.model === undefined ? {} : { model: task.model }),
          ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
        })
        if (started.deny !== undefined) throw new Error(`${name}: Claude Code refused the task: ${started.deny}`)
        const data: TaskData = { id: started.agentId ?? '', title: task.name ?? '', agentType: task.agentType ?? 'general-purpose', model: started.model, openedBy: '', openedAt: new Date().toISOString() }
        return taskOf(id(), data)
      },
      messages: (options: { readonly after?: string; readonly last?: number } = {}) => call<Message[]>(conversationMethods.messages, { session: id(), ...options }),
      turns: async (options: { readonly last?: number } = {}) => (await call<TurnData[]>(conversationMethods.turns, { session: id(), ...options })).map((turn) => turnOf(id(), turn)),
      contexts: async () => (await call<ContextData[]>(conversationMethods.contexts, { session: id() })).map((context) => contextOf(id(), context)),
      goal: async () => goalOf(id(), await call<GoalData>(conversationMethods.goal, { session: id() })),
    }
    return session
  }

  const currentSession = sessionOf(() => current)

  return {
    sessions: {
      get current() {
        return currentSession as unknown as Sessions['current']
      },
      list: async (scope: SessionScope = {}) =>
        (await call<SessionData[]>(conversationMethods.sessions, scope)).map((data) => {
          if (data.id !== current.id) return sessionOf(() => data) as unknown as Sessions['current']
          if (current.title === '') current = { ...current, title: data.title }
          return currentSession as unknown as Sessions['current']
        }),
      search: (text, options = {}) => call<Message[]>(conversationMethods.search, { text, ...options, ...(options.before === undefined ? {} : { before: { session: options.before.session, id: options.before.id } }) }),
    },
    changed(session, change) {
      for (const { event, matcher, listener } of listening.get(session) ?? []) {
        if (!isHeardBy(event, matcher, change)) continue
        void Promise.resolve()
          .then(() => listener(payloadFor(session, change) as never))
          .catch((error: unknown) => report(`session:${event}`, `The ${event} listener failed`, error))
      }
    },
    follow(next) {
      const moved = next.id !== current.id && current.id !== ''
      const previous = current.id
      current = { ...next, title: next.title || (next.id === current.id ? current.title : ''), isRunning: true, lastAt: new Date().toISOString() }
      if (!moved) return
      const kept = listening.get(previous)
      if (kept === undefined) return
      listening.delete(previous)
      listening.set(current.id, kept)
      subscribe(previous)
      subscribe(current.id)
    },
  }
}
