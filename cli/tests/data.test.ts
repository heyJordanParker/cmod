import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { cmod, deleteTemporaryHomes, spawningTestLimitMs, temporaryHome, writeFiles } from './cmod.js'

setDefaultTimeout(spawningTestLimitMs)
afterAll(deleteTemporaryHomes)

const record = (name: string) => JSON.stringify({ name, version: '0.1.0', root: `/cache/${name}`, installedAt: '2026-11-19T10:00:00.000Z', scriptsSha256: '', uninstall: null, program: null, keys: {} })

test('cmod data prints the data folder of each mod cmod set up, and leaves out a mod with no data folder and a data folder with no mod', async () => {
  const home = await temporaryHome()
  const store = join(home, '.local/share/cmod')
  await writeFiles(store, {
    'records/chat.json': record('chat'),
    'records/notes.json': record('notes'),
    'records/plain.json': record('plain'),
    'data/chat/history.db': 'chat\n',
    'data/notes/notes.md': 'notes\n',
    'data/orphan/left.txt': 'left\n',
  })

  const json = await cmod(home, 'data', '--json')
  const lines = await cmod(home, 'data')

  expect(json.exitCode).toBe(0)
  expect(JSON.parse(json.stdout)).toEqual([
    { mod: 'chat', folder: join(store, 'data/chat') },
    { mod: 'notes', folder: join(store, 'data/notes') },
  ])
  expect(lines.exitCode).toBe(0)
  expect(lines.stdout).toBe(`chat ${join(store, 'data/chat')}\nnotes ${join(store, 'data/notes')}\n`)
})

test("cmod data lists the cmod plugin's own data folder, with its goals, tasks, and Log, though the cmod plugin has no install record", async () => {
  const home = await temporaryHome()
  const store = join(home, '.local/share/cmod')
  await writeFiles(store, { 'records/chat.json': record('chat'), 'data/chat/history.db': 'chat\n', 'data/cmod/goals/s1.txt': 'Ship cmod data\n' })

  const json = await cmod(home, 'data', '--json')

  expect(json.exitCode).toBe(0)
  expect(JSON.parse(json.stdout)).toEqual([
    { mod: 'chat', folder: join(store, 'data/chat') },
    { mod: 'cmod', folder: join(store, 'data/cmod') },
  ])
})

test('cmod data --json prints an empty list when cmod set up no mod', async () => {
  const home = await temporaryHome()

  const json = await cmod(home, 'data', '--json')

  expect(json.exitCode).toBe(0)
  expect(JSON.parse(json.stdout)).toEqual([])
})
