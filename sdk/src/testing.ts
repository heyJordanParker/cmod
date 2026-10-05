import type { Args, ClassicHookInputs, CmodDependencies, CommandRunResult, EventResult, Frozen, Next, PaneOpenArgs, RenderChildren, RenderComponent, RenderElement, Timer } from 'claude-code'
import type { Reply } from './jobs/slash-command.js'
import type { ModDefinition, ModEvent } from './mod.js'
import type { Claude } from './runtime/claude.js'
import { answerCall, notInstalled } from './runtime/dependencies.js'
import type { RoutedEvent } from './runtime/hooks.js'
import { createLifecycle } from './runtime/lifecycle.js'
import type { Slot, SlotProps } from './ui/slots.js'
import { elements, findButton, rowsOf } from './utils/fake-elements.js'

export type TestCall = {
  readonly call: string
  readonly args: readonly unknown[]
}

export type Fakes = {
  process: { run?: Claude['process']['run']; spawn?: Claude['process']['spawn'] }
  fs: { read?: Claude['fs']['read']; write?: Claude['fs']['write']; list?: Claude['fs']['list']; exists?: Claude['fs']['exists']; stat?: Claude['fs']['stat'] }
  http: { fetch?: Claude['http']['fetch'] }
  settings: { read?: Claude['settings']['read'] }
  ui: { ask?: Claude['ui']['ask']; open?: Claude['ui']['open'] }
  agent: { list?: Claude['agent']['list'] }
  clock: { after?: Claude['clock']['after'] }
  cmod: { call?: Claude['cmod']['call'] }
}

export type Shown = {
  readonly toasts: string[]
  readonly logs: string[]
  readonly debug: string[]
  readonly statuses: (string | undefined)[]
  readonly openPanes: Set<string>
  readonly commands: string[]
  readonly tools: string[]
}

export type FakeClaude = {
  readonly claude: Claude
  readonly calls: TestCall[]
  readonly fakes: Fakes
  readonly shown: Shown
  readonly store: Map<string, unknown>
}

export type TestOptions<State extends object> = {
  readonly state?: { readonly [Lifetime in keyof State]?: Partial<State[Lifetime]> }
  readonly scope?: 'user' | 'project'
  readonly projectRoot?: string
  readonly cwd?: string
  readonly dependencies?: { readonly [Name in keyof CmodDependencies]?: CmodDependencies[Name] }
}

type FilledField = 'session_id' | 'transcript_path' | 'cwd' | 'hook_event_name' | 'tool_use_id'

export type TestInput<E extends ModEvent> = Omit<ClassicHookInputs[E], FilledField> & Partial<Pick<ClassicHookInputs[E], FilledField & keyof ClassicHookInputs[E]>>

export type TestedMod<State extends object> = {
  start(): Promise<void>
  fire<E extends ModEvent>(event: E, input: TestInput<E>, below?: EventResult<`classic.${E}`>): Promise<EventResult<`classic.${E}`>>
  fire<N extends RoutedEvent>(event: N, input: Args<N>, below?: EventResult<N>): Promise<EventResult<N>>
  lines(paneId: string): Promise<string[]>
  lines<S extends Slot<object, object, { readonly component: RenderComponent }>>(slot: S, props: Omit<SlotProps<S>, 'Default'>): Promise<string[]>
  type(line: string): Promise<Reply>
  callTool(name: string, input: Record<string, unknown>): Promise<EventResult<'tool.call'>>
  press(paneId: string, key: string): Promise<void>
  moveTo(projectRoot: string, cwd?: string): Promise<void>
  readonly state: Readonly<State>
  readonly calls: readonly TestCall[]
  readonly fakes: Fakes
  readonly shown: Shown
}

const defaultColumns = 80

const toolUseEvents: readonly string[] = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied'] satisfies readonly ModEvent[]

export function fakeClaude(plugin: { readonly name: string; readonly root: string }): FakeClaude {
  const calls: TestCall[] = []
  const fakes: Fakes = { process: {}, fs: {}, http: {}, settings: {}, ui: {}, agent: {}, clock: {}, cmod: {} }
  const shown: Shown = { toasts: [], logs: [], debug: [], statuses: [], openPanes: new Set(), commands: [], tools: [] }
  const store = new Map<string, unknown>()

  const faked = <Args extends readonly unknown[], Result>(call: string, answer: () => ((...args: Args) => Result) | undefined) => {
    return (...args: Args): Result => {
      calls.push({ call, args })
      const fake = answer()
      if (fake === undefined) {
        throw new Error(`${call}(${args.map((arg) => JSON.stringify(arg)).join(', ')}) has no fake answer. Set fakes.${call} on the tested mod.`)
      }
      return fake(...args)
    }
  }
  const rejected = <Args extends readonly unknown[], Result>(call: string, answer: () => ((...args: Args) => Promise<Result>) | undefined) => {
    const run = faked(call, answer)
    return async (...args: Args): Promise<Result> => run(...args)
  }

  const claude: Claude = {
    plugin,
    ui: {
      toast: (text) => {
        shown.toasts.push(text)
      },
      status: (text) => {
        shown.statuses.push(text)
      },
      log: (text, options) => {
        const lines = options?.to === 'debug' ? shown.debug : shown.logs
        lines.push(text)
      },
      notice: () => undefined,
      invalidate: () => undefined,
      ask: rejected('ui.ask', () => fakes.ui.ask),
      open: async (pane) => {
        calls.push({ call: 'ui.open', args: [pane] })
        const answer = fakes.ui.open === undefined ? { isPlaced: true as const } : await fakes.ui.open(pane)
        if (answer.isPlaced) shown.openPanes.add(pane.id)
        return answer
      },
      close: async (pane) => {
        calls.push({ call: 'ui.close', args: [pane] })
        shown.openPanes.delete(pane.id)
      },
      panes: async () => [...shown.openPanes].map((id) => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
      resolve: () => elements,
    },
    process: {
      run: rejected('process.run', () => fakes.process.run),
      spawn: faked('process.spawn', () => fakes.process.spawn),
    },
    fs: {
      read: rejected('fs.read', () => fakes.fs.read),
      write: rejected('fs.write', () => fakes.fs.write),
      list: rejected('fs.list', () => fakes.fs.list),
      exists: rejected('fs.exists', () => fakes.fs.exists ?? (async () => false)),
      stat: rejected('fs.stat', () => fakes.fs.stat),
    },
    http: { fetch: rejected('http.fetch', () => fakes.http.fetch) },
    settings: { read: rejected('settings.read', () => fakes.settings.read) },
    agent: { list: rejected('agent.list', () => fakes.agent.list) },
    store: {
      get: async (key) => store.get(key),
      set: async (key, value) => {
        store.set(key, JSON.parse(JSON.stringify(value)))
      },
      delete: async (key) => {
        store.delete(key)
      },
      keys: async () => [...store.keys()],
    },
    clock: {
      now: async () => Date.now(),
      after: faked('clock.after', () => fakes.clock.after ?? realTimer),
      every: () => ({ cancel: () => undefined }),
    },
    session: {
      id: async () => 'test-session',
      root: async () => plugin.root,
      cwd: async () => plugin.root,
      model: async () => 'test-model',
      usage: async () => ({ context: { window: 200000 }, rateLimits: {}, cost: { usd: 0 } }) as unknown as Awaited<ReturnType<Claude['session']['usage']>>,
      surfaces: async () => ['terminal'],
    },
    command: {
      register: async (command) => {
        shown.commands.push(command.name)
        return { command: command.name }
      },
    },
    tool: {
      register: async (tool) => {
        shown.tools.push(tool.name)
        return { tool: `mcp__${plugin.name}__${tool.name}` }
      },
    },
    env: {
      home: async () => '/test/home',
      dataHome: async () => undefined,
      configHome: async () => undefined,
    },
    cmod: { call: rejected('cmod.call', () => fakes.cmod.call) },
  }

  return { claude, calls, fakes, shown, store }
}

export function testMod<State extends object>(definition: ModDefinition<State>, options: TestOptions<State> = {}): TestedMod<State> {
  installJsx()
  const name = definition.name
  const isProjectPlugin = options.scope === 'project'
  let projectRoot = options.projectRoot ?? (isProjectPlugin ? '/test/project' : `/test/plugins/${name}`)
  const root = isProjectPlugin ? `${projectRoot}/.claude/skills/${name}` : `/test/plugins/${name}`
  const fake = fakeClaude({ name, root })
  let cwd = options.cwd ?? projectRoot
  let sessionId = 'test-session'
  let toolUses = 0
  fake.claude.session.id = async () => sessionId
  fake.claude.session.root = async () => projectRoot
  fake.claude.session.cwd = async () => cwd
  fake.fakes.cmod.call = fakeDependencies(options.dependencies ?? {})
  const starting = options.state as Record<string, object> | undefined
  const declared = Object.entries(definition.state ?? {}) as [string, object][]
  const state = Object.fromEntries(declared.map(([lifetime, values]) => [lifetime, { ...values, ...starting?.[lifetime] }])) as State
  const lifecycle = createLifecycle<State>({ ...definition, state })
  let started: Promise<void> | undefined

  const start = async () => {
    started ??= lifecycle.start(fake.claude, async () => ({ name, root, version: '0.0.0', store: '/test/home/.local/share/cmod', isInstalled: true, shouldRecord: false }))
    await started
    if (lifecycle.phase !== 'active') throw lifecycle.failure ?? new Error(`${name} did not start: the lifecycle is ${lifecycle.phase}.`)
  }

  const route = async <N extends RoutedEvent>(event: N, input: unknown, below: unknown): Promise<EventResult<N>> => {
    await start()
    return lifecycle.route(event, input as Frozen<Args<N>>, fakeNext(event, () => below))
  }

  const drawPane = async (paneId: string) => {
    await start()
    if (!fake.shown.openPanes.has(paneId)) {
      const opening = [...fake.shown.commands.map((command) => `tested.type('/${command}')`), 'pane.open() in the mod'].join(', or with ')
      throw new Error(`The pane "${paneId}" of ${name} is not open, and a user sees a pane only while it is open. Open it first with ${opening}.`)
    }
    const opened = fake.calls.findLast((call) => call.call === 'ui.open' && (call.args[0] as PaneOpenArgs).id === paneId)?.args[0] as PaneOpenArgs | undefined
    const columns = opened?.columns ?? defaultColumns
    const props = { title: opened?.title ?? paneId, isFocused: false, bodyColumns: columns, placement: 'dock' }
    const drawing = await route('ui.render', { surface: 'terminal', component: 'Pane', requestId: paneId, props }, elements.Box({}))
    return { drawing, columns }
  }

  const drawSlot = async (component: RenderComponent, props: object) => {
    await start()
    const input = { surface: 'terminal', component, requestId: component, props } as Frozen<Args<'ui.render'>>
    const drawing = await lifecycle.route('ui.render', input, fakeNext('ui.render', (e) => plainOutput(e as Args<'ui.render'>)))
    return { drawing, columns: defaultColumns }
  }

  const fire = ((event: string, input: object, below: unknown = {}) => {
    if (event.includes('.')) return route(event as RoutedEvent, input, below)
    if (event === 'SessionStart') sessionId = (input as { session_id?: string }).session_id ?? sessionId
    const toolUse = toolUseEvents.includes(event) ? { tool_use_id: `toolu_${(toolUses += 1)}` } : {}
    const filled = { session_id: sessionId, transcript_path: '/test/transcript.jsonl', cwd, hook_event_name: event, ...toolUse, ...input }
    if (event !== 'PreToolUse') return route(`classic.${event as ModEvent}`, filled, below)
    const { tool_name, tool_input, tool_use_id } = filled as ClassicHookInputs['PreToolUse']
    return route('classic.PreToolUse', { ...(tool_input as object), tool: tool_name, tool_use_id }, below)
  }) as TestedMod<State>['fire']

  return {
    start,
    fire,
    lines: (async (target: string | { readonly component: RenderComponent }, props: object = {}) => {
      const { drawing, columns } = typeof target === 'string' ? await drawPane(target) : await drawSlot(target.component, props)
      return rowsOf(drawing, columns).map((row) => row.trimEnd())
    }) as TestedMod<State>['lines'],
    async type(line) {
      const typed = /^\/(\S+)\s*(.*)$/s.exec(line)
      if (typed === null) throw new Error(`type takes a slash command the way the user types it, such as tested.type('/help'), and "${line}" does not start with /.`)
      const [, command = '', args = ''] = typed
      const unanswered: CommandRunResult = {}
      const answer = await route('command.run', { command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: defaultColumns } }, unanswered)
      if (answer === unanswered) throw new Error(`${name} has no slash command /${command}. Add it in setup with mod.use(slashCommand({ name: '${command}', … })).`)
      return replyOf(answer)
    },
    async callTool(toolName, input) {
      const tool = `mcp__${name}__${toolName}`
      const tool_use_id = `toolu_${(toolUses += 1)}`
      const check = await route('tool.check', { tool, input, tool_use_id }, { decision: 'allow' })
      if (check.decision === 'deny') return { deny: check.reason ?? '' }
      if (check.decision === 'ask') throw new Error(`The permission rules of ${name} ask the user before ${toolName} runs: ${check.reason ?? 'no reason given'}. callTool answers only a call Claude Code allows or denies without asking.`)
      const unanswered: EventResult<'tool.call'> = { deny: '' }
      const answer = await route('tool.call', { ...input, tool, tool_use_id }, unanswered)
      if (answer === unanswered) throw new Error(`${name} has no tool ${toolName}. Add it in setup with mod.use(tool({ name: '${toolName}', … })).`)
      return answer
    },
    async press(paneId, key) {
      const button = findButton((await drawPane(paneId)).drawing, key)
      if (button === undefined) throw new Error(`The pane "${paneId}" of ${name} draws no Button with the key or label "${key}".`)
      await button.props.onPress()
    },
    async moveTo(nextRoot, nextCwd = nextRoot) {
      await start()
      const oldCwd = cwd
      projectRoot = nextRoot
      cwd = nextCwd
      await fire('CwdChanged', { old_cwd: oldCwd, new_cwd: nextCwd })
    },
    get state() {
      const mod = lifecycle.mod
      if (mod === undefined) throw new Error(`${name} has not started. Await tested.start() or tested.fire(…) first.`)
      return mod.state
    },
    calls: fake.calls,
    fakes: fake.fakes,
    shown: fake.shown,
  }
}

declare function setTimeout(fn: () => void, ms: number): unknown
declare function clearTimeout(timeout: unknown): void

function realTimer(ms: number, fn: () => void): Timer {
  const timeout = setTimeout(fn, ms)
  return { cancel: () => clearTimeout(timeout) }
}

function fakeDependencies(dependencies: NonNullable<TestOptions<object>['dependencies']>): Claude['cmod']['call'] {
  const apis = dependencies as Readonly<Record<string, Parameters<typeof answerCall>[1] | undefined>>
  return async (call) => {
    const api = apis[call.to]
    const answer = api === undefined ? { deny: notInstalled(call.to) } : await answerCall(call.to, api, call)
    if (answer.deny !== undefined) throw new Error(answer.deny)
    return answer.value
  }
}

function fakeNext<N extends RoutedEvent>(event: N, below: (e: unknown) => unknown): Next<N> {
  const next = Object.assign(async (e: unknown) => below(e), {
    event,
    signal: new AbortController().signal,
    origin: { plugin: 'engine', tier: 'core' },
    trace: [],
    budget: { ms: 0, remainingMs: Number.POSITIVE_INFINITY },
    is: () => true,
  })
  return Object.assign(next, { to: next }) as unknown as Next<N>
}

function plainOutput({ component, props }: Args<'ui.render'>): RenderElement {
  const rows = Object.entries(props).map(([key, value]) => elements.Text({ children: `${key}: ${JSON.stringify(value)}` }))
  return elements.Box({ flexDirection: 'column', children: [elements.Text({ children: component }), elements.Box({ flexDirection: 'column', paddingLeft: 2, children: rows })] })
}

function replyOf({ text, context }: CommandRunResult): Reply {
  return { ...(text === undefined ? {} : { text }), ...(context === undefined ? {} : { context: context.join('\n') }) }
}

function installJsx(): void {
  const scope = globalThis as unknown as Record<string, unknown>
  scope['h'] ??= (tag: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
    if (typeof tag !== 'function') throw new Error(`JSX tag "${String(tag)}" is not an element. Import elements such as Box from node_modules/cmod-sdk/ui/elements.js.`)
    return tag({ ...props, children })
  }
  scope['Fragment'] ??= (props: { children?: RenderChildren }) => elements.Box({ flexDirection: 'column', children: props.children })
}
