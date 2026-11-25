import { afterAll, expect, jest, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rm, symlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { version } from '../package.json'
import { changesOf, checkoutFiles, linkedChanges, pollWhile } from '../src/commands/watch.js'
import { observe } from '../src/observer.js'
import { captured, cmodExecutable, deleteTemporaryHomes, environment, servedChanges, spawned, spawningTestLimitMs, startCmod, temporaryHome, writeFiles, writeLinked } from './cmod.js'

setDefaultTimeout(spawningTestLimitMs)
afterAll(deleteTemporaryHomes)

const store = (home: string, file = '') => join(home, '.local/share/cmod', file)

const demoHooks = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
  'hooks/hooks.json': JSON.stringify({ modules: ['./register.js'] }),
  'hooks/register.js': 'export function register() {}\n',
}

const markOf = (text: string, mod: string) => Number(new RegExp(`^\\n(\\d+) ${mod}\\n$`).exec(text)?.[1])

async function watchingFolders(home: string, checkout: string): Promise<ReturnType<typeof startCmod>> {
  const watching = startCmod(home, 'watch')
  await watching.waitForOutput(`cmod watch: watching ${checkout}`)
  return watching
}

async function storeChanges(home: string, part: string): Promise<() => Promise<unknown>> {
  return (await servedChanges(home)).listen('cmod/Store', { part })
}

test.concurrent("cmod watch hears a linked mod's change through the file system, writes the time of the change to plugins-changed once the mod builds, and tells cmod/Store", async () => {
  const home = await temporaryHome()
  const root = join(home, 'Developer/demo-checkout')
  await writeFiles(root, demoHooks)
  await writeLinked(home, root)
  await writeFiles(home, { '.local/share/cmod/records/.keep': '' })
  const pluginsChanged = await storeChanges(home, 'plugins')
  const watching = await watchingFolders(home, root)

  await writeFiles(root, { 'hooks/register.js': 'export function register() { return }\n' })
  const changedAt = Math.trunc(statSync(join(root, 'hooks/register.js')).mtimeMs)
  expect(await pluginsChanged()).toEqual({ part: 'plugins' })

  expect(markOf(await readFile(store(home, 'plugins-changed'), 'utf8'), 'demo')).toBeGreaterThanOrEqual(changedAt)
  expect(existsSync(store(home, 'build-failures.json'))).toBe(false)
  watching.child.kill()
})

const programBuild = `touch ".$(printf '%016x' $$)-00000000.bun-build"; echo built >> "$HOME/builds"; mkdir -p dist && if grep -q broken message; then echo "error: expected ;" >&2; exit 1; fi; for machine in $CMOD_MACHINES; do printf '#!/bin/sh\\necho %s\\n' "$(cat message)" > dist/hello-$machine; done`

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
  await writeFiles(home, { '.local/share/cmod/bin/hello/0.2.0/hello.linked': '#!/bin/sh\necho first build\n' })
  await chmod(store(home, 'bin/hello/0.2.0/hello.linked'), 0o755)
  await mkdir(store(home, 'programs'), { recursive: true })
  await symlink(store(home, 'bin/hello/0.2.0/hello.linked'), store(home, 'programs/hello'))
  return root
}

const outputOf = (program: string) => new Response(spawned([program], { stdout: 'pipe' }).stdout).text()

const builds = (home: string) => readFileSync(join(home, 'builds'), 'utf8')

const changedMarks = (home: string) => readFileSync(store(home, 'plugins-changed'), 'utf8')

test.concurrent("cmod watch builds a linked mod's program again after a change at the same version, so the program in cmod's programs folder runs the new build", async () => {
  const home = await temporaryHome()
  const root = await linkedProgramMod(home)
  const pluginsChanged = await storeChanges(home, 'plugins')
  const watching = await watchingFolders(home, root)

  await writeFiles(root, { 'cli/message': 'second build\n' })
  await pluginsChanged()
  expect(await outputOf(store(home, 'programs/hello'))).toBe('second build\n')
  watching.child.kill()
})

test.concurrent("cmod watch names a linked mod whose program fails to build in build-failures.json, reloads no session, and leaves the old build in cmod's programs folder", async () => {
  const home = await temporaryHome()
  const root = await linkedProgramMod(home)
  const failuresChanged = await storeChanges(home, 'buildFailures')
  const watching = await watchingFolders(home, root)
  const failuresFile = store(home, 'build-failures.json')

  await writeFiles(root, { 'cli/message': 'broken\n' })
  await failuresChanged()
  const failures = JSON.parse(await readFile(failuresFile, 'utf8')) as Record<string, string>
  expect(Object.keys(failures)).toEqual(['hello-mod'])
  expect(failures['hello-mod']).toStartWith(`Building hello with "${programBuild}" exited 1: error: expected ;.`)
  expect(existsSync(store(home, 'plugins-changed'))).toBe(false)
  expect(await outputOf(store(home, 'programs/hello'))).toBe('first build\n')

  await writeFiles(root, { 'README.md': 'a change outside the program\n' })
  await failuresChanged()
  expect(builds(home)).toBe('built\nbuilt\n')
  expect(existsSync(store(home, 'plugins-changed'))).toBe(false)
  expect(Object.keys(JSON.parse(await readFile(failuresFile, 'utf8')))).toEqual(['hello-mod'])
  watching.child.kill()
})

test.concurrent("cmod watch builds once and reloads once for a change whose program build writes its output and leaves Bun's temporary file in the checkout, and deletes that file", async () => {
  const home = await temporaryHome()
  const root = await linkedProgramMod(home)
  await writeFiles(root, { '.gitignore': 'cli/dist/\n' })
  expect((await captured(['git', 'init', '-q', root])).exitCode).toBe(0)
  const pluginsChanged = await storeChanges(home, 'plugins')
  const watching = await watchingFolders(home, root)

  await writeFiles(root, { 'cli/message': 'second build\n' })
  await pluginsChanged()
  await writeFiles(root, { 'README.md': 'a change the build does not read\n' })
  const readmeAt = Math.trunc(statSync(join(root, 'README.md')).mtimeMs)
  await pluginsChanged()

  expect(markOf(changedMarks(home), 'hello-mod')).toBeGreaterThanOrEqual(readmeAt)
  expect(builds(home)).toBe('built\n')
  expect((await readdir(join(root, 'cli'))).filter((name) => name.endsWith('.bun-build'))).toEqual([])
  watching.child.kill()
})

test.concurrent("cmod watch keeps a linked mod's program file when a change builds the same program, so its running copy keeps running", async () => {
  const home = await temporaryHome()
  const root = await linkedProgramMod(home)
  const pluginsChanged = await storeChanges(home, 'plugins')
  const watching = await watchingFolders(home, root)
  await writeFiles(root, { 'cli/message': 'second build\n' })
  await pluginsChanged()
  const built = statSync(store(home, 'bin/hello/0.2.0/hello.linked'))

  await writeFiles(root, { 'cli/notes.txt': 'a change the build does not use\n' })
  await pluginsChanged()
  const kept = statSync(store(home, 'bin/hello/0.2.0/hello.linked'))
  expect({ ino: kept.ino, mtimeMs: kept.mtimeMs }).toEqual({ ino: built.ino, mtimeMs: built.mtimeMs })
  expect(builds(home)).toBe('built\nbuilt\n')
  watching.child.kill()
  const { stderr } = await watching.done
  expect(stderr.match(/Installed hello/g)).toEqual(['Installed hello'])
  expect(stderr).not.toContain('PATH')
})

test.concurrent("cmod watch builds a linked mod's program only for a change to a file its build reads: one in cli/, or one its entry imports", async () => {
  const home = await temporaryHome()
  const root = await linkedProgramMod(home)
  const pluginsChanged = await storeChanges(home, 'plugins')
  const watching = await watchingFolders(home, root)

  await writeFiles(root, { 'src/other.ts': "export const other = 'changed'\n", 'README.md': 'a change outside the program\n' })
  await pluginsChanged()
  expect(existsSync(join(home, 'builds'))).toBe(false)

  await writeFiles(root, { 'src/greeting.ts': "export const greeting = 'hi'\n" })
  await pluginsChanged()
  expect(builds(home)).toBe('built\n')
  watching.child.kill()
})

test.concurrent('cmod watch links a folder an older cmod put in CLAUDE_CODE_PLUGIN_DIRS as a marketplace, so it watches it, and takes it out of the list', async () => {
  const home = await temporaryHome()
  await writeFiles(home, {
    '.claude/settings.json': JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: '~/Developer/demo', CLAUDE_CODE_PLUGIN_DIR_WATCH: 'false' } }),
    'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    '.local/share/cmod/records/.keep': '',
  })
  const watching = await watchingFolders(home, join(home, 'Developer/demo'))

  expect(JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'))).toEqual({})
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toContain(`plugin marketplace add ${join(home, 'Developer')} --scope local\nplugin install demo@Developer-linked --json\n`)
  expect(JSON.parse(await readFile(store(home, 'links.json'), 'utf8'))).toMatchObject({ marketplaces: { 'Developer-linked': join(home, 'Developer') } })
  watching.child.kill()
})

test.concurrent('a second cmod watch exits at once while the first one watches, and the first keeps its lock', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { '.local/share/cmod/records/.keep': '' })
  const lockFile = (pid: number) => store(home, `watch.lock/${pid}`)
  const first = startCmod(home, 'watch')
  await first.waitForOutput('cmod watch: watching no linked checkout')
  const second = startCmod(home, 'watch')

  expect(await second.child.exited).toBe(0)
  expect(existsSync(lockFile(second.child.pid))).toBe(false)
  expect(existsSync(lockFile(first.child.pid))).toBe(true)
  expect(first.child.exitCode).toBeNull()
  first.child.kill()
})

test.concurrent('cmod watch exits and lets go of watch.lock when its parent process dies, so a crashed session leaves no watcher behind', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { 'bin/cmod': cmodExecutable, '.local/share/cmod/records/.keep': '' })
  const parent = spawned(['sh', '-c', 'cmod watch & wait'], { cwd: home, env: environment(home), stdout: 'ignore', stderr: 'pipe' })
  const output = parent.stderr.getReader()
  const decoder = new TextDecoder()
  let printed = ''
  while (!printed.includes('cmod watch: watching')) printed += decoder.decode((await output.read()).value, { stream: true })
  expect(existsSync(store(home, 'watch.lock'))).toBe(true)

  parent.kill('SIGKILL')
  while (!(await output.read()).done);

  expect(existsSync(store(home, 'watch.lock'))).toBe(false)
})

test.concurrent('a cmod watch exits and lets go of watch.lock once cmod/Store tells that the plugins changed and a newer cmod is installed, so the cmod plugin starts the newer one', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { '.local/share/cmod/records/.keep': '' })
  const serve = await servedChanges(home)
  const watching = startCmod(home, 'watch')
  await watching.waitForOutput('cmod watch: watching')

  const newer = `${Number(version.split('.')[0]) + 1}.0.0`
  await writeFiles(home, { '.local/share/cmod/programs/cmod': cmodExecutable, [`.local/share/cmod/bin/cmod/${newer}/cmod`]: cmodExecutable })
  await serve.tell('cmod/Store', 'changed', ['plugins'])
  expect(await watching.child.exited).toBe(0)
  expect(existsSync(store(home, 'watch.lock'))).toBe(false)
})

test.concurrent('cmod watch watches a checkout linked while it runs once cmod/Store tells that the links changed', async () => {
  const home = await temporaryHome()
  const root = join(home, 'Developer/demo-checkout')
  await writeFiles(root, demoHooks)
  await writeFiles(home, { '.local/share/cmod/records/.keep': '' })
  const serve = await servedChanges(home)
  const watching = startCmod(home, 'watch')
  await watching.waitForOutput('cmod watch: watching no linked checkout')

  await writeLinked(home, root)
  await serve.tell('cmod/Store', 'changed', ['links'])

  await watching.waitForOutput(`cmod watch: watching ${root}`)
  watching.child.kill()
})

test.concurrent('a cmod watch as new as the newest cmod installed keeps watching and holding its lock', async () => {
  const home = await temporaryHome()
  await writeFiles(home, {
    '.local/share/cmod/records/.keep': '',
    '.local/share/cmod/programs/cmod': cmodExecutable,
    '.local/share/cmod/bin/cmod/0.1.0/cmod': cmodExecutable,
    [`.local/share/cmod/bin/cmod/${version}/cmod`]: cmodExecutable,
  })
  const watching = startCmod(home, 'watch')
  const lockFile = store(home, `watch.lock/${watching.child.pid}`)
  await watching.waitForOutput('cmod watch: watching')

  expect(watching.child.exitCode).toBeNull()
  expect(existsSync(lockFile)).toBe(true)
  watching.child.kill()
})

test.concurrent('a cmod watch checks each build failure it finds at its start again, so a failure an older cmod wrote goes once the mod builds', async () => {
  const home = await temporaryHome()
  const root = join(home, 'Developer/demo-checkout')
  await writeFiles(root, demoHooks)
  await writeLinked(home, root)
  await writeFiles(home, { '.local/share/cmod/build-failures.json': JSON.stringify({ demo: 'a rule of an older cmod' }) })
  const pluginsChanged = await storeChanges(home, 'plugins')
  const watching = startCmod(home, 'watch')

  await pluginsChanged()
  expect(existsSync(store(home, 'build-failures.json'))).toBe(false)
  watching.child.kill()
})

const startedAt = Date.parse('2026-11-25T10:00:00.000Z')

async function onFakeClock(root: string, heard: (recorded: ReturnType<typeof recording>) => Promise<void>): Promise<void> {
  jest.useFakeTimers({ now: startedAt })
  const recorded = recording(root)
  try {
    await recorded.look()
    await heard(recorded)
  } finally {
    recorded.close()
    jest.useRealTimers()
  }
}

function recording(root: string) {
  const marks: { readonly mod: string; readonly at: number }[] = []
  const failed: Record<string, string>[] = []
  const changes = linkedChanges(new Map(), {
    failures: async (failures) => void failed.push(Object.fromEntries(failures)),
    changed: async (linked) => void marks.push(linked),
  })
  const observer = observe({
    folders: () => [],
    isRecursive: true,
    list: async () => (await checkoutFiles(root)).map((file) => join(root, file)),
    onChange: (observed) => changes.changed(root, changesOf(root, observed)),
    report: (error) => {
      throw error
    },
  })
  return {
    changes,
    marks,
    failed,
    look: () => observer.look(),
    close: () => {
      observer.close()
      changes.close()
    },
  }
}

async function changeAt(root: string, path: string, text: string, at = Date.now()): Promise<void> {
  await writeFiles(root, { [path]: text })
  await utimes(join(root, path), new Date(at), new Date(at))
}

async function demoCheckout(files: Record<string, string> = {}): Promise<string> {
  const root = join(await temporaryHome(), 'Developer/demo-checkout')
  await writeFiles(root, { ...demoHooks, ...files })
  return root
}

test('a change counts once its checkout has had no change for 2 seconds, at the modification time of the last file that changed', async () => {
  const root = await demoCheckout()
  await onFakeClock(root, async ({ changes, marks, look }) => {
    await changeAt(root, 'hooks/register.js', 'export function register() { return }\n')
    await look()
    jest.advanceTimersByTime(1500)
    await changeAt(root, 'hooks/register.js', 'export function register() { return 1 }\n')
    await look()

    jest.advanceTimersByTime(1999)
    await changes.settled()
    expect(marks).toEqual([])

    jest.advanceTimersByTime(1)
    await changes.settled()
    expect(marks).toEqual([{ mod: 'demo', at: startedAt + 1500 }])
  })
})

test('a look that finds every file as the last look found it counts nothing', async () => {
  const root = await demoCheckout()
  await onFakeClock(root, async ({ changes, marks, look }) => {
    await look()
    jest.advanceTimersByTime(2000)
    await changes.settled()
    expect(marks).toEqual([])
  })
})

test('a build still failing 10 seconds after the last change is written to the failures, and a change that builds takes it out and counts', async () => {
  const root = await demoCheckout()
  await onFakeClock(root, async ({ changes, marks, failed, look }) => {
    await changeAt(root, 'hooks/register.js', 'export function register( {\n')
    await look()
    jest.advanceTimersByTime(2000)
    await changes.settled()

    jest.advanceTimersByTime(7999)
    expect(failed).toEqual([])
    jest.advanceTimersByTime(1)
    expect(failed).toEqual([{ demo: expect.stringContaining('Bundling hooks/') }])
    expect(marks).toEqual([])

    await changeAt(root, 'hooks/register.js', 'export function register() {}\n')
    await look()
    jest.advanceTimersByTime(2000)
    await changes.settled()
    expect(failed.at(-1)).toEqual({})
    expect(marks).toEqual([{ mod: 'demo', at: startedAt + 10000 }])
  })
})

test('a change only to files git ignores, to node_modules, or to an untracked file gone again counts nothing, and a change counts at the time of its last file git does not ignore', async () => {
  const root = await demoCheckout({ '.gitignore': '.claude-plugin/types/\n' })
  expect((await captured(['git', 'init', '-q', root])).exitCode).toBe(0)
  await onFakeClock(root, async ({ changes, marks, look }) => {
    await changeAt(root, '.claude-plugin/types/claude-code/index.d.ts', 'export {}\n')
    await changeAt(root, 'node_modules/demo/index.js', 'export {}\n')
    await changeAt(root, '.0000000000000001-00000000.bun-build', 'built\n')
    await look()
    await rm(join(root, '.0000000000000001-00000000.bun-build'))
    await look()
    jest.advanceTimersByTime(2000)
    await changes.settled()
    expect(marks).toEqual([])

    await changeAt(root, 'hooks/register.js', 'export function register() { return }\n')
    await look()
    jest.advanceTimersByTime(1000)
    await changeAt(root, '.claude-plugin/types/claude-code/index.d.ts', 'export type Reloaded = true\n')
    await look()
    jest.advanceTimersByTime(2000)
    await changes.settled()
    expect(marks).toEqual([{ mod: 'demo', at: startedAt + 2000 }])
  })
})

test("a file a build makes and deletes again counts nothing in a checkout that is no git repository, so a failing build never starts the next one", async () => {
  const root = await demoCheckout({})
  await onFakeClock(root, async ({ changes, marks, look }) => {
    await changeAt(root, '.0000000000000001-00000000.bun-build', 'built\n')
    await look()
    await rm(join(root, '.0000000000000001-00000000.bun-build'))
    await look()
    jest.advanceTimersByTime(2000)
    await changes.settled()
    expect(marks).toEqual([])
  })
})

test("a change only inside the program's output folder counts nothing, and a change outside it counts without a build", async () => {
  const home = await temporaryHome()
  const root = await linkedProgramMod(home)
  await onFakeClock(root, async ({ changes, marks, look }) => {
    await changeAt(root, 'cli/dist/hello-darwin-arm64', '#!/bin/sh\necho built\n')
    await look()
    jest.advanceTimersByTime(2000)
    await changes.settled()
    expect(marks).toEqual([])

    await changeAt(root, 'README.md', 'a change outside the program\n')
    await look()
    jest.advanceTimersByTime(2000)
    await changes.settled()
    expect(marks).toEqual([{ mod: 'hello-mod', at: startedAt + 2000 }])
    expect(existsSync(join(home, 'builds'))).toBe(false)
  })
})

test('a deleted file counts at the time a look found it gone, because it has no modification time left', async () => {
  const root = await demoCheckout({ 'src/old.ts': 'export const old = 1\n' })
  await onFakeClock(root, async ({ changes, marks, look }) => {
    jest.advanceTimersByTime(500)
    await rm(join(root, 'src/old.ts'))
    await look()
    jest.advanceTimersByTime(2000)
    await changes.settled()
    expect(marks).toEqual([{ mod: 'demo', at: startedAt + 500 }])
  })
})

test('a checkout cmod watch builds again with no file changed, as for a failure an older cmod wrote, counts at the time it asked', async () => {
  const root = await demoCheckout()
  await onFakeClock(root, async ({ changes, marks }) => {
    jest.advanceTimersByTime(500)
    changes.retry(root)
    jest.advanceTimersByTime(2000)
    await changes.settled()
    expect(marks).toEqual([{ mod: 'demo', at: startedAt + 500 }])
  })
})

async function timerSet(): Promise<void> {
  for (let tick = 0; tick < 100 && jest.getTimerCount() === 0; tick += 1) await Promise.resolve()
}

test('cmod watch touches its lock file every 5 seconds, and stops before its next touch once a newer cmod is installed', async () => {
  jest.useFakeTimers({ now: 0 })
  try {
    const touches: number[] = []
    let isNewer = false
    let touched = Promise.withResolvers<void>()
    const polling = pollWhile(
      async () => !isNewer,
      async () => {
        touches.push(Date.now())
        touched.resolve()
      },
    )
    const touchAfter = async (ms: number) => {
      touched = Promise.withResolvers<void>()
      await timerSet()
      jest.advanceTimersByTime(ms)
      await touched.promise
    }
    await touched.promise
    await touchAfter(5000)
    await touchAfter(5000)
    expect(touches).toEqual([0, 5000, 10000])

    isNewer = true
    await timerSet()
    jest.advanceTimersByTime(8000)
    await polling
    expect(touches).toEqual([0, 5000, 10000])
  } finally {
    jest.useRealTimers()
  }
})
