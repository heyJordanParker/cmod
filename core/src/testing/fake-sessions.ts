import { isObject } from '../records.js'
import { Document } from '../session/context/turn/message/document.js'
import { Message, noFiles, searchText, skillPrefix, type Row } from '../session/context/turn/message/message.js'
import { Note } from '../session/context/turn/message/note.js'
import { Notice } from '../session/context/turn/message/notice.js'
import { Prompt } from '../session/context/turn/message/prompt.js'
import { Reply } from '../session/context/turn/message/reply.js'
import { Mod, Person, Schedule, type Sender } from '../session/context/turn/message/sender.js'
import { GoalChange } from '../session/goal/goal.js'
import { Task } from '../session/goal/task.js'
import { Skill } from '../session/context/turn/message/skill.js'
import { ToolCall } from '../session/context/turn/message/tool-call.js'
import { ToolResult } from '../session/context/turn/message/tool-result.js'
import { createConversation, emptyConversation, searchLimit, type ContextData, type Conversation, type SessionChange, type SessionData, type TaskData, type TurnData, type TurnEnding } from '../session/conversation.js'
import type { Place } from '../runtime/before.js'
import type { Claude } from '../runtime/claude.js'
import { conversationMethods, everySession, isHeardBy, resultOf, type Subscription } from '../runtime/sessions.js'
import { receivedMatcher } from '../utils/matcher.js'
import { firstLine, messageOf } from '../utils/text.js'

export type MessageDraft =
  | { readonly type: typeof Prompt; readonly text: string; readonly from?: Sender }
  | { readonly type: typeof Note; readonly text: string; readonly from?: Sender }
  | { readonly type: typeof Reply; readonly text: string }
  | { readonly type: typeof ToolCall; readonly name: string; readonly input?: Readonly<Record<string, unknown>>; readonly callId?: string }
  | { readonly type: typeof ToolResult; readonly callId: string; readonly output: string; readonly isError?: boolean }
  | { readonly type: typeof Skill; readonly name: string; readonly text: string }
  | { readonly type: typeof Document; readonly path: string; readonly text: string }
  | { readonly type: typeof Notice; readonly text: string }

export type FakeSession = Partial<Omit<SessionData, 'id'>> & {
  readonly id: string
  readonly messages?: readonly MessageDraft[]
  readonly goal?: string
}

type Kept = {
  data: SessionData
  readonly conversation: Conversation
  readonly messages: Message[]
  readonly turns: Map<string, TurnData>
  readonly contexts: Map<number, ContextData>
  readonly tasks: Map<string, TaskData>
}

type Heard = { readonly event: Subscription['event']; readonly matcher: unknown }


export type FakeSessions = {
  answer(caller: string, method: string, input: unknown): unknown
  add(draft: MessageDraft, task?: string): Message[]
  place(): Place
  wants(mod: string, event: string): boolean
  endTurn(ending?: TurnEnding): void
  compact(): void
  startTask(task: { readonly title: string; readonly agentType?: string; readonly model?: string; readonly openedBy?: string; readonly parent?: string }): string
  start(id: string): void
  readonly sent: { readonly session: string; readonly task?: string; readonly type: string; readonly text: string; readonly as?: string }[]
}

export function fakeSessions({ project, given, push, callTool }: { readonly project: () => string; readonly given: readonly FakeSession[]; readonly push: (mod: string, session: string, change: SessionChange) => void; readonly callTool: Claude['tool']['call'] }): FakeSessions {
  const kept = new Map<string, Kept>()
  const heard = new Map<string, Map<string, readonly Heard[]>>()
  const watches = new Map<string, Map<string, readonly string[]>>()
  const goals = new Map<string, string>()
  const sent: FakeSessions['sent'] = []
  let current = ''
  let clock = Date.parse('2026-01-01T00:00:00.000Z')
  let ids = 0
  const now = () => new Date((clock += 1000)).toISOString()

  const keep = (data: SessionData): Kept => {
    const session: Kept = { data, conversation: createConversation(emptyConversation(data.id)), messages: [], turns: new Map(), contexts: new Map(), tasks: new Map() }
    kept.set(data.id, session)
    return session
  }

  const record = (session: Kept, changes: readonly SessionChange[]) => {
    for (const change of changes) {
      if (change.type === Message) session.messages.push(change.message)
      if ('turn' in change) session.turns.set(change.turn.prompt.id, change.turn)
      if ('context' in change) session.contexts.set(change.context.number, change.context)
      if ('task' in change) session.tasks.set(change.task.id, change.task)
      session.data = { ...session.data, lastAt: change.type === Message ? change.message.at : session.data.lastAt, ...(session.data.title === '' && change.type === Message && change.message.type === Prompt && change.message.from.type === Person ? { title: firstLine(change.message.text) } : {}) }
      for (const [mod, sessions] of heard) {
        if ([...(sessions.get(session.data.id) ?? []), ...(sessions.get(everySession) ?? [])].some(({ event, matcher }) => isHeardBy(event, matcher, change))) push(mod, session.data.id, change)
      }
    }
  }

  const add = (session: Kept, draft: MessageDraft, task?: string) => {
    const before = session.messages.length
    record(session, session.conversation.add(rowOf(draft, `message-${(ids += 1)}`, now()), task))
    return session.messages.slice(before)
  }

  for (const each of given) {
    const session = keep({ title: '', project: project(), cwd: project(), model: 'test-model', startedAt: now(), lastAt: '', isRunning: false, ...each })
    for (const draft of each.messages ?? []) add(session, draft)
    if (each.goal !== undefined) record(session, session.conversation.changeGoal(each.goal))
  }

  const sessionOf = (id: string) => {
    const session = kept.get(id)
    if (session === undefined) throw new Error(`No Claude Code transcript is named ${id}.jsonl. Give it to testMod as { sessions: [{ id: '${id}' }] }.`)
    return session
  }

  const currentSession = () => sessionOf(current)

  const place = (): Place => {
    const { session, context, contextOpenedAt, turn, tasks, taskTurns, openCalls } = currentSession().conversation.state
    return { session, context, contextOpenedAt, ...(turn === undefined ? {} : { turn }), tasks, taskTurns, ...(openCalls === undefined ? {} : { openCalls }) }
  }

  const taskOf = (session: Kept, id: string) => {
    const task = session.tasks.get(id)
    if (task === undefined) throw new Error(`Session ${session.data.id} has no task ${id}. Start it with tested.startTask.`)
    return task
  }

  const turnsOf = (session: Kept, task: unknown) => [...session.turns.values()].filter((turn) => turn.prompt.task === (typeof task === 'string' ? task : undefined))

  const isUnder = (session: Kept | undefined, task: string, ancestor: string) => {
    for (let at: string | undefined = task, steps = 0; at !== undefined && steps < 64; at = session?.tasks.get(at)?.parent, steps += 1) if (at === ancestor) return true
    return false
  }

  const lastOf = <Item>(items: readonly Item[], last: unknown): Item[] => (typeof last === 'number' ? items.slice(-last) : [...items])

  const isInScope = (session: Kept, request: Readonly<Record<string, unknown>>) =>
    (request['everyProject'] === true || session.data.project === project()) && session.data.lastAt >= (typeof request['since'] === 'string' ? request['since'] : '') && (request['running'] !== true || session.data.isRunning)

  const methods: Readonly<Record<string, (request: Readonly<Record<string, unknown>>, caller: string) => unknown>> = {
    [conversationMethods.sessions]: (request) =>
      [...kept.values()]
        .filter((session) => isInScope(session, request))
        .map((session) => session.data)
        .toSorted((first, second) => second.lastAt.localeCompare(first.lastAt)),
    [conversationMethods.search](request) {
      const text = String(request['text'])
      if ([...text].length < 3) throw new Error('cmod history search takes at least 3 characters.')
      const inRecord = (message: Message) => {
        const session = kept.get(message.session)
        const task = request['task']
        if (request['session'] !== undefined && message.session !== request['session']) return false
        if (typeof task === 'string' && (message.task === undefined || !isUnder(session, message.task, task) || (request['isGoal'] === true && message.task === task))) return false
        if (task === undefined && request['isGoal'] === true && message.task === undefined) return false
        return (request['turn'] === undefined || message.turn === request['turn']) && (request['context'] === undefined || message.context === request['context'])
      }
      const found = [...kept.values()]
        .filter((session) => request['session'] !== undefined || isInScope(session, request))
        .flatMap((session) => session.messages)
        .filter((message) => inRecord(message) && searchText(message).toLowerCase().includes(text.toLowerCase()))
        .toSorted((first, second) => second.at.localeCompare(first.at))
      const before = isObject(request['before']) ? request['before'] : undefined
      const start = before === undefined ? 0 : found.findIndex((message) => message.session === before['session'] && message.id === before['id']) + 1
      return found.slice(start, start + (typeof request['limit'] === 'number' ? request['limit'] : searchLimit))
    },
    [conversationMethods.messages](request) {
      const session = sessionOf(String(request['session']))
      const fits = session.messages.filter((message) => message.task === request['task'] && (request['turn'] === undefined || message.turn === request['turn']))
      const after = typeof request['after'] === 'string' ? fits.findIndex((message) => message.id === request['after']) + 1 : 0
      return lastOf(fits.slice(after), request['last'])
    },
    [conversationMethods.turns]: (request) => lastOf(turnsOf(sessionOf(String(request['session'])), request['task']).filter((turn) => request['context'] === undefined || turn.context === request['context']), request['last']),
    [conversationMethods.contexts](request) {
      const session = sessionOf(String(request['session']))
      if (typeof request['task'] !== 'string') return [...session.contexts.values()]
      const task = taskOf(session, request['task'])
      return [{ number: session.conversation.state.tasks[task.id]?.context ?? 1, openedAt: task.openedAt, ...(task.closedAt === undefined ? {} : { closedAt: task.closedAt }) }]
    },
    [conversationMethods.tasks]: (request) => [...sessionOf(String(request['session'])).tasks.values()].filter((task) => request['all'] === true || task.parent === request['task']),
    [conversationMethods.goal](request) {
      const session = sessionOf(String(request['session']))
      const task = request['task']
      if (typeof task !== 'string') return { text: session.conversation.state.goal ?? '' }
      return { text: goals.get(task) ?? turnsOf(session, task)[0]?.prompt.text ?? '' }
    },
    [conversationMethods.updateGoal](request) {
      const session = sessionOf(String(request['session']))
      const task = typeof request['task'] === 'string' ? request['task'] : undefined
      const text = String(request['text'])
      if (task === undefined) record(session, session.conversation.changeGoal(text))
      else {
        goals.set(task, text)
        record(session, [{ type: GoalChange, goal: { text, task } }])
      }
      return null
    },
    [conversationMethods.watchBefore](request, caller) {
      const targets = watches.get(caller) ?? new Map<string, readonly string[]>()
      targets.set(String(request['session']), (Array.isArray(request['subscriptions']) ? (request['subscriptions'] as readonly Subscription[]) : []).map(({ event }) => event))
      watches.set(caller, targets)
      return null
    },
    async [conversationMethods.act](request) {
      const session = sessionOf(String(request['session']))
      const action = String(request['action'])
      const input = isObject(request['input']) ? request['input'] : {}
      const task = typeof request['task'] === 'string' ? request['task'] : undefined
      const isLive = task === undefined ? session.data.isRunning : session.data.isRunning && taskOf(session, task).closedAt === undefined
      if (action === 'usage') return { model: task === undefined ? session.data.model : (taskOf(session, task).model ?? session.data.model), context: {} }
      if (action === 'clients') return isLive ? ['terminal'] : []
      if (!isLive) throw new Error(`session ${task ?? session.data.id} has ended`)
      if (action === 'abort') return null
      if (action === 'send') {
        sent.push({ session: session.data.id, ...(task === undefined ? {} : { task }), type: String(input['type']), text: String(input['text']), ...(typeof input['as'] === 'string' ? { as: input['as'] } : {}) })
        return null
      }
      if (action === 'startTask') {
        const id = `task-${(ids += 1)}`
        const data: TaskData = { id, title: typeof input['name'] === 'string' ? input['name'] : '', agentType: typeof input['agentType'] === 'string' ? input['agentType'] : 'general-purpose', openedBy: '', openedAt: now(), ...(typeof input['model'] === 'string' ? { model: input['model'] } : {}) }
        record(session, session.conversation.startTask(data))
        return data
      }
      if (session.data.id === current) return resultOf(place(), { name: String(input['name']), input: input['input'] as Readonly<Record<string, unknown>>, cwd: project() }, await callTool({ ...input['input'] as object, tool: String(input['name']) } as never))
      return { id: '', type: ToolResult, at: now(), session: session.data.id, context: session.conversation.state.context, callId: '', name: '', input: {}, cwd: project(), files: noFiles, output: '', isError: false }
    },
    [conversationMethods.subscribe](request, caller) {
      const list = Array.isArray(request['subscriptions']) ? (request['subscriptions'] as readonly Subscription[]) : []
      const sessions = heard.get(caller) ?? new Map<string, readonly Heard[]>()
      sessions.set(String(request['session']), list.map(({ event, matcher }) => ({ event, matcher: matcher === undefined ? undefined : receivedMatcher(matcher) })))
      heard.set(caller, sessions)
      return null
    },
  }

  return {
    answer(caller, method, input) {
      const run = methods[method]
      if (run === undefined) return undefined
      try {
        return { value: run(isObject(input) ? input : {}, caller) }
      } catch (error) {
        return { deny: messageOf(error) }
      }
    },
    add: (draft, task) => add(currentSession(), draft, task),
    place,
    wants: (mod, event) => [current, everySession].some((target) => (watches.get(mod)?.get(target) ?? []).includes(event)),
    endTurn(ending = {}) {
      const session = currentSession()
      record(session, session.conversation.endTurn(now(), { reason: 'answer', ...ending }))
    },
    compact() {
      const session = currentSession()
      record(session, session.conversation.add({ id: `compact-${(ids += 1)}`, at: now(), type: 'system', name: 'compact_boundary', isMeta: false, isSummary: false, content: [] }))
    },
    startTask({ title, agentType = 'general-purpose', model, openedBy = '', parent }) {
      const session = currentSession()
      const id = `task-${(ids += 1)}`
      record(session, session.conversation.startTask({ id, title, agentType, openedBy, openedAt: now(), ...(model === undefined ? {} : { model }), ...(parent === undefined ? {} : { parent }) }))
      return id
    },
    start(id) {
      current = id
      const session = kept.get(id) ?? keep({ id, title: '', project: project(), cwd: project(), model: 'test-model', startedAt: now(), lastAt: now(), isRunning: true })
      session.data = { ...session.data, isRunning: true }
      if (session.conversation.state.context === 0) record(session, session.conversation.startContext(now()))
    },
    sent,
  }
}

function rowOf(draft: MessageDraft, id: string, at: string): Row {
  const base = { id, at, isMeta: false, isSummary: false }
  const text = (value: string) => [{ type: 'text', text: value }]
  const origin = (from: Sender | undefined) => (from === undefined || from.type === Person ? { kind: 'human' } : from.type === Mod ? { kind: 'plugin', name: from.name, ...(from.as === Person ? { asUser: true } : {}) } : from.type === 'session' ? { kind: 'peer' } : from.type === Task ? { kind: 'task-notification' } : { kind: from.type === Schedule ? 'scheduled-trigger' : from.type, ...(from.name === undefined ? {} : { server: from.name }) })
  if (draft.type === Prompt) return { ...base, type: 'user', content: text(draft.text), origin: origin(draft.from) }
  if (draft.type === Note) return { ...base, type: 'user', isMeta: true, content: text(draft.text), origin: origin(draft.from ?? { type: Mod, name: 'test' }) }
  if (draft.type === Reply) return { ...base, type: 'assistant', content: text(draft.text) }
  if (draft.type === ToolCall) return { ...base, type: 'assistant', content: [{ type: 'tool_use', id: draft.callId ?? `toolu_${id}`, name: draft.name, input: draft.input ?? {} }], cwd: '/test/project' }
  if (draft.type === ToolResult) return { ...base, type: 'user', content: [{ type: 'tool_result', tool_use_id: draft.callId, content: draft.output, ...(draft.isError === true ? { is_error: true } : {}) }] }
  if (draft.type === Skill) return { ...base, type: 'user', isMeta: true, content: text(`${skillPrefix} /skills/${draft.name}\n\n${draft.text}`) }
  if (draft.type === Document) return { ...base, type: 'attachment', name: 'nested_memory', content: text(draft.text), path: draft.path }
  return { ...base, type: 'system', name: 'informational', content: text(draft.text) }
}
