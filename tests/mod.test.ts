import { expect, test } from 'bun:test'
import type { EngineCreateResult, HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import { claudeCodeOf } from '../node_modules/@cmodjs/core/testing/claude-code.js'
import { findElement } from '../node_modules/@cmodjs/core/testing/fake-elements.js'
import type { Claude } from '../node_modules/@cmodjs/core/runtime/claude.js'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { register } from '../hooks/register.js'
import { cmodPlugin, type CmodPluginState } from '../src/mod.js'
import type { Cmod } from '../types/index.js'

declare const Bun: { sleep(ms: number): Promise<void> }

type Answer = { exitCode: number; stdout: string; stderr: string }

const cmodProgram = '/test/home/.local/share/cmod/programs/cmod'

function testRemovals(installedPlugins: readonly string[] | null, userPlugins: Record<string, boolean>, answers: Record<string, Answer> = {}, mergedPlugins: Record<string, boolean> = userPlugins) {
  const tested = testMod(cmodPlugin, { state: { global: { installedPlugins, areHotkeysBound: true } } })
  const teardowns: string[] = []
  tested.fakes.settings.read = async (args) => ({ enabledPlugins: args?.source === 'user' ? userPlugins : mergedPlugins })
  tested.fakes.process.run = async (argv) => {
    teardowns.push(argv.join(' '))
    const answer = answers[argv[2] ?? ''] ?? { exitCode: 0, stdout: `missing ${argv[2]}\n`, stderr: '' }
    return { ...answer, isStdoutTruncated: false, isStderrTruncated: false }
  }
  answerRules(tested, [{ linked: [], placed: [], removed: [], watched }])
  return { tested, teardowns }
}

const watched = ['/test/home/.claude/settings.json']

async function changeSettings(tested: ReturnType<typeof testMod>) {
  const { write } = tested.fakes.fs
  if (write === undefined) throw new Error('The test kit fakes no fs.write.')
  await write('/test/home/.claude/settings.json', '{}')
}

async function prompt(tested: ReturnType<typeof testMod>, text: string) {
  await claudeCodeOf(tested).fire('prompt.submit', { text, origin: { kind: 'composer' } } as never, { turnId: `turn-${text}` } as never)
  const appended = { uuid: `prompt-${text}`, door: 'user', origin: { kind: 'composer' }, message: { type: 'user', content: [{ type: 'text', text }] } }
  await claudeCodeOf(tested).fire('session.append', appended as never, appended as never)
}

type Synced = { linked: { mod: string; folder: string; rules: { name: string; isGlobal: boolean; text: string }[] }[]; placed: string[]; removed: string[]; watched: string[] }

function answerRules(tested: ReturnType<typeof testMod>, answers: Synced[]): { readonly runs: number } {
  const counted = { runs: 0 }
  tested.fakes.process.spawn = (request) => {
    const isRules = request.argv[1] === 'rules'
    if (isRules) counted.runs += 1
    const answer = !isRules ? [] : answers.length > 1 ? answers.shift() : answers[0]
    async function* read(): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
      yield { stream: 'stdout', text: `${JSON.stringify(answer)}\n` }
      return { code: 0, signal: null }
    }
    return Object.assign(read(), { result: Promise.resolve({ code: 0, signal: null }) }) as HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  }
  return counted
}

const cmodNote = (text: string) => `<cmod_mod>\n${text}\n</cmod_mod>`

const appendedNotes = (tested: ReturnType<typeof testMod>) => tested.calls.filter((call) => call.call === 'session.append').map((call) => (call.args[0] as { message: { content: { text: string }[] } }).message.content[0]?.text)

test("a mod's global rules linked after Claude Code started reach Claude as one note, and a later unlink says they no longer apply", async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  const rules = [
    { name: 'tests', isGlobal: true, text: 'Write a test before each fix.' },
    { name: 'sql', isGlobal: false, text: 'Quote every identifier.' },
  ]
  const linked = { linked: [{ mod: 'house-style', folder: '/test/home/.claude/rules/house-style', rules }], placed: ['house-style'], removed: [], watched }
  const rulesRuns = answerRules(tested, [linked, { linked: [], placed: [], removed: ['house-style'], watched }])

  const started = (await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })) as { readonly additionalContext?: readonly string[] }
  await settled()

  await prompt(tested, 'hello')

  expect(started.additionalContext).toEqual([cmodNote('The house-style mod adds these rules from now on:\n\nWrite a test before each fix.')])
  expect(appendedNotes(tested)).toEqual([])
  expect(rulesRuns.runs).toBe(1)

  await changeSettings(tested)
  await prompt(tested, 'again')
  await settled()

  expect(appendedNotes(tested)).toEqual([cmodNote("The house-style mod's rules no longer apply.")])
  expect(rulesRuns.runs).toBe(2)
})

test('a watched file that changes while cmod rules runs makes the next prompt run it again', async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  let changedAt = 0
  tested.fakes.fs.stat = async () => ({ kind: 'file', size: 2, mtimeMs: changedAt, isLink: false })
  const rulesRuns = answerRules(tested, [{ linked: [], placed: [], removed: [], watched }])

  changedAt = Date.now()
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await settled()
  expect(rulesRuns.runs).toBe(1)
  await prompt(tested, 'hello')
  await settled()

  expect(rulesRuns.runs).toBe(2)
})

test('a rule taken out of a mod that stays linked is withdrawn by a note, and its other rules keep applying', async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  const linked = (rules: { name: string; isGlobal: boolean; text: string }[], placed: string[]) => ({ linked: [{ mod: 'house-style', folder: '/test/home/.claude/rules/house-style', rules }], placed, removed: [], watched })
  const tests = { name: 'tests', isGlobal: true, text: 'Write a test before each fix.' }
  const old = { name: 'old-api', isGlobal: true, text: 'Use the old API.' }
  answerRules(tested, [linked([tests, old], ['house-style']), linked([tests], [])])

  const started = (await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })) as { readonly additionalContext?: readonly string[] }
  await settled()
  await changeSettings(tested)
  await prompt(tested, 'hello')
  await settled()

  expect(started.additionalContext).toEqual([cmodNote('The house-style mod adds these rules from now on:\n\nWrite a test before each fix.\n\nUse the old API.')])
  expect(appendedNotes(tested)).toEqual([cmodNote('These rules of the house-style mod no longer apply:\n\nUse the old API.')])
})

const settled = () => Bun.sleep(0)

const ready = { type: 'success', message: 'Installed', description: 'Adds the Sidebar pane and /mods.\nInstalled the cmod program.\nBinds ctrl+q to Show or hide the Sidebar.\nBinds meta+s to Show or hide Settings.\nRun cmod on your computer.\nRead your Claude Code conversations.\nAdd text Claude reads and start turns.' } as const

const uninstalled = { type: 'success', message: 'four-step is uninstalled' } as const

test("a removed enabledPlugins key runs cmod teardown --events with that plugin's name, and the uninstall toast tells the user to reload", async () => {
  const { tested, teardowns } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true }, { 'four-step': { exitCode: 0, stdout: 'progress 1 1 Removing the alias\ndone four-step\n', stderr: '' } })
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await prompt(tested, 'hello')
  await settled()
  expect(teardowns).toEqual([`${cmodProgram} teardown four-step --events`])
  expect(tested.shown.toasts).toEqual([ready, uninstalled])
  expect(tested.state.global.installedPlugins).toEqual(['cmod'])
})

test('a removal noticed at session start runs its teardown and toasts that it is uninstalled', async () => {
  const { tested, teardowns } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true }, { 'four-step': { exitCode: 0, stdout: 'done four-step\n', stderr: '' } })
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await settled()
  expect(teardowns).toEqual([`${cmodProgram} teardown four-step --events`])
  expect(tested.shown.toasts).toEqual([ready, uninstalled])
})

test('the cmod plugin tears down only keys removed from user settings', async () => {
  const user = { 'cmod@fixtures': true, 'four-step@fixtures': true }
  const { tested, teardowns } = testRemovals(['cmod', 'four-step'], user, {}, { 'cmod@fixtures': true, 'project-mod@team': true })
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await settled()
  expect(teardowns).toEqual([])
  expect(tested.state.global.installedPlugins).toEqual(['cmod', 'four-step'])
})

test('a key set to false runs nothing', async () => {
  const { tested, teardowns } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true, 'four-step@fixtures': false })
  await prompt(tested, 'hello')
  await settled()
  expect(teardowns).toEqual([])
  expect(tested.state.global.installedPlugins).toEqual(['cmod', 'four-step'])
})

test('a tool call reads no settings and tears nothing down', async () => {
  const { tested, teardowns } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true })
  await claudeCodeOf(tested).fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_use_id: 'toolu_0' })
  await settled()
  const readsBefore = tested.calls.filter((call) => call.call === 'settings.read').length
  await claudeCodeOf(tested).fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1' })
  await settled()
  expect(tested.calls.filter((call) => call.call === 'settings.read')).toHaveLength(readsBefore)
  expect(teardowns).toEqual([])
})

test('the first snapshot after install removes nothing', async () => {
  const { tested, teardowns } = testRemovals(null, { 'cmod@fixtures': true })
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await settled()
  expect(teardowns).toEqual([])
  expect(tested.state.global.installedPlugins).toEqual(['cmod'])
})

test('a removed plugin that is not a cmod mod answers missing and shows nothing', async () => {
  const { tested, teardowns } = testRemovals(['cmod', 'other-plugin'], { 'cmod@fixtures': true })
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await prompt(tested, 'hello')
  await settled()
  expect(teardowns).toEqual([`${cmodProgram} teardown other-plugin --events`])
  expect(tested.shown.toasts).toEqual([ready])
  expect(tested.state.global.installedPlugins).toEqual(['cmod'])
})

test('a failed removal is not retried in the next session and its toast names the fix', async () => {
  const message = 'The uninstall step of four-step exited 2: zsh: no such file: ~/.zshrc.d/four-step. Fix ~/.local/share/cmod/uninstall/four-step/uninstall.sh, then run cmod teardown four-step.'
  const failed = { 'four-step': { exitCode: 1, stdout: `log removing the alias\nfailed 2\t${message}\n`, stderr: '' } }
  const { tested } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true }, failed)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await prompt(tested, 'hello')
  await settled()
  expect(tested.shown.toasts).toEqual([ready, { type: 'error', message: 'Could not uninstall four-step', description: message }])

  const next = testRemovals(tested.state.global.installedPlugins, { 'cmod@fixtures': true }, failed)
  await claudeCodeOf(next.tested).fire('SessionStart', { source: 'startup' })
  await settled()
  expect(next.teardowns).toEqual([])
  expect(next.tested.shown.toasts).toEqual([ready])
})

test('a removal interrupted before its teardown answers is torn down by the next session', async () => {
  const interrupted = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true })
  interrupted.tested.fakes.process.run = () => new Promise(() => {})
  await claudeCodeOf(interrupted.tested).fire('SessionStart', { source: 'startup' })
  await settled()
  expect(interrupted.tested.state.global.installedPlugins).toEqual(['cmod', 'four-step'])

  const next = testRemovals(interrupted.tested.state.global.installedPlugins, { 'cmod@fixtures': true }, { 'four-step': { exitCode: 0, stdout: 'done four-step\n', stderr: '' } })
  await claudeCodeOf(next.tested).fire('SessionStart', { source: 'startup' })
  await settled()
  expect(next.teardowns).toEqual([`${cmodProgram} teardown four-step --events`])
  expect(next.tested.state.global.installedPlugins).toEqual(['cmod'])
})

test('a prompt while a removal is pending starts no second teardown in the same session', async () => {
  const { tested, teardowns } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true })
  tested.fakes.process.run = (argv) => {
    teardowns.push(argv.join(' '))
    return new Promise(() => {})
  }
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await prompt(tested, 'hello')
  await settled()
  expect(teardowns).toEqual([`${cmodProgram} teardown four-step --events`])
})

test('a teardown that fails before any event shows its last line of standard error', async () => {
  const { tested } = testRemovals(['cmod', 'four-step'], { 'cmod@fixtures': true }, { 'four-step': { exitCode: 1, stdout: '', stderr: 'cmod teardown: records/four-step.json is not JSON\n' } })
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await prompt(tested, 'hello')
  await settled()
  expect(tested.shown.toasts).toEqual([ready, { type: 'error', message: 'Could not uninstall four-step', description: 'cmod teardown exited 1: records/four-step.json is not JSON' }])
})

const store = '/test/home/.local/share/cmod'

const bound = { global: { installedPlugins: [], areHotkeysBound: true } }

function testSettings(files: Readonly<Record<string, string>> = {}) {
  const tested = testMod(cmodPlugin, {
    state: bound,
    files: {
      [`${store}/records/ci-watch.json`]: JSON.stringify({ name: 'ci-watch', version: '0.2.0', root: '/plugins/ci-watch', installedAt: '', scriptsSha256: '', uninstall: null, program: null, keys: { 'ctrl+l': 'ci-watch--runs' } }),
      [`${store}/consent.json`]: JSON.stringify({ 'ci-watch': ['network:api.github.com'] }),
      '/test/home/.claude/keybindings.json': JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'ctrl+l': 'command:ci-watch--runs' } }] }),
      '/plugins/ci-watch/package.json': JSON.stringify({ cmod: { permissions: { network: ['api.github.com'], model: true }, hotkeys: { runs: { title: 'Show the runs', default: 'ctrl+l' } } } }),
      '/plugins/ci-watch/.claude-plugin/plugin.json': JSON.stringify({ name: 'ci-watch', version: '0.2.0', description: 'Tells you when CI fails on your branch' }),
      ...files,
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
    if (input.method === 'cmod:pendingSteps') return called.includes('ci-watch cmod:finishSteps') ? [] : ['Sign in to GitHub']
    if (input.method === 'cmod:draw') return { draw: 1, tree: { $cmodElement: 'Text', props: { children: 'last run passed' } } }
    return null
  }
  const declare = (pages: readonly unknown[]) => tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input: { parts: { widgets: [], pages } }, caller: 'ci-watch' } as never)
  const shown = async () => (await tested.shown.pane.lines()).join('\n')
  return { tested, ran, called, declare, shown }
}

test("Settings lists each set-up mod with its Settings pages, options, permissions, and hotkeys, and the Sidebar's tabs", async () => {
  const { tested, declare, shown } = testSettings()
  await tested.start()
  await declare([{ id: 'runs', title: 'Runs', place: 'settings' }])

  await tested.type('/mods ci-watch')
  await tested.settle()
  await shown()
  await tested.settle()
  const page = await shown()
  await tested.shown.pane.press('section:options')
  const options = await shown()
  await tested.shown.pane.press('section:permissions')
  const permissions = await shown()
  await tested.shown.pane.press('section:hotkeys')
  const hotkeys = await shown()

  expect(tested.shown.pane.id).toBe('sidebar')
  expect(page).toContain('0: Dashboard')
  expect(page).toContain('Settings')
  expect(page).toContain('ci-watch 0.2.0')
  expect(page).toContain('Tells you when CI fails on your branch')
  expect(page).not.toContain('Off:')
  expect(page).toContain('last run passed')
  expect(options).toContain('Branch')
  expect(permissions).toContain('[x] Connect to api.github.com')
  expect(permissions).toContain('[ ] Ask a model, which uses your plan')
  expect(hotkeys).toContain('Show the runs  ctrl+l')
})

const changelog = '# Changelog\n\n## [Unreleased]\n\n- Watches merge queues.\n\n## [0.2.0] - 2026-10-13\n\n### Added\n- CI failures on your branch.\n\n## [0.1.0] - 2026-09-30\n\n- First release.\n'

const openChangelog = (tested: ReturnType<typeof testMod>, caller = 'ci-watch') => tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input: { requests: [{ settings: true, tab: 'changelog' }] }, caller } as never)

test("a mod's Changelog button opens Settings at its installed version, one block per version", async () => {
  const { tested, shown } = testSettings({ '/plugins/ci-watch/CHANGELOG.md': changelog })
  await tested.start()

  await openChangelog(tested)
  await tested.settle()
  const page = await shown()

  expect(page).toContain('0.2.0 · 2026-10-13 · installed')
  expect(page).toContain('CI failures on your branch.')
  expect(page).toContain('Unreleased')
  expect(page).toContain('0.1.0 · 2026-09-30')
  expect(tested.calls.filter((call) => call.call === 'ui.scroll').map((call) => call.args[0])).toEqual([{ to: { key: 'changelog:0.2.0' }, in: 'sidebar', block: 'start' }])
})

test('Settings shows no Changelog section for a mod without CHANGELOG.md', async () => {
  const { tested, shown } = testSettings()

  await tested.type('/mods ci-watch')
  await tested.settle()

  expect(await shown()).not.toContain('Changelog')
})

test('a checkout whose version has no changelog section yet opens the Changelog at Unreleased', async () => {
  const { tested } = testSettings({ '/plugins/ci-watch/CHANGELOG.md': changelog.replace('## [0.2.0] - 2026-10-13', '## [0.1.5] - 2026-10-01') })
  await tested.start()

  await openChangelog(tested)
  await tested.settle()

  expect(tested.calls.filter((call) => call.call === 'ui.scroll').map((call) => call.args[0])).toEqual([{ to: { key: 'changelog:Unreleased' }, in: 'sidebar', block: 'start' }])
})

test('a permission toggle runs cmod permission, an option saves through cmod option, and a combo binds through cmod hotkey', async () => {
  const { tested, ran } = testSettings()
  await tested.type('/mods ci-watch')
  await tested.settle()

  await tested.shown.pane.input('option:ci-watch.branch', 'release')
  await tested.shown.pane.press('section:permissions')
  await tested.shown.pane.press('permission:model')
  await tested.shown.pane.press('section:hotkeys')
  await tested.shown.pane.input('hotkey:runs', 'ctrl+shift+r')
  await tested.settle()

  expect(ran).toEqual([`${cmodProgram} option ci-watch branch release`, `${cmodProgram} permission ci-watch model on`, `${cmodProgram} hotkey ci-watch runs ctrl+shift+r`])
})

test('Settings marks a mod turned off in Claude Code, and Turn on runs cmod enable', async () => {
  const { tested, ran, shown } = testSettings()
  tested.fakes.settings.read = async () => ({ enabledPlugins: { 'ci-watch@ci-watch': false } })

  await tested.type('/mods ci-watch')
  await tested.settle()
  const lines = await shown()
  await tested.shown.pane.press('turn')
  await tested.settle()

  expect(lines).toContain('ci-watch (off)')
  expect(lines).toContain('Off: Claude Code does not load it.')
  expect(lines).toContain('Turn on')
  expect(ran).toEqual([`${cmodProgram} enable ci-watch`])
  expect((await shown()).replace(/\s+/g, ' ')).toContain('Turned ci-watch on.')
})

test('Turn off runs cmod disable on a mod that is on', async () => {
  const { tested, ran } = testSettings()
  await tested.type('/mods ci-watch')
  await tested.settle()

  await tested.shown.pane.press('turn')
  await tested.settle()

  expect(ran).toEqual([`${cmodProgram} disable ci-watch`])
})

test('Remove asks first, and Remove again runs cmod remove', async () => {
  const { tested, ran, shown } = testSettings()
  await tested.type('/mods ci-watch')
  await tested.settle()

  await tested.shown.pane.press('remove')
  const asked = await shown()
  await tested.shown.pane.press('keep')
  const kept = await shown()
  await tested.shown.pane.press('remove')
  await tested.shown.pane.press('remove-confirmed')
  await tested.settle()

  expect(asked.replace(/\s+/g, ' ')).toContain('Remove ci-watch? Its uninstall step runs, and Claude Code deletes it.')
  expect(kept).not.toContain('Remove ci-watch?')
  expect(ran).toEqual([`${cmodProgram} remove ci-watch`])
  expect((await shown()).replace(/\s+/g, ' ')).toContain('Removed ci-watch.')
})

test('Settings shows the installer steps a mod still needs, and Finish setup runs them', async () => {
  const { tested, called, shown } = testSettings()
  await tested.type('/mods ci-watch')
  await tested.settle()
  expect(await shown()).toContain('Needs setup: Sign in to GitHub')

  await tested.shown.pane.press('finish')
  await tested.settle()

  expect(called).toContain('ci-watch cmod:finishSteps')
  expect(await shown()).not.toContain('Needs setup')
})

test("a mod's page opens as a Sidebar tab with its number, the × closes it, and the last close hides the Sidebar", async () => {
  const { tested, called, declare, shown } = testSettings()
  await tested.start()
  await declare([{ id: 'runs', title: 'Runs', place: 'sidebar' }])

  await tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input: { requests: [{ open: 'runs', params: { run: 42 } }] }, caller: 'ci-watch' } as never)
  await tested.settle()
  await shown()
  await tested.settle()
  const page = await shown()
  await tested.shown.pane.press('close:ci-watch/runs')
  await tested.settle()

  expect(page).toContain('1: Runs')
  expect(page).toContain('last run passed')
  expect(called).toContain('ci-watch cmod:shown')
  expect(tested.shown.openPanes.has('sidebar')).toBe(false)
})

test("a Sidebar page keeps its last drawing while its mod draws the next one after a state change", async () => {
  const tested = testMod(cmodPlugin, {
    state: bound,
    files: {
      [`${store}/records/ci-watch.json`]: JSON.stringify({ name: 'ci-watch', version: '0.2.0', root: '/plugins/ci-watch', installedAt: '', scriptsSha256: '', uninstall: null, program: null, keys: {} }),
      '/plugins/ci-watch/package.json': JSON.stringify({ cmod: {} }),
      '/plugins/ci-watch/.claude-plugin/plugin.json': JSON.stringify({ name: 'ci-watch', version: '0.2.0' }),
    },
  })
  tested.fakes.settings.read = async () => ({ enabledPlugins: { 'ci-watch@ci-watch': true } })
  let draws = 0
  let finish = () => {}
  const drawing = new Promise<void>((resolve) => (finish = resolve))
  tested.fakes.cmod.call = async (input) => {
    if (input.method !== 'cmod:draw') return null
    draws += 1
    if (draws > 1) await drawing
    return { draw: draws, tree: { $cmodElement: 'Text', props: { children: `runs body ${draws}` } } }
  }
  await tested.start()
  const changed = (input: object) => tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input, caller: 'ci-watch' } as never)
  await changed({ parts: { widgets: [], pages: [{ id: 'runs', title: 'Runs', place: 'sidebar' }] } })
  await changed({ requests: [{ open: 'runs' }] })
  await tested.settle()
  await tested.shown.pane.lines()
  await tested.settle()

  await changed({ redraw: true })
  const whileDrawing = await tested.shown.pane.lines()
  finish()
  await tested.settle()

  expect(whileDrawing).toContain('runs body 1')
  expect(await tested.shown.pane.lines()).toContain('runs body 2')
})

test('a page request of a kind this cmod does not know, from a mod on a newer @cmodjs/core, opens nothing', async () => {
  const tested = testMod(cmodPlugin, { state: bound })
  await tested.start()
  await tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input: { requests: [{ pin: 'runs' }] }, caller: 'ci-watch' } as never)
  await tested.settle()

  expect(tested.shown.debug.join('\n')).toContain('ci-watch sent a page request this cmod does not know, so it skips it: {"pin":"runs"}')
  expect(tested.state.session.shown).not.toBe('settings')
})

test("a mod's Settings page opens inside Settings, not as a Sidebar tab, and the mod hears it shown", async () => {
  const { tested, declare, shown } = testSettings()
  const told: unknown[] = []
  const answer = tested.fakes.cmod.call
  tested.fakes.cmod.call = async (input) => {
    if (input.method === 'cmod:shown') told.push(input.input)
    return answer?.(input)
  }
  await tested.start()
  await declare([{ id: 'runs', title: 'Runs', place: 'settings' }])

  await tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input: { requests: [{ open: 'runs' }] }, caller: 'ci-watch' } as never)
  await tested.settle()
  await shown()
  await tested.settle()
  const page = await shown()

  expect(page).not.toContain('1: Runs')
  expect(page).toContain('ci-watch 0.2.0')
  expect(page).toContain('last run passed')
  expect(told).toContainEqual({ open: [], shown: 'runs', isFocused: true })
})

test("picking another mod in Settings draws that mod's page without the last mod's params, and tells it the page it shows", async () => {
  const record = (name: string) => JSON.stringify({ name, version: '0.2.0', root: `/plugins/${name}`, installedAt: '', scriptsSha256: '', uninstall: null, program: null, keys: {} })
  const tested = testMod(cmodPlugin, {
    state: { global: { installedPlugins: [], areHotkeysBound: true } },
    files: {
      [`${store}/records/ci-watch.json`]: record('ci-watch'),
      [`${store}/records/deploys.json`]: record('deploys'),
      '/plugins/ci-watch/package.json': JSON.stringify({ cmod: {} }),
      '/plugins/ci-watch/.claude-plugin/plugin.json': JSON.stringify({ name: 'ci-watch', version: '0.2.0' }),
      '/plugins/deploys/package.json': JSON.stringify({ cmod: {} }),
      '/plugins/deploys/.claude-plugin/plugin.json': JSON.stringify({ name: 'deploys', version: '0.2.0' }),
    },
  })
  tested.fakes.settings.read = async () => ({ enabledPlugins: {} })
  tested.fakes.config.list = async () => []
  const draws: unknown[] = []
  const told: unknown[] = []
  tested.fakes.cmod.call = async (input) => {
    if (input.method === 'cmod:draw') {
      draws.push({ to: input.to, ...(input.input as object) })
      return { draw: draws.length, tree: { $cmodElement: 'Text', props: { children: `${input.to} body` } } }
    }
    if (input.method === 'cmod:shown') told.push({ to: input.to, ...(input.input as object) })
    return null
  }
  await tested.start()
  const fire = (caller: string, input: object) => tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input, caller } as never)
  await fire('ci-watch', { parts: { widgets: [], pages: [{ id: 'runs', title: 'Runs', place: 'settings' }] } })
  await fire('deploys', { parts: { widgets: [], pages: [{ id: 'queue', title: 'Queue', place: 'settings' }] } })
  await fire('ci-watch', { requests: [{ open: 'runs', params: { run: 7 } }] })
  await tested.settle()
  await tested.shown.pane.lines()
  await tested.settle()
  draws.length = 0
  told.length = 0

  await tested.shown.pane.press('mod:deploys')
  await tested.settle()
  await tested.shown.pane.lines()
  await tested.settle()

  expect(draws).toContainEqual(expect.objectContaining({ to: 'deploys', page: 'queue', params: null }))
  expect(told).toContainEqual(expect.objectContaining({ to: 'deploys', shown: 'queue' }))
  expect(told).not.toContainEqual(expect.objectContaining({ to: 'deploys', shown: 'runs' }))
})

test("a mod's Settings page draws with the params it opened with, and closing it leaves the page", async () => {
  const { tested, declare, called } = testSettings()
  const draws: unknown[] = []
  const answer = tested.fakes.cmod.call
  tested.fakes.cmod.call = async (input) => {
    if (input.method === 'cmod:draw') draws.push(input.input)
    return answer?.(input)
  }
  await tested.start()
  await declare([{ id: 'runs', title: 'Runs', place: 'settings' }])
  const request = (requests: readonly object[]) => tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input: { requests }, caller: 'ci-watch' } as never)

  await request([{ open: 'runs', params: { run: 7 } }])
  await tested.settle()
  await tested.shown.pane.lines()
  await tested.settle()
  await request([{ close: 'runs' }])
  await tested.settle()

  expect(draws).toContainEqual(expect.objectContaining({ page: 'runs', params: { run: 7 } }))
  expect(tested.state.session.section).not.toBe('page:runs')
  expect(called).toContain('ci-watch cmod:shown')
})

test('a start whose hotkey bind fails tries again at the next start', async () => {
  const tested = testMod(cmodPlugin, { state: { global: { installedPlugins: [] } } })
  tested.fakes.process.run = async (argv) => ({ exitCode: argv[1] === 'hotkey' ? 2 : 0, stdout: '', stderr: 'cmod: unknown command hotkey', isStdoutTruncated: false, isStderrTruncated: false })

  await tested.start()

  expect(tested.state.global.areHotkeysBound).toBe(false)
  expect(tested.shown.toasts.map(({ message }) => message)).toContain('Could not bind ctrl+q to Show or hide the Sidebar')
})

test('on its first start cmod binds its own hotkeys, ctrl+q for the Sidebar and meta+s for Settings, and never again', async () => {
  const tested = testMod(cmodPlugin, { state: { global: { installedPlugins: [] } } })
  const ran: string[] = []
  tested.fakes.process.run = async (argv) => (ran.push(argv.join(' ')), { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  await tested.start()

  expect(ran).toEqual([`${cmodProgram} hotkey cmod sidebar ctrl+q`, `${cmodProgram} hotkey cmod settings meta+s`])
  expect(tested.state.global.areHotkeysBound).toBe(true)
  expect(tested.shown.commands).toEqual(expect.arrayContaining(['cmod--sidebar', 'cmod--settings', 'mods']))
})

test('the Sidebar hotkey shows the Dashboard, and the Settings hotkey switches to Settings, then hides it', async () => {
  const tested = testMod(cmodPlugin, { state: bound, files: { '/test/plugins/cmod/package.json': JSON.stringify({ cmod: { hotkeys: cmodPlugin.hotkeys } }) } })

  await tested.hotkey('sidebar')
  const dashboard = (await tested.shown.pane.lines()).join('\n')
  await tested.hotkey('settings')
  await tested.shown.pane.lines()
  await tested.settle()
  const settings = (await tested.shown.pane.lines()).join('\n')
  await tested.hotkey('settings')

  expect(dashboard).toContain('No widget is on the Dashboard yet.')
  expect(settings).toContain('▸ cmod')
  expect(settings).toContain('Show or hide the Sidebar')
  expect(tested.shown.openPanes.has('sidebar')).toBe(false)
})

test('cmod.call denies a call no mod takes with the install command', async () => {
  const hooks = new Map<string, (...args: unknown[]) => Promise<EngineCreateResult>>()
  const on = (event: string, hook: (...args: unknown[]) => Promise<EngineCreateResult>) => {
    hooks.set(event, hook)
    return { catch: () => undefined }
  }
  register(on, {})

  const built = (await hooks.get('engine.create')?.({}, { plugins: ['cmod'] }, async () => ({}))) as { cmod: Cmod }

  expect(await built.cmod.call({ to: 'tracer', method: 'signatures', input: { path: 'src/a.ts' } })).toEqual({ deny: 'tracer is not installed. Install it in Plugins.' })
})

const readingConsent = { [`${store}/consent.json`]: JSON.stringify({ recall: ['conversation'], notes: ['prompt'] }) }

function cmodAnswering(answers: Record<string, { code: number; stdout?: string; stderr?: string }>, files: Record<string, string> = readingConsent) {
  const tested = testMod(cmodPlugin, { state: { global: { installedPlugins: ['cmod'], areHotkeysBound: true } }, files, projectRoot: '/work/app' })
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

const askCmod = (tested: ReturnType<typeof cmodAnswering>['tested'], caller: string, method: string, input: unknown) => tested.fire('cmod.call', { to: 'cmod', method, input, caller } as never)

test("the sessions service runs cmod history in this session with each request as flags for a mod that may read conversations, and the session start indexes them", async () => {
  const session = { id: 's1', title: 'Rename the tree pane', project: '/work/app', cwd: '/work/app', model: 'claude-opus-5-5', startedAt: '2026-10-11T10:00:00.000Z', lastAt: '2026-10-11T10:05:00.000Z', isRunning: false }
  const { tested, spawned, sessions } = cmodAnswering({ 'history sessions': { code: 0, stdout: `${JSON.stringify([session])}\n` }, 'history messages': { code: 0, stdout: '[]\n' }, 'history search': { code: 0, stdout: '[]\n' } })
  await tested.start()
  await tested.settle()

  expect(await askCmod(tested, 'recall', 'cmod:sessions', { since: '2026-10-09T00:00:00.000Z', everyProject: true, running: true })).toEqual({ value: [session] })
  expect(await askCmod(tested, 'recall', 'cmod:messages', { session: 's1', task: 'a7', after: 'm9', last: 5 })).toEqual({ value: [] })
  expect(await askCmod(tested, 'recall', 'cmod:search', { text: 'deploy', before: { session: 's1', id: 'm9' } })).toEqual({ value: [] })

  expect(spawned).toEqual([
    [cmodProgram, 'history', 'index'],
    [cmodProgram, 'history', 'sessions', '--since', '2026-10-09T00:00:00.000Z', '--all', '--running', '--json', '--project', '/work/app'],
    [cmodProgram, 'history', 'messages', 's1', '--task', 'a7', '--after', 'm9', '--last', '5', '--json', '--project', '/work/app'],
    [cmodProgram, 'history', 'search', 'deploy', '--before', 's1:m9', '--json', '--project', '/work/app'],
  ])
  expect(sessions).toEqual(['test-session', 'test-session', 'test-session', 'test-session'])
})

test('the sessions service refuses a mod without the conversation grant, and runs nothing for it', async () => {
  const { tested, spawned } = cmodAnswering({})
  await tested.start()
  await tested.settle()

  expect(await askCmod(tested, 'notes', 'cmod:sessions', {})).toEqual({ deny: 'notes reads your conversations without your grant. Turn it on in Settings.' })
  expect(spawned).toEqual([[cmodProgram, 'history', 'index']])
})

test("the session start builds no history index while no other mod reads conversations, whatever cmod's own grants say", async () => {
  const { tested, spawned } = cmodAnswering({}, { [`${store}/consent.json`]: JSON.stringify({ cmod: ['conversation'], notes: ['prompt'] }) })
  await tested.start()
  await tested.settle()

  expect(spawned).toEqual([])
})

test("the updateSettings call runs cmod settings for the mod, and a refusal comes back as the deny with cmod's last error line", async () => {
  const { tested, spawned } = cmodAnswering({ 'settings keeper': { code: 1, stderr: 'keeper has no grant to change statusLine.\n' } })
  const update = (mod: string, values: Record<string, unknown>) => tested.fire('cmod.call', { to: 'cmod', method: 'updateSettings', input: { mod, source: 'project', project: '/work/app', values } })

  expect(await update('notes', { cleanupPeriodDays: 365 })).toEqual({ value: null })
  expect(await update('keeper', { statusLine: null })).toEqual({ deny: 'cmod: keeper has no grant to change statusLine.' })

  expect(spawned.filter((argv) => argv[1] === 'settings')).toEqual([
    [cmodProgram, 'settings', 'notes', 'project', '{"cleanupPeriodDays":365}', '--project', '/work/app'],
    [cmodProgram, 'settings', 'keeper', 'project', '{"statusLine":null}', '--project', '/work/app'],
  ])
})

test("a read of this session's newest messages and turns answers from memory, and runs cmod history only for what memory lacks", async () => {
  const { tested, spawned } = cmodAnswering({ 'history messages': { code: 0, stdout: '[]\n' }, 'history turns': { code: 0, stdout: '[]\n' } })
  await tested.start()
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await prompt(tested, 'first')
  await prompt(tested, 'second')
  await tested.settle()
  const read = async (method: string, input: object) => ((await askCmod(tested, 'recall', method, { session: 'test-session', ...input })) as { value: { text?: string }[] }).value

  expect((await read('cmod:messages', { last: 1 })).map((message) => message.text)).toEqual(['second'])
  expect(await read('cmod:turns', { last: 1 })).toHaveLength(1)
  expect(spawned.filter((argv) => argv[1] === 'history' && argv[2] !== 'index')).toEqual([])

  await read('cmod:messages', { last: 50 })

  expect(spawned.filter((argv) => argv[1] === 'history' && argv[2] !== 'index')).toEqual([[cmodProgram, 'history', 'messages', 'test-session', '--last', '50', '--json', '--project', '/work/app']])
})

test('the cmod plugin keeps only the newest 200 messages of its session in memory, and reads older ones from the conversation index', async () => {
  const { tested, spawned } = cmodAnswering({ 'history messages': { code: 0, stdout: '[]\n' } })
  await tested.start()
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  for (let index = 0; index < 201; index += 1) await prompt(tested, `prompt ${index}`)
  await tested.settle()
  const read = async (input: object) => ((await askCmod(tested, 'recall', 'cmod:messages', { session: 'test-session', ...input })) as { value: { text?: string }[] }).value

  expect((await read({ last: 200 })).map((message) => message.text)).toEqual(Array.from({ length: 200 }, (_, index) => `prompt ${index + 1}`))
  expect(spawned.filter((argv) => argv[1] === 'history' && argv[2] !== 'index')).toEqual([])

  await read({ after: 'prompt-prompt 0' })

  expect(spawned.filter((argv) => argv[1] === 'history' && argv[2] !== 'index')).toHaveLength(1)
})

test('the cmod plugin answers every method a mod built on @cmodjs/core 4.0.0 calls on it', async () => {
  const { tested } = cmodAnswering({})
  await tested.start()
  const methods = ['cmod:sessions', 'cmod:search', 'cmod:messages', 'cmod:turns', 'cmod:contexts', 'cmod:tasks', 'cmod:goal', 'cmod:updateGoal', 'cmod:subscribe', 'cmod:watchBefore', 'cmod:act', 'cmod:partsChanged', 'forkParent', 'updateSettings']
  const refusal = async (method: string) => {
    const answer = await askCmod(tested, 'recall', method, {}).catch((error: unknown) => ({ deny: String(error) }))
    return (answer as { deny?: string }).deny ?? ''
  }

  expect(await refusal('cmod:unheard')).toContain('has no method')
  for (const method of methods) expect(await refusal(method)).not.toContain('has no method')
})

const installedPlugins = '/test/home/.claude/plugins/installed_plugins.json'

function pluginsListed(lists: readonly (readonly { name: string; version: string; state?: string; unsatisfied?: string[] }[])[], global: Partial<CmodPluginState['global']> = {}) {
  const tested = testMod(cmodPlugin, { state: { global: { installedPlugins: ['cmod'], areHotkeysBound: true, pluginsCheckedAt: null, ...global } }, files: { [installedPlugins]: '{}' } })
  const ticks: (() => void)[] = []
  tested.fakes.clock.every = (_ms, run) => (ticks.push(run), { cancel: () => undefined })
  const ran: string[] = []
  const answers = [...lists]
  tested.fakes.process.spawn = (request) => {
    ran.push(request.argv.slice(1).join(' '))
    const rows = request.argv[1] === 'list' ? (answers.length > 1 ? answers.shift() : answers[0]) : undefined
    const stdout = rows === undefined ? '' : `${JSON.stringify(rows.map((row) => ({ state: 'ready', unsatisfied: [], ...row })))}\n`
    async function* read(): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
      if (stdout !== '') yield { stream: 'stdout', text: stdout }
      return { code: 0, signal: null }
    }
    return Object.assign(read(), { result: Promise.resolve({ code: 0, signal: null }) }) as HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  }
  return { tested, ran, ticks }
}

const turnedOff = 'Claude Code turned it off: Requires "cmod@beta" >=4.0.3, installed 4.0.2'

test('the cmod plugin updates cmod when Claude Code turned a mod off for an older cmod, and the mod turns on', async () => {
  const { tested, ran } = pluginsListed([[{ name: 'cmod@beta', version: '4.0.2' }, { name: 'file-tree@beta', version: '0.1.0', state: turnedOff, unsatisfied: ['cmod@beta'] }], [{ name: 'cmod@beta', version: '4.0.3' }, { name: 'file-tree@beta', version: '0.1.0' }]])
  await tested.start()
  await tested.settle()

  expect(ran.filter((command) => !command.startsWith('rules'))).toEqual(['list --json', 'update cmod', 'list --json'])
  expect(tested.shown.toasts.filter((toast) => toast.type === 'error')).toEqual([])
  expect(tested.state.global.pluginsCheckedAt).toBe(0)
})

test('the cmod plugin updates every copy of cmod when two marketplaces hold different versions, because Claude Code loads only one', async () => {
  const { tested, ran } = pluginsListed([[{ name: 'cmod@alpha', version: '4.0.0' }, { name: 'cmod@beta', version: '4.0.2' }], [{ name: 'cmod@alpha', version: '4.0.2' }, { name: 'cmod@beta', version: '4.0.2' }]])
  await tested.start()
  await tested.settle()

  expect(ran.filter((command) => !command.startsWith('rules'))).toEqual(['list --json', 'update cmod', 'list --json'])
})

test('a mod the newest cmod still does not satisfy shows why Claude Code turned it off', async () => {
  const off = [{ name: 'cmod@beta', version: '4.0.2' }, { name: 'file-tree@beta', version: '0.1.0', state: turnedOff, unsatisfied: ['cmod@beta'] }]
  const { tested } = pluginsListed([off])
  await tested.start()
  await tested.settle()

  expect(tested.shown.toasts.filter((toast) => toast.type === 'error')).toEqual([{ type: 'error', message: 'file-tree@beta is off', description: turnedOff }])
})

test('an update that leaves a mod off runs once, whichever session checks next, and Retry runs it again', async () => {
  const off = [{ name: 'cmod@beta', version: '4.0.2' }, { name: 'file-tree@beta', version: '0.1.0', state: turnedOff, unsatisfied: ['cmod@beta'] }]
  const other = pluginsListed([off])
  await other.tested.start()
  await other.tested.settle()
  await other.tested.fakes.fs.write?.(installedPlugins, '{"file-tree@beta":[]}')
  for (const run of other.ticks) run()
  await other.tested.settle()

  expect(other.ran.filter((command) => !command.startsWith('rules'))).toEqual(['list --json', 'update cmod', 'list --json', 'list --json'])
  expect(other.tested.shown.toasts.filter((toast) => toast.type === 'error')).toEqual([{ type: 'error', message: 'file-tree@beta is off', description: turnedOff }])

  const toasts = await other.tested.fire('ui.render', { surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false }, viewport: { columns: 100, rows: 24 } } as never, { type: 'Text', children: ['>'] } as never)
  const retry = findElement(toasts, 'Button', 'Retry')
  if (retry === undefined) throw new Error('The off toast draws no Retry button.')
  await (retry['onPress'] as () => Promise<void>)()
  await other.tested.settle()

  expect(other.ran.filter((command) => !command.startsWith('rules'))).toEqual(['list --json', 'update cmod', 'list --json', 'list --json', 'list --json', 'update cmod', 'list --json'])
})

test('the off toast leaves once the next check finds every mod on', async () => {
  const off = [{ name: 'cmod@beta', version: '4.0.2' }, { name: 'file-tree@beta', version: '0.1.0', state: turnedOff, unsatisfied: ['cmod@beta'] }]
  const { tested, ticks } = pluginsListed([off, off, [{ name: 'cmod@beta', version: '4.0.3' }, { name: 'file-tree@beta', version: '0.1.0' }]])
  await tested.start()
  await tested.settle()
  await tested.fakes.fs.write?.(installedPlugins, '{"cmod@beta":[]}')
  for (const run of ticks) run()
  await tested.settle()

  expect(tested.shown.toasts.filter((toast) => toast.type === 'error')).toEqual([])
})

test('a plugin check that fails, such as when cmod cannot run Claude Code, runs again at the next start', async () => {
  const { tested } = pluginsListed([[{ name: 'cmod@beta', version: '4.0.2' }, { name: 'file-tree@beta', version: '0.1.0', state: turnedOff, unsatisfied: ['cmod@beta'] }]])
  tested.fakes.process.spawn = () => {
    async function* read(): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
      yield { stream: 'stderr', text: 'cmod list: claude is not on PATH. Install it, then run the command again.\n' }
      return { code: 1, signal: null }
    }
    return Object.assign(read(), { result: Promise.resolve({ code: 1, signal: null }) }) as HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  }
  await tested.start()
  await tested.settle()

  expect(tested.state.global.pluginsCheckedAt).toBeNull()
  expect(tested.shown.toasts.filter((toast) => toast.type === 'error').map((toast) => toast.message)).toEqual(['Could not update cmod for the mods that need a newer one'])
})

test('the cmod plugin reads the plugin list only after Claude Code changes its installed plugins, and updates nothing when every mod has the cmod it needs', async () => {
  const { tested, ran } = pluginsListed([[{ name: 'cmod@cmod', version: '4.0.0' }, { name: 'notes@cmod', version: '0.1.0' }]])
  await tested.start()
  await tested.settle()
  const checked = pluginsListed([[]], { pluginsCheckedAt: tested.state.global.pluginsCheckedAt })
  await checked.tested.start()
  await checked.tested.settle()

  expect(ran.filter((command) => !command.startsWith('rules'))).toEqual(['list --json'])
  expect(checked.ran.filter((command) => !command.startsWith('rules'))).toEqual([])
})

test('a mod Claude Code installs while cmod checks the plugin list is checked too', async () => {
  const healthy = [{ name: 'cmod@beta', version: '4.0.2' }]
  const off = [...healthy, { name: 'file-tree@beta', version: '0.1.0', state: turnedOff, unsatisfied: ['cmod@beta'] }]
  const { tested, ran } = pluginsListed([healthy, off, [{ name: 'cmod@beta', version: '4.0.3' }, { name: 'file-tree@beta', version: '0.1.0' }]])
  const listing = tested.fakes.process.spawn
  let isInstalled = false
  tested.fakes.process.spawn = (request) => {
    if (request.argv[1] === 'list' && !isInstalled) {
      isInstalled = true
      void tested.fakes.fs.write?.(installedPlugins, '{"file-tree@beta":[]}')
    }
    return listing?.(request) as ReturnType<NonNullable<typeof listing>>
  }
  await tested.start()
  await tested.settle()

  expect(ran.filter((command) => !command.startsWith('rules'))).toEqual(['list --json', 'list --json', 'update cmod', 'list --json'])
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
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await prompt(tested, 'hello')
  await claudeCodeOf(tested).fire('Stop', { stop_hook_active: false })
  while (tested.state.session.tip === null) await settled()
  await claudeCodeOf(tested).fire('SessionStart', { source: 'fork', session_id: 'forked-elsewhere' })

  expect(await forkParent()).toEqual({ value: 'test-session' })
})

function watchedStore(tested: ReturnType<typeof testMod>) {
  const timers: (() => void)[] = []
  const polls: (() => void)[] = []
  tested.fakes.clock.after = (_ms, fire) => (timers.push(fire), { cancel: () => undefined })
  tested.fakes.clock.every = (_ms, fire) => (polls.push(fire), { cancel: () => undefined })
  const tick = async () => {
    for (const poll of polls) poll()
    await settled()
    for (const fire of timers.splice(0)) fire()
    await settled()
  }
  return { tick }
}

test('a change cmod marks in its store reloads the plugins once, and the mark the session started with reloads nothing', async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  const changed = `${store}/plugins-changed`
  await tested.fakes.fs.write?.(changed, '1 100\n')
  const reloads: string[] = []
  tested.fakes.command.run = async ({ command }) => (reloads.push(command), {})
  const { tick } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })

  await tick()
  await tick()
  expect(reloads).toEqual([])

  await tested.fakes.fs.write?.(changed, '2 200\n')
  await tested.fakes.fs.write?.(changed, '3 300\n')
  await tick()

  expect(reloads).toEqual(['reload-plugins'])
})

test('a plugin Claude Code installs, updates, or turns on without cmod reloads the plugins, and other settings reload nothing', async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  await tested.fakes.fs.write?.(installedPlugins, JSON.stringify({ plugins: { 'hello@market': [{ version: '0.1.0' }] } }))
  const reloads: string[] = []
  tested.fakes.command.run = async ({ command }) => (reloads.push(command), {})
  const { tick } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tick()

  await tested.fakes.fs.write?.(installedPlugins, JSON.stringify({ plugins: { 'hello@market': [{ version: '0.2.0' }] } }))
  await tick()
  await tick()
  expect(reloads).toEqual(['reload-plugins'])

  await tested.fakes.fs.write?.('/test/home/.claude/settings.json', JSON.stringify({ model: 'opus' }))
  await tick()
  await tick()
  expect(reloads).toEqual(['reload-plugins'])

  tested.fakes.settings.read = async () => ({ enabledPlugins: { 'cmod@fixtures': true, 'hello@market': true } })
  await tested.fakes.fs.write?.('/test/home/.claude/settings.json', JSON.stringify({ model: 'opus', enabledPlugins: { 'hello@market': true } }))
  await tick()
  await tick()
  expect(reloads).toEqual(['reload-plugins', 'reload-plugins'])
})

test('a change cmod marks while a reload runs reloads once more after it', async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  const changed = `${store}/plugins-changed`
  const reloads: string[] = []
  let finish = () => {}
  tested.fakes.command.run = async ({ command }) => {
    reloads.push(command)
    if (reloads.length === 1) {
      await tested.fakes.fs.write?.(changed, '2 200\n')
      await new Promise<void>((resolve) => (finish = resolve))
    }
    return {}
  }
  const { tick } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tick()

  await tested.fakes.fs.write?.(changed, '1 100\n')
  await tick()
  await tick()
  finish()
  await tick()
  await tick()

  expect(reloads).toEqual(['reload-plugins', 'reload-plugins'])
})

test('a reload the session refuses waits for the next prompt, and a second refusal is shown', async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  const changed = `${store}/plugins-changed`
  const reloads: string[] = []
  let refusals = 1
  tested.fakes.command.run = async ({ command }) => {
    reloads.push(command)
    if (refusals > 0) {
      refusals -= 1
      throw new Error('the session was stopped and nobody has sent input since')
    }
    return {}
  }
  const { tick } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tick()
  const goOn = async (text: string) => {
    await prompt(tested, text)
    await tick()
  }

  await tested.fakes.fs.write?.(changed, '1 100\n')
  await tick()
  await tick()
  expect(reloads).toEqual(['reload-plugins'])
  expect(tested.shown.toasts.filter((toast) => toast.type === 'error')).toEqual([])

  await goOn('Go on')
  expect(reloads).toEqual(['reload-plugins', 'reload-plugins'])
  expect(tested.shown.toasts.filter((toast) => toast.type === 'error')).toEqual([])

  refusals = 2
  await tested.fakes.fs.write?.(changed, '2 200\n')
  await tick()
  await goOn('Keep going')
  expect(tested.shown.toasts.filter((toast) => toast.message === 'Could not reload the mods')).toHaveLength(1)
})
const gitWidgets = {
  'cmod:parts': () => ({ widgets: [{ id: 'branch', title: 'Branch', areas: ['belowPrompt', 'dashboard'] }], pages: [] }),
  'cmod:draw': (input: { readonly columns: number }) => ({ draw: 1, tree: { $cmodElement: 'Text', props: { children: `main, ${input.columns} columns` } } }),
}

test("the Sidebar's Dashboard shows the widgets the person moved onto it", async () => {
  const layout = { areas: { abovePrompt: [], belowPrompt: [], working: [], turnEnd: [], dashboard: [{ left: ['git/branch'], right: [] }] }, hidden: [] }
  const tested = testMod(cmodPlugin, { state: bound, files: { [`${store}/widgets.json`]: JSON.stringify(layout) }, dependencies: { git: gitWidgets } })

  await tested.hotkey('sidebar')
  await tested.shown.pane.lines()
  await tested.settle()

  expect(await tested.shown.pane.lines()).toEqual(['0: Dashboard  │  9: Settings', '', 'main, 80 columns'])
})

test('the Widgets section of cmod in Settings moves the picked widget, and hides it', async () => {
  type Row = { readonly left: readonly string[]; readonly right: readonly string[] }
  const layout: { readonly areas: Readonly<Record<string, readonly Row[]>>; readonly hidden: readonly string[] } = { areas: { abovePrompt: [], belowPrompt: [{ left: ['git/branch'], right: [] }], working: [], turnEnd: [], dashboard: [] }, hidden: [] }
  const tested = testMod(cmodPlugin, { state: bound, files: { [`${store}/widgets.json`]: JSON.stringify(layout) }, dependencies: { git: gitWidgets } })
  const saved = async () => JSON.parse((await tested.fakes.fs.read?.(`${store}/widgets.json`)) ?? '{}') as typeof layout
  await tested.type('/mods cmod')
  await tested.settle()
  await tested.shown.pane.press('section:widgets')
  await tested.settle()

  expect((await tested.shown.pane.lines()).join('\n')).toContain('Branch (git)')
  await tested.shown.pane.press('widget:git/branch')
  await tested.shown.pane.press('move:down')
  await tested.shown.pane.press('move:down')
  await tested.shown.pane.press('hide')
  await tested.settle()

  expect(await saved()).toEqual({ ...layout, areas: { ...layout.areas, belowPrompt: [], working: [], dashboard: [{ left: ['git/branch'], right: [] }] }, hidden: ['git/branch'] })
})
