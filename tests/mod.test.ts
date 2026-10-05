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

test('a removed enabledPlugins key runs cmod teardown --events with that plugin\'s name, and done shows "<name> is uninstalled"', async () => {
  const { tested, teardowns } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true }, { 'four-step': { exitCode: 0, stdout: 'progress 1 1 Removing the alias\ndone four-step\n', stderr: '' } })
  await tested.fire('UserPromptSubmit', { prompt: 'hello' })
  await settled()
  expect(teardowns).toEqual(['cmod teardown four-step --events'])
  expect(tested.shown.toasts).toEqual(['cmod is ready', 'four-step is uninstalled'])
  expect(tested.state.global.installedPlugins).toEqual(['cmod'])
})

test('the CMod plugin tears down only keys removed from user settings', async () => {
  const user = { 'cmod@fixtures': true, 'four-step@fixtures': true }
  const { tested, teardowns } = testRemovals(['cmod', 'four-step'], user, {}, { 'cmod@fixtures': true, 'project-mod@team': true })
  await tested.fire('SessionStart', { source: 'startup' })
  await settled()
  expect(tested.calls).toContainEqual({ call: 'settings.read', args: [{ source: 'user' }] })
  expect(tested.calls).not.toContainEqual({ call: 'settings.read', args: [] })
  expect(teardowns).toEqual([])
  expect(tested.state.global.installedPlugins).toEqual(['cmod', 'four-step'])
})

test('a key set to false runs nothing', async () => {
  const { tested, teardowns } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true, 'four-step@fixtures': false })
  await tested.fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1' })
  await settled()
  expect(teardowns).toEqual([])
  expect(tested.state.global.installedPlugins).toEqual(['cmod', 'four-step'])
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
})

test('a failed teardown shows the error its failed event names', async () => {
  const { tested } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true }, { 'four-step': { exitCode: 1, stdout: 'log removing the alias\nfailed 2\tzsh: no such file: ~/.zshrc.d/four-step\n', stderr: '' } })
  await tested.fire('UserPromptSubmit', { prompt: 'hello' })
  await settled()
  expect(tested.shown.toasts).toEqual(['cmod is ready', 'cmod teardown four-step exited 1: zsh: no such file: ~/.zshrc.d/four-step'])
})

test('a teardown that fails before any event shows its last line of standard error', async () => {
  const { tested } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true }, { 'four-step': { exitCode: 1, stdout: '', stderr: 'cmod teardown: records/four-step.json is not JSON\n' } })
  await tested.fire('UserPromptSubmit', { prompt: 'hello' })
  await settled()
  expect(tested.shown.toasts).toEqual(['cmod is ready', 'cmod teardown four-step exited 1: cmod teardown: records/four-step.json is not JSON'])
})

test('cmod.call answers missing when no mod takes the call', async () => {
  const hooks = new Map<string, (...args: unknown[]) => Promise<EngineCreateResult>>()
  const on = (event: string, hook: (...args: unknown[]) => Promise<EngineCreateResult>) => void hooks.set(event, hook)
  register(on as unknown as On, {})

  const built = (await hooks.get('engine.create')?.({}, { plugins: ['cmod'] }, async () => ({}))) as { cmod: Cmod }

  expect(await built.cmod.call({ to: 'tracer', method: 'signatures', input: { path: 'src/a.ts' } })).toEqual({ missing: 'tracer' })
})
