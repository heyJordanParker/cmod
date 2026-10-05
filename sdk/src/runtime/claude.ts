import type {
  AgentInfo,
  Args,
  AskOptions,
  CommandSpec,
  ElementTable,
  EngineInterface,
  EventResult,
  FsEntry,
  FsStat,
  FsStatOptions,
  Frozen,
  HookStream,
  HttpInit,
  HttpResponse,
  InvalidatableEventName,
  Next,
  On,
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
} from 'claude-code'
import { startSession } from './hooks.js'

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
  }
  readonly command: { register(command: CommandSpec): Promise<{ command: string }> }
  readonly tool: { register(tool: ToolSpec): Promise<{ tool: string }> }
  readonly agent: { list(): Promise<AgentInfo[]> }
  readonly env: {
    home(): Promise<string | undefined>
    dataHome(): Promise<string | undefined>
    configHome(): Promise<string | undefined>
  }
  readonly cmod: { call(input: Args<'cmod.call'>): Promise<unknown> }
}

async function keep($: EngineInterface, e: Frozen<Args<'session.start'>>, next: Next<'session.start'>): Promise<EventResult<'session.start'>> {
  await startSession({
    plugin: { name: $.plugin.name, root: $.plugin.root },
    ui: {
      toast: (text, options) => $.ui.toast(text, options),
      status: (text) => $.ui.status(text),
      log: (text, options) => $.ui.log(text, options),
      notice: (toolUseId, text) => $.ui.notice(toolUseId, text),
      invalidate: (event) => $.ui.invalidate(event),
      ask: (question, options) => $.ui.ask(question, options),
      open: (pane) => $.ui.open(pane),
      close: (pane) => $.ui.close(pane),
      panes: () => $.ui.panes(),
      resolve: (render) => $.ui.resolve(render),
    },
    process: {
      run: (argv, init) => $.process.run(argv, init),
      spawn: (request) => $.process.spawn(request),
    },
    fs: {
      read: (path) => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      list: (path) => $.fs.list(path),
      exists: (path) => $.fs.exists(path),
      stat: (path, options) => $.fs.stat(path, options),
    },
    http: { fetch: (url, init) => $.http.fetch(url, init) },
    settings: { read: (args) => $.settings.read(args) },
    store: {
      get: (key) => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
    },
    clock: {
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
    },
    session: {
      id: () => $.session.id(),
      root: () => $.session.root(),
      cwd: () => $.session.cwd(),
      model: () => $.session.model(),
      usage: () => $.session.usage(),
      surfaces: () => $.session.surfaces(),
    },
    command: { register: (command) => $.command.register(command) },
    tool: { register: (tool) => $.tool.register(tool) },
    agent: { list: () => $.agent.list() },
    env: {
      home: () => $.env.get('HOME'),
      dataHome: () => $.env.get('XDG_DATA_HOME'),
      configHome: () => $.env.get('CLAUDE_CONFIG_DIR'),
    },
    cmod: { call: (input) => $.cmod.call(input) },
  })
  return next(e)
}

export function keepClaudeCalls(on: On): void {
  on('session.start', keep)
}
