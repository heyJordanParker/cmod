import { isObject } from '../records.js'
import { Document } from '../session/context/turn/message/document.js'
import { Message, searchText, skillPrefix, type Row } from '../session/context/turn/message/message.js'
import { Note } from '../session/context/turn/message/note.js'
import { Notice } from '../session/context/turn/message/notice.js'
import { Prompt } from '../session/context/turn/message/prompt.js'
import { Reply } from '../session/context/turn/message/reply.js'
import { Mod, Person, Schedule, type Sender } from '../session/context/turn/message/sender.js'
import { Task } from '../session/goal/task.js'
import { Skill } from '../session/context/turn/message/skill.js'
import { ToolCall } from '../session/context/turn/message/tool-call.js'
import { ToolResult } from '../session/context/turn/message/tool-result.js'
import { createConversation, emptyConversation, searchLimit, type ContextData, type Conversation, type SessionChange, type SessionData, type TaskData, type TurnData } from '../session/conversation.js'
import { conversationMethods, isHeardBy, type Subscription } from '../runtime/sessions.js'
import { receivedMatcher } from '../utils/matcher.js'
import { firstLine, messageOf } from '../utils/text.js'

export type MessageDraft =
  | { readonly type: typeof Prompt; readonly text: string; readonly from?: Sender }
  | { readonly type: typeof Note; readonly text: string; readonly from?: Sender }
  | { readonly type: typeof Reply; readonly text: string }
  | { readonly type: typeof ToolCall; readonly name: string; readonly input?: Readonly<Record<string, unknown>>; readonly callId?: string }
  | { readonly type: typeof ToolResult; readonly callId: string; readonly text: string; readonly isError?: boolean }
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
  endTurn(): void
  compact(): void
  startTask(task: { readonly title: string; readonly agentType?: string; readonly model?: string; readonly openedBy?: string }): string
  start(id: string): void
  readonly sent: { readonly session: string; readonly type: string; readonly text: string; readonly as?: string }[]
}

export function fakeSessions({ project, given, push }: { readonly project: () => string; readonly given: readonly FakeSession[]; readonly push: (mod: string, session: string, change: SessionChange) => void }): FakeSessions {
  const kept = new Map<string, Kept>()
  const heard = new Map<string, Map<string, readonly Heard[]>>()
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
        if ((sessions.get(session.data.id) ?? []).some(({ event, matcher }) => isHeardBy(event, matcher, change))) push(mod, session.data.id, change)
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
      const found = [...kept.values()]
        .filter((session) => isInScope(session, request))
        .flatMap((session) => session.messages)
        .filter((message) => searchText(message).toLowerCase().includes(text.toLowerCase()))
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
    [conversationMethods.turns]: (request) => lastOf([...sessionOf(String(request['session'])).turns.values()].filter((turn) => request['context'] === undefined || turn.context === request['context']), request['last']),
    [conversationMethods.contexts]: (request) => [...sessionOf(String(request['session'])).contexts.values()],
    [conversationMethods.tasks]: (request) => [...sessionOf(String(request['session'])).tasks.values()].filter((task) => task.parent === request['task']),
    [conversationMethods.goal]: (request) => ({ text: sessionOf(String(request['session'])).conversation.state.goal ?? '' }),
    [conversationMethods.updateGoal](request) {
      const session = sessionOf(String(request['session']))
      record(session, session.conversation.changeGoal(String(request['text'])))
      return null
    },
    [conversationMethods.subscribe](request, caller) {
      const list = Array.isArray(request['subscriptions']) ? (request['subscriptions'] as readonly Subscription[]) : []
      const sessions = heard.get(caller) ?? new Map<string, readonly Heard[]>()
      sessions.set(String(request['session']), list.map(({ event, matcher }) => ({ event, matcher: matcher === undefined ? undefined : receivedMatcher(matcher) })))
      heard.set(caller, sessions)
      return null
    },
    [conversationMethods.send](request) {
      sent.push({ session: String(request['session']), type: String(request['type']), text: String(request['text']), ...(typeof request['as'] === 'string' ? { as: request['as'] } : {}) })
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
    endTurn() {
      const session = currentSession()
      record(session, session.conversation.add({ id: `turn-end-${(ids += 1)}`, at: now(), type: 'system', name: 'turn_duration', isMeta: false, isSummary: false, content: [] }))
    },
    compact() {
      const session = currentSession()
      const at = now()
      record(session, [...session.conversation.endContext(at), ...session.conversation.startContext(at)])
    },
    startTask({ title, agentType = 'general-purpose', model, openedBy = '' }) {
      const session = currentSession()
      const id = `task-${(ids += 1)}`
      record(session, session.conversation.startTask({ id, title, agentType, openedBy, openedAt: now(), ...(model === undefined ? {} : { model }) }))
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
  if (draft.type === ToolResult) return { ...base, type: 'user', content: [{ type: 'tool_result', tool_use_id: draft.callId, content: draft.text, ...(draft.isError === true ? { is_error: true } : {}) }] }
  if (draft.type === Skill) return { ...base, type: 'user', isMeta: true, content: text(`${skillPrefix} /skills/${draft.name}\n\n${draft.text}`) }
  if (draft.type === Document) return { ...base, type: 'attachment', name: 'nested_memory', content: text(draft.text), path: draft.path }
  return { ...base, type: 'system', name: 'informational', content: text(draft.text) }
}
