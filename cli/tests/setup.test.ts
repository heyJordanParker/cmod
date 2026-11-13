import { afterAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, readdir, readFile, readlink, rm, stat, symlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { readRecord } from '@cmodjs/core/src/records.js'
import { readText } from '../src/files.js'
import { claudeAnswering, cmod, cmodOnPath, cmodPluginListed, createMod, environment, createProgramMod, deleteTemporaryHomes, fourStepInstall, hashOf, helloBuild, isGone, platform, release, serveRelease, sha256Sums, temporaryHome, writeFiles, writeLinked } from './cmod.js'

afterAll(deleteTemporaryHomes)

const coreLifecycle = join(import.meta.dir, '..', '..', 'core', 'src', 'runtime', 'lifecycle.ts')

const claudeOnDisk = (home: string, plugin: { name: string; root: string }) => ({
  plugin,
  env: { home: async () => home, dataHome: async () => undefined },
  fs: {
    exists: async (path: string) => existsSync(path),
    stat: async (path: string) => ({ kind: (await stat(path)).isFile() ? 'file' : 'dir' }),
    read: (path: string) => readFile(path, 'utf8'),
    list: async (folder: string) => (await readdir(folder, { withFileTypes: true })).map((entry) => ({ name: entry.name, kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other', isLink: entry.isSymbolicLink() })),
  },
})

test('setup --events with an install step that prints four progress lines emits four progress events, then done, and writes the record', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const sha256 = await hashOf(root)

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toBe('progress 1 4 Checking Homebrew\nprogress 2 4 Installing trash\nprogress 3 4 Adding the zsh alias\nprogress 4 4 Finishing\ndone demo 0.1.0\n')
  expect(result.exitCode).toBe(0)
  const store = join(home, '.local/share/cmod')
  const record = JSON.parse(await readFile(join(store, 'records/demo.json'), 'utf8'))
  expect(record).toEqual({ name: 'demo', version: '0.1.0', root, installedAt: expect.any(String), scriptsSha256: sha256, uninstall: join(store, 'uninstall/demo/uninstall.sh'), program: null, keys: {}, permissions: [], grantedOnUpdate: [], installedBy: { session: process.env['CLAUDE_CODE_SESSION_ID'] || null, pid: process.pid } })
  expect(await readFile(join(store, 'data/demo/runs'), 'utf8')).toBe(`ran in ${root} at 0.1.0\n`)
})

test('setup --events on changed scripts runs them again without asking', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  await writeFiles(root, { 'setup/install.sh': `${fourStepInstall}echo "a new line"\n` })
  const runs = join(home, '.local/share/cmod/data/demo/runs')

  const rerun = await cmod(home, 'setup', root, '--events')

  expect(rerun.stdout).toBe('progress 1 4 Checking Homebrew\nprogress 2 4 Installing trash\nprogress 3 4 Adding the zsh alias\nprogress 4 4 Finishing\nlog a new line\ndone demo 0.1.0\n')
  expect(rerun.exitCode).toBe(0)
  expect(await readFile(runs, 'utf8')).toBe(`ran in ${root} at 0.1.0\nran in ${root} at 0.1.0\n`)
})

test('a setup --events from a library built on @cmodjs/core 4 still passes --consent, and cmod sets the mod up', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)

  expect(await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))).toMatchObject({ stdout: expect.stringContaining('done demo 0.1.0\n'), exitCode: 0 })
})

test.each([
  ['the uninstall script', { 'setup/uninstall.sh': '#!/bin/sh\necho "uninstalled again" >> "$HOME/uninstalls"\n' }],
  ['a sourced sibling script', { 'setup/lib.sh': 'greet() {\n  echo "progress 1 1 Greeting again"\n}\n' }],
])('changing only %s runs the install step again', async (_, files) => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\n. "$(dirname "$0")/lib.sh"\ngreet\necho ran >> "$CMOD_DATA/runs"\n')
  await writeFiles(root, { 'setup/lib.sh': 'greet() {\n  echo "progress 1 1 Greeting"\n}\n' })
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  await writeFiles(root, files)

  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)

  expect(await readFile(join(home, '.local/share/cmod/data/demo/runs'), 'utf8')).toBe('ran\nran\n')
  expect((await readRecord(readText, join(home, '.local/share/cmod'), 'demo'))?.scriptsSha256).toBe(await hashOf(root))
})

test('an update that changes only setup/lib runs the install step again', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\n. ./setup/lib/common.sh\ngreet\n')
  await writeFiles(root, { 'setup/lib/common.sh': 'greet() {\n  echo "progress 1 1 Greeting"\n}\n' })
  const installed = await hashOf(root)
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  await writeFiles(root, { 'setup/lib/common.sh': 'greet() {\n  echo "progress 1 1 Greeting again"\n}\n' })
  const changed = await hashOf(root)

  const rerun = await cmod(home, 'setup', root, '--events')

  expect(rerun).toMatchObject({ stdout: 'progress 1 1 Greeting again\ndone demo 0.1.0\n', exitCode: 0 })
  expect(changed).not.toBe(installed)
})

test('a changed script behind a symbolic link runs the install step again', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await writeFiles(root, { 'scripts/install.sh': fourStepInstall })
  await rm(join(root, 'setup/install.sh'))
  await symlink('../scripts/install.sh', join(root, 'setup/install.sh'))
  const installed = await hashOf(root)
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  await writeFiles(root, { 'scripts/install.sh': '#!/bin/sh\necho "progress 1 1 Changed"\n' })
  const changed = await hashOf(root)

  const rerun = await cmod(home, 'setup', root, '--events')

  expect(rerun).toMatchObject({ stdout: 'progress 1 1 Changed\ndone demo 0.1.0\n', exitCode: 0 })
  expect(changed).not.toBe(installed)
})

test('the CLI and the SDK hash a mod with a nested setup/lib and a symbolic link the same', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\n. ./setup/lib/common.sh\n')
  await writeFiles(root, { 'setup/lib/common.sh': 'echo safe\n', 'setup/lib/shell/zsh.sh': 'echo zsh\n', 'shared/aliases.sh': 'echo aliases\n' })
  await symlink('../../shared/aliases.sh', join(root, 'setup/lib/aliases.sh'))
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  const { readPlugin } = await import(coreLifecycle)

  const plugin = await readPlugin(claudeOnDisk(home, { name: 'demo', root }))

  expect(plugin).toMatchObject({ name: 'demo', version: '0.1.0', isInstalled: true })
})

test('a step script at the plugin root is refused', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo', cmod: { install: './install.sh' } }),
    'install.sh': fourStepInstall,
  })

  const result = await cmod(home, 'setup', root)

  expect(result.stderr).toBe(`cmod setup: ${root}: package.json "cmod.install" names ./install.sh, a script at the plugin root. Move it into a folder, such as ./setup/install.sh: cmod runs the steps again whenever anything in a script's folder changes.\n`)
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(home, '.local/share/cmod/data/demo'))).toBe(false)
})

test('cmod setup --events with a refused cmod key prints one failed line', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo', cmod: { install: './install.sh' } }),
    'install.sh': fourStepInstall,
  })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toBe(`failed 1\t${root}: package.json "cmod.install" names ./install.sh, a script at the plugin root. Move it into a folder, such as ./setup/install.sh: cmod runs the steps again whenever anything in a script's folder changes.\n`)
  expect(result.stderr).toBe('')
  expect(result.exitCode).toBe(1)
})

test('a step that runs make -C setup is refused at setup', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo', cmod: { install: 'make -C setup' } }),
    'setup/Makefile': 'all:\n\techo installed\n',
  })
  const refusal = 'package.json "cmod.install" runs "make -C setup", which names no script file in the mod, so cmod cannot tell when what it runs changes. Put the commands in a script, such as ./setup/install.sh.'
  const { readPlugin } = await import(coreLifecycle)

  const result = await cmod(home, 'setup', root)

  expect(result.stderr).toBe(`cmod setup: ${refusal}\n`)
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(home, '.local/share/cmod'))).toBe(false)
  await expect(readPlugin(claudeOnDisk(home, { name: 'demo', root }))).rejects.toThrow(refusal)
})

test('a link to a folder in a step folder is refused', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await writeFiles(root, { 'shared/lib.sh': 'echo shared\n' })
  await symlink('../shared', join(root, 'setup/shared'))
  const refusal = './setup/shared links to a folder or to nothing, so cmod cannot tell when it changes. Point the link at a file, or delete it.'
  const { readPlugin } = await import(coreLifecycle)

  const result = await cmod(home, 'setup', root)

  expect(result.stderr).toBe(`cmod setup: ${refusal}\n`)
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(home, '.local/share/cmod'))).toBe(false)
  await expect(readPlugin(claudeOnDisk(home, { name: 'demo', root }))).rejects.toThrow(refusal)
})

test('a link to nothing in a step folder is refused', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await symlink('../missing.sh', join(root, 'setup/missing.sh'))
  const refusal = './setup/missing.sh links to a folder or to nothing, so cmod cannot tell when it changes. Point the link at a file, or delete it.'
  const { readPlugin } = await import(coreLifecycle)

  const result = await cmod(home, 'setup', root)

  expect(result.stderr).toBe(`cmod setup: ${refusal}\n`)
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(home, '.local/share/cmod'))).toBe(false)
  await expect(readPlugin(claudeOnDisk(home, { name: 'demo', root }))).rejects.toThrow(refusal)
})

async function createDemo(home: string, cmodKey: object): Promise<string> {
  const root = join(home, 'demo')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }),
    'package.json': JSON.stringify({ name: 'demo', cmod: cmodKey }),
  })
  return root
}

const consentFile = (home: string) => join(home, '.local/share/cmod/consent.json')

test('setup of a mod built on @cmodjs/core 4 that declares permissions approves its hash and each permission without asking', async () => {
  const home = await temporaryHome()
  const root = await createDemo(home, { permissions: { network: ['api.github.com'], prompt: true } })
  const sha256 = await hashOf(root)

  const result = await cmod(home, 'setup', root, '--events')

  expect(result).toMatchObject({ stdout: 'done demo 0.2.0\n', exitCode: 0 })
  expect(JSON.parse(await readFile(consentFile(home), 'utf8'))).toEqual({ 'demo': [sha256, 'network:api.github.com', 'prompt'] })
  expect(await readRecord(readText, join(home, '.local/share/cmod'), 'demo')).toMatchObject({ permissions: ['network:api.github.com', 'prompt'], grantedOnUpdate: [] })
})

test('an update of a mod built on @cmodjs/core 4 that adds a permission approves it, and grants nothing on update', async () => {
  const home = await temporaryHome()
  const root = await createDemo(home, { permissions: { prompt: true } })
  const installed = await hashOf(root)
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.3.0' }),
    'package.json': JSON.stringify({ name: 'demo', cmod: { permissions: { prompt: true, conversation: true } } }),
  })

  const updated = await cmod(home, 'setup', root, '--events')

  expect(updated).toMatchObject({ stdout: 'done demo 0.3.0\n', exitCode: 0 })
  expect(JSON.parse(await readFile(consentFile(home), 'utf8'))).toEqual({ 'demo': [installed, 'prompt', await hashOf(root), 'conversation'] })
  expect(await readRecord(readText, join(home, '.local/share/cmod'), 'demo')).toMatchObject({ version: '0.3.0', permissions: ['prompt', 'conversation'], grantedOnUpdate: [] })
})

test('setup --events on a set-up mod prints done and runs nothing', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await cmod(home, 'setup', root, '--events')

  const again = await cmod(home, 'setup', root, '--events')

  expect(again.stdout).toBe('done demo 0.1.0\n')
  expect(again.exitCode).toBe(0)
  expect(await readFile(join(home, '.local/share/cmod/data/demo/runs'), 'utf8')).toBe(`ran in ${root} at 0.1.0\n`)
})

const listedCopy = (id: string, installPath: string, version: string, enabled = true) => ({ id, version, scope: 'user', enabled, installPath })

test('setup --events of an older copy a session loaded sets up the copy Claude Code installed', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }) })
  await writeFiles(home, { 'bin/claude': claudeAnswering([...cmodPluginListed, listedCopy('demo@demo', root, '0.2.0')]) })
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  const older = await createMod(join(home, 'older'))

  const result = await cmod(home, 'setup', older, '--events')

  expect(result).toEqual({ exitCode: 0, stdout: 'done demo 0.2.0\n', stderr: '' })
  expect(await readRecord(readText, join(home, '.local/share/cmod'), 'demo')).toMatchObject({ version: '0.2.0', root })
  expect(await readFile(join(home, '.local/share/cmod/data/demo/runs'), 'utf8')).toBe(`ran in ${root} at 0.2.0\n`)
})

test('an older version you install through Claude Code is set up over the newer one', async () => {
  const home = await temporaryHome()
  const newer = await createMod(join(home, 'newer'))
  await writeFiles(newer, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }) })
  expect((await cmod(home, 'setup', newer, '--events')).exitCode).toBe(0)
  const root = await createMod(home)
  await writeFiles(home, { 'bin/claude': claudeAnswering([...cmodPluginListed, listedCopy('demo@demo', root, '0.1.0')]) })

  const result = await cmod(home, 'setup', newer, '--events')

  expect(result.stdout).toEndWith('done demo 0.1.0\n')
  expect(await readRecord(readText, join(home, '.local/share/cmod'), 'demo')).toMatchObject({ version: '0.1.0', root })
})

test('setup of a published copy a session loaded sets up the linked checkout instead', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await writeLinked(home, root)
  const published = await createMod(join(home, 'published'))
  await writeFiles(published, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }) })
  await writeFiles(home, { 'bin/claude': claudeAnswering([...cmodPluginListed, listedCopy('demo@demo', published, '0.2.0', false), listedCopy(`demo@${basename(home)}-linked`, '/cache/demo/0.1.0', '0.1.0')]) })

  const result = await cmod(home, 'setup', published, '--events')

  expect(result.stdout).toEndWith('done demo 0.1.0\n')
  expect(await readRecord(readText, join(home, '.local/share/cmod'), 'demo')).toMatchObject({ version: '0.1.0', root })
})

test('the record names the session and the process that asked for the setup', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)

  const setup = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'src', 'main.ts'), 'setup', root, '--events'], { cwd: home, env: { ...environment(home), CLAUDE_CODE_SESSION_ID: 'a1b2c3d4' }, stdout: 'ignore', stderr: 'ignore' })

  expect(await setup.exited).toBe(0)
  expect((await readRecord(readText, join(home, '.local/share/cmod'), 'demo'))?.installedBy).toEqual({ session: 'a1b2c3d4', pid: process.pid })
})

test('setup --events on a failing install step prints failed with the exit code and a sentence naming the last stderr line, and writes no record', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\necho "progress 1 2 Fetching"\necho "curl: could not resolve host" >&2\nexit 7\n')

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toBe('progress 1 2 Fetching\nlog curl: could not resolve host\nlog The uninstall step of demo undid the install.\nfailed 7\tThe install step of demo exited 7: curl: could not resolve host.\n')
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(home, '.local/share/cmod/records/demo.json'))).toBe(false)
})

test('setup --events on a mod with no install step writes its record and prints done', async () => {
  const home = await temporaryHome()
  const root = join(home, 'plain')
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'plain', version: '1.2.0' }) })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toBe('done plain 1.2.0\n')
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/records/plain.json'), 'utf8')).uninstall).toBeNull()
})

test("a linked checkout's failed setup says it retries once the checkout changes", async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await writeFiles(root, { 'setup/install.sh': '#!/bin/sh\nexit 3\n' })
  await writeLinked(home, root)

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toEndWith('failed 3\tThe install step of demo exited 3.\nretries changed\n')
})

test('a failed upgrade keeps only the approval of the version its record names', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const sha256 = await hashOf(root)
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  const store = join(home, '.local/share/cmod')
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }), 'setup/install.sh': '#!/bin/sh\nexit 3\n' })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toBe('failed 3\tThe install step of demo exited 3.\n')
  expect(JSON.parse(await readFile(join(store, 'records/demo.json'), 'utf8'))).toMatchObject({ version: '0.1.0' })
  expect(await readFile(join(store, 'data/demo/runs'), 'utf8')).toBe(`ran in ${root} at 0.1.0\n`)
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({ demo: [sha256] })
})

test('setup downloads the named program for this platform, checks it against SHA256SUMS, links it, and counts its steps in the bar', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) })
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toBe(
    [
      'progress 0 3 Downloading hello 0.2.0',
      'progress 1 3 Checking hello 0.2.0',
      'progress 2 3 Linking hello',
      'progress 3 3 hello 0.2.0 is installed',
      'progress 4 5 Adding the alias',
      'progress 5 5 Finishing',
      'done hello-mod 0.2.0',
      '',
    ].join('\n'),
  )
  expect(result.exitCode).toBe(0)
  const entry = join(home, '.local/bin/hello')
  expect(await readlink(entry)).toBe(join(home, '.local/share/cmod/bin/hello/0.2.0/hello'))
  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/records/hello-mod.json'), 'utf8'))).toMatchObject({ program: 'hello', uninstall: null })
  expect(existsSync(join(home, '.local/share/cmod/uninstall/hello-mod'))).toBe(false)
  expect(await new Response(Bun.spawn([entry], { stdout: 'pipe' }).stdout).text()).toBe('hello 0.2.0\n')
})

test('a download whose SHA-256 differs from SHA256SUMS fails and installs nothing', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums({ [`hello-${platform}`]: '#!/bin/sh\necho "the build cmod publish hashed"\n' }) })
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  const url = `${server.url.origin}${release}/hello-${platform}`
  const actual = new Bun.CryptoHasher('sha256').update(helloBuild[`hello-${platform}`] as string).digest('hex')

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toStartWith(`progress 0 3 Downloading hello 0.2.0\nfailed 1\t${url} has SHA-256 ${actual}, but SHA256SUMS lists `)
  expect(result.exitCode).toBe(1)
  for (const path of [join(home, '.local/bin/hello'), join(home, '.local/share/cmod/bin/hello'), join(home, '.local/share/cmod/records/hello-mod.json')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
})

test('a failed install leaves no program link', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) })
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  await writeFiles(root, { 'setup/install.sh': '#!/bin/sh\necho "brew: no such formula" >&2\nexit 3\n' })

  const result = await cmod(home, 'setup', root)

  expect(result.exitCode).toBe(1)
  for (const path of [join(home, '.local/bin/hello'), join(home, '.local/share/cmod/bin/hello'), join(home, '.local/share/cmod/records/hello-mod.json')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
})

test('a failed install of a set-up mod keeps the program its record names', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) })
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  expect((await cmod(home, 'setup', root)).exitCode).toBe(0)
  await writeFiles(root, { 'setup/install.sh': '#!/bin/sh\necho "brew: no such formula" >&2\nexit 3\n' })

  const result = await cmod(home, 'setup', root)

  expect(result.exitCode).toBe(1)
  expect(await readlink(join(home, '.local/bin/hello'))).toBe(join(home, '.local/share/cmod/bin/hello/0.2.0/hello'))
  expect(existsSync(join(home, '.local/share/cmod/records/hello-mod.json'))).toBe(true)
})

test('a failed upgrade keeps the program the record names', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) })
  const repository = `${server.url.origin}/owner/hello-mod`
  const root = await createProgramMod(home, repository)
  expect((await cmod(home, 'setup', root)).exitCode).toBe(0)
  await writeFiles(home, { '.local/share/cmod/bin/hello/0.3.0/hello': '#!/bin/sh\necho "hello 0.3.0"\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.3.0', repository }),
    'setup/install.sh': '#!/bin/sh\necho "brew: no such formula" >&2\nexit 3\n',
  })

  const result = await cmod(home, 'setup', root)

  expect(result.exitCode).toBe(1)
  expect(await readlink(join(home, '.local/bin/hello'))).toBe(join(home, '.local/share/cmod/bin/hello/0.2.0/hello'))
  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/records/hello-mod.json'), 'utf8'))).toMatchObject({ version: '0.2.0', program: 'hello' })
})

test('an upgrade that drops cmod.program removes the old program', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.2.0' }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { program: 'hello', install: './setup/install.sh' } }),
    'setup/install.sh': '#!/bin/sh\necho ran >> "$CMOD_DATA/runs"\n',
  })
  expect((await cmod(home, 'setup', root)).exitCode).toBe(0)
  expect(await readlink(join(home, '.local/bin/hello'))).toBe(join(store, 'bin/hello/0.2.0/hello'))
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.3.0' }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { install: './setup/install.sh' } }),
  })

  const result = await cmod(home, 'setup', root)

  expect(result.exitCode).toBe(0)
  expect(JSON.parse(await readFile(join(store, 'records/hello-mod.json'), 'utf8'))).toMatchObject({ version: '0.3.0', program: null })
  for (const path of [join(home, '.local/bin/hello'), join(store, 'bin/hello')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
})

test('an upgrade that renames cmod.program removes the old program and links the new one', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n', 'bin/hi/0.3.0/hi': '#!/bin/sh\necho hi\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.2.0' }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { program: 'hello', install: './setup/install.sh' } }),
    'setup/install.sh': '#!/bin/sh\necho ran >> "$CMOD_DATA/runs"\n',
  })
  expect((await cmod(home, 'setup', root)).exitCode).toBe(0)
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.3.0' }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { program: 'hi', install: './setup/install.sh' } }),
  })

  const result = await cmod(home, 'setup', root)

  expect(result.exitCode).toBe(0)
  expect(await readlink(join(home, '.local/bin/hi'))).toBe(join(store, 'bin/hi/0.3.0/hi'))
  for (const path of [join(home, '.local/bin/hello'), join(store, 'bin/hello')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
})

test('a mod named constructor sets up', async () => {
  const home = await temporaryHome()
  const root = join(home, 'constructor')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'constructor', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'constructor', cmod: { install: './setup/install.sh' } }),
    'setup/install.sh': '#!/bin/sh\ntrue\n',
  })
  const sha256 = await hashOf(root)

  const result = await cmod(home, 'setup', root, '--events')

  expect(result).toEqual({ exitCode: 0, stdout: 'done constructor 0.1.0\n', stderr: '' })
  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/consent.json'), 'utf8'))).toEqual({ constructor: [sha256] })
})


async function createMarketplaceMod(home: string, settings: Record<string, unknown>, known: Record<string, unknown> = { 'demo-market': { source: { source: 'github', repo: 'owner/demo' } } }): Promise<string> {
  const root = join(home, '.claude/plugins/cache/demo-market/demo/0.1.0')
  await writeFiles(home, {
    '.claude/plugins/cache/demo-market/demo/0.1.0/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    '.claude/plugins/cache/demo-market/demo/0.1.0/package.json': JSON.stringify({ name: 'demo', cmod: { install: './setup/install.sh' } }),
    '.claude/plugins/cache/demo-market/demo/0.1.0/setup/install.sh': '#!/bin/sh\n',
    '.claude/plugins/known_marketplaces.json': JSON.stringify(known),
    '.claude/settings.json': `${JSON.stringify(settings, null, 2)}\n`,
  })
  return root
}

test('setup turns on automatic updates for the marketplace a mod came from, says so, and keeps the rest of settings.json', async () => {
  const home = await temporaryHome()
  const root = await createMarketplaceMod(home, { model: 'opus', extraKnownMarketplaces: { 'demo-market': { source: { source: 'github', repo: 'owner/demo' } } } })

  const result = await cmod(home, 'setup', root)

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('demo now updates automatically from the demo-market marketplace. Turn it off in /plugin, Marketplaces.')
  expect(JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'))).toEqual({ model: 'opus', extraKnownMarketplaces: { 'demo-market': { source: { source: 'github', repo: 'owner/demo' }, autoUpdate: true } } })
})

test('setup declares a marketplace only known_marketplaces.json lists, with its source and automatic updates', async () => {
  const home = await temporaryHome()
  const root = await createMarketplaceMod(home, {})

  expect((await cmod(home, 'setup', root)).exitCode).toBe(0)

  expect(JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'))).toEqual({ extraKnownMarketplaces: { 'demo-market': { source: { source: 'github', repo: 'owner/demo' }, autoUpdate: true } } })
})

test('setup keeps automatic updates off when the person turned them off, in settings.json or in /plugin', async () => {
  const home = await temporaryHome()
  const offInSettings = { extraKnownMarketplaces: { 'demo-market': { source: { source: 'github', repo: 'owner/demo' }, autoUpdate: false } } }
  const root = await createMarketplaceMod(home, offInSettings)
  expect((await cmod(home, 'setup', root)).exitCode).toBe(0)
  expect(JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'))).toEqual(offInSettings)

  const other = await temporaryHome()
  const offInPlugin = await createMarketplaceMod(other, {}, { 'demo-market': { source: { source: 'github', repo: 'owner/demo' }, autoUpdate: false } })
  const result = await cmod(other, 'setup', offInPlugin)
  expect(result.stdout).not.toContain('updates automatically')
  expect(JSON.parse(await readFile(join(other, '.claude/settings.json'), 'utf8'))).toEqual({})
})

test('a linked mod, outside the plugin cache, leaves automatic updates alone', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)

  const result = await cmod(home, 'setup', root)

  expect(result.exitCode).toBe(0)
  expect(result.stdout).not.toContain('updates automatically')
  expect(existsSync(join(home, '.claude/settings.json'))).toBe(false)
})

test('a current mod whose approval is gone sets up without asking', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  expect((await cmod(home, 'setup', root)).exitCode).toBe(0)
  await rm(join(home, '.local/share/cmod/consent.json'))

  const result = await cmod(home, 'setup', root)

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe('✔ demo 0.1.0 is already set up\n  Start Claude Code to use demo. A session that is running starts it on its own.\n')
  expect(await readFile(join(home, '.local/share/cmod/data/demo/runs'), 'utf8')).toBe(`ran in ${root} at 0.1.0\n`)
})

test('setup --events prints failed when the release holds no build for this platform yet, says it retries later, and writes no record', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ SHA256SUMS: sha256Sums(helloBuild) })
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toBe(`progress 0 3 Downloading hello 0.2.0\nfailed 1\tThe v0.2.0 release of hello-mod has no hello-${platform} yet. Its author attaches it with cmod publish.\nretries later\n`)
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(home, '.local/share/cmod/records/hello-mod.json'))).toBe(false)
  expect(existsSync(join(home, '.local/share/cmod/bin/hello'))).toBe(false)
})

test('setup keeps a ~/.local/bin file cmod did not make, links the program into the programs folder Claude Code runs, and says which one a terminal runs', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) })
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  await writeFiles(home, { '.local/bin/hello': '#!/bin/sh\necho "my own hello"\n' })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("log ~/.local/bin/hello is not cmod's, so a terminal runs that hello. Claude Code runs cmod's.\n")
  expect(await readFile(join(home, '.local/bin/hello'), 'utf8')).toBe('#!/bin/sh\necho "my own hello"\n')
  expect(await readlink(join(home, '.local/share/cmod/programs/hello'))).toBe(join(home, '.local/share/cmod/bin/hello/0.2.0/hello'))
})

test('setup installs a program whose name PATH finds elsewhere, links it into the programs folder, and says a terminal runs the other one', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) })
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  await writeFiles(home, { 'bin/hello': '#!/bin/sh\necho "another hello"\n' })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("log A terminal runs ~/bin/hello, which PATH finds before ~/.local/bin. Claude Code runs cmod's hello.\n")
  expect(await readlink(join(home, '.local/bin/hello'))).toBe(join(home, '.local/share/cmod/bin/hello/0.2.0/hello'))
  expect(await new Response(Bun.spawn([join(home, '.local/share/cmod/programs/hello')], { stdout: 'pipe' }).stdout).text()).toBe('hello 0.2.0\n')
})

test('setup refuses a mod whose package.json "os" leaves out this system, before any script runs', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  const other = process.platform === 'darwin' ? 'linux' : 'darwin'
  const names: Record<string, string> = { darwin: 'macOS', linux: 'Linux' }
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo', os: [other], cmod: { install: './setup/install.sh' } }),
    'setup/install.sh': '#!/bin/sh\necho ran > "$CMOD_DATA/ran"\n',
  })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toBe(`failed 1\tdemo runs on ${names[other]}, and this is ${names[process.platform]}, so cmod set up nothing.\n`)
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(home, '.local/share/cmod/data/demo'))).toBe(false)
})

test("an install step's PATH puts cmod's programs folder ahead of a system command of the same name", async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(home, { '.local/share/cmod/bin/env/0.2.0/env': '#!/bin/sh\necho "cmod\'s env"\n' })
  await chmod(join(home, '.local/share/cmod/bin/env/0.2.0/env'), 0o755)
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0', repository: 'http://127.0.0.1:9/owner/demo' }),
    'package.json': JSON.stringify({ name: 'demo', cmod: { program: 'env', install: './setup/install.sh' } }),
    'setup/install.sh': '#!/bin/sh\nenv > "$CMOD_DATA/ran"\n',
  })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.exitCode).toBe(0)
  expect(await readFile(join(home, '.local/share/cmod/data/demo/ran'), 'utf8')).toBe("cmod's env\n")
})

test('setup installs a program when ~/.local/bin comes before the other folder PATH finds it in', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) })
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  await writeFiles(home, { 'brew/bin/hello': '#!/bin/sh\necho "another hello"\n' })
  await chmod(join(home, 'brew/bin/hello'), 0o755)

  const result = await cmodOnPath(home, `${join(home, 'bin')}:${join(home, '.local/bin')}:${join(home, 'brew/bin')}:${process.env['PATH']}`, 'setup', root, '--events')

  expect(result.exitCode).toBe(0)
  expect(existsSync(join(home, '.local/bin/hello'))).toBe(true)
})

test('setup links a program version already in the store, such as one the cmod bootstrap placed, without downloading it', async () => {
  const home = await temporaryHome()
  using server = serveRelease({})
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  await writeFiles(home, { '.local/share/cmod/bin/hello/0.2.0/hello': '#!/bin/sh\necho "placed by the bootstrap"\n' })
  await chmod(join(home, '.local/share/cmod/bin/hello/0.2.0/hello'), 0o755)

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toBe('progress 2 3 Linking hello\nprogress 3 3 hello 0.2.0 is installed\nprogress 4 5 Adding the alias\nprogress 5 5 Finishing\ndone hello-mod 0.2.0\n')
  expect(await new Response(Bun.spawn([join(home, '.local/bin/hello')], { stdout: 'pipe' }).stdout).text()).toBe('placed by the bootstrap\n')
})

test('a linked mod whose version moved past its last release builds its program from the checkout instead of downloading it', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) })
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  const build = `mkdir -p dist && printf '#!/bin/sh\\necho hello from the checkout\\n' > dist/hello-${platform}`
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.3.0', repository: `${server.url.origin}/owner/hello-mod` }),
    'cli/package.json': JSON.stringify({ name: 'hello', cmod: { build, output: 'dist' } }),
  })
  await writeLinked(home, root)

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toBe(
    [
      'progress 0 3 Building hello',
      `log Built hello: hello-${platform}`,
      'progress 2 3 Linking hello',
      'progress 3 3 hello 0.3.0 is installed',
      'progress 4 5 Adding the alias',
      'progress 5 5 Finishing',
      'done hello-mod 0.3.0',
      '',
    ].join('\n'),
  )
  expect(await readlink(join(home, '.local/bin/hello'))).toBe(join(home, '.local/share/cmod/bin/hello/0.3.0/hello'))
  expect(await new Response(Bun.spawn([join(home, '.local/bin/hello')], { stdout: 'pipe' }).stdout).text()).toBe('hello from the checkout\n')
})

test('a program rebuilt after the install step ran makes setup run the install step again with it', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) })
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  await writeFiles(root, { 'setup/install.sh': '#!/bin/sh\nhello >> "$CMOD_DATA/runs"\n' })
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  const program = join(home, '.local/share/cmod/bin/hello/0.2.0/hello')
  await writeFiles(home, { '.local/share/cmod/bin/hello/0.2.0/hello': '#!/bin/sh\necho "hello from the rebuild"\n' })
  await chmod(program, 0o755)

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toEndWith('done hello-mod 0.2.0\n')
  expect((await readFile(join(home, '.local/share/cmod/data/hello-mod/runs'), 'utf8')).split('\n').at(-2)).toBe('hello from the rebuild')
  expect((await cmod(home, 'setup', root, '--events')).stdout).toBe('done hello-mod 0.2.0\n')
})

test("a linked mod's failed build runs again only once a file in its program folder changes", async () => {
  const home = await temporaryHome()
  const root = await createProgramMod(home, 'http://127.0.0.1:9/owner/hello-mod')
  const build = 'echo built >> ../builds; echo "error: expected ;" >&2; exit 1'
  await writeFiles(root, { 'cli/package.json': JSON.stringify({ name: 'hello', cmod: { build, output: 'dist' } }) })
  await writeLinked(home, root)
  const failure = `failed 1\tBuilding hello with "${build}" exited 1: error: expected ;. Fix the build in ~/hello-mod/cli, then save a file there or run the command again.\nretries changed\n`

  expect((await cmod(home, 'setup', root, '--events')).stdout).toEndWith(failure)
  await writeFiles(root, { 'README.md': 'outside the program folder\n' })
  expect((await cmod(home, 'setup', root, '--events')).stdout).toEndWith(failure)
  expect(await readFile(join(root, 'builds'), 'utf8')).toBe('built\n')

  await writeFiles(root, { 'cli/main.ts': 'export {}\n' })
  expect((await cmod(home, 'setup', root, '--events')).stdout).toEndWith(failure)
  expect(await readFile(join(root, 'builds'), 'utf8')).toBe('built\nbuilt\n')
})
