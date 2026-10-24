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
import type { ModDefinition } from './mod.js'
import type { Options, OptionValues } from './options.js'
import { hotkeyCommand, readSteps, storeFolder, type Steps } from './records.js'
import type { Claude } from './runtime/claude.js'
import { answerCall, cmodPluginName, notInstalled } from './runtime/dependencies.js'
import { closingContext, foldBefore, installBefore, withAnswer, type Answers, type Decide } from './runtime/before.js'
import { permissionRoutes } from './runtime/permission-check.js'
import type { RoutedEvent } from './runtime/hooks.js'
import { keepClaudeCode, type ClaudeCode } from './testing/claude-code.js'
import { createRouter } from './runtime/router.js'
import { toolInputOf } from './runtime/tool-calls.js'
import { createLifecycle } from './runtime/lifecycle.js'
import { MissingOptions } from './runtime/options.js'
import { conversationMethods } from './runtime/sessions.js'
import type { ShownToast } from './runtime/toaster.js'
import { Message } from './session/context/turn/message/message.js'
import { Note, untagged } from './session/context/turn/message/note.js'
import { Prompt } from './session/context/turn/message/prompt.js'
import { Mod, Person } from './session/context/turn/message/sender.js'
import type { SessionChange } from './session/conversation.js'
import { TurnEnd, type Turn } from './session/context/turn/turn.js'
import { beforeEvents, processEvents, sessionEvents, type AnswerOf, type BeforeEvent, type BeforeName, type CommandRun, type CommandRunAnswer, type Placement, type ProcessAnswer, type ProcessAsked, type ProcessName, type ProcessPayload } from './session/session.js'
import { ContextEnd } from './session/context/context.js'
import { TaskStart } from './session/goal/task.js'
import { calledAnswer, fakeClaude, type Fakes, type Shown as ShownByClaude, type TestCall } from './testing/fake-claude.js'
import { elements, findElement, rowsOf } from './testing/fake-elements.js'
import { fakeFiles } from './testing/fake-files.js'
import { fakeSessions, type FakeSession, type FakeSessions, type MessageDraft, type StartedTask } from './testing/fake-sessions.js'
import { listed, messageOf } from './utils/text.js'
import { componentOf, type KindProps, type Row, type StyledAt } from './ui/styles.js'
import { areas, TurnEnd as TurnEndArea, type Area } from './ui/areas.js'
import { drawWith, elementOf } from './ui/elements.js'
import { drawnParts } from './runtime/parts.js'
import { serveWidgets, type Widgets } from './runtime/widgets.js'
import { engineOf } from './runtime/engine.js'
import { pagesOf, servePages } from './runtime/pages.js'
import { partMethods, type DrawnPart, type PageRequest, type PartPress, type PartsUpdate } from './runtime/ui.js'

export type { Fakes, TestCall } from './testing/fake-claude.js'
export type { FakeSession, MessageDraft, StartedTask } from './testing/fake-sessions.js'
export type { RoutedEvent } from './runtime/hooks.js'
export type { ShownToast } from './runtime/toaster.js'

export type ShownPart = {
  readonly id: string
  readonly params: unknown
  lines(options?: { readonly columns?: number }): Promise<string[]>
  press(key: string, link?: string): Promise<void>
  input(key: string, text: string, type?: UiInputArgument['kind']): Promise<void>
  select(key: string, value: string): Promise<void>
}

export type Shown = ShownByClaude & { readonly toasts: readonly ShownToast[]; readonly sent: FakeSessions['sent']; readonly pane: ShownPart; readonly page: ShownPart }

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
  readonly sessions?: readonly FakeSession[]
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

export type TestedMod<State extends object> = {
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
}

const defaultColumns = 80

const defaultRows = 24

const presentation: CommandPresentation = { isFullscreen: false, columns: defaultColumns }

const toolUseEvents: readonly string[] = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied']

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
  const conversations = fakeSessions({
    callTool: (args: Parameters<Claude["tool"]["call"]>[0]) => fake.claude.tool.call(args),
    listAgents: () => fake.fakes.agent.list?.() ?? Promise.resolve([]),
    project: () => projectRoot,
    cwd: () => cwd,
    given: options.sessions ?? [],
    decide: (event, change) => decide(event, change),
    push: (mod, session, change) => {
      if (mod !== name) return
      const pushed = { to: mod, method: conversationMethods.changed, input: { session, change }, caller: cmodPluginName } as unknown as Frozen<Args<'cmod.call'>>
      void lifecycle.route('cmod.call', pushed, async () => ({ deny: notInstalled(mod) }))
    },
  })
  conversations.start(sessionId)
  const callMod = async (method: string, input: unknown, caller = cmodPluginName) => calledAnswer(caller, await lifecycle.route('cmod.call', { to: name, method, input, caller } as unknown as Frozen<Args<'cmod.call'>>, async () => ({ deny: notInstalled(name) })))
  let declaredPages: ReturnType<typeof pagesOf> = []
  let openPages: { readonly id: string; readonly params: unknown }[] = []
  let shownPage: { readonly id: string; readonly params: unknown; readonly isFocused: boolean } | undefined
  const tellShown = () => callMod(partMethods.shown, { open: openPages, shown: shownPage?.id ?? null, isFocused: shownPage?.isFocused ?? false })
  const applyRequests = async (requests: readonly PageRequest[]) => {
    for (const request of requests) {
      if ('open' in request) {
        const isSettings = declaredPages.some((page) => page.id === request.open && page.place === 'settings')
        if (!isSettings) openPages = [...openPages.filter((page) => page.id !== request.open), { id: request.open, params: request.params ?? null }]
        shownPage = { id: request.open, params: request.params ?? null, isFocused: request.focus === true }
      } else if ('close' in request) {
        openPages = openPages.filter((page) => page.id !== request.close)
        if (shownPage?.id === request.close) shownPage = undefined
      } else if ('settings' in request) {
        const first = declaredPages.find((page) => page.place === 'settings')
        shownPage = first === undefined ? undefined : { id: first.id, params: null, isFocused: true }
      }
    }
    await tellShown()
  }
  let widgets: Promise<Widgets> | undefined
  let stylesMarkdown = false
  const ownMarkdown = new Map<string, DrawnPart | null>()
  const missedMarkdown = new Map<string, { readonly markdown: string } & StyledAt>()
  const updated = async ({ parts, redraw, requests }: PartsUpdate) => {
    if (parts !== undefined) {
      declaredPages = pagesOf(parts)
      stylesMarkdown = parts.stylesMarkdown === true
      ownMarkdown.clear()
    }
    if (parts !== undefined || redraw !== undefined) (await widgetsOf()).update(name, { ...(parts === undefined ? {} : { parts }), ...(redraw === undefined ? {} : { redraw }) })
    if (requests !== undefined && requests.length > 0) await applyRequests(requests)
  }
  const pressPart = (input: PartPress) => callMod(partMethods.press, input).then((update) => updated((update ?? {}) as PartsUpdate))
  const markdownIn = (table: ElementTable, at: StyledAt) => (props: MarkdownProps): RenderElement => {
    const drawnAt = `${at.surface}\u0000${at.columns}\u0000${props.text}`
    const drawn = stylesMarkdown ? ownMarkdown.get(drawnAt) : null
    if (drawn === undefined) missedMarkdown.set(drawnAt, { markdown: props.text, ...at })
    if (drawn === undefined || drawn === null || drawn.tree === null) return table.Markdown(props)
    const { draw, tree } = drawn
    return drawWith(table, () => elementOf(tree, '', (handler, args) => void pressPart({ draw, handler, args }))) as RenderElement
  }
  const withOwnMarkdown = async <Drawn>(draw: () => Promise<Drawn>): Promise<Drawn> => {
    const first = await draw()
    if (missedMarkdown.size === 0) return first
    for (const [drawnAt, input] of missedMarkdown) ownMarkdown.set(drawnAt, (await callMod(partMethods.draw, input)) as DrawnPart | null)
    missedMarkdown.clear()
    return draw()
  }
  const cmodClaude: Claude = { ...fake.claude, cmod: { call: async (input) => (input.to === name ? callMod(input.method, input.input) : fake.claude.cmod.call(input)) } }
  const reportPart = (_id: string, message: string, error: unknown) => fake.claude.ui.log(`cmod: ${message}: ${messageOf(error)}`, { to: 'debug' })
  const parts = drawnParts({ claude: cmodClaude, report: reportPart, press: (_mod: string, input: PartPress) => void pressPart(input).catch((error: unknown) => fake.claude.ui.log(`cmod: ${name} did not take the press: ${messageOf(error)}`, { to: 'debug' })) })
  const servedWidgets = async (): Promise<Widgets> => {
    const own = name === cmodPluginName && lifecycle.mod !== undefined ? engineOf(lifecycle.mod).widgets : undefined
    if (own !== undefined) return own
    return serveWidgets({
      claude: cmodClaude,
      router: cmodPlugin,
      store: storeFolder({ HOME: await fake.claude.env.home(), XDG_DATA_HOME: await fake.claude.env.dataHome() }),
      report: reportPart,
      turnClosedBy: () => conversations.lastTurn(),
      parts,
      markdownIn,
    })
  }
  const widgetsOf = () => (widgets ??= servedWidgets())
  const cmodBeneath = createRouter()
  const pages = servePages({ claude: cmodClaude, router: cmodBeneath, report: reportPart, widgets: { update: (mod, update) => void widgetsOf().then((served) => served.update(mod, update)) }, parts, tellStylers: () => undefined })
  pages.apply((_mod, requests) => applyRequests(requests))
  const dependencies = fakeDependencies(name, options.dependencies ?? {}, conversations)
  fake.fakes.cmod.call = async (call) => {
    if (call.to !== cmodPluginName || call.method !== partMethods.changed) return dependencies(call)
    const { requests, isAsked, ...listing } = call.input as PartsUpdate
    const isHeld = isAsked === true && requests !== undefined && pages.update(name, { requests, isAsked })
    await updated(isAsked === true ? listing : (call.input as PartsUpdate))
    return { isHeld }
  }
  const appendRow = fake.claude.session.append
  fake.claude.session.append = async (args) => {
    const added = await appendRow(args)
    if (added.deny === undefined) conversations.add({ type: Note, text: args.message.content.map((block) => (typeof block['text'] === 'string' ? block['text'] : '')).join(''), from: { type: Mod, name } })
    return added
  }
  const submitRow = fake.claude.prompt.submit
  fake.claude.prompt.submit = async (args) => {
    const submitted = await submitRow(args)
    conversations.add({ type: Prompt, text: args.text, from: { type: Mod, name, ...(args.asUser === true ? { as: Person } : {}) } })
    return submitted
  }
  const firedAgents = new Map<string, string>()
  const listAgents = fake.claude.agent.list
  fake.claude.agent.list = async () => {
    if (fake.fakes.agent.list !== undefined || firedAgents.size === 0) return listAgents()
    return [...firedAgents].map(([id, type]) => ({ id, type, description: '', status: 'running' as const }))
  }
  const files = fakeFiles(options.files ?? {}, options.links)
  Object.assign(fake.fakes.fs, files)
  const starting = options.state as Record<string, object> | undefined
  const declared = Object.entries(definition.state ?? {}) as [string, object][]
  const state = Object.fromEntries(declared.map(([lifetime, values]) => [lifetime, { ...values, ...starting?.[lifetime] }])) as State
  const lifecycle = createLifecycle<State, Declared>({ ...definition, state }, () => permissionRoutes,(options.options ?? {}) as PluginOptions, false)
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
    await fake.settle()
    const { failure } = lifecycle
    if (failure instanceof MissingOptions) {
      const given = failure.keys.map((key) => `${key}: …`).join(', ')
      throw new Error(`${name} needs ${listed(failure.titles)}, which a person sets in /config. Give ${failure.keys.length === 1 ? 'it' : 'them'} to the tested mod: testMod(mod, { options: { ${given} } }).`)
    }
    if (lifecycle.phase !== 'active') throw failure ?? new Error(`${name} did not start: the lifecycle is ${lifecycle.phase}.`)
  }

  const cmodPlugin = createRouter()
  const askMod = async (event: BeforeEvent, change: SessionChange) => {
    const asked = { to: name, method: conversationMethods.before, input: { session: sessionId, event, change }, caller: cmodPluginName } as unknown as Frozen<Args<'cmod.call'>>
    return calledAnswer(cmodPluginName, await lifecycle.route('cmod.call', asked, async () => ({ deny: notInstalled(name) })))
  }
  const decide: Decide = (event, change) => foldBefore(event, change, [(latest) => askMod(event, latest)], (error) => fake.claude.ui.log(`cmod: passed the ${event} on without ${name}'s answer: ${messageOf(error)}`, { to: 'debug' }))
  installBefore({
    claude: fake.claude,
    router: cmodPlugin,
    hooks: {
      place: async () => conversations.place(),
      wants: async (event) => conversations.wants(name, event),
      fold: () => decide,
    },
  })

  const route = async <N extends RoutedEvent>(event: N, input: unknown, below: unknown): Promise<EventResult<N>> => {
    await start()
    if (event === 'ui.render') {
      const { component, requestId } = input as Args<'ui.render'>
      if (component === 'Pane') fake.placePane(requestId)
      await widgetsOf()
      await fake.settle()
    }
    return cmodPlugin.dispatch(event, input as Frozen<Args<N>>, (passed) => lifecycle.route(event, passed, async (e) => (await claudeCodeRuns(event, e, below)) as EventResult<N>))
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
    }
    if (event === 'agent.spawn') {
      const started = await route('classic.SubagentStart', { hook_event_name: 'SubagentStart', agent_id: (answer as { agentId: string }).agentId, agent_type: (e as Args<'agent.spawn'>).subagentType }, undefined)
      fake.shown.notes.push(...(started.additionalContext ?? []).map(untagged))
    }
    return answer
  }

  const runCommand = async (command: string, args: string): Promise<CommandRunResult> => {
    await start()
    const reached: Set<string> = new Set()
    const ownRun = async (): Promise<CommandRunResult> => (reached.add(command), {})
    const answer = await cmodPlugin.dispatch('command.run', { command, args, origin: { kind: 'composer' }, presentation }, (passed) => lifecycle.route('command.run', passed, (e) => cmodBeneath.dispatch('command.run', e, ownRun)))
    if (reached.has(command) && answer.text === undefined) throw new Error(!fake.shown.commands.includes(command) ? `${name} has no slash command /${command}. Add it in setup with mod.use(slashCommand({ name: '${command}', … })).` : `${name}: /${command} reached Claude Code's own run of the command, so Claude Code shows "${name} registered /${command} but no command.run hook answered it". Answer it without calling next(e).`)
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

  const drawPage = async (pageId: string, columns = defaultColumns) => {
    await start()
    const page = shownPage
    if (page?.id !== pageId) throw new Error(`The page "${pageId}" of ${name} no longer shows, and a user sees a page only while it shows.`)
    const drawn = (await callMod(partMethods.draw, { page: pageId, params: page.params, columns, isFocused: page.isFocused })) as DrawnPart | null
    await fake.settle()
    const tree = drawn?.tree ?? null
    const drawing = tree === null || drawn === null ? elements.Box({}) : await withOwnMarkdown(async () => drawWith(elements, () => elementOf(tree, '', (handler, args) => void pressPart({ draw: drawn.draw, handler, args })), markdownIn(elements, { surface: 'terminal', columns })) as RenderElement)
    return { drawing, columns }
  }

  const shownNow = (isPane: boolean): { readonly id: string; readonly params: unknown } => {
    if (isPane) {
      const id = [...fake.shown.openPanes].at(-1)
      if (id === undefined) throw new Error(`No pane of ${name} shows. Open one with pane.open(), from a slash command, a hotkey, or setup.`)
      return { id, params: undefined }
    }
    if (shownPage === undefined) throw new Error(`No page of ${name} shows in the Sidebar. Open one with page.open(), or Settings with mod.settings.open().`)
    return shownPage
  }

  const shownPart = (isPane: boolean): ShownPart => {
    const kind = isPane ? 'pane' : 'page'
    const draw = async (columns?: number) => {
      await start()
      const { id } = shownNow(isPane)
      return { id, ...(isPane ? await drawPane(id, columns) : await drawPage(id, columns)) }
    }
    const drawnElement = async (type: 'Button' | 'Input' | 'Select' | 'Markdown', key: string) => {
      const { id, drawing } = await draw()
      const props = findElement(drawing, type, key)
      if (props === undefined) throw new Error(`The ${kind} "${id}" of ${name} draws no ${type} with the ${type === 'Button' ? 'key or label' : 'key'} "${key}".`)
      return { id, props }
    }
    const eventIn = (id: string, key: string) => ({ plugin: name, element: key, component: 'Pane' as const, requestId: id, surface: 'terminal' as const })
    return {
      get id() {
        return shownNow(isPane).id
      },
      get params() {
        return shownNow(isPane).params
      },
      lines: async (lineOptions) => {
        const { drawing, columns } = await draw(lineOptions?.columns)
        return rowsOf(drawing, columns).map((row) => row.trimEnd())
      },
      async press(key, link) {
        const { id, props } = await drawnElement(link === undefined ? 'Button' : 'Markdown', key)
        if (link !== undefined && props['onLinkPress'] === undefined) throw new Error(`The Markdown "${key}" in the ${kind} "${id}" of ${name} has no onLinkPress, so Claude Code opens its links itself.`)
        const pressed: UiPressArgument = { ...eventIn(id, String(props['key'])), ...(link === undefined ? {} : { link: { href: link } }) }
        const run = async (e: Frozen<UiPressArgument>) => {
          if (e.link === undefined) await (props['onPress'] as (e: Frozen<UiPressArgument>) => unknown)(e)
          else await (props['onLinkPress'] as (link: PressedLink, e: Frozen<UiPressArgument>) => unknown)(e.link, e)
          return { element: e.element }
        }
        if (isPane) await lifecycle.route('ui.press', pressed, (e) => cmodBeneath.dispatch('ui.press', e, run))
        else await run(pressed)
        await fake.settle()
      },
      async input(key, text, type = 'submit') {
        const { id, props } = await drawnElement('Input', key)
        const typed: UiInputArgument = { ...eventIn(id, key), kind: type, value: text }
        await (props[type === 'submit' ? 'onSubmit' : 'onInput'] as ((value: string, e: UiInputArgument) => unknown) | undefined)?.(text, typed)
        await fake.settle()
      },
      async select(key, value) {
        const { id, props } = await drawnElement('Select', key)
        const choices = (props['options'] as readonly { readonly value: string }[]).map((option) => option.value)
        if (!choices.includes(value)) throw new Error(`The Select "${key}" in the ${kind} "${id}" of ${name} has no option "${value}". Its options are ${choices.map((option) => `"${option}"`).join(', ')}.`)
        const picked: UiSelectArgument = { ...eventIn(id, key), value }
        await (props['onSelect'] as (value: string, e: UiSelectArgument) => unknown)(value, picked)
        await fake.settle()
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
    return { drawing: elements.Box({ flexDirection: 'column', children: [...(await withOwnMarkdown(() => served.draw(area, elements, { surface: 'terminal', columns }, turn)))] }), columns }
  }

  const drawSlot = async (component: RenderComponent, props: object, requestId = `${component}_${(slotDraws += 1)}`) => {
    await start()
    const input = { surface: 'terminal', component, requestId, props } as Frozen<Args<'ui.render'>>
    const drawing = await lifecycle.route('ui.render', input, async (e) => plainOutput(e as Args<'ui.render'>))
    return { drawing, columns: defaultColumns }
  }

  const fire = ((event: string, input: object, below?: unknown) => {
    if (event.includes('.')) return route(event as RoutedEvent, input, below)
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
    if (event === 'SessionStart' && !('transcript_path' in input)) return files.write(transcript, '').then(() => route('classic.SessionStart', filled, below))
    if (event !== 'PreToolUse') return route(`classic.${event}` as RoutedEvent, filled, below)
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

  const tested: TestedMod<State> = {
    start,
    raise,
    fire,
    settle: fake.settle,
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
      await settled(conversations.compact())
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
      if (props === undefined || component === undefined) throw new Error(`lines takes an area, such as AbovePrompt, or a row kind, such as ToolCall, with its props, and ${target} is neither. Read a pane with tested.shown.pane.lines() and a page with tested.shown.page.lines().`)
      const { drawing, columns } = await drawSlot(component, props, requestId)
      return rowsOf(drawing, columns).map((row) => row.trimEnd())
    },
    async type(line) {
      const typed = /^\/(\S+)\s*(.*)$/s.exec(line)
      if (typed === null) throw new Error(`type takes a slash command the way the user types it, such as tested.type('/help'), and "${line}" does not start with /.`)
      const [, command = '', args = ''] = typed
      return replyOf(await runCommand(command, args))
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
      await fake.settle()
    },
    async press(area: Area, key: string) {
      const { drawing } = await drawWidgets(area)
      const keys = [key, ...(await widgetsOf()).widgets().filter((widget) => widget.mod === name).map((widget) => `${widget.key}:${key}`)]
      const button = keys.map((each) => findElement(drawing, 'Button', each)).find((found) => found !== undefined)
      if (button === undefined) throw new Error(`The widgets of ${name} in ${area} draw no Button with the key or label "${key}".`)
      await (button['onPress'] as () => unknown)()
      await fake.settle()
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
      pane: shownPart(true),
      page: shownPart(false),
    },
  }
  keepClaudeCode(tested, { fire })
  return tested
}

function fakeDependencies(caller: string, dependencies: NonNullable<TestOptions<object>['dependencies']>, conversations: FakeSessions): Claude['cmod']['call'] {
  const cmod = { forkParent: () => null, updateSettings: () => null }
  const apis = { [cmodPluginName]: cmod, ...dependencies } as Readonly<Record<string, Parameters<typeof answerCall>[1] | undefined>>
  return async (call) => {
    const served = call.to === cmodPluginName ? conversations.answer(caller, call.method, call.input) : undefined
    if (served !== undefined) return calledAnswer(caller, served as EventResult<'cmod.call'>)
    const api = apis[call.to]
    return calledAnswer(caller, api === undefined ? { deny: notInstalled(call.to) } : await answerCall(call.to, api, call))
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
