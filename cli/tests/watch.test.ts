import { afterAll, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { version } from '../package.json'
import { cmodFromSource, deleteTemporaryHomes, startCmod, temporaryHome, writeFiles, writeLinked } from './cmod.js'

afterAll(deleteTemporaryHomes)

const store = (home: string, file: string) => join(home, '.local/share/cmod', file)

test('cmod watch reloads every session once a linked mod builds after it stops changing, and names a build still failing 10 seconds after the last change', async () => {
  const home = await temporaryHome()
  const root = join(home, 'Developer/demo-checkout')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'hooks/hooks.json': JSON.stringify({ modules: ['./register.js'] }),
    'hooks/register.js': 'export function register() {}\n',
  })
  await writeLinked(home, root)
  await writeFiles(home, { '.local/share/cmod/records/.keep': '' })
  const watching = startCmod(home, 'watch')
  await until(() => existsSync(store(home, `watch.lock/${watching.child.pid}`)))
  await Bun.sleep(500)

  await writeFiles(root, { 'hooks/register.js': 'export function register( {\n' })
  await Bun.sleep(3000)
  expect(existsSync(store(home, 'plugins-changed'))).toBe(false)
  expect(existsSync(store(home, 'build-failures.json'))).toBe(false)
  await until(() => existsSync(store(home, 'build-failures.json')))
  expect(Object.keys(JSON.parse(await readFile(store(home, 'build-failures.json'), 'utf8')))).toEqual(['demo'])
  expect(existsSync(store(home, 'plugins-changed'))).toBe(false)
  await until(() => existsSync(store(home, 'store-changed')))

  await writeFiles(root, { 'hooks/register.js': 'export function register() {}\n' })
  await until(() => existsSync(store(home, 'plugins-changed')))
  expect(existsSync(store(home, 'build-failures.json'))).toBe(false)
  watching.child.kill()
}, 60000)

test('cmod watch reloads no session for a change only to files git ignores, such as the types Claude Code writes each time it loads the mod', async () => {
  const home = await temporaryHome()
  const root = join(home, 'Developer/demo-checkout')
  await writeFiles(root, {
    '.gitignore': '.claude-plugin/types/\n',
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'hooks/hooks.json': JSON.stringify({ modules: ['./register.js'] }),
    'hooks/register.js': 'export function register() {}\n',
  })
  expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0)
  await writeLinked(home, root)
  await writeFiles(home, { '.local/share/cmod/records/.keep': '' })
  const watching = startCmod(home, 'watch')
  await until(() => existsSync(store(home, `watch.lock/${watching.child.pid}`)))
  await Bun.sleep(500)

  await writeFiles(root, { '.claude-plugin/types/claude-code/index.d.ts': 'export {}\n' })
  await Bun.sleep(3500)
  expect(existsSync(store(home, 'plugins-changed'))).toBe(false)

  await writeFiles(root, { 'hooks/register.js': 'export function register() { return }\n' })
  await until(() => existsSync(store(home, 'plugins-changed')))
  watching.child.kill()
}, 60000)

async function until(isDone: () => boolean): Promise<void> {
  const deadline = Date.now() + 20000
  while (!isDone()) {
    if (Date.now() > deadline) throw new Error('waited 20 seconds')
    await Bun.sleep(100)
  }
}

test('cmod watch links a folder an older cmod put in CLAUDE_CODE_PLUGIN_DIRS as a marketplace, takes it out of the list, and watches it', async () => {
  const home = await temporaryHome()
  await writeFiles(home, {
    '.claude/settings.json': JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: '~/Developer/demo', CLAUDE_CODE_PLUGIN_DIR_WATCH: 'false' } }),
    'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    '.local/share/cmod/records/.keep': '',
  })
  const watching = startCmod(home, 'watch')
  await until(() => !readFileSync(join(home, '.claude/settings.json'), 'utf8').includes('CLAUDE_CODE_PLUGIN_DIRS'))

  expect(JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'))).toEqual({})
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toContain(`plugin marketplace add ${join(home, 'Developer')}\nplugin install demo@Developer-linked --json\n`)
  const heartbeat = store(home, `watch.lock/${watching.child.pid}`)
  const linkedAt = statSync(heartbeat).mtimeMs
  await until(() => statSync(heartbeat).mtimeMs > linkedAt)
  await writeFiles(home, { 'Developer/demo/hooks/hooks.json': JSON.stringify({ modules: ['./register.js'] }), 'Developer/demo/hooks/register.js': 'export function register() {}\n' })
  await until(() => existsSync(store(home, 'plugins-changed')))
  watching.child.kill()
}, 60000)

test('a second cmod watch exits at once while the first one watches, and the first touches its lock file every 5 seconds', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { '.local/share/cmod/records/.keep': '' })
  const lockFile = (pid: number) => join(home, '.local/share/cmod/watch.lock', String(pid))
  const first = startCmod(home, 'watch')
  await until(() => existsSync(lockFile(first.child.pid)))
  const touchedAt = statSync(lockFile(first.child.pid)).mtimeMs
  const second = startCmod(home, 'watch')

  expect(await second.child.exited).toBe(0)
  expect(existsSync(lockFile(second.child.pid))).toBe(false)
  await until(() => statSync(lockFile(first.child.pid)).mtimeMs > touchedAt)
  first.child.kill()
}, 60000)

test('a cmod watch older than the newest cmod installed exits within one touch and lets go of watch.lock, so the cmod plugin starts the newer one', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { '.local/share/cmod/records/.keep': '' })
  const watching = startCmod(home, 'watch')
  await until(() => existsSync(store(home, `watch.lock/${watching.child.pid}`)))

  const newer = `${Number(version.split('.')[0]) + 1}.0.0`
  await writeFiles(home, { '.local/share/cmod/programs/cmod': cmodFromSource, [`.local/share/cmod/bin/cmod/${newer}/cmod`]: cmodFromSource })
  expect(await Promise.race([watching.child.exited, Bun.sleep(8000).then(() => 'still watching')])).toBe(0)
  expect(existsSync(store(home, 'watch.lock'))).toBe(false)
}, 60000)

test('a cmod watch as new as the newest cmod installed keeps watching and touching its lock file', async () => {
  const home = await temporaryHome()
  await writeFiles(home, {
    '.local/share/cmod/records/.keep': '',
    '.local/share/cmod/programs/cmod': cmodFromSource,
    '.local/share/cmod/bin/cmod/0.1.0/cmod': cmodFromSource,
    [`.local/share/cmod/bin/cmod/${version}/cmod`]: cmodFromSource,
  })
  const watching = startCmod(home, 'watch')
  const lockFile = store(home, `watch.lock/${watching.child.pid}`)
  await until(() => existsSync(lockFile))
  const touchedAt = statSync(lockFile).mtimeMs

  await until(() => statSync(lockFile).mtimeMs > touchedAt)
  await Bun.sleep(500)
  expect(watching.child.exitCode).toBeNull()
  expect(existsSync(lockFile)).toBe(true)
  watching.child.kill()
}, 60000)

test('a cmod watch checks each build failure it finds at its start again, so a failure an older cmod wrote goes once the mod builds', async () => {
  const home = await temporaryHome()
  const root = join(home, 'Developer/demo-checkout')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'hooks/hooks.json': JSON.stringify({ modules: ['./register.js'] }),
    'hooks/register.js': 'export function register() {}\n',
  })
  await writeLinked(home, root)
  await writeFiles(home, { '.local/share/cmod/build-failures.json': JSON.stringify({ demo: 'a rule of an older cmod' }) })
  const watching = startCmod(home, 'watch')

  await until(() => existsSync(store(home, 'plugins-changed')))
  expect(existsSync(store(home, 'build-failures.json'))).toBe(false)
  watching.child.kill()
}, 60000)
