import type {
  Args,
  ClassicHookInputs,
  CmodDependencies,
  CommandPresentation,
  CommandRunResult,
  ElementTable,
  EventResult,
  Frozen,
  MarkdownProps,
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
import type { CommandReply } from './jobs/slash-command.js'
import type { InterfaceMethods, InterfaceName, ModDefinition, Provided } from './mod.js'
import type { Options, OptionValues } from './options.js'
import { hotkeyCommand, readSteps, type Steps } from './records.js'
import { heldInput, type Claude } from './runtime/claude.js'
import { answerCall, cmodPluginName, loadedMethod, notInstalled } from './runtime/dependencies.js'
import { closingContext, foldBefore, installBefore, withAnswer, type Answers, type Decide } from './runtime/before.js'
import { permissionRoutes } from './runtime/permission-check.js'
import type { RoutedEvent } from './runtime/hooks.js'
import { keepClaudeCode, type ClaudeCode } from './testing/claude-code.js'
import { createRouter } from './runtime/router.js'
import { toolInputOf } from './runtime/tool-calls.js'
import { createLifecycle } from './runtime/lifecycle.js'
import { cmodStore } from './runtime/programs.js'
import { serveCmodPlugin } from './register.js'
import { MissingOptions } from './runtime/options.js'
import { conversationMethods, pickedColor, type SessionColor } from './runtime/sessions.js'
import type { ShownToast } from './runtime/toaster.js'
import { deviceNote } from './session/context/turn/device.js'
import { Message } from './session/context/turn/message/message.js'
import { Note, untagged } from './session/context/turn/message/note.js'
import { Prompt } from './session/context/turn/message/prompt.js'
import { Mod, Person } from './session/context/turn/message/sender.js'
import type { SessionChange } from './session/conversation.js'
import { TurnEnd, type Turn } from './session/context/turn/turn.js'
import { beforeEvents, processEvents, sessionEvents, type AnswerOf, type BeforeEvent, type BeforeName, type CommandRun, type CommandRunAnswer, type Placement, type ProcessAnswer, type ProcessAsked, type ProcessName, type ProcessPayload } from './session/session.js'
import { ContextEnd } from './session/context/context.js'
import { TaskStart } from './session/goal/task.js'
import { calledAnswer, fakeAgent, fakeClaude, type Fakes, type Shown as ShownByClaude, type TestCall } from './testing/fake-claude.js'
import { checkKeys, elements, findElement, focusableKey, rowsOf } from './testing/fake-elements.js'
import { fakeFiles } from './testing/fake-files.js'
import { fakeSessions, type FakeSession, type FakeSessions, type MessageDraft, type StartedTask } from './testing/fake-sessions.js'
import { listed, messageOf } from './utils/text.js'
import { componentOf, type KindProps, type Row, type StyledAt } from './ui/styles.js'
import { AbovePrompt, areas, BelowPrompt, Dashboard, TurnEnd as TurnEndArea, Working, type Area } from './ui/areas.js'
import { drawWith, elementOf, forClaudeCode } from './ui/elements.js'
import { drawnParts, pagesOf, providedBy, serveParts, viewsOf } from './runtime/parts.js'
import { serveWidgets, type Widgets } from './runtime/widgets.js'
import { engineOf } from './runtime/engine.js'
import { createProviders, interfaceMethods, styleInterface, type Provided as ProvidedHandle, type Providers, type ServedProviders } from './runtime/interfaces.js'
import { inheriting, openLink, partMethods, type DrawnPart, type PartPress, type PartRequest, type PartsUpdate } from './runtime/ui.js'

export type { Fakes, TestCall } from './testing/fake-claude.js'
export type { FakeSession, MessageDraft, StartedTask } from './testing/fake-sessions.js'
export type { RoutedEvent } from './runtime/hooks.js'
export type { ShownToast } from './runtime/toaster.js'

export type ShownPart = {
  readonly id: string
  readonly params: unknown
  lines(options?: { readonly columns?: number }): Promise<string[]>
  press(key: string, link?: string): Promise<void>
  input(key: string, text: string, type?: 'change' | 'submit'): Promise<void>
  select(key: string, value: string): Promise<void>
  focusedKey(): Promise<string | undefined>
}

export type Shown = ShownByClaude & { readonly toasts: readonly ShownToast[]; readonly sent: FakeSessions['sent']; readonly pane: ShownPart; readonly view: ShownPart; readonly page: ShownPart }

export type FakeProvider = {
  readonly [Name in InterfaceName]: { readonly name: Name; readonly mod: string; readonly program?: string; readonly device?: { readonly id: string; readonly name: string }; readonly isStarted?: false; readonly methods: InterfaceMethods<Name> }
}[InterfaceName]

export type TestOptions<State extends object, Declared extends Options = Options, Given extends readonly FakeProvider[] = readonly FakeProvider[]> = {
  readonly state?: { readonly [Lifetime in keyof State]?: Partial<State[Lifetime]> }
  readonly options?: Partial<OptionValues<Declared>>
  readonly scope?: 'user' | 'project'
  readonly projectRoot?: string
  readonly cwd?: string
  readonly dependencies?: { readonly [Name in keyof CmodDependencies]?: CmodDependencies[Name] }
  readonly files?: Readonly<Record<string, string>>
  readonly links?: Readonly<Record<string, string>>
  readonly secrets?: Readonly<Record<string, string>>
  readonly sessions?: readonly FakeSession[]
  readonly providers?: Given
}

type Placed<Payload> = Omit<Payload, keyof Placement> & Partial<Placement>

type MessageBefore = Exclude<BeforeName, 'TaskStart' | 'TurnEnd' | 'ContextEnd'>

type DraftOf<Name extends MessageBefore> = Omit<Extract<MessageDraft, { readonly type: (typeof sessionEvents)[Name] }>, 'type'>

type RaisedOf<Name extends MessageBefore> = Name extends 'ToolResult' ? Omit<DraftOf<Name>, 'output'> & { readonly output: unknown } : DraftOf<Name>

export type Raise = {
  readonly [Name in MessageBefore as `before${Name}`]: (message: RaisedOf<Name>, options?: { readonly task?: string }) => Promise<AnswerOf<Name> | undefined>
} & {
  beforeTaskStart(task: { readonly title: string; readonly agentType?: string; readonly model?: string }): Promise<AnswerOf<'TaskStart'> | undefined>
  beforeTurnEnd(ending?: Pick<Turn, 'answer' | 'failure'>): Promise<AnswerOf<'TurnEnd'> | undefined>
  beforeContextEnd(options?: { readonly task?: string }): Promise<AnswerOf<'ContextEnd'> | undefined>
} & {
  readonly [Name in ProcessName as `on${Name}`]: (payload: Placed<ProcessPayload[Name]>) => Promise<void>
} & {
  readonly [Name in keyof ProcessAnswer as `before${Name}`]: (payload: Placed<ProcessAsked[Name]>) => Promise<ProcessAnswer[Name] | undefined>
} & {
  onRun(run: Placed<CommandRun>): Promise<void>
  beforeRun(run: Placed<CommandRun>): Promise<CommandRunAnswer | undefined>
}

type FiredEvent = 'ui.render' | 'ui.scroll' | 'ui.close' | 'cmod.call' | 'tool.check' | 'prompt.context'

export type TestedMod<State extends object, Given extends readonly FakeProvider[] = readonly FakeProvider[]> = {
  start(): Promise<void>
  readonly raise: Raise
  fire<N extends FiredEvent>(event: N, input: Args<N>, below?: EventResult<N>): Promise<EventResult<N>>
  settle(): Promise<void>
  add(message: MessageDraft, options?: { readonly task?: string }): Promise<Message[]>
  endTurn(ending?: Pick<Turn, 'answer' | 'failure'>, options?: { readonly task?: string }): Promise<void>
  compact(): Promise<void>
  startSession(start: { readonly source: 'startup' | 'resume' | 'clear' | 'fork'; readonly id?: string }): Promise<void>
  startTask(task: StartedTask): Promise<string>
  lines(area: Area, props?: { readonly columns?: number }): Promise<string[]>
  lines<K extends Row>(kind: K, props: KindProps<K>, requestId?: string): Promise<string[]>
  type(line: string): Promise<CommandReply>
  hotkey(name: string): Promise<void>
  callTool(name: string, input: Record<string, unknown>): Promise<EventResult<'tool.call'>>
  press(area: Area, key: string): Promise<void>
  moveTo(projectRoot: string, cwd?: string): Promise<void>
  readonly api: Readonly<Record<string, (input?: unknown) => Promise<unknown>>>
  readonly state: Readonly<State>
  readonly calls: readonly TestCall[]
  readonly fakes: Fakes
  readonly shown: Shown
  readonly providers: { readonly [Index in keyof Given]: Provided<Given[Index]['name']> & { start(): void } }
}

const defaultColumns = 80

const defaultRows = 24

const presentation: CommandPresentation = { isFullscreen: false, columns: defaultColumns }

const toolUseEvents: readonly string[] = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied']

const areaComponents = { [AbovePrompt]: 'AbovePrompt', [BelowPrompt]: 'PromptHint', [Working]: 'Spinner', [TurnEndArea]: 'TurnDuration', [Dashboard]: 'Pane' } as const satisfies Readonly<Record<Area, RenderComponent>>

function drawnByStyle(key: string): (drawnKey: string) => boolean {
  return (drawnKey) => {
    if (!drawnKey.endsWith(`:${key}`)) return false
    const scoped = drawnKey.slice(0, -key.length - 1)
    const block = scoped.slice(scoped.lastIndexOf(':') + 1)
    return block !== scoped && /^\d+$/.test(block)
  }
}

export function testMod<State extends object, Declared extends Options = Options, const Given extends readonly FakeProvider[] = readonly FakeProvider[]>(definition: ModDefinition<State, string, Declared>, options: TestOptions<State, Declared, Given> = {}): TestedMod<State, Given> {
  installJsx()
  const name = definition.name
  const given: readonly FakeProvider[] = options.providers ?? []
  for (const each of given) {
    if (each.program !== undefined) continue
    if (each.mod === name) throw new Error(`${name} is the tested mod, so its own provide answers ${each.name}. Fake another mod's provider, or a program's with program: '<executable>'.`)
    if (each.device !== undefined) throw new Error(`${each.mod}'s session code provides ${each.name} only in this session, on this computer, so it takes no device. Give the program that provides it on ${each.device.name}, with program: '<executable>'.`)
  }
  const isProjectPlugin = options.scope === 'project'
  let projectRoot = options.projectRoot ?? (isProjectPlugin ? '/test/project' : `/test/plugins/${name}`)
  const root = isProjectPlugin ? `${projectRoot}/.claude/skills/${name}` : `/test/plugins/${name}`
  const fake = fakeClaude({ name, root })
  let cwd = options.cwd ?? projectRoot
  let cwdAfterPrompt: string | undefined
  let sessionId = 'test-session'
  let answeredId = sessionId
  let toolUses = 0
  let slotDraws = 0
  fake.claude.session.id = async () => answeredId
  fake.claude.session.info = async () => ({ transcriptPath: `/test/transcripts/${answeredId}.jsonl` })
  fake.claude.session.root = async () => projectRoot
  fake.claude.session.cwd = async () => cwd
  const conversations = fakeSessions({
    callTool: (args: Parameters<Claude["tool"]["call"]>[0]) => fake.claude.tool.call(args),
    listAgents: () => fake.fakes.agent.list?.() ?? Promise.resolve([]),
    project: () => projectRoot,
    cwd: () => cwd,
    given: options.sessions ?? [],
    decide: (event, change) => decide()(event, change),
    push: (mod, session, change) => {
      if (mod !== name) return
      const pushed = { to: mod, method: conversationMethods.changed, input: { session, change }, caller: cmodPluginName } as unknown as Frozen<Args<'cmod.call'>>
      void lifecycle.route('cmod.call', pushed, async () => ({ deny: notInstalled(mod) }))
    },
  })
  conversations.start(sessionId)
  const callMod = async (method: string, input: unknown, caller = cmodPluginName) => calledAnswer(caller, await lifecycle.route('cmod.call', { to: name, method, input, caller } as unknown as Frozen<Args<'cmod.call'>>, async () => ({ deny: notInstalled(name) })))
  const tellColor = async (told: SessionColor) => {
    if (name !== cmodPluginName) await callMod(conversationMethods.sessionColor, told)
  }
  const tellHeldColor = async () => {
    const held = conversations.color()
    if (held.color !== undefined) await tellColor(held)
  }
  let declaredViews: ReturnType<typeof viewsOf> = []
  let declaredPages: ReturnType<typeof pagesOf> = []
  let openPages: { readonly id: string; readonly params: unknown }[] = []
  let shownPage: { readonly id: string; readonly params: unknown; readonly isFocused: boolean } | undefined
  const tellShown = () => callMod(partMethods.shown, { open: openPages, shown: shownPage?.id ?? null, isFocused: shownPage?.isFocused ?? false })
  const modeled = new Set<Promise<unknown>>()
  const modeling = <Value>(work: Promise<Value>): Promise<Value> => {
    modeled.add(work)
    void work.finally(() => modeled.delete(work)).catch(() => undefined)
    return work
  }
  const settle = async () => {
    await fake.settle()
    while (modeled.size > 0) {
      await Promise.allSettled(modeled)
      await fake.settle()
    }
  }
  let focused: { readonly part: string; readonly key: string } | undefined
  const forgetFocus = (part: string) => {
    if (focused?.part === part) focused = undefined
  }
  const holdsKeyboard = async (isPane: boolean, id: string) => (isPane ? (await fake.claude.ui.panes()).some((open) => open.id === id && open.isFocused) : shownPage?.id === id && shownPage.isFocused)
  const refusedFocus = async (isPane: boolean, id: string, key: string): Promise<string | undefined> => {
    const pane = isPane ? id : 'sidebar'
    if (!(await holdsKeyboard(isPane, id))) return `the pane "${pane}" does not hold the keyboard`
    const drawn = lifecycle.phase === 'active' ? (isPane ? await drawPane(id) : await drawInSidebar(id)).drawing : undefined
    if (drawn === undefined || focusableKey(drawn, (props) => props['key'] === key) === undefined) return `the pane "${pane}" draws no Button, Input, or Select with the key "${key}"`
    return undefined
  }
  const applyRequests = async (requests: readonly PartRequest[]) => {
    for (const request of requests) {
      if ('open' in request) {
        const isSettings = declaredViews.some((view) => view.id === request.open && view.place === 'settings')
        if (!isSettings) openPages = [...openPages.filter((page) => page.id !== request.open), { id: request.open, params: request.params ?? null }]
        shownPage = { id: request.open, params: request.params ?? null, isFocused: request.focus === true }
        if (request.focus === true) forgetFocus(`sidebar:${request.open}`)
      } else if ('close' in request) {
        openPages = openPages.filter((page) => page.id !== request.close)
        if (shownPage?.id === request.close) shownPage = undefined
      } else if ('focus' in request) {
        const key = `${name}/${request.focus}:${request.key}`
        const refused = await refusedFocus(false, request.focus, key)
        if (refused === undefined) focused = { part: `sidebar:${request.focus}`, key: request.key }
        else reportPart(`pages:${name}`, `Could not show the view or page ${name} asked for`, new Error(`cmod: Claude Code did not focus "${key}" in the Sidebar pane: ${refused}`))
      } else if ('settings' in request) {
        const first = declaredViews.find((view) => view.place === 'settings')
        shownPage = first === undefined ? undefined : { id: first.id, params: null, isFocused: true }
        if (first !== undefined) forgetFocus(`sidebar:${first.id}`)
      }
    }
    await tellShown()
  }
  let widgets: Promise<Widgets> | undefined
  let provides: readonly string[] = []
  const ownMarkdown = new Map<string, DrawnPart | null>()
  const missedMarkdown = new Map<string, { readonly markdown: string } & StyledAt>()
  const updated = async ({ parts, redraw, changed, requests }: PartsUpdate) => {
    if (parts !== undefined) {
      declaredViews = viewsOf(parts)
      declaredPages = pagesOf(parts)
      const before = provides
      provides = providedBy(parts)
      for (const named of new Set([...before, ...provides])) if (before.includes(named) !== provides.includes(named)) await served.providersChanged(named)
      ownMarkdown.clear()
    }
    if (parts !== undefined || redraw !== undefined || changed !== undefined) (await widgetsOf()).update(name, { ...(parts === undefined ? {} : { parts }), ...(redraw === undefined ? {} : { redraw }), ...(changed === undefined ? {} : { changed }) })
    if (requests !== undefined && requests.length > 0) await applyRequests(requests)
  }
  const pressPart = (input: PartPress) => callMod(partMethods.press, input).then((update) => updated((update ?? {}) as PartsUpdate))
  const markdownIn = (table: ElementTable, at: StyledAt) => {
    let unkeyed = 0
    return (props: MarkdownProps): RenderElement => {
      if (!provides.includes(styleInterface)) return table.Markdown(props)
      const keyPrefix = `${name}/markdown:${props.key ?? unkeyed++}:`
      const drawnAt = `${at.surface}\u0000${at.columns}\u0000${props.text}`
      const drawn = ownMarkdown.get(drawnAt)
      if (drawn === undefined) missedMarkdown.set(drawnAt, { markdown: props.text, ...at })
      if (drawn === undefined || drawn === null || drawn.tree === null) return table.Markdown(props)
      const { draw, tree } = drawn
      return drawWith(table, () => elementOf(tree, keyPrefix, (handler, args) => void pressPart({ draw, handler, args })), inheriting(props, table.Markdown)) as RenderElement
    }
  }
  const withOwnMarkdown = async <Drawn>(draw: () => Promise<Drawn>): Promise<Drawn> => {
    const first = await draw()
    if (missedMarkdown.size === 0) return first
    for (const [drawnAt, input] of missedMarkdown) ownMarkdown.set(drawnAt, (await callMod(partMethods.draw, input)) as DrawnPart | null)
    missedMarkdown.clear()
    return draw()
  }
  const refusals: string[] = []
  const reportPart = (id: string, message: string, error: unknown) => {
    if (id.startsWith('refused:')) refusals.push(messageOf(error))
    fake.claude.ui.log(`cmod: ${message}: ${messageOf(error)}`, { to: 'debug' })
  }
  const openFromCmod = (href: string, press: UiPressArgument) => void openLink(fake.claude, href, press.surface).catch((error: unknown) => reportPart('open-link', 'Could not open the link', error))
  const cmodClaude: Claude = {
    ...fake.claude,
    ui: { ...fake.claude.ui, resolve: (e) => forClaudeCode(fake.claude.ui.resolve(e), e.surface, openFromCmod) },
    cmod: { call: async (input) => (input.to === name ? callMod(input.method, input.input) : fake.claude.cmod.call(input)) },
  }
  const tellRefusedPress = (_mod: string, error: unknown) => fake.claude.ui.log(`cmod: ${name} did not take the press: ${messageOf(error)}`, { to: 'debug' })
  const parts = drawnParts({ claude: cmodClaude, report: reportPart, press: (mod: string, input: PartPress) => void pressPart(input).catch((error: unknown) => tellRefusedPress(mod, error)) })
  const servedWidgets = async (): Promise<Widgets> => {
    const own = name === cmodPluginName && lifecycle.mod !== undefined ? engineOf(lifecycle.mod).widgets : undefined
    if (own !== undefined) return own
    return serveWidgets({
      claude: cmodClaude,
      router: cmodPlugin,
      store: await cmodStore(fake.claude),
      report: reportPart,
      turnClosedBy: () => conversations.lastTurn(),
      parts,
      markdownIn,
    })
  }
  const widgetsOf = () => (widgets ??= servedWidgets())
  const cmodBeneath = createRouter()
  const servedParts = serveParts({ claude: cmodClaude, router: cmodBeneath, report: reportPart, tellRefusedPress, widgets: { update: (mod, update) => void widgetsOf().then((served) => served.update(mod, update)) }, parts, tellStylers: () => undefined, tellUi: () => undefined, tellProviders: (names) => void Promise.all(names.map((named) => served.providersChanged(named))).catch(report) })
  servedParts.apply((_mod, requests) => applyRequests(requests))
  const after: Claude['clock']['after'] = (ms, run) => fake.claude.clock.after(ms, run)
  const report = (error: unknown) => reportPart('interfaces', 'A provider listener failed', error)
  const sessionMods = new Map<string, Providers>()
  const served = fake.serve.connect({
    tell: (_caller, heard) => new Promise((resolve) => fake.claude.clock.after(0, () => resolve(callMod(interfaceMethods.heard, heard)))),
    sessionCode: (named) => [...(provides.includes(named) ? [name] : []), ...[...sessionMods].filter(([, each]) => each.provided().includes(named)).map(([mod]) => mod)],
    device: async () => {
      const { id, name: deviceName } = await fake.claude.device.read()
      return { id, name: deviceName }
    },
    after,
    report,
  })
  const inSession = (index: number) => {
    const { name: named, mod, methods } = given[index] as FakeProvider
    const made = sessionMods.get(mod) ?? createProviders({ name: mod, call: (_to, method, input) => served.answer(method, input, mod) ?? Promise.reject(new Error(`${mod} reaches no ${method} in the test kit.`)), changed: () => undefined, after, report })
    sessionMods.set(mod, made)
    return made.provide(named, methods)
  }
  const asProgram = (index: number) => {
    const { name: named, mod, program, device, methods } = given[index] as FakeProvider
    return { name: named, mod, program: program as string, ...(device === undefined ? {} : { device }), methods }
  }
  const isFirst = (index: number) => given[index]?.isStarted !== false
  const inSessionChanged = async (index: number, handle: ProvidedHandle) => {
    await served.providersChanged((given[index] as FakeProvider).name)
    return handle
  }
  const providedInSession = given.map((each, index) => (each.program === undefined && isFirst(index) ? inSession(index) : undefined))
  const late = new Map<number, Promise<ProvidedHandle>>()
  const startLate = (index: number) => {
    const known = late.get(index)
    if (known !== undefined) return known
    const started = fakeProviders().then(async () => (given[index]?.program === undefined ? inSessionChanged(index, inSession(index)) : ((await fake.serve.provide([asProgram(index)], { after, report }))[0] as ProvidedHandle)))
    late.set(index, started)
    return started
  }
  let fakesReady: Promise<readonly (ProvidedHandle | undefined)[]> | undefined
  const fakeProviders = () =>
    (fakesReady ??= (async () => {
      const first = given.flatMap((each, index) => (each.program !== undefined && isFirst(index) ? [index] : []))
      const programs = await fake.serve.provide(first.map(asProgram), { after, report })
      return given.map((_each, index) => providedInSession[index] ?? (first.includes(index) ? programs[first.indexOf(index)] : undefined))
    })())
  const fakeProvider = (index: number): ProvidedHandle & { start(): void } => {
    const reached = async (): Promise<ProvidedHandle> => {
      const started = late.get(index)
      const each = (await fakeProviders())[index] ?? (started === undefined ? undefined : await started)
      if (each === undefined) throw new Error(`The test kit's fake provider ${index} has isStarted: false, so start() it before it tells, asks, or leaves.`)
      await fake.settle()
      return each
    }
    return {
      start: () => {
        if (isFirst(index)) throw new Error(`The test kit's fake provider ${index} runs from the start. Give it isStarted: false to start it later.`)
        void modeling(startLate(index).then(() => fake.settle()))
      },
      remove: () => void modeling(reached().then((each) => (each.remove(), given[index]?.program === undefined ? inSessionChanged(index, each) : each))),
      tell: (event, payload) => void modeling(reached().then((each) => each.tell(event, payload))),
      ask: (event, payload) => modeling(reached().then((each) => each.ask(event, payload))),
    }
  }
  const fakedPrograms = new Set(given.flatMap(({ mod, program }) => (mod === name && program !== undefined ? [program] : [])))
  const spawnUnlessFaked = fake.claude.process.spawn
  fake.claude.process.spawn = (request) => {
    const [, command, mod] = request.argv
    const at = request.argv.indexOf('--')
    const executable = at === -1 ? undefined : request.argv[at + 1]?.split('/').at(-1)
    if (command !== 'program' || mod !== name || request.argv.includes('--remove-service') || executable === undefined || !fakedPrograms.has(executable)) return spawnUnlessFaked(request)
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }) } as never
  }
  const dependencies = fakeDependencies(name, options.dependencies ?? {}, conversations, served, sessionMods)
  fake.fakes.cmod.call = async (call) => {
    if (call.to !== cmodPluginName || call.method !== partMethods.changed) return dependencies(call)
    const { requests, isAsked, ...listing } = call.input as PartsUpdate
    const isHeld = isAsked === true && requests !== undefined && servedParts.update(name, { requests, isAsked })
    await updated(isAsked === true ? listing : (call.input as PartsUpdate))
    return { isHeld }
  }
  const appendRow = fake.claude.session.append
  fake.claude.session.append = async (args) => {
    const added = await appendRow(args)
    if (added.deny === undefined) conversations.add({ type: Note, text: args.message.content.map((block) => (typeof block['text'] === 'string' ? block['text'] : '')).join(''), from: { type: Mod, name } })
    return added
  }
  let isInputHeld = false
  const runUnlessHeld = fake.claude.command.run
  fake.claude.command.run = async (args) => {
    if (isInputHeld) throw new Error(`${name}: $.command.run: ${heldInput}`)
    return runUnlessHeld(args)
  }
  const submitRow = fake.claude.prompt.submit
  fake.claude.prompt.submit = async (args) => {
    const submitted = await submitRow(args)
    conversations.add({ type: Prompt, text: args.text, from: { type: Mod, name, ...(args.asUser === true ? { as: Person } : {}) } })
    return submitted
  }
  const openPane = fake.claude.ui.open
  fake.claude.ui.open = async (pane) => {
    if (pane.focus === true) forgetFocus(`pane:${pane.id}`)
    return openPane(pane)
  }
  const focusOnce = fake.claude.ui.focus
  fake.claude.ui.focus = (args) =>
    modeling(
      (async () => {
        const answer = await focusOnce(args)
        if (answer.deny !== undefined || !fake.shown.openPanes.has(args.requestId)) return answer
        const refused = await refusedFocus(true, args.requestId, args.key)
        if (refused !== undefined) return { deny: refused }
        focused = { part: `pane:${args.requestId}`, key: args.key }
        return answer
      })(),
    )
  const secrets = new Map(Object.entries(options.secrets ?? {}))
  const runProcess = fake.claude.process.run
  fake.claude.process.run = async (argv, init) => {
    const [program, command, action, mod, key] = argv
    if (program?.split('/').at(-1) !== 'cmod' || command !== 'secrets' || mod !== name || key === undefined) return runProcess(argv, init)
    const answer = (stdout: string, stderr = '') => ({ exitCode: stderr === '' ? 0 : 1, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
    if (action === 'get') return answer(secrets.get(key) ?? '')
    if (action === 'delete') secrets.delete(key)
    else if (init?.stdin === undefined || init.stdin === '') return answer('', `cmod secrets: cmod secrets store read no value from stdin. cmod secrets delete ${name} ${key} deletes the secret.\n`)
    else secrets.set(key, init.stdin)
    return answer('')
  }
  const firedAgents = new Map<string, string>()
  const listAgents = fake.claude.agent.list
  fake.claude.agent.list = async () => {
    if (fake.fakes.agent.list !== undefined || firedAgents.size === 0) return listAgents()
    return [...firedAgents].map(([id, type]) => fakeAgent({ id, type, description: '', status: 'running' }))
  }
  const files = fakeFiles(options.files ?? {}, options.links)
  Object.assign(fake.fakes.fs, files)
  const starting = options.state as Record<string, object> | undefined
  const declared = Object.entries(definition.state ?? {}) as [string, object][]
  const state = Object.fromEntries(declared.map(([lifetime, values]) => [lifetime, { ...values, ...starting?.[lifetime] }])) as State
  const lifecycle = createLifecycle<State, Declared>({ ...definition, state }, () => permissionRoutes, (options.options ?? {}) as PluginOptions, false, definition.name === cmodPluginName ? serveCmodPlugin : undefined)
  let started: Promise<void> | undefined
  let isColorTold = false
  let deviceNoted: Promise<void> | undefined
  let hasSessionStarted = false
  const noteDevice = async () => {
    const at = new Date(await fake.claude.clock.now()).toISOString()
    const found = await fake.claude.device.read().catch((error: unknown) => {
      if (!(error instanceof Error)) throw error
      return undefined
    })
    if (found === undefined) return
    conversations.add({ type: Note, text: deviceNote(found, at), from: { type: Mod, name: cmodPluginName } })
    await fake.settle()
  }

  const start = async () => {
    started ??= fakeProviders().then(() =>
      lifecycle.start(fake.claude, async (claude) => ({
        name,
        root,
        version: '0.0.0',
        store: await cmodStore(claude),
        isInstalled: true,
        shouldRecord: false,
        steps: await modSteps(),
      })),
    )
    await started
    await fake.settle()
    const { failure } = lifecycle
    if (failure instanceof MissingOptions) {
      const given = failure.keys.map((key) => `${key}: …`).join(', ')
      throw new Error(`${name} needs ${listed(failure.titles)}, which a person sets in /config. Give ${failure.keys.length === 1 ? 'it' : 'them'} to the tested mod: testMod(mod, { options: { ${given} } }).`)
    }
    if (lifecycle.phase !== 'active') throw failure ?? new Error(`${name} did not start: the lifecycle is ${lifecycle.phase}.`)
    deviceNoted ??= noteDevice()
    await deviceNoted
    if (isColorTold) return
    isColorTold = true
    await tellHeldColor()
  }

  const cmodPlugin = createRouter()
  const askMod = async (event: BeforeEvent, change: SessionChange, signal?: AbortSignal) => {
    const asked = { to: name, method: conversationMethods.before, input: { session: sessionId, event, change }, caller: cmodPluginName } as unknown as Frozen<Args<'cmod.call'>>
    return calledAnswer(cmodPluginName, await lifecycle.route('cmod.call', asked, async () => ({ deny: notInstalled(name) }), signal))
  }
  const decide =
    (cancel?: AbortSignal): Decide =>
    (event, change) =>
      foldBefore(event, change, [(latest) => askMod(event, latest, cancel)], (error) => {
        if (cancel?.aborted !== true) fake.claude.ui.log(`cmod: passed the ${event} on without ${name}'s answer: ${messageOf(error)}`, { to: 'debug' })
      })
  installBefore({
    claude: fake.claude,
    router: cmodPlugin,
    hooks: {
      place: async () => conversations.place(),
      wants: async (event) => conversations.wants(name, event),
      fold: decide,
      failedBefore: () => undefined,
    },
  })

  const route = async <N extends RoutedEvent>(event: N, input: unknown, below: unknown, signal?: AbortSignal): Promise<EventResult<N>> => {
    await start()
    if ((event === 'turn.complete' && (input as Args<'turn.complete'>).isAborted) || (event === 'classic.Stop' && signal?.aborted === true)) isInputHeld = true
    if ((event === 'prompt.submit' || event === 'command.run' || event === 'ui.press') && (input as { readonly origin?: { readonly kind?: string } }).origin?.kind !== 'plugin') isInputHeld = false
    if (event === 'ui.render') {
      const { component, requestId } = input as Args<'ui.render'>
      if (component === 'Pane') fake.placePane(requestId)
      await widgetsOf()
      await fake.settle()
    }
    const answer = await cmodPlugin.dispatch(event, input as Frozen<Args<N>>, (passed) => lifecycle.route(event, passed, async (e) => (await claudeCodeRuns(event, e, below)) as EventResult<N>, signal), signal)
    await fake.settle()
    if (event === 'ui.render') checkKeys(answer as RenderElement, name, (input as Args<'ui.render'>).component)
    return answer
  }

  const claudeCodeRuns = async (event: RoutedEvent, e: unknown, below: unknown): Promise<unknown> => {
    if (event === 'session.compact' && (e as Args<'session.compact'>).trigger !== 'precompute') {
      const started = await fire('SessionStart', { source: 'compact' })
      fake.shown.notes.push(...(started.additionalContext ?? []).map(untagged))
    }
    if (below !== undefined) return below
    const answer = claudeCodeAnswer(event, e)
    if (event === 'ui.close') {
      const { id, origin } = e as Args<'ui.close'>
      if (origin.kind === 'person' && fake.shown.openPanes.has(id)) await drawPane(id)
      fake.shown.openPanes.delete(id)
      forgetFocus(`pane:${id}`)
    }
    if (event === 'agent.spawn') {
      const started = await route('classic.SubagentStart', { hook_event_name: 'SubagentStart', agent_id: (answer as { agentId: string }).agentId, agent_type: (e as Args<'agent.spawn'>).subagentType }, undefined)
      fake.shown.notes.push(...(started.additionalContext ?? []).map(untagged))
    }
    return answer
  }

  const runCommand = async (command: string, args: string, builtIn: CommandRunResult = {}): Promise<CommandRunResult> => {
    await start()
    isInputHeld = false
    const reached: Set<string> = new Set()
    const ownRun = async (): Promise<CommandRunResult> => (reached.add(command), builtIn)
    const answer = await cmodPlugin.dispatch('command.run', { command, args, origin: { kind: 'composer' }, presentation }, (passed) => lifecycle.route('command.run', passed, (e) => cmodBeneath.dispatch('command.run', e, ownRun)))
    if (reached.has(command) && answer.text === undefined) throw new Error(!fake.shown.commands.includes(command) ? `${name} has no slash command /${command}. Add it in setup with mod.use(slashCommand({ name: '${command}', … })).` : `${name}: /${command} reached Claude Code's own run of the command, so Claude Code shows "${name} registered /${command} but no command.run hook answered it". Answer it without calling next(e).`)
    return answer
  }

  const runColor = async (args: string): Promise<CommandRunResult> => {
    if (args.trim() === '') throw new Error(`Claude Code's /color with no color picks one at random, so a test names the color, such as tested.type('/color cyan').`)
    const color = pickedColor(args)
    const answer = await runCommand('color', args, { text: color === undefined ? 'Session color reset to default' : `Session color set to: ${color}` })
    await tellColor(conversations.recolor(color))
    return answer
  }

  const drawPane = async (paneId: string, asked?: number) => {
    await start()
    if (!fake.shown.openPanes.has(paneId)) throw new Error(`The pane "${paneId}" of ${name} closed, and a user sees a pane only while it is open.`)
    const opened = fake.calls.findLast((call) => call.call === 'ui.open' && (call.args[0] as PaneOpenArgs).id === paneId)?.args[0] as PaneOpenArgs | undefined
    const columns = asked ?? opened?.columns ?? defaultColumns
    const isFocused = (await fake.claude.ui.panes()).some((open) => open.id === paneId && open.isFocused)
    const props: RenderPropsOf['Pane'] = { title: opened?.title ?? paneId, isFocused, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: defaultRows }, view: {} }
    const drawing = await route('ui.render', { surface: 'terminal', component: 'Pane', requestId: paneId, props }, elements.Box({}))
    return { drawing, columns }
  }

  const drawInSidebar = async (id: string, columns = defaultColumns) => {
    await start()
    const shown = shownPage
    if (shown?.id !== id) throw new Error(`The view or page "${id}" of ${name} no longer shows, and a user sees one only while it shows.`)
    const drawn = (await callMod(partMethods.draw, { page: id, params: shown.params, columns, isFocused: shown.isFocused, surface: 'terminal' })) as DrawnPart | null
    await fake.settle()
    const tree = drawn?.tree ?? null
    const table = forClaudeCode(elements, 'terminal', openFromCmod)
    const drawing = tree === null || drawn === null ? elements.Box({}) : await withOwnMarkdown(async () => drawWith(table, () => elementOf(tree, `${name}/${id}:`, (handler, args) => void modeling(pressPart({ draw: drawn.draw, handler, args }))), markdownIn(table, { surface: 'terminal', columns })) as RenderElement)
    checkKeys(drawing, cmodPluginName, 'Pane')
    return { drawing, columns }
  }

  const shownNow = (kind: 'pane' | 'view' | 'page'): { readonly id: string; readonly params: unknown } => {
    if (kind === 'pane') {
      const id = [...fake.shown.openPanes].at(-1)
      if (id === undefined) throw new Error(`No pane of ${name} shows. Open one with pane.open(), from a slash command, a hotkey, or setup.`)
      return { id, params: undefined }
    }
    const shownKind = shownPage === undefined ? undefined : declaredPages.some((page) => page.id === shownPage?.id) ? 'page' : 'view'
    if (shownPage === undefined || shownKind !== kind) {
      const opening = kind === 'view' ? 'view.open(), or Settings with mod.settings.open()' : 'page.open()'
      throw new Error(`No ${kind} of ${name} shows in the Sidebar${shownPage === undefined ? '' : `, where its ${shownKind} "${shownPage.id}" shows`}. Open one with ${opening}.`)
    }
    return shownPage
  }

  const shownPart = (kind: 'pane' | 'view' | 'page'): ShownPart => {
    const isPane = kind === 'pane'
    const draw = async (columns?: number) => {
      await start()
      const { id } = shownNow(kind)
      return { id, ...(isPane ? await drawPane(id, columns) : await drawInSidebar(id, columns)) }
    }
    const drawnElement = async (type: 'Button' | 'Input' | 'Select' | 'Markdown', key: string) => {
      const { id, drawing } = await draw()
      const keys = isPane ? [key] : [key, `${name}/${id}:${key}`]
      const props = keys.map((each) => findElement(drawing, type, each)).find((found) => found !== undefined) ?? findElement(drawing, type, drawnByStyle(key))
      if (props === undefined) throw new Error(`The ${kind} "${id}" of ${name} draws no ${type} with the ${type === 'Button' ? 'key or label' : 'key'} "${key}".`)
      return { id, props }
    }
    const eventIn = (id: string, key: string) => ({ plugin: name, element: key, component: 'Pane' as const, requestId: id, surface: 'terminal' as const })
    return {
      get id() {
        return shownNow(kind).id
      },
      get params() {
        return shownNow(kind).params
      },
      lines: async (lineOptions) => {
        const { drawing, columns } = await draw(lineOptions?.columns)
        return rowsOf(drawing, columns).map((row) => row.trimEnd())
      },
      async press(key, link) {
        const { id, props } = await drawnElement(link === undefined ? 'Button' : 'Markdown', key)
        if (link !== undefined && props['onLinkPress'] === undefined) throw new Error(`The Markdown "${key}" in the ${kind} "${id}" of ${name} has no onLinkPress, so Claude Code opens its links itself.`)
        const pressed: UiPressArgument = { ...eventIn(id, String(props['key'])), ...(link === undefined ? {} : { link: { href: link } }) }
        isInputHeld = false
        const run = async (e: Frozen<UiPressArgument>) => {
          if (e.link === undefined) await (props['onPress'] as (e: Frozen<UiPressArgument>) => unknown)(e)
          else await (props['onLinkPress'] as (link: PressedLink, e: Frozen<UiPressArgument>) => unknown)(e.link, e)
          return { element: e.element }
        }
        if (isPane) await lifecycle.route('ui.press', pressed, (e) => cmodBeneath.dispatch('ui.press', e, run))
        else await run(pressed)
        await settle()
      },
      async input(key, text, type = 'submit') {
        const { id, props } = await drawnElement('Input', key)
        const typed: UiInputArgument = { ...eventIn(id, key), kind: type, value: text }
        await (props[type === 'submit' ? 'onSubmit' : 'onInput'] as ((value: string, e: UiInputArgument) => unknown) | undefined)?.(text, typed)
        await settle()
      },
      async select(key, value) {
        const { id, props } = await drawnElement('Select', key)
        const choices = (props['options'] as readonly { readonly value: string }[]).map((option) => option.value)
        if (!choices.includes(value)) throw new Error(`The Select "${key}" in the ${kind} "${id}" of ${name} has no option "${value}". Its options are ${choices.map((option) => `"${option}"`).join(', ')}.`)
        const picked: UiSelectArgument = { ...eventIn(id, key), value }
        await (props['onSelect'] as (value: string, e: UiSelectArgument) => unknown)(value, picked)
        await settle()
      },
      async focusedKey() {
        await start()
        const { id } = shownNow(kind)
        if (!(await holdsKeyboard(isPane, id))) return undefined
        if (focused?.part === `${isPane ? 'pane' : 'sidebar'}:${id}`) return focused.key
        const autoFocused = focusableKey((await draw()).drawing, (props) => props['autoFocus'] === true)
        return isPane || autoFocused === undefined ? autoFocused : autoFocused.slice(`${name}/${id}:`.length)
      },
    }
  }

  const isArea = (target: string): target is Area => (areas as readonly string[]).includes(target)

  const drawWidgets = async (area: Area, columns = defaultColumns) => {
    await start()
    const served = await widgetsOf()
    await fake.settle()
    const turn = area === TurnEndArea ? conversations.lastTurn() : undefined
    if (area === TurnEndArea && turn?.closedAt === undefined) throw new Error(`${name} has no ended turn, so TurnEnd draws nothing. End one with tested.add({ type: Prompt, text: '…' }), then tested.endTurn().`)
    const drawn = await withOwnMarkdown(() => served.draw(area, elements, { surface: 'terminal', columns }, turn))
    await fake.settle()
    const drawing = elements.Box({ flexDirection: 'column', children: [...drawn] })
    const [refused] = refusals.splice(0)
    if (refused !== undefined) throw new Error(`${cmodPluginName}: returned a tree ${areaComponents[area]} refuses: ${refused}`)
    checkKeys(drawing, cmodPluginName, areaComponents[area])
    return { drawing, columns }
  }

  const drawSlot = async (component: RenderComponent, props: object, requestId = `${component}_${(slotDraws += 1)}`) => {
    await start()
    const input = { surface: 'terminal', component, requestId, props } as Frozen<Args<'ui.render'>>
    const drawing = await lifecycle.route('ui.render', input, async (e) => plainOutput(e as Args<'ui.render'>))
    await fake.settle()
    checkKeys(drawing, name, component)
    return { drawing, columns: defaultColumns }
  }

  const loadSettings = async (answer: EventResult<'classic.ConfigChange'>) => {
    if (answer.block === undefined) await lifecycle.settingsLoaded()
    await fake.settle()
    return answer
  }

  const noted = <Answer extends { readonly additionalContext?: readonly string[] }>(answer: Answer) => {
    fake.shown.notes.push(...(answer.additionalContext ?? []).map(untagged))
    return answer
  }

  const fire = ((event: string, input: object, below?: unknown, signal?: AbortSignal) => {
    if (event.includes('.')) return route(event as RoutedEvent, input, below, signal)
    if (event === 'SessionStart') {
      sessionId = (input as { session_id?: string }).session_id ?? sessionId
      conversations.start(sessionId)
    }
    if (event === 'UserPromptSubmit') {
      cwd = cwdAfterPrompt ?? cwd
      cwdAfterPrompt = undefined
    }
    const toolUse = toolUseEvents.includes(event) ? { tool_use_id: `toolu_${(toolUses += 1)}` } : {}
    const transcript = `/test/transcripts/${sessionId}.jsonl`
    const filled = { session_id: sessionId, transcript_path: transcript, cwd, hook_event_name: event, ...toolUse, ...input }
    if (event === 'SessionStart') {
      const source = (input as { readonly source?: string }).source
      const isStartNote = source === 'startup' && !hasSessionStarted
      const startedAs = sessionId
      hasSessionStarted = true
      if (source !== 'resume') answeredId = startedAs
      const noted = start().then(() => (isStartNote ? undefined : noteDevice()))
      const routed = 'transcript_path' in input ? noted.then(() => route('classic.SessionStart', filled, below)) : Promise.all([noted, files.write(transcript, '')]).then(() => route('classic.SessionStart', filled, below))
      const started = routed.then((answer) => ((answeredId = startedAs), answer))
      return source === 'startup' || source === 'clear' ? started : started.then(async (answer) => (await tellHeldColor(), answer))
    }
    if (event === 'ConfigChange') return route('classic.ConfigChange', filled, below, signal).then(loadSettings)
    if (event === 'UserPromptSubmit' || event === 'PostToolBatch') return route(`classic.${event}`, filled, below, signal).then(noted)
    if (event !== 'PreToolUse') return route(`classic.${event}` as RoutedEvent, filled, below, signal)
    return firePreToolUse(filled as ClassicHookInputs['PreToolUse'], below as { deny?: string } | undefined)
  }) as ClaudeCode['fire']

  const asked = async (event: BeforeEvent, change: SessionChange) => {
    await start()
    const answer = ((await askMod(event, change)) as Partial<Answers> | null | undefined) ?? undefined
    return answer?.note === undefined ? answer : { ...answer, note: untagged(answer.note) }
  }

  const raise = Object.fromEntries([
    ...beforeEvents
      .filter((named) => named !== 'TaskStart' && named !== 'TurnEnd' && named !== 'ContextEnd')
      .map((named) => [`before${named}`, async (draft: { readonly output?: unknown }, placed?: { readonly task?: string }) => {
        await start()
        const isResult = named === 'ToolResult'
        const message = conversations.draft({ ...draft, ...(isResult ? { output: '' } : {}), type: sessionEvents[named] } as MessageDraft, placed?.task)
        return asked(sessionEvents[named], withAnswer({ type: Message, message }, { output: draft.output }))
      }]),
    ['beforeTaskStart', async ({ title, agentType = 'general-purpose', model }: { readonly title: string; readonly agentType?: string; readonly model?: string }) => {
      await start()
      return asked(TaskStart, { type: TaskStart, task: { id: '', title, agentType, openedBy: '', openedAt: new Date().toISOString(), context: conversations.place().context, ...(model === undefined ? {} : { model }) } })
    }],
    ['beforeTurnEnd', async (ending: Pick<Turn, 'answer' | 'failure'> = {}) => {
      await start()
      const { turn } = conversations.place()
      if (turn === undefined) throw new Error(`${name} has no turn open to end. Open one with tested.add({ type: Prompt, text: '…' }).`)
      return asked(TurnEnd, { type: TurnEnd, turn: { ...turn, ...ending, closedAt: new Date().toISOString() } })
    }],
    ['beforeContextEnd', async (placed: { readonly task?: string } = {}) => {
      await start()
      const where = conversations.place()
      const task = placed.task === undefined ? undefined : where.tasks[placed.task]
      if (placed.task !== undefined && task === undefined) throw new Error(`${name} has no task ${placed.task}. Start it with tested.startTask.`)
      return asked(ContextEnd, { type: ContextEnd, context: closingContext(where, task, new Date().toISOString()) })
    }],
    ...[...Object.entries(processEvents).flatMap(([named, event]) => [`on${named}`, ...('before' in event ? [`before${named}`] : [])]), 'onRun', 'beforeRun'].map((method) => [method, async (payload: object) => {
      await start()
      const answer = await lifecycle.raise(method, { session: sessionId, cwd, ...payload })
      await fake.settle()
      return answer
    }]),
  ]) as Raise

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
      return check.decision === 'deny' ? { deny: check.reason ?? '' } : { result: '' }
    })
    const updatedInput = toolInputOf(reached)
    const decided = check === asks ? {} : check.decision === 'allow' ? { allow: true } : check.decision === 'ask' ? { ask: check.reason ?? '' } : {}
    return {
      ...(answer.deny === undefined ? decided : { deny: answer.deny }),
      ...(JSON.stringify(updatedInput) === JSON.stringify(tool_input) ? {} : { updatedInput }),
      ...(answer.context === undefined || answer.context.length === 0 ? {} : { additionalContext: [...answer.context] }),
    } as EventResult<'classic.PreToolUse'>
  }

  const settled = async <Value>(value: Value) => {
    await fake.settle()
    return value
  }

  const tested: TestedMod<State, Given> = {
    start,
    raise,
    fire,
    settle,
    add: async (message, added) => {
      await start()
      return settled(conversations.add(message, added?.task))
    },
    endTurn: async (ending, options) => {
      await start()
      await settled(conversations.endTurn(ending === undefined ? undefined : { ...ending, ...(ending.failure === undefined ? {} : { reason: 'error' as const }) }, options?.task))
    },
    compact: async () => {
      await start()
      conversations.compact()
      await noteDevice()
    },
    startSession: async ({ source, id }) => {
      await start()
      await fire('SessionStart', { source, ...(id === undefined ? {} : { session_id: id }) })
      await fake.settle()
    },
    startTask: async (task) => {
      await start()
      return settled(conversations.startTask(task))
    },
    lines: async (target: string, props?: { readonly columns?: number }, requestId?: string) => {
      if (isArea(target) && (props === undefined || Object.keys(props).every((key) => key === 'columns'))) {
        const { drawing, columns } = await drawWidgets(target, props?.columns)
        return rowsOf(drawing, columns).map((row) => row.trimEnd())
      }
      const component = componentOf(target as Row)
      if (props === undefined || component === undefined) throw new Error(`lines takes an area, such as AbovePrompt, or a row kind, such as ToolCall, with its props, and ${target} is neither. Read a pane with tested.shown.pane.lines(), a view with tested.shown.view.lines(), and a page with tested.shown.page.lines().`)
      const { drawing, columns } = await drawSlot(component, props, requestId)
      return rowsOf(drawing, columns).map((row) => row.trimEnd())
    },
    async type(line) {
      const typed = /^\/(\S+)\s*(.*)$/s.exec(line)
      if (typed === null) throw new Error(`type takes a slash command the way the user types it, such as tested.type('/help'), and "${line}" does not start with /.`)
      const [, command = '', args = ''] = typed
      return replyOf(await (command === 'color' ? runColor(args) : runCommand(command, args)))
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
    async hotkey(hotkeyName) {
      if ((definition.hotkeys as Readonly<Record<string, unknown>> | undefined)?.[hotkeyName] === undefined) throw new Error(`${name} has no hotkey ${hotkeyName}. Declare it in defineMod: hotkeys: { ${hotkeyName}: { title: '…', default: 'ctrl+…' } }.`)
      await runCommand(hotkeyCommand(name, hotkeyName), '')
      await settle()
    },
    async press(area: Area, key: string) {
      const { drawing } = await drawWidgets(area)
      const keys = [key, ...(await widgetsOf()).widgets().filter((widget) => widget.mod === name).map((widget) => `${widget.key}:${key}`)]
      const button = keys.map((each) => findElement(drawing, 'Button', each)).find((found) => found !== undefined) ?? findElement(drawing, 'Button', drawnByStyle(key))
      if (button === undefined) throw new Error(`The widgets of ${name} in ${area} draw no Button with the key or label "${key}".`)
      await (button['onPress'] as () => unknown)()
      await settle()
    },
    api: new Proxy({}, {
      get: (_target, method) =>
        method === 'then'
          ? undefined
          : async (input?: unknown) => {
              await start()
              return callMod(String(method), input ?? null, 'tester')
            },
    }),
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
      if (mod === undefined) throw new Error(`${name} has not started. Await tested.start() first.`)
      return mod.state
    },
    calls: fake.calls,
    fakes: fake.fakes,
    shown: {
      ...fake.shown,
      get toasts() {
        return lifecycle.toasts
      },
      sent: conversations.sent,
      pane: shownPart('pane'),
      view: shownPart('view'),
      page: shownPart('page'),
    },
    providers: given.map((_each, index) => fakeProvider(index)) as never,
  }
  keepClaudeCode(tested, { fire })
  return tested
}

function fakeDependencies(caller: string, dependencies: NonNullable<TestOptions<object>['dependencies']>, conversations: FakeSessions, served: ServedProviders, sessionMods: ReadonlyMap<string, Providers>): Claude['cmod']['call'] {
  const cmod = {
    forkParent: () => null,
    updateSettings: () => null,
    [loadedMethod]: ({ name }: { readonly name: string }) => name === caller || name === cmodPluginName || Object.hasOwn(dependencies, name) || sessionMods.has(name),
  }
  const apis = { [cmodPluginName]: cmod, ...dependencies } as Readonly<Record<string, Parameters<typeof answerCall>[1] | undefined>>
  const provided = ({ to, method, input }: Parameters<Claude['cmod']['call']>[0]) => (to === cmodPluginName ? served.answer(method, input, caller) : sessionMods.get(to)?.answer(method, input, caller, new AbortController().signal))
  return async (call) => {
    const told = call.to === cmodPluginName ? conversations.answer(caller, call.method, call.input) : undefined
    if (told !== undefined) return calledAnswer(caller, told as EventResult<'cmod.call'>)
    const answered = provided(call)
    if (answered !== undefined) return calledAnswer(caller, await answered.then((value): EventResult<'cmod.call'> => ({ value }), (error: unknown) => ({ deny: messageOf(error) })))
    const api = apis[call.to]
    return calledAnswer(caller, api === undefined ? { deny: sessionMods.has(call.to) ? `${call.to} has no method ${call.method}.` : notInstalled(call.to) } : await answerCall(call.to, api, call))
  }
}

function claudeCodeAnswer(event: RoutedEvent, e: unknown): unknown {
  if (event === 'agent.spawn') {
    const { model, parentModel } = e as Args<'agent.spawn'>
    return { agentId: 'agent-1', model: model ?? parentModel }
  }
  if (event === 'session.append') {
    const { message, uuid } = e as Args<'session.append'>
    return { message, uuid }
  }
  if (event !== 'prompt.submit') return {}
  const { text, context, origin } = e as Args<'prompt.submit'>
  return { text, ...(context === undefined ? {} : { context }), origin }
}

function plainOutput({ component, props }: Args<'ui.render'>): RenderElement {
  const rows = Object.entries(props).map(([key, value]) => elements.Text({ children: `${key}: ${JSON.stringify(value)}` }))
  return elements.Box({ flexDirection: 'column', children: [elements.Text({ children: component }), elements.Box({ flexDirection: 'column', paddingLeft: 2, children: rows })] })
}

function replyOf({ text, context }: CommandRunResult): CommandReply {
  return { ...(text === undefined ? {} : { text }), ...(context === undefined ? {} : { note: context.map(untagged).join('\n') }) }
}

async function modSteps(): Promise<Steps> {
  const manifest = '../../../package.json'
  const loaded: unknown = await import(manifest, { with: { type: 'json' } }).then(
    (module: { default: unknown }) => module.default,
    (error: { readonly code?: unknown }) => {
      if (error.code === 'ERR_MODULE_NOT_FOUND') return undefined
      throw error
    },
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
