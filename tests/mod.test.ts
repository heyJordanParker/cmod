import { expect, test } from 'bun:test'
import type { EngineCreateResult, HookStream, On, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import type { Claude } from '../node_modules/@cmodjs/core/runtime/claude.js'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { register } from '../hooks/register.js'
import { cmodPlugin } from '../src/mod.js'
import type { Cmod } from '../types/index.js'

declare const Bun: { sleep(ms: number): Promise<void> }

type Answer = { exitCode: number; stdout: string; stderr: string }

function testRemovals(installedPlugins: readonly string[] | null, userPlugins: Record<string, boolean>, answers: Record<string, Answer> = {}, mergedPlugins: Record<string, boolean> = userPlugins) {
  const tested = testMod(cmodPlugin, { state: { global: { installedPlugins } } })
  const teardowns: string[] = []
  tested.fakes.settings.read = async (args) => ({ enabledPlugins: args?.source === 'user' ? userPlugins : mergedPlugins })
  tested.fakes.process.run = async (argv) => {
    teardowns.push(argv.join(' '))
    const answer = answers[argv[2] ?? ''] ?? { exitCode: 0, stdout: `missing ${argv[2]}\n`, stderr: '' }
    return { ...answer, isStdoutTruncated: false, isStderrTruncated: false }
  }
  return { tested, teardowns }
}

const settled = () => Bun.sleep(0)

test("a removed enabledPlugins key runs cmod teardown --events with that plugin's name, and the uninstall toast tells the user to reload", async () => {
  const { tested, teardowns } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true }, { 'four-step': { exitCode: 0, stdout: 'progress 1 1 Removing the alias\ndone four-step\n', stderr: '' } })
  await tested.fire('UserPromptSubmit', { prompt: 'hello' })
  await settled()
  expect(teardowns).toEqual(['cmod teardown four-step --events'])
  expect(tested.shown.toasts).toEqual(['cmod is ready', 'four-step is uninstalled. A session that still runs it stops after /reload-plugins.'])
  expect(tested.state.global.installedPlugins).toEqual(['cmod'])
})

test('a removal noticed at session start toasts that a session still running it stops after /reload-plugins', async () => {
  const { tested, teardowns } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true }, { 'four-step': { exitCode: 0, stdout: 'done four-step\n', stderr: '' } })
  await tested.fire('SessionStart', { source: 'startup' })
  await settled()
  expect(teardowns).toEqual(['cmod teardown four-step --events'])
  expect(tested.shown.toasts).toEqual(['cmod is ready', 'four-step is uninstalled. A session that still runs it stops after /reload-plugins.'])
})

test('the cmod plugin tears down only keys removed from user settings', async () => {
  const user = { 'cmod@fixtures': true, 'four-step@fixtures': true }
  const { tested, teardowns } = testRemovals(['cmod', 'four-step'], user, {}, { 'cmod@fixtures': true, 'project-mod@team': true })
  await tested.fire('SessionStart', { source: 'startup' })
  await settled()
  expect(teardowns).toEqual([])
  expect(tested.state.global.installedPlugins).toEqual(['cmod', 'four-step'])
})

test('a key set to false runs nothing', async () => {
  const { tested, teardowns } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true, 'four-step@fixtures': false })
  await tested.fire('UserPromptSubmit', { prompt: 'hello' })
  await settled()
  expect(teardowns).toEqual([])
  expect(tested.state.global.installedPlugins).toEqual(['cmod', 'four-step'])
})

test('a tool call reads no settings and tears nothing down', async () => {
  const { tested, teardowns } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true })
  await tested.fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1' })
  await settled()
  expect(tested.calls.filter((call) => call.call === 'settings.read')).toEqual([])
  expect(teardowns).toEqual([])
})

test('the first snapshot after install removes nothing', async () => {
  const { tested, teardowns } = testRemovals(null, { 'cmod@fixtures': true })
  await tested.fire('SessionStart', { source: 'startup' })
  await settled()
  expect(teardowns).toEqual([])
  expect(tested.state.global.installedPlugins).toEqual(['cmod'])
})

test('a removed plugin that is not a cmod mod answers missing and shows nothing', async () => {
  const { tested, teardowns } = testRemovals(['cmod', 'other-plugin'], { 'cmod@fixtures': true })
  await tested.fire('UserPromptSubmit', { prompt: 'hello' })
  await settled()
  expect(teardowns).toEqual(['cmod teardown other-plugin --events'])
  expect(tested.shown.toasts).toEqual(['cmod is ready'])
  expect(tested.state.global.installedPlugins).toEqual(['cmod'])
})

test('a failed removal is not retried in the next session and its toast names the fix', async () => {
  const message = 'The uninstall step of four-step exited 2: zsh: no such file: ~/.zshrc.d/four-step. Fix ~/.local/share/cmod/uninstall/four-step/uninstall.sh, then run cmod teardown four-step.'
  const failed = { 'four-step': { exitCode: 1, stdout: `log removing the alias\nfailed 2\t${message}\n`, stderr: '' } }
  const { tested } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true }, failed)
  await tested.fire('UserPromptSubmit', { prompt: 'hello' })
  await settled()
  expect(tested.shown.toasts).toEqual(['cmod is ready', message])

  const next = testRemovals(tested.state.global.installedPlugins, { 'cmod@fixtures': true }, failed)
  await next.tested.fire('SessionStart', { source: 'startup' })
  await settled()
  expect(next.teardowns).toEqual([])
  expect(next.tested.shown.toasts).toEqual(['cmod is ready'])
})

test('a removal interrupted before its teardown answers is torn down by the next session', async () => {
  const interrupted = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true })
  interrupted.tested.fakes.process.run = () => new Promise(() => {})
  await interrupted.tested.fire('SessionStart', { source: 'startup' })
  await settled()
  expect(interrupted.tested.state.global.installedPlugins).toEqual(['cmod', 'four-step'])

  const next = testRemovals(interrupted.tested.state.global.installedPlugins, { 'cmod@fixtures': true }, { 'four-step': { exitCode: 0, stdout: 'done four-step\n', stderr: '' } })
  await next.tested.fire('SessionStart', { source: 'startup' })
  await settled()
  expect(next.teardowns).toEqual(['cmod teardown four-step --events'])
  expect(next.tested.state.global.installedPlugins).toEqual(['cmod'])
})

test('a prompt while a removal is pending starts no second teardown in the same session', async () => {
  const { tested, teardowns } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true })
  tested.fakes.process.run = (argv) => {
    teardowns.push(argv.join(' '))
    return new Promise(() => {})
  }
  await tested.fire('SessionStart', { source: 'startup' })
  await tested.fire('UserPromptSubmit', { prompt: 'hello' })
  await settled()
  expect(teardowns).toEqual(['cmod teardown four-step --events'])
})

test('a teardown that fails before any event shows its last line of standard error', async () => {
  const { tested } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true }, { 'four-step': { exitCode: 1, stdout: '', stderr: 'cmod teardown: records/four-step.json is not JSON\n' } })
  await tested.fire('UserPromptSubmit', { prompt: 'hello' })
  await settled()
  expect(tested.shown.toasts).toEqual(['cmod is ready', 'cmod teardown four-step exited 1: cmod teardown: records/four-step.json is not JSON'])
})

const store = '/test/home/.local/share/cmod'

function testPanel() {
  const tested = testMod(cmodPlugin, {
    state: { global: { installedPlugins: [] } },
    files: {
      [`${store}/records/ci-watch.json`]: JSON.stringify({ name: 'ci-watch', version: '0.2.0', root: '/plugins/ci-watch', installedAt: '', scriptsSha256: '', uninstall: null, program: null, keys: { 'ctrl+l': 'ci-watch' } }),
      [`${store}/consent.json`]: JSON.stringify({ 'ci-watch': ['network:api.github.com'] }),
      '/plugins/ci-watch/package.json': JSON.stringify({ cmod: { permissions: { network: ['api.github.com'], model: true } } }),
      '/plugins/ci-watch/.claude-plugin/plugin.json': JSON.stringify({ name: 'ci-watch', version: '0.2.0', description: 'Tells you when CI fails on your branch' }),
    },
  })
  tested.fakes.settings.read = async () => ({ enabledPlugins: { 'ci-watch@ci-watch': true } })
  const ran: string[] = []
  tested.fakes.process.run = async (argv) => {
    ran.push(argv.join(' '))
    return { exitCode: 0, stdout: 'Turned on for ci-watch: Ask a model, which uses your plan\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  }
  tested.fakes.config.list = async () => [{ key: 'ci-watch.branch', label: 'Branch', kind: 'text', value: 'main', provider: { plugin: 'ci-watch', tier: 'user' }, isLocked: false } as never]
  const called: string[] = []
  tested.fakes.cmod.call = async (input) => {
    called.push(`${input.to} ${input.method}`)
    if (input.method === 'cmod:settingsPages') return [{ id: 'runs', title: 'Runs' }]
    if (input.method === 'cmod:pendingSteps') return called.includes('ci-watch cmod:finishSteps') ? [] : ['Sign in to GitHub']
    return null
  }
  return { tested, ran, called }
}

test('/mods lists each set-up mod with its options, permissions, keys, and pages', async () => {
  const { tested } = testPanel()

  await tested.type('/mods ci-watch')
  await tested.settle()
  const options = (await tested.lines('mods')).join('\n')
  await tested.press('mods', 'tab:permissions')
  const permissions = (await tested.lines('mods')).join('\n')
  await tested.press('mods', 'tab:keys')
  const keys = (await tested.lines('mods')).join('\n')
  await tested.press('mods', 'tab:pages')
  const pages = (await tested.lines('mods')).join('\n')

  expect(tested.shown.openPanes.has('mods')).toBe(true)
  expect(options).toContain('ci-watch 0.2.0')
  expect(options).toContain('Tells you when CI fails on your branch')
  expect(options).not.toContain('Off:')
  expect(options).toContain('Branch')
  expect(permissions).toContain('[x] Connect to api.github.com')
  expect(permissions).toContain('[ ] Ask a model, which uses your plan')
  expect(keys).toContain('ctrl+l')
  expect(pages).toContain('Runs')
})

test('a /mods permission toggle runs cmod permission, and an option saves through cmod option', async () => {
  const { tested, ran } = testPanel()
  await tested.type('/mods ci-watch')
  await tested.settle()

  await tested.input('mods', 'option:ci-watch.branch', 'release')
  await tested.press('mods', 'tab:permissions')
  await tested.press('mods', 'permission:model')
  await tested.settle()

  expect(ran).toEqual(['cmod option ci-watch branch release', 'cmod permission ci-watch model on'])
})

test('/mods marks a mod turned off in Claude Code, and Turn on runs cmod enable', async () => {
  const { tested, ran } = testPanel()
  tested.fakes.settings.read = async () => ({ enabledPlugins: { 'ci-watch@ci-watch': false } })

  await tested.type('/mods ci-watch')
  await tested.settle()
  const lines = (await tested.lines('mods')).join('\n')
  await tested.press('mods', 'turn')
  await tested.settle()

  expect(lines).toContain('ci-watch (off)')
  expect(lines).toContain('Off: Claude Code does not load it.')
  expect(lines).toContain('Turn on')
  expect(ran).toEqual(['cmod enable ci-watch'])
  expect((await tested.lines('mods')).join(' ').replace(/\s+/g, ' ')).toContain('Turned ci-watch on. This session follows after /reload-plugins.')
})

test('/mods Turn off runs cmod disable on a mod that is on', async () => {
  const { tested, ran } = testPanel()
  await tested.type('/mods ci-watch')
  await tested.settle()

  await tested.press('mods', 'turn')
  await tested.settle()

  expect(ran).toEqual(['cmod disable ci-watch'])
})

test('/mods Remove asks first, and Remove again runs cmod remove', async () => {
  const { tested, ran } = testPanel()
  await tested.type('/mods ci-watch')
  await tested.settle()

  await tested.press('mods', 'remove')
  const asked = (await tested.lines('mods')).join('\n')
  await tested.press('mods', 'keep')
  const kept = (await tested.lines('mods')).join('\n')
  await tested.press('mods', 'remove')
  await tested.press('mods', 'remove-confirmed')
  await tested.settle()

  expect(asked.replace(/\s+/g, ' ')).toContain('Remove ci-watch? Its uninstall step runs, and Claude Code deletes it.')
  expect(kept).not.toContain('Remove ci-watch?')
  expect(ran).toEqual(['cmod remove ci-watch'])
  expect((await tested.lines('mods')).join(' ').replace(/\s+/g, ' ')).toContain('Removed ci-watch. This session stops running it after /reload-plugins.')
})

test('/mods shows the installer steps a mod still needs, and Finish setup runs them', async () => {
  const { tested, called } = testPanel()
  await tested.type('/mods ci-watch')
  await tested.settle()
  expect((await tested.lines('mods')).join('\n')).toContain('Needs setup: Sign in to GitHub')

  await tested.press('mods', 'finish')
  await tested.settle()

  expect(called).toContain('ci-watch cmod:finishSteps')
  expect((await tested.lines('mods')).join('\n')).not.toContain('Needs setup')
})

test('cmod.call denies a call no mod takes with the install command', async () => {
  const hooks = new Map<string, (...args: unknown[]) => Promise<EngineCreateResult>>()
  const on = (event: string, hook: (...args: unknown[]) => Promise<EngineCreateResult>) => void hooks.set(event, hook)
  register(on as unknown as On, {})

  const built = (await hooks.get('engine.create')?.({}, { plugins: ['cmod'] }, async () => ({}))) as { cmod: Cmod }

  expect(await built.cmod.call({ to: 'tracer', method: 'signatures', input: { path: 'src/a.ts' } })).toEqual({ deny: 'tracer is not installed. Run cmod install tracer.' })
})

function cmodAnswering(answers: Record<string, { code: number; stdout?: string; stderr?: string }>) {
  const tested = testMod(cmodPlugin, { state: { global: { installedPlugins: ['cmod'] } } })
  const spawned: string[][] = []
  const sessions: (string | undefined)[] = []
  tested.fakes.process.spawn = (request) => {
    spawned.push([...request.argv])
    sessions.push(request.env?.['CLAUDE_CODE_SESSION_ID'])
    const { code, stdout = '', stderr = '' } = answers[request.argv.slice(1, 3).join(' ')] ?? { code: 0 }
    const chunks: ProcessSpawnChunk[] = [...(stdout === '' ? [] : [{ stream: 'stdout' as const, text: stdout }]), ...(stderr === '' ? [] : [{ stream: 'stderr' as const, text: stderr }])]
    async function* read(): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
      yield* chunks
      return { code, signal: null }
    }
    return Object.assign(read(), { result: Promise.resolve({ code, signal: null }) }) as HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  }
  return { tested, spawned, sessions }
}

test('the history call runs cmod history in this session with the request as flags and answers its JSON, and the session start indexes in the background', async () => {
  const session = { id: 's1', title: 'Rename the tree pane', project: '/work/app', startedAt: '2026-10-11T10:00:00.000Z', lastAt: '2026-10-11T10:05:00.000Z' }
  const { tested, spawned, sessions } = cmodAnswering({ 'history sessions': { code: 0, stdout: `${JSON.stringify([session])}\n` }, 'history messages': { code: 0, stdout: '[]\n' } })
  const history = (input: unknown) => tested.fire('cmod.call', { to: 'cmod', method: 'history', input })

  expect(await history({ command: 'sessions', project: '/work/app', since: '2d', everyProject: true })).toEqual({ value: [session] })
  expect(await history({ command: 'messages', project: '/work/app', session: 's1', agent: 'a7', after: 'm9', limit: 100 })).toEqual({ value: [] })

  expect(spawned).toEqual([
    ['cmod', 'history', 'index'],
    ['cmod', 'history', 'sessions', '--json', '--project', '/work/app', '--since', '2d', '--all'],
    ['cmod', 'history', 'messages', 's1', '--json', '--project', '/work/app', '--agent', 'a7', '--after', 'm9', '--limit', '100'],
  ])
  expect(sessions).toEqual(['test-session', 'test-session', 'test-session'])
})

test("the updateSettings call runs cmod settings for the mod, and a refusal comes back as the deny with cmod's last error line", async () => {
  const { tested, spawned } = cmodAnswering({ 'settings keeper': { code: 1, stderr: 'keeper has no grant to change statusLine.\n' } })
  const update = (mod: string, values: Record<string, unknown>) => tested.fire('cmod.call', { to: 'cmod', method: 'updateSettings', input: { mod, source: 'project', project: '/work/app', values } })

  expect(await update('notes', { cleanupPeriodDays: 365 })).toEqual({ value: null })
  expect(await update('keeper', { statusLine: null })).toEqual({ deny: 'cmod: keeper has no grant to change statusLine.' })

  expect(spawned.slice(1)).toEqual([
    ['cmod', 'settings', 'notes', 'project', '{"cleanupPeriodDays":365}', '--project', '/work/app'],
    ['cmod', 'settings', 'keeper', 'project', '{"statusLine":null}', '--project', '/work/app'],
  ])
})

test('forkParent names the session whose last turn ended on this conversation, and null for a new conversation', async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  const forkParent = () => tested.fire('cmod.call', { to: 'cmod', method: 'forkParent', input: null })
  const conversation = [
    { role: 'user' as const, text: 'fix the failing test', toolUses: [] },
    { role: 'assistant' as const, text: 'Fixed it.', toolUses: [] },
  ]
  tested.fakes.session.messages = async () => []
  expect(await forkParent()).toEqual({ value: null })

  tested.fakes.session.messages = (async () => conversation) as unknown as Claude['session']['messages']
  await tested.fire('Stop', { stop_hook_active: false })
  await settled()
  await tested.fire('SessionStart', { source: 'fork', session_id: 'forked-elsewhere' })

  expect(await forkParent()).toEqual({ value: 'test-session' })
})
