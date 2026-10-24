import { beforeEach, expect, setSystemTime, test } from 'bun:test'
import type { Args, ClassicHookInputs, EventResult, Frozen, FsEntry, HookStream, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult, RenderElement } from 'claude-code'
import { installPage } from '../../src/runtime/installer.js'
import { permissions } from '../../src/jobs/permissions.js'
import { slashCommand } from '../../src/jobs/slash-command.js'
import { servePages } from '../../src/runtime/pages.js'
import { drawnParts } from '../../src/runtime/parts.js'
import { createRouter } from '../../src/runtime/router.js'
import { partMethods, type DrawnPart, type PartsUpdate } from '../../src/runtime/ui.js'
import { defineMod, model, sessions, type CwdChange, type Mod } from '../../src/mod.js'
import { option } from '../../src/options.js'
import type { RoutedEvent } from '../../src/runtime/hooks.js'
import { engineOf } from '../../src/runtime/engine.js'
import { createLifecycle, readPlugin, type Lifecycle, type Plugin } from '../../src/runtime/lifecycle.js'
import { permissionRoutes } from '../../src/runtime/permission-check.js'
import { coreVersion, scriptsSha256 } from '../../src/records.js'
import type { ShownToast } from '../../src/testing.js'
import { calledAnswer, fakeClaude } from '../../src/testing/fake-claude.js'
import { elements, findElement, rowsOf, textOf } from '../../src/testing/fake-elements.js'
import { fakeFiles } from '../../src/testing/fake-files.js'
import { Button, drawWith, elementOf, Text } from '../../src/ui/elements.js'
import { messageOf } from '../../src/utils/text.js'

const root = '/plugins/safe-delete'

beforeEach(() => void setSystemTime(new Date(2026, 9, 23, 9, 5)))
const pending: Plugin = { name: 'safe-delete', root, version: '0.2.0', store: '/home/.local/share/cmod', isInstalled: false, shouldRecord: false, steps: {}, granted: [] }

const given = (plugin: Plugin) => async () => plugin


const manifestOnly = { [`${root}/.claude-plugin/plugin.json`]: '{ "name": "safe-delete", "version": "0.2.0" }' }

const entriesIn = (files: Record<string, string>) => async (folder = ''): Promise<FsEntry[]> => {
  const prefix = `${folder.replaceAll('/./', '/')}/`
  const names = new Set(Object.keys(files).flatMap((path) => (path.startsWith(prefix) ? [path.slice(prefix.length).split('/')[0] as string] : [])))
  return [...names].map((name) => ({ name, kind: files[`${prefix}${name}`] === undefined ? 'dir' : 'file', size: 1, mtimeMs: 0, isLink: false }))
}

function controlledStream() {
  const queue: (ProcessSpawnChunk | ProcessSpawnResult)[] = []
  let wake: (() => void) | undefined
  const push = (item: ProcessSpawnChunk | ProcessSpawnResult) => {
    queue.push(item)
    wake?.()
  }
  async function* read(): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
    for (;;) {
      while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve))
      const item = queue.shift() as ProcessSpawnChunk | ProcessSpawnResult
      if ('code' in item) return item
      yield item
    }
  }
  const stream = Object.assign(read(), { result: new Promise<ProcessSpawnResult>(() => undefined) }) as HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  return {
    stream,
    print: (text: string) => push({ stream: 'stdout', text: `${text}\n` }),
    printError: (text: string) => push({ stream: 'stderr', text: `${text}\n` }),
    exit: (code: number) => push({ code, signal: null }),
  }
}

function finished(lines: readonly string[], code: number) {
  const controlled = controlledStream()
  for (const text of lines) controlled.print(text)
  controlled.exit(code)
  return controlled.stream
}

const cmodStore = '/test/home/.local/share/cmod'

const cmodProgram = `${cmodStore}/programs/cmod`

function installCmod(fake: ReturnType<typeof fakeClaude>, version: string = coreVersion) {
  const program = fakeFiles({ [cmodProgram]: '', [`${cmodStore}/bin/cmod/${version}/cmod`]: '' })
  const disk = { stat: fake.fakes.fs.stat ?? fakeFiles({}).stat, list: fake.fakes.fs.list ?? fakeFiles({}).list }
  const isProgram = (path: string) => path.startsWith(`${cmodStore}/programs`) || path.startsWith(`${cmodStore}/bin`)
  fake.fakes.fs.stat = (path) => (isProgram(path) ? program.stat(path) : disk.stat(path))
  fake.fakes.fs.list = (path) => (path !== undefined && isProgram(path) ? program.list(path) : disk.list(path))
}


const postToolUse: ClassicHookInputs['PostToolUse'] = {
  session_id: 's',
  transcript_path: '/t',
  cwd: '/work',
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: {},
  tool_response: {},
  tool_use_id: 'toolu_1',
}

const promptSubmit = { ...postToolUse, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }

const toolBatch = { session_id: 's', cwd: '/work', hook_event_name: 'PostToolBatch', tool_calls: [] }

function failed(message: string, description?: string): ShownToast[] {
  return [{ type: 'error', message, ...(description === undefined ? {} : { description }) }]
}

function fire<N extends RoutedEvent>(lifecycle: Pick<Lifecycle<object>, 'route'>, event: N, input: unknown, below: unknown) {
  return lifecycle.route(event, input as Frozen<Args<N>>, async () => below as EventResult<N>)
}

function trackedMod() {
  const runs: string[] = []
  const definition = defineMod({
    name: 'safe-delete',
    setup(mod) {
      runs.push('setup')
      sessions.current.beforeToolBatch(() => {
        runs.push('PostToolBatch')
        return { note: 'safe-delete saw it' }
      })
      void mod.panes.add({ id: 'trash', title: 'Trash', render: () => Text({ children: 'empty' }) })
    },
  })
  return { runs, definition }
}

const abovePrompt = { surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: {}, viewport: { columns: 100, rows: 30 } }

const prompt = { type: 'Text', children: ['>'] } as unknown as RenderElement

const installerOpen = { requests: [{ open: installPage, focus: true }] }

function installRequests(fake: ReturnType<typeof fakeClaude>): unknown[] {
  const sent = fake.calls.flatMap(({ call, args: [input] }) => (call === 'cmod.call' && (input as { method?: string }).method === partMethods.changed ? [(input as { input: Record<string, unknown> }).input] : []))
  return sent.filter((input) => input['parts'] === undefined)
}

function askedByCmod(lifecycle: Pick<Lifecycle<object>, 'route'>, name: string, method: string, input: unknown): Promise<unknown> {
  return fire(lifecycle, 'cmod.call', { to: name, method, input, caller: 'cmod' }, { deny: `${name} has no method ${method}.` }).then((answer) => calledAnswer('cmod', answer))
}

async function installerDrawing(lifecycle: Pick<Lifecycle<object>, 'route'>, name = 'safe-delete', columns = 60): Promise<{ readonly drawing: RenderElement; readonly pressed: () => Promise<unknown> }> {
  const drawn = (await askedByCmod(lifecycle, name, partMethods.draw, { page: installPage, params: null, columns, isFocused: true })) as DrawnPart
  let pending: Promise<unknown> = Promise.resolve()
  const drawing = drawWith(elements, () => elementOf(drawn.tree, '', (handler, args) => void (pending = askedByCmod(lifecycle, name, partMethods.press, { draw: drawn.draw, handler, args })))) as RenderElement
  return { drawing, pressed: () => pending }
}

async function installerText(lifecycle: Pick<Lifecycle<object>, 'route'>, name?: string): Promise<string> {
  return textOf((await installerDrawing(lifecycle, name)).drawing)
}

async function pressInInstaller(lifecycle: Pick<Lifecycle<object>, 'route'>, key: string, name?: string): Promise<void> {
  const { drawing, pressed } = await installerDrawing(lifecycle, name)
  const button = findElement(drawing, 'Button', key)
  if (button === undefined) throw new Error(`The installer draws no button ${key}.`)
  ;(button['onPress'] as () => unknown)()
  await pressed()
}

async function submitInInstaller(lifecycle: Pick<Lifecycle<object>, 'route'>, key: string, value: string, name?: string): Promise<void> {
  const { drawing, pressed } = await installerDrawing(lifecycle, name)
  const field = findElement(drawing, 'Input', key)
  if (field === undefined) throw new Error(`The installer draws no field ${key}.`)
  ;(field['onSubmit'] as (value: string) => unknown)(value)
  await pressed()
}

function repeatingTimers(fake: ReturnType<typeof fakeClaude>) {
  const timers: { fire: () => void; isRunning: boolean }[] = []
  fake.fakes.clock.every = (_ms, fire) => {
    const timer = { fire, isRunning: true }
    timers.push(timer)
    return { cancel: () => void (timer.isRunning = false) }
  }
  const running = () => timers.filter((timer) => timer.isRunning)
  return {
    running,
    fire: () => {
      for (const timer of running()) timer.fire()
    },
  }
}

function cmodSidebar(name: string) {
  const cmod = fakeClaude({ name: 'cmod', root: '/plugins/cmod' })
  const refusals: string[] = []
  let loaded: Lifecycle<object> | undefined
  cmod.fakes.cmod.call = async (call) => {
    if (loaded === undefined || call.to !== name) throw new Error(`${call.to} is not loaded.`)
    return askedByCmod(loaded, name, call.method, call.input)
  }
  const parts = drawnParts({ claude: cmod.claude, report: () => undefined, press: (mod, input) => pages.press(mod, input) })
  const pages = servePages({ claude: cmod.claude, router: createRouter(), report: (_id, message, error) => void refusals.push(`${message}: ${messageOf(error)}`), widgets: { update: (mod) => parts.forget(mod) }, parts, tellStylers: () => undefined })
  const shown = async (page: string) => {
    pages.element(name, page, null, 60, true)
    await cmod.settle()
    return drawWith(elements, () => pages.element(name, page, null, 60, true) ?? Text({ children: 'Drawing…' }))
  }
  return {
    refusals,
    shown,
    async load(lifecycle: Lifecycle<object>, fake: ReturnType<typeof fakeClaude>, plugin: Plugin) {
      loaded = lifecycle
      fake.fakes.cmod.call = async (call) => (call.method === partMethods.changed ? { isHeld: pages.update(name, call.input as PartsUpdate), stylers: [] } : null)
      await lifecycle.start(fake.claude, given(plugin))
      await fake.settle()
    },
    async press(page: string, label: string) {
      const button = findElement(await shown(page), 'Button', label)
      if (button === undefined) throw new Error(`The ${page} page shows no button ${label}.`)
      ;(button['onPress'] as () => unknown)()
      await cmod.settle()
    },
  }
}

test('a mod with a pending install registers nothing until done, then runs setup from a timer of its own, so no hook it lands in cuts its calls short', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const step = controlledStream()
  const spawned: ProcessSpawnRequest[] = []
  installCmod(fake)
  fake.fakes.process.spawn = (request) => {
    spawned.push(request)
    return step.stream
  }
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, given({ ...pending, granted: ['prompt'] }))
  step.print('progress 1 4 Checking Homebrew')
  step.print('log Homebrew 4.6.0')
  step.print('progress 2 4 Installing trash')
  await fake.settle()

  expect(spawned).toEqual([{ argv: [cmodProgram, 'setup', root, '--events'] }])
  expect(await fire(lifecycle, 'classic.PostToolBatch', toolBatch, {})).toEqual({})
  expect(runs).toEqual([])
  expect(rowsOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt), 100).map((row) => row.trimEnd())).toEqual([
    '>',
    '⠋  safe-delete  Installing                                  ✕',
    `                ${'█'.repeat(12)}${'░'.repeat(12)}  Installing trash`,
  ])

  step.print('progress 4 4 Adding the zsh alias')
  step.print('done safe-delete 0.2.0')
  step.exit(0)
  await fake.settle()

  expect(runs).toEqual(['setup'])
  expect(fake.calls.filter((call) => call.call === 'clock.after').map((call) => call.args[0])).toContain(0)

  const answer = await fire(lifecycle, 'classic.PostToolBatch', toolBatch, {})

  expect(runs).toEqual(['setup', 'PostToolBatch'])
  expect(answer).toEqual({ additionalContext: ['<safe-delete_mod>\nsafe-delete saw it\n</safe-delete_mod>'] })
  await fake.settle()
  expect(lifecycle.toasts).toEqual([{ type: 'success', message: 'Installed', description: 'Adds the Trash pane.\nAdd text Claude reads and start turns.' }])
  expect(fake.shown.logs).toEqual([])
  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toStartWith('>\n✓  safe-delete  Installed')
})

test('a call to a mod still installing fails with when to retry', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  fake.fakes.process.spawn = () => controlledStream().stream
  const lifecycle = createLifecycle(trackedMod().definition)
  const below = { value: [{ name: 'parse', line: 1 }] }

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(await fire(lifecycle, 'cmod.call', { to: 'safe-delete', method: 'restore', input: { path: 'a.ts' } }, { deny: 'safe-delete is not installed. Install it in Plugins.' })).toEqual({
    deny: "safe-delete is installing. Try again when it's ready.",
  })
  expect(await fire(lifecycle, 'cmod.call', { to: 'tracer', method: 'signatures', input: { path: 'a.ts' } }, below)).toBe(below)
})

test('a call to a mod that is still starting waits for it, then answers', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  const lifecycle = createLifecycle(defineMod({ name: 'safe-delete', setup: () => ({ restore: () => ['a.ts'] }) }))
  const plugins: ((plugin: Plugin) => void)[] = []
  const starting = lifecycle.start(fake.claude, () => new Promise<Plugin>((resolve) => void plugins.push(resolve)))

  const answer = fire(lifecycle, 'cmod.call', { to: 'safe-delete', method: 'restore', input: null }, { deny: 'safe-delete is not installed. Install it in Plugins.' })
  await fake.settle()
  plugins.shift()?.({ ...pending, isInstalled: true })
  await starting

  expect(await answer).toEqual({ value: ['a.ts'] })
})

test("Claude's call to a mod's own tool that comes before the mod's session.start, as right after a reload, waits for the start, then answers", async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  const lifecycle = createLifecycle(
    defineMod({
      name: 'safe-delete',
      setup(mod) {
        engineOf(mod).router.add('tool.call', (e, next) => (e.tool === 'mcp__safe-delete__restore' ? { result: 'restored' } : next(e)))
      },
    }),
  )
  const unanswered = async () => ({ result: 'safe-delete registered the tool restore but no tool.call hook answered this call' }) as never

  const answer = lifecycle.route('tool.call', { tool: 'mcp__safe-delete__restore', tool_use_id: 't1' } as never, unanswered)
  await lifecycle.start(fake.claude, given({ ...pending, isInstalled: true }))

  expect(await answer).toEqual({ result: 'restored' } as never)
})

test("a transcript row that comes before the mod's session.start, as during the cmod plugin's own restart, waits for the start, then reaches the mod's route", async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  const lifecycle = createLifecycle(
    defineMod({
      name: 'safe-delete',
      setup(mod) {
        engineOf(mod).router.add('session.append', (e, next) => next({ ...e, message: { ...e.message, content: [{ type: 'text', text: 'rewritten' }] } }))
      },
    }),
  )
  const row = { uuid: 'r1', door: 'command', origin: { kind: 'engine' }, message: { type: 'system', role: 'user', content: [{ type: 'text', text: 'Reloaded' }] } }

  const appended = lifecycle.route('session.append', row as never, async (e) => e as never)
  await lifecycle.start(fake.claude, given({ ...pending, isInstalled: true }))

  expect(((await appended) as { readonly message: { readonly content: unknown } }).message.content).toEqual([{ type: 'text', text: 'rewritten' }])
})

test("a call that comes before the mod's session.start waits for the start, then answers", async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  const lifecycle = createLifecycle(defineMod({ name: 'safe-delete', setup: () => ({ restore: () => ['a.ts'] }) }))

  const answer = fire(lifecycle, 'cmod.call', { to: 'safe-delete', method: 'restore', input: null }, { deny: 'safe-delete is not installed. Install it in Plugins.' })
  await lifecycle.start(fake.claude, given({ ...pending, isInstalled: true }))

  expect(await answer).toEqual({ value: ['a.ts'] })
})

test('a call to a mod whose install was declined fails and points at its toast', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  fake.fakes.process.spawn = () => finished(['needs-consent abc123\t./setup/install.sh\t'], 10)
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  await pressInInstaller(lifecycle, 'not-now')
  await fake.settle()

  expect(await fire(lifecycle, 'cmod.call', { to: 'safe-delete', method: 'restore', input: { path: 'a.ts' } }, { value: [] })).toEqual({
    deny: 'safe-delete is not set up. Its toast says why.',
  })
})

test('while the installer waits for the answer, its toast stays still, so no redraw takes a press away', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  fake.fakes.process.spawn = () => finished(['needs-consent abc123\t./setup/install.sh\t'], 10)
  const timers = repeatingTimers(fake)
  const lifecycle = createLifecycle(trackedMod().definition)
  const redraws = () => fake.calls.filter(({ call }) => call === 'ui.invalidate').length

  void lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  const shownRedraws = redraws()
  timers.fire()
  await fake.settle()

  expect(lifecycle.toasts).toEqual([{ type: 'info', message: 'Installing', description: 'Waiting for your answer' }])
  expect(redraws()).toBe(shownRedraws)
})

test("a question Claude Code holds back in a narrow terminal opens from its toast's Answer button, and the toast leaves once answered", async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  fake.fakes.process.spawn = () => finished(['needs-consent abc123\t./setup/install.sh\t'], 10)
  const lifecycle = createLifecycle(trackedMod().definition)

  void lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  const answer = findElement(await fire(lifecycle, 'ui.render', abovePrompt, prompt), 'Button', 'Answer')
  if (answer === undefined) throw new Error('The waiting toast has no Answer button.')
  await (answer['onPress'] as () => unknown)()
  await fake.settle()

  expect(installRequests(fake)).toEqual([installerOpen, { ...installerOpen, isAsked: true }])
  await pressInInstaller(lifecycle, 'not-now')
  await fake.settle()
  expect(findElement(await fire(lifecycle, 'ui.render', abovePrompt, prompt), 'Button', 'Answer')).toBeUndefined()
})

test('needs-consent opens the installer focused, and Accept runs the setup again with the hash', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const spawned: ProcessSpawnRequest[] = []
  installCmod(fake)
  fake.fakes.process.spawn = (request) => {
    spawned.push(request)
    return spawned.length === 1 ? finished(['needs-consent abc123\t./setup/install.sh\t./setup/uninstall.sh\tshift+tab to /mode'], 10) : finished(['done safe-delete 0.2.0'], 0)
  }
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(installRequests(fake)).toEqual([installerOpen])
  expect(await installerText(lifecycle)).toContain('safe-delete wants to change your computer:')
  expect(await installerText(lifecycle)).toContain('Run ./setup/install.sh now, and ./setup/uninstall.sh when you remove it')
  expect(await installerText(lifecycle)).toContain('Bind shift+tab to /mode')
  await pressInInstaller(lifecycle, 'accept')
  await fake.settle()
  expect(spawned.map((request) => request.argv)).toEqual([
    [cmodProgram, 'setup', root, '--events'],
    [cmodProgram, 'setup', root, '--events', '--consent', 'abc123'],
  ])
  await fire(lifecycle, 'classic.PostToolBatch', toolBatch, {})
  expect(runs).toEqual(['setup', 'PostToolBatch'])
})

test('a mod that only binds keys asks about the keys alone', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  fake.fakes.process.spawn = () => finished(['needs-consent abc123\t\t\tshift+tab to /mode and alt+m to /mode'], 10)
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  const shown = await installerText(lifecycle)
  expect(shown).toContain('safe-delete wants to change your computer:')
  expect(shown).toContain('Bind shift+tab to /mode and alt+m to /mode')
  expect(shown).not.toContain('Run ')
})

test('a consent whose only change is the program names the program it installs', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  Object.assign(
    fake.fakes.fs,
    fakeFiles({
      [`${root}/.claude-plugin/plugin.json`]: '{ "name": "safe-delete", "version": "0.2.0" }',
      [`${root}/package.json`]: '{ "cmod": { "program": "trash" } }',
    }),
  )
  installCmod(fake)
  fake.fakes.process.spawn = () => finished(['needs-consent abc123\t\t\t'], 10)
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, readPlugin)
  await fake.settle()

  const shown = await installerText(lifecycle)
  expect(shown).toContain('safe-delete wants to change your computer:')
  expect(shown).toContain('Install trash, which Claude runs by its name')
})

test('a mod installed from a marketplace with no update choice says it will update automatically, and one the person chose for says nothing', async () => {
  const cached = '/test/home/.claude/plugins/cache/safe-market/safe-delete/0.2.0'
  const shownFor = async (autoUpdate: boolean | undefined) => {
    const fake = fakeClaude({ name: 'safe-delete', root: cached })
    installCmod(fake)
    fake.fakes.process.spawn = () => finished(['needs-consent abc123\t./setup/install.sh\t'], 10)
    fake.fakes.settings.read = async () => ({ extraKnownMarketplaces: { 'safe-market': { source: { source: 'github', repo: 'owner/safe' }, ...(autoUpdate === undefined ? {} : { autoUpdate }) } } })
    const lifecycle = createLifecycle(trackedMod().definition)
    await lifecycle.start(fake.claude, given({ ...pending, root: cached }))
    await fake.settle()
    return installerText(lifecycle)
  }

  expect(await shownFor(undefined)).toContain('Update safe-delete automatically from the safe-market marketplace')
  expect(await shownFor(false)).not.toContain('automatically')
})

test('a mod that asks for permissions names each one in the words the person reads', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  fake.fakes.process.spawn = () => finished(['needs-consent abc123\t./setup/install.sh\t\t\tnetwork:api.github.com\tprompt'], 10)
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  const shown = await installerText(lifecycle)
  expect(shown).toContain('Connect to api.github.com')
  expect(shown).toContain('Add text Claude reads and start turns')
  expect(shown).toContain('and change your computer:')
})

test('each hotkey of a mod is a command that runs at once', async () => {
  const fake = fakeClaude({ name: 'modes', root })
  const definition = defineMod({ name: 'modes', hotkeys: { cycle: { title: 'Switch mode', default: 'shift+tab' } }, setup: () => undefined })

  const lifecycle = createLifecycle(definition)
  await lifecycle.start(fake.claude, given({ ...pending, isInstalled: true, steps: { hotkeys: { cycle: { title: 'Switch mode', default: 'shift+tab' } } } }))
  await fake.settle()

  expect(fake.shown.commands).toEqual(['modes--cycle'])
})

test("the cmod plugin hides every mod's hotkey command from the slash command list, and no other command, whose provider Claude Code names with its marketplace", async () => {
  const fake = fakeClaude({ name: 'cmod', root })
  const lifecycle = createLifecycle(defineMod({ name: 'cmod', setup() {} }))
  await lifecycle.start(fake.claude, given({ ...pending, name: 'cmod', isInstalled: true }))
  await fake.settle()
  const described = (command: string, plugin: string) => fire(lifecycle, 'command.describe', { command, provider: { plugin, tier: 'user' } }, { description: 'Switch mode', isHidden: false })

  expect(await described('modes--cycle', 'modes@market')).toEqual({ description: 'Switch mode', isHidden: true })
  expect(await described('cmod--sidebar', 'cmod@cmod')).toEqual({ description: 'Switch mode', isHidden: true })
  expect(await described('modes--cycle', 'modes')).toEqual({ description: 'Switch mode', isHidden: true })
  expect(await described('review', 'modes@market')).toEqual({ description: 'Switch mode', isHidden: false })
  expect(await described('notes--cycle', 'modes@market')).toEqual({ description: 'Switch mode', isHidden: false })
})

test('the cmod plugin asks Claude Code to list the commands again once it can hide hotkey commands, because Claude Code keeps the list it made before the plugin started', async () => {
  const fake = fakeClaude({ name: 'cmod', root })
  const lifecycle = createLifecycle(defineMod({ name: 'cmod', setup() {} }))
  await lifecycle.start(fake.claude, given({ ...pending, name: 'cmod', isInstalled: true }))
  await fake.settle()

  expect(fake.calls.filter(({ call, args }) => call === 'ui.invalidate' && args[0] === 'command.describe')).toHaveLength(1)
})

test('Not now declines the install with one notice naming cmod install, and setup never runs', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  fake.fakes.process.spawn = () => finished(['needs-consent abc123\t./setup/install.sh\t'], 10)
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  await pressInInstaller(lifecycle, 'not-now')
  await fake.settle()
  await fire(lifecycle, 'classic.PostToolBatch', toolBatch, {})

  expect(lifecycle.toasts).toEqual([{ type: 'default', message: 'Not installed', description: 'Install it whenever you like.' }])
  expect(runs).toEqual([])
})

test('a failed install draws the sentence cmod setup wrote and its fix, and setup never runs', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  fake.fakes.process.spawn = () => finished(['progress 1 4 Checking Homebrew', 'failed 1\tThe install step of safe-delete exited 1: brew: command not found.'], 1)
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  await fire(lifecycle, 'classic.PostToolBatch', toolBatch, {})

  expect(runs).toEqual([])
  expect(lifecycle.toasts).toEqual([
    { type: 'error', message: 'The install step of safe-delete exited 1: brew: command not found.' },
  ])
})

test('Retry on a failed install runs cmod setup again, and a done setup activates the mod', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  const outcomes = [['failed 1\tdisk full'], ['done safe-delete 0.2.0']]
  fake.fakes.process.spawn = () => finished(outcomes.shift() ?? [], 0)
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)
  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  const retry = findElement(await fire(lifecycle, 'ui.render', abovePrompt, prompt), 'Button', 'Retry')
  if (retry === undefined) throw new Error('The failed install draws no Retry button.')

  await (retry['onPress'] as () => void)()
  await fake.settle()
  await fire(lifecycle, 'classic.PostToolBatch', toolBatch, {})

  expect(lifecycle.failure).toBeUndefined()
  expect(lifecycle.phase).toBe('active')
  expect(runs).toEqual(['setup', 'PostToolBatch'])
})

test('Retry keeps the failure toast in place, with its progress where its buttons were, until the try ends', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  const second = controlledStream()
  const streams = [finished(['failed 1\tdisk full'], 1), second.stream]
  fake.fakes.process.spawn = () => streams.shift() ?? finished([], 0)
  const lifecycle = createLifecycle(trackedMod().definition)
  const rows = async () => rowsOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt), 100).map((row) => row.trimEnd())
  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  const failed = await rows()
  const retry = findElement(await fire(lifecycle, 'ui.render', abovePrompt, prompt), 'Button', 'Retry')
  if (retry === undefined) throw new Error('The failed install draws no Retry button.')

  void (retry['onPress'] as () => unknown)()
  await fake.settle()
  second.print('progress 1 4 Building trace')
  await fake.settle()
  const trying = await rows()
  second.print('failed 1\tdisk full')
  second.exit(1)
  await fake.settle()

  expect(trying.length).toBe(failed.length)
  expect(trying[1]?.slice(1)).toBe(failed[1]?.slice(1))
  expect(trying.at(-1)).toMatch(/Trying again: .* Building trace/)
  expect(await rows()).toEqual(failed)
})

test('Retry on a failure with a description shows its progress in the description, and keeps its buttons', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  fake.fakes.clock.after = () => ({ cancel: () => undefined })
  const second = controlledStream()
  const streams = [finished(['failed 1\tdisk full', 'retries later'], 1), second.stream]
  fake.fakes.process.spawn = () => streams.shift() ?? finished([], 0)
  const lifecycle = createLifecycle(trackedMod().definition)
  const rows = async () => rowsOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt), 100).map((row) => row.trimEnd())
  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  const failed = await rows()
  const retry = findElement(await fire(lifecycle, 'ui.render', abovePrompt, prompt), 'Button', 'Retry')
  if (retry === undefined) throw new Error('The failed install draws no Retry button.')

  void (retry['onPress'] as () => unknown)()
  await fake.settle()
  const trying = await rows()
  second.exit(0)
  await fake.settle()

  expect(failed.slice(2)).toEqual(['                Trying again in 2 s.', '                Retry  Report  Hide  09:05'])
  expect(trying.slice(2)).toEqual(['                Trying again: Installing', '                Retry  Report  Hide  09:05'])
  expect(trying[1]?.slice(1)).toBe(failed[1]?.slice(1))
})

const changelog = `# Changelog

## [Unreleased]

## [0.2.0] - 2026-10-13

### Added
- /rollback undoes the last deploy.

### Changed
- Deploys wait for CI.
- The status line names the branch.

### Removed
- /deploy-old.

## [0.1.0] - 2026-09-30

- First release.
`

async function updatedFrom(previous: unknown, files: Record<string, string>, pluginRoot = root) {
  const fake = fakeClaude({ name: 'safe-delete', root: pluginRoot })
  const disk = fakeFiles(files)
  fake.fakes.fs.read = disk.read
  fake.store.set('cmod:announced', previous)
  const opened: unknown[] = []
  fake.fakes.cmod.call = async (call) => void opened.push(call)
  const lifecycle = createLifecycle(trackedMod().definition)
  await lifecycle.start(fake.claude, given({ ...pending, root: pluginRoot, isInstalled: true }))
  await fake.settle()
  return { fake, lifecycle, opened }
}

test("an update shows the new version's changelog, where it came from, and a Changelog button that opens it in /mods", async () => {
  const { fake, lifecycle, opened } = await updatedFrom({ version: '0.1.0', added: [] }, { [`${root}/CHANGELOG.md`]: changelog })

  expect(lifecycle.toasts).toEqual([
    {
      type: 'success',
      message: 'Updated to 0.2.0',
      description: 'Added: /rollback undoes the last deploy.\nChanged: Deploys wait for CI.\nChanged: The status line names the branch.\n…\nFrom 0.1.0, loaded from /plugins/safe-delete.',
    },
  ])
  const button = findElement(await fire(lifecycle, 'ui.render', abovePrompt, prompt), 'Button', 'Changelog')
  if (button === undefined) throw new Error('The Updated toast draws no Changelog button.')
  await (button['onPress'] as () => Promise<void>)()
  await fake.settle()
  expect(opened).toEqual([
    { to: 'cmod', method: 'cmod:partsChanged', input: { parts: { widgets: [], pages: [] } } },
    { to: 'cmod', method: 'cmod:partsChanged', input: { requests: [{ settings: true, tab: 'changelog' }], isAsked: true } },
  ])
})

const commandFrom = (isHeld: boolean) => async () => {
  const fake = fakeClaude({ name: 'ci-watch', root })
  fake.fakes.cmod.call = async () => ({ isHeld })
  const lifecycle = createLifecycle(
    defineMod({
      name: 'ci-watch',
      setup(mod) {
        const page = mod.sidebar.add({ id: 'runs', title: 'Runs', render: () => Text({ children: 'last run passed' }) })
        mod.use(slashCommand({ name: 'runs', description: 'Show the runs', reply: () => page.open() }))
      },
    }),
  )
  await lifecycle.start(fake.claude, given({ ...pending, name: 'ci-watch', isInstalled: true }))
  await fake.settle()
  const passedOn: string[] = []
  const answer = await lifecycle.route('command.run', { command: 'runs', args: '', origin: { kind: 'composer' } } as never, async (e) => (passedOn.push((e as Args<'command.run'>).command), { text: 'Claude Code ran it' }))
  return { answer, passedOn }
}

test('a command whose page request the cmod plugin did not hold passes the command on to the cmod plugin, and keeps its own answer', async () => {
  const { answer, passedOn } = await commandFrom(false)()

  expect(passedOn).toEqual(['runs'])
  expect(answer).toEqual({})
})

test('a command whose page request the cmod plugin held answers without passing the command on', async () => {
  const { answer, passedOn } = await commandFrom(true)()

  expect(passedOn).toEqual([])
  expect(answer).toEqual({})
})

test("a press whose handler drops page.open's promise ends only once the cmod plugin heard the page request, so a cmod plugin earlier in the chain opens the page in the person's frame", async () => {
  const fake = fakeClaude({ name: 'ci-watch', root })
  const heard: unknown[] = []
  let answer: () => void = () => undefined
  fake.fakes.cmod.call = async (call) => {
    const update = call.input as PartsUpdate
    if (update.isAsked !== true) return null
    heard.push(update)
    return new Promise((resolve) => (answer = () => resolve({ isHeld: true })))
  }
  let page: ReturnType<Mod['sidebar']['add']> | undefined
  const lifecycle = createLifecycle(defineMod({ name: 'ci-watch', setup: (mod) => void (page = mod.sidebar.add({ id: 'runs', title: 'Runs', render: () => Text({ children: 'last run passed' }) })) }))
  await lifecycle.start(fake.claude, given({ ...pending, name: 'ci-watch', isInstalled: true }))
  await fake.settle()
  let isPressed = false

  const pressed = lifecycle.route('ui.press', { plugin: 'ci-watch', element: 'runs', component: 'Pane', requestId: 'runs', surface: 'terminal' } as never, async (e) => (void page?.open(), { element: e.element })).then(() => (isPressed = true))
  await fake.settle()

  expect(heard).toEqual([{ requests: [{ open: 'runs' }], isAsked: true }])
  expect(isPressed).toBe(false)
  answer()
  await pressed
  expect(isPressed).toBe(true)
})

test('the cmod plugin opens a page a mod before it in the chain asked for, and ends the command there', async () => {
  const fake = fakeClaude({ name: 'cmod', root })
  const router = createRouter()
  const opened: unknown[] = []
  const pages = servePages({ claude: fake.claude, router, report: () => undefined, widgets: { update: () => undefined }, parts: drawnParts({ claude: fake.claude, report: () => undefined, press: () => undefined }), tellStylers: () => undefined })
  pages.apply(async (mod, requests) => void opened.push({ mod, requests }))

  const isHeld = pages.update('ci-watch', { requests: [{ open: 'runs' }], isAsked: true })
  const passedOn: string[] = []
  const answer = await router.dispatch('command.run', { command: 'runs', args: '', origin: { kind: 'composer' } } as never, async (e) => (passedOn.push((e as Args<'command.run'>).command), { text: 'Claude Code ran it' }))

  expect(isHeld).toBe(false)
  expect(opened).toEqual([{ mod: 'ci-watch', requests: [{ open: 'runs' }] }])
  expect(passedOn).toEqual([])
  expect(answer).toEqual({})
})

test("a press waits for the mod it pressed, never for a slower mod an earlier press is still waiting on, because Claude Code's clock runs through that wait", async () => {
  const fake = fakeClaude({ name: 'cmod', root })
  let answerInbox: (value: unknown) => void = () => undefined
  fake.fakes.cmod.call = async (call) => (call.to === 'inbox' ? new Promise((resolve) => (answerInbox = resolve)) : null)
  const router = createRouter()
  const pages = servePages({ claude: fake.claude, router, report: () => undefined, widgets: { update: () => undefined }, parts: drawnParts({ claude: fake.claude, report: () => undefined, press: () => undefined }), tellStylers: () => undefined })
  const pressIn = (mod: string) => router.dispatch('ui.press', { requestId: 'sidebar', key: 'k' } as never, async () => (pages.press(mod, { handler: 1 } as never), { element: null } as never))
  const first = pressIn('inbox')
  let isSecondDone = false

  await pressIn('notes').then(() => (isSecondDone = true))
  answerInbox(null)
  await first

  expect(isSecondDone).toBe(true)
})

test('a mod that adds or drops a markdown style makes the cmod plugin tell every mod which mods style markdown', async () => {
  const fake = fakeClaude({ name: 'cmod', root })
  const told: unknown[] = []
  fake.fakes.cmod.call = async (call) => (told.push({ to: call.to, method: call.method, input: call.input }), null)
  const ownStylers: unknown[] = []
  const pages = servePages({ claude: fake.claude, router: createRouter(), report: () => undefined, widgets: { update: () => undefined }, parts: drawnParts({ claude: fake.claude, report: () => undefined, press: () => undefined }), tellStylers: (stylers) => void ownStylers.push(stylers) })
  pages.update('notes', { parts: { widgets: [], pages: [] } })
  pages.update('cmod', { parts: { widgets: [], pages: [] } })

  pages.update('diagrams', { parts: { widgets: [], pages: [], stylesMarkdown: true } })
  pages.update('diagrams', { parts: { widgets: [], pages: [], stylesMarkdown: true } })
  pages.update('diagrams', { parts: { widgets: [], pages: [] } })
  pages.update('notes', { parts: { widgets: [], pages: [] } })

  expect(pages.stylers()).toEqual([])
  expect(ownStylers).toEqual([['diagrams'], ['diagrams'], []])
  expect(told.filter((call) => (call as { to: string }).to === 'notes')).toEqual([
    { to: 'notes', method: partMethods.stylers, input: ['diagrams'] },
    { to: 'notes', method: partMethods.stylers, input: ['diagrams'] },
    { to: 'notes', method: partMethods.stylers, input: [] },
  ])
  expect(told.filter((call) => (call as { to: string }).to === 'cmod')).toEqual([])
})

test('a press the mod refuses makes the page draw again, so its next buttons work', async () => {
  const fake = fakeClaude({ name: 'cmod', root })
  const asked: string[] = []
  fake.fakes.cmod.call = async (call) => {
    asked.push(call.method)
    if (call.method === partMethods.press) throw new Error('ci-watch: that button drew before the last redraw. Press the one it shows now.')
    return call.method === partMethods.draw ? { draw: asked.length, tree: { $cmodElement: 'Button', props: { key: 'go', label: 'Go', onPress: { $cmodHandler: 0 } } } } : null
  }
  const parts = drawnParts({ claude: fake.claude, report: () => undefined, press: () => undefined })
  const pages = servePages({ claude: fake.claude, router: createRouter(), report: () => undefined, widgets: { update: () => undefined }, parts, tellStylers: () => undefined })
  const draw = async () => {
    pages.element('ci-watch', 'runs', { run: 7 }, 80, false)
    await fake.settle()
    return pages.element('ci-watch', 'runs', { run: 7 }, 80, false)
  }

  await draw()
  pages.press('ci-watch', { draw: 2, handler: 0, args: [] })
  await fake.settle()
  await draw()

  expect(asked.filter((method) => method === partMethods.draw || method === partMethods.press)).toEqual([partMethods.draw, partMethods.press, partMethods.draw])
})

test('a page keeps its drawing while its mod draws it for a focused pane or a new width, so Claude Code never clamps the scrolled window to a one-line placeholder', async () => {
  const fake = fakeClaude({ name: 'cmod', root })
  fake.fakes.cmod.call = async (call) => {
    if (call.method !== partMethods.draw) return null
    const { columns, isFocused } = call.input as { readonly columns: number; readonly isFocused: boolean }
    return { draw: 1, tree: { $cmodElement: 'Text', props: { children: `runs at ${columns}${isFocused ? ', focused' : ''}` } } }
  }
  const pages = servePages({ claude: fake.claude, router: createRouter(), report: () => undefined, widgets: { update: () => undefined }, parts: drawnParts({ claude: fake.claude, report: () => undefined, press: () => undefined }), tellStylers: () => undefined })
  const shown = async (columns: number, isFocused: boolean, params: unknown = { run: 7 }) => {
    const drawn = drawWith(elements, () => pages.element('ci-watch', 'runs', params, columns, isFocused))
    await fake.settle()
    return drawn === undefined ? 'Drawing Runs…' : textOf(drawn)
  }

  await shown(80, false)

  expect([await shown(80, false), await shown(80, true), await shown(80, true), await shown(60, true), await shown(60, true), await shown(60, true, { run: 8 })]).toEqual([
    'runs at 80',
    'runs at 80',
    'runs at 80, focused',
    'runs at 80, focused',
    'runs at 60, focused',
    'Drawing Runs…',
  ])
})

test('a press on a page drawn before its mod restarted only draws the page again, and a press the mod refuses for another reason shows its failure', async () => {
  const fake = fakeClaude({ name: 'cmod', root })
  const refusals: Readonly<Record<string, string>> = { 'ci-watch': 'ci-watch: that button drew before the last redraw. Press the one it shows now.', deploys: 'deploys: the deploy key is missing' }
  fake.fakes.cmod.call = async (call) => calledAnswer('cmod', call.method === partMethods.press ? { deny: refusals[call.to] ?? 'unknown mod' } : { value: null })
  const reported: string[] = []
  const redraws = () => fake.calls.filter((call) => call.call === 'ui.invalidate').length
  const pages = servePages({ claude: fake.claude, router: createRouter(), report: (_id, message, error) => void reported.push(`${message}: ${messageOf(error)}`), widgets: { update: () => undefined }, parts: drawnParts({ claude: fake.claude, report: () => undefined, press: () => undefined }), tellStylers: () => undefined })

  pages.press('ci-watch', { draw: 3, handler: 0, args: [] })
  await fake.settle()
  const redrawnForStale = redraws()
  pages.press('deploys', { draw: 3, handler: 0, args: [] })
  await fake.settle()

  expect([redrawnForStale, reported]).toEqual([1, ['deploys did not take the press: cmod: $.cmod.call: deploys: the deploy key is missing']])
  expect(fake.shown.debug).toContain('cmod: ci-watch draws its page again, because the button pressed was from an older drawing:cmod: $.cmod.call: ci-watch: that button drew before the last redraw. Press the one it shows now.')
})

test('after a mod restarts with its install question open, Not now on the shown install tab declines on the first press', async () => {
  const cmod = cmodSidebar('safe-delete')
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  fake.fakes.process.spawn = () => finished(['needs-consent abc123\t./setup/install.sh\t'], 10)
  await cmod.load(createLifecycle(trackedMod().definition), fake, pending)
  await cmod.shown(installPage)
  const restarted = createLifecycle(trackedMod().definition)

  await cmod.load(restarted, fake, pending)
  await cmod.press(installPage, 'Not now')
  await fake.settle()

  expect(cmod.refusals).toEqual([])
  expect(restarted.toasts).toEqual([{ type: 'default', message: 'Not installed', description: 'Install it whenever you like.' }])
})

test("after a mod restarts, a press on its Sidebar page runs the restarted module's handler", async () => {
  const cmod = cmodSidebar('safe-delete')
  const fake = fakeClaude({ name: 'safe-delete', root })
  const ranIn: string[] = []
  const withRuns = (module: string) => defineMod({ name: 'safe-delete', setup: (mod) => void mod.sidebar.add({ id: 'runs', title: 'Runs', render: () => Button({ key: 'rerun', label: 'Run again', onPress: () => void ranIn.push(module) }) }) })
  const installed = { ...pending, isInstalled: true }
  await cmod.load(createLifecycle(withRuns('first')), fake, installed)
  await cmod.shown('runs')

  await cmod.load(createLifecycle(withRuns('restarted')), fake, installed)
  await cmod.press('runs', 'Run again')

  expect(cmod.refusals).toEqual([])
  expect(ranIn).toEqual(['restarted'])
})

test("a restarted module refuses a press on a draw number an earlier module of the mod drew, instead of running another drawing's button", async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const ranIn: string[] = []
  const withPages = (module: string) =>
    defineMod({
      name: 'safe-delete',
      setup(mod) {
        for (const id of ['runs', 'logs']) void mod.sidebar.add({ id, title: id, render: () => Button({ key: id, label: id, onPress: () => void ranIn.push(`${module} ${id}`) }) })
      },
    })
  const draw = async (lifecycle: Lifecycle<object>, page: string) => (await askedByCmod(lifecycle, 'safe-delete', partMethods.draw, { page, params: null, columns: 60, isFocused: true })) as DrawnPart
  const installed = given({ ...pending, isInstalled: true })
  const first = createLifecycle(withPages('first'))
  await first.start(fake.claude, installed)
  const stale = await draw(first, 'runs')
  setSystemTime(new Date(2026, 9, 23, 9, 6))
  const restarted = createLifecycle(withPages('restarted'))
  await restarted.start(fake.claude, installed)
  await draw(restarted, 'logs')

  const pressed = askedByCmod(restarted, 'safe-delete', partMethods.press, { draw: stale.draw, handler: 0, args: [] })

  await expect(pressed).rejects.toThrow('safe-delete: that button drew before the last redraw. Press the one it shows now.')
  expect(ranIn).toEqual([])
})

test('a page opened in setup reaches the cmod plugin with the first list of parts', async () => {
  const fake = fakeClaude({ name: 'welcome', root })
  const told: unknown[] = []
  fake.fakes.cmod.call = async (call) => void told.push(call)
  const lifecycle = createLifecycle(
    defineMod({
      name: 'welcome',
      async setup(mod) {
        await mod.sidebar.add({ id: 'hello', title: 'Hello', render: () => Text({ children: 'Hi' }) }).open()
      },
    }),
  )

  await lifecycle.start(fake.claude, given({ ...pending, name: 'welcome', isInstalled: true }))
  await fake.settle()

  expect(told).toEqual([{ to: 'cmod', method: 'cmod:partsChanged', input: { parts: { widgets: [], pages: [{ id: 'hello', title: 'Hello', place: 'sidebar' }] }, requests: [{ open: 'hello' }] } }])
})

test('a failure for a permission the person turned off has a Settings button that opens its Permissions', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.store.set('cmod:announced', { version: '0.2.0', added: [] })
  const opened: unknown[] = []
  fake.fakes.cmod.call = async (call) => void opened.push(call)
  const lifecycle = createLifecycle(defineMod({ name: 'safe-delete', setup: () => void sessions.current.onSessionStart(() => model.complete({ prompt: 'Green?' } as never)) }))
  await lifecycle.start(fake.claude, given({ ...pending, isInstalled: true, steps: { permissions: ['model'] } }))
  await fake.settle()

  await fire(lifecycle, 'classic.SessionStart', sessionStart('startup'), {})
  await fake.settle()
  const button = findElement(await fire(lifecycle, 'ui.render', abovePrompt, prompt), 'Button', 'Settings')
  if (button === undefined) throw new Error('The failure toast draws no Settings button.')
  await (button['onPress'] as () => Promise<void>)()
  await fake.settle()

  expect(lifecycle.toasts).toContainEqual({ type: 'error', message: 'The onSessionStart listener failed', description: 'safe-delete calls model.complete without your grant to "Ask a model, which uses your plan". Turn it on in Settings.' })
  expect(opened).toContainEqual({ to: 'cmod', method: 'cmod:partsChanged', input: { requests: [{ settings: true, tab: 'permissions' }], isAsked: true } })
})

test('a setup that fails for a permission the person turned off still has a Settings button that opens its Permissions', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const opened: unknown[] = []
  fake.fakes.cmod.call = async (call) => void opened.push(call)
  const lifecycle = createLifecycle(defineMod({ name: 'safe-delete', setup: async () => void (await model.complete({ prompt: 'Green?' } as never)) }))
  await lifecycle.start(fake.claude, given({ ...pending, isInstalled: true, steps: { permissions: ['model'] } }))
  await fake.settle()

  const button = findElement(await fire(lifecycle, 'ui.render', abovePrompt, prompt), 'Button', 'Settings')
  if (button === undefined) throw new Error('The failed setup draws no Settings button.')
  await (button['onPress'] as () => Promise<void>)()
  await fake.settle()

  expect(opened).toContainEqual({ to: 'cmod', method: 'cmod:partsChanged', input: { requests: [{ settings: true, tab: 'permissions' }], isAsked: true } })
})

test('an answer part dropped for a permission the person turned off has a Settings button that opens its Permissions', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.store.set('cmod:announced', { version: '0.2.0', added: [] })
  const opened: unknown[] = []
  fake.fakes.cmod.call = async (call) => void opened.push(call)
  const lifecycle = createLifecycle(defineMod({ name: 'safe-delete', setup: () => void sessions.current.beforeSessionStart(() => ({ note: 'Be brief.' })) }))
  await lifecycle.start(fake.claude, given({ ...pending, isInstalled: true, steps: { permissions: ['prompt'] } }))
  await fake.settle()

  await fire(lifecycle, 'classic.SessionStart', sessionStart('startup'), {})
  await fake.settle()
  const button = findElement(await fire(lifecycle, 'ui.render', abovePrompt, prompt), 'Button', 'Settings')
  if (button === undefined) throw new Error('The dropped-answer toast draws no Settings button.')
  await (button['onPress'] as () => Promise<void>)()
  await fake.settle()

  expect(lifecycle.toasts).toContainEqual({ type: 'warning', message: 'Answered additionalContext without your grant to "Add text Claude reads and start turns", so cmod dropped it', description: 'Turn it on in Settings.' })
  expect(opened).toContainEqual({ to: 'cmod', method: 'cmod:partsChanged', input: { requests: [{ settings: true, tab: 'permissions' }], isAsked: true } })
})

test('a mod loaded mid-session, which hears no SessionStart, runs its session-start listeners before the next prompt, once', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.store.set('cmod:announced', { version: '0.2.0', added: [] })
  const starts: string[] = []
  const lifecycle = createLifecycle(defineMod({ name: 'safe-delete', setup: () => void sessions.current.onSessionStart((start) => void starts.push(start.source)) }))
  await lifecycle.start(fake.claude, given({ ...pending, isInstalled: true }))
  await fake.settle()

  await fire(lifecycle, 'classic.UserPromptSubmit', { ...sessionStart('startup'), hook_event_name: 'UserPromptSubmit', prompt: 'hello' }, {})
  await fire(lifecycle, 'classic.UserPromptSubmit', { ...sessionStart('startup'), hook_event_name: 'UserPromptSubmit', prompt: 'again' }, {})
  await fake.settle()

  expect(starts).toEqual(['resume'])
})

test('an update with no changelog says what the mod adds now, links its release, and has no Changelog button', async () => {
  const installed = '/home/.claude/plugins/cache/market/safe-delete/0.2.0'
  const manifest = JSON.stringify({ name: 'safe-delete', version: '0.2.0', repository: 'https://github.com/owner/safe-delete' })
  const { lifecycle } = await updatedFrom({ version: '0.1.0', added: ['the Trash pane', 'the Bin pane'] }, { [`${installed}/.claude-plugin/plugin.json`]: manifest }, installed)

  expect(lifecycle.toasts).toEqual([
    {
      type: 'success',
      message: 'Updated to 0.2.0',
      description: 'No longer adds the Bin pane.\nFrom 0.1.0.\nRelease notes: https://github.com/owner/safe-delete/releases/tag/v0.2.0',
    },
  ])
  expect(findElement(await fire(lifecycle, 'ui.render', abovePrompt, prompt), 'Button', 'Changelog')).toBeUndefined()
})

test('a version this machine already announced shows no toast', async () => {
  const { lifecycle } = await updatedFrom({ version: '0.2.0', added: [] }, { [`${root}/CHANGELOG.md`]: changelog })

  expect(lifecycle.toasts).toEqual([])
})

const recordFile = '/home/.local/share/cmod/records/safe-delete.json'

function stoppedSession(firstOutcome: string, code: number) {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const disk = fakeFiles({})
  fake.fakes.fs.stat = disk.stat
  fake.fakes.fs.read = disk.read
  installCmod(fake)
  fake.fakes.process.spawn = () => finished([firstOutcome], code)
  const { runs, definition } = trackedMod()
  return { fake, disk, runs, lifecycle: createLifecycle(definition) }
}

const installedNow = (installed: { isInstalled: boolean }) => async () => ({ ...pending, isInstalled: installed.isInstalled })

test('two sessions whose install failed start on their next prompt once cmod install writes the record, with no reload', async () => {
  const installed = { isInstalled: false }
  const sessions = [stoppedSession('failed 1\tdisk full', 1), stoppedSession('failed 1\tdisk full', 1)]
  for (const { fake, lifecycle } of sessions) {
    await lifecycle.start(fake.claude, installedNow(installed))
    await fake.settle()
  }
  expect(sessions.map(({ lifecycle }) => lifecycle.phase)).toEqual(['failed', 'failed'])

  installed.isInstalled = true
  for (const { disk } of sessions) await disk.write(recordFile, '{}')
  for (const { lifecycle } of sessions) await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})
  for (const { lifecycle } of sessions) await fire(lifecycle, 'classic.PostToolBatch', toolBatch, {})

  expect(sessions.map(({ lifecycle }) => lifecycle.phase)).toEqual(['active', 'active'])
  expect(sessions.map(({ lifecycle }) => lifecycle.failure)).toEqual([undefined, undefined])
  expect(sessions.map(({ runs }) => runs)).toEqual([
    ['setup', 'PostToolBatch'],
    ['setup', 'PostToolBatch'],
  ])
})

test('a mod whose install was declined starts on the next prompt once cmod install writes the record', async () => {
  const installed = { isInstalled: false }
  const { fake, disk, runs, lifecycle } = stoppedSession('needs-consent abc123\t./setup/install.sh\t', 10)
  await lifecycle.start(fake.claude, installedNow(installed))
  await fake.settle()
  await pressInInstaller(lifecycle, 'not-now')
  await fake.settle()
  expect(lifecycle.phase).toBe('declined')

  installed.isInstalled = true
  await disk.write(recordFile, '{}')
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect(lifecycle.phase).toBe('active')
  expect(runs).toEqual(['setup'])
})

test('a mod waiting on its install question starts with no answer once another cmod writes its install record, and closes the question', async () => {
  const installed = { isInstalled: false }
  const { fake, disk, runs, lifecycle } = stoppedSession('needs-consent abc123\t./setup/install.sh\t', 10)
  const timers = repeatingTimers(fake)
  await lifecycle.start(fake.claude, installedNow(installed))
  await fake.settle()
  expect(lifecycle.toasts).toEqual([{ type: 'info', message: 'Installing', description: 'Waiting for your answer' }])

  installed.isInstalled = true
  await disk.write(recordFile, '{}')
  timers.fire()
  await fake.settle()

  expect(lifecycle.phase).toBe('active')
  expect(runs).toEqual(['setup'])
  expect(installRequests(fake)).toEqual([installerOpen, { requests: [{ close: installPage }] }])
  expect(lifecycle.toasts.map(({ message }) => message)).toEqual(['Installed'])
  expect(timers.running()).toEqual([])
})

test('a mod whose install failed starts with no prompt once another cmod writes its install record', async () => {
  const installed = { isInstalled: false }
  const { fake, disk, runs, lifecycle } = stoppedSession('failed 1\tdisk full', 1)
  const timers = repeatingTimers(fake)
  await lifecycle.start(fake.claude, installedNow(installed))
  await fake.settle()
  expect(lifecycle.phase).toBe('failed')

  installed.isInstalled = true
  await disk.write(recordFile, '{}')
  timers.fire()
  await fake.settle()

  expect(lifecycle.phase).toBe('active')
  expect(runs).toEqual(['setup'])
  expect(timers.running()).toEqual([])
})

test('a mod whose install was declined starts with no prompt once another cmod writes its install record', async () => {
  const installed = { isInstalled: false }
  const { fake, disk, runs, lifecycle } = stoppedSession('needs-consent abc123\t./setup/install.sh\t', 10)
  const timers = repeatingTimers(fake)
  await lifecycle.start(fake.claude, installedNow(installed))
  await fake.settle()
  await pressInInstaller(lifecycle, 'not-now')
  await fake.settle()
  expect(lifecycle.phase).toBe('declined')

  installed.isInstalled = true
  await disk.write(recordFile, '{}')
  timers.fire()
  await fake.settle()

  expect(lifecycle.phase).toBe('active')
  expect(runs).toEqual(['setup'])
  expect(lifecycle.toasts.map(({ message }) => message)).toEqual(['Installed'])
  expect(timers.running()).toEqual([])
})

test('a mod whose first start failed after its install starts again once cmod install rewrites its record', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const disk = fakeFiles({})
  fake.fakes.fs.stat = disk.stat
  fake.fakes.fs.read = disk.read
  installCmod(fake)
  fake.fakes.process.spawn = () => finished(['done safe-delete 0.2.0'], 0)
  let setups = 0
  const lifecycle = createLifecycle(
    defineMod({
      name: 'safe-delete',
      setup() {
        setups += 1
        if (setups === 1) throw new Error('the first setup fails')
      },
    }),
  )
  const installed = { isInstalled: false }
  await lifecycle.start(fake.claude, installedNow(installed))
  await fake.settle()
  await fire(lifecycle, 'classic.PostToolBatch', toolBatch, {})
  await fake.settle()
  expect(lifecycle.phase).toBe('failed')

  installed.isInstalled = true
  await disk.write(recordFile, '{}')
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})
  await fake.settle()

  expect(lifecycle.phase).toBe('active')
  expect(setups).toBe(2)
})

test('a stopped mod whose record is unchanged stays stopped across prompts and shows its error once', async () => {
  const installed = { isInstalled: false }
  const { fake, runs, lifecycle } = stoppedSession('failed 1\tdisk full', 1)
  await lifecycle.start(fake.claude, installedNow(installed))
  await fake.settle()

  installed.isInstalled = true
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect(lifecycle.phase).toBe('failed')
  expect(runs).toEqual([])
  expect(lifecycle.toasts).toEqual([{ type: 'error', message: 'disk full' }])
})

test('an install error longer than the band wraps its message across the band, with its buttons on a line under it', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  const error = 'cmod bootstrap: cmod is installed at /home/me/.local/bin/cmod, but PATH finds no cmod. Put /home/me/.local/bin first on PATH, then restart Claude Code.'
  fake.fakes.process.spawn = () => finished([`failed 1\t${error}`], 1)
  const lifecycle = createLifecycle(trackedMod().definition)
  const narrowBand = { ...abovePrompt, viewport: { columns: 40, rows: 30 } }

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(rowsOf(await fire(lifecycle, 'ui.render', narrowBand, prompt), 40).map((row) => row.trimEnd())).toEqual([
    '>',
    '✗  safe-delete  cmod bootstrap: cmod is',
    '                installed at',
    '                /home/me/.local/bin/cmod',
    '                , but PATH finds no',
    '                cmod. Put',
    '                /home/me/.local/bin',
    '                first on PATH, then',
    '                restart Claude Code.',
    '                Retry  Report  Hide  09:05',
  ])
})

function retryingFake(setups: readonly (readonly string[])[]) {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  const setupsRun: string[][] = []
  fake.fakes.process.spawn = (request) => {
    setupsRun.push([...request.argv])
    const lines = setups[Math.min(setupsRun.length - 1, setups.length - 1)] ?? []
    return finished(lines, lines.some((line) => line.startsWith('done')) ? 0 : 1)
  }
  const timers: { ms: number; fire: () => void; isCancelled: boolean }[] = []
  fake.fakes.clock.after = (ms, fire) => {
    const made = { ms, fire, isCancelled: false }
    if (ms === 0) void Promise.resolve().then(fire)
    else timers.push(made)
    return { cancel: () => void (made.isCancelled = true) }
  }
  const fire = async (ms: number) => {
    const made = timers.find((each) => each.ms === ms && !each.isCancelled)
    if (made === undefined) throw new Error(`No timer of ${ms} ms is waiting.`)
    made.isCancelled = true
    made.fire()
    await fake.settle()
  }
  return { fake, setupsRun, timers, fire }
}

const notYet = 'failed 1\tThe v0.2.0 release of safe-delete has no SHA256SUMS yet. Its author attaches it with cmod publish.'

test('a release download that is not there yet shows the failure at once, retries in the background, and clears the failure when it works', async () => {
  const { fake, setupsRun, fire } = retryingFake([[notYet, 'retries later'], [notYet, 'retries later'], ['done safe-delete 0.2.0']])
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  const first = lifecycle.toasts
  await fire(2000)
  const second = lifecycle.toasts
  await fire(4000)

  expect(first).toEqual(failed('The v0.2.0 release of safe-delete has no SHA256SUMS yet. Its author attaches it with cmod publish.', 'Trying again in 2 s.'))
  expect(second).toEqual(failed('The v0.2.0 release of safe-delete has no SHA256SUMS yet. Its author attaches it with cmod publish.', 'Trying again in 4 s.'))
  expect(setupsRun).toHaveLength(3)
  expect(lifecycle.toasts.filter((toast) => toast.type === 'error')).toEqual([])
})

test('the background retry waits 2 s up to 128 s, then every 128 s', async () => {
  const { fake, timers, fire } = retryingFake([[notYet, 'retries later']])
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  for (const ms of [2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 128_000]) await fire(ms)

  expect(timers.map((made) => made.ms)).toEqual([2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 128_000, 128_000])
})

test('a failure that waiting cannot fix, such as a failed install step of a release, waits for Retry', async () => {
  const { fake, timers } = retryingFake([['failed 1\tThe install step of safe-delete exited 1.']])
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(lifecycle.toasts).toEqual(failed('The install step of safe-delete exited 1.'))
  expect(timers).toEqual([])
})

test('a retry after the person accepted carries that consent, so it never asks again, and the install page closes on Accept', async () => {
  const broken = 'failed 1\tThe install step of safe-delete exited 1.'
  const { fake, setupsRun, fire } = retryingFake([['needs-consent abc123\t./setup/install.sh\t'], [broken, 'retries changed'], ['done safe-delete 0.2.0']])
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  await pressInInstaller(lifecycle, 'accept')
  await fake.settle()
  await fire(2000)

  expect(setupsRun.map((argv) => argv.slice(-2))).toEqual([[pending.root, '--events'], ['--consent', 'abc123'], ['--consent', 'abc123']])
  expect(installRequests(fake)).toEqual([installerOpen, { requests: [{ close: installPage }] }])
  expect(lifecycle.toasts.filter((toast) => toast.type === 'error')).toEqual([])
})

test('a checkout whose steps did not change keeps running while its new version builds, and a failed build shows its own error', async () => {
  const fake = await raisedCheckout(root)
  installCmod(fake)
  const broken = 'Building trace with "cargo xtask dist" exited 101: error[E0425]: cannot find value `x`. Fix the build in ~/Developer/trace/cli, then save a file there or run the command again.'
  const outcomes = [[`failed 1\t${broken}`, 'retries changed'], ['done safe-delete 0.3.0']]
  fake.fakes.process.spawn = () => {
    const lines = outcomes.shift() ?? []
    return finished(lines, lines[0]?.startsWith('done') === true ? 0 : 1)
  }
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, readPlugin)
  await fake.settle()

  expect(runs).toEqual(['setup'])
  expect(lifecycle.toasts.filter((toast) => toast.message === 'Installing')).toEqual([])
  expect(lifecycle.toasts.filter((toast) => toast.type === 'error')).toEqual(failed(broken))

  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})
  await fake.settle()

  expect(lifecycle.toasts.filter((toast) => toast.type === 'error')).toEqual([])
})

test('a waiting mod continues its install once the cmod program appears, with no further event', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const spawned: ProcessSpawnRequest[] = []
  fake.fakes.process.spawn = (request) => {
    spawned.push(request)
    return finished(['done safe-delete 0.2.0'], 0)
  }
  const timers: { ms: number; fire: () => void; isCancelled: boolean }[] = []
  fake.claude.clock.every = (ms, fire) => {
    const timer = { ms, fire, isCancelled: false }
    timers.push(timer)
    return { cancel: () => (timer.isCancelled = true) }
  }
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  const cmodCheck = timers.find((timer) => timer.ms === 1000)
  cmodCheck?.fire()
  await fake.settle()

  expect(spawned).toEqual([])
  expect(lifecycle.toasts).toEqual([{ type: 'loading', message: 'Installing', description: 'Waiting for cmod' }])

  installCmod(fake)
  cmodCheck?.fire()
  await fake.settle()

  expect(spawned).toEqual([{ argv: [cmodProgram, 'setup', root, '--events'] }])
  expect(cmodCheck?.isCancelled).toBe(true)
  expect(runs).toEqual(['setup'])
})

test('a mod whose cmod stays older than the library it bundles for a minute updates cmod, and sets up once cmod updates', async () => {
  const fake = fakeClaude({ name: 'modes', root })
  installCmod(fake, '3.1.0')
  const spawned: ProcessSpawnRequest[] = []
  fake.fakes.process.spawn = (request) => {
    spawned.push(request)
    return finished(request.argv[1] === 'setup' ? ['done modes 0.2.0'] : [], 0)
  }
  const timers: { ms: number; fire: () => void; isCancelled: boolean }[] = []
  const timer = (ms: number, fire: () => void) => {
    const made = { ms, fire, isCancelled: false }
    timers.push(made)
    return { cancel: () => (made.isCancelled = true) }
  }
  fake.fakes.clock.every = timer
  fake.fakes.clock.after = timer
  const lifecycle = createLifecycle(defineMod({ name: 'modes', setup() {} }))

  await lifecycle.start(fake.claude, given({ ...pending, name: 'modes' }))
  await fake.settle()
  timers.find((made) => made.ms === 1000)?.fire()
  await fake.settle()
  timers.find((made) => made.ms === 60_000)?.fire()
  await fake.settle()

  expect(spawned).toEqual([{ argv: [cmodProgram, 'update', 'cmod'] }])
  expect(lifecycle.toasts).toEqual([{ type: 'loading', message: 'Installing', description: `modes needs cmod ${coreVersion} or later, and this computer has cmod 3.1.0, so cmod is updating itself.` }])

  installCmod(fake)
  timers.find((made) => made.ms === 10_000)?.fire()
  await fake.settle()

  expect(spawned).toEqual([{ argv: [cmodProgram, 'update', 'cmod'] }, { argv: [cmodProgram, 'setup', root, '--events'] }])
})

test('a mod runs one update for an older cmod, and when the update leaves it older, the next wait shows why with Retry instead of updating again', async () => {
  const fake = fakeClaude({ name: 'modes', root })
  installCmod(fake, '3.1.0')
  const spawned: string[] = []
  fake.fakes.process.spawn = (request) => (spawned.push(request.argv.slice(1).join(' ')), finished([], 0))
  const timers: { ms: number; fire: () => void }[] = []
  fake.fakes.clock.after = (ms, fire) => (timers.push({ ms, fire }), { cancel: () => {} })
  fake.fakes.clock.every = fake.fakes.clock.after
  const wait = async () => {
    const lifecycle = createLifecycle(defineMod({ name: 'modes', setup() {} }))
    await lifecycle.start(fake.claude, given({ ...pending, name: 'modes' }))
    await fake.settle()
    timers.splice(0).find((made) => made.ms === 60_000)?.fire()
    await fake.settle()
    return lifecycle
  }

  await wait()
  const reloaded = await wait()

  expect(spawned).toEqual(['update cmod'])
  expect(reloaded.toasts).toEqual(failed(`modes needs cmod ${coreVersion} or later, and the newest cmod is 3.1.0.`))

  const retry = findElement(await fire(reloaded, 'ui.render', abovePrompt, prompt), 'Button', 'Retry')
  if (retry === undefined) throw new Error('The failure draws no Retry button.')
  await (retry['onPress'] as () => Promise<void>)()
  await fake.settle()
  timers.splice(0).find((made) => made.ms === 60_000)?.fire()
  await fake.settle()

  expect(spawned).toEqual(['update cmod', 'update cmod'])
})

test('a failed update of an older cmod shows its error with Retry', async () => {
  const fake = fakeClaude({ name: 'modes', root })
  installCmod(fake, '3.1.0')
  fake.fakes.process.spawn = () => {
    const step = controlledStream()
    step.printError('cmod update: claude plugin update cmod@cmod failed: Requires "cmod@cmod" ^3.0.0')
    step.exit(1)
    return step.stream
  }
  const timers: { ms: number; fire: () => void }[] = []
  fake.fakes.clock.after = (ms, fire) => (timers.push({ ms, fire }), { cancel: () => {} })
  fake.fakes.clock.every = fake.fakes.clock.after
  const lifecycle = createLifecycle(defineMod({ name: 'modes', setup() {} }))

  await lifecycle.start(fake.claude, given({ ...pending, name: 'modes' }))
  await fake.settle()
  timers.find((made) => made.ms === 60_000)?.fire()
  await fake.settle()

  expect(lifecycle.toasts).toEqual(failed(`modes needs cmod ${coreVersion} or later, and updating cmod 3.1.0 exited 1: cmod update: claude plugin update cmod@cmod failed: Requires "cmod@cmod" ^3.0.0`))
})

test('a mod keeps waiting for cmod past 60 seconds and starts once cmod is ready', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const spawned: ProcessSpawnRequest[] = []
  fake.fakes.process.spawn = (request) => {
    spawned.push(request)
    return finished(['done safe-delete 0.2.0'], 0)
  }
  const timers: { ms: number; fire: () => void; isCancelled: boolean }[] = []
  const timer = (ms: number, fire: () => void) => {
    const made = { ms, fire, isCancelled: false }
    timers.push(made)
    return { cancel: () => (made.isCancelled = true) }
  }
  fake.fakes.clock.every = timer
  fake.fakes.clock.after = timer
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  timers.find((made) => made.ms === 60_000)?.fire()
  await fake.settle()

  expect(lifecycle.toasts).toEqual([{ type: 'loading', message: 'Installing', description: "Still waiting for cmod to download cmod. See cmod's own line." }])

  installCmod(fake)
  timers.find((made) => made.ms === 1000)?.fire()
  await fake.settle()
  timers.find((made) => made.ms === 0)?.fire()
  await fake.settle()
  await fire(lifecycle, 'classic.PostToolBatch', toolBatch, {})

  expect(spawned).toEqual([{ argv: [cmodProgram, 'setup', root, '--events'] }])
  expect(timers.filter((made) => made.ms === 1000 || made.ms === 60_000).map((made) => made.isCancelled)).toEqual([true, true])
  expect(runs).toEqual(['setup', 'PostToolBatch'])
})

test('a mod whose setup function throws says its setup function threw, and leaves no listener registered', async () => {
  const fake = fakeClaude({ name: 'broken', root })
  let hookRuns = 0
  const lifecycle = createLifecycle(
    defineMod({
      name: 'broken',
      setup() {
        sessions.current.beforeToolBatch(() => {
          hookRuns += 1
        })
        throw new Error('no config file')
      },
    }),
  )

  await lifecycle.start(fake.claude, given({ ...pending, name: 'broken', isInstalled: true }))
  await fire(lifecycle, 'classic.PostToolBatch', toolBatch, {})

  expect(hookRuns).toBe(0)
  expect(lifecycle.toasts).toEqual(failed('its setup function threw: no config file'))

  const copied: string[] = []
  fake.fakes.ui.copy = async ({ text }) => (copied.push(text), { isCopied: true })
  const press = async (label: string) => {
    const button = findElement(await fire(lifecycle, 'ui.render', abovePrompt, prompt), 'Button', label)
    if (button === undefined) throw new Error(`The toast draws no ${label} button.`)
    await (button['onPress'] as () => Promise<void>)()
    await fake.settle()
  }
  await press('Report')
  await press('Copy the error')
  expect(copied[0]).toContain('its setup function threw: no config file')
  expect(copied[0]).toContain('\n    at ')
})

test('a mod whose state fails to load says its state did not load', async () => {
  const fake = fakeClaude({ name: 'broken', root })
  fake.claude.store.get = async () => Promise.reject(new Error('the store file is locked'))
  const lifecycle = createLifecycle(defineMod({ name: 'broken', state: { project: { expanded: [] as string[] } }, setup() {} }))

  await lifecycle.start(fake.claude, given({ ...pending, name: 'broken', isInstalled: true }))

  expect(lifecycle.toasts).toEqual(failed('its state did not load: the store file is locked'))
})

test('a missing secret option asks in the installer to set it in /config, with a button that opens it, and Not now fails with a Retry that asks again', async () => {
  const fake = fakeClaude({ name: 'ci-watch', root })
  const ran: string[] = []
  fake.fakes.command.run = async ({ command }) => (ran.push(command), {})
  const token = option.secret({ title: 'GitHub token', description: 'Reads your CI runs' })
  const lifecycle = createLifecycle(defineMod({ name: 'ci-watch', options: { githubToken: token }, setup() {} }))

  void lifecycle.start(fake.claude, given({ ...pending, name: 'ci-watch', isInstalled: true }))
  await fake.settle()

  expect(await installerText(lifecycle, 'ci-watch')).toContain('Set it in /config, where Claude Code keeps it in your keychain')
  await pressInInstaller(lifecycle, 'secret:githubToken', 'ci-watch')
  expect(ran).toEqual(['config'])
  await pressInInstaller(lifecycle, 'not-now', 'ci-watch')
  await fake.settle()
  expect(lifecycle.toasts).toEqual(failed('it needs GitHub token', 'Retry asks for it.'))
})

test('a missing text option saved in the installer through cmod option starts the mod on Next', async () => {
  const fake = fakeClaude({ name: 'ci-watch', root })
  const saved: (readonly string[])[] = []
  const rows: { key: string; value: string }[] = []
  fake.fakes.process.run = async (argv) => {
    saved.push(argv)
    if (argv[1] === 'option') rows.push({ key: `${argv[2]}.${argv[3]}`, value: argv[4] ?? '' })
    return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  }
  fake.fakes.config.list = async () => rows.map((row) => ({ ...row, label: row.key, kind: 'text', provider: { plugin: 'ci-watch', tier: 'user' }, isLocked: false }) as never)
  let branch: unknown
  const lifecycle = createLifecycle(defineMod({ name: 'ci-watch', options: { branch: option.text({ title: 'Branch', description: '' }) }, setup: (mod) => void (branch = mod.options.branch) }))

  void lifecycle.start(fake.claude, given({ ...pending, name: 'ci-watch', isInstalled: true }))
  await fake.settle()
  await submitInInstaller(lifecycle, 'option:branch', 'main', 'ci-watch')
  await fake.settle()
  expect(await installerText(lifecycle, 'ci-watch')).toContain('✓ saved')
  await pressInInstaller(lifecycle, 'next', 'ci-watch')
  await fake.settle()

  expect(saved).toContainEqual([cmodProgram, 'option', 'ci-watch', 'branch', 'main'])
  expect(lifecycle.phase).toBe('active')
  expect(branch).toBe('main')
})

test('a mod whose setup fails after the person saved its settings closes its install page', async () => {
  const fake = fakeClaude({ name: 'ci-watch', root })
  const rows: { key: string; value: string }[] = []
  fake.fakes.process.run = async (argv) => {
    if (argv[1] === 'option') rows.push({ key: `${argv[2]}.${argv[3]}`, value: argv[4] ?? '' })
    return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  }
  fake.fakes.config.list = async () => rows.map((row) => ({ ...row, label: row.key, kind: 'text', provider: { plugin: 'ci-watch', tier: 'user' }, isLocked: false }) as never)
  const lifecycle = createLifecycle(
    defineMod({
      name: 'ci-watch',
      options: { branch: option.text({ title: 'Branch', description: '' }) },
      setup: () => {
        throw new Error('the GitHub API is down')
      },
    }),
  )

  void lifecycle.start(fake.claude, given({ ...pending, name: 'ci-watch', isInstalled: true }))
  await fake.settle()
  await submitInInstaller(lifecycle, 'option:branch', 'main', 'ci-watch')
  await fake.settle()
  await pressInInstaller(lifecycle, 'next', 'ci-watch')
  await fake.settle()

  expect(lifecycle.phase).toBe('failed')
  expect(installRequests(fake).at(-1)).toEqual({ requests: [{ close: installPage }] })
})

test("a mod's own installer step opens after it starts, and Finish waits for isDone", async () => {
  const fake = fakeClaude({ name: 'ci-watch', root })
  let isSignedIn = false
  const lifecycle = createLifecycle(
    defineMod({
      name: 'ci-watch',
      installer: [{ id: 'sign-in', title: 'Sign in to GitHub', render: () => Text({ children: 'Press s to sign in.' }), isDone: () => isSignedIn }],
      setup() {},
    }),
  )

  await lifecycle.start(fake.claude, given({ ...pending, name: 'ci-watch', isInstalled: true }))
  await fake.settle()

  expect(await installerText(lifecycle, 'ci-watch')).toContain('Sign in to GitHub  (1 of 1)')
  await pressInInstaller(lifecycle, 'next', 'ci-watch')
  expect(await installerText(lifecycle, 'ci-watch')).toContain('Finish Sign in to GitHub first.')
  isSignedIn = true
  await pressInInstaller(lifecycle, 'next', 'ci-watch')
  await fake.settle()
  expect(installRequests(fake)).toEqual([installerOpen, { requests: [{ close: installPage }] }])
})

test("a step whose isDone fails stays pending, shows the failure, and Finish shows it in the installer", async () => {
  const fake = fakeClaude({ name: 'ci-watch', root })
  const lifecycle = createLifecycle(
    defineMod({
      name: 'ci-watch',
      installer: [{ id: 'sign-in', title: 'Sign in to GitHub', render: () => Text({ children: 'Press s to sign in.' }), isDone: () => { throw new Error('gh is not installed') } }],
      setup() {},
    }),
  )

  await lifecycle.start(fake.claude, given({ ...pending, name: 'ci-watch', isInstalled: true }))
  await fake.settle()

  expect(lifecycle.toasts).toContainEqual({ type: 'error', message: "The Sign in to GitHub step's isDone failed", description: 'gh is not installed' })
  await pressInInstaller(lifecycle, 'next', 'ci-watch')
  expect(await installerText(lifecycle, 'ci-watch')).toContain("The Sign in to GitHub step's isDone failed: gh is not installed")
})

test('a step left on Not now keeps a Finish button and is listed to /mods, and finishing opens the installer on it again without waiting for the person', async () => {
  const fake = fakeClaude({ name: 'ci-watch', root })
  let isSignedIn = false
  const lifecycle = createLifecycle(
    defineMod({
      name: 'ci-watch',
      installer: [{ id: 'sign-in', title: 'Sign in to GitHub', render: () => Text({ children: 'Press s to sign in.' }), isDone: () => isSignedIn }],
      setup() {},
    }),
  )
  await lifecycle.start(fake.claude, given({ ...pending, name: 'ci-watch', isInstalled: true }))
  await fake.settle()
  await pressInInstaller(lifecycle, 'not-now', 'ci-watch')
  await fake.settle()

  expect(lifecycle.toasts).toContainEqual({ type: 'warning', message: 'Needs one more step', description: 'Starting with Sign in to GitHub.' })
  expect(findElement(await fire(lifecycle, 'ui.render', abovePrompt, prompt), 'Button', 'Finish')).toBeDefined()
  expect(await fire(lifecycle, 'cmod.call', { to: 'ci-watch', method: 'cmod:pendingSteps', input: null }, { deny: '' })).toEqual({ value: ['Sign in to GitHub'] })

  expect(await fire(lifecycle, 'cmod.call', { to: 'ci-watch', method: 'cmod:finishSteps', input: null }, { deny: '' })).toEqual({ value: installerOpen })
  expect(await installerText(lifecycle, 'ci-watch')).toContain('Sign in to GitHub  (1 of 1)')
  isSignedIn = true
  await pressInInstaller(lifecycle, 'next', 'ci-watch')
  await fake.settle()
  expect(await fire(lifecycle, 'cmod.call', { to: 'ci-watch', method: 'cmod:pendingSteps', input: null }, { deny: '' })).toEqual({ value: [] })
})

test('a mod that hears permissions without registerPermissionCheck does not start, and names the line to add', async () => {
  const fake = fakeClaude({ name: 'guard', root })
  const lifecycle = createLifecycle(defineMod({ name: 'guard', setup: () => void sessions.current.onPermissionCheck(() => undefined) }), () => undefined)

  await lifecycle.start(fake.claude, given({ ...pending, name: 'guard', isInstalled: true }))

  expect(lifecycle.toasts).toEqual(
    failed("its setup function threw: guard: onPermissionCheck hears Claude Code's permission check, so hooks/register.ts must call registerPermissionCheck(addHook) after registerMod."),
  )
})

test('the permissions job without registerPermissionCheck throws where it is used, in setup or after it', async () => {
  const forcePush = permissions({ deny: [{ command: 'git push --force', reason: 'Never force-push.' }] })
  const advice = "guard: the permissions job hears Claude Code's permission check, so hooks/register.ts must call registerPermissionCheck(addHook) after registerMod."
  const inSetup = createLifecycle(defineMod({ name: 'guard', setup: (mod) => mod.use(forcePush) }), () => undefined)
  let started: Mod | undefined
  const later = createLifecycle(defineMod({ name: 'guard', setup: (mod) => void (started = mod) }), () => undefined)

  await inSetup.start(fakeClaude({ name: 'guard', root }).claude, given({ ...pending, name: 'guard', isInstalled: true }))
  await later.start(fakeClaude({ name: 'guard', root }).claude, given({ ...pending, name: 'guard', isInstalled: true }))

  expect(inSetup.toasts).toEqual(failed(`its setup function threw: ${advice}`))
  expect(later.phase).toBe('active')
  let thrown: unknown
  try {
    started?.use(forcePush)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toEqual(new Error(advice))
})

test('a mod that decides permissions starts once registerPermissionCheck registered the permission events', async () => {
  const fake = fakeClaude({ name: 'guard', root })
  const lifecycle = createLifecycle(defineMod({ name: 'guard', setup: () => void sessions.current.beforePermissionRequest(() => undefined) }), () => permissionRoutes)

  await lifecycle.start(fake.claude, given({ ...pending, name: 'guard', isInstalled: true }))

  expect(lifecycle.phase).toBe('active')
})

test('a mod that refuses tool calls starts without registerPermissionCheck', async () => {
  const fake = fakeClaude({ name: 'docs', root })
  const lifecycle = createLifecycle(defineMod({ name: 'docs', setup: () => void sessions.current.beforeToolCall(() => undefined) }), () => undefined)

  await lifecycle.start(fake.claude, given({ ...pending, name: 'docs', isInstalled: true }))

  expect(lifecycle.phase).toBe('active')
})

test('a mod whose open panes cannot be read says its open panes did not load', async () => {
  const fake = fakeClaude({ name: 'broken', root })
  fake.claude.ui.panes = async () => Promise.reject(new Error('the pane list is unavailable'))
  const lifecycle = createLifecycle(defineMod({ name: 'broken', setup: (mod) => void mod.panes.add({ id: 'trash', title: 'Trash', render: () => Text({ children: 'empty' }) }) }))

  await lifecycle.start(fake.claude, given({ ...pending, name: 'broken', isInstalled: true }))

  expect(lifecycle.toasts).toEqual(failed('its open panes did not load: the pane list is unavailable'))
})

test("the cmod plugin runs its bootstrap from its root, and its mod.dataFolder names its data folder", async () => {
  const fake = fakeClaude({ name: 'cmod', root })
  const spawned: ProcessSpawnRequest[] = []
  fake.fakes.process.spawn = (request) => {
    spawned.push(request)
    return finished([], 0)
  }
  let folder: string | undefined
  const lifecycle = createLifecycle(
    defineMod({
      name: 'cmod',
      setup(mod) {
        folder = mod.dataFolder
      },
    }),
  )

  await lifecycle.start(fake.claude, given({ ...pending, name: 'cmod' }))
  await fake.settle()
  await fire(lifecycle, 'classic.PostToolBatch', toolBatch, {})

  expect(spawned).toEqual([{ argv: ['sh', '-c', './setup/bootstrap.sh'], cwd: root }])
  expect(folder).toBe('/home/.local/share/cmod/data/cmod')
})

test('the cmod plugin counts as installed when the cmod program is its version or newer', async () => {
  const fake = fakeClaude({ name: 'cmod', root })
  Object.assign(fake.fakes.fs, fakeFiles({ [`${root}/.claude-plugin/plugin.json`]: '{ "name": "cmod", "version": "0.1.10" }' }))
  const installedWith = async (program: string) => {
    installCmod(fake, program)
    return (await readPlugin(fake.claude)).isInstalled
  }

  expect(await installedWith('0.1.10')).toBe(true)
  expect(await installedWith('0.2.0')).toBe(true)
  expect(await installedWith('0.1.9')).toBe(false)
  expect(await installedWith('0.1.9-rc.1')).toBe(false)
})

test('readPlugin reads the install step, the version, and whether the record matches the scripts', async () => {
  const files: Record<string, string> = {
    [`${root}/.claude-plugin/plugin.json`]: '{ "name": "safe-delete", "version": "0.2.0" }',
    [`${root}/package.json`]: '{ "cmod": { "install": "./setup/install.sh" } }',
    [`${root}/setup/install.sh`]: 'echo "progress 1 1 Done"\n',
  }
  const fileAt = (path: string) => files[path.replaceAll('/./', '/')]
  const sha = await scriptsSha256({ install: './setup/install.sh' }, { read: async (path) => fileAt(`${root}/${path}`), list: async (folder) => (await entriesIn(files)(`${root}/${folder}`)).map((entry) => entry.name) })
  files['/test/home/.local/share/cmod/records/safe-delete.json'] = JSON.stringify({
    name: 'safe-delete',
    version: '0.2.0',
    root,
    installedAt: '2026-10-05T00:00:00.000Z',
    scriptsSha256: sha,
    uninstall: null,
    program: null,
  })
  const fake = fakeClaude({ name: 'safe-delete', root })
  Object.assign(fake.fakes.fs, fakeFiles(files))

  expect(await readPlugin(fake.claude)).toEqual({ ...pending, isInstalled: true, store: '/test/home/.local/share/cmod', steps: { install: './setup/install.sh' } })

  await fake.claude.fs.write(`${root}/setup/install.sh`, 'echo changed\n')
  expect((await readPlugin(fake.claude)).isInstalled).toBe(false)
})

test('a new version in the folder its record names keeps the install when its steps are the same, and records it again', async () => {
  const fake = await raisedCheckout(root)

  expect(await readPlugin(fake.claude)).toMatchObject({ isInstalled: true, shouldRecord: true })

  const moved = await raisedCheckout('/test/plugins/cache/safe-delete/0.1.0')
  expect(await readPlugin(moved.claude)).toMatchObject({ isInstalled: false, shouldRecord: false })
})

async function raisedCheckout(recordedRoot: string) {
  const files: Record<string, string> = {
    [`${root}/.claude-plugin/plugin.json`]: '{ "name": "safe-delete", "version": "0.3.0" }',
    [`${root}/package.json`]: '{ "cmod": { "install": "./setup/install.sh" } }',
    [`${root}/setup/install.sh`]: 'brew install trash\n',
  }
  const sha = await scriptsSha256({ install: './setup/install.sh' }, { read: async (path) => files[`${root}/${path.replace(/^\.\//, '')}`], list: async () => ['install.sh'] })
  files['/test/home/.local/share/cmod/records/safe-delete.json'] = JSON.stringify({ name: 'safe-delete', version: '0.2.0', root: recordedRoot, installedAt: '2026-10-05T00:00:00.000Z', scriptsSha256: sha, uninstall: null, program: 'trace', keys: {} })
  const fake = fakeClaude({ name: 'safe-delete', root })
  Object.assign(fake.fakes.fs, fakeFiles(files))
  return fake
}

test("the SDK lists files in a script's subfolders", async () => {
  const files: Record<string, string> = {
    [`${root}/.claude-plugin/plugin.json`]: '{ "name": "safe-delete", "version": "0.2.0" }',
    [`${root}/package.json`]: '{ "cmod": { "install": "./setup/install.sh" } }',
    [`${root}/setup/install.sh`]: '. ./setup/lib/brew.sh\n',
    [`${root}/setup/lib/brew.sh`]: 'brew install trash\n',
  }
  const fileAt = (path: string) => files[path.replaceAll('/./', '/')]
  const below = (folder: string) => {
    const prefix = `${root}/${folder}/`.replaceAll('/./', '/')
    return Object.keys(files).flatMap((path) => (path.startsWith(prefix) ? [path.slice(prefix.length)] : [])).sort()
  }
  const sha = await scriptsSha256({ install: './setup/install.sh' }, { read: async (path) => fileAt(`${root}/${path}`), list: async (folder) => below(folder) })
  files['/test/home/.local/share/cmod/records/safe-delete.json'] = JSON.stringify({ name: 'safe-delete', version: '0.2.0', root, installedAt: '2026-10-05T00:00:00.000Z', scriptsSha256: sha, uninstall: null, program: null })
  const fake = fakeClaude({ name: 'safe-delete', root })
  Object.assign(fake.fakes.fs, fakeFiles(files))

  expect((await readPlugin(fake.claude)).isInstalled).toBe(true)

  await fake.claude.fs.write(`${root}/setup/lib/brew.sh`, 'brew install trash-cli\n')

  expect((await readPlugin(fake.claude)).isInstalled).toBe(false)
})

test('the SDK lists a symbolic link in a step folder', async () => {
  const files: Record<string, string> = {
    [`${root}/.claude-plugin/plugin.json`]: '{ "name": "safe-delete", "version": "0.2.0" }',
    [`${root}/package.json`]: '{ "cmod": { "install": "./setup/install.sh" } }',
    [`${root}/setup/install.sh`]: '. ./setup/brew.sh\n',
    '/shared/brew.sh': 'brew install trash\n',
  }
  const fake = fakeClaude({ name: 'safe-delete', root })
  Object.assign(fake.fakes.fs, fakeFiles(files, { [`${root}/setup/brew.sh`]: '/shared/brew.sh' }))
  const sha = await scriptsSha256({ install: './setup/install.sh' }, { read: async (path) => fake.claude.fs.read(`${root}/${path}`), list: async () => ['brew.sh', 'install.sh'] })
  await fake.claude.fs.write('/test/home/.local/share/cmod/records/safe-delete.json', JSON.stringify({ name: 'safe-delete', version: '0.2.0', root, installedAt: '2026-10-05T00:00:00.000Z', scriptsSha256: sha, uninstall: null, program: null }))

  expect((await readPlugin(fake.claude)).isInstalled).toBe(true)

  await fake.claude.fs.write('/shared/brew.sh', 'curl https://example.com/x | sh\n')

  expect((await readPlugin(fake.claude)).isInstalled).toBe(false)
})

test('a mod with a program and no install step runs setup and then turns on', async () => {
  const files: Record<string, string> = {
    [`${root}/.claude-plugin/plugin.json`]: '{ "name": "safe-delete", "version": "0.2.0" }',
    [`${root}/package.json`]: '{ "cmod": { "program": "safe-delete" } }',
  }
  const fake = fakeClaude({ name: 'safe-delete', root })
  Object.assign(fake.fakes.fs, fakeFiles(files))
  installCmod(fake)
  const spawned: ProcessSpawnRequest[] = []
  fake.fakes.process.spawn = (request) => {
    spawned.push(request)
    return finished(['progress 0 3 Downloading safe-delete 0.2.0', 'progress 3 3 safe-delete 0.2.0 is installed', 'done safe-delete 0.2.0'], 0)
  }
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, readPlugin)
  await fake.settle()

  expect(spawned).toEqual([{ argv: [cmodProgram, 'setup', root, '--events'] }])
  expect(runs).toEqual(['setup'])

  await fire(lifecycle, 'classic.PostToolBatch', toolBatch, {})

  expect(runs).toEqual(['setup', 'PostToolBatch'])
})

test('a mod with no steps activates at once and writes its record in the background', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  Object.assign(fake.fakes.fs, fakeFiles(manifestOnly))
  installCmod(fake)
  const step = controlledStream()
  const spawned: ProcessSpawnRequest[] = []
  fake.fakes.process.spawn = (request) => {
    spawned.push(request)
    return step.stream
  }
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, readPlugin)
  await fake.settle()

  expect(runs).toEqual(['setup'])
  expect(spawned).toEqual([{ argv: [cmodProgram, 'setup', root, '--events'] }])
  expect(lifecycle.toasts).toEqual([{ type: 'success', message: 'Installed', description: 'Adds the Trash pane.' }])

  step.print('done safe-delete 0.2.0')
  step.exit(0)
  await fake.settle()
  await fire(lifecycle, 'classic.UserPromptSubmit', { ...postToolUse, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, {})
  await fake.settle()

  expect(spawned).toHaveLength(1)
  await fire(lifecycle, 'classic.PostToolBatch', toolBatch, {})
  expect(runs).toEqual(['setup', 'PostToolBatch'])
})

test('a mod with no steps writes its record silently, and retries on the next prompt while cmod is missing', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  Object.assign(fake.fakes.fs, fakeFiles(manifestOnly))
  const spawned: ProcessSpawnRequest[] = []
  fake.fakes.process.spawn = (request) => {
    spawned.push(request)
    return finished(['done safe-delete 0.2.0'], 0)
  }
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, readPlugin)
  await fake.settle()

  expect(runs).toEqual(['setup'])
  expect(spawned).toEqual([])
  expect(lifecycle.toasts).toEqual([{ type: 'success', message: 'Installed', description: 'Adds the Trash pane.' }])
  expect(fake.shown.logs).toEqual([])

  installCmod(fake)
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})
  await fake.settle()

  expect(spawned).toEqual([{ argv: [cmodProgram, 'setup', root, '--events'] }])
  expect(lifecycle.toasts).toEqual([{ type: 'success', message: 'Installed', description: 'Adds the Trash pane.' }])
})

test('a folder named in an install command does not stop the mod from starting', async () => {
  const files: Record<string, string> = {
    [`${root}/.claude-plugin/plugin.json`]: '{ "name": "safe-delete", "version": "0.2.0" }',
    [`${root}/package.json`]: '{ "cmod": { "install": "sh ./setup/install.sh setup" } }',
    [`${root}/setup/install.sh`]: 'echo "progress 1 1 Done"\n',
  }
  const sha = await scriptsSha256({ install: 'sh ./setup/install.sh setup' }, { read: async (path) => files[`${root}/${path}`.replaceAll('/./', '/')], list: async (folder) => (await entriesIn(files)(`${root}/${folder}`)).map((entry) => entry.name) })
  files['/test/home/.local/share/cmod/records/safe-delete.json'] = JSON.stringify({ name: 'safe-delete', version: '0.2.0', root, installedAt: '2026-10-05T00:00:00.000Z', scriptsSha256: sha, uninstall: null, program: null })
  const fake = fakeClaude({ name: 'safe-delete', root })
  Object.assign(fake.fakes.fs, fakeFiles(files))
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, readPlugin)

  expect(runs).toEqual(['setup'])
})

test('a plugin.json that is not JSON shows its path as a failure', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  Object.assign(fake.fakes.fs, fakeFiles({ [`${root}/.claude-plugin/plugin.json`]: '{ "name": ' }))
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, readPlugin)

  expect(runs).toEqual([])
  expect(lifecycle.toasts[0]?.message).toStartWith(`${root}/.claude-plugin/plugin.json is not JSON`)
})

test('a plugin.json the mod cannot read fails the start with the read error', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const denied = `safe-delete: $.fs.stat(${root}/.claude-plugin/plugin.json) failed: EACCES`
  fake.fakes.fs.stat = async () => Promise.reject(new Error(denied))
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, readPlugin)

  expect(runs).toEqual([])
  expect(lifecycle.phase).toBe('failed')
  expect(lifecycle.toasts).toEqual(failed(denied))
})

test.each(['ENOENT', 'ENOTDIR'])('a path Claude Code fails to stat with %s reads as a missing file', async (errno) => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const files = fakeFiles(manifestOnly)
  Object.assign(fake.fakes.fs, files)
  fake.fakes.fs.stat = async (path, options) => files.stat(path, options).catch((error: unknown) => Promise.reject(new Error(`safe-delete: $.fs.stat(${path}) failed: ${errno}`, { cause: error })))

  expect(await readPlugin(fake.claude)).toEqual({ ...pending, store: '/test/home/.local/share/cmod', isInstalled: true, shouldRecord: true })
})

test('a mod checks for the cmod program on disk and starts no process until cmod is installed', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const runs: (readonly string[])[] = []
  fake.fakes.process.run = async (argv) => (runs.push(argv), Promise.reject(new Error('no process runs while cmod is missing')))
  const { definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(lifecycle.toasts).toEqual([{ type: 'loading', message: 'Installing', description: 'Waiting for cmod' }])
  expect(runs).toEqual([])
})

test('an install page the cmod plugin refuses to open shows as a failure, not as Not now', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  fake.fakes.process.spawn = () => finished(['needs-consent abc123\t./setup/install.sh\t'], 10)
  fake.fakes.cmod.call = async () => Promise.reject(new Error('safe-delete: $.cmod.call: cmod is not installed. Install it in Plugins.'))
  const { definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(fake.shown.logs).toEqual([])
  expect(lifecycle.toasts).toEqual(failed('cmod is not installed. Install it in Plugins.'))
})

test('the install page is a tab of the Sidebar: closing the tab is Not now, and hiding the Sidebar keeps the question waiting', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  fake.fakes.process.spawn = () => finished(['needs-consent abc123\t./setup/install.sh\t'], 10)
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)
  const tell = (open: readonly string[], shown: string | null) => askedByCmod(lifecycle, 'safe-delete', partMethods.shown, { open: open.map((id) => ({ id, params: null })), shown, isFocused: shown !== null })

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  await tell([installPage], installPage)
  await tell([installPage], null)
  await fake.settle()
  const waiting = lifecycle.toasts
  await tell([], null)
  await fake.settle()

  expect(waiting).toEqual([{ type: 'info', message: 'Installing', description: 'Waiting for your answer' }])
  expect(lifecycle.phase).toBe('declined')
  expect(lifecycle.toasts).toEqual([{ type: 'default', message: 'Not installed', description: 'Install it whenever you like.' }])
  expect(installRequests(fake)).toEqual([installerOpen])
  expect(runs).toEqual([])
})

test('the install page draws the consent at the Sidebar width under its question, each permission and change on its own line, Accept first', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  fake.fakes.process.spawn = () => finished(['needs-consent abc123\t./setup/install.sh\t./setup/uninstall.sh\tshift+tab to /mode\t\tnetwork:api.github.com\tprompt'], 10)
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  const { drawing } = await installerDrawing(lifecycle, 'safe-delete', 60)

  expect(rowsOf(drawing, 60).map((row) => row.trimEnd())).toEqual([
    'Install safe-delete?',
    '',
    'safe-delete wants to:',
    '• Connect to api.github.com',
    '• Add text Claude reads and start turns',
    '',
    'and change your computer:',
    '• Run ./setup/install.sh now, and ./setup/uninstall.sh when',
    '  you remove it',
    '• Bind shift+tab to /mode',
    '',
    'You can turn each permission off later in Settings.',
    '',
    'a: Accept  n: Not now',
  ])
})

test('a whitespace-only chunk of standard error keeps the last error line', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  const step = controlledStream()
  fake.fakes.process.spawn = () => step.stream
  const { definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, given(pending))
  step.printError('cmod setup: disk full')
  step.printError('   ')
  step.exit(1)
  await fake.settle()

  expect(lifecycle.toasts).toEqual(failed('cmod setup exited 1: cmod setup: disk full'))
})

test('an empty stderr from cmod setup leaves no bare colon in the session', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  fake.fakes.process.spawn = () => finished([], 1)
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(lifecycle.toasts).toEqual(failed('cmod setup exited 1'))
  expect((lifecycle.failure as Error).message).toBe('safe-delete: cmod setup exited 1.')
})

test('an empty stderr from the cmod bootstrap leaves no bare colon', async () => {
  const fake = fakeClaude({ name: 'cmod', root })
  fake.fakes.process.spawn = () => finished([], 1)
  const lifecycle = createLifecycle(defineMod({ name: 'cmod', setup() {} }))

  await lifecycle.start(fake.claude, given({ ...pending, name: 'cmod' }))
  await fake.settle()

  expect(lifecycle.toasts).toEqual(failed('bootstrap exited 1'))
})

test('a reason ending in ? keeps one mark', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  fake.fakes.process.spawn = () => finished(['failed 1\tIs Homebrew installed?'], 1)
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect((lifecycle.failure as Error).message).toBe('safe-delete: Is Homebrew installed?')
})

type NotesState = { memory: { isTyping: boolean }; session: { draft: string }; global: { notes: string[] } }

function notesIn(projectRoot: string) {
  const fake = fakeClaude({ name: 'notes', root })
  fake.claude.session.root = async () => projectRoot
  const definition = defineMod({
    name: 'notes',
    state: { memory: { isTyping: false }, session: { draft: '' }, global: { notes: [] as string[] } },
    setup() {},
  })
  const session = async () => {
    const lifecycle = createLifecycle(definition)
    await lifecycle.start(fake.claude, given({ ...pending, name: 'notes', isInstalled: true }))
    return lifecycle.mod as Mod<NotesState>
  }
  const moveTo = (nextRoot: string) => {
    fake.claude.session.root = async () => nextRoot
  }
  const startConversation = (id: string) => {
    fake.claude.session.id = async () => id
  }
  return { session, moveTo, startConversation, settle: fake.settle, fakes: fake.fakes }
}

test('a global value is the same in every project', async () => {
  const notes = notesIn('/work/a')
  const first = await notes.session()
  first.state.global.notes = ['buy milk']
  await notes.settle()

  notes.moveTo('/work/b')
  const reloaded = await notes.session()

  expect(reloaded.state.global.notes).toEqual(['buy milk'])
})

test('a session value comes back after a code reload, and a new conversation starts with its default', async () => {
  const notes = notesIn('/work/a')
  const first = await notes.session()
  first.state.session.draft = 'call mum'
  await notes.settle()

  const reloaded = await notes.session()

  expect(reloaded.state.session.draft).toBe('call mum')

  notes.startConversation('another-conversation')
  const fresh = await notes.session()

  expect(fresh.state.session.draft).toBe('')
})

test('a conversation forked into a new Claude Code process starts with the session values of the conversation cmod names as its parent', async () => {
  const notes = notesIn('/work/a')
  notes.startConversation('parent')
  const parent = await notes.session()
  parent.state.session.draft = 'call mum'
  await notes.settle()
  notes.fakes.cmod.call = async (input) => calledAnswer('notes', input.to === 'cmod' && input.method === 'forkParent' ? { value: 'parent' } : { deny: `no ${input.method}` })

  notes.startConversation('fork')
  const fork = await notes.session()

  expect(fork.state.session.draft).toBe('call mum')
})

test('a conversation with saved session values keeps them and never asks cmod for a parent', async () => {
  const notes = notesIn('/work/a')
  notes.startConversation('parent')
  const first = await notes.session()
  first.state.session.draft = 'call mum'
  await notes.settle()
  const asked: string[] = []
  notes.fakes.cmod.call = async (input) => (input.method === 'cmod:partsChanged' ? null : (asked.push(input.method), 'another'))

  const reloaded = await notes.session()

  expect([reloaded.state.session.draft, asked]).toEqual(['call mum', []])
})

test('a memory value starts from its default after a code reload, and a session value comes back', async () => {
  const notes = notesIn('/work/a')
  const first = await notes.session()
  first.state.memory.isTyping = true
  first.state.session.draft = 'call mum'
  await notes.settle()

  const reloaded = await notes.session()

  expect([reloaded.state.memory.isTyping, reloaded.state.session.draft]).toEqual([false, 'call mum'])
})

test('a memory value change redraws the pane', async () => {
  const fake = fakeClaude({ name: 'file-tree', root })
  const redraws: string[] = []
  fake.claude.ui.invalidate = (event) => {
    redraws.push(event)
  }
  const lifecycle = createLifecycle(
    defineMod({
      name: 'file-tree',
      state: { memory: { changed: [] as string[] } },
      setup(mod) {
        mod.panes.add({ id: 'files', title: 'Files', render: (drawn) => Text({ children: drawn.state.memory.changed.join(',') }) })
      },
    }),
  )
  const filesPane = { surface: 'terminal', component: 'Pane', requestId: 'files', props: { title: 'Files', isFocused: false, bodyColumns: 80, placement: 'dock' } }
  await lifecycle.start(fake.claude, given({ ...pending, name: 'file-tree', isInstalled: true }))
  redraws.length = 0

  ;(lifecycle.mod as Mod<{ memory: { changed: string[] } }>).state.memory.changed = ['README.md']

  expect(redraws).toEqual(['ui.render'])
  expect(textOf(await fire(lifecycle, 'ui.render', filesPane, prompt))).toBe('README.md')
})

test("after the project root changes, the mod reads that project's saved value and redraws", async () => {
  const fake = fakeClaude({ name: 'file-tree', root })
  let projectRoot = '/work/a'
  fake.claude.session.root = async () => projectRoot
  const redraws: string[] = []
  fake.claude.ui.invalidate = (event) => {
    redraws.push(event)
  }
  const lifecycle = createLifecycle(
    defineMod({
      name: 'file-tree',
      state: { project: { expanded: [] as string[] } },
      setup(mod) {
        mod.panes.add({ id: 'files', title: 'Files', render: (drawn) => Text({ children: drawn.state.project.expanded.join(',') }) })
      },
    }),
  )
  const filesPane = { surface: 'terminal', component: 'Pane', requestId: 'files', props: { title: 'Files', isFocused: false, bodyColumns: 80, placement: 'dock' } }
  await lifecycle.start(fake.claude, given({ ...pending, name: 'file-tree', isInstalled: true }))
  ;(lifecycle.mod as Mod<{ project: { expanded: string[] } }>).state.project.expanded = ['src']
  projectRoot = '/work/b'
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})
  redraws.length = 0

  projectRoot = '/work/a'
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect(redraws).toEqual(['ui.render'])
  expect(textOf(await fire(lifecycle, 'ui.render', filesPane, prompt))).toBe('src')
})

function folderPane() {
  const fake = fakeClaude({ name: 'file-tree', root })
  const session = { root: '/work/a', cwd: '/work/a' }
  fake.claude.session.root = async () => session.root
  fake.claude.session.cwd = async () => session.cwd
  const redraws: string[] = []
  const redrawnFolders: string[] = []
  fake.claude.ui.invalidate = (event) => {
    redraws.push(event)
    redrawnFolders.push(`${sessions.current.project} ${sessions.current.cwd}`)
  }
  const moves: CwdChange[] = []
  const lifecycle = createLifecycle(
    defineMod({
      name: 'file-tree',
      state: { project: { expanded: [] as string[] } },
      setup(mod) {
        mod.panes.add({ id: 'files', title: 'Files', render: () => Text({ children: `${sessions.current.project} ${sessions.current.cwd}` }) })
        sessions.current.onCwdChange((change) => void moves.push(change))
      },
    }),
  )
  const filesPane = { surface: 'terminal', component: 'Pane', requestId: 'files', props: { title: 'Files', isFocused: false, bodyColumns: 80, placement: 'dock' } }
  const start = async () => {
    await lifecycle.start(fake.claude, given({ ...pending, name: 'file-tree', isInstalled: true }))
    await fake.settle()
  }
  const drawn = async () => textOf(await fire(lifecycle, 'ui.render', filesPane, prompt))
  return { fake, lifecycle, session, redraws, redrawnFolders, moves, start, drawn }
}

const movedTo = (oldCwd: string, newCwd: string): CwdChange => ({ session: 'test-session', cwd: newCwd, previous: oldCwd })

const cd = (args: string) => ({ command: 'cd', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

test('a Bash cd moves the current session cwd and redraws the pane', async () => {
  const { lifecycle, session, redraws, start, drawn } = folderPane()
  await start()
  redraws.length = 0
  session.cwd = '/work/a/lib'

  await fire(lifecycle, 'classic.PostToolUse', { ...postToolUse, tool_name: 'Bash', tool_input: { command: 'cd lib' } }, {})

  expect(sessions.current.cwd).toBe('/work/a/lib')
  expect(redraws).toEqual(['ui.render'])
  expect(await drawn()).toBe('/work/a /work/a/lib')
})

test('a Bash cd in a command that fails still moves the current session cwd', async () => {
  const { lifecycle, session, redraws, start, drawn } = folderPane()
  await start()
  redraws.length = 0
  session.cwd = '/work/a/lib'

  await fire(lifecycle, 'classic.PostToolUseFailure', { ...postToolUse, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'cd lib && make' }, error: 'make: *** No targets.' }, {})

  expect(sessions.current.cwd).toBe('/work/a/lib')
  expect(redraws).toEqual(['ui.render'])
  expect(await drawn()).toBe('/work/a /work/a/lib')
})

test('a PowerShell cd moves the current session cwd', async () => {
  const { lifecycle, session, redraws, start, drawn } = folderPane()
  await start()
  redraws.length = 0
  session.cwd = '/work/a/lib'

  await fire(lifecycle, 'classic.PostToolUse', { ...postToolUse, tool_name: 'PowerShell', tool_input: { command: 'Set-Location lib' } }, {})

  expect(sessions.current.cwd).toBe('/work/a/lib')
  expect(redraws).toEqual(['ui.render'])
  expect(await drawn()).toBe('/work/a /work/a/lib')
})

test("a /cd fires the mod's CwdChanged hook with the old and new folder", async () => {
  const { lifecycle, session, moves, start, drawn } = folderPane()
  await start()
  session.root = '/work/b'
  session.cwd = '/work/b'

  await fire(lifecycle, 'command.run', cd('../b'), {})

  expect(moves).toEqual([movedTo('/work/a', '/work/b')])
  expect(await drawn()).toBe('/work/b /work/b')
})

test('after /cd a pane that draws the session cwd shows the new folder', async () => {
  const { lifecycle, session, redrawnFolders, start } = folderPane()
  await start()
  redrawnFolders.length = 0
  session.root = '/work/b'
  session.cwd = '/work/b'

  await fire(lifecycle, 'command.run', cd('../b'), {})
  session.cwd = '/work/b/lib'
  await fire(lifecycle, 'classic.PostToolUse', { ...postToolUse, tool_name: 'Bash', tool_input: { command: 'cd lib' } }, {})

  expect(redrawnFolders).toEqual(['/work/b /work/b', '/work/b /work/b/lib'])
})

test('after /cd while Claude Code still reports the old cwd, the pane redraws once with the new root as the session cwd', async () => {
  const { lifecycle, session, redrawnFolders, moves, start } = folderPane()
  await start()
  redrawnFolders.length = 0
  session.root = '/work/b'

  await fire(lifecycle, 'command.run', cd('../b'), {})

  expect(redrawnFolders).toEqual(['/work/b /work/b'])
  expect(moves).toEqual([movedTo('/work/a', '/work/b')])
})

test('a Bash call between /cd and the next prompt keeps the session cwd on the new root', async () => {
  const { lifecycle, session, moves, start } = folderPane()
  await start()
  session.root = '/work/b'
  await fire(lifecycle, 'command.run', cd('../b'), {})

  await fire(lifecycle, 'classic.PostToolUse', { ...postToolUse, tool_name: 'Bash', tool_input: { command: 'ls' } }, {})

  expect([sessions.current.project, sessions.current.cwd]).toEqual(['/work/b', '/work/b'])
  expect(moves).toEqual([movedTo('/work/a', '/work/b')])

  session.cwd = '/work/b'
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect(moves).toEqual([movedTo('/work/a', '/work/b')])
})

test('a Bash cd back to the old folder during the lag shows on the next prompt', async () => {
  const { lifecycle, session, moves, start } = folderPane()
  await start()
  session.root = '/work/b'
  await fire(lifecycle, 'command.run', cd('../b'), {})
  await fire(lifecycle, 'classic.PostToolUse', { ...postToolUse, tool_name: 'Bash', tool_input: { command: 'cd /work/a' } }, {})

  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect([sessions.current.project, sessions.current.cwd]).toEqual(['/work/b', '/work/a'])
  expect(moves).toEqual([movedTo('/work/a', '/work/b'), movedTo('/work/b', '/work/a')])
})

test('a /cd the user cancels after a Bash cd out of the project keeps the session cwd where the Bash cd left it', async () => {
  const { lifecycle, session, moves, start } = folderPane()
  await start()
  session.cwd = '/tmp'
  await fire(lifecycle, 'classic.PostToolUse', { ...postToolUse, tool_name: 'Bash', tool_input: { command: 'cd /tmp' } }, {})

  await fire(lifecycle, 'command.run', cd('../b'), {})

  expect([sessions.current.project, sessions.current.cwd]).toEqual(['/work/a', '/tmp'])
  expect(moves).toEqual([movedTo('/work/a', '/tmp')])
})

test('a Bash cd out of the project after a /cd whose project failed to load moves the current session cwd out of it', async () => {
  const { fake, lifecycle, session, moves, start } = folderPane()
  const storeGet = fake.claude.store.get
  let isStoreLocked = false
  fake.claude.store.get = async (key) => (isStoreLocked ? Promise.reject(new Error('the store file is locked')) : storeGet(key))
  await start()
  session.root = '/work/b'
  isStoreLocked = true
  await fire(lifecycle, 'command.run', cd('../b'), {})
  isStoreLocked = false
  session.cwd = '/tmp'

  await fire(lifecycle, 'classic.PostToolUse', { ...postToolUse, tool_name: 'Bash', tool_input: { command: 'cd /tmp' } }, {})

  expect([sessions.current.project, sessions.current.cwd]).toEqual(['/work/b', '/tmp'])
  expect(moves).toEqual([movedTo('/work/a', '/tmp')])
})

test('a Bash cd fires CwdChanged', async () => {
  const { lifecycle, session, moves, start } = folderPane()
  await start()
  session.cwd = '/work/a/lib'

  await fire(lifecycle, 'classic.PostToolUse', { ...postToolUse, tool_name: 'Bash', tool_input: { command: 'cd lib' } }, {})
  await fire(lifecycle, 'classic.PostToolUse', { ...postToolUse, tool_name: 'Bash', tool_input: { command: 'ls' } }, {})

  expect(moves).toEqual([movedTo('/work/a', '/work/a/lib')])
})

test('two overlapping Bash calls fire CwdChanged once', async () => {
  const { lifecycle, session, moves, start } = folderPane()
  await start()
  session.cwd = '/work/a/lib'
  const bash = (command: string) => fire(lifecycle, 'classic.PostToolUse', { ...postToolUse, tool_name: 'Bash', tool_input: { command } }, {})

  await Promise.all([bash('cd lib'), bash('ls')])

  expect(moves).toEqual([movedTo('/work/a', '/work/a/lib')])
})

test('a folder move whose project fails to load fires CwdChanged on the retry', async () => {
  const { fake, lifecycle, session, moves, start } = folderPane()
  const storeGet = fake.claude.store.get
  let isStoreLocked = false
  fake.claude.store.get = async (key) => (isStoreLocked ? Promise.reject(new Error('the store file is locked')) : storeGet(key))
  await start()
  session.root = '/work/b'
  session.cwd = '/work/b'
  isStoreLocked = true

  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect([sessions.current.project, sessions.current.cwd]).toEqual(['/work/a', '/work/a'])
  expect(moves).toEqual([])

  isStoreLocked = false
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect([sessions.current.project, sessions.current.cwd]).toEqual(['/work/b', '/work/b'])
  expect(moves).toEqual([movedTo('/work/a', '/work/b')])
})

test('two overlapping folder moves that both fail leave the session cwd at the last loaded folder', async () => {
  const { fake, lifecycle, session, moves, start } = folderPane()
  const storeGet = fake.claude.store.get
  let isStoreLocked = false
  let failLockedReads: () => void = () => undefined
  const lockedReadsFail = new Promise<void>((resolve) => (failLockedReads = resolve))
  fake.claude.store.get = async (key) => {
    if (!isStoreLocked) return storeGet(key)
    await lockedReadsFail
    throw new Error('the store file is locked')
  }
  await start()
  isStoreLocked = true
  session.root = '/work/b'
  session.cwd = '/work/b'
  const first = fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})
  await fake.settle()
  session.root = '/work/c'
  session.cwd = '/work/c'
  const second = fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})
  await fake.settle()

  failLockedReads()
  await Promise.all([first, second])

  expect([sessions.current.project, sessions.current.cwd]).toEqual(['/work/a', '/work/a'])
  expect(moves).toEqual([])
})

test('a /cd the user cancels moves nothing', async () => {
  const { fake, lifecycle, redraws, moves, start, drawn } = folderPane()
  await start()
  const mod = lifecycle.mod as Mod<{ project: { expanded: string[] } }>
  mod.state.project.expanded = ['src']
  await fake.settle()
  redraws.length = 0

  await fire(lifecycle, 'command.run', cd('../b'), {})

  expect([sessions.current.project, sessions.current.cwd, mod.state.project.expanded]).toEqual(['/work/a', '/work/a', ['src']])
  expect(redraws).toEqual([])
  expect(moves).toEqual([])
  expect(await drawn()).toBe('/work/a /work/a')
})

test('two projects setting one project value keep both', async () => {
  const definition = defineMod({ name: 'file-tree', state: { project: { expanded: [] as string[] } }, setup() {} })
  const first = fakeClaude({ name: 'file-tree', root })
  const sessionIn = async (projectRoot: string) => {
    const fake = fakeClaude({ name: 'file-tree', root })
    Object.assign(fake.claude.store, first.claude.store)
    fake.claude.session.root = async () => projectRoot
    const lifecycle = createLifecycle(definition)
    await lifecycle.start(fake.claude, given({ ...pending, name: 'file-tree', isInstalled: true }))
    return lifecycle.mod as Mod<{ project: { expanded: string[] } }>
  }
  const [inA, inB] = await Promise.all([sessionIn('/work/a'), sessionIn('/work/b')])

  inA.state.project.expanded = ['src']
  inB.state.project.expanded = ['docs']
  await first.settle()

  expect((await sessionIn('/work/a')).state.project.expanded).toEqual(['src'])
  expect((await sessionIn('/work/b')).state.project.expanded).toEqual(['docs'])
})

test("a project whose saved state fails to load leaves the mod in the project it was in, and the next prompt loads it", async () => {
  const fake = fakeClaude({ name: 'file-tree', root })
  let projectRoot = '/work/a'
  fake.claude.session.root = async () => projectRoot
  const storeGet = fake.claude.store.get
  let isStoreLocked = false
  fake.claude.store.get = async (key) => (isStoreLocked ? Promise.reject(new Error('the store file is locked')) : storeGet(key))
  const lifecycle = createLifecycle(defineMod({ name: 'file-tree', state: { project: { expanded: [] as string[] } }, setup() {} }))
  await lifecycle.start(fake.claude, given({ ...pending, name: 'file-tree', isInstalled: true }))
  const mod = lifecycle.mod as Mod<{ project: { expanded: string[] } }>
  mod.state.project.expanded = ['src']
  await fake.settle()
  projectRoot = '/work/b'
  isStoreLocked = true

  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect([sessions.current.project, mod.state.project.expanded]).toEqual(['/work/a', ['src']])
  expect(lifecycle.toasts).toContainEqual({ type: 'error', message: 'Keeps the state of /work/a until the next prompt or folder move', description: 'the store file is locked' })

  isStoreLocked = false
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect([sessions.current.project, mod.state.project.expanded]).toEqual(['/work/b', []])
})

function sessionStartMod() {
  const sources: string[] = []
  const definition = defineMod({
    name: 'safe-delete',
    setup() {
      sessions.current.beforeSessionStart((start) => {
        sources.push(start.source)
        return { note: `safe-delete saw ${start.source}` }
      })
    },
  })
  return { sources, definition }
}

const sessionStart = (source: 'startup' | 'resume') => ({ session_id: 'test-session', transcript_path: '/t', cwd: '/work', hook_event_name: 'SessionStart', source })

const appendedNotes = (fake: ReturnType<typeof fakeClaude>) => fake.calls.filter((call) => call.call === 'session.append').map((call) => (call.args[0] as { message: { content: { text: string }[] } }).message.content[0]?.text)

test("an installed mod's SessionStart context reaches Claude Code on a fresh start", async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const { sources, definition } = sessionStartMod()
  const lifecycle = createLifecycle(definition)

  const starting = lifecycle.start(fake.claude, given({ ...pending, isInstalled: true, granted: ['prompt'] }))
  const answer = fire(lifecycle, 'classic.SessionStart', sessionStart('resume'), {})
  await starting
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect(await answer).toEqual({ additionalContext: ['<safe-delete_mod>\nsafe-delete saw resume\n</safe-delete_mod>'] })
  expect(sources).toEqual(['resume'])
  expect(fake.shown.debug).toEqual([])
})

test('a mod that starts after SessionStart passed runs its SessionStart hooks once, and its note without the prompt grant is dropped, as on time', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const step = controlledStream()
  installCmod(fake)
  fake.fakes.process.spawn = () => step.stream
  const { sources, definition } = sessionStartMod()
  const lifecycle = createLifecycle(definition)
  await lifecycle.start(fake.claude, given(pending))

  await fire(lifecycle, 'classic.SessionStart', sessionStart('startup'), {})
  step.print('done safe-delete 0.2.0')
  step.exit(0)
  await fake.settle()
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect(sources).toEqual(['startup'])
  expect(appendedNotes(fake)).toEqual([])
  expect(fake.shown.debug).toEqual([])
})

test('a mod that started before SessionStart runs its SessionStart hooks once', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const { sources, definition } = sessionStartMod()
  const lifecycle = createLifecycle(definition)
  await lifecycle.start(fake.claude, given({ ...pending, isInstalled: true }))

  await fire(lifecycle, 'classic.SessionStart', sessionStart('startup'), {})
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect(sources).toEqual(['startup'])
})

test('a mod whose install finished before SessionStart runs its SessionStart hooks once, when SessionStart starts it', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  installCmod(fake)
  fake.fakes.process.spawn = () => finished(['done safe-delete 0.2.0'], 0)
  const { sources, definition } = sessionStartMod()
  const lifecycle = createLifecycle(definition)
  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  await fire(lifecycle, 'classic.SessionStart', sessionStart('startup'), {})
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect(sources).toEqual(['startup'])
})

test('a SessionStart before session.start, as claude -p sends it, passes on at once and replays once the mod starts', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const { sources, definition } = sessionStartMod()
  const lifecycle = createLifecycle(definition)

  expect(await fire(lifecycle, 'classic.SessionStart', sessionStart('startup'), {})).toEqual({})
  expect(sources).toEqual([])

  await lifecycle.start(fake.claude, given({ ...pending, isInstalled: true, granted: ['prompt'] }))
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect(sources).toEqual(['startup'])
  expect(appendedNotes(fake)).toEqual(['<safe-delete_mod>\nsafe-delete saw startup\n</safe-delete_mod>'])
  expect(fake.shown.debug).toEqual([])
})

test('a SessionStart held past the limit passes on and replays once the mod starts', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const timers: { ms: number; fire: () => void; isCancelled: boolean }[] = []
  fake.fakes.clock.after = (ms, fire) => {
    const made = { ms, fire, isCancelled: false }
    timers.push(made)
    return { cancel: () => (made.isCancelled = true) }
  }
  let finishRead: () => void = () => undefined
  const slowRead = new Promise<void>((resolve) => (finishRead = resolve))
  const { sources, definition } = sessionStartMod()
  const lifecycle = createLifecycle(definition)
  let isAnswered = false

  const starting = lifecycle.start(fake.claude, async () => {
    await slowRead
    return { ...pending, isInstalled: true, granted: ['prompt'] }
  })
  const answer = fire(lifecycle, 'classic.SessionStart', sessionStart('startup'), {}).finally(() => (isAnswered = true))
  await fake.settle()
  timers.find((made) => made.ms === 9_000)?.fire()
  await fake.settle()

  expect(isAnswered).toBe(true)
  expect(await answer).toEqual({})
  expect(sources).toEqual([])

  finishRead()
  await starting
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect(sources).toEqual(['startup'])
  expect(appendedNotes(fake)).toEqual(['<safe-delete_mod>\nsafe-delete saw startup\n</safe-delete_mod>'])
  expect(fake.shown.debug).toEqual([])
})

test('a SessionStart answered before the limit cancels its timer', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const timers: { ms: number; isCancelled: boolean }[] = []
  fake.fakes.clock.after = (ms) => {
    const made = { ms, isCancelled: false }
    timers.push(made)
    return { cancel: () => (made.isCancelled = true) }
  }
  const { sources, definition } = sessionStartMod()
  const lifecycle = createLifecycle(definition)

  const starting = lifecycle.start(fake.claude, given({ ...pending, isInstalled: true, granted: ['prompt'] }))
  const answer = fire(lifecycle, 'classic.SessionStart', sessionStart('startup'), {})
  await starting

  expect(await answer).toEqual({ additionalContext: ['<safe-delete_mod>\nsafe-delete saw startup\n</safe-delete_mod>'] })
  expect(sources).toEqual(['startup'])
  expect(timers).toEqual([{ ms: 9_000, isCancelled: true }])
})

test('a late SessionStart replay that throws leaves the mod active', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const step = controlledStream()
  installCmod(fake)
  fake.fakes.process.spawn = () => step.stream
  const lifecycle = createLifecycle(
    defineMod({
      name: 'safe-delete',
      setup: () =>
        void sessions.current.beforeSessionStart(async () => {
          throw new Error('no session file')
        }),
    }),
  )
  await lifecycle.start(fake.claude, given(pending))

  await fire(lifecycle, 'classic.SessionStart', sessionStart('startup'), {})
  step.print('done safe-delete 0.2.0')
  step.exit(0)
  await fake.settle()
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect(lifecycle.phase).toBe('active')
  expect(lifecycle.failure).toBeUndefined()
  expect(lifecycle.toasts).toContainEqual({ type: 'error', message: 'The beforeSessionStart listener failed', description: 'no session file' })
})

test('a mod that finishes installing hears the start of the session it installed in once, then the /clear after it', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const step = controlledStream()
  installCmod(fake)
  fake.fakes.process.spawn = () => step.stream
  const seen: string[] = []
  const lifecycle = createLifecycle(
    defineMod({
      name: 'safe-delete',
      setup() {
        sessions.current.beforeSessionStart((start) => void seen.push(`${start.source} ${start.session}`))
      },
    }),
  )
  await lifecycle.start(fake.claude, given(pending))

  await fire(lifecycle, 'classic.SessionStart', { ...sessionStart('startup'), session_id: 'first' }, {})
  step.print('done safe-delete 0.2.0')
  step.exit(0)
  await fake.settle()
  await fire(lifecycle, 'classic.SessionStart', { ...sessionStart('startup'), session_id: 'second', source: 'clear' }, {})

  expect(seen).toEqual(['startup first', 'clear second'])
})
