import type { Disposable } from '../utils/disposable.js'
import type { Matcher } from '../utils/matcher.js'
import type { Context, ContextEnd, ContextStart } from './context/context.js'
import type { Document } from './context/turn/message/document.js'
import type { Message, MessageType } from './context/turn/message/message.js'
import type { Note } from './context/turn/message/note.js'
import type { Notice } from './context/turn/message/notice.js'
import type { Prompt } from './context/turn/message/prompt.js'
import type { Reply } from './context/turn/message/reply.js'
import type { Person } from './context/turn/message/sender.js'
import type { Skill } from './context/turn/message/skill.js'
import type { ToolCall } from './context/turn/message/tool-call.js'
import type { ToolResult } from './context/turn/message/tool-result.js'
import type { Turn, TurnEnd, TurnStart } from './context/turn/turn.js'
import type { Goal, GoalChange } from './goal/goal.js'
import type { Task, TaskEnd, TaskStart } from './goal/task.js'

export const Session = 'session'

export const UsageChange = 'usageChange'

export type SessionEvent = typeof Message | MessageType | typeof ContextStart | typeof ContextEnd | typeof TurnStart | typeof TurnEnd | typeof TaskStart | typeof TaskEnd | typeof GoalChange | typeof UsageChange

export type SessionPayload = {
  readonly message: Message
  readonly prompt: Prompt
  readonly note: Note
  readonly reply: Reply
  readonly toolCall: ToolCall
  readonly toolResult: ToolResult
  readonly skill: Skill
  readonly document: Document
  readonly notice: Notice
  readonly contextStart: Context
  readonly contextEnd: Context
  readonly turnStart: Turn
  readonly turnEnd: Turn
  readonly taskStart: Task
  readonly taskEnd: Task
  readonly goalChange: Goal
  readonly usageChange: Usage
}

export type Refusal = { readonly refuse: string }

export type BeforeAnswer = {
  readonly prompt: { readonly text: string } | Refusal
  readonly note: { readonly text: string }
  readonly skill: { readonly text: string }
  readonly document: { readonly text: string } | Refusal
  readonly reply: { readonly text: string }
  readonly toolCall: { readonly input: Readonly<Record<string, unknown>> } | { readonly result: string } | Refusal
  readonly toolResult: { readonly text: string }
  readonly notice: { readonly text: string }
  readonly taskStart: { readonly owner: { readonly model: string } } | Refusal
  readonly taskEnd: Refusal
  readonly turnEnd: Refusal
  readonly contextEnd: Refusal
}

export type BeforeEvent = keyof BeforeAnswer

export type Usage = {
  readonly model: string
  readonly context: { readonly tokens?: number; readonly window?: number; readonly percent?: number }
  readonly cost?: { readonly usd: number }
}

export type Client = 'terminal' | 'desktop' | 'mobile' | 'vscode'

export type Listener<Event extends SessionEvent> = (payload: SessionPayload[Event]) => unknown

export type BeforeListener<Event extends BeforeEvent> = (payload: SessionPayload[Event]) => BeforeAnswer[Event] | void | Promise<BeforeAnswer[Event] | void>

export type SearchOptions = {
  readonly limit?: number
  readonly before?: Pick<Message, 'session' | 'id'>
}

export type RecordPart = {
  search(text: string, options?: SearchOptions): Promise<Message[]>
  on<Event extends SessionEvent>(event: Event, listener: Listener<Event>): Disposable
  on<Event extends SessionEvent>(event: Event, matcher: Matcher<SessionPayload[Event]>, listener: Listener<Event>): Disposable
  before<Event extends BeforeEvent>(event: Event, listener: BeforeListener<Event>): Disposable
  before<Event extends BeforeEvent>(event: Event, matcher: Matcher<SessionPayload[Event]>, listener: BeforeListener<Event>): Disposable
}

export type SessionSend = {
  readonly type: typeof Prompt | typeof Note
  readonly text: string
  readonly as?: typeof Person | typeof Session
}

export type TaskStartArgs = {
  readonly prompt: string
  readonly agentType?: string
  readonly model?: string
  readonly name?: string
  readonly cwd?: string
}

export type ToolCallArgs = {
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
}

export type Session = RecordPart & {
  readonly id: string
  readonly title: string
  readonly project: string
  readonly agentType?: string
  readonly model: string
  readonly cwd: string
  readonly isRunning: boolean
  readonly startedAt: string
  readonly lastAt: string
  readonly forkedFrom?: string
  goal(): Promise<Goal>
  context(): Promise<Context>
  contexts(): Promise<Context[]>
  turn(): Promise<Turn | undefined>
  turns(options?: { readonly last?: number }): Promise<Turn[]>
  messages(options?: { readonly after?: string; readonly last?: number }): Promise<Message[]>
  send(message: SessionSend): Promise<void>
  startTask(task: TaskStartArgs): Promise<Task>
  callTool(call: ToolCallArgs): Promise<ToolResult>
  usage(): Promise<Usage>
  clients(): Promise<Client[]>
}

export type SessionScope = {
  readonly running?: boolean
  readonly since?: string
  readonly everyProject?: boolean
}

export type Sessions = Omit<RecordPart, 'search'> & {
  readonly current: Session
  list(options?: SessionScope): Promise<Session[]>
  search(text: string, options?: SessionScope & SearchOptions): Promise<Message[]>
}
