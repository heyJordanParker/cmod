import { expect, test } from 'bun:test'
import type { EngineCreateResult, On } from 'claude-code'
import { testMod } from '../node_modules/cmod-sdk/testing.js'
import { register } from '../hooks/register.js'
import { cmodPlugin } from '../src/mod.js'
import type { Cmod } from '../types/index.js'

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

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

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

test('the CMod plugin tears down only keys removed from user settings', async () => {
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

test('cmod.call denies a call no mod takes with the install command', async () => {
  const hooks = new Map<string, (...args: unknown[]) => Promise<EngineCreateResult>>()
  const on = (event: string, hook: (...args: unknown[]) => Promise<EngineCreateResult>) => void hooks.set(event, hook)
  register(on as unknown as On, {})

  const built = (await hooks.get('engine.create')?.({}, { plugins: ['cmod'] }, async () => ({}))) as { cmod: Cmod }

  expect(await built.cmod.call({ to: 'tracer', method: 'signatures', input: { path: 'src/a.ts' } })).toEqual({ deny: 'tracer is not installed. Run cmod install tracer.' })
})
