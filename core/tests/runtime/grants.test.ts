import { expect, test } from 'bun:test'
import { defineMod, fs, http, model, process, Prompt, SessionStart, sessions, settings, Stop, UserPromptSubmit, type Mod } from '../../src/mod.js'
import { consentPath, formatEvent, oldestCmodFor, parseEvent, permissionWords, readSteps, scriptsSha256, storeFolder } from '../../src/records.js'
import { engineOf } from '../../src/runtime/engine.js'
import { createLifecycle, type Plugin } from '../../src/runtime/lifecycle.js'
import { fakeClaude } from '../../src/testing/fake-claude.js'
import { testMod } from '../../src/testing.js'

const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

test('readSteps turns package.json "cmod" permissions into one item each', () => {
  const steps = readSteps({ cmod: { permissions: { network: ['api.github.com', '/var/run/docker.sock'], run: ['gh'], files: ['~/.zshrc'], prompt: true, tools: true, config: ['cleanupPeriodDays', 'env.ANTHROPIC_BASE_URL'], conversation: true } } })

  expect(steps).toEqual({ permissions: ['network:api.github.com', 'network:/var/run/docker.sock', 'run:gh', 'files:~/.zshrc', 'prompt', 'tools', 'config:cleanupPeriodDays', 'config:env.ANTHROPIC_BASE_URL', 'conversation'] })
  expect(steps?.permissions?.map(permissionWords)).toEqual([
    'Connect to api.github.com',
    'Connect to /var/run/docker.sock',
    'Run gh on your computer',
    'Change ~/.zshrc',
    'Add text Claude reads and start turns',
    "Use and change Claude's tool calls",
    'Change cleanupPeriodDays in your Claude Code settings',
    'Change env.ANTHROPIC_BASE_URL in your Claude Code settings',
    'Read your Claude Code conversations',
  ])
})

test('readSteps names the fix for each permission it cannot use', () => {
  const read = (permissions: unknown) => () => readSteps({ cmod: { permissions } })

  expect(read({ camera: true })).toThrow('package.json "cmod.permissions" names "camera", which is not a permission.')
  expect(read({ model: 'yes' })).toThrow('package.json "cmod.permissions" sets "model" to "yes". Write "model": true, or leave it out.')
  expect(read({ network: ['https://api.github.com/repos'] })).toThrow('lists "https://api.github.com/repos" under "network". Write a host alone, such as "api.github.com", or a socket path, such as "/var/run/docker.sock".')
  expect(read({ files: ['notes.md'] })).toThrow('lists "notes.md" under "files". Write a path that starts with ~/ or /, such as "~/.zshrc".')
  expect(read({ config: true })).toThrow('sets "config" to true. Write a list, such as "config": ["cleanupPeriodDays"].')
  expect(read({ config: ['env.'] })).toThrow('lists "env." under "config". Write a Claude Code setting\'s name, or a key path inside one, such as "cleanupPeriodDays" or "env.ANTHROPIC_BASE_URL".')
})

test('a call the mod does not declare fails with the line to add to package.json', async () => {
  let failure = ''
  const tested = testMod(
    defineMod({ name: 'ci-watch', setup: (mod) => mod.on(SessionStart, () => http.fetch('https://api.github.com/repos').then(() => undefined, (error: Error) => void (failure = error.message))) }),
    { permissions: [] },
  )

  await tested.fire(SessionStart, { source: 'startup' })

  expect(failure).toBe('ci-watch calls http.fetch(https://api.github.com/repos), which needs "permissions": { "network": ["api.github.com"] } in package.json "cmod".')
})

test('a declared permission the person turned off fails with where to turn it on', async () => {
  const fake = fakeClaude({ name: 'ci-watch', root: '/plugins/ci-watch' })
  const lifecycle = createLifecycle(defineMod({ name: 'ci-watch', setup() {} }))
  const plugin: Plugin = { name: 'ci-watch', root: '/plugins/ci-watch', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: { permissions: ['model'] }, granted: [] }
  await lifecycle.start(fake.claude, async () => plugin)

  await expect(model.complete({ prompt: 'Green?' } as never)).rejects.toThrow('ci-watch calls model.complete without your grant to "Ask a model, which uses your plan". Turn it on in /mods ci-watch.')
})

test('a fetch over a socket needs the socket path, and has names a permission the way package.json writes it', async () => {
  let mod: Mod | undefined
  const tested = testMod(defineMod({ name: 'docker', setup: (started) => void (mod = started) }), { permissions: ['network:/var/run/docker.sock', 'model'] })
  tested.fakes.http.fetch = async () => ({ status: 200, headers: {}, body: '[]' }) as never
  await tested.start()

  expect((await http.fetch('http://localhost/containers/json', { socketPath: '/var/run/docker.sock' })).status).toBe(200)
  await expect(http.fetch('http://localhost/containers/json', { socketPath: '/tmp/other.sock' })).rejects.toThrow('"network": ["/tmp/other.sock"]')
  expect(mod?.permissions.network.allows('/var/run/docker.sock')).toBe(true)
  expect(mod?.permissions.network.allows('api.github.com')).toBe(false)
  expect(mod?.permissions.model).toBe(true)
  expect(mod?.permissions.tasks).toBe(false)
})

test('a write inside the project or the data folder needs no grant, one to a Claude Code settings file is refused for settings.update, and one elsewhere needs files', async () => {
  const writes: string[] = []
  const notes = defineMod({
    name: 'notes',
    setup: (mod) =>
      mod.on(SessionStart, async () => {
        const project = sessions.current.project
        for (const path of [`${project}/notes.md`, `${mod.dataFolder}/cache.json`, `${project}/.claude/settings.json`, '/test/home/.claude/settings.json', '/test/home/.zshrc', '/test/home/.config/notes/rc']) {
          await fs.write(path, 'x').then(
            () => writes.push(`wrote ${path}`),
            (error: Error) => writes.push(error.message),
          )
        }
      }),
  })
  const tested = testMod(notes, { projectRoot: '/work/app', permissions: ['files:~/.config/notes', 'files:~/.claude'] })

  await tested.fire(SessionStart, { source: 'startup' })

  expect(writes).toEqual([
    'wrote /work/app/notes.md',
    'wrote /test/home/.local/share/cmod/data/notes/cache.json',
    "notes writes /work/app/.claude/settings.json by hand. Change Claude Code's settings with settings.user.update, settings.project.update, or settings.local.update, which keep the person's own edits and take the mod's values out when it is removed.",
    "notes writes /test/home/.claude/settings.json by hand. Change Claude Code's settings with settings.user.update, settings.project.update, or settings.local.update, which keep the person's own edits and take the mod's values out when it is removed.",
    'notes calls fs.write(/test/home/.zshrc), which needs "permissions": { "files": ["~/.zshrc"] } in package.json "cmod".',
    'wrote /test/home/.config/notes/rc',
  ])
})

test("reading Claude Code's transcripts needs conversation, and other reads need nothing", async () => {
  const tested = testMod(defineMod({ name: 'reader', setup() {} }), {
    files: { '/test/home/.claude/projects/-work-app/session.jsonl': '{}', '/test/home/notes.md': 'hi' },
    permissions: [],
  })
  await tested.start()

  expect(await fs.read('/test/home/notes.md')).toBe('hi')
  await expect(fs.read('/test/home/.claude/projects/-work-app/session.jsonl')).rejects.toThrow('"permissions": { "conversation": true }')
})

test("the jobs' own Claude Code calls check their grants the same way: tool.call needs tools", async () => {
  let mod: Mod | undefined
  const tested = testMod(defineMod({ name: 'raw', setup: (started) => void (mod = started) }), { permissions: [] })
  await tested.start()

  await expect(engineOf(mod as Mod).claude.tool.call({ tool: 'Read', file_path: '/x' } as never)).rejects.toThrow('raw calls tool.call(Read), which needs "permissions": { "tools": true }')
})

test('run:* covers every program', async () => {
  const tested = testMod(defineMod({ name: 'shell', setup() {} }), { permissions: ['run:*'] })
  tested.fakes.process.run = async () => ok
  await tested.start()

  expect((await process.run(['/usr/bin/make', 'all'])).exitCode).toBe(0)
})

test('a hook answer part without its grant is dropped, and cmod logs once which grant it needs', async () => {
  const tested = testMod(
    defineMod({
      name: 'nudge',
      setup(mod) {
        mod.on(UserPromptSubmit, () => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Be brief.', sessionTitle: 'Nudged' } }))
        mod.on(Stop, () => ({ decision: 'block', reason: 'Keep going.' }))
      },
    }),
    { permissions: [] },
  )

  const first = (await tested.fire(UserPromptSubmit, { prompt: 'hi' })) as Record<string, unknown>
  await tested.fire(UserPromptSubmit, { prompt: 'again' })
  const stopped = (await tested.fire(Stop, { stop_hook_active: false } as never)) as Record<string, unknown>

  expect(first['additionalContext']).toBeUndefined()
  expect(first['sessionTitle']).toBe('Nudged')
  expect(stopped['block']).toBeUndefined()
  expect(tested.shown.toasts.filter(({ type }) => type === 'warning')).toEqual([
    {
      type: 'warning',
      message: 'Answered additionalContext without your grant to "Add text Claude reads and start turns", so cmod dropped it',
      description: 'It needs "permissions": { "prompt": true } in package.json "cmod".',
    },
  ])
})

test('a program run without its grant names the line to add', async () => {
  let failure = ''
  const tested = testMod(defineMod({ name: 'preview', setup: (mod) => mod.on(SessionStart, () => process.run(['preview-server']).then(() => undefined, (error: Error) => void (failure = error.message))) }), { permissions: [] })

  await tested.fire(SessionStart, { source: 'startup' })

  expect(failure).toBe('preview calls process.run(preview-server), which needs "permissions": { "run": ["preview-server"] } in package.json "cmod".')
})

test('settings.update sends each listed setting to the cmod plugin and refuses one the mod does not list', async () => {
  const sent: unknown[] = []
  const tested = testMod(defineMod({ name: 'keeper', setup() {} }), {
    projectRoot: '/work/app',
    permissions: ['config:cleanupPeriodDays'],
    dependencies: {
      cmod: {
        updateSettings(input: unknown) {
          sent.push(input)
          return null
        },
      },
    } as never,
  })
  await tested.start()

  await settings.user.update({ cleanupPeriodDays: 365 })
  await expect(settings.project.update({ statusLine: null })).rejects.toThrow('keeper calls settings.project.update(statusLine), which needs "permissions": { "config": ["statusLine"] } in package.json "cmod".')

  expect(sent).toEqual([{ mod: 'keeper', source: 'user', project: '/work/app', values: { cleanupPeriodDays: 365 } }])
})

test('a config grant names a key path, and covers each value at or below it', async () => {
  const sent: unknown[] = []
  let mod: Mod | undefined
  const tested = testMod(defineMod({ name: 'oneclaude', setup: (started) => void (mod = started) }), {
    permissions: ['config:env.ANTHROPIC_BASE_URL', 'config:permissions'],
    dependencies: {
      cmod: {
        updateSettings(input: unknown) {
          sent.push((input as { values: unknown }).values)
          return null
        },
      },
    } as never,
  })
  await tested.start()

  await settings.user.update({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' }, permissions: { allow: ['Bash(gh:*)'] } })
  await expect(settings.user.update({ env: { ANTHROPIC_BASE_URL: null, OTHER: '1' } })).rejects.toThrow('oneclaude calls settings.user.update(env.OTHER), which needs "permissions": { "config": ["env.OTHER"] } in package.json "cmod".')

  expect(sent).toEqual([{ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' }, permissions: { allow: ['Bash(gh:*)'] } }])
  expect([mod?.permissions.config.allows('env.ANTHROPIC_BASE_URL'), mod?.permissions.config.allows('env'), mod?.permissions.config.allows('permissions.deny'), mod?.permissions.config.allows('permissionsX')]).toEqual([true, false, true, false])
})

test('a hook answer part with its grant reaches Claude Code', async () => {
  const tested = testMod(defineMod({ name: 'nudge', setup: (mod) => mod.on(UserPromptSubmit, () => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Be brief.' } })) }), {
    permissions: ['prompt'],
  })

  const answer = (await tested.fire(UserPromptSubmit, { prompt: 'hi' })) as Record<string, unknown>

  expect(answer['additionalContext']).toEqual(['Be brief.'])
})

test("a changed tool input without tools runs the call as Claude asked, and the mod's own tool answers freely", async () => {
  const seen: unknown[] = []
  const fake = fakeClaude({ name: 'rewriter', root: '/plugins/rewriter' })
  const lifecycle = createLifecycle(
    defineMod({
      name: 'rewriter',
      setup(mod) {
        engineOf(mod).router.add('tool.call', (e, next) => (e.tool === 'mcp__rewriter__echo' ? { result: 'echoed' } : next({ ...e, command: 'ls -la' } as typeof e)))
      },
    }),
  )
  await lifecycle.start(fake.claude, async () => ({ name: 'rewriter', root: '/plugins/rewriter', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {}, granted: [] }))
  const below = async (e: unknown) => {
    seen.push(e)
    return { result: 'ok' } as never
  }

  const echoed = await lifecycle.route('tool.call', { tool: 'mcp__rewriter__echo', tool_use_id: 't1' } as never, below)
  await lifecycle.route('tool.call', { tool: 'Bash', tool_use_id: 't2', command: 'ls' } as never, below)

  expect(echoed).toEqual({ result: 'echoed' } as never)
  expect(seen).toEqual([{ tool: 'Bash', tool_use_id: 't2', command: 'ls' }])
  expect(lifecycle.toasts.filter(({ type }) => type === 'warning')).toEqual([
    {
      type: 'warning',
      message: 'Answered a changed tool input without your grant to "Use and change Claude\'s tool calls", so cmod dropped it',
      description: 'It needs "permissions": { "tools": true } in package.json "cmod".',
    },
  ])
})

test("the cmod plugin passes on a mod's changed tool input, which that mod's own grant already covers", async () => {
  const seen: unknown[] = []
  const fake = fakeClaude({ name: 'cmod', root: '/plugins/cmod' })
  const lifecycle = createLifecycle(
    defineMod({
      name: 'cmod',
      setup(mod) {
        engineOf(mod).router.add('tool.call', (e, next) => next({ ...e, command: 'echo safe' } as typeof e))
      },
    }),
  )
  await lifecycle.start(fake.claude, async () => ({ name: 'cmod', root: '/plugins/cmod', version: '1.5.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {}, granted: ['conversation', 'prompt'] }))

  await lifecycle.route('tool.call', { tool: 'Bash', tool_use_id: 't1', command: 'rm -rf build' } as never, async (e: unknown) => {
    seen.push(e)
    return { result: 'ok' }
  })

  expect(seen).toEqual([{ tool: 'Bash', tool_use_id: 't1', command: 'echo safe' }])
  expect(lifecycle.toasts.filter(({ type }) => type === 'warning')).toEqual([])
})

test('needs-consent carries the permissions the person has not granted yet, after the keys', () => {
  const event = { type: 'needs-consent', sha256: 'abc', install: './setup/install.sh', uninstall: '', keys: 'ctrl+l to /ci', permissions: ['network:api.github.com', 'prompt'] } as const

  expect(parseEvent(formatEvent(event))).toEqual(event)
  expect(parseEvent('needs-consent abc\t./setup/install.sh\t\t')).toEqual({ ...event, keys: '', permissions: [] })
})

test('the consent hash changes when the permissions change', async () => {
  const files = { read: async () => undefined, list: async () => [] }
  const base = await scriptsSha256({ permissions: ['prompt'] }, files)

  expect(await scriptsSha256({ permissions: ['prompt', 'network:api.github.com'] }, files)).not.toBe(base)
})

test('a mod that asks for a config list needs cmod 1.6, for tasks 1.0, and other permissions need 0.2', () => {
  expect(oldestCmodFor({ permissions: ['tasks'] })).toBe('1.0.0')
  expect(oldestCmodFor({ permissions: ['config:statusLine'] })).toBe('1.6.0')
  expect(oldestCmodFor({ permissions: ['prompt', 'network:api.github.com'] })).toBe('0.2.0')
})

test('a mod whose conversation grant the person turned off hears no new message after the next prompt', async () => {
  const heard: string[] = []
  const tested = testMod(defineMod({ name: 'listener', setup: () => void sessions.current.on(Prompt, (prompt) => void heard.push(prompt.text)) }), { permissions: ['conversation'] })
  await tested.add({ type: Prompt, text: 'before' })

  await tested.fakes.fs.write?.(consentPath(storeFolder({ HOME: '/test/home' })), JSON.stringify({ listener: [] }))
  await tested.fire(UserPromptSubmit, { prompt: 'refresh grants' })
  await tested.add({ type: Prompt, text: 'after' })

  expect(heard).toEqual(['before'])
})
