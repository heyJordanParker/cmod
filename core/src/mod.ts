import type {
  AskOptions,
  CmodDependencies,
  ConfigRow as ClaudeConfigRow,
  FsStatOptions,
  HookStream,
  HttpInit,
  HttpResponse,
  ModelCompleteOptions,
  ModelCompleteRequest,
  ModelCompleteResult,
  ProcessRunInit,
  ProcessRunResult,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
  RenderElement,
  Settings,
} from 'claude-code'
import { checkHotkeys, type Hotkey, type HotkeyInit, type Hotkeys } from './hotkeys.js'
import { checkSteps, type Step } from './installer.js'
import { checkOptions, type Option, type Options, type OptionValues } from './options.js'
import { bound } from './runtime/bound.js'
import { Mod as modSender } from './session/context/turn/message/sender.js'
import { sessionEvents, type BeforeMethod, type CommandRun, type CommandRunAnswer, type OnMethod, type OnMethods, type Sessions } from './session/session.js'
import type { Widget, WidgetInit } from './ui/areas.js'
import type { Page, PageInit, Pane, PaneInit } from './ui/panes.js'
import type { Kind, Style, StyleInit } from './ui/styles.js'
import type { Matcher } from './utils/matcher.js'
import type { Subscription } from './utils/subscription.js'

export type { Subscription }

export type Timer = { readonly isRunning: boolean; stop(): void }

export type Reservation = { remove(): void }

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

export type FileChange = { readonly path: string; readonly type: 'change' | 'add' | 'unlink' }

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

export type SettingsFileChange = { readonly source: 'user' | 'project' | 'local' | 'policy' | 'skills'; readonly path?: string }

export type SettingsFileChangeListener = (change: SettingsFileChange) => { readonly refuse: string } | void | Promise<{ readonly refuse: string } | void>

export type ConfigRow = Pick<ClaudeConfigRow, 'key' | 'label' | 'kind' | 'value' | 'isLocked'> & {
  readonly description?: string
  readonly options?: readonly string[]
  readonly plugin?: string
}

export type CommandInfo = { readonly name: string; readonly description: string; readonly source: 'builtin' | 'plugin' | 'user' | 'mcp'; readonly plugin?: string }

export type CommandRunResult = { readonly text?: string; readonly note?: string }

export type Imports = {
  readonly sessions: Sessions
  readonly commands: {
    list(): Promise<CommandInfo[]>
    run(name: string, args?: string): Promise<CommandRunResult>
    readonly beforeRun: BeforeMethod<CommandRun, CommandRunAnswer>
    readonly onRun: OnMethod<CommandRun>
  }
  readonly config: { list(): Promise<ConfigRow[]> }
  readonly settings: {
    readonly user: SettingsFile
    readonly project: SettingsFile
    readonly local: SettingsFile
    beforeFileChange(listener: SettingsFileChangeListener): Subscription
    beforeFileChange(matcher: Matcher<SettingsFileChange>, listener: SettingsFileChangeListener): Subscription
  }
  readonly model: { complete(request: ModelCompleteRequest, options?: ModelCompleteOptions): Promise<ModelCompleteResult> }
  readonly fs: {
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
    exists(path: string): Promise<boolean>
    find(glob: string | readonly string[]): Promise<readonly FileMatch[]>
    list(path?: string): Promise<Entry[]>
    stat(path: string, options?: FsStatOptions): Promise<Stat>
    onChange(matcher: { readonly path: string | readonly string[] }, listener: (change: FileChange) => unknown): Subscription
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
  readonly clipboard: { write(text: string): Promise<void> }
}

export const sessions: Imports['sessions'] = {
  get current() {
    return bound().sessions.current
  },
  list: (options) => bound().sessions.list(options),
  search: (text, matcher, options) => bound().sessions.search(text, matcher, options),
  ...(Object.fromEntries(Object.keys(sessionEvents).map((named) => [`on${named}`, (...args: unknown[]) => (bound().sessions[`on${named}` as keyof OnMethods] as (...each: unknown[]) => Subscription)(...args)])) as OnMethods),
}

export const settings: Imports['settings'] = {
  user: { read: () => bound().settings.user.read(), update: (values) => bound().settings.user.update(values) },
  project: { read: () => bound().settings.project.read(), update: (values) => bound().settings.project.update(values) },
  local: { read: () => bound().settings.local.read(), update: (values) => bound().settings.local.update(values) },
  beforeFileChange: ((matcherOrListener: never, listener?: never) => bound().settings.beforeFileChange(matcherOrListener, listener as never)) as Imports['settings']['beforeFileChange'],
}

export const commands: Imports['commands'] = {
  list: () => bound().commands.list(),
  run: (name, args) => bound().commands.run(name, args),
  beforeRun: ((...args: never[]) => (bound().commands.beforeRun as (...each: never[]) => Subscription)(...args)) as Imports['commands']['beforeRun'],
  onRun: ((...args: never[]) => (bound().commands.onRun as (...each: never[]) => Subscription)(...args)) as Imports['commands']['onRun'],
}

export const config: Imports['config'] = {
  list: () => bound().config.list(),
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
  onChange: (matcher, listener) => bound().fs.onChange(matcher, listener),
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

export const clipboard: Imports['clipboard'] = {
  write: (text) => bound().clipboard.write(text),
}

export type Mod<State extends object = Record<never, never>, Declared extends Options = Options, Keys extends Hotkeys = Hotkeys> = {
  readonly name: string
  readonly folder: string
  readonly dataFolder: string
  readonly state: Readonly<State>
  readonly options: OptionValues<Declared>
  readonly permissions: Permissions
  readonly hotkeys: { readonly [Key in keyof Keys]: Hotkey }
  every(ms: number, listener: () => unknown): Timer
  after(ms: number, listener: () => unknown): Timer
  use<Handle>(job: Job<Handle, State>): Handle
  log(text: string, options?: { readonly to?: 'debug' | 'transcript' }): void
  readonly panes: { add<Params = undefined>(pane: PaneInit<State, Params>): Pane<Params> }
  readonly sidebar: { add<Params = undefined>(page: PageInit<State, Params>): Page<Params> }
  readonly settings: {
    add<Params = undefined>(page: PageInit<State, Params>): Page<Params>
    open(): Promise<void>
  }
  readonly widgets: { add(widget: WidgetInit<State>): Widget }
  readonly styles: { add<K extends Kind>(style: StyleInit<K, State>): Style }
  readonly toast: Toast
  ask(question: string, options?: readonly string[] | AskOptions): Promise<string>
  readonly dependencies: CmodDependencies
}

export const Mod = modSender

type StateGroups = {
  readonly memory?: object
  readonly session?: object
  readonly project?: object
  readonly global?: object
}

type AnyApi = { readonly [method: string]: (input: never) => unknown } | void

type Api<Name extends string> = 0 extends 1 & CmodDependencies
  ? AnyApi
  : Name extends keyof CmodDependencies
    ? { readonly [Method in keyof CmodDependencies[Name]]: CmodDependencies[Name][Method] extends (input: infer Input) => infer Result ? (input: Input) => Result | Awaited<Result> : never }
    : AnyApi

export type ModDefinition<State extends StateGroups = Record<never, never>, Name extends string = string, Declared extends Options = Record<never, Option>, Keys extends Hotkeys = Record<never, HotkeyInit>> = {
  readonly name: Name
  readonly state?: State
  readonly options?: Declared
  readonly hotkeys?: Keys
  readonly installer?: readonly Step<State>[]
  setup(mod: Mod<State, Declared, Keys>): Api<Name> | Promise<Api<Name>>
}

export type JobContext<State extends object = Record<never, never>> = {
  readonly mod: Mod<State>
  announce(feature: string): void
  reserveName(type: string, name: string, taken: string): Reservation
}

export type Job<Handle, State extends object = Record<never, never>> = (context: JobContext<State>) => Handle

export function defineMod<State extends StateGroups = Record<never, never>, Name extends string = string, const Declared extends Options = Record<never, Option>, const Keys extends Hotkeys = Record<never, HotkeyInit>>(
  definition: ModDefinition<State, Name, Declared, Keys>,
): ModDefinition<State, Name, Declared, Keys> {
  if (definition.name.trim() === '') throw new Error('defineMod: the mod needs a name, such as the name in .claude-plugin/plugin.json.')
  if (definition.options !== undefined) checkOptions(definition.name, definition.options)
  if (definition.hotkeys !== undefined) checkHotkeys(definition.name, definition.hotkeys)
  if (definition.installer !== undefined) checkSteps(definition.name, definition.installer)
  return definition
}

export type { Matcher } from './utils/matcher.js'
export type { Combo, Hotkey, HotkeyInit, Key } from './hotkeys.js'
export type { OpenOptions, Page, PageInit, PageProps, Pane, PaneInit, PaneProps, ScrollOptions, ScrollTarget } from './ui/panes.js'
export type { Kind, Row, Style, StyleInit, StyleProps } from './ui/styles.js'
export type { Block } from './ui/markdown.js'
export { AskUserQuestion, CommandOutput, ToolGroup, ToolProgress } from './ui/styles.js'
export { AbovePrompt, BelowPrompt, Dashboard, TurnEnd, Working, type Area, type Widget, type WidgetContext, type WidgetInit } from './ui/areas.js'
export type { Step } from './installer.js'
export type { SlashCommand } from './jobs/slash-command.js'
export type { Tool } from './jobs/tool.js'
export { Session, type AnswerOptions, type BeforeMethods, type Surface, type Listener, type ListenerTime, type OnMethods, type ReadOptions, type RecordPart, type Refusal, type SearchOptions, type SessionScope, type SessionSend, type Sessions, type CurrentSession, type Placement, type ProjectSetup, type SessionStartAsked, type SessionStarted, type SessionEnded, type ModelChange, type CwdChange, type DirectoryAdd, type Worktree, type Notification, type Elicitation, type ElicitationResponse, type McpServer, type PermissionUpdate, type PermissionCheck, type PermissionRequest, type PermissionDenial, type BatchedCall, type ToolBatch, type Todo, type ReplyDisplay, type TaskOwner, type TaskStartArgs, type ToolCallArgs, type Usage, type CommandRun, type CommandRunAnswer } from './session/session.js'
export type { Context } from './session/context/context.js'
export type { Turn } from './session/context/turn/turn.js'
export type { Message, MessageType } from './session/context/turn/message/message.js'
export { Prompt } from './session/context/turn/message/prompt.js'
export { Note } from './session/context/turn/message/note.js'
export { Reply } from './session/context/turn/message/reply.js'
export { ToolCall } from './session/context/turn/message/tool-call.js'
export { ToolResult } from './session/context/turn/message/tool-result.js'
export { Skill } from './session/context/turn/message/skill.js'
export { InstructionFile } from './session/context/turn/message/instruction-file.js'
export { Notice } from './session/context/turn/message/notice.js'
export { Channel, Engine, Person, Schedule, Sdk, type Sender, type SenderType } from './session/context/turn/message/sender.js'
export type { Goal } from './session/goal/goal.js'
export { Task } from './session/goal/task.js'
export { longestMs } from './runtime/deadline.js'
export { notInstalled } from './runtime/dependencies.js'
export { messageOf } from './utils/text.js'
