import { afterAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { lstat, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readRecord } from '@cmodjs/core/src/records.js'
import { readText } from '../src/files.js'
import { cmod, cmodWith, deleteTemporaryHomes, hashOf, temporaryHome, writeFiles } from './cmod.js'

afterAll(deleteTemporaryHomes)

const cycle = { title: 'Switch mode', default: 'shift+tab' }
const review = { title: 'Review', default: 'alt+m' }
const clear = { title: 'Clear', default: 'ctrl+k' }

async function createHotkeysMod(home: string, hotkeys: Record<string, unknown>): Promise<string> {
  const root = join(home, 'demo')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo', cmod: { hotkeys } }),
  })
  return root
}

const keybindings = (home: string) => join(home, '.claude/keybindings.json')

test('setup binds the mod hotkeys in the Chat bindings, keeps a combo the person bound, and teardown removes only the combos that still run its hotkeys', async () => {
  const home = await temporaryHome()
  const root = await createHotkeysMod(home, { cycle, review, clear })
  await writeFiles(home, { '.claude/keybindings.json': `{\n  "bindings": [\n    { "context": "Chat", "bindings": { "ctrl+k": "chat:clearInput" } }\n  ]\n}\n` })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toBe('log ~/.claude/keybindings.json binds ctrl+k to "chat:clearInput", so it stays, and the demo hotkey clear has no combo. Pick one for it in Settings.\ndone demo 0.1.0\n')
  expect(JSON.parse(await readFile(keybindings(home), 'utf8'))).toEqual({ bindings: [{ context: 'Chat', bindings: { 'ctrl+k': 'chat:clearInput', 'shift+tab': 'command:demo--cycle', 'alt+m': 'command:demo--review' } }] })
  expect((await readRecord(readText, join(home, '.local/share/cmod'), 'demo'))?.keys).toEqual({ 'shift+tab': 'demo--cycle', 'alt+m': 'demo--review' })

  const edited = JSON.parse(await readFile(keybindings(home), 'utf8'))
  edited.bindings[0].bindings['alt+m'] = 'command:review'
  await writeFiles(home, { '.claude/keybindings.json': JSON.stringify(edited) })
  expect((await cmod(home, 'teardown', 'demo')).exitCode).toBe(0)

  expect(JSON.parse(await readFile(keybindings(home), 'utf8'))).toEqual({ bindings: [{ context: 'Chat', bindings: { 'ctrl+k': 'chat:clearInput', 'alt+m': 'command:review' } }] })
})

test('an update from cmod 3 moves the key its record bound to a slash command onto the hotkey that declares that combo', async () => {
  const home = await temporaryHome()
  const root = await createHotkeysMod(home, { review })
  await cmod(home, 'setup', root, '--events')
  const recordFile = join(home, '.local/share/cmod/records/demo.json')
  const record = JSON.parse(await readFile(recordFile, 'utf8'))
  await writeFiles(home, { '.local/share/cmod/records/demo.json': JSON.stringify({ ...record, keys: { 'alt+m': 'review-demo' } }), '.claude/keybindings.json': '{ "bindings": [{ "context": "Chat", "bindings": { "alt+m": "command:review-demo" } }] }\n' })
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }) })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toBe('done demo 0.2.0\n')
  expect(JSON.parse(await readFile(keybindings(home), 'utf8'))).toEqual({ bindings: [{ context: 'Chat', bindings: { 'alt+m': 'command:demo--review' } }] })
})

test('cmod hotkey moves a hotkey to another combo, an update keeps it, and a combo taken by something else fails', async () => {
  const home = await temporaryHome()
  const root = await createHotkeysMod(home, { cycle, review })
  await writeFiles(home, { '.claude/keybindings.json': '{ "bindings": [{ "context": "Chat", "bindings": { "ctrl+k": "chat:clearInput" } }] }\n' })
  await cmod(home, 'setup', root, '--events')

  const moved = await cmod(home, 'hotkey', 'demo', 'cycle', 'ctrl+e')
  const taken = await cmod(home, 'hotkey', 'demo', 'review', 'ctrl+k')
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }) })
  await cmod(home, 'setup', root, '--events')

  expect(moved.stdout).toBe('Bound ctrl+e to Switch mode for demo.\n')
  expect(taken.stderr).toBe('cmod hotkey: ctrl+k already runs something else in ~/.claude/keybindings.json. Pick another combo.\n')
  expect(JSON.parse(await readFile(keybindings(home), 'utf8'))).toEqual({ bindings: [{ context: 'Chat', bindings: { 'ctrl+k': 'chat:clearInput', 'alt+m': 'command:demo--review', 'ctrl+e': 'command:demo--cycle' } }] })
  expect((await readRecord(readText, join(home, '.local/share/cmod'), 'demo'))?.keys).toEqual({ 'ctrl+e': 'demo--cycle', 'alt+m': 'demo--review' })
})

test('cmod hotkey given a plugin folder binds the hotkey of a mod that has no install record, as a --plugin-dir cmod plugin', async () => {
  const home = await temporaryHome()
  const root = await createHotkeysMod(home, { cycle })

  const bound = await cmod(home, 'hotkey', root, 'cycle', 'ctrl+e')

  expect(bound).toMatchObject({ stdout: 'Bound ctrl+e to Switch mode for demo.\n', exitCode: 0 })
  expect(JSON.parse(await readFile(keybindings(home), 'utf8'))).toEqual({ bindings: [{ context: 'Chat', bindings: { 'ctrl+e': 'command:demo--cycle' } }] })
  expect(await readRecord(readText, join(home, '.local/share/cmod'), 'demo')).toBeUndefined()
})

test('an update whose new hotkey defaults to a combo the person rebound keeps the person’s combo and leaves the new hotkey unbound', async () => {
  const home = await temporaryHome()
  const root = await createHotkeysMod(home, { cycle })
  await cmod(home, 'setup', root, '--events')
  await cmod(home, 'hotkey', 'demo', 'cycle', 'alt+m')
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }), 'package.json': JSON.stringify({ name: 'demo', cmod: { hotkeys: { cycle, review } } }) })

  await cmod(home, 'setup', root, '--events')

  expect((await readRecord(readText, join(home, '.local/share/cmod'), 'demo'))?.keys).toEqual({ 'alt+m': 'demo--cycle' })
})

test('a combo the person rebinds by hand in keybindings.json survives an update, and teardown removes it', async () => {
  const home = await temporaryHome()
  const root = await createHotkeysMod(home, { cycle, review })
  await cmod(home, 'setup', root, '--events')
  await writeFiles(home, { '.claude/keybindings.json': JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'shift+tab': 'command:demo--cycle', 'alt+n': 'command:demo--review' } }] }) })

  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }) })
  await cmod(home, 'setup', root, '--events')
  const updated = JSON.parse(await readFile(keybindings(home), 'utf8'))
  await cmod(home, 'teardown', 'demo')

  expect(updated).toEqual({ bindings: [{ context: 'Chat', bindings: { 'shift+tab': 'command:demo--cycle', 'alt+n': 'command:demo--review' } }] })
  expect(JSON.parse(await readFile(keybindings(home), 'utf8'))).toEqual({ bindings: [] })
})

test('setup writes keybindings.json under CLAUDE_CONFIG_DIR through its symbolic link, adding a Chat block when none exists', async () => {
  const home = await temporaryHome()
  const root = await createHotkeysMod(home, { cycle })
  await writeFiles(home, { 'shared/keybindings.json': '{ "bindings": [{ "context": "Global", "bindings": { "ctrl+t": "app:toggleTodos" } }] }\n' })
  await writeFiles(home, { 'config/.keep': '' })
  await symlink(join(home, 'shared/keybindings.json'), join(home, 'config/keybindings.json'))

  const result = await cmodWith(home, { CLAUDE_CONFIG_DIR: join(home, 'config') }, 'setup', root, '--events')

  expect(result.stdout).toBe('done demo 0.1.0\n')
  expect((await lstat(join(home, 'config/keybindings.json'))).isSymbolicLink()).toBe(true)
  expect(JSON.parse(await readFile(join(home, 'shared/keybindings.json'), 'utf8'))).toEqual({
    bindings: [
      { context: 'Global', bindings: { 'ctrl+t': 'app:toggleTodos' } },
      { context: 'Chat', bindings: { 'shift+tab': 'command:demo--cycle' } },
    ],
  })
})

test('an upgrade that drops a hotkey removes its binding, and a hotkey with a new default binds it', async () => {
  const home = await temporaryHome()
  const root = await createHotkeysMod(home, { cycle, review })
  await cmod(home, 'setup', root, '--events')
  await createHotkeysMod(home, { cycle })

  const dropped = await cmod(home, 'setup', root, '--events')
  const bound = JSON.parse(await readFile(keybindings(home), 'utf8'))
  await createHotkeysMod(home, { cycle, review: { ...review, default: 'alt+r' } })
  const changed = await cmod(home, 'setup', root, '--events')

  expect(dropped).toMatchObject({ stdout: 'done demo 0.1.0\n', exitCode: 0 })
  expect(bound).toEqual({ bindings: [{ context: 'Chat', bindings: { 'shift+tab': 'command:demo--cycle' } }] })
  expect(changed).toMatchObject({ stdout: 'done demo 0.1.0\n', exitCode: 0 })
  expect(JSON.parse(await readFile(keybindings(home), 'utf8'))).toEqual({ bindings: [{ context: 'Chat', bindings: { 'shift+tab': 'command:demo--cycle', 'alt+r': 'command:demo--review' } }] })
})

test('teardown removes a Chat block it leaves empty, and keeps the other blocks', async () => {
  const home = await temporaryHome()
  const root = await createHotkeysMod(home, { cycle })
  await writeFiles(home, { '.claude/keybindings.json': '{ "bindings": [{ "context": "Global", "bindings": { "ctrl+t": "app:toggleTodos" } }] }\n' })
  await cmod(home, 'setup', root, '--events')

  expect((await cmod(home, 'teardown', 'demo')).exitCode).toBe(0)

  expect(JSON.parse(await readFile(keybindings(home), 'utf8'))).toEqual({ bindings: [{ context: 'Global', bindings: { 'ctrl+t': 'app:toggleTodos' } }] })
})

test('a hotkey default that is not a combo is refused', async () => {
  const home = await temporaryHome()
  const root = await createHotkeysMod(home, { cycle: { title: 'Switch mode', default: 'tab' } })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toBe(`failed 1\t${root}: package.json "cmod": hotkeys.cycle defaults to "tab", which is not a combo. Give one or two of ctrl, alt, shift, meta in that order, then a key, such as "ctrl+q" or "ctrl+shift+k".\n`)
  expect(existsSync(keybindings(home))).toBe(false)
})

const next = { title: 'Open the next item' }

test('setup binds only the hotkeys with a default, and approves only them', async () => {
  const home = await temporaryHome()
  const root = await createHotkeysMod(home, { cycle, next })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toBe('done demo 0.1.0\n')
  expect(JSON.parse(await readFile(keybindings(home), 'utf8'))).toEqual({ bindings: [{ context: 'Chat', bindings: { 'shift+tab': 'command:demo--cycle' } }] })
  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/consent.json'), 'utf8'))).toEqual({ demo: [await hashOf(root), 'hotkey:cycle=shift+tab'] })
})

test('cmod hotkey binds a hotkey without a default, and an update that adds another one keeps it without asking', async () => {
  const home = await temporaryHome()
  const root = await createHotkeysMod(home, { next })
  const installed = await cmod(home, 'setup', root, '--events')

  const bound = await cmod(home, 'hotkey', 'demo', 'next', 'ctrl+n')
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }), 'package.json': JSON.stringify({ name: 'demo', cmod: { hotkeys: { next, previous: { title: 'Open the previous item' } } } }) })
  const updated = await cmod(home, 'setup', root, '--events')

  expect(installed).toMatchObject({ stdout: 'done demo 0.1.0\n', exitCode: 0 })
  expect(bound.stdout).toBe('Bound ctrl+n to Open the next item for demo.\n')
  expect(updated).toMatchObject({ stdout: 'done demo 0.2.0\n', exitCode: 0 })
  expect(JSON.parse(await readFile(keybindings(home), 'utf8'))).toEqual({ bindings: [{ context: 'Chat', bindings: { 'ctrl+n': 'command:demo--next' } }] })
  expect((await readRecord(readText, join(home, '.local/share/cmod'), 'demo'))?.keys).toEqual({ 'ctrl+n': 'demo--next' })
})
