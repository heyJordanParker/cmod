import type {
  AgentInfo,
  AgentSpawnArgs,
  AgentSpawnResult,
  Args,
  EngineInterface,
  AskOptions,
  CommandSpec,
  ElementTable,
  FsEntry,
  FsStat,
  FsStatOptions,
  HookStream,
  HttpInit,
  HttpResponse,
  InvalidatableEventName,
  PaneCloseArgs,
  PaneOpenArgs,
  ProcessRunInit,
  ProcessRunResult,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
  RenderSurface,
  ResolveInput,
  SessionUsage,
  Settings,
  SettingsReadArgs,
  Timer,
  ToastOptions,
  ToolSpec,
  UiLogOptions,
  UiOpenResult,
  UiPane,
  UiScrollArgs,
  UiScrollResult,
} from 'claude-code'

export type Claude = {
  readonly plugin: { readonly name: string; readonly root: string }
  readonly ui: {
    toast(text: string, options?: ToastOptions): void
    status(text: string | undefined): void
    log(text: string, options?: UiLogOptions): void
    notice(toolUseId: string, text: string | undefined): void
    invalidate(event: InvalidatableEventName): void
    ask(question: string, options?: readonly string[] | AskOptions): Promise<string>
    open(pane: PaneOpenArgs): Promise<UiOpenResult>
    close(pane: PaneCloseArgs): Promise<void>
    panes(): Promise<readonly UiPane[]>
    scroll(args: UiScrollArgs): Promise<UiScrollResult>
    resolve(e: ResolveInput): ElementTable<RenderSurface>
  }
  readonly process: {
    run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult>
    spawn(request: ProcessSpawnRequest): HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  }
  readonly fs: {
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
    list(path?: string): Promise<FsEntry[]>
    exists(path: string): Promise<boolean>
    stat(path: string, options?: FsStatOptions): Promise<FsStat>
  }
  readonly http: { fetch(url: string, init?: HttpInit): Promise<HttpResponse> }
  readonly settings: { read(args?: SettingsReadArgs): Promise<Settings> }
  readonly store: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
    keys(): Promise<string[]>
  }
  readonly clock: {
    now(): Promise<number>
    after(ms: number, fn: () => void): Timer
    every(ms: number, fn: () => void): Timer
  }
  readonly session: {
    id(): Promise<string>
    root(): Promise<string>
    cwd(): Promise<string>
    model(): Promise<string>
    usage(): Promise<SessionUsage>
    surfaces(): Promise<readonly RenderSurface[]>
    messages: EngineInterface['session']['messages']
    append: EngineInterface['session']['append']
  }
  readonly prompt: { submit: EngineInterface['prompt']['submit'] }
  readonly model: { complete: EngineInterface['model']['complete'] }
  readonly command: { register(command: CommandSpec): Promise<{ command: string }> }
  readonly tool: { register(tool: ToolSpec): Promise<{ tool: string }>; call: EngineInterface['tool']['call'] }
  readonly agent: {
    list(): Promise<AgentInfo[]>
    spawn(args: AgentSpawnArgs): Promise<AgentSpawnResult>
  }
  readonly env: {
    home(): Promise<string | undefined>
    dataHome(): Promise<string | undefined>
    configHome(): Promise<string | undefined>
  }
  readonly cmod: { call(input: Args<'cmod.call'>): Promise<unknown> }
}
