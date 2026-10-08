import { expect, test } from 'bun:test'
import { defineMod, type Mod } from '../../src/mod.js'
import { formatEvent, parseEvent, permissionWords, readSteps, scriptsSha256 } from '../../src/records.js'
import { createLifecycle, type Plugin } from '../../src/runtime/lifecycle.js'
import { fakeClaude } from '../../src/testing/fake-claude.js'
import { testMod } from '../../src/testing.js'

const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

test('readSteps turns package.json "cmod" permissions into one item each', () => {
  const steps = readSteps({ cmod: { permissions: { network: ['api.github.com', '/var/run/docker.sock'], run: ['gh'], files: ['~/.zshrc'], prompt: true, tools: true, config: true } } })

  expect(steps).toEqual({ permissions: ['network:api.github.com', 'network:/var/run/docker.sock', 'run:gh', 'files:~/.zshrc', 'prompt', 'tools', 'config'] })
  expect(steps?.permissions?.map(permissionWords)).toEqual([
    'Connect to api.github.com',
    'Connect to /var/run/docker.sock',
    'Run gh on your computer',
    'Change ~/.zshrc',
    'Add text Claude reads and start turns',
    "Use and change Claude's tool calls",
    'Change your Claude Code settings',
  ])
})

test('readSteps names the fix for each permission it cannot use', () => {
  const read = (permissions: unknown) => () => readSteps({ cmod: { permissions } })

  expect(read({ camera: true })).toThrow('package.json "cmod.permissions" names "camera", which is not a permission.')
  expect(read({ model: 'yes' })).toThrow('package.json "cmod.permissions" sets "model" to "yes". Write "model": true, or leave it out.')
  expect(read({ network: ['https://api.github.com/repos'] })).toThrow('lists "https://api.github.com/repos" under "network". Write a host alone, such as "api.github.com", or a socket path, such as "/var/run/docker.sock".')
  expect(read({ files: ['notes.md'] })).toThrow('lists "notes.md" under "files". Write a path that starts with ~/ or /, such as "~/.zshrc".')
})

test('a call the mod does not declare fails with the line to add to package.json', async () => {
  let failure = ''
  const tested = testMod(
    defineMod({ name: 'ci-watch', setup: (mod) => mod.on('SessionStart', () => mod.http.fetch('https://api.github.com/repos').then(() => undefined, (error: Error) => void (failure = error.message))) }),
    { permissions: [] },
  )

  await tested.fire('SessionStart', { source: 'startup' })

  expect(failure).toBe('ci-watch calls http.fetch(https://api.github.com/repos), which needs "permissions": { "network": ["api.github.com"] } in package.json "cmod".')
})

test('a declared permission the person turned off fails with where to turn it on', async () => {
  const fake = fakeClaude({ name: 'ci-watch', root: '/plugins/ci-watch' })
  let mod: Mod | undefined
  const lifecycle = createLifecycle(defineMod({ name: 'ci-watch', setup: (started) => void (mod = started) }))
  const plugin: Plugin = { name: 'ci-watch', root: '/plugins/ci-watch', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: { permissions: ['model'] }, granted: [] }
  await lifecycle.start(fake.claude, async () => plugin)

  await expect(mod?.model.complete({ prompt: 'Green?' } as never) ?? Promise.resolve()).rejects.toThrow('ci-watch calls model.complete without your grant to "Ask a model, which uses your plan". Turn it on in /mods ci-watch.')
})

test('a fetch over a socket needs the socket path, and has names a permission the way package.json writes it', async () => {
  let mod: Mod | undefined
  const tested = testMod(defineMod({ name: 'docker', setup: (started) => void (mod = started) }), { permissions: ['network:/var/run/docker.sock', 'model'] })
  tested.fakes.http.fetch = async () => ({ status: 200, headers: {}, body: '[]' }) as never
  await tested.start()

  expect((await mod?.http.fetch('http://localhost/containers/json', { socketPath: '/var/run/docker.sock' }))?.status).toBe(200)
  await expect(mod?.http.fetch('http://localhost/containers/json', { socketPath: '/tmp/other.sock' }) ?? Promise.resolve()).rejects.toThrow('"network": ["/tmp/other.sock"]')
  expect(mod?.permissions.has('network', '/var/run/docker.sock')).toBe(true)
  expect(mod?.permissions.has('network', 'api.github.com')).toBe(false)
  expect(mod?.permissions.has('model')).toBe(true)
  expect(mod?.permissions.has('agents')).toBe(false)
})

test('a write inside the project or the data folder needs no grant, one to Claude Code settings needs config, and one elsewhere needs files', async () => {
  const writes: string[] = []
  const notes = defineMod({
    name: 'notes',
    setup: (mod) =>
      mod.on('SessionStart', async () => {
        for (const path of [`${mod.projectRoot}/notes.md`, `${mod.dataFolder}/cache.json`, `${mod.projectRoot}/.claude/settings.json`, '/test/home/.zshrc', '/test/home/.config/notes/rc']) {
          await mod.fs.write(path, 'x').then(
            () => writes.push(`wrote ${path}`),
            (error: Error) => writes.push(error.message),
          )
        }
      }),
  })
  const tested = testMod(notes, { projectRoot: '/work/app', permissions: ['files:~/.config/notes'] })

  await tested.fire('SessionStart', { source: 'startup' })

  expect(writes).toEqual([
    'wrote /work/app/notes.md',
    'wrote /test/home/.local/share/cmod/data/notes/cache.json',
    'notes calls fs.write(/work/app/.claude/settings.json), which needs "permissions": { "config": true } in package.json "cmod".',
    'notes calls fs.write(/test/home/.zshrc), which needs "permissions": { "files": ["~/.zshrc"] } in package.json "cmod".',
    'wrote /test/home/.config/notes/rc',
  ])
})

test("reading Claude Code's transcripts needs conversation, and other reads need nothing", async () => {
  let mod: Mod | undefined
  const tested = testMod(defineMod({ name: 'reader', setup: (started) => void (mod = started) }), {
    files: { '/test/home/.claude/projects/-work-app/session.jsonl': '{}', '/test/home/notes.md': 'hi' },
    permissions: [],
  })
  await tested.start()

  expect(await mod?.fs.read('/test/home/notes.md')).toBe('hi')
  await expect(mod?.fs.read('/test/home/.claude/projects/-work-app/session.jsonl') ?? Promise.resolve()).rejects.toThrow('"permissions": { "conversation": true }')
})

test('mod.claude checks its calls the same way: tool.call needs tools', async () => {
  let mod: Mod | undefined
  const tested = testMod(defineMod({ name: 'raw', setup: (started) => void (mod = started) }), { permissions: [] })
  await tested.start()

  await expect(mod?.claude.tool.call({ tool: 'Read', file_path: '/x' } as never) ?? Promise.resolve()).rejects.toThrow('raw calls tool.call(Read), which needs "permissions": { "tools": true }')
})

test('run:* covers every program', async () => {
  let ran: Mod['process'] | undefined
  const tested = testMod(defineMod({ name: 'shell', setup: (mod) => void (ran = mod.process) }), { permissions: ['run:*'] })
  tested.fakes.process.run = async () => ok
  await tested.start()

  expect((await ran?.run(['/usr/bin/make', 'all']))?.exitCode).toBe(0)
})

test('a hook answer part without its grant is dropped, and cmod logs once which grant it needs', async () => {
  const tested = testMod(
    defineMod({
      name: 'nudge',
      setup(mod) {
        mod.on('UserPromptSubmit', () => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Be brief.', sessionTitle: 'Nudged' } }))
        mod.on('Stop', () => ({ decision: 'block', reason: 'Keep going.' }))
      },
    }),
    { permissions: [] },
  )

  const first = (await tested.fire('UserPromptSubmit', { prompt: 'hi' })) as Record<string, unknown>
  await tested.fire('UserPromptSubmit', { prompt: 'again' })
  const stopped = (await tested.fire('Stop', { stop_hook_active: false } as never)) as Record<string, unknown>

  expect(first['additionalContext']).toBeUndefined()
  expect(first['sessionTitle']).toBe('Nudged')
  expect(stopped['block']).toBeUndefined()
  expect(tested.shown.logs.filter((line) => line.includes('without your grant'))).toEqual([
    'nudge answered additionalContext without your grant to "Add text Claude reads and start turns", so cmod dropped it. It needs "permissions": { "prompt": true } in package.json "cmod".',
  ])
})

test('a program run without its grant names the line to add', async () => {
  let failure = ''
  const tested = testMod(defineMod({ name: 'preview', setup: (mod) => mod.on('SessionStart', () => mod.process.run(['preview-server']).then(() => undefined, (error: Error) => void (failure = error.message))) }), { permissions: [] })

  await tested.fire('SessionStart', { source: 'startup' })

  expect(failure).toBe('preview calls process.run(preview-server), which needs "permissions": { "run": ["preview-server"] } in package.json "cmod".')
})

test('a hook answer part with its grant reaches Claude Code', async () => {
  const tested = testMod(defineMod({ name: 'nudge', setup: (mod) => mod.on('UserPromptSubmit', () => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Be brief.' } })) }), {
    permissions: ['prompt'],
  })

  const answer = (await tested.fire('UserPromptSubmit', { prompt: 'hi' })) as Record<string, unknown>

  expect(answer['additionalContext']).toEqual(['Be brief.'])
})

test("a changed tool input without tools runs the call as Claude asked, and the mod's own tool answers freely", async () => {
  const seen: unknown[] = []
  const fake = fakeClaude({ name: 'rewriter', root: '/plugins/rewriter' })
  const lifecycle = createLifecycle(
    defineMod({
      name: 'rewriter',
      setup(mod) {
        mod.claude.on('tool.call', (e, next) => (e.tool === 'mcp__rewriter__echo' ? ({ result: 'echoed' } as never) : next({ ...e, command: 'ls -la' } as typeof e)))
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
  expect(fake.shown.logs).toEqual(['rewriter answered a changed tool input without your grant to "Use and change Claude\'s tool calls", so cmod dropped it. It needs "permissions": { "tools": true } in package.json "cmod".'])
})

test('needs-consent carries the permissions the person has not granted yet, after the keys', () => {
  const event = { kind: 'needs-consent', sha256: 'abc', install: './setup/install.sh', uninstall: '', keys: 'ctrl+l to /ci', permissions: ['network:api.github.com', 'prompt'] } as const

  expect(parseEvent(formatEvent(event))).toEqual(event)
  expect(parseEvent('needs-consent abc\t./setup/install.sh\t\t')).toEqual({ ...event, keys: '', permissions: [] })
})

test('the consent hash changes when the permissions change', async () => {
  const files = { read: async () => undefined, list: async () => [] }
  const base = await scriptsSha256({ permissions: ['prompt'] }, files)

  expect(await scriptsSha256({ permissions: ['prompt', 'network:api.github.com'] }, files)).not.toBe(base)
})
