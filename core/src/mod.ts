import type {
  AgentSpawnArgs,
  AgentSpawnResult,
  AskOptions,
  ClassicHookInputs,
  CmodDependencies,
  FsEntry,
  FsStat,
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
  SessionMessage,
  Timer,
  ToastOptions,
  UiScrollArgs,
  UiScrollResult,
} from 'claude-code'
import type { Step } from './installer.js'
import { checkOptions, type Option, type Options, type OptionValues } from './options.js'
import type { FlagPermission, ListPermission } from './records.js'
import type { Claude } from './runtime/claude.js'
import type { RoutedEvent } from './runtime/hooks.js'
import type { RoutedHook } from './runtime/router.js'
import type { ToolCalls } from './runtime/tool-calls.js'
import type { Pane } from './ui/define-pane.js'
import type { Slot, SlotProps } from './ui/slots.js'

export type ProgressStep = {
  readonly done: number
  readonly total: number
  readonly label?: string
}

export type PaneHandle = {
  open(options?: Readonly<Pick<PaneOpenArgs, 'focus'>>): Promise<void>
  close(): Promise<void>
  toggle(options?: Readonly<Pick<PaneOpenArgs, 'focus'>>): Promise<void>
  readonly isOpen: boolean
}

export type { Claude, RoutedEvent, RoutedHook, ToolCalls }
export { longestMs } from './runtime/deadline.js'
export { notInstalled } from './runtime/dependencies.js'
export { messageOf } from './utils/text.js'

export type ModEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'InstructionsLoaded'
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostToolBatch'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Notification'
  | 'PreCompact'
  | 'Stop'
  | 'StopFailure'
  | 'CwdChanged'
  | 'FileChanged'

export type HookAnswer = {
  continue?: boolean
  stopReason?: string
  suppressOutput?: boolean
  systemMessage?: string
  decision?: 'block'
  reason?: string
  hookSpecificOutput?: {
    hookEventName?: ModEvent
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

export type HookInput<E extends ModEvent> = HookInputs[E]

export type ModHook<E extends ModEvent> = (input: HookInput<E>) => HookAnswer | void | Promise<HookAnswer | void>

export type HookOptions = {
  readonly timeoutMs?: number
}

export type ScrollArgs = Omit<UiScrollArgs, 'to'> & { readonly to: Exclude<UiScrollArgs['to'], { requestId: string }> }

export type ModClaude = Claude & {
  on<N extends RoutedEvent>(event: N, hook: RoutedHook<N>): void
}

export type Metadata = Readonly<Record<string, string>>

export type FileMatch = {
  readonly path: string
  readonly name?: string
  readonly metadata: Metadata
  readonly error?: string
}

type SessionMessages = {
  (): Promise<SessionMessage[]>
  (args: { readonly agentId: string }): Promise<SessionMessage[] | { readonly deny: string }>
}

export type Mod<State extends object = Record<never, never>, Declared extends Options = Options> = {
  readonly name: string
  readonly state: Readonly<State>
  readonly options: OptionValues<Declared>
  readonly dataFolder: string
  on<E extends ModEvent>(event: E, hook: ModHook<E>, options?: HookOptions): void
  use<Handle>(job: Job<Handle, State>): Handle
  every(ms: number, hook: () => unknown): Timer
  readonly ui: {
    pane(pane: Pane<State>): PaneHandle
    render<S extends Slot>(slot: S, Component: (props: SlotProps<S>) => RenderElement): void
    toast(text: string, options?: ToastOptions): void
    progress<T>(title: string, task: (report: (step: ProgressStep) => void) => Promise<T>): Promise<T>
    ask(question: string, options?: readonly string[] | AskOptions): Promise<string>
    scroll(args: ScrollArgs): Promise<UiScrollResult>
  }
  readonly process: {
    run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult>
    spawn(argv: readonly string[], init?: Omit<ProcessSpawnRequest, 'argv'>): HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  }
  readonly fs: {
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
    list(path?: string): Promise<FsEntry[]>
    exists(path: string): Promise<boolean>
    stat(path: string, options?: FsStatOptions): Promise<FsStat>
    find(glob: string | readonly string[]): Promise<readonly FileMatch[]>
  }
  readonly metadata: {
    read(path: string): Promise<Metadata>
    update(path: string, change: (metadata: Record<string, string>) => void): Promise<void>
  }
  readonly http: {
    fetch(url: string, init?: HttpInit): Promise<HttpResponse>
  }
  readonly settings: {
    page(page: Pane<State>): void
    open(pageId?: string): Promise<void>
  }
  readonly session: {
    messages: SessionMessages
    append(text: string): Promise<void>
    submit(text: string): Promise<void>
  }
  readonly agent: {
    spawn(args: AgentSpawnArgs): Promise<AgentSpawnResult>
  }
  readonly model: {
    complete(request: ModelCompleteRequest, options?: ModelCompleteOptions): Promise<ModelCompleteResult>
  }
  readonly permissions: {
    has(name: ListPermission, value: string): boolean
    has(name: FlagPermission): boolean
  }
  readonly projectRoot: string
  readonly cwd: string
  readonly dependencies: CmodDependencies
  readonly claude: ModClaude
}

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
  setup(mod: Mod<State, Declared>): void | Promise<void>
}

export type JobContext<State extends object = Record<never, never>> = {
  readonly mod: Mod<State>
  announce(feature: string): void
  reserveName(kind: string, name: string, taken: string): void
  readonly toolCalls: ToolCalls
}

export type Job<Handle, State extends object = Record<never, never>> = (context: JobContext<State>) => Handle

export function defineMod<State extends StateGroups = Record<never, never>, Name extends string = string, const Declared extends Options = Record<never, Option>>(definition: ModDefinition<State, Name, Declared>): ModDefinition<State, Name, Declared> {
  if (definition.name.trim() === '') throw new Error('defineMod: the mod needs a name, such as the name in .claude-plugin/plugin.json.')
  if (definition.options !== undefined) checkOptions(definition.name, definition.options)
  return definition
}
