import type {
  AskOptions,
  ClassicHookInputs,
  CmodDependencies,
  FsStatOptions,
  HookStream,
  HttpInit,
  HttpResponse,
  ModelCompleteOptions,
  ModelCompleteRequest,
  ModelCompleteResult,
  PaneOpenArgs,
  PermissionRequestDecision,
  ProcessRunInit,
  ProcessRunResult,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
  RenderElement,
  Settings,
  UiScrollArgs,
  UiScrollResult,
} from 'claude-code'
import type { Step } from './installer.js'
import { checkOptions, type Option, type Options, type OptionValues } from './options.js'
import { bound } from './runtime/bound.js'
import { Mod as modSender } from './session/context/turn/message/sender.js'
import type { Sessions } from './session/session.js'
import type { Pane } from './ui/define-pane.js'
import type { Place, PlaceProps } from './ui/places.js'
import type { Matcher } from './utils/matcher.js'

export type Disposable = {
  dispose(): void
}

export type ToastId = string | number

export type ToastType = 'default' | 'success' | 'info' | 'warning' | 'error' | 'loading'

export type ToastOptions = {
  readonly id?: ToastId
  readonly description?: string | RenderElement
  readonly action?: { readonly label: string; readonly onClick: () => unknown }
  readonly duration?: number
}

type ToastMessage<Value> = string | ((value: Value) => string)

export type Toast = {
  (message: string, options?: ToastOptions): ToastId
  success(message: string, options?: ToastOptions): ToastId
  info(message: string, options?: ToastOptions): ToastId
  warning(message: string, options?: ToastOptions): ToastId
  error(message: string, options?: ToastOptions): ToastId
  loading(message: string, options?: ToastOptions): ToastId
  promise<T>(task: Promise<T> | (() => Promise<T>), messages: { readonly loading: string; readonly success: ToastMessage<T>; readonly error: ToastMessage<unknown> }): { unwrap(): Promise<T> }
  dismiss(id?: ToastId): void
}

export type PaneHandle = {
  open(options?: Readonly<Pick<PaneOpenArgs, 'focus'>>): Promise<void>
  close(): Promise<void>
  toggle(options?: Readonly<Pick<PaneOpenArgs, 'focus'>>): Promise<void>
  readonly isOpen: boolean
}

export const SessionStart = 'SessionStart'
export const SessionEnd = 'SessionEnd'
export const UserPromptSubmit = 'UserPromptSubmit'
export const InstructionsLoaded = 'InstructionsLoaded'
export const PreToolUse = 'PreToolUse'
export const PermissionRequest = 'PermissionRequest'
export const PermissionDenied = 'PermissionDenied'
export const PostToolUse = 'PostToolUse'
export const PostToolUseFailure = 'PostToolUseFailure'
export const PostToolBatch = 'PostToolBatch'
export const SubagentStart = 'SubagentStart'
export const SubagentStop = 'SubagentStop'
export const Notification = 'Notification'
export const PreCompact = 'PreCompact'
export const Stop = 'Stop'
export const StopFailure = 'StopFailure'
export const CwdChanged = 'CwdChanged'
export const FileChanged = 'FileChanged'

export const hooks = [
  SessionStart,
  SessionEnd,
  UserPromptSubmit,
  InstructionsLoaded,
  PreToolUse,
  PermissionRequest,
  PermissionDenied,
  PostToolUse,
  PostToolUseFailure,
  PostToolBatch,
  SubagentStart,
  SubagentStop,
  Notification,
  PreCompact,
  Stop,
  StopFailure,
  CwdChanged,
  FileChanged,
] as const

export type Hook = (typeof hooks)[number]

export type HookAnswer = {
  continue?: boolean
  stopReason?: string
  suppressOutput?: boolean
  systemMessage?: string
  decision?: 'block'
  reason?: string
  hookSpecificOutput?: {
    hookEventName?: Hook
    additionalContext?: string
    permissionDecision?: 'allow' | 'deny' | 'ask'
    permissionDecisionReason?: string
    updatedInput?: Record<string, unknown>
    sessionTitle?: string
    suppressOriginalPrompt?: boolean
    initialUserMessage?: string
    watchPaths?: string[]
    reloadSkills?: boolean
    decision?: PermissionRequestDecision
    updatedToolOutput?: unknown
    updatedMCPToolOutput?: unknown
    retry?: boolean
  }
}

type CallFiles = { read: string[]; changed: string[] }

type HookInputs = Omit<ClassicHookInputs, 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'CwdChanged'> & {
  PreToolUse: {
    session_id: string
    cwd: string
    hook_event_name: 'PreToolUse'
    tool_name: string
    tool_input: Record<string, unknown>
    tool_use_id: string
    agent_id?: string
    agent_type?: string
    files: CallFiles
  }
  PostToolUse: ClassicHookInputs['PostToolUse'] & { files: CallFiles }
  PostToolUseFailure: ClassicHookInputs['PostToolUseFailure'] & { files: CallFiles }
  CwdChanged: Omit<ClassicHookInputs['CwdChanged'], 'transcript_path'>
}

export type HookInput<H extends Hook> = HookInputs[H]

export type HookListener<H extends Hook> = (input: HookInput<H>) => HookAnswer | void | Promise<HookAnswer | void>

export type HookOptions = {
  readonly timeoutMs?: number
}

export type Metadata = Readonly<Record<string, string>>

export type FileMatch = {
  readonly path: string
  readonly name?: string
  readonly metadata: Metadata
  readonly error?: string
}

export type Entry = {
  readonly name: string
  readonly isFile: boolean
  readonly isFolder: boolean
  readonly isLink: boolean
  readonly size: number
  readonly modifiedAt: number
}

export type Stat = Omit<Entry, 'name'> & {
  readonly realPath?: string
}

export type Allowed = {
  allows(value: string): boolean
}

export type Permissions = {
  readonly conversation: boolean
  readonly prompt: boolean
  readonly model: boolean
  readonly tasks: boolean
  readonly tools: boolean
  readonly approve: boolean
  readonly network: Allowed
  readonly run: Allowed
  readonly files: Allowed
  readonly config: Allowed
}

export type SettingsFile = {
  read(): Promise<Settings>
  update(values: Readonly<Record<string, unknown>>): Promise<void>
}

export type Imports = {
  readonly sessions: Sessions
  readonly settings: { readonly user: SettingsFile; readonly project: SettingsFile; readonly local: SettingsFile }
  readonly model: { complete(request: ModelCompleteRequest, options?: ModelCompleteOptions): Promise<ModelCompleteResult> }
  readonly fs: {
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
    exists(path: string): Promise<boolean>
    find(glob: string | readonly string[]): Promise<readonly FileMatch[]>
    list(path?: string): Promise<Entry[]>
    stat(path: string, options?: FsStatOptions): Promise<Stat>
  }
  readonly metadata: {
    read(path: string): Promise<Metadata>
    update(path: string, change: (metadata: Record<string, string>) => void): Promise<void>
  }
  readonly process: {
    run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult>
    spawn(argv: readonly string[], init?: Omit<ProcessSpawnRequest, 'argv'>): HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  }
  readonly http: { fetch(url: string, init?: HttpInit): Promise<HttpResponse> }
}

export const sessions: Imports['sessions'] = {
  get current() {
    return bound().sessions.current
  },
  list: (options) => bound().sessions.list(options),
  search: (text, options) => bound().sessions.search(text, options),
}

export const settings: Imports['settings'] = {
  user: { read: () => bound().settings.user.read(), update: (values) => bound().settings.user.update(values) },
  project: { read: () => bound().settings.project.read(), update: (values) => bound().settings.project.update(values) },
  local: { read: () => bound().settings.local.read(), update: (values) => bound().settings.local.update(values) },
}

export const model: Imports['model'] = {
  complete: (request, options) => bound().model.complete(request, options),
}

export const fs: Imports['fs'] = {
  read: (path) => bound().fs.read(path),
  write: (path, text) => bound().fs.write(path, text),
  exists: (path) => bound().fs.exists(path),
  find: (glob) => bound().fs.find(glob),
  list: (path) => bound().fs.list(path),
  stat: (path, options) => bound().fs.stat(path, options),
}

export const metadata: Imports['metadata'] = {
  read: (path) => bound().metadata.read(path),
  update: (path, change) => bound().metadata.update(path, change),
}

export const process: Imports['process'] = {
  run: (argv, init) => bound().process.run(argv, init),
  spawn: (argv, init) => bound().process.spawn(argv, init),
}

export const http: Imports['http'] = {
  fetch: (url, init) => bound().http.fetch(url, init),
}

export type Mod<State extends object = Record<never, never>, Declared extends Options = Options> = {
  readonly name: string
  readonly folder: string
  readonly dataFolder: string
  readonly state: Readonly<State>
  readonly options: OptionValues<Declared>
  readonly permissions: Permissions
  on<H extends Hook>(hook: H, listener: HookListener<H>, options?: HookOptions): Disposable
  on<H extends Hook>(hook: H, matcher: Matcher<HookInput<H>>, listener: HookListener<H>, options?: HookOptions): Disposable
  every(ms: number, listener: () => unknown): Disposable
  after(ms: number, listener: () => unknown): Disposable
  use<Handle>(job: Job<Handle, State>): Handle
  log(text: string): void
  readonly ui: {
    pane(pane: Pane<State>): PaneHandle
    render<P extends Place>(place: P, Component: (props: PlaceProps<P>) => RenderElement): Disposable
    readonly toast: Toast
    ask(question: string, options?: readonly string[] | AskOptions): Promise<string>
    copy(text: string): Promise<void>
    scroll(args: UiScrollArgs): Promise<UiScrollResult>
    notice(callId: string, text: string | undefined): void
  }
  readonly settings: {
    page(page: Pane<State>): void
    open(pageId?: string): Promise<void>
  }
  readonly dependencies: CmodDependencies
}

export const Mod = modSender

type StateGroups = {
  readonly memory?: object
  readonly session?: object
  readonly project?: object
  readonly global?: object
}

type Api<Contract, State extends object> = {
  readonly [Method in keyof Contract]: Contract[Method] extends (input: infer Input) => infer Result ? (input: Input, mod: Mod<State>) => Result | Awaited<Result> : never
}

export type ModDefinition<State extends StateGroups = Record<never, never>, Name extends string = string, Declared extends Options = Record<never, Option>> = {
  readonly name: Name
  readonly state?: State
  readonly options?: Declared
  readonly api?: Name extends keyof CmodDependencies ? Api<CmodDependencies[Name], State> : { readonly [method: string]: (input: never, mod: Mod<State>) => unknown }
  readonly installer?: readonly Step<State>[]
  setup(mod: Mod<State, Declared>): unknown
}

export type JobContext<State extends object = Record<never, never>> = {
  readonly mod: Mod<State>
  announce(feature: string): void
  reserveName(type: string, name: string, taken: string): Disposable
}

export type Job<Handle, State extends object = Record<never, never>> = (context: JobContext<State>) => Handle

export function defineMod<State extends StateGroups = Record<never, never>, Name extends string = string, const Declared extends Options = Record<never, Option>>(definition: ModDefinition<State, Name, Declared>): ModDefinition<State, Name, Declared> {
  if (definition.name.trim() === '') throw new Error('defineMod: the mod needs a name, such as the name in .claude-plugin/plugin.json.')
  if (definition.options !== undefined) checkOptions(definition.name, definition.options)
  return definition
}

export type { Matcher } from './utils/matcher.js'
export type { Place, PlaceProps } from './ui/places.js'
export { AbovePrompt, AskUserQuestion, CommandOutput, PromptHint, SessionMode, Spinner, ToolGroup, ToolProgress, TurnDuration } from './ui/places.js'
export { Session, type SessionEvent, type SessionPayload, type SessionScope, type SessionSend, type Sessions, type TaskStartArgs, type Usage } from './session/session.js'
export { ContextEnd, ContextStart, type Context } from './session/context/context.js'
export { TurnEnd, TurnStart, type Turn } from './session/context/turn/turn.js'
export { Message, type MessageType } from './session/context/turn/message/message.js'
export { Prompt } from './session/context/turn/message/prompt.js'
export { Note } from './session/context/turn/message/note.js'
export { Reply } from './session/context/turn/message/reply.js'
export { ToolCall } from './session/context/turn/message/tool-call.js'
export { ToolResult } from './session/context/turn/message/tool-result.js'
export { Skill } from './session/context/turn/message/skill.js'
export { Document } from './session/context/turn/message/document.js'
export { Notice } from './session/context/turn/message/notice.js'
export { Channel, Person, Schedule, Sdk, type Sender, type SenderType } from './session/context/turn/message/sender.js'
export { GoalChange, type Goal } from './session/goal/goal.js'
export { Task, TaskEnd, TaskStart } from './session/goal/task.js'
export { longestMs } from './runtime/deadline.js'
export { notInstalled } from './runtime/dependencies.js'
export { messageOf } from './utils/text.js'
