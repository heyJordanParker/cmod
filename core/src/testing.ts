import type {
  Args,
  ClassicHookInputs,
  CmodDependencies,
  CommandPresentation,
  CommandRunResult,
  EventResult,
  Frozen,
  PaneOpenArgs,
  PluginOptions,
  PressedLink,
  RenderChildren,
  RenderComponent,
  RenderElement,
  RenderPropsOf,
  UiInputArgument,
  UiPressArgument,
  UiSelectArgument,
} from 'claude-code'
import type { Reply } from './jobs/slash-command.js'
import type { ModDefinition, ModEvent } from './mod.js'
import type { Options, OptionValues } from './options.js'
import { readSteps, storeFolder, type Steps } from './records.js'
import type { Claude } from './runtime/claude.js'
import { answerCall, notInstalled } from './runtime/dependencies.js'
import type { RoutedEvent } from './runtime/hooks.js'
import { toolInputOf } from './runtime/tool-calls.js'
import { createLifecycle } from './runtime/lifecycle.js'
import { MissingOptions } from './runtime/options.js'
import { fakeClaude, type Fakes, type Shown, type TestCall } from './testing/fake-claude.js'
import { elements, findElement, rowsOf } from './testing/fake-elements.js'
import { fakeFiles } from './testing/fake-files.js'
import { listed } from './utils/text.js'
import type { Slot, SlotProps } from './ui/slots.js'

export type { Fakes, Shown, TestCall } from './testing/fake-claude.js'

export type TestOptions<State extends object, Declared extends Options = Options> = {
  readonly state?: { readonly [Lifetime in keyof State]?: Partial<State[Lifetime]> }
  readonly options?: Partial<OptionValues<Declared>>
  readonly permissions?: readonly string[]
  readonly scope?: 'user' | 'project'
  readonly projectRoot?: string
  readonly cwd?: string
  readonly dependencies?: { readonly [Name in keyof CmodDependencies]?: CmodDependencies[Name] }
  readonly files?: Readonly<Record<string, string>>
  readonly links?: Readonly<Record<string, string>>
}

type FilledField = 'session_id' | 'transcript_path' | 'cwd' | 'hook_event_name' | 'tool_use_id'

export type TestInput<E extends ModEvent> = Omit<ClassicHookInputs[E], FilledField> & Partial<Pick<ClassicHookInputs[E], FilledField & keyof ClassicHookInputs[E]>>

export type TestedMod<State extends object> = {
  start(): Promise<void>
  fire<E extends ModEvent>(event: E, input: TestInput<E>, below?: EventResult<`classic.${E}`>): Promise<EventResult<`classic.${E}`>>
  fire<N extends RoutedEvent>(event: N, input: Args<N>, below?: EventResult<N>): Promise<EventResult<N>>
  settle(): Promise<void>
  lines(paneId: string): Promise<string[]>
  lines<S extends Slot<object, object, { readonly component: RenderComponent }>>(slot: S, props: Omit<SlotProps<S>, 'Default'>, requestId?: string): Promise<string[]>
  type(line: string): Promise<Reply>
  callTool(name: string, input: Record<string, unknown>): Promise<EventResult<'tool.call'>>
  press(paneId: string, key: string, link?: string): Promise<void>
  input(paneId: string, key: string, text: string, kind?: UiInputArgument['kind']): Promise<void>
  select(paneId: string, key: string, value: string): Promise<void>
  moveTo(projectRoot: string, cwd?: string): Promise<void>
  readonly state: Readonly<State>
  readonly calls: readonly TestCall[]
  readonly fakes: Fakes
  readonly shown: Shown
}

const defaultColumns = 80

const defaultRows = 24

const presentation: CommandPresentation = { isFullscreen: false, columns: defaultColumns }

const toolUseEvents: readonly string[] = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied'] satisfies readonly ModEvent[]

export function testMod<State extends object, Declared extends Options = Options>(definition: ModDefinition<State, string, Declared>, options: TestOptions<State, Declared> = {}): TestedMod<State> {
  installJsx()
  const name = definition.name
  const isProjectPlugin = options.scope === 'project'
  let projectRoot = options.projectRoot ?? (isProjectPlugin ? '/test/project' : `/test/plugins/${name}`)
  const root = isProjectPlugin ? `${projectRoot}/.claude/skills/${name}` : `/test/plugins/${name}`
  const fake = fakeClaude({ name, root })
  let cwd = options.cwd ?? projectRoot
  let cwdAfterPrompt: string | undefined
  let sessionId = 'test-session'
  let toolUses = 0
  let slotDraws = 0
  fake.claude.session.id = async () => sessionId
  fake.claude.session.root = async () => projectRoot
  fake.claude.session.cwd = async () => cwd
  fake.fakes.cmod.call = fakeDependencies(options.dependencies ?? {})
  const firedAgents = new Map<string, string>()
  const listAgents = fake.claude.agent.list
  fake.claude.agent.list = async () => {
    if (fake.fakes.agent.list !== undefined || firedAgents.size === 0) return listAgents()
    return [...firedAgents].map(([id, type]) => ({ id, type, description: '', status: 'running' as const }))
  }
  Object.assign(fake.fakes.fs, fakeFiles(options.files ?? {}, options.links))
  const starting = options.state as Record<string, object> | undefined
  const declared = Object.entries(definition.state ?? {}) as [string, object][]
  const state = Object.fromEntries(declared.map(([lifetime, values]) => [lifetime, { ...values, ...starting?.[lifetime] }])) as State
  const lifecycle = createLifecycle<State, Declared>({ ...definition, state }, () => true, (options.options ?? {}) as PluginOptions, false)
  let started: Promise<void> | undefined

  const start = async () => {
    started ??= lifecycle.start(fake.claude, async (claude) => {
      const steps = await modSteps()
      return {
        name,
        root,
        version: '0.0.0',
        store: storeFolder({ HOME: await claude.env.home(), XDG_DATA_HOME: await claude.env.dataHome() }),
        isInstalled: true,
        shouldRecord: false,
        steps,
        granted: options.permissions ?? steps.permissions ?? [],
      }
    })
    await started
    const { failure } = lifecycle
    if (failure instanceof MissingOptions) {
      const given = failure.keys.map((key) => `${key}: …`).join(', ')
      throw new Error(`${name} needs ${listed(failure.titles)}, which a person sets in /config. Give ${failure.keys.length === 1 ? 'it' : 'them'} to the tested mod: testMod(mod, { options: { ${given} } }).`)
    }
    if (lifecycle.phase !== 'active') throw failure ?? new Error(`${name} did not start: the lifecycle is ${lifecycle.phase}.`)
  }

  const route = async <N extends RoutedEvent>(event: N, input: unknown, below: unknown): Promise<EventResult<N>> => {
    await start()
    return lifecycle.route(event, input as Frozen<Args<N>>, async (e) => (below ?? claudeCodeAnswer(event, e)) as EventResult<N>)
  }

  const drawPane = async (paneId: string) => {
    await start()
    if (!fake.shown.openPanes.has(paneId)) {
      const opening = [...fake.shown.commands.map((command) => `tested.type('/${command}')`), 'pane.open() in the mod'].join(', or with ')
      throw new Error(`The pane "${paneId}" of ${name} is not open, and a user sees a pane only while it is open. Open it first with ${opening}.`)
    }
    const opened = fake.calls.findLast((call) => call.call === 'ui.open' && (call.args[0] as PaneOpenArgs).id === paneId)?.args[0] as PaneOpenArgs | undefined
    const columns = opened?.columns ?? defaultColumns
    const isFocused = (await fake.claude.ui.panes()).some((open) => open.id === paneId && open.isFocused)
    const props: RenderPropsOf['Pane'] = { title: opened?.title ?? paneId, isFocused, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: defaultRows }, view: {} }
    const drawing = await route('ui.render', { surface: 'terminal', component: 'Pane', requestId: paneId, props }, elements.Box({}))
    return { drawing, columns }
  }

  const drawnElement = async (paneId: string, type: 'Button' | 'Input' | 'Select' | 'Markdown', key: string) => {
    const props = findElement((await drawPane(paneId)).drawing, type, key)
    if (props === undefined) throw new Error(`The pane "${paneId}" of ${name} draws no ${type} with the ${type === 'Button' ? 'key or label' : 'key'} "${key}".`)
    return props
  }

  const eventIn = (paneId: string, key: string) => ({ plugin: name, element: key, component: 'Pane' as const, requestId: paneId, surface: 'terminal' as const })

  const drawSlot = async (component: RenderComponent, props: object, requestId = `${component}_${(slotDraws += 1)}`) => {
    await start()
    const input = { surface: 'terminal', component, requestId, props } as Frozen<Args<'ui.render'>>
    const drawing = await lifecycle.route('ui.render', input, async (e) => plainOutput(e as Args<'ui.render'>))
    return { drawing, columns: defaultColumns }
  }

  const fire = ((event: string, input: object, below?: unknown) => {
    if (event.includes('.')) return route(event as RoutedEvent, input, below)
    if (event === 'SessionStart') sessionId = (input as { session_id?: string }).session_id ?? sessionId
    if (event === 'UserPromptSubmit') {
      cwd = cwdAfterPrompt ?? cwd
      cwdAfterPrompt = undefined
    }
    const toolUse = toolUseEvents.includes(event) ? { tool_use_id: `toolu_${(toolUses += 1)}` } : {}
    const filled = { session_id: sessionId, transcript_path: '/test/transcript.jsonl', cwd, hook_event_name: event, ...toolUse, ...input }
    if (event !== 'PreToolUse') return route(`classic.${event as Exclude<ModEvent, 'PreToolUse'>}`, filled, below)
    return firePreToolUse(filled as ClassicHookInputs['PreToolUse'], below as { deny?: string } | undefined)
  }) as TestedMod<State>['fire']

  const firePreToolUse = async ({ tool_name, tool_input, tool_use_id, agent_id, agent_type }: ClassicHookInputs['PreToolUse'], below: { deny?: string } | undefined) => {
    await start()
    if (agent_id !== undefined && agent_type !== undefined) firedAgents.set(agent_id, agent_type)
    const envelope = { ...(tool_input as object), tool: tool_name, tool_use_id, ...(agent_id === undefined ? {} : { agentId: agent_id }) } as Frozen<Args<'tool.call'>>
    const asks: EventResult<'tool.check'> = below?.deny === undefined ? { decision: 'ask' } : { decision: 'deny', reason: below.deny }
    let reached = envelope
    let check = asks
    const answer = await lifecycle.route('tool.call', envelope, async (e) => {
      reached = e
      check = await lifecycle.route('tool.check', { tool: e.tool, input: toolInputOf(e), tool_use_id: e.tool_use_id, ...(e.agentId === undefined ? {} : { agentId: e.agentId }) }, async () => asks)
      return (check.decision === 'deny' ? { deny: check.reason ?? '' } : { result: '' }) as EventResult<'tool.call'>
    })
    const updatedInput = toolInputOf(reached)
    const decided = check === asks ? {} : check.decision === 'allow' ? { allow: true } : check.decision === 'ask' ? { ask: check.reason ?? '' } : {}
    return {
      ...(answer.deny === undefined ? decided : { deny: answer.deny }),
      ...(JSON.stringify(updatedInput) === JSON.stringify(tool_input) ? {} : { updatedInput }),
      ...(answer.context === undefined || answer.context.length === 0 ? {} : { additionalContext: [...answer.context] }),
    } as EventResult<'classic.PreToolUse'>
  }

  return {
    start,
    fire,
    settle: fake.settle,
    lines: (async (target: string | { readonly component: RenderComponent }, props: object = {}, requestId?: string) => {
      const { drawing, columns } = typeof target === 'string' ? await drawPane(target) : await drawSlot(target.component, props, requestId)
      return rowsOf(drawing, columns).map((row) => row.trimEnd())
    }) as TestedMod<State>['lines'],
    async type(line) {
      const typed = /^\/(\S+)\s*(.*)$/s.exec(line)
      if (typed === null) throw new Error(`type takes a slash command the way the user types it, such as tested.type('/help'), and "${line}" does not start with /.`)
      const [, command = '', args = ''] = typed
      const unanswered: CommandRunResult = {}
      const answer = await route('command.run', { command, args, origin: { kind: 'composer' }, presentation }, unanswered)
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
    async press(paneId, key, link) {
      const props = await drawnElement(paneId, link === undefined ? 'Button' : 'Markdown', key)
      if (link !== undefined && props['onLinkPress'] === undefined) throw new Error(`The Markdown "${key}" in the pane "${paneId}" of ${name} has no onLinkPress, so Claude Code opens its links itself.`)
      const pressed: UiPressArgument = { ...eventIn(paneId, String(props['key'])), ...(link === undefined ? {} : { link: { href: link } }) }
      await lifecycle.route('ui.press', pressed as Frozen<Args<'ui.press'>>, async (e) => {
        if (e.link === undefined) await (props['onPress'] as (e: UiPressArgument) => unknown)(e)
        else await (props['onLinkPress'] as (link: PressedLink, e: UiPressArgument) => unknown)(e.link, e)
        return { element: e.element }
      })
    },
    async input(paneId, key, text, kind = 'submit') {
      const props = await drawnElement(paneId, 'Input', key)
      const typed: UiInputArgument = { ...eventIn(paneId, key), kind, value: text }
      await (props[kind === 'submit' ? 'onSubmit' : 'onInput'] as ((value: string, e: UiInputArgument) => unknown) | undefined)?.(text, typed)
    },
    async select(paneId, key, value) {
      const props = await drawnElement(paneId, 'Select', key)
      const options = (props['options'] as readonly { readonly value: string }[]).map((option) => option.value)
      if (!options.includes(value)) throw new Error(`The Select "${key}" in the pane "${paneId}" of ${name} has no option "${value}". Its options are ${options.map((option) => `"${option}"`).join(', ')}.`)
      const picked: UiSelectArgument = { ...eventIn(paneId, key), value }
      await (props['onSelect'] as (value: string, e: UiSelectArgument) => unknown)(value, picked)
    },
    async moveTo(nextRoot, nextCwd = nextRoot) {
      await start()
      if (nextRoot !== projectRoot) {
        await lifecycle.route('command.run', { command: 'cd', args: nextRoot, origin: { kind: 'composer' }, presentation }, async () => {
          projectRoot = nextRoot
          cwdAfterPrompt = nextRoot
          return {}
        })
        if (nextCwd === nextRoot) return
      }
      cwd = nextCwd
      cwdAfterPrompt = undefined
      await fire('PostToolUse', { tool_name: 'Bash', tool_input: { command: `cd '${nextCwd}'` }, tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false } })
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

function fakeDependencies(dependencies: NonNullable<TestOptions<object>['dependencies']>): Claude['cmod']['call'] {
  const apis = dependencies as Readonly<Record<string, Parameters<typeof answerCall>[1] | undefined>>
  return async (call) => {
    const api = apis[call.to]
    const answer = api === undefined ? { deny: notInstalled(call.to) } : await answerCall(call.to, api, call)
    if (answer.deny !== undefined) throw new Error(answer.deny)
    return answer.value
  }
}

function claudeCodeAnswer(event: RoutedEvent, e: unknown): unknown {
  if (event !== 'prompt.submit') return {}
  const { text, context, origin } = e as Args<'prompt.submit'>
  return { text, ...(context === undefined ? {} : { context }), origin }
}

function plainOutput({ component, props }: Args<'ui.render'>): RenderElement {
  const rows = Object.entries(props).map(([key, value]) => elements.Text({ children: `${key}: ${JSON.stringify(value)}` }))
  return elements.Box({ flexDirection: 'column', children: [elements.Text({ children: component }), elements.Box({ flexDirection: 'column', paddingLeft: 2, children: rows })] })
}

function replyOf({ text, context }: CommandRunResult): Reply {
  return { ...(text === undefined ? {} : { text }), ...(context === undefined ? {} : { context: context.join('\n') }) }
}

async function modSteps(): Promise<Steps> {
  const manifest = '../../../package.json'
  const loaded: unknown = await import(manifest, { with: { type: 'json' } }).then(
    (module: { default: unknown }) => module.default,
    () => undefined,
  )
  return readSteps(loaded) ?? {}
}

function installJsx(): void {
  const scope = globalThis as unknown as Record<string, unknown>
  scope['h'] ??= (tag: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
    if (typeof tag !== 'function') throw new Error(`JSX tag "${String(tag)}" is not an element. Import elements such as Box from node_modules/@cmodjs/core/ui/elements.js.`)
    return tag({ ...props, children })
  }
  scope['Fragment'] ??= (props: { children?: RenderChildren }) => elements.Box({ flexDirection: 'column', children: props.children })
}
