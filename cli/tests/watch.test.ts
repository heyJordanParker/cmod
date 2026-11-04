import { afterAll, expect, test } from 'bun:test'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { chmod, mkdir, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { version } from '../package.json'
import { cmodFromSource, deleteTemporaryHomes, startCmod, temporaryHome, writeFiles, writeLinked } from './cmod.js'

afterAll(deleteTemporaryHomes)

const store = (home: string, file: string) => join(home, '.local/share/cmod', file)

test.concurrent('cmod watch marks plugins-changed with the checkout once a linked mod builds after it stops changing, and names a build still failing 10 seconds after the last change', async () => {
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
  const [mark, checkout] = (await readFile(store(home, 'plugins-changed'), 'utf8')).split('\n')
  expect(mark).toMatch(/^\d+ \d+$/)
  expect(checkout).toBe(realpathSync(root))
  watching.child.kill()
}, 60000)

test.concurrent('cmod watch reloads no session for a change only to files git ignores, such as the types Claude Code writes each time it loads the mod', async () => {
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

const programBuild = `trap 'rm -f .hello.bun-build' EXIT; touch .hello.bun-build; echo built >> "$HOME/builds"; mkdir -p dist && if grep -q broken message; then echo "error: expected ;" >&2; exit 1; fi; for machine in $CMOD_MACHINES; do printf '#!/bin/sh\\necho %s\\n' "$(cat message)" > dist/hello-$machine; done`

async function linkedProgramMod(home: string): Promise<string> {
  const root = join(home, 'Developer/hello-checkout')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.2.0' }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { program: 'hello' } }),
    'cli/package.json': JSON.stringify({ name: 'hello', bin: { hello: 'src/main.ts' }, cmod: { build: programBuild, output: 'dist' } }),
    'cli/src/main.ts': "import { greeting } from '../../src/greeting.ts'\nconsole.log(greeting)\n",
    'cli/message': 'first build\n',
    'src/greeting.ts': "export const greeting = 'hello'\n",
    'src/other.ts': "export const other = 'the mod alone reads this'\n",
  })
  await writeLinked(home, root)
  await writeFiles(home, { '.local/share/cmod/bin/hello/0.2.0/hello': '#!/bin/sh\necho first build\n' })
  await chmod(store(home, 'bin/hello/0.2.0/hello'), 0o755)
  await mkdir(store(home, 'programs'), { recursive: true })
  await symlink(store(home, 'bin/hello/0.2.0/hello'), store(home, 'programs/hello'))
  return root
}

const outputOf = (program: string) => new Response(Bun.spawn([program], { stdout: 'pipe' }).stdout).text()

async function watchingFolders(home: string): Promise<ReturnType<typeof startCmod>> {
  const watching = startCmod(home, 'watch')
  const heartbeat = store(home, `watch.lock/${watching.child.pid}`)
  await until(() => existsSync(heartbeat))
  const lockedAt = statSync(heartbeat).mtimeMs
  await until(() => statSync(heartbeat).mtimeMs > lockedAt)
  return watching
}

test.concurrent("cmod watch builds a linked mod's program again after a change at the same version, so the program in cmod's programs folder runs the new build", async () => {
  const home = await temporaryHome()
  const root = await linkedProgramMod(home)
  const watching = await watchingFolders(home)

  await writeFiles(root, { 'cli/message': 'second build\n' })
  await until(() => existsSync(store(home, 'plugins-changed')))
  expect(await outputOf(store(home, 'programs/hello'))).toBe('second build\n')
  watching.child.kill()
}, 60000)

test.concurrent("cmod watch names a linked mod whose program fails to build in build-failures.json, reloads no session, and leaves the old build in cmod's programs folder", async () => {
  const home = await temporaryHome()
  const root = await linkedProgramMod(home)
  const watching = await watchingFolders(home)

  await writeFiles(root, { 'cli/message': 'broken\n' })
  await until(() => existsSync(store(home, 'build-failures.json')))
  const failures = JSON.parse(await readFile(store(home, 'build-failures.json'), 'utf8')) as Record<string, string>
  expect(Object.keys(failures)).toEqual(['hello-mod'])
  expect(failures['hello-mod']).toStartWith(`Building hello with "${programBuild}" exited 1: error: expected ;.`)
  expect(existsSync(store(home, 'plugins-changed'))).toBe(false)
  expect(await outputOf(store(home, 'programs/hello'))).toBe('first build\n')

  await writeFiles(root, { 'README.md': 'a change outside the program\n' })
  await until(() => readFileSync(join(home, 'builds'), 'utf8') === 'built\nbuilt\n')
  await Bun.sleep(500)
  expect(existsSync(store(home, 'plugins-changed'))).toBe(false)
  expect(Object.keys(JSON.parse(await readFile(store(home, 'build-failures.json'), 'utf8')))).toEqual(['hello-mod'])
  watching.child.kill()
}, 60000)

test.concurrent("cmod watch reloads once for a change whose program build writes its output and a temporary file into the checkout", async () => {
  const home = await temporaryHome()
  const root = await linkedProgramMod(home)
  await writeFiles(root, { '.gitignore': 'cli/dist/\n' })
  expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0)
  const watching = await watchingFolders(home)

  await writeFiles(root, { 'cli/message': 'second build\n' })
  await until(() => existsSync(store(home, 'plugins-changed')))
  const mark = await readFile(store(home, 'plugins-changed'), 'utf8')
  await Bun.sleep(4000)
  expect(await readFile(store(home, 'plugins-changed'), 'utf8')).toBe(mark)
  watching.child.kill()
}, 60000)

test.concurrent("cmod watch keeps a linked mod's program file when a change builds the same program, so its running copy keeps running", async () => {
  const home = await temporaryHome()
  const root = await linkedProgramMod(home)
  const watching = await watchingFolders(home)
  await writeFiles(root, { 'cli/message': 'second build\n' })
  await until(() => existsSync(store(home, 'plugins-changed')))
  const built = statSync(store(home, 'bin/hello/0.2.0/hello'))
  const mark = await readFile(store(home, 'plugins-changed'), 'utf8')

  await writeFiles(root, { 'cli/notes.txt': 'a change the build does not use\n' })
  await until(() => readFileSync(store(home, 'plugins-changed'), 'utf8') !== mark)
  const kept = statSync(store(home, 'bin/hello/0.2.0/hello'))
  expect({ ino: kept.ino, mtimeMs: kept.mtimeMs }).toEqual({ ino: built.ino, mtimeMs: built.mtimeMs })
  expect(await readFile(join(home, 'builds'), 'utf8')).toBe('built\nbuilt\n')
  watching.child.kill()
  const { stderr } = await watching.done
  expect(stderr.match(/Installed hello/g)).toEqual(['Installed hello'])
  expect(stderr).not.toContain('PATH')
}, 60000)

test.concurrent("cmod watch builds a linked mod's program only for a change to a file its build reads: one in cli/, or one its entry imports", async () => {
  const home = await temporaryHome()
  const root = await linkedProgramMod(home)
  const watching = await watchingFolders(home)

  await writeFiles(root, { 'src/other.ts': "export const other = 'changed'\n", 'README.md': 'a change outside the program\n' })
  await until(() => existsSync(store(home, 'plugins-changed')))
  const mark = await readFile(store(home, 'plugins-changed'), 'utf8')
  expect(existsSync(join(home, 'builds'))).toBe(false)

  await writeFiles(root, { 'src/greeting.ts': "export const greeting = 'hi'\n" })
  await until(() => readFileSync(store(home, 'plugins-changed'), 'utf8') !== mark)
  expect(await readFile(join(home, 'builds'), 'utf8')).toBe('built\n')
  watching.child.kill()
}, 60000)

async function until(isDone: () => boolean): Promise<void> {
  const deadline = Date.now() + 20000
  while (!isDone()) {
    if (Date.now() > deadline) throw new Error('waited 20 seconds')
    await Bun.sleep(100)
  }
}

test.concurrent('cmod watch links a folder an older cmod put in CLAUDE_CODE_PLUGIN_DIRS as a marketplace, takes it out of the list, and watches it', async () => {
  const home = await temporaryHome()
  await writeFiles(home, {
    '.claude/settings.json': JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: '~/Developer/demo', CLAUDE_CODE_PLUGIN_DIR_WATCH: 'false' } }),
    'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    '.local/share/cmod/records/.keep': '',
  })
  const watching = startCmod(home, 'watch')
  await until(() => !readFileSync(join(home, '.claude/settings.json'), 'utf8').includes('CLAUDE_CODE_PLUGIN_DIRS'))

  expect(JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'))).toEqual({})
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toContain(`plugin marketplace add ${join(home, 'Developer')} --scope local\nplugin install demo@Developer-linked --json\n`)
  const heartbeat = store(home, `watch.lock/${watching.child.pid}`)
  const linkedAt = statSync(heartbeat).mtimeMs
  await until(() => statSync(heartbeat).mtimeMs > linkedAt)
  await writeFiles(home, { 'Developer/demo/hooks/hooks.json': JSON.stringify({ modules: ['./register.js'] }), 'Developer/demo/hooks/register.js': 'export function register() {}\n' })
  await until(() => existsSync(store(home, 'plugins-changed')))
  watching.child.kill()
}, 60000)

test.concurrent('a second cmod watch exits at once while the first one watches, and the first touches its lock file every 5 seconds', async () => {
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
  const firstTouch = statSync(lockFile(first.child.pid)).mtimeMs
  await until(() => statSync(lockFile(first.child.pid)).mtimeMs > firstTouch)
  expect(statSync(lockFile(first.child.pid)).mtimeMs - firstTouch).toBeGreaterThanOrEqual(4000)
  first.child.kill()
}, 60000)

test.concurrent('a cmod watch older than the newest cmod installed exits within one touch and lets go of watch.lock, so the cmod plugin starts the newer one', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { '.local/share/cmod/records/.keep': '' })
  const watching = startCmod(home, 'watch')
  await until(() => existsSync(store(home, `watch.lock/${watching.child.pid}`)))

  const newer = `${Number(version.split('.')[0]) + 1}.0.0`
  await writeFiles(home, { '.local/share/cmod/programs/cmod': cmodFromSource, [`.local/share/cmod/bin/cmod/${newer}/cmod`]: cmodFromSource })
  expect(await Promise.race([watching.child.exited, Bun.sleep(8000).then(() => 'still watching')])).toBe(0)
  expect(existsSync(store(home, 'watch.lock'))).toBe(false)
}, 60000)

test.concurrent('a cmod watch as new as the newest cmod installed keeps watching and touching its lock file', async () => {
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

test.concurrent('a cmod watch checks each build failure it finds at its start again, so a failure an older cmod wrote goes once the mod builds', async () => {
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
