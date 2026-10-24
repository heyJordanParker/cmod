import type { Subscription } from '../utils/subscription.js'
import type { Matcher } from '../utils/matcher.js'
import type { Sender } from './context/turn/message/sender.js'
import type { Context, ContextEnd, ContextStart } from './context/context.js'
import type { AttachedFile } from './context/turn/message/attached-file.js'
import type { InstructionFile } from './context/turn/message/instruction-file.js'
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
  readonly instructionFile: InstructionFile
  readonly attachedFile: AttachedFile
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
  readonly prompt: { readonly text?: string; readonly note?: string; readonly title?: string } | Refusal
  readonly note: { readonly text: string }
  readonly skill: { readonly text: string }
  readonly instructionFile: { readonly text: string } | Refusal
  readonly attachedFile: { readonly text: string } | Refusal
  readonly reply: { readonly text: string }
  readonly toolCall: { readonly input?: Readonly<Record<string, unknown>>; readonly note?: string } | { readonly result: string; readonly note?: string } | Refusal
  readonly toolResult: { readonly output?: unknown; readonly isError?: true; readonly note?: string }
  readonly notice: { readonly text: string }
  readonly taskStart: { readonly prompt?: string; readonly title?: string; readonly owner?: { readonly agentType?: string; readonly model?: string; readonly cwd?: string }; readonly isAsync?: boolean } | Refusal
  readonly turnEnd: { readonly note: string } | Refusal
  readonly contextEnd: Refusal
}

export type BeforeEvent = keyof BeforeAnswer

export type Usage = {
  readonly model: string
  readonly contextWindow: { readonly tokenCount?: number; readonly size?: number; readonly percent?: number }
  readonly rateLimits?: readonly RateLimit[]
  readonly cost?: { readonly usd: number }
}

export type RateLimit = { readonly type: string; readonly percent: number; readonly resetsAt?: string }

export type Surface = 'terminal' | 'desktop' | 'mobile' | 'vscode'

export const sessionEvents = {
  Message: 'message',
  Prompt: 'prompt',
  Note: 'note',
  Reply: 'reply',
  ToolCall: 'toolCall',
  ToolResult: 'toolResult',
  Skill: 'skill',
  InstructionFile: 'instructionFile',
  AttachedFile: 'attachedFile',
  Notice: 'notice',
  ContextStart: 'contextStart',
  ContextEnd: 'contextEnd',
  TurnStart: 'turnStart',
  TurnEnd: 'turnEnd',
  TaskStart: 'taskStart',
  TaskEnd: 'taskEnd',
  GoalChange: 'goalChange',
  UsageChange: 'usageChange',
} as const satisfies Readonly<Record<string, SessionEvent>>

export const beforeEvents = ['Prompt', 'Note', 'Skill', 'InstructionFile', 'AttachedFile', 'Reply', 'ToolCall', 'ToolResult', 'Notice', 'TaskStart', 'TurnEnd', 'ContextEnd'] as const satisfies readonly (keyof typeof sessionEvents)[]

export type EventName = keyof typeof sessionEvents

export type BeforeName = (typeof beforeEvents)[number]

export type PayloadOf<Name extends EventName> = SessionPayload[(typeof sessionEvents)[Name]]

export type AnswerOf<Name extends BeforeName> = (typeof sessionEvents)[Name] extends BeforeEvent ? BeforeAnswer[(typeof sessionEvents)[Name]] : never

export type ReadOptions = { readonly timeoutMs?: number }

export type AnswerOptions = ReadOptions & { readonly onFailure?: 'pass' | 'refuse' }

export type ListenerTime = { readonly deadline: number; readonly signal: AbortSignal }

export type Listener<Payload, Answer = void> = (payload: Payload, time: ListenerTime) => Answer | void | Promise<Answer | void>

export type OnMethod<Payload> = {
  (listener: Listener<Payload, unknown>, options?: ReadOptions): Subscription
  (matcher: Matcher<Payload>, listener: Listener<Payload, unknown>, options?: ReadOptions): Subscription
}

export type BeforeMethod<Payload, Answer> = {
  (listener: Listener<Payload, Answer>, options?: AnswerOptions): Subscription
  (matcher: Matcher<Payload>, listener: Listener<Payload, Answer>, options?: AnswerOptions): Subscription
}

export type OnMethods = { readonly [Name in EventName as `on${Name}`]: OnMethod<PayloadOf<Name>> }

export type BeforeMethods = { readonly [Name in BeforeName as `before${Name}`]: BeforeMethod<PayloadOf<Name>, AnswerOf<Name>> }

export type RecordPart = OnMethods &
  BeforeMethods & {
    search(text: string, matcher?: Matcher<Message>): AsyncIterable<Message>
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
  readonly title: string
  readonly name?: string
  readonly cwd?: string
  readonly isBackground?: boolean
}

export type ToolCallArgs = {
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
}

export type Session = RecordPart & {
  readonly id: string
  readonly title: string
  readonly color?: string
  readonly project: string
  readonly agentType?: string
  readonly model: string
  readonly cwd: string
  readonly isRunning: boolean
  readonly startedAt: string
  readonly lastAt: string
  readonly forkedFrom?: string
  readonly goal: Goal
  context(): Promise<Context>
  contexts(): Promise<Context[]>
  turn(): Promise<Turn | undefined>
  turns(options?: { readonly last?: number }): Promise<Turn[]>
  messages(options?: { readonly after?: string; readonly last?: number }): Promise<Message[]>
  send(message: SessionSend): Promise<void>
  startTask(task: TaskStartArgs): Promise<Task>
  fork(task: Pick<TaskStartArgs, 'prompt' | 'title'>): Promise<Task>
  clone(task: Pick<TaskStartArgs, 'prompt' | 'title'>): Promise<Task>
  callTool(call: ToolCallArgs): Promise<ToolResult>
  usage(): Promise<Usage>
  surfaces(): Promise<Surface[]>
}

export type TaskOwner = Omit<Session, 'startTask' | 'callTool' | 'fork' | 'clone'>

type ProcessEvent = { readonly on: string; readonly before?: string }

export const processEvents = {
  ProjectSetup: { on: 'Setup', before: 'Setup' },
  SessionStart: { on: 'SessionStart', before: 'SessionStart' },
  SessionEnd: { on: 'SessionEnd' },
  ModelChange: { on: 'PostModelSwitch', before: 'PreModelSwitch' },
  CwdChange: { on: 'CwdChanged' },
  DirectoryAdd: { on: 'DirectoryAdded' },
  WorktreeCreate: { on: 'WorktreeCreate', before: 'WorktreeCreate' },
  WorktreeRemove: { on: 'WorktreeRemove' },
  Notification: { on: 'Notification' },
  Elicitation: { on: 'Elicitation', before: 'Elicitation' },
  ElicitationResponse: { on: 'ElicitationResult', before: 'ElicitationResult' },
  PermissionCheck: { on: 'tool.check', before: 'tool.check' },
  PermissionRequest: { on: 'PermissionRequest', before: 'PermissionRequest' },
  PermissionDenial: { on: 'PermissionDenied', before: 'PermissionDenied' },
  ToolBatch: { on: 'PostToolBatch', before: 'PostToolBatch' },
  TodoCreate: { on: 'TaskCreated', before: 'TaskCreated' },
  TodoComplete: { on: 'TaskCompleted', before: 'TaskCompleted' },
  ReplyDisplay: { on: 'MessageDisplay', before: 'MessageDisplay' },
} as const satisfies Readonly<Record<string, ProcessEvent>>

export type Placement = {
  readonly session: string
  readonly task?: string
  readonly agentType?: string
  readonly cwd: string
  readonly permissionMode?: string
}

export type SessionStartAsked = Placement & {
  readonly source: 'startup' | 'resume' | 'clear' | 'fork' | 'compact'
  readonly model?: string
  readonly title?: string
  readonly idleSeconds?: number
  readonly contextTokenCount?: number
  readonly isCacheWarm?: boolean
  readonly cacheWriteUsd?: number
}

export type SessionStarted = Omit<SessionStartAsked, 'source'> & { readonly source: 'startup' | 'resume' | 'clear' | 'fork' }

export type ProjectSetup = Placement & { readonly trigger: 'init' | 'maintenance' }

export type SessionEnded = Placement & { readonly reason: 'clear' | 'resume' | 'logout' | 'exit' | 'other' }

export type ModelChange = Placement & {
  readonly model: string
  readonly previous: string
  readonly requested?: string
  readonly source: 'command' | 'picker' | 'sdk' | 'auto' | 'resume'
  readonly contextTokenCount: number
  readonly isCacheWarm: boolean
  readonly cacheTtl: '5m' | '1h'
  readonly cacheWriteUsd: number
  readonly pricing?: 'configured' | 'catalog' | 'default'
}

export type CwdChange = Placement & { readonly previous: string }

export type DirectoryAdd = Placement & { readonly directory: string; readonly source: 'command' | 'sdk' }

export type Worktree = Placement & { readonly name?: string; readonly path?: string }

export type Notification = Placement & { readonly text: string; readonly title?: string; readonly type: string }

export type Elicitation = Placement & { readonly id?: string; readonly server: string; readonly text: string; readonly mode?: 'form' | 'url'; readonly url?: string; readonly schema?: Readonly<Record<string, unknown>> }

export type ElicitationResponse = Placement & { readonly id?: string; readonly server: string; readonly mode?: 'form' | 'url'; readonly action: 'accept' | 'decline' | 'cancel'; readonly content?: Readonly<Record<string, unknown>> }

export type McpServer = { readonly name: string; readonly source: string }

type PermissionRules = { readonly rules: readonly { readonly toolName: string; readonly ruleContent?: string }[]; readonly behavior: 'allow' | 'deny' | 'ask' }

type PermissionDestination = { readonly destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg' }

export type PermissionUpdate = PermissionDestination &
  (
    | (PermissionRules & { readonly type: 'addRules' | 'replaceRules' | 'removeRules' })
    | { readonly type: 'setMode'; readonly mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto' }
    | { readonly type: 'addDirectories' | 'removeDirectories'; readonly directories: readonly string[] }
  )

export type PermissionCheck = Placement & {
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  readonly callId?: string
  readonly decision: 'allow' | 'ask' | 'refuse'
  readonly reason?: string
  readonly rule?: string
  readonly ceiling?: 'allow' | 'ask' | 'refuse'
}

export type PermissionRequest = Placement & { readonly name: string; readonly input: Readonly<Record<string, unknown>>; readonly suggestions: readonly PermissionUpdate[]; readonly mcpServer?: McpServer }

export type PermissionDenial = Placement & { readonly name: string; readonly input: Readonly<Record<string, unknown>>; readonly callId: string; readonly reason: string; readonly mcpServer?: McpServer }

export type BatchedCall = { readonly callId: string; readonly name: string; readonly input: Readonly<Record<string, unknown>>; readonly output?: unknown }

export type ToolBatch = Placement & { readonly calls: readonly BatchedCall[] }

export type Todo = Placement & { readonly id: string; readonly subject: string; readonly description?: string; readonly teammate?: string }

export type ReplyDisplay = Placement & { readonly replyId: string; readonly index: number; readonly isLast: boolean; readonly text: string }

export type CommandRun = Placement & { readonly name: string; readonly args: string; readonly source?: 'builtin' | 'plugin' | 'user' | 'mcp'; readonly from: Sender }

export type CommandRunAnswer = { readonly args?: string; readonly note?: string } | { readonly result: string; readonly exitCode?: number } | Refusal

export type ProcessPayload = {
  readonly ProjectSetup: ProjectSetup
  readonly SessionStart: SessionStarted
  readonly SessionEnd: SessionEnded
  readonly ModelChange: ModelChange
  readonly CwdChange: CwdChange
  readonly DirectoryAdd: DirectoryAdd
  readonly WorktreeCreate: Worktree
  readonly WorktreeRemove: Worktree
  readonly Notification: Notification
  readonly Elicitation: Elicitation
  readonly ElicitationResponse: ElicitationResponse
  readonly PermissionCheck: PermissionCheck
  readonly PermissionRequest: PermissionRequest
  readonly PermissionDenial: PermissionDenial
  readonly ToolBatch: ToolBatch
  readonly TodoCreate: Todo
  readonly TodoComplete: Todo
  readonly ReplyDisplay: ReplyDisplay
}

export type ProcessAsked = Omit<ProcessPayload, 'SessionStart'> & { readonly SessionStart: SessionStartAsked }

export type ProcessAnswer = {
  readonly ProjectSetup: { readonly note: string }
  readonly SessionStart: { readonly note?: string; readonly title?: string; readonly reloadSkills?: true; readonly firstPrompt?: string }
  readonly ModelChange: { readonly ask: string } | { readonly note: string } | Refusal
  readonly WorktreeCreate: { readonly result: string }
  readonly Elicitation: Refusal
  readonly ElicitationResponse: Refusal
  readonly PermissionCheck: { readonly allow: true } | { readonly ask: string } | Refusal
  readonly PermissionRequest: { readonly allow: true; readonly input?: Readonly<Record<string, unknown>>; readonly updates?: readonly PermissionUpdate[] } | (Refusal & { readonly interrupt?: true })
  readonly PermissionDenial: { readonly retry: true }
  readonly ToolBatch: { readonly note: string }
  readonly TodoCreate: Refusal
  readonly TodoComplete: Refusal
  readonly ReplyDisplay: { readonly text: string }
}

export type ProcessName = keyof typeof processEvents

export type ProcessOnMethods = { readonly [Name in ProcessName as `on${Name}`]: OnMethod<ProcessPayload[Name]> }

export type ProcessBeforeMethods = { readonly [Name in keyof ProcessAnswer as `before${Name}`]: BeforeMethod<ProcessAsked[Name], ProcessAnswer[Name]> }

export type CurrentSession = Omit<Session, 'goal'> & ProcessOnMethods & ProcessBeforeMethods & {
  readonly goal: Goal & Pick<ProcessBeforeMethods, 'beforeSessionStart'>
  scrollTo(message: Message, options?: { readonly block?: 'start' | 'center' | 'end' | 'nearest' }): Promise<void>
  caption(toolCall: Message & { readonly type: typeof ToolCall }, text: string | undefined): void
}

export type SessionScope = {
  readonly running?: boolean
  readonly since?: string
  readonly everyProject?: boolean
}

export type SearchOptions = SessionScope & { readonly before?: Pick<Message, 'session' | 'id'> }

export type Sessions = OnMethods & {
  readonly current: CurrentSession
  list(options?: SessionScope): Promise<Session[]>
  search(text: string, matcher?: Matcher<Message>, options?: SearchOptions): AsyncIterable<Message>
}
