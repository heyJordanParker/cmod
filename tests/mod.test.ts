import { expect, spyOn, test } from 'bun:test'
import type { EngineCreateResult, HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import { claudeCodeOf } from '../node_modules/@cmodjs/core/testing/claude-code.js'
import { elements, findElement } from '../node_modules/@cmodjs/core/testing/fake-elements.js'
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

async function prompt(tested: ReturnType<typeof testMod>, text: string): Promise<readonly string[]> {
  const answered = (await claudeCodeOf(tested).fire('prompt.submit', { text, origin: { kind: 'composer' } } as never)) as { readonly context?: readonly string[] }
  const appended = { uuid: `prompt-${text}`, door: 'user', origin: { kind: 'composer' }, message: { type: 'user', content: [{ type: 'text', text }] } }
  await claudeCodeOf(tested).fire('session.append', appended as never, appended as never)
  return answered.context ?? []
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

test("a mod's global rules linked after Claude Code started reach Claude as one note the person never sees, and a later unlink says they no longer apply", async () => {
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
  const noted = await prompt(tested, 'again')
  await settled()

  expect(noted).toEqual([cmodNote("The house-style mod's rules no longer apply.")])
  expect(appendedNotes(tested)).toEqual([])
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
  const noted = await prompt(tested, 'hello')
  await settled()

  expect(started.additionalContext).toEqual([cmodNote('The house-style mod adds these rules from now on:\n\nWrite a test before each fix.\n\nUse the old API.')])
  expect(noted).toEqual([cmodNote('These rules of the house-style mod no longer apply:\n\nUse the old API.')])
  expect(appendedNotes(tested)).toEqual([])
})

const settled = () => Bun.sleep(0)

const ready = { type: 'success', message: 'Installed', description: 'Adds the compact tool, the start_background_agent tool, the Sidebar pane and /mods.\nInstalled the cmod program.\nBinds meta+0 to Show or hide the Sidebar.\nBinds meta+m to Show or hide Settings.\nRun cmod on your computer.\nRead your Claude Code conversations.\nAdd text Claude reads and start turns.\nStart tasks that work beside Claude.' } as const

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
  expect(page).toContain('0.2.0  Turn off  Remove')
  expect(page).toContain('Tells you when CI fails on your branch')
  expect(page).not.toContain('Off:')
  expect(page).toContain('last run passed')
  expect(options).toContain('Branch')
  expect(permissions).toContain('[x] Connect to api.github.com')
  expect(permissions).toContain('[ ] Ask a model, which uses your plan')
  expect(hotkeys).toContain('│ Show the runs                          │\n                  │ Combo ctrl+l                           │')
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

test('Settings lists a hotkey without a default as unbound, and a combo binds it through cmod hotkey', async () => {
  const { tested, ran, shown } = testSettings({ '/plugins/ci-watch/package.json': JSON.stringify({ cmod: { hotkeys: { runs: { title: 'Show the runs', default: 'ctrl+l' }, next: { title: 'Open the next run' } } } }) })
  await tested.type('/mods ci-watch')
  await tested.settle()

  await tested.shown.pane.press('section:hotkeys')
  const hotkeys = await shown()
  await tested.shown.pane.input('hotkey:next', 'ctrl+shift+n')
  await tested.settle()

  expect(hotkeys).toContain('│ Show the runs                          │\n                  │ Combo ctrl+l                           │')
  expect(hotkeys).toContain('│ Open the next run · unbound            │\n                  │ Combo                                  │')
  expect(ran).toEqual([`${cmodProgram} hotkey ci-watch next ctrl+shift+n`])
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

test('Settings shows a linked mod on while the copy cmod link turned off stays off', async () => {
  const { tested, shown } = testSettings()
  tested.fakes.settings.read = async () => ({ enabledPlugins: { 'ci-watch@inline': false, 'ci-watch@Developer-linked': true } })

  await tested.type('/mods ci-watch')
  await tested.settle()
  const lines = await shown()

  expect(lines).not.toContain('ci-watch (off)')
  expect(lines).not.toContain('Off: Claude Code does not load it.')
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

  expect(asked.replace(/[\s│]+/g, ' ')).toContain('Remove ci-watch? Its uninstall step runs, and Claude Code deletes it.')
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

  expect(whileDrawing.join('\n')).toContain('runs body 1')
  expect((await tested.shown.pane.lines()).join('\n')).toContain('runs body 2')
})

test("a Sidebar page whose mod fails to draw it shows the mod's error in place of the drawing placeholder", async () => {
  const tested = testMod(cmodPlugin, {
    state: bound,
    files: {
      [`${store}/records/inbox.json`]: JSON.stringify({ name: 'inbox', version: '0.2.0', root: '/plugins/inbox', installedAt: '', scriptsSha256: '', uninstall: null, program: null, keys: {} }),
      '/plugins/inbox/package.json': JSON.stringify({ cmod: {} }),
      '/plugins/inbox/.claude-plugin/plugin.json': JSON.stringify({ name: 'inbox', version: '0.2.0' }),
    },
  })
  tested.fakes.settings.read = async () => ({ enabledPlugins: { 'inbox@inbox': true } })
  tested.fakes.cmod.call = async (input) => {
    if (input.method === 'cmod:draw') throw new Error('item 3 has no title')
    return null
  }
  await tested.start()
  const changed = (input: object) => tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input, caller: 'inbox' } as never)
  await changed({ parts: { widgets: [], pages: [{ id: 'items', title: 'Inbox', place: 'sidebar' }] } })
  await changed({ requests: [{ open: 'items' }] })
  await tested.settle()
  await tested.shown.pane.lines()
  await tested.settle()

  const lines = (await tested.shown.pane.lines()).join('\n')

  expect(lines).toContain('The items page of inbox could not draw: item 3 has no title')
  expect(lines).not.toContain('Drawing')
})

test('a Sidebar page opened with params draws, because the cmod plugin sends a plain copy of them across plugins', async () => {
  const tested = testMod(cmodPlugin, {
    state: bound,
    files: {
      [`${store}/records/inbox.json`]: JSON.stringify({ name: 'inbox', version: '0.2.0', root: '/plugins/inbox', installedAt: '', scriptsSha256: '', uninstall: null, program: null, keys: {} }),
      '/plugins/inbox/package.json': JSON.stringify({ cmod: {} }),
      '/plugins/inbox/.claude-plugin/plugin.json': JSON.stringify({ name: 'inbox', version: '0.2.0' }),
    },
  })
  tested.fakes.settings.read = async () => ({ enabledPlugins: { 'inbox@inbox': true } })
  const drawnWith: unknown[] = []
  tested.fakes.cmod.call = async (input) => {
    if (input.method !== 'cmod:draw') return null
    drawnWith.push((input.input as { params: unknown }).params)
    return { draw: 1, tree: { $cmodElement: 'Text', props: { children: 'src/a.ts' } } }
  }
  await tested.start()
  const changed = (input: object) => tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input, caller: 'inbox' } as never)
  await changed({ parts: { widgets: [], pages: [{ id: 'file', title: 'File', place: 'sidebar' }] } })
  await changed({ requests: [{ open: 'file', params: { project: '/work/app', path: 'src/a.ts' } }] })
  await tested.settle()
  await tested.shown.pane.lines()
  await tested.settle()

  expect((await tested.shown.pane.lines()).join('\n')).toContain('src/a.ts')
  expect(drawnWith).toContainEqual({ project: '/work/app', path: 'src/a.ts' })
})

test('a Sidebar page keeps its last drawing, and so its place, when its mod fails to draw it during a reload', async () => {
  const tested = testMod(cmodPlugin, {
    state: bound,
    files: {
      [`${store}/records/inbox.json`]: JSON.stringify({ name: 'inbox', version: '0.2.0', root: '/plugins/inbox', installedAt: '', scriptsSha256: '', uninstall: null, program: null, keys: {} }),
      '/plugins/inbox/package.json': JSON.stringify({ cmod: {} }),
      '/plugins/inbox/.claude-plugin/plugin.json': JSON.stringify({ name: 'inbox', version: '0.2.0' }),
    },
  })
  tested.fakes.settings.read = async () => ({ enabledPlugins: { 'inbox@inbox': true } })
  let isReloading = false
  tested.fakes.cmod.call = async (input) => {
    if (input.method !== 'cmod:draw') return null
    if (isReloading) throw new Error('inbox is not installed. Install it in Plugins.')
    return { draw: 1, tree: { $cmodElement: 'Text', props: { children: 'item 7 of 9' } } }
  }
  await tested.start()
  const changed = (input: object) => tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input, caller: 'inbox' } as never)
  await changed({ parts: { widgets: [], pages: [{ id: 'items', title: 'Inbox', place: 'sidebar' }] } })
  await changed({ requests: [{ open: 'items' }] })
  await tested.settle()
  await tested.shown.pane.lines()
  await tested.settle()

  isReloading = true
  await changed({ redraw: true })
  await tested.shown.pane.lines()
  await tested.settle()

  expect((await tested.shown.pane.lines()).join('\n')).toContain('item 7 of 9')
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
  expect(page).toContain('0.2.0  Turn off  Remove')
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

  await tested.settle()

  expect(tested.state.global.areHotkeysBound).toBe(false)
  expect(tested.shown.toasts.map(({ message }) => message)).toContain('Could not bind meta+0 to Show or hide the Sidebar')
  expect(await ownLog(tested)).toContain('Could not bind meta+0 to Show or hide the Sidebar')
})

async function ownLog(tested: ReturnType<typeof testMod>): Promise<string[]> {
  const logged = JSON.parse((await tested.fakes.fs.read?.(`${store}/data/cmod/log/test-session.json`)) ?? '[]') as { message: string }[]
  return logged.map(({ message }) => message)
}

test('on its first start cmod binds its own hotkeys, meta+0 for the Sidebar and meta+m for Settings, and never again', async () => {
  const tested = testMod(cmodPlugin, { state: { global: { installedPlugins: [] } } })
  const ran: string[] = []
  tested.fakes.process.run = async (argv) => (ran.push(argv.join(' ')), { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  await tested.start()

  expect(ran).toEqual([`${cmodProgram} hotkey cmod sidebar meta+0`, `${cmodProgram} hotkey cmod settings meta+m`])
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

  expect(dashboard).toContain('Nothing is on the Dashboard yet.')
  expect(settings).toContain('● cmod')
  expect(settings).toContain('Show or hide the Sidebar')
  expect(tested.shown.openPanes.has('sidebar')).toBe(false)
})

test('after the person hides the Sidebar with Escape, one press of the Sidebar hotkey shows it again', async () => {
  const tested = testMod(cmodPlugin, { state: bound, files: { '/test/plugins/cmod/package.json': JSON.stringify({ cmod: { hotkeys: cmodPlugin.hotkeys } }) } })
  await tested.hotkey('sidebar')
  await tested.fire('ui.close', { id: 'sidebar', origin: { kind: 'person' } } as never)
  await tested.settle()

  await tested.hotkey('sidebar')

  expect(tested.shown.openPanes.has('sidebar')).toBe(true)
  expect((await tested.shown.pane.lines()).join('\n')).toContain('Nothing is on the Dashboard yet.')
})

test("an empty Dashboard says what goes there, and Arrange widgets opens cmod's Widgets in Settings", async () => {
  const tested = testMod(cmodPlugin, { state: bound })

  await tested.hotkey('sidebar')
  const empty = await tested.shown.pane.lines()
  await tested.shown.pane.press('arrange-widgets')
  await tested.settle()
  await tested.shown.pane.lines()
  await tested.settle()

  expect(empty).toEqual([
    '▄'.repeat(80),
    ` 0: Dashboard${' '.repeat(55)}9: Settings`,
    '▀'.repeat(80),
    '',
    ` ╭─ Widgets ${'─'.repeat(66)}╮`,
    ` │ Nothing is on the Dashboard yet.${' '.repeat(43)}│`,
    ` │ Place the widgets your mods add here, in Settings.${' '.repeat(25)}│`,
    ` │${' '.repeat(76)}│`,
    ` │ Arrange widgets${' '.repeat(60)}│`,
    ` ╰${'─'.repeat(76)}╯`,
    '',
    ' ↑↓ scroll  tab move  esc hide',
  ])
  expect(tested.state.session.shown).toBe('settings')
  expect(tested.state.session.selected).toBe('cmod')
  expect(tested.state.session.section).toBe('widgets')
  expect((await tested.shown.pane.lines()).join('\n')).toContain('Above the prompt')
})

test("a mod's install page is a Sidebar tab named for the mod, drawn by the mod, and its × closes it", async () => {
  const { tested, called, shown } = testSettings()
  await tested.start()

  await tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input: { requests: [{ open: 'cmod:install', focus: true }] }, caller: 'ci-watch' } as never)
  await tested.settle()
  await shown()
  await tested.settle()
  const lines = await tested.shown.pane.lines()
  await tested.shown.pane.press('close:ci-watch/cmod:install')
  await tested.settle()

  expect(lines).toEqual(['▄'.repeat(80), ` 0: Dashboard  1: Install ci-watch  ×${' '.repeat(31)}9: Settings`, '▀'.repeat(80), '', ` ╭─ ci-watch ${'─'.repeat(65)}╮`, ` │ last run passed${' '.repeat(60)}│`, ` ╰${'─'.repeat(76)}╯`, '', ' ↑↓ scroll  tab move  esc hide'])
  expect(called).toContain('ci-watch cmod:draw')
  expect(tested.shown.openPanes.has('sidebar')).toBe(false)
})

test('two mods that install at once each get an install tab, and the later one shows', async () => {
  const { tested, shown } = testSettings()
  await tested.start()
  const install = (caller: string) => tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input: { requests: [{ open: 'cmod:install', focus: true }] }, caller } as never)

  await install('ci-watch')
  await install('notes')
  await tested.settle()
  await shown()
  await tested.settle()

  expect((await tested.shown.pane.lines())[1]).toBe(` 0: Dashboard  1: Install ci-watch  ×   2: Install notes  ×${' '.repeat(9)}9: Settings`)
  expect(tested.state.session.shown).toBe('notes/cmod:install')
})

test('Finish setup in Settings opens the install page the mod answers with', async () => {
  const { tested, shown } = testSettings()
  const answer = tested.fakes.cmod.call
  tested.fakes.cmod.call = async (input) => (input.method === 'cmod:finishSteps' ? { requests: [{ open: 'cmod:install', focus: true }] } : answer?.(input))
  await tested.type('/mods ci-watch')
  await tested.settle()

  await tested.shown.pane.press('finish')
  await tested.settle()
  await shown()
  await tested.settle()

  expect(tested.state.session.shown).toBe('ci-watch/cmod:install')
  expect(await shown()).toContain('1: Install ci-watch')
})

test('Settings draws a Mods panel with a status mark beside each mod, and a panel for the selected mod with its version and actions, then what it needs and its sections', async () => {
  const { tested } = testSettings()
  await tested.type('/mods ci-watch')
  await tested.settle()
  await tested.shown.pane.lines()
  await tested.settle()

  expect(await tested.shown.pane.lines()).toEqual([
    '▄'.repeat(80),
    ` 0: Dashboard${' '.repeat(55)}9: Settings`,
    '▀'.repeat(80),
    '',
    ' ╭─ Mods ───────╮ ╭─ ci-watch ─────────────────────────────╮',
    ' │  ● cmod      │ │ 0.2.0  Turn off  Remove                │',
    ' │  ● ci-watch  │ │ Tells you when CI fails on your branch │',
    ' ╰──────────────╯ │                                        │',
    '                  │ Needs setup: Sign in to GitHub         │',
    '                  │ Finish setup                           │',
    '                  │                                        │',
    '                  │  Options  Permissions  Hotkeys         │',
    '                  │                                        │',
    '                  │ Branch                                 │',
    '                  │ Value main                             │',
    '                  ╰────────────────────────────────────────╯',
    '',
    ' ↑↓ scroll  tab move  esc hide',
  ])
})

test('Settings stacks the Mods panel above the mod panel when the Sidebar is too narrow for both side by side', async () => {
  const { tested } = testSettings()
  await tested.type('/mods ci-watch')
  await tested.settle()
  await tested.shown.pane.lines({ columns: 45 })
  await tested.settle()

  expect((await tested.shown.pane.lines({ columns: 45 })).slice(4, 13)).toEqual([
    ' ╭─ Mods ──────────────────────────────────╮',
    ' │  ● cmod                                 │',
    ' │  ● ci-watch                             │',
    ' ╰─────────────────────────────────────────╯',
    '',
    ' ╭─ ci-watch ──────────────────────────────╮',
    ' │ 0.2.0                  Turn off  Remove │',
    ' │ Tells you when CI fails on your branch  │',
    ' │                                         │',
  ])
})

test('every Sidebar tab keeps its width whether it shows or not, so switching tabs moves no other tab', async () => {
  const { tested, declare } = testSettings()
  await tested.start()
  await declare([{ id: 'runs', title: 'Runs', place: 'sidebar' }])
  await tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input: { requests: [{ open: 'runs' }] }, caller: 'ci-watch' } as never)
  await tested.settle()

  const pageShown = (await tested.shown.pane.lines())[1]
  await tested.shown.pane.press('tab:dashboard')
  const dashboardShown = (await tested.shown.pane.lines())[1]

  expect(pageShown).toBe(` 0: Dashboard  1: Runs  ×${' '.repeat(43)}9: Settings`)
  expect(dashboardShown).toBe(pageShown)
})

test("a page tab's × draws as a reversed block, its tab's text color filled behind a glyph in its tab's background, on the shown tab and on every other one", async () => {
  const { tested, declare } = testSettings()
  await tested.start()
  await declare([
    { id: 'runs', title: 'Runs', place: 'sidebar' },
    { id: 'logs', title: 'Logs', place: 'sidebar' },
  ])
  await tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input: { requests: [{ open: 'runs' }, { open: 'logs' }] }, caller: 'ci-watch' } as never)
  await tested.settle()

  const buttons = spyOn(elements, 'Button')
  const tabBar = (await tested.shown.pane.lines())[1]
  const closes = new Map(buttons.mock.calls.map(([props]) => [props.key, props.children]))
  buttons.mockRestore()

  expect(tabBar).toBe(` 0: Dashboard  1: Runs  ×   2: Logs  ×${' '.repeat(30)}9: Settings`)
  expect(closes.get('close:ci-watch/runs')).toEqual(elements.Text({ color: 'userMessageBackground', backgroundColor: 'inactive', children: ' × ' }))
  expect(closes.get('close:ci-watch/logs')).toEqual(elements.Text({ color: 'claude', backgroundColor: 'inverseText', children: ' × ' }))
})

test('the key bar of a Sidebar without the focus says a click focuses it, and names no chord', async () => {
  const { tested, declare } = testSettings()
  await tested.start()
  await declare([{ id: 'runs', title: 'Runs', place: 'sidebar' }])
  await tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input: { requests: [{ open: 'runs' }] }, caller: 'ci-watch' } as never)
  await tested.settle()

  expect((await tested.shown.pane.lines()).at(-1)).toBe(' click focus')
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
    if (request.argv[1] !== 'watch') {
      spawned.push([...request.argv])
      sessions.push(request.env?.['CLAUDE_CODE_SESSION_ID'])
    }
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

const linkedFiles = {
  [`${store}/links.json`]: JSON.stringify({ marketplaces: { 'work-linked': '/work' }, turnedOff: { notes: [] } }),
  '/test/home/.claude/plugins/known_marketplaces.json': JSON.stringify({ 'work-linked': { source: { source: 'directory', path: '/work' }, installLocation: '/work' } }),
}

test('a session started with a linked mod starts cmod watch only while no watcher touched its lock file in the last 15 seconds', async () => {
  const tested = testMod(cmodPlugin, { state: { global: { installedPlugins: ['cmod'], areHotkeysBound: true } }, files: linkedFiles })
  const watches: string[] = []
  tested.fakes.process.spawn = (request) => {
    if (request.argv[1] === 'watch') watches.push('watch')
    const chunks: ProcessSpawnChunk[] = []
    async function* read(): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
      yield* chunks
      return { code: 0, signal: null }
    }
    return Object.assign(read(), { result: Promise.resolve({ code: 0, signal: null }) }) as HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  }
  let now = 100_000
  let touchedAt = 95_000
  tested.fakes.clock.now = async () => now
  const ticks: (() => void)[] = []
  tested.fakes.clock.every = (_ms, run) => (ticks.push(run), { cancel: () => undefined })
  tested.fakes.fs.list = async (path) => (path === `${store}/watch.lock` ? [{ name: '4242', kind: 'file' }] : []) as never
  const stat = tested.fakes.fs.stat
  tested.fakes.fs.stat = async (path) => (path === `${store}/watch.lock/4242` ? { kind: 'file', size: 0, mtimeMs: touchedAt, isLink: false } : (stat?.(path) ?? Promise.reject(new Error('no fs.stat'))))
  const tick = async () => {
    for (const run of ticks) run()
    await tested.settle()
  }

  await tested.start()
  await tested.settle()
  expect(watches).toEqual([])

  now = 120_000
  await tick()
  expect(watches).toEqual(['watch'])

  touchedAt = 119_000
  now = 130_000
  await tick()
  expect(watches).toEqual(['watch'])
})

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

  expect(await askCmod(tested, 'notes', 'cmod:sessions', {})).toEqual({ deny: 'notes calls sessions.list without your grant to "Read your Claude Code conversations". Turn it on in Settings.' })
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

test('the cmod plugin answers every method a mod built on @cmodjs/core 4.0.0 or later calls on it', async () => {
  const { tested } = cmodAnswering({})
  await tested.start()
  const methods = ['cmod:sessions', 'cmod:search', 'cmod:messages', 'cmod:turns', 'cmod:contexts', 'cmod:tasks', 'cmod:goal', 'cmod:updateGoal', 'cmod:subscribe', 'cmod:watchBefore', 'cmod:act', 'cmod:partsChanged', 'forkParent', 'updateSettings', 'cmod:failed']
  const refusal = async (method: string) => {
    const answer = await askCmod(tested, 'recall', method, {}).catch((error: unknown) => ({ deny: String(error) }))
    return (answer as { deny?: string }).deny ?? ''
  }

  expect(await refusal('cmod:unheard')).toContain('has no method')
  for (const method of methods) expect(await refusal(method)).not.toContain('has no method')
})

const installedRoot = '/test/home/.claude/plugins/cache/ci-watch/ci-watch/0.2.0'

const failureOf = (mod: string, root: string, at: string, fields: Record<string, unknown> = {}) => ({
  mod,
  id: 'session:onPrompt',
  message: `${mod}'s onPrompt listener failed`,
  details: `${mod} 1.0.0, @cmodjs/core 4.3.0, at ${at}\nThe onPrompt listener failed\nthe notes file is missing`,
  at,
  isCritical: false,
  root,
  ...fields,
})

test('cmod:failed answers show for a mod run from its checkout and a critical failure, no show for an installed mod until Show errors from installed mods is on, and the Log lists each newest first with Copy', async () => {
  const { tested, shown } = testSettings()
  await tested.start()
  const fail = (caller: string, input: unknown) => tested.fire('cmod.call', { to: 'cmod', method: 'cmod:failed', input, caller } as never)

  const linked = await fail('notes', failureOf('notes', '/work/notes', '2026-10-26T09:00:00.000Z'))
  const installed = await fail('ci-watch', failureOf('ci-watch', installedRoot, '2026-10-26T09:01:00.000Z'))
  const critical = await fail('ci-watch', failureOf('ci-watch', installedRoot, '2026-10-26T09:02:00.000Z', { id: 'cmod:install', message: 'Its setup failed', isCritical: true }))
  await tested.fakes.fs.write?.(`${store}/preferences.json`, JSON.stringify({ showsInstalledModErrors: true }))
  const repeated = await fail('ci-watch', failureOf('ci-watch', installedRoot, '2026-10-26T09:03:00.000Z'))

  expect([linked, installed, critical, repeated]).toEqual([{ value: { showsToast: true } }, { value: { showsToast: false } }, { value: { showsToast: true } }, { value: { showsToast: true } }])

  await tested.type('/mods cmod')
  await tested.settle()
  await tested.shown.pane.press('section:log')
  const log = await shown()
  await tested.shown.pane.press('copy:notes/session:onPrompt')

  const rows = ["ci-watch's onPrompt listener failed", 'Its setup failed', "notes's onPrompt listener failed"]
  expect(rows.map((row) => log.indexOf(row))).toEqual(rows.map((row) => log.indexOf(row)).toSorted((left, right) => left - right))
  expect(log.split("ci-watch's onPrompt listener failed")).toHaveLength(2)
  expect(log).toContain('Copy')
  expect(log).toContain('Report')
  expect(tested.calls.filter((call) => call.call === 'ui.copy').map((call) => call.args[0])).toEqual([{ text: failureOf('notes', '/work/notes', '2026-10-26T09:00:00.000Z').details }])
  expect(await shown()).toContain('Copied the error.')
})

test('the Log keeps the failures of every session, and skips a session file that is not a list, naming it in the debug log', async () => {
  const other = [{ mod: 'notes', id: 'timer', message: 'The every 1000 ms timer failed', details: 'notes 1.0.0', at: '2026-10-25T08:00:00.000Z' }]
  const { tested, shown } = testSettings({ [`${store}/data/cmod/log/other-session.json`]: JSON.stringify(other) })
  await tested.start()
  await tested.fire('cmod.call', { to: 'cmod', method: 'cmod:failed', input: failureOf('ci-watch', installedRoot, '2026-10-26T09:01:00.000Z'), caller: 'ci-watch' } as never)

  await tested.type('/mods cmod')
  await tested.settle()
  await tested.shown.pane.press('section:log')
  const log = await shown()

  expect(log.indexOf("ci-watch's onPrompt listener failed")).toBeLessThan(log.indexOf('The every 1000 ms timer failed'))
  expect(JSON.parse((await tested.fakes.fs.read?.(`${store}/data/cmod/log/test-session.json`)) ?? '[]')).toEqual([
    { mod: 'ci-watch', id: 'session:onPrompt', message: "ci-watch's onPrompt listener failed", details: failureOf('ci-watch', installedRoot, '2026-10-26T09:01:00.000Z').details, at: '2026-10-26T09:01:00.000Z' },
  ])

  await tested.fakes.fs.write?.(`${store}/data/cmod/log/other-session.json`, '{}')
  await tested.type('/mods cmod')
  await tested.settle()
  await tested.shown.pane.press('section:log')
  const skipped = await shown()

  expect(skipped).toContain("ci-watch's onPrompt listener failed")
  expect(skipped).not.toContain('The every 1000 ms timer failed')
  expect(skipped).not.toContain('did not load')
  expect(tested.shown.debug).toContain(`cmod: the Log skips a file: ${store}/data/cmod/log/other-session.json is not a list of mod failures. Delete it, and cmod starts it again.`)
})

test("another session's preference write reaches this session's Settings when store-changed changes", async () => {
  const { tested, shown } = testSettings()
  const { tick } = watchedStore(tested)
  await tested.start()
  await tested.type('/mods cmod')
  await tested.settle()
  await tested.shown.pane.press('section:preferences')
  const before = await shown()

  await writeStoreFile(tested, `${store}/preferences.json`, JSON.stringify({ showsInstalledModErrors: true }))
  await tick()

  expect(before).toContain('[ ] Show errors from installed mods')
  expect(await shown()).toContain('[x] Show errors from installed mods')
})

test('pressing Show errors from installed mods writes preferences.json, then store-changed', async () => {
  const { tested, shown } = testSettings({ [`${store}/preferences.json`]: JSON.stringify({ asksBeforeUpdatePermissions: true }) })
  await tested.start()
  await tested.type('/mods cmod')
  await tested.settle()
  await tested.shown.pane.press('section:preferences')
  const before = await shown()
  await tested.shown.pane.press('preference:showsInstalledModErrors')
  await tested.settle()

  expect(before).toContain('[x] Ask before an update adds a permission')
  expect(before).toContain('[ ] Show errors from installed mods')
  expect(JSON.parse((await tested.fakes.fs.read?.(`${store}/preferences.json`)) ?? '')).toEqual({ asksBeforeUpdatePermissions: true, showsInstalledModErrors: true })
  expect(await tested.fakes.fs.exists?.(`${store}/store-changed`)).toBe(true)
  expect(await shown()).toContain('[x] Show errors from installed mods')
})

test("Claude's start_background_agent tool starts its task in a new background session through cmod task start", async () => {
  const started = { id: 'bg-1', title: 'Upgrade', openedBy: '', openedAt: '2026-10-23T10:00:00.000Z', isBackground: true }
  const { tested, spawned, sessions } = cmodAnswering({ 'task start': { code: 0, stdout: `${JSON.stringify(started)}\n` } })
  await tested.start()
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tested.settle()

  const answer = await tested.callTool('start_background_agent', { task: 'Upgrade every dependency.', title: 'Upgrade', model: 'sonnet' })

  expect(answer).toEqual({ result: 'Started a background agent in session bg-1. It answers there, not in this conversation.' })
  expect(spawned.filter((argv) => argv[1] === 'task')).toEqual([[cmodProgram, 'task', 'start', '--title', 'Upgrade', '--model', 'sonnet', '--cwd', '/work/app', '--json', '--', 'Upgrade every dependency.']])
  expect(sessions[spawned.findIndex((argv) => argv[1] === 'task')]).toBe('test-session')
})

test("Claude's compact tool compacts the conversation once Claude's answer ends, keeping what it named, and then prompts Claude to carry on", async () => {
  const { tested } = cmodAnswering({})
  const ran: { command: string; args?: string }[] = []
  tested.fakes.command.run = async (run) => (ran.push(run), {})
  await tested.start()
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await prompt(tested, 'Build the parser')

  expect(await tested.callTool('compact', { keep: 'the parser plan' })).toEqual({ result: 'The conversation compacts once this answer ends, and a prompt then lets you carry on. End your answer now.' })
  expect(ran).toEqual([])

  await claudeCodeOf(tested).fire('Stop', { stop_hook_active: false })
  for (let waited = 0; tested.shown.prompts.length === 0 && waited < 50; waited += 1) await Bun.sleep(1)

  expect(ran).toEqual([{ command: 'compact', args: 'the parser plan' }])
  expect(tested.shown.prompts).toEqual(['The conversation was compacted. Carry on with the work from before the compaction.'])
})

const installedPlugins = '/test/home/.claude/plugins/installed_plugins.json'

function pluginsListed(lists: readonly (readonly { name: string; version: string; state?: string; unsatisfied?: string[] }[])[], global: Partial<CmodPluginState['global']> = {}) {
  const tested = testMod(cmodPlugin, { state: { global: { installedPlugins: ['cmod'], areHotkeysBound: true, pluginsCheckedAt: null, ...global } }, files: { [installedPlugins]: '{}', [`${store}/store-changed`]: '' } })
  const ticks: (() => void)[] = []
  tested.fakes.clock.every = (_ms, run) => (ticks.push(run), { cancel: () => undefined })
  const ran: string[] = []
  const answers = [...lists]
  tested.fakes.process.spawn = (request) => {
    if (request.argv[1] !== 'watch') ran.push(request.argv.slice(1).join(' '))
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
  expect(tested.state.global.pluginsCheckedAt).toEqual([0, null])
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
  expect(await ownLog(tested)).toEqual(['Could not update cmod for the mods that need a newer one'])
})

test('only a session with a linked mod, shown in an app, starts cmod watch', async () => {
  const startsWatch = async (files: Record<string, string>, surfaces: readonly ('terminal' | 'desktop' | 'mobile' | 'vscode')[]) => {
    const { tested } = cmodAnswering({}, files)
    const started: string[][] = []
    const spawn = tested.fakes.process.spawn
    tested.fakes.process.spawn = (request) => (started.push([...request.argv]), spawn!(request))
    tested.fakes.session.surfaces = async () => [...surfaces]
    await tested.start()
    await tested.settle()
    return started.some((argv) => argv.join(' ') === `${cmodProgram} watch`)
  }
  const removed = { ...linkedFiles, '/test/home/.claude/plugins/known_marketplaces.json': '{}' }

  expect(await startsWatch(linkedFiles, ['terminal'])).toBe(true)
  expect(await startsWatch({}, ['terminal'])).toBe(false)
  expect(await startsWatch(removed, ['terminal'])).toBe(false)
  expect(await startsWatch(linkedFiles, [])).toBe(false)
})

test('a running session starts cmod watch once a mod is linked', async () => {
  const { tested } = cmodAnswering({}, {})
  const started: string[] = []
  const spawn = tested.fakes.process.spawn
  tested.fakes.process.spawn = (request) => (started.push(request.argv.join(' ')), spawn!(request))
  const { tick } = watchedStore(tested)
  await tested.start()
  await tested.settle()
  expect(started).not.toContain(`${cmodProgram} watch`)

  for (const [path, text] of Object.entries(linkedFiles)) await writeStoreFile(tested, path, text)
  await tick()

  expect(started).toContain(`${cmodProgram} watch`)
})

test('a linked mod that does not build shows its error in one toast, and the toast goes once it builds', async () => {
  const { tested } = cmodAnswering({}, {})
  const { tick } = watchedStore(tested)
  await tested.start()
  await tested.settle()

  await writeStoreFile(tested, `${store}/build-failures.json`, JSON.stringify({ demo: 'Bundling hooks/register.ts failed: Expected ")"' }))
  await tick()
  expect(tested.shown.toasts.filter((toast) => toast.type === 'error')).toContainEqual({ type: 'error', message: 'demo does not build', description: 'Bundling hooks/register.ts failed: Expected ")"' })

  await writeStoreFile(tested, `${store}/build-failures.json`, '{}')
  await tick()
  expect(tested.shown.toasts.filter((toast) => toast.message === 'demo does not build')).toEqual([])
})

test('the cmod plugin updates nothing when every mod has the cmod it needs, and a store change that marks no plugin change lists nothing', async () => {
  const { tested, ran, ticks } = pluginsListed([[{ name: 'cmod@cmod', version: '4.0.0' }, { name: 'notes@cmod', version: '0.1.0' }]])
  await tested.start()
  await tested.settle()
  await writeStoreFile(tested, `${store}/widgets.json`, '{}')
  for (const run of ticks) run()
  await tested.settle()

  expect(ran.filter((command) => !command.startsWith('rules'))).toEqual(['list --json'])
})

test('a session start lists the mods even when no plugin changed since the last check, and shows a mod off for an older cmod', async () => {
  const off = [{ name: 'cmod@beta', version: '4.0.2' }, { name: 'file-tree@beta', version: '0.1.0', state: turnedOff, unsatisfied: ['cmod@beta'] }]
  const first = pluginsListed([off])
  await first.tested.start()
  await first.tested.settle()
  const { tested, ran } = pluginsListed([off], { pluginsCheckedAt: first.tested.state.global.pluginsCheckedAt })
  await tested.start()
  await tested.settle()

  expect(ran.filter((command) => !command.startsWith('rules'))).toEqual(['list --json', 'update cmod', 'list --json'])
  expect(tested.shown.toasts.filter((toast) => toast.type === 'error')).toEqual([{ type: 'error', message: 'file-tree@beta is off', description: turnedOff }])
})

test('a session no app shows, such as claude -p, lists no mods at its start when no plugin changed since the last check', async () => {
  const off = [{ name: 'cmod@beta', version: '4.0.2' }, { name: 'file-tree@beta', version: '0.1.0', state: turnedOff, unsatisfied: ['cmod@beta'] }]
  const first = pluginsListed([off])
  await first.tested.start()
  await first.tested.settle()
  const { tested, ran } = pluginsListed([off], { pluginsCheckedAt: first.tested.state.global.pluginsCheckedAt })
  tested.fakes.session.surfaces = async () => []
  await tested.start()
  await tested.settle()

  expect(ran.filter((command) => !command.startsWith('rules'))).toEqual([])
})

test("a linked mod's new plugins-changed mark, with installed_plugins.json unchanged, updates cmod when the mod is off for an older cmod, and shows it while it stays off", async () => {
  const healthy = [{ name: 'cmod@Developer-linked', version: '4.3.2' }, { name: 'oneclaude@Developer-linked', version: '0.1.0' }]
  const linkedOff = 'Claude Code turned it off: Requires "cmod@Developer-linked" >=4.3.3, installed 4.3.2'
  const off = [healthy[0]!, { name: 'oneclaude@Developer-linked', version: '0.1.0', state: linkedOff, unsatisfied: ['cmod@Developer-linked'] }]
  const { tested, ran, ticks } = pluginsListed([healthy, off, off])
  await tested.start()
  await tested.settle()

  await writeStoreFile(tested, `${store}/plugins-changed`, '1 100\n')
  for (const run of ticks) run()
  await tested.settle()

  expect(ran.filter((command) => !command.startsWith('rules'))).toEqual(['list --json', 'list --json', 'update cmod', 'list --json'])
  expect(tested.shown.toasts.filter((toast) => toast.type === 'error')).toEqual([{ type: 'error', message: 'oneclaude@Developer-linked is off', description: linkedOff }])
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
  type Timed = { at: number; readonly every?: number; readonly fire: () => void }
  let now = 0
  const timers = new Set<Timed>()
  const add = (timer: Timed) => (timers.add(timer), { cancel: () => void timers.delete(timer) })
  tested.fakes.clock.after = (ms, fire) => add({ at: now + ms, fire })
  tested.fakes.clock.every = (ms, fire) => add({ at: now + ms, every: ms, fire })
  const advance = async (ms: number) => {
    const end = now + ms
    for (let due = [...timers].filter((timer) => timer.at <= end).toSorted((a, b) => a.at - b.at)[0]; due !== undefined; due = [...timers].filter((timer) => timer.at <= end).toSorted((a, b) => a.at - b.at)[0]) {
      now = due.at
      if (due.every === undefined) timers.delete(due)
      else due.at += due.every
      due.fire()
      await settled()
      await settled()
    }
    now = end
    await settled()
  }
  return { tick: () => advance(2500), advance }
}

async function writeStoreFile(tested: ReturnType<typeof testMod>, path: string, text: string) {
  await tested.fakes.fs.write?.(path, text)
  await tested.fakes.fs.write?.(`${store}/store-changed`, '')
}

test('the cmod plugin polls only the store-changed stamp and installed_plugins.json', async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  await writeStoreFile(tested, `${store}/plugins-changed`, '1 100\n')
  await tested.fakes.fs.write?.(installedPlugins, '{}')
  const { tick } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tick()
  const before = tested.calls.length

  await tick()

  const polled = new Set(tested.calls.slice(before).filter(({ call }) => call === 'fs.stat').map(({ args }) => args[0]))
  expect([...polled].toSorted()).toEqual([installedPlugins, `${store}/store-changed`])
})

test('a store file cmod changes without the store-changed stamp is not read', async () => {
  const { tested } = cmodAnswering({}, {})
  const { tick } = watchedStore(tested)
  await tested.start()
  await tested.settle()

  await tested.fakes.fs.write?.(`${store}/build-failures.json`, JSON.stringify({ demo: 'Bundling hooks/register.ts failed: Expected ")"' }))
  await tick()

  expect(tested.shown.toasts.filter((toast) => toast.message === 'demo does not build')).toEqual([])
})

const shownToasts = (tested: ReturnType<typeof testMod>) => tested.calls.filter(({ call }) => call === 'ui.toast').map(({ args }) => args[0])

test("a plugin turned on in this session's own /plugin, which raises no ConfigChange here, reloads the session once that prompt's turn ends", async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  const reloads: string[] = []
  tested.fakes.command.run = async ({ command }) => (reloads.push(command), {})
  const { tick } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tick()

  tested.fakes.settings.read = async () => ({ enabledPlugins: { 'cmod@fixtures': true, 'hello@market': true } })
  await prompt(tested, 'hello')
  await tick()
  expect(reloads).toEqual([])

  await claudeCodeOf(tested).fire('Stop', { stop_hook_active: false })
  await tick()
  expect(reloads).toEqual(['reload-plugins'])
})

test('a plugins-changed mark in an idle session runs /reload-plugins, and the band shows no toast for it', async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  const reloads: string[] = []
  tested.fakes.command.run = async ({ command }) => (reloads.push(command), {})
  const { tick } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tick()

  await writeStoreFile(tested, `${store}/plugins-changed`, '1 100\n')
  await tick()
  await tick()

  expect(reloads).toEqual(['reload-plugins'])
  expect(tested.shown.toasts).toEqual([ready])
  expect(shownToasts(tested)).toEqual([])
})

test('a plugins-changed mark during a running turn runs /reload-plugins only after the turn ends', async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  const reloads: string[] = []
  tested.fakes.command.run = async ({ command }) => (reloads.push(command), {})
  const { tick } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tick()
  await prompt(tested, 'Rename the parser')

  await writeStoreFile(tested, `${store}/plugins-changed`, '1 100\n')
  await tick()
  await tick()
  expect(reloads).toEqual([])

  await claudeCodeOf(tested).fire('Stop', { stop_hook_active: false })
  await tick()
  expect(reloads).toEqual(['reload-plugins'])
})

const installedJson = (versions: Readonly<Record<string, string>>) => JSON.stringify({ version: 2, plugins: Object.fromEntries(Object.entries(versions).map(([id, version]) => [id, [{ scope: 'user', installPath: `/test/home/.claude/plugins/cache/${id}`, version }]])) })

const installRecord = (name: string, version: string, grantedOnUpdate: readonly string[]) => JSON.stringify({ name, version, root: `/plugins/${name}`, installedAt: '', scriptsSha256: '', uninstall: null, program: null, keys: {}, permissions: [], grantedOnUpdate })

async function startedWith(from: Readonly<Record<string, string>>, files: Readonly<Record<string, string>> = {}) {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true, ...Object.fromEntries(Object.keys(from).map((id) => [id, true])) })
  for (const [path, text] of Object.entries(files)) await tested.fakes.fs.write?.(path, text)
  await tested.fakes.fs.write?.(installedPlugins, installedJson(from))
  const reloads: string[] = []
  tested.fakes.command.run = async ({ command }) => (reloads.push(command), {})
  const { tick, advance } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tick()
  expect(shownToasts(tested)).toEqual([])
  return { tested, reloads, tick, advance }
}

async function updated(from: Readonly<Record<string, string>>, to: Readonly<Record<string, string>>, files: Readonly<Record<string, string>> = {}) {
  const { tested, reloads, tick } = await startedWith(from, files)

  await tested.fakes.fs.write?.(installedPlugins, installedJson(to))
  await tick()
  await tick()
  expect(reloads).toEqual(['reload-plugins'])
  return { tested, tick }
}

test('an update of five plugins, which rewrites installed_plugins.json once per plugin, reloads once and shows one 5 plugins updated toast', async () => {
  const ids = ['notes@market', 'inbox@market', 'tasks@market', 'deploys@market', 'recall@market']
  const { tested, reloads, tick, advance } = await startedWith(Object.fromEntries(ids.map((id) => [id, '1.0.0'])))

  for (const [index] of ids.entries()) {
    await tested.fakes.fs.write?.(installedPlugins, installedJson(Object.fromEntries(ids.map((id, at) => [id, at <= index ? '1.1.0' : '1.0.0']))))
    await advance(1000)
  }
  await tick()
  await tick()

  expect(reloads).toEqual(['reload-plugins'])
  expect(shownToasts(tested)).toEqual(['5 plugins updated'])
})

test('an update after /clear still shows its toast, because the versions belong to the running Claude Code, not the conversation', async () => {
  const { tested, reloads, tick } = await startedWith({ 'notes@market': '1.2.0' })
  await claudeCodeOf(tested).fire('SessionStart', { source: 'clear', session_id: 'after-clear' })
  await tick()

  await tested.fakes.fs.write?.(installedPlugins, installedJson({ 'notes@market': '1.3.0' }))
  await tick()
  await tick()

  expect(reloads).toEqual(['reload-plugins'])
  expect(shownToasts(tested)).toEqual(['notes updated to 1.3.0'])
})

test('with more than 3 updates, each update that granted a permission keeps its own toast, and only the rest are summed up', async () => {
  const versions = (version: string) => ({ 'notes@market': version, 'inbox@market': version, 'tasks@market': version, 'deploys@market': version, 'recall@market': version, 'trace@market': version })
  const { tested } = await updated(versions('1.0.0'), versions('1.1.0'), { [`${store}/records/inbox.json`]: installRecord('inbox', '1.1.0', ['conversation']), [`${store}/records/recall.json`]: installRecord('recall', '1.1.0', []) })

  expect(shownToasts(tested)).toEqual(['inbox updated to 1.1.0 · Read your Claude Code conversations', '5 plugins updated'])
})

test('with more than 3 updates, 3 or fewer left after the ones that granted a permission show one by one', async () => {
  const versions = (version: string) => ({ 'notes@market': version, 'inbox@market': version, 'tasks@market': version, 'deploys@market': version })
  const { tested } = await updated(versions('1.0.0'), versions('1.1.0'), { [`${store}/records/inbox.json`]: installRecord('inbox', '1.1.0', ['conversation']) })

  expect(shownToasts(tested).toSorted()).toEqual(['deploys updated to 1.1.0', 'inbox updated to 1.1.0 · Read your Claude Code conversations', 'notes updated to 1.1.0', 'tasks updated to 1.1.0'])
})

test('a reload that changed notes from 1.2.0 to 1.3.0 shows notes updated to 1.3.0 in the corner', async () => {
  const { tested } = await updated({ 'notes@market': '1.2.0', 'inbox@market': '2.0.0' }, { 'notes@market': '1.3.0', 'inbox@market': '2.0.0' })

  expect(shownToasts(tested)).toEqual(['notes updated to 1.3.0'])
})

test('a reload that updated a plugin installed from git names the version its plugin.json holds, without the commit Claude Code adds, and the permissions its record granted at it', async () => {
  const copy = (version: string) => `/test/home/.claude/plugins/cache/market/notes/${version}`
  const installed = (version: string) => JSON.stringify({ version: 2, plugins: { 'notes@market': [{ scope: 'user', installPath: copy(version), version }] } })
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true, 'notes@market': true })
  await tested.fakes.fs.write?.(`${copy('1.2.0-aaaaaaaaaaaa')}/.claude-plugin/plugin.json`, JSON.stringify({ name: 'notes', version: '1.2.0' }))
  await tested.fakes.fs.write?.(`${copy('1.3.0-bbbbbbbbbbbb')}/.claude-plugin/plugin.json`, JSON.stringify({ name: 'notes', version: '1.3.0' }))
  await tested.fakes.fs.write?.(`${store}/records/notes.json`, installRecord('notes', '1.3.0', ['conversation']))
  await tested.fakes.fs.write?.(installedPlugins, installed('1.2.0-aaaaaaaaaaaa'))
  const reloads: string[] = []
  tested.fakes.command.run = async ({ command }) => (reloads.push(command), {})
  const { tick } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tick()

  await tested.fakes.fs.write?.(installedPlugins, installed('1.3.0-bbbbbbbbbbbb'))
  await tick()
  await tick()

  expect(reloads).toEqual(['reload-plugins'])
  expect(shownToasts(tested)).toEqual(['notes updated to 1.3.0 · Read your Claude Code conversations'])
})

test('a reload that changed four versions shows one 4 plugins updated toast', async () => {
  const versions = (version: string) => ({ 'notes@market': version, 'inbox@market': version, 'tasks@market': version, 'deploys@market': version })
  const { tested } = await updated(versions('1.0.0'), versions('1.1.0'))

  expect(shownToasts(tested)).toEqual(['4 plugins updated'])
})

test('a reload with no version change, such as an edit to a linked mod, shows no corner toast', async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true, 'notes@market': true })
  await tested.fakes.fs.write?.(installedPlugins, installedJson({ 'notes@market': '1.2.0' }))
  const reloads: string[] = []
  tested.fakes.command.run = async ({ command }) => (reloads.push(command), {})
  const { tick } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tick()

  await writeStoreFile(tested, `${store}/plugins-changed`, '1 100\n')
  await tick()
  await tick()

  expect(reloads).toEqual(['reload-plugins'])
  expect(shownToasts(tested)).toEqual([])
})

test('an update whose install record at the new version granted a permission adds its words to the toast', async () => {
  const { tested } = await updated({ 'notes@market': '1.2.0' }, { 'notes@market': '1.3.0' }, { [`${store}/records/notes.json`]: installRecord('notes', '1.3.0', ['conversation']) })

  expect(shownToasts(tested)).toEqual(['notes updated to 1.3.0 · Read your Claude Code conversations'])
})

test("an update waits for the mod's setup to write its record at the new version, then names what it granted", async () => {
  const record = `${store}/records/notes.json`
  const { tested, tick } = await updated({ 'notes@market': '1.2.0' }, { 'notes@market': '1.3.0' }, { [record]: installRecord('notes', '1.2.0', []) })
  expect(shownToasts(tested)).toEqual([])

  await tested.fakes.fs.write?.(record, installRecord('notes', '1.3.0', ['conversation']))
  await tick()

  expect(shownToasts(tested)).toEqual(['notes updated to 1.3.0 · Read your Claude Code conversations'])
})

test("an update whose mod never writes its record at the new version shows the toast without permissions after 10 s of checks", async () => {
  const record = `${store}/records/notes.json`
  const { tested, tick } = await updated({ 'notes@market': '1.2.0' }, { 'notes@market': '1.3.0' }, { [record]: installRecord('notes', '1.2.0', ['conversation']) })
  for (let ticks = 0; ticks < 40 && shownToasts(tested).length === 0; ticks += 1) await tick()

  expect(shownToasts(tested)).toEqual(['notes updated to 1.3.0'])
  expect(tested.calls.filter(({ call, args }) => call === 'fs.read' && args[0] === record)).toHaveLength(21)
})

test('a user settings change Claude Code reports turns a plugin on, and reloads the session once Claude Code has loaded it', async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  const reloads: string[] = []
  tested.fakes.command.run = async ({ command }) => (reloads.push(command), {})
  const { tick } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tick()

  await claudeCodeOf(tested).fire('ConfigChange', { source: 'user_settings', file_path: '/test/home/.claude/settings.json' })
  tested.fakes.settings.read = async () => ({ enabledPlugins: { 'cmod@fixtures': true, 'hello@market': true } })
  await tick()
  await tick()

  expect(reloads).toEqual(['reload-plugins'])
})

test('two changes cmod marks in its store reload the session once, and the mark the session started with reloads nothing', async () => {
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

  await writeStoreFile(tested, changed, '2 200\n')
  await writeStoreFile(tested, changed, '3 300\n')
  await tick()
  await tick()

  expect(reloads).toEqual(['reload-plugins'])
})

const reloadEcho = '<command-name>/reload-plugins</command-name>\n<command-message>reload-plugins</command-message>\n<command-args></command-args>'
const reloadOutput = '<local-command-stdout>Reloaded: 5 plugins</local-command-stdout>'
const hiddenReload = [{ type: 'text', text: '<local-command-caveat>cmod reloaded the plugins.</local-command-caveat>' }]

const appendedRow = async (tested: ReturnType<typeof testMod>, uuid: string, origin: object, type: 'user' | 'system', text: string) => {
  const row = { uuid, door: 'command', origin, message: { type, ...(type === 'system' ? { name: 'local_command' } : {}), role: 'user', content: [{ type: 'text', text }] } }
  const kept = await claudeCodeOf(tested).fire('session.append', row as never)
  return kept.message?.content
}

test("the reload cmod runs leaves no row in the conversation, and a person's own /reload-plugins still shows", async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  const reloads: string[] = []
  tested.fakes.command.run = async ({ command }) => (reloads.push(command), {})
  const { tick } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tick()

  await writeStoreFile(tested, `${store}/plugins-changed`, '1 100\n')
  await tick()
  await tick()

  expect(reloads).toEqual(['reload-plugins'])
  expect(await appendedRow(tested, 'echo-1', { kind: 'plugin', name: 'cmod' }, 'user', reloadEcho)).toEqual(hiddenReload)
  expect(await appendedRow(tested, 'output-1', { kind: 'engine' }, 'system', reloadOutput)).toEqual(hiddenReload)
  expect(await appendedRow(tested, 'echo-2', { kind: 'composer' }, 'user', reloadEcho)).toEqual([{ type: 'text', text: reloadEcho }])
  expect(await appendedRow(tested, 'output-2', { kind: 'engine' }, 'system', reloadOutput)).toEqual([{ type: 'text', text: reloadOutput }])
})

test("cmod's reload hides its output row even when Claude Code restarted the cmod plugin before the echo row reached it", async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  const reloads: string[] = []
  tested.fakes.command.run = async ({ command }) => (reloads.push(command), {})
  const { tick } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tick()

  await writeStoreFile(tested, `${store}/plugins-changed`, '1 100\n')
  await tick()
  await tick()

  expect(reloads).toEqual(['reload-plugins'])
  expect(await appendedRow(tested, 'output-1', { kind: 'engine' }, 'system', reloadOutput)).toEqual(hiddenReload)
  expect(await appendedRow(tested, 'echo-4', { kind: 'composer' }, 'user', '<command-name>/model</command-name>')).toEqual([{ type: 'text', text: '<command-name>/model</command-name>' }])
})

test('a plugin Claude Code installs, updates, or turns on without cmod reloads the session, and other settings reload nothing', async () => {
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

  await claudeCodeOf(tested).fire('ConfigChange', { source: 'user_settings', file_path: '/test/home/.claude/settings.json' })
  await tick()
  await tick()
  expect(reloads).toEqual(['reload-plugins'])

  tested.fakes.settings.read = async () => ({ enabledPlugins: { 'cmod@fixtures': true, 'hello@market': true } })
  await claudeCodeOf(tested).fire('ConfigChange', { source: 'user_settings', file_path: '/test/home/.claude/settings.json' })
  await tick()
  await tick()
  expect(reloads).toEqual(['reload-plugins', 'reload-plugins'])
})

test('a session no app shows, such as claude -p, never reloads, so its answer stays the run\'s result', async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  tested.fakes.session.surfaces = async () => []
  const reloads: string[] = []
  tested.fakes.command.run = async ({ command }) => (reloads.push(command), {})
  const { tick } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tick()

  await writeStoreFile(tested, `${store}/plugins-changed`, '2 200\n')
  await tick()
  await tick()

  expect(reloads).toEqual([])
})

test('a plugin install that writes the user settings, then installed_plugins.json, reloads the session once', async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  const reloads: string[] = []
  tested.fakes.command.run = async ({ command }) => (reloads.push(command), {})
  const { tick, advance } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tick()

  await claudeCodeOf(tested).fire('ConfigChange', { source: 'user_settings', file_path: '/test/home/.claude/settings.json' })
  tested.fakes.settings.read = async () => ({ enabledPlugins: { 'cmod@fixtures': true, 'hello@market': true } })
  await advance(1500)
  await tested.fakes.fs.write?.(installedPlugins, '{"version":2,"plugins":{"hello@market":[]}}')
  await tick()
  await tick()

  expect(reloads).toEqual(['reload-plugins'])
})

test("a change cmod marks while cmod's reload runs reloads the session again after it", async () => {
  const { tested } = testRemovals(['cmod'], { 'cmod@fixtures': true })
  const changed = `${store}/plugins-changed`
  const reloads: string[] = []
  let finish = () => {}
  tested.fakes.command.run = async ({ command }) => {
    reloads.push(command)
    if (reloads.length === 1) {
      await writeStoreFile(tested, changed, '2 200\n')
      await new Promise<void>((resolve) => (finish = resolve))
    }
    return {}
  }
  const { tick } = watchedStore(tested)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tick()

  await writeStoreFile(tested, changed, '1 100\n')
  await tick()
  await tick()
  await tick()
  expect(reloads).toEqual(['reload-plugins'])

  finish()
  await tick()
  await tick()

  expect(reloads).toEqual(['reload-plugins', 'reload-plugins'])
})

test('a reload the session refuses shows why, and Retry reloads', async () => {
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

  await writeStoreFile(tested, changed, '1 100\n')
  await tick()
  await tick()
  expect(reloads).toEqual(['reload-plugins'])
  expect(tested.shown.toasts.filter((toast) => toast.type === 'error')).toEqual([{ type: 'error', message: 'Could not reload the plugins', description: 'the session was stopped and nobody has sent input since' }])

  const band = await tested.fire('ui.render', { surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false }, viewport: { columns: 100, rows: 24 } } as never, { type: 'Text', children: ['>'] } as never)
  const retry = findElement(band, 'Button', 'Retry')
  if (retry === undefined) throw new Error('The reload failure draws no Retry button.')
  await (retry['onPress'] as () => Promise<void>)()
  await tick()
  expect(reloads).toEqual(['reload-plugins', 'reload-plugins'])
  expect(tested.shown.toasts.filter((toast) => toast.type === 'error')).toEqual([])
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

  expect(await tested.shown.pane.lines()).toEqual(['▄'.repeat(80), ` 0: Dashboard${' '.repeat(55)}9: Settings`, '▀'.repeat(80), '', ` ╭─ Widgets ${'─'.repeat(66)}╮`, ` │ main, 74 columns${' '.repeat(59)}│`, ` ╰${'─'.repeat(76)}╯`, '', ' ↑↓ scroll  tab move  esc hide'])
})

test('a widget layout another session saves redraws here once the store-changed stamp moves', async () => {
  const onDashboard = { areas: { abovePrompt: [], belowPrompt: [], working: [], turnEnd: [], dashboard: [{ left: ['git/branch'], right: [] }] }, hidden: [] }
  const tested = testMod(cmodPlugin, { state: bound, files: { [`${store}/widgets.json`]: JSON.stringify(onDashboard) }, dependencies: { git: gitWidgets } })
  const { tick } = watchedStore(tested)
  await tested.hotkey('sidebar')
  await tested.shown.pane.lines()
  await tested.settle()
  expect((await tested.shown.pane.lines()).join('\n')).toContain('main, 74 columns')

  await writeStoreFile(tested, `${store}/widgets.json`, JSON.stringify({ ...onDashboard, areas: { ...onDashboard.areas, belowPrompt: [{ left: ['git/branch'], right: [] }], dashboard: [] } }))
  await tick()

  expect((await tested.shown.pane.lines()).join('\n')).not.toContain('main, 74 columns')
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
