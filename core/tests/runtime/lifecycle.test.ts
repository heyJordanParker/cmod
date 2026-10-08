import { expect, test } from 'bun:test'
import type { Args, ClassicHookInputs, EventResult, Frozen, FsEntry, HookStream, ProcessRunResult, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult, RenderElement } from 'claude-code'
import { defineStep } from '../../src/installer.js'
import { slashCommand } from '../../src/jobs/slash-command.js'
import { defineMod, type Mod } from '../../src/mod.js'
import { option } from '../../src/options.js'
import type { RoutedEvent } from '../../src/runtime/hooks.js'
import { createLifecycle, readPlugin, type Lifecycle, type Plugin } from '../../src/runtime/lifecycle.js'
import { scriptsSha256 } from '../../src/records.js'
import { fakeClaude } from '../../src/testing/fake-claude.js'
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

function fire<N extends RoutedEvent>(lifecycle: Pick<Lifecycle<object>, 'route'>, event: N, input: unknown, below: unknown) {
  return lifecycle.route(event, input as Frozen<Args<N>>, async () => below as EventResult<N>)
}

function trackedMod() {
  const runs: string[] = []
  const definition = defineMod({
    name: 'safe-delete',
    setup(mod) {
      runs.push('setup')
      mod.on('PostToolUse', () => {
        runs.push('PostToolUse')
        return { hookSpecificOutput: { additionalContext: 'safe-delete saw it' } }
      })
      void mod.ui.pane({ id: 'trash', title: 'Trash', render: () => Text({ children: 'empty' }) })
    },
  })
  return { runs, definition }
}

const abovePrompt = { surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: {}, viewport: { columns: 100, rows: 30 } }
const prompt = { type: 'Text', children: ['>'] } as unknown as RenderElement
const installerPane = { surface: 'terminal', component: 'Pane', requestId: 'cmod-installer', props: { title: 'Install', isFocused: true, bodyColumns: 80, placement: 'dock' } }

async function installerText(lifecycle: Pick<Lifecycle<object>, 'route'>): Promise<string> {
  return textOf((await fire(lifecycle, 'ui.render', installerPane, prompt)) as RenderElement)
}

async function pressInInstaller(lifecycle: Pick<Lifecycle<object>, 'route'>, key: string): Promise<void> {
  const button = findElement((await fire(lifecycle, 'ui.render', installerPane, prompt)) as RenderElement, 'Button', key)
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
  expect(await fire(lifecycle, 'classic.PostToolUse', postToolUse, {})).toEqual({})
  expect(runs).toEqual([])
  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe(`>\n⠋ Installing safe-delete  ${'█'.repeat(15)}${'░'.repeat(15)}  2/4  Installing trash`)

  step.print('progress 4 4 Adding the zsh alias')
  step.print('done safe-delete 0.2.0')
  step.exit(0)
  await fake.settle()

  expect(runs).toEqual([])

  const answer = await fire(lifecycle, 'classic.PostToolUse', postToolUse, {})

  expect(runs).toEqual(['setup', 'PostToolUse'])
  expect(answer).toEqual({ additionalContext: ['safe-delete saw it'] })
  expect(fake.shown.toasts).toEqual(['safe-delete is ready'])
  expect(fake.shown.logs).toEqual(['safe-delete added the Trash pane and a hook on PostToolUse.'])
  expect(await fire(lifecycle, 'ui.render', abovePrompt, prompt)).toBe(prompt)
})

test('a call to a mod still installing fails with when to retry', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodOnPath
  fake.fakes.process.spawn = () => controlledStream().stream
  const lifecycle = createLifecycle(trackedMod().definition)
  const below = { value: [{ name: 'parse', line: 1 }] }

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(await fire(lifecycle, 'cmod.call', { to: 'safe-delete', method: 'restore', input: { path: 'a.ts' } }, { deny: 'safe-delete is not installed. Run cmod install safe-delete.' })).toEqual({
    deny: "safe-delete is installing. Try again when it's ready.",
  })
  expect(await fire(lifecycle, 'cmod.call', { to: 'tracer', method: 'signatures', input: { path: 'a.ts' } }, below)).toBe(below)
})

test('a call to a mod whose install was declined fails with the install command', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodOnPath
  fake.fakes.process.spawn = () => finished(['needs-consent abc123\t./setup/install.sh\t'], 10)
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  await pressInInstaller(lifecycle, 'not-now')
  await fake.settle()

  expect(await fire(lifecycle, 'cmod.call', { to: 'safe-delete', method: 'restore', input: { path: 'a.ts' } }, { value: [] })).toEqual({
    deny: 'safe-delete is not installed. Run cmod install safe-delete.',
  })
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

  expect(fake.calls.find((call) => call.call === 'ui.open')?.args).toEqual([{ id: 'cmod-installer', title: 'Install safe-delete', focus: true, holdToasts: true, closeOnEscape: true }])
  expect(await installerText(lifecycle)).toContain('safe-delete wants to:')
  expect(await installerText(lifecycle)).toContain('Run ./setup/install.sh now, and ./setup/uninstall.sh when you remove it')
  expect(await installerText(lifecycle)).toContain('Bind shift+tab to /mode')
  await pressInInstaller(lifecycle, 'accept')
  await fake.settle()
  expect(spawned.map((request) => request.argv)).toEqual([
    ['cmod', 'setup', root, '--events'],
    ['cmod', 'setup', root, '--events', '--consent', 'abc123'],
  ])
  await fire(lifecycle, 'classic.PostToolUse', postToolUse, {})
  expect(runs).toEqual(['setup', 'PostToolUse'])
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

test('a key bound to a command that waits for the turn logs the fix, and an immediate command logs nothing', async () => {
  const fake = fakeClaude({ name: 'modes', root })
  const definition = defineMod({
    name: 'modes',
    setup(mod) {
      mod.use(slashCommand({ name: 'mode', description: 'Switch mode', reply: () => undefined }))
      mod.use(slashCommand({ name: 'review', description: 'Review mode', immediate: true, reply: () => undefined }))
    },
  })

  await createLifecycle(definition).start(fake.claude, given({ ...pending, isInstalled: true, steps: { keys: { 'shift+tab': 'mode', 'alt+r': 'review' } } }))
  await fake.settle()

  expect(fake.shown.commands).toEqual(['mode', 'review'])
  expect(fake.shown.logs.filter((line) => line.includes('immediate'))).toEqual([
    "modes: shift+tab runs /mode, which waits for Claude's turn to end and adds a row to the conversation. Give /mode immediate: true.",
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
  await fire(lifecycle, 'classic.PostToolUse', postToolUse, {})

  expect(fake.shown.logs).toEqual(['safe-delete is not installed. Run cmod install safe-delete to install it.'])
  expect(runs).toEqual([])
  expect(await fire(lifecycle, 'ui.render', abovePrompt, prompt)).toBe(prompt)
})

test('a failed install draws the sentence cmod setup wrote and its fix, and setup never runs', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodOnPath
  fake.fakes.process.spawn = () => finished(['progress 1 4 Checking Homebrew', 'failed 1\tThe install step of safe-delete exited 1: brew: command not found.'], 1)
  const { runs, definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()
  await fire(lifecycle, 'classic.PostToolUse', postToolUse, {})

  expect(runs).toEqual([])
  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe(
    '>\n✗ Installing safe-delete  The install step of safe-delete exited 1: brew: command not found.\n  Fix the cause, then run: cmod install safe-delete',
  )
})

test('an install error longer than the band shows its fix in full', async () => {
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
    '✗ Installing safe-delete  cmod',
    '  bootstrap: cmod is installed at',
    '  /home/me/.local/bin/cmod, but PATH',
    '  finds no cmod. Put /home/me/.local/bin',
    '  first on PATH, then restart Claude',
    '  Code.',
    '  Fix the cause, then run: cmod install',
    '  safe-delete',
  ])
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
  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe('>\n◌ Installing safe-delete  Waiting for cmod')

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
  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe(
    '>\n◌ Installing modes  PATH finds cmod 0.1.8, and modes needs cmod 0.1.12 or later. Run npm i -g @cmodjs/cli, or put ~/.local/bin ahead of the old cmod on PATH.',
  )

  fake.fakes.process.run = cmodAt('0.1.12')
  timers.find((made) => made.ms === 1000)?.fire()
  await fake.settle()

  expect(spawned).toEqual([{ argv: ['cmod', 'setup', root, '--events'] }])
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

  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe(">\n◌ Installing safe-delete  Still waiting for cmod to download cmod. See cmod's own line.")

  fake.fakes.process.run = cmodOnPath
  timers.find((made) => made.ms === 1000)?.fire()
  await fake.settle()
  await fire(lifecycle, 'classic.PostToolUse', postToolUse, {})

  expect(spawned).toEqual([{ argv: ['cmod', 'setup', root, '--events'] }])
  expect(timers.filter((made) => made.ms === 1000 || made.ms === 60_000).map((made) => made.isCancelled)).toEqual([true, true])
  expect(runs).toEqual(['setup', 'PostToolUse'])
})

test('a mod whose setup function throws says its setup function threw, and leaves no hook registered', async () => {
  const fake = fakeClaude({ name: 'broken', root })
  let hookRuns = 0
  const lifecycle = createLifecycle(
    defineMod({
      name: 'broken',
      setup(mod) {
        mod.on('PostToolUse', () => {
          hookRuns += 1
        })
        throw new Error('no config file')
      },
    }),
  )

  await lifecycle.start(fake.claude, given({ ...pending, name: 'broken', isInstalled: true }))
  await fire(lifecycle, 'classic.PostToolUse', postToolUse, {})

  expect(hookRuns).toBe(0)
  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe(
    '>\n✗ Installing broken  its setup function threw: no config file\n  Fix it, then run /reload-plugins.',
  )
})

test('a mod whose state fails to load says its state did not load', async () => {
  const fake = fakeClaude({ name: 'broken', root })
  fake.claude.store.get = async () => Promise.reject(new Error('the store file is locked'))
  const lifecycle = createLifecycle(defineMod({ name: 'broken', state: { project: { expanded: [] as string[] } }, setup() {} }))

  await lifecycle.start(fake.claude, given({ ...pending, name: 'broken', isInstalled: true }))

  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe('>\n✗ Installing broken  its state did not load: the store file is locked\n  Fix it, then run /reload-plugins.')
})

test('a missing secret option asks in the installer to set it in /config, and Not now fails with the same fix', async () => {
  const fake = fakeClaude({ name: 'ci-watch', root })
  const token = option.secret({ title: 'GitHub token', description: 'Reads your CI runs' })
  const lifecycle = createLifecycle(defineMod({ name: 'ci-watch', options: { githubToken: token }, setup() {} }))

  void lifecycle.start(fake.claude, given({ ...pending, name: 'ci-watch', isInstalled: true }))
  await fake.settle()

  expect(await installerText(lifecycle)).toContain('Set it in /config, where Claude Code keeps it in your keychain')
  await pressInInstaller(lifecycle, 'not-now')
  await fake.settle()
  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe('>\n✗ Installing ci-watch  it needs GitHub token\n  Set it in /config.')
})

test('a missing text option saved in the installer through /config starts the mod on Next', async () => {
  const fake = fakeClaude({ name: 'ci-watch', root })
  const saved: unknown[] = []
  const rows: { key: string; value: string }[] = []
  fake.fakes.config.set = async (args) => {
    saved.push(args)
    rows.push({ key: args.key, value: String(args.value) })
    return { value: args.value }
  }
  fake.fakes.config.list = async () => rows.map((row) => ({ ...row, label: row.key, kind: 'text', provider: { plugin: 'ci-watch', tier: 'user' }, isLocked: false }) as never)
  let branch: unknown
  const lifecycle = createLifecycle(defineMod({ name: 'ci-watch', options: { branch: option.text({ title: 'Branch', description: '' }) }, setup: (mod) => void (branch = mod.options.branch) }))

  void lifecycle.start(fake.claude, given({ ...pending, name: 'ci-watch', isInstalled: true }))
  await fake.settle()
  const field = findElement((await fire(lifecycle, 'ui.render', installerPane, prompt)) as RenderElement, 'Input', 'option:branch')
  if (field === undefined) throw new Error('The installer draws no field for branch.')
  ;(field['onSubmit'] as (value: string) => void)('main')
  await fake.settle()
  await pressInInstaller(lifecycle, 'next')
  await fake.settle()

  expect(saved).toEqual([{ key: 'ci-watch.branch', value: 'main' }])
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

  expect(await installerText(lifecycle)).toContain('Sign in to GitHub  (1 of 1)')
  await pressInInstaller(lifecycle, 'next')
  expect(await installerText(lifecycle)).toContain('Finish Sign in to GitHub first.')
  isSignedIn = true
  await pressInInstaller(lifecycle, 'next')
  await fake.settle()
  expect(fake.calls.filter((call) => call.call === 'ui.close').map((call) => call.args[0])).toEqual([{ id: 'cmod-installer' }])
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
  await pressInInstaller(lifecycle, 'not-now')
  await fake.settle()

  expect(fake.shown.logs).toContain('ci-watch needs one more step, starting with Sign in to GitHub. Run /mods ci-watch to finish.')
  expect(await fire(lifecycle, 'cmod.call', { to: 'ci-watch', method: 'cmod:pendingSteps', input: null }, { deny: '' })).toEqual({ value: ['Sign in to GitHub'] })

  const finishing = fire(lifecycle, 'cmod.call', { to: 'ci-watch', method: 'cmod:finishSteps', input: null }, { deny: '' })
  await fake.settle()
  expect(await installerText(lifecycle)).toContain('Sign in to GitHub  (1 of 1)')
  isSignedIn = true
  await pressInInstaller(lifecycle, 'next')
  expect(await finishing).toEqual({ value: null })
  expect(await fire(lifecycle, 'cmod.call', { to: 'ci-watch', method: 'cmod:pendingSteps', input: null }, { deny: '' })).toEqual({ value: [] })
})

test('a mod that decides permissions without registerPermissionCheck does not start, and names the line to add', async () => {
  const fake = fakeClaude({ name: 'guard', root })
  const lifecycle = createLifecycle(defineMod({ name: 'guard', setup: (mod) => mod.on('PermissionRequest', () => undefined) }), () => false)

  await lifecycle.start(fake.claude, given({ ...pending, name: 'guard', isInstalled: true }))

  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe(
    '>\n✗ Installing guard  it decides permissions on classic.PermissionRequest, so hooks/register.ts must call registerPermissionCheck(addHook) after registerMod\n  Fix it, then run /reload-plugins.',
  )
})

test('a mod that decides permissions starts once registerPermissionCheck registered the permission events', async () => {
  const fake = fakeClaude({ name: 'guard', root })
  const lifecycle = createLifecycle(defineMod({ name: 'guard', setup: (mod) => mod.on('PermissionRequest', () => undefined) }), () => true)

  await lifecycle.start(fake.claude, given({ ...pending, name: 'guard', isInstalled: true }))

  expect(lifecycle.phase).toBe('active')
})

test('a mod with a PreToolUse hook starts without registerPermissionCheck', async () => {
  const fake = fakeClaude({ name: 'docs', root })
  const lifecycle = createLifecycle(defineMod({ name: 'docs', setup: (mod) => mod.on('PreToolUse', () => undefined) }), () => false)

  await lifecycle.start(fake.claude, given({ ...pending, name: 'docs', isInstalled: true }))

  expect(lifecycle.phase).toBe('active')
})

test('a PreToolUse allow without registerPermissionCheck denies the call and names the line to add', async () => {
  const fake = fakeClaude({ name: 'auto-approve', root })
  const allows = defineMod({ name: 'auto-approve', setup: (mod) => mod.on('PreToolUse', () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })) })
  const lifecycle = createLifecycle(allows, () => false)
  await lifecycle.start(fake.claude, given({ ...pending, name: 'auto-approve', isInstalled: true }))

  expect(await fire(lifecycle, 'tool.call', { tool: 'Bash', tool_use_id: 'toolu_1', command: 'ls' }, { result: '' })).toEqual({
    deny: 'auto-approve: the PreToolUse hook answered permissionDecision "allow", so hooks/register.ts must call registerPermissionCheck(addHook) after registerMod.',
  })
})

test('a mod whose open panes cannot be read says its open panes did not load', async () => {
  const fake = fakeClaude({ name: 'broken', root })
  fake.claude.ui.panes = async () => Promise.reject(new Error('the pane list is unavailable'))
  const lifecycle = createLifecycle(defineMod({ name: 'broken', setup: (mod) => void mod.ui.pane({ id: 'trash', title: 'Trash', render: () => Text({ children: 'empty' }) }) }))

  await lifecycle.start(fake.claude, given({ ...pending, name: 'broken', isInstalled: true }))

  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe('>\n✗ Installing broken  its open panes did not load: the pane list is unavailable\n  Fix it, then run /reload-plugins.')
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
  await fire(lifecycle, 'classic.PostToolUse', postToolUse, {})

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

  await fire(lifecycle, 'classic.PostToolUse', postToolUse, {})

  expect(runs).toEqual(['setup', 'PostToolUse'])
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
  expect(await fire(lifecycle, 'ui.render', abovePrompt, prompt)).toBe(prompt)

  step.print('done safe-delete 0.2.0')
  step.exit(0)
  await fake.settle()
  await fire(lifecycle, 'classic.UserPromptSubmit', { ...postToolUse, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, {})
  await fake.settle()

  expect(spawned).toHaveLength(1)
  await fire(lifecycle, 'classic.PostToolUse', postToolUse, {})
  expect(runs).toEqual(['setup', 'PostToolUse'])
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
  expect(await fire(lifecycle, 'ui.render', abovePrompt, prompt)).toBe(prompt)
  expect(fake.shown.logs).toEqual(['safe-delete added the Trash pane and a hook on PostToolUse.'])

  isOnPath = true
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})
  await fake.settle()

  expect(spawned).toEqual([{ argv: ['cmod', 'setup', root, '--events'] }])
  expect(await fire(lifecycle, 'ui.render', abovePrompt, prompt)).toBe(prompt)
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
  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toStartWith(`>\n✗ Installing safe-delete  ${root}/.claude-plugin/plugin.json is not JSON`)
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
  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toStartWith(`>\n✗ Installing safe-delete  ${denied}`)
})

test.each(['ENOENT', 'ENOTDIR'])('a path Claude Code fails to stat with %s reads as a missing file', async (errno) => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const files = fakeFiles(manifestOnly)
  Object.assign(fake.fakes.fs, files)
  fake.fakes.fs.stat = async (path, options) => files.stat(path, options).catch(() => Promise.reject(new Error(`safe-delete: $.fs.stat(${path}) failed: ${errno}`)))

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
  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe(
    '>\n✗ Installing safe-delete  cmod --version is still running after 30 s\n  Run cmod install safe-delete in a terminal to see the whole log.',
  )
})

test('cmod missing from PATH is waiting, not a failure', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodMissing
  const { definition } = trackedMod()
  const lifecycle = createLifecycle(definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe('>\n◌ Installing safe-delete  Waiting for cmod')
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
  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe(
    '>\n✗ Installing safe-delete  the installer pane did not open\n  Run cmod install safe-delete in a terminal to see the whole log.',
  )
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

  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe(
    '>\n✗ Installing safe-delete  cmod setup exited 1: cmod setup: disk full\n  Fix the cause, then run: cmod install safe-delete',
  )
})

test('an empty stderr from cmod setup leaves no bare colon in the session', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodOnPath
  fake.fakes.process.spawn = () => finished([], 1)
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe('>\n✗ Installing safe-delete  cmod setup exited 1\n  Fix the cause, then run: cmod install safe-delete')
  expect((lifecycle.failure as Error).message).toBe('safe-delete: cmod setup exited 1. Fix the cause, then run: cmod install safe-delete')
})

test('an empty stderr from the cmod bootstrap leaves no bare colon', async () => {
  const fake = fakeClaude({ name: 'cmod', root })
  fake.fakes.process.spawn = () => finished([], 1)
  const lifecycle = createLifecycle(defineMod({ name: 'cmod', setup() {} }))

  await lifecycle.start(fake.claude, given({ ...pending, name: 'cmod' }))
  await fake.settle()

  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe(`>\n✗ Installing cmod  bootstrap exited 1\n  Run ./setup/bootstrap.sh in ${root} to see the whole log.`)
})

test('an empty stderr from cmod --version leaves no bare colon', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = async () => ({ exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect(textOf(await fire(lifecycle, 'ui.render', abovePrompt, prompt))).toBe('>\n✗ Installing safe-delete  cmod --version exited 1\n  Run cmod install safe-delete in a terminal to see the whole log.')
})

test('a reason ending in ? keeps one mark', async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  fake.fakes.process.run = cmodOnPath
  fake.fakes.process.spawn = () => finished(['failed 1\tIs Homebrew installed?'], 1)
  const lifecycle = createLifecycle(trackedMod().definition)

  await lifecycle.start(fake.claude, given(pending))
  await fake.settle()

  expect((lifecycle.failure as Error).message).toBe('safe-delete: Is Homebrew installed? Fix the cause, then run: cmod install safe-delete')
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
  return { session, moveTo, startConversation, settle: fake.settle }
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
    redrawnFolders.push(`${lifecycle.mod?.projectRoot} ${lifecycle.mod?.cwd}`)
  }
  const moves: unknown[] = []
  const lifecycle = createLifecycle(
    defineMod({
      name: 'file-tree',
      state: { project: { expanded: [] as string[] } },
      setup(mod) {
        mod.ui.pane({ id: 'files', title: 'Files', render: (drawn) => Text({ children: `${drawn.projectRoot} ${drawn.cwd}` }) })
        mod.on('CwdChanged', (input) => void moves.push(input))
      },
    }),
  )
  const filesPane = { surface: 'terminal', component: 'Pane', requestId: 'files', props: { title: 'Files', isFocused: false, bodyColumns: 80, placement: 'dock' } }
  const start = () => lifecycle.start(fake.claude, given({ ...pending, name: 'file-tree', isInstalled: true }))
  const drawn = async () => textOf(await fire(lifecycle, 'ui.render', filesPane, prompt))
  return { fake, lifecycle, session, redraws, redrawnFolders, moves, start, drawn }
}

const movedTo = (oldCwd: string, newCwd: string) => ({ session_id: 'test-session', cwd: newCwd, hook_event_name: 'CwdChanged', old_cwd: oldCwd, new_cwd: newCwd })

const cd = (args: string) => ({ command: 'cd', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

test('a Bash cd moves mod.cwd and redraws the pane', async () => {
  const { lifecycle, session, redraws, start, drawn } = folderPane()
  await start()
  redraws.length = 0
  session.cwd = '/work/a/lib'

  await fire(lifecycle, 'classic.PostToolUse', { ...postToolUse, tool_name: 'Bash', tool_input: { command: 'cd lib' } }, {})

  expect(lifecycle.mod?.cwd).toBe('/work/a/lib')
  expect(redraws).toEqual(['ui.render'])
  expect(await drawn()).toBe('/work/a /work/a/lib')
})

test('a Bash cd in a command that fails still moves mod.cwd', async () => {
  const { lifecycle, session, redraws, start, drawn } = folderPane()
  await start()
  redraws.length = 0
  session.cwd = '/work/a/lib'

  await fire(lifecycle, 'classic.PostToolUseFailure', { ...postToolUse, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'cd lib && make' }, error: 'make: *** No targets.' }, {})

  expect(lifecycle.mod?.cwd).toBe('/work/a/lib')
  expect(redraws).toEqual(['ui.render'])
  expect(await drawn()).toBe('/work/a /work/a/lib')
})

test('a PowerShell cd moves mod.cwd', async () => {
  const { lifecycle, session, redraws, start, drawn } = folderPane()
  await start()
  redraws.length = 0
  session.cwd = '/work/a/lib'

  await fire(lifecycle, 'classic.PostToolUse', { ...postToolUse, tool_name: 'PowerShell', tool_input: { command: 'Set-Location lib' } }, {})

  expect(lifecycle.mod?.cwd).toBe('/work/a/lib')
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

test('after /cd a pane that draws mod.cwd shows the new folder', async () => {
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

test('after /cd while Claude Code still reports the old cwd, the pane redraws once with the new root as mod.cwd', async () => {
  const { lifecycle, session, redrawnFolders, moves, start } = folderPane()
  await start()
  redrawnFolders.length = 0
  session.root = '/work/b'

  await fire(lifecycle, 'command.run', cd('../b'), {})

  expect(redrawnFolders).toEqual(['/work/b /work/b'])
  expect(moves).toEqual([movedTo('/work/a', '/work/b')])
})

test('a Bash call between /cd and the next prompt keeps mod.cwd on the new root', async () => {
  const { lifecycle, session, moves, start } = folderPane()
  await start()
  session.root = '/work/b'
  await fire(lifecycle, 'command.run', cd('../b'), {})

  await fire(lifecycle, 'classic.PostToolUse', { ...postToolUse, tool_name: 'Bash', tool_input: { command: 'ls' } }, {})

  expect([lifecycle.mod?.projectRoot, lifecycle.mod?.cwd]).toEqual(['/work/b', '/work/b'])
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

  expect([lifecycle.mod?.projectRoot, lifecycle.mod?.cwd]).toEqual(['/work/b', '/work/a'])
  expect(moves).toEqual([movedTo('/work/a', '/work/b'), movedTo('/work/b', '/work/a')])
})

test('a /cd the user cancels after a Bash cd out of the project keeps mod.cwd where the Bash cd left it', async () => {
  const { lifecycle, session, moves, start } = folderPane()
  await start()
  session.cwd = '/tmp'
  await fire(lifecycle, 'classic.PostToolUse', { ...postToolUse, tool_name: 'Bash', tool_input: { command: 'cd /tmp' } }, {})

  await fire(lifecycle, 'command.run', cd('../b'), {})

  expect([lifecycle.mod?.projectRoot, lifecycle.mod?.cwd]).toEqual(['/work/a', '/tmp'])
  expect(moves).toEqual([movedTo('/work/a', '/tmp')])
})

test('a Bash cd out of the project after a /cd whose project failed to load moves mod.cwd out of it', async () => {
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

  expect([lifecycle.mod?.projectRoot, lifecycle.mod?.cwd]).toEqual(['/work/b', '/tmp'])
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

  expect([lifecycle.mod?.projectRoot, lifecycle.mod?.cwd]).toEqual(['/work/a', '/work/a'])
  expect(moves).toEqual([])

  isStoreLocked = false
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect([lifecycle.mod?.projectRoot, lifecycle.mod?.cwd]).toEqual(['/work/b', '/work/b'])
  expect(moves).toEqual([movedTo('/work/a', '/work/b')])
})

test('two overlapping folder moves that both fail leave mod.cwd at the last loaded folder', async () => {
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

  expect([lifecycle.mod?.projectRoot, lifecycle.mod?.cwd]).toEqual(['/work/a', '/work/a'])
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

  expect([mod.projectRoot, mod.cwd, mod.state.project.expanded]).toEqual(['/work/a', '/work/a', ['src']])
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

  expect([mod.projectRoot, mod.state.project.expanded]).toEqual(['/work/a', ['src']])
  expect(fake.shown.logs).toContain('file-tree keeps the state of /work/a until the next prompt or folder move: the store file is locked')

  isStoreLocked = false
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect([mod.projectRoot, mod.state.project.expanded]).toEqual(['/work/b', []])
})

function sessionStartMod() {
  const sources: string[] = []
  const definition = defineMod({
    name: 'safe-delete',
    setup(mod) {
      mod.on('SessionStart', (input) => {
        sources.push(input.source)
        return { hookSpecificOutput: { additionalContext: `safe-delete saw ${input.source}` } }
      })
    },
  })
  return { sources, definition }
}

const sessionStart = (source: 'startup' | 'resume') => ({ session_id: 'test-session', transcript_path: '/t', cwd: '/work', hook_event_name: 'SessionStart', source })

const unreadSessionStart = "safe-delete started after Claude Code's SessionStart, so Claude Code did not read the answer of its SessionStart hooks."

test("an installed mod's SessionStart context reaches Claude Code on a fresh start", async () => {
  const fake = fakeClaude({ name: 'safe-delete', root })
  const { sources, definition } = sessionStartMod()
  const lifecycle = createLifecycle(definition)

  const starting = lifecycle.start(fake.claude, given({ ...pending, isInstalled: true, granted: ['prompt'] }))
  const answer = fire(lifecycle, 'classic.SessionStart', sessionStart('resume'), {})
  await starting
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect(await answer).toEqual({ additionalContext: ['safe-delete saw resume'] })
  expect(sources).toEqual(['resume'])
  expect(fake.shown.debug).toEqual([])
})

test('a mod that starts after SessionStart passed runs its SessionStart hooks once', async () => {
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
  expect(fake.shown.debug).toEqual([unreadSessionStart])
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

  await lifecycle.start(fake.claude, given({ ...pending, isInstalled: true }))
  await fire(lifecycle, 'classic.UserPromptSubmit', promptSubmit, {})

  expect(sources).toEqual(['startup'])
  expect(fake.shown.debug).toEqual([unreadSessionStart])
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
    return { ...pending, isInstalled: true }
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
  expect(fake.shown.debug).toEqual([unreadSessionStart])
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

  expect(await answer).toEqual({ additionalContext: ['safe-delete saw startup'] })
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
      setup: (mod) =>
        mod.claude.on('classic.SessionStart', async () => {
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
  expect(fake.shown.logs).toContain('safe-delete: the SessionStart hook failed: no session file')
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
      setup(mod) {
        mod.on('SessionStart', (input) => void seen.push(`${input.source} ${input.session_id}`))
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
