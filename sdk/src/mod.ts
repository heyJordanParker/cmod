import type {
  AskOptions,
  ClassicHookInputs,
  FsEntry,
  HookStream,
  HttpInit,
  HttpResponse,
  PermissionRequestDecision,
  ProcessRunInit,
  ProcessRunResult,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
  RenderElement,
  Settings,
  SettingsReadArgs,
} from 'claude-code'
import type { PaneHandle, ProgressStep } from './api/ui.js'
import type { Claude } from './runtime/claude.js'
import type { RoutedEvent } from './runtime/hooks.js'
import type { RoutedHook } from './runtime/router.js'
import type { Pane } from './ui/define-pane.js'
import type { Slot, SlotProps } from './ui/slots.js'

export type { PaneHandle, ProgressStep }

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

type HookInputs = Omit<ClassicHookInputs, 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'> & {
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
}

export type ModHook<E extends ModEvent> = (input: HookInputs[E]) => HookAnswer | void | Promise<HookAnswer | void>

export interface Dependencies {}

export type Mod<State extends object = Record<never, never>> = {
  readonly name: string
  readonly state: Readonly<State>
  readonly dataFolder: string
  on<E extends ModEvent>(event: E, hook: ModHook<E>): void
  use<Handle>(part: Part<Handle, State>): Handle
  readonly ui: {
    pane(pane: Pane<State>): PaneHandle
    render<S extends Slot>(slot: S, Component: (props: SlotProps<S>) => RenderElement): void
    toast(text: string): void
    progress<T>(title: string, task: (report: (step: ProgressStep) => void) => Promise<T>): Promise<T>
    ask(question: string, options?: readonly string[] | AskOptions): Promise<string>
  }
  readonly process: {
    run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult>
    spawn(argv: readonly string[], init?: Omit<ProcessSpawnRequest, 'argv'>): HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  }
  readonly fs: {
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
    list(path?: string): Promise<FsEntry[]>
  }
  readonly http: {
    fetch(url: string, init?: HttpInit): Promise<HttpResponse>
  }
  readonly settings: {
    read(args?: SettingsReadArgs): Promise<Settings>
  }
  readonly session: {
    readonly root: string
    readonly cwd: string
  }
  readonly dependencies: Dependencies
}

type StateGroups = {
  readonly memory?: object
  readonly session?: object
  readonly project?: object
  readonly global?: object
}

export type ModDefinition<State extends StateGroups = Record<never, never>> = {
  readonly name: string
  readonly state?: State
  readonly api?: { readonly [method: string]: (input: never, mod: Mod<State>) => unknown }
  setup(mod: Mod<State>): void | Promise<void>
}

export type PartContext<State extends object = Record<never, never>> = {
  readonly mod: Mod<State>
  readonly claude: Claude
  on<N extends RoutedEvent>(event: N, hook: RoutedHook<N>): void
  adds(feature: string): void
}

export type Part<Handle, State extends object = Record<never, never>> = (context: PartContext<State>) => Handle

export function defineMod<State extends StateGroups = Record<never, never>>(definition: ModDefinition<State>): ModDefinition<State> {
  if (definition.name.trim() === '') throw new Error('defineMod: the mod needs a name, such as the name in .claude-plugin/plugin.json.')
  return definition
}
