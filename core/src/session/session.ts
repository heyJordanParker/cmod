import type { Disposable } from '../mod.js'
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

export type SessionEvent = typeof Message | MessageType | typeof ContextStart | typeof ContextEnd | typeof TurnStart | typeof TurnEnd | typeof TaskStart | typeof TaskEnd | typeof GoalChange

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
}

export type Usage = {
  readonly model: string
  readonly context: { readonly tokens?: number; readonly window: number; readonly percent?: number }
  readonly cost?: { readonly usd: number }
}

export type Listener<Event extends SessionEvent> = (payload: SessionPayload[Event]) => unknown

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

export type Session = {
  readonly id: string
  readonly title: string
  readonly project: string
  readonly cwd: string
  readonly model: string
  readonly startedAt: string
  readonly lastAt: string
  readonly forkedFrom?: string
  readonly isRunning: boolean
  usage(): Promise<Usage>
  on<Event extends SessionEvent>(event: Event, listener: Listener<Event>): Disposable
  on<Event extends SessionEvent>(event: Event, matcher: Matcher<SessionPayload[Event]>, listener: Listener<Event>): Disposable
  send(message: SessionSend): Promise<void>
  startTask(task: TaskStartArgs): Promise<Task>
  messages(options?: { readonly after?: string; readonly last?: number }): Promise<Message[]>
  turns(options?: { readonly last?: number }): Promise<Turn[]>
  contexts(): Promise<Context[]>
  goal(): Promise<Goal>
}

export type SessionScope = {
  readonly running?: boolean
  readonly since?: string
  readonly everyProject?: boolean
}

export type Sessions = {
  readonly current: Session
  list(options?: SessionScope): Promise<Session[]>
  search(text: string, options?: SessionScope & { readonly limit?: number; readonly before?: Pick<Message, 'session' | 'id'> }): Promise<Message[]>
}
