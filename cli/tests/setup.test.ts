import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, lstat, readdir, readFile, readlink, rename, rm, stat, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseEvent, readRecord, recordPath } from 'cmod-sdk/src/records.js'
import { messageOf } from 'cmod-sdk/src/utils/text.js'
import { listFiles, readText } from '../src/files.js'
import { cmod, cmodInTerminal, deleteTemporaryHomes, hashOf, startCmod, temporaryHome, writeFiles } from './cmod.js'

afterEach(deleteTemporaryHomes)

const fourStepInstall = `#!/bin/sh
echo "progress 1 4 Checking Homebrew"
echo "progress 2 4 Installing trash"
echo "progress 3 4 Adding the zsh alias"
echo "progress 4 4 Finishing"
echo "ran in $CMOD_PLUGIN_ROOT at $CMOD_VERSION" >> "$CMOD_DATA/runs"
`

async function createMod(home: string, install = fourStepInstall): Promise<string> {
  const root = join(home, 'demo')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo', cmod: { install: './setup/install.sh', uninstall: './setup/uninstall.sh' } }),
    'setup/install.sh': install,
    'setup/uninstall.sh': '#!/bin/sh\necho "uninstalled from $CMOD_PLUGIN_ROOT" >> "$HOME/uninstalls"\n',
  })
  return root
}

const platform = `${process.platform}-${process.arch}`
const release = '/owner/hello-mod/releases/download/v0.2.0'
const helloBuild = { [`hello-${platform}`]: '#!/bin/sh\necho "hello 0.2.0"\n' }

function sha256Sums(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([name, text]) => `${new Bun.CryptoHasher('sha256').update(text).digest('hex')}  ${name}\n`)
    .join('')
}

function serveRelease(files: Record<string, string>, delayMs = 0) {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      const { pathname } = new URL(request.url)
      const file = pathname.startsWith(`${release}/`) ? files[pathname.slice(release.length + 1)] : undefined
      await Bun.sleep(delayMs)
      return file === undefined ? new Response('Not Found', { status: 404 }) : new Response(file)
    },
  })
}

async function waitFor(path: string): Promise<void> {
  while (!existsSync(path)) await Bun.sleep(10)
}

async function createProgramMod(home: string, repository: string): Promise<string> {
  const root = join(home, 'hello-mod')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.2.0', repository }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { program: 'hello', install: './setup/install.sh' } }),
    'setup/install.sh': '#!/bin/sh\necho "progress 1 2 Adding the alias"\necho "progress 2 2 Finishing"\necho ran >> "$CMOD_DATA/runs"\n',
  })
  return root
}

const sdkLifecycle = join(import.meta.dir, '..', '..', 'sdk', 'src', 'runtime', 'lifecycle.ts')

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

const isGone = (path: string) => lstat(path).then(
  () => false,
  () => true,
)

async function goneProcessId(): Promise<number> {
  const child = Bun.spawn(['true'])
  await child.exited
  return child.pid
}

async function startOf(processId: number): Promise<string> {
  const ps = Bun.spawn(['/bin/ps', '-o', 'lstart=', '-p', String(processId)], { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, stdout: 'pipe' })
  return (await new Response(ps.stdout).text()).trim()
}

test('setup --events with an install step that prints four progress lines emits four progress events, then done, and writes the record', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const sha256 = await hashOf(root)

  const result = await cmod(home, 'setup', root, '--events', '--consent', sha256)

  expect(result.stdout).toBe('progress 1 4 Checking Homebrew\nprogress 2 4 Installing trash\nprogress 3 4 Adding the zsh alias\nprogress 4 4 Finishing\ndone demo 0.1.0\n')
  expect(result.exitCode).toBe(0)
  const store = join(home, '.local/share/cmod')
  const record = JSON.parse(await readFile(join(store, 'records/demo.json'), 'utf8'))
  expect(record).toEqual({ name: 'demo', version: '0.1.0', root, installedAt: expect.any(String), scriptsSha256: sha256, uninstall: join(store, 'uninstall/demo/uninstall.sh'), program: null })
  expect(await readFile(join(store, 'data/demo/runs'), 'utf8')).toBe(`ran in ${root} at 0.1.0\n`)
})

test('setup --events on changed scripts prints needs-consent and runs nothing, and --consent with the right hash runs it', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  expect((await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))).exitCode).toBe(0)
  await writeFiles(root, { 'setup/install.sh': `${fourStepInstall}echo "a new line"\n` })
  const changed = await hashOf(root)
  const runs = join(home, '.local/share/cmod/data/demo/runs')

  const asked = await cmod(home, 'setup', root, '--events')

  expect(asked.stdout).toBe(`needs-consent ${changed}\t./setup/install.sh\t./setup/uninstall.sh\n`)
  expect(asked.exitCode).toBe(10)
  expect(await readFile(runs, 'utf8')).toBe(`ran in ${root} at 0.1.0\n`)

  const approved = await cmod(home, 'setup', root, '--events', '--consent', changed)

  expect(approved.stdout).toBe('progress 1 4 Checking Homebrew\nprogress 2 4 Installing trash\nprogress 3 4 Adding the zsh alias\nprogress 4 4 Finishing\nlog a new line\ndone demo 0.1.0\n')
  expect(approved.exitCode).toBe(0)
  expect(await readFile(runs, 'utf8')).toBe(`ran in ${root} at 0.1.0\nran in ${root} at 0.1.0\n`)
})

test('changing only the uninstall script asks for consent again', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  expect((await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))).exitCode).toBe(0)
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\nrm -rf "$HOME/Documents"\n' })

  const asked = await cmod(home, 'setup', root, '--events')

  expect(asked.stdout).toBe(`needs-consent ${await hashOf(root)}\t./setup/install.sh\t./setup/uninstall.sh\n`)
  expect(asked.exitCode).toBe(10)
})

test('changing only a sourced sibling script asks for consent again', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\n. "$(dirname "$0")/lib.sh"\ngreet\n')
  await writeFiles(root, { 'setup/lib.sh': 'greet() {\n  echo "progress 1 1 Greeting"\n}\n' })
  expect((await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))).exitCode).toBe(0)
  await writeFiles(root, { 'setup/lib.sh': 'greet() {\n  rm -rf "$HOME/Documents"\n}\n' })

  const asked = await cmod(home, 'setup', root, '--events')

  expect(asked.stdout).toBe(`needs-consent ${await hashOf(root)}\t./setup/install.sh\t./setup/uninstall.sh\n`)
  expect(asked.exitCode).toBe(10)
})

test('an update that changes only setup/lib asks consent again', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\n. ./setup/lib/common.sh\ngreet\n')
  await writeFiles(root, { 'setup/lib/common.sh': 'greet() {\n  echo "progress 1 1 Greeting"\n}\n' })
  const approved = await hashOf(root)
  expect((await cmod(home, 'setup', root, '--events', '--consent', approved)).exitCode).toBe(0)
  await writeFiles(root, { 'setup/lib/common.sh': 'greet() {\n  rm -rf "$HOME/Documents"\n}\n' })
  const changed = await hashOf(root)

  const asked = await cmod(home, 'setup', root, '--events')

  expect(asked.stdout).toBe(`needs-consent ${changed}\t./setup/install.sh\t./setup/uninstall.sh\n`)
  expect(asked.exitCode).toBe(10)
  expect(changed).not.toBe(approved)
})

test('a changed script behind a symbolic link asks consent again', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await writeFiles(root, { 'scripts/install.sh': fourStepInstall })
  await rm(join(root, 'setup/install.sh'))
  await symlink('../scripts/install.sh', join(root, 'setup/install.sh'))
  const approved = await hashOf(root)
  expect((await cmod(home, 'setup', root, '--events', '--consent', approved)).exitCode).toBe(0)
  await writeFiles(root, { 'scripts/install.sh': '#!/bin/sh\nrm -rf "$HOME/Documents"\n' })
  const changed = await hashOf(root)

  const asked = await cmod(home, 'setup', root, '--events')

  expect(asked.stdout).toBe(`needs-consent ${changed}\t./setup/install.sh\t./setup/uninstall.sh\n`)
  expect(asked.exitCode).toBe(10)
  expect(changed).not.toBe(approved)
})

test('the CLI and the SDK hash a mod with a nested setup/lib and a symbolic link the same', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\n. ./setup/lib/common.sh\n')
  await writeFiles(root, { 'setup/lib/common.sh': 'echo safe\n', 'setup/lib/shell/zsh.sh': 'echo zsh\n', 'shared/aliases.sh': 'echo aliases\n' })
  await symlink('../../shared/aliases.sh', join(root, 'setup/lib/aliases.sh'))
  const asked = parseEvent((await cmod(home, 'setup', root, '--events')).stdout.trim())
  if (asked.kind !== 'needs-consent') throw new Error(`cmod setup printed ${asked.kind}, not needs-consent`)
  expect((await cmod(home, 'setup', root, '--events', '--consent', asked.sha256)).exitCode).toBe(0)
  const { readPlugin } = await import(sdkLifecycle)

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

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stderr).toBe(`cmod setup: ${root}: package.json "cmod.install" names ./install.sh, a script at the plugin root. Move it into a folder, such as ./setup/install.sh: CMod asks consent for the whole folder of each script.\n`)
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(home, '.local/share/cmod/data/demo'))).toBe(false)
})

test('a step that runs make -C setup is refused at setup', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo', cmod: { install: 'make -C setup' } }),
    'setup/Makefile': 'all:\n\techo installed\n',
  })
  const refusal = 'package.json "cmod.install" runs "make -C setup", which names no script file in the mod, so consent cannot cover what it runs. Put the commands in a script, such as ./setup/install.sh.'
  const { readPlugin } = await import(sdkLifecycle)

  const result = await cmod(home, 'setup', root, '--yes')

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
  const refusal = './setup/shared links to a folder or to nothing, so consent cannot cover it. Point the link at a file, or delete it.'
  const { readPlugin } = await import(sdkLifecycle)

  const result = await cmod(home, 'setup', root, '--yes')

  expect(result.stderr).toBe(`cmod setup: ${refusal}\n`)
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(home, '.local/share/cmod'))).toBe(false)
  await expect(readPlugin(claudeOnDisk(home, { name: 'demo', root }))).rejects.toThrow(refusal)
})

test('a link to nothing in a step folder is refused', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await symlink('../missing.sh', join(root, 'setup/missing.sh'))
  const refusal = './setup/missing.sh links to a folder or to nothing, so consent cannot cover it. Point the link at a file, or delete it.'
  const { readPlugin } = await import(sdkLifecycle)

  const result = await cmod(home, 'setup', root, '--yes')

  expect(result.stderr).toBe(`cmod setup: ${refusal}\n`)
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(home, '.local/share/cmod'))).toBe(false)
  await expect(readPlugin(claudeOnDisk(home, { name: 'demo', root }))).rejects.toThrow(refusal)
})

test('setup --events asks consent for a mod that names only a program', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.2.0', repository: 'https://github.com/owner/hello-mod' }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { program: 'hello' } }),
  })

  const asked = await cmod(home, 'setup', root, '--events')

  expect(asked.stdout).toBe(`needs-consent ${await hashOf(root)}\t\t\n`)
  expect(asked.exitCode).toBe(10)
  expect(existsSync(join(home, '.local/share/cmod/bin/hello'))).toBe(false)
})

test('setup --events on a set-up mod prints done and runs nothing', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))

  const again = await cmod(home, 'setup', root, '--events')

  expect(again.stdout).toBe('done demo 0.1.0\n')
  expect(again.exitCode).toBe(0)
  expect(await readFile(join(home, '.local/share/cmod/data/demo/runs'), 'utf8')).toBe(`ran in ${root} at 0.1.0\n`)
})

test('setup --events on a failing install step prints failed with the exit code and the last stderr line, and writes no record', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\necho "progress 1 2 Fetching"\necho "curl: could not resolve host" >&2\nexit 7\n')

  const result = await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))

  expect(result.stdout).toBe('progress 1 2 Fetching\nlog curl: could not resolve host\nlog The uninstall step of demo exited 0.\nfailed 7\tcurl: could not resolve host\n')
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

test('teardown runs the saved uninstall step after the plugin folder is deleted, then deletes the record and the saved step', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))
  await rm(root, { recursive: true })
  const store = join(home, '.local/share/cmod')

  const result = await cmod(home, 'teardown', 'demo')

  expect(result.exitCode).toBe(0)
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe(`uninstalled from ${join(store, 'uninstall/demo/root')}\n`)
  expect(existsSync(join(store, 'records/demo.json'))).toBe(false)
  expect(existsSync(join(store, 'records/demo.json.lock'))).toBe(false)
  expect(existsSync(join(store, 'uninstall/demo'))).toBe(false)
})

test('teardown keeps the config folder', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))
  await writeFiles(home, { '.claude/cmods/demo/skills/architecture-diagram/SKILL.md': 'My own diagram rules.\n', '.claude/cmods/demo/state.json': '{ "global": { "retries": 5 } }\n' })
  await rm(root, { recursive: true })

  const result = await cmod(home, 'teardown', 'demo', '--events')

  expect(result.stdout).toBe('done demo\n')
  expect(await readFile(join(home, '.claude/cmods/demo/skills/architecture-diagram/SKILL.md'), 'utf8')).toBe('My own diagram rules.\n')
  expect(await readFile(join(home, '.claude/cmods/demo/state.json'), 'utf8')).toBe('{ "global": { "retries": 5 } }\n')
})

test('teardown forgets the approved scripts, so setting the mod up again asks for consent', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  expect((await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))).exitCode).toBe(0)

  expect((await cmod(home, 'teardown', 'demo', '--events')).stdout).toBe('done demo\n')

  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/consent.json'), 'utf8'))).toEqual({})
  const again = await cmod(home, 'setup', root, '--events')
  expect(again.stdout).toBe(`needs-consent ${await hashOf(root)}\t./setup/install.sh\t./setup/uninstall.sh\n`)
  expect(again.exitCode).toBe(10)
})

test('the saved uninstall runs a script that sources a sibling file after the plugin folder is gone', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await writeFiles(root, {
    'setup/uninstall.sh': '#!/bin/sh\n. "$(dirname "$0")/lib.sh"\nremove_alias\n',
    'setup/lib.sh': 'remove_alias() {\n  echo "alias removed" >> "$HOME/uninstalls"\n}\n',
  })
  await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))
  await rm(root, { recursive: true })

  const result = await cmod(home, 'teardown', 'demo', '--events')

  expect(result.stdout).toBe('done demo\n')
  expect(result.exitCode).toBe(0)
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('alias removed\n')
})

test('teardown runs an uninstall that sources setup/lib after the mod\'s folder is gone', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await writeFiles(root, {
    'setup/uninstall.sh': '#!/bin/sh\n. ./setup/lib/alias.sh\nremove_alias\n',
    'setup/lib/alias.sh': 'remove_alias() {\n  echo "alias removed" >> "$HOME/uninstalls"\n}\n',
  })
  await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))
  await rm(root, { recursive: true })

  const result = await cmod(home, 'teardown', 'demo', '--events')

  expect(result.stdout).toBe('done demo\n')
  expect(result.exitCode).toBe(0)
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('alias removed\n')
})

test('teardown runs an uninstall step reached through a symbolic link', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await writeFiles(root, { 'scripts/uninstall.sh': '#!/bin/sh\necho "uninstalled through the link" >> "$HOME/uninstalls"\n' })
  await rm(join(root, 'setup/uninstall.sh'))
  await symlink('../scripts/uninstall.sh', join(root, 'setup/uninstall.sh'))
  expect((await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))).exitCode).toBe(0)
  await rm(root, { recursive: true })

  const result = await cmod(home, 'teardown', 'demo', '--events')

  expect(result.stdout).toBe('done demo\n')
  expect(result.exitCode).toBe(0)
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled through the link\n')
})

test('two teardowns of one mod run its uninstall once', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\nsleep 1\necho "uninstalled" >> "$HOME/uninstalls"\n' })
  await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))
  await rm(root, { recursive: true })

  const results = await Promise.all([cmod(home, 'teardown', 'demo', '--events'), cmod(home, 'teardown', 'demo', '--events')])

  expect(results.map((result) => result.stdout).sort()).toEqual(['done demo\n', 'missing demo\n'])
  expect(results.map((result) => result.exitCode)).toEqual([0, 0])
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled\n')
})

test('reading a record while a teardown deletes it and a setup writes it again returns the record or nothing, never an error', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))
  const store = join(home, '.local/share/cmod')
  const record = recordPath(store, 'demo')
  const text = await readFile(record, 'utf8')
  let isRewriting = true
  const rewriting = (async () => {
    while (isRewriting) {
      await rm(record)
      await Bun.write(`${record}.tmp`, text)
      await rename(`${record}.tmp`, record)
    }
  })()

  const outcomes = new Set<string>()
  for (let read = 0; read < 2000; read++) {
    outcomes.add(await readRecord(readText, store, 'demo').then((found) => found?.name ?? 'nothing', messageOf))
  }
  isRewriting = false
  await rewriting

  expect([...outcomes].sort()).toEqual(['demo', 'nothing'])
})

test('a setup that starts during a teardown waits, then sets up a mod whose saved step exists', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\ntouch "$HOME/uninstalling"\nsleep 1\necho uninstalled >> "$HOME/uninstalls"\n' })
  const sha256 = await hashOf(root)
  expect((await cmod(home, 'setup', root, '--events', '--consent', sha256)).exitCode).toBe(0)
  const teardown = startCmod(home, 'teardown', 'demo', '--events')
  await waitFor(join(home, 'uninstalling'))

  const setup = await cmod(home, 'setup', root, '--events', '--consent', sha256)

  expect((await teardown.done).stdout).toBe('done demo\n')
  expect(setup.stdout).toEndWith('done demo 0.1.0\n')
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled\n')
  const record = JSON.parse(await readFile(join(home, '.local/share/cmod/records/demo.json'), 'utf8'))
  expect(existsSync(record.uninstall)).toBe(true)
  expect(await readFile(join(home, '.local/share/cmod/data/demo/runs'), 'utf8')).toBe(`ran in ${root} at 0.1.0\n`)
})

test('a teardown during an upgrade waits and removes version 0.2.0', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const store = join(home, '.local/share/cmod')
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\necho "uninstalled $CMOD_VERSION" >> "$HOME/uninstalls"\n' })
  expect((await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))).exitCode).toBe(0)
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }), 'setup/install.sh': '#!/bin/sh\ntouch "$HOME/installing"\nsleep 1\n' })
  const upgrade = startCmod(home, 'setup', root, '--events', '--consent', await hashOf(root))
  await waitFor(join(home, 'installing'))

  const teardown = await cmod(home, 'teardown', 'demo', '--events')

  expect((await upgrade.done).stdout).toBe('done demo 0.2.0\n')
  expect(teardown.stdout).toBe('done demo\n')
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled 0.2.0\n')
  for (const path of [join(store, 'records/demo.json'), join(store, 'records/demo.json.lock'), join(store, 'uninstall/demo'), join(store, 'data/demo')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
})

test('a teardown takes over a lock whose process is gone', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\necho $$ > "$HOME/install-pid"\necho partial >> "$CMOD_DATA/partial"\nexec sleep 30\n')
  const store = join(home, '.local/share/cmod')
  const setup = startCmod(home, 'setup', root, '--events', '--consent', await hashOf(root))
  await waitFor(join(store, 'data/demo/partial'))
  setup.child.kill('SIGKILL')
  await setup.done
  process.kill(Number(await readFile(join(home, 'install-pid'), 'utf8')))

  const result = await cmod(home, 'teardown', 'demo', '--events')

  expect(result.stdout).toBe('missing demo\n')
  expect(result.exitCode).toBe(0)
  for (const path of [join(store, 'data/demo'), join(store, 'records/demo.json.lock'), join(store, 'uninstall/demo')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
})

test('a failed uninstall keeps the record, so teardown can run again', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\necho "zsh: no such file" >&2\nexit 2\n' })
  await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))
  const store = join(home, '.local/share/cmod')

  const result = await cmod(home, 'teardown', 'demo', '--events')

  expect(result.stdout).toBe('log zsh: no such file\nfailed 2\tThe uninstall step of demo exited 2: zsh: no such file. Fix ~/.local/share/cmod/uninstall/demo/uninstall.sh, then run cmod teardown demo.\n')
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(store, 'records/demo.json'))).toBe(true)
  expect(existsSync(join(store, 'uninstall/demo/uninstall.sh'))).toBe(true)
  expect(existsSync(join(store, 'records/demo.json.lock'))).toBe(false)
})

test("a failed removal's message names the saved step from the record under the lock", async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\ntouch "$HOME/installing"\nsleep 1\n')
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\necho "zsh: no such file" >&2\nexit 2\n' })
  const setup = startCmod(home, 'setup', root, '--events', '--consent', await hashOf(root))
  await waitFor(join(home, 'installing'))

  const result = await cmod(home, 'teardown', 'demo')

  expect((await setup.done).exitCode).toBe(0)
  expect(result.exitCode).toBe(1)
  expect(result.stdout).toContain('✘ The uninstall step of demo exited 2: zsh: no such file. Fix ~/.local/share/cmod/uninstall/demo/uninstall.sh, then run cmod teardown demo.\n')
})

test('a failed upgrade keeps only the approval of the version its record names', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const sha256 = await hashOf(root)
  expect((await cmod(home, 'setup', root, '--events', '--consent', sha256)).exitCode).toBe(0)
  const store = join(home, '.local/share/cmod')
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }), 'setup/install.sh': '#!/bin/sh\nexit 3\n' })

  const result = await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))

  expect(result.stdout).toBe('failed 3\t\n')
  expect(JSON.parse(await readFile(join(store, 'records/demo.json'), 'utf8'))).toMatchObject({ version: '0.1.0' })
  expect(await readFile(join(store, 'data/demo/runs'), 'utf8')).toBe(`ran in ${root} at 0.1.0\n`)
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({ demo: [sha256] })
})

test('setup downloads the named program for this platform, checks it against SHA256SUMS, links it, and counts its steps in the bar', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) })
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)

  const result = await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))

  expect(result.stdout).toBe(
    [
      'progress 0 3 Downloading hello 0.2.0',
      'progress 1 3 Checking hello 0.2.0',
      'progress 2 3 Linking ~/.local/bin/hello',
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

  const result = await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))

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

  const result = await cmod(home, 'setup', root, '--yes')

  expect(result.exitCode).toBe(1)
  for (const path of [join(home, '.local/bin/hello'), join(home, '.local/share/cmod/bin/hello'), join(home, '.local/share/cmod/records/hello-mod.json')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
})

test('a failed install of a set-up mod keeps the program its record names', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) })
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  expect((await cmod(home, 'setup', root, '--yes')).exitCode).toBe(0)
  await writeFiles(root, { 'setup/install.sh': '#!/bin/sh\necho "brew: no such formula" >&2\nexit 3\n' })

  const result = await cmod(home, 'setup', root, '--yes')

  expect(result.exitCode).toBe(1)
  expect(await readlink(join(home, '.local/bin/hello'))).toBe(join(home, '.local/share/cmod/bin/hello/0.2.0/hello'))
  expect(existsSync(join(home, '.local/share/cmod/records/hello-mod.json'))).toBe(true)
})

test('a failed upgrade keeps the program the record names', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) })
  const repository = `${server.url.origin}/owner/hello-mod`
  const root = await createProgramMod(home, repository)
  expect((await cmod(home, 'setup', root, '--yes')).exitCode).toBe(0)
  await writeFiles(home, { '.local/share/cmod/bin/hello/0.3.0/hello': '#!/bin/sh\necho "hello 0.3.0"\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.3.0', repository }),
    'setup/install.sh': '#!/bin/sh\necho "brew: no such formula" >&2\nexit 3\n',
  })

  const result = await cmod(home, 'setup', root, '--yes')

  expect(result.exitCode).toBe(1)
  expect(await readlink(join(home, '.local/bin/hello'))).toBe(join(home, '.local/share/cmod/bin/hello/0.2.0/hello'))
  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/records/hello-mod.json'), 'utf8'))).toMatchObject({ version: '0.2.0', program: 'hello' })
})

test('Ctrl+C during the install step of cmod setup leaves no program link', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.2.0' }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { program: 'hello', install: './setup/install.sh' } }),
    'setup/install.sh': '#!/bin/sh\necho partial >> "$CMOD_DATA/partial"\nkill -INT 0\nsleep 1\n',
  })

  const result = await cmodInTerminal(home, 'setup', root, '--yes')

  expect(result.exitCode).toBe(130)
  expect(result.output).toContain('Cancelled the install step of hello-mod on SIGINT.')
  expect(result.output).not.toContain('Fix the step')
  for (const path of [join(home, '.local/bin/hello'), join(store, 'bin/hello'), join(store, 'data/hello-mod'), join(store, 'records/hello-mod.json')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
})

test('Ctrl+C during the install step runs the uninstall step and leaves nothing', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\necho partial >> "$CMOD_DATA/partial"\nkill -INT 0\nsleep 1\n')
  const store = join(home, '.local/share/cmod')

  const result = await cmodInTerminal(home, 'setup', root, '--yes')

  expect(result.exitCode).toBe(130)
  expect(result.output).toContain('Cancelled the install step of demo on SIGINT.')
  expect(result.output).toContain('The uninstall step of demo exited 0.')
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe(`uninstalled from ${root}\n`)
  for (const path of [join(store, 'data/demo'), join(store, 'records/demo.json'), join(store, 'records/demo.json.lock'), join(store, 'uninstall/demo')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
})

test('a fresh install step that traps Ctrl+C and exits 1 runs the uninstall step', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, `#!/bin/sh\ntrap 'exit 1' INT\necho partial >> "$CMOD_DATA/partial"\nkill -INT 0\nsleep 1\n`)
  const store = join(home, '.local/share/cmod')

  const result = await cmodInTerminal(home, 'setup', root, '--yes')

  expect(result.exitCode).toBe(130)
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe(`uninstalled from ${root}\n`)
  for (const path of [join(store, 'data/demo'), join(store, 'records/demo.json'), join(store, 'records/demo.json.lock'), join(store, 'uninstall/demo')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
})

test('a fresh install step that fails runs the uninstall step and leaves nothing', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\necho partial >> "$CMOD_DATA/partial"\necho "brew: no such formula" >&2\nexit 3\n')
  const store = join(home, '.local/share/cmod')

  const result = await cmod(home, 'setup', root, '--yes')

  expect(result.exitCode).toBe(1)
  expect(result.stdout).toContain('The uninstall step of demo exited 0.')
  expect(result.stdout).toContain('✘ The install step of demo exited 3: brew: no such formula. Fix the step, then run the command again.\n')
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe(`uninstalled from ${root}\n`)
  for (const path of [join(store, 'data/demo'), join(store, 'records/demo.json'), join(store, 'records/demo.json.lock'), join(store, 'uninstall/demo')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
})

test('a fresh install whose uninstall step fails says parts may remain', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\necho "curl: could not resolve host" >&2\nexit 7\n')
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\necho "zsh: no such file" >&2\nexit 2\n' })

  const result = await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))

  expect(result.stdout).toBe('log curl: could not resolve host\nlog zsh: no such file\nlog The uninstall step of demo exited 2.\nfailed 7\tcurl: could not resolve host. The uninstall step then exited 2: zsh: no such file, so parts of the install may remain\n')
  expect(result.exitCode).toBe(1)
})

test("Ctrl+C during the undo keeps the install step's exit code and reason", async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\necho "brew: no such formula" >&2\nexit 3\n')
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\nkill -INT 0\nsleep 1\necho uninstalled >> "$HOME/uninstalls"\n' })

  const result = await cmodInTerminal(home, 'setup', root, '--yes')

  expect(result.exitCode).toBe(130)
  expect(result.output).toContain('Cancelled the install step of demo on SIGINT. It exited 3: brew: no such formula.')
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled\n')
})

test("Ctrl+C during an upgrade's install step keeps the version its record names", async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\necho "history the user built" > "$HOME/history.db"\n')
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\nrm -f "$HOME/history.db"\necho "uninstalled $CMOD_VERSION" >> "$HOME/uninstalls"\n' })
  const store = join(home, '.local/share/cmod')
  const installed = await hashOf(root)
  expect((await cmod(home, 'setup', root, '--yes')).exitCode).toBe(0)
  const savedStep = await readFile(join(store, 'uninstall/demo/root/setup/uninstall.sh'), 'utf8')
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }), 'setup/install.sh': '#!/bin/sh\nkill -INT 0\nsleep 1\n' })

  const result = await cmodInTerminal(home, 'setup', root, '--yes')

  expect(result.exitCode).toBe(130)
  expect(result.output).toContain('Cancelled the install step of demo on SIGINT.')
  expect(await readFile(join(home, 'history.db'), 'utf8')).toBe('history the user built\n')
  expect(existsSync(join(home, 'uninstalls'))).toBe(false)
  expect(JSON.parse(await readFile(join(store, 'records/demo.json'), 'utf8'))).toMatchObject({ version: '0.1.0', scriptsSha256: installed })
  expect(await readFile(join(store, 'uninstall/demo/root/setup/uninstall.sh'), 'utf8')).toBe(savedStep)
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({ demo: [installed] })
})

test('cleanup after a cancel revokes the approval while another process holds the consent lock', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, `#!/bin/sh
(trap '' INT HUP TERM; exec sleep 2 </dev/null >/dev/null 2>&1) &
mkdir -p "$HOME/.local/share/cmod/consent.json.lock"
printf '%s' "$(TZ=UTC LC_ALL=C ps -o lstart= -p $! | sed 's/ *$//')" > "$HOME/.local/share/cmod/consent.json.lock/$!"
kill -INT 0
sleep 1
`)
  const store = join(home, '.local/share/cmod')

  const result = await cmodInTerminal(home, 'setup', root, '--yes')

  expect(result.exitCode).toBe(130)
  expect(result.output).toContain('Cancelled the install step of demo on SIGINT.')
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
  for (const path of [join(store, 'data/demo'), join(store, 'records/demo.json'), join(store, 'consent.json.lock')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
}, 15_000)

test("Ctrl+C during cmod remove's uninstall step still removes the mod", async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.2.0' }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { program: 'hello', install: './setup/install.sh', uninstall: './setup/uninstall.sh' } }),
    'setup/install.sh': '#!/bin/sh\necho ran >> "$CMOD_DATA/runs"\n',
    'setup/uninstall.sh': '#!/bin/sh\nkill -INT 0\nsleep 1\necho uninstalled >> "$HOME/uninstalls"\n',
  })
  expect((await cmod(home, 'setup', root, '--yes')).exitCode).toBe(0)

  const result = await cmodInTerminal(home, 'remove', 'hello-mod')

  expect(result.exitCode).toBe(130)
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled\n')
  for (const path of [join(home, '.local/bin/hello'), join(store, 'bin/hello'), join(store, 'data/hello-mod'), join(store, 'records/hello-mod.json'), join(store, 'records/hello-mod.json.lock'), join(store, 'uninstall/hello-mod')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
})

const blockRecordWrite = '#!/bin/sh\nmkdir "$HOME/.local/share/cmod/records/demo.json.$PPID.tmp"\n'

test('a record write that fails after the uninstall step is saved deletes the saved step', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, blockRecordWrite)
  const store = join(home, '.local/share/cmod')

  const result = await cmod(home, 'setup', root, '--yes')

  expect(result.exitCode).toBe(1)
  expect(existsSync(join(store, 'records/demo.json'))).toBe(false)
  expect(await readdir(join(store, 'uninstall')).catch(() => [])).toEqual([])
})

test('a record write that fails in an upgrade keeps the new saved uninstall step, because the new install step ran', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const store = join(home, '.local/share/cmod')
  expect((await cmod(home, 'setup', root, '--yes')).exitCode).toBe(0)
  const newUninstall = '#!/bin/sh\necho "the new uninstall" >> "$HOME/uninstalls"\n'
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }), 'setup/install.sh': blockRecordWrite, 'setup/uninstall.sh': newUninstall })

  const result = await cmod(home, 'setup', root, '--yes')

  expect(result.exitCode).toBe(1)
  expect(await readdir(join(store, 'uninstall'))).toEqual(['demo'])
  expect(await readFile(join(store, 'uninstall/demo/root/setup/uninstall.sh'), 'utf8')).toBe(newUninstall)
  expect(JSON.parse(await readFile(join(store, 'records/demo.json'), 'utf8'))).toMatchObject({ version: '0.1.0' })
})

test('a crash between the saved step and the record leaves a record whose uninstall step exists', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const store = join(home, '.local/share/cmod')
  await writeFiles(root, Object.fromEntries(Array.from({ length: 3000 }, (_, index) => [`setup/lib/${index}.sh`, `echo ${index}\n`])))
  expect((await cmod(home, 'setup', root, '--yes')).exitCode).toBe(0)
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }) })
  const recordFile = join(store, 'records/demo.json')

  const setup = startCmod(home, 'setup', root, '--yes')
  while (setup.child.exitCode === null && !(await readFile(recordFile, 'utf8')).includes('"version": "0.2.0"')) await Bun.sleep(0)
  setup.child.kill('SIGKILL')
  await setup.done

  const record = JSON.parse(await readFile(recordFile, 'utf8'))
  expect(record.version).toBe('0.2.0')
  expect(existsSync(record.uninstall)).toBe(true)
  expect(await listFiles(join(dirname(record.uninstall), 'root/setup'))).toEqual(await listFiles(join(root, 'setup')))
}, 30_000)

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
  expect((await cmod(home, 'setup', root, '--yes')).exitCode).toBe(0)
  expect(await readlink(join(home, '.local/bin/hello'))).toBe(join(store, 'bin/hello/0.2.0/hello'))
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.3.0' }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { install: './setup/install.sh' } }),
  })

  const result = await cmod(home, 'setup', root, '--yes')

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
  expect((await cmod(home, 'setup', root, '--yes')).exitCode).toBe(0)
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.3.0' }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { program: 'hi', install: './setup/install.sh' } }),
  })

  const result = await cmod(home, 'setup', root, '--yes')

  expect(result.exitCode).toBe(0)
  expect(await readlink(join(home, '.local/bin/hi'))).toBe(join(store, 'bin/hi/0.3.0/hi'))
  for (const path of [join(home, '.local/bin/hello'), join(store, 'bin/hello')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
})

test('Ctrl+C while cmod setup downloads the program installs nothing', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) }, 1000)
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  const store = join(home, '.local/share/cmod')

  const setup = startCmod(home, 'setup', root, '--yes')
  await Bun.sleep(500)
  setup.child.kill('SIGINT')
  const result = await setup.done

  expect(result.exitCode).toBe(130)
  expect(result.stdout).toContain('Cancelled setting up hello-mod on SIGINT, before its install step started.')
  expect(result.stdout).not.toContain('Cancelled the install step')
  for (const path of [join(home, '.local/bin/hello'), join(store, 'bin/hello'), join(store, 'data/hello-mod'), join(store, 'records/hello-mod.json')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
})

test('SIGTERM to cmod setup --events during the install step leaves a recorded mod', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.2.0' }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { program: 'hello', install: './setup/install.sh', uninstall: './setup/uninstall.sh' } }),
    'setup/install.sh': '#!/bin/sh\ntouch "$HOME/installing"\nsleep 1\necho ran >> "$CMOD_DATA/runs"\n',
    'setup/uninstall.sh': '#!/bin/sh\necho uninstalled >> "$HOME/uninstalls"\n',
  })

  const setup = startCmod(home, 'setup', root, '--events', '--consent', await hashOf(root))
  await waitFor(join(home, 'installing'))
  setup.child.kill('SIGTERM')
  const result = await setup.done

  expect(result.exitCode).toBe(143)
  expect(JSON.parse(await readFile(join(store, 'records/hello-mod.json'), 'utf8'))).toMatchObject({ version: '0.2.0', program: 'hello', uninstall: join(store, 'uninstall/hello-mod/uninstall.sh') })
  expect(existsSync(join(store, 'uninstall/hello-mod/uninstall.sh'))).toBe(true)
  expect(await readlink(join(home, '.local/bin/hello'))).toBe(join(store, 'bin/hello/0.2.0/hello'))
  expect(await readFile(join(store, 'data/hello-mod/runs'), 'utf8')).toBe('ran\n')
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({ 'hello-mod': [await hashOf(root)] })
})

test('concurrent setups of eight mods keep every approval', async () => {
  const home = await temporaryHome()
  const names = Array.from({ length: 8 }, (_, index) => `mod-${index}`)
  const roots = names.map((name) => join(home, name))
  for (const [index, name] of names.entries()) {
    await writeFiles(roots[index] as string, {
      '.claude-plugin/plugin.json': JSON.stringify({ name, version: '0.1.0' }),
      'package.json': JSON.stringify({ name, cmod: { install: './setup/install.sh' } }),
      'setup/install.sh': '#!/bin/sh\ntrue\n',
    })
  }
  const hashes = await Promise.all(roots.map((root) => hashOf(root)))

  const results = await Promise.all(roots.map((root, index) => cmod(home, 'setup', root, '--events', '--consent', hashes[index] as string)))

  expect(results.map((result) => result.exitCode)).toEqual(names.map(() => 0))
  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/consent.json'), 'utf8'))).toEqual(Object.fromEntries(names.map((name, index) => [name, [hashes[index]]])))
}, 15_000)

test('a mod named constructor sets up', async () => {
  const home = await temporaryHome()
  const root = join(home, 'constructor')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'constructor', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'constructor', cmod: { install: './setup/install.sh' } }),
    'setup/install.sh': '#!/bin/sh\ntrue\n',
  })
  const sha256 = await hashOf(root)

  const result = await cmod(home, 'setup', root, '--events', '--consent', sha256)

  expect(result).toEqual({ exitCode: 0, stdout: 'done constructor 0.1.0\n', stderr: '' })
  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/consent.json'), 'utf8'))).toEqual({ constructor: [sha256] })
})

test('SIGTERM to cmod teardown --events during the uninstall step still removes the mod', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const store = join(home, '.local/share/cmod')
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\ntouch "$HOME/uninstalling"\nsleep 1\necho uninstalled >> "$HOME/uninstalls"\n' })
  expect((await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))).exitCode).toBe(0)

  const teardown = startCmod(home, 'teardown', 'demo', '--events')
  await waitFor(join(home, 'uninstalling'))
  teardown.child.kill('SIGTERM')
  const result = await teardown.done

  expect(result.exitCode).toBe(143)
  expect(result.stdout).toBe('done demo\n')
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled\n')
  for (const path of [join(store, 'records/demo.json'), join(store, 'records/demo.json.lock'), join(store, 'data/demo'), join(store, 'uninstall/demo')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
})

test('six concurrent setups of one mod run the install step once and all exit 0', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\nsleep 0.3\necho ran >> "$CMOD_DATA/runs"\n')
  const store = join(home, '.local/share/cmod')
  const consent = await hashOf(root)

  const results = await Promise.all(Array.from({ length: 6 }, () => cmod(home, 'setup', root, '--events', '--consent', consent)))

  expect(results.map((result) => ({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }))).toEqual(Array.from({ length: 6 }, () => ({ exitCode: 0, stdout: 'done demo 0.1.0\n', stderr: '' })))
  expect(await readFile(join(store, 'data/demo/runs'), 'utf8')).toBe('ran\n')
  expect(await readdir(join(store, 'uninstall'))).toEqual(['demo'])
  expect(await readdir(join(store, 'records'))).toEqual(['demo.json'])
}, 15_000)

test('a setup deletes the staged uninstall folders a killed setup left', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const store = join(home, '.local/share/cmod')
  expect((await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))).exitCode).toBe(0)
  await writeFiles(store, { 'uninstall/demo.tmp/uninstall.sh': 'left by a killed setup\n', 'uninstall/demo.old/uninstall.sh': 'left by a killed setup\n' })
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }) })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toEndWith('done demo 0.2.0\n')
  expect(await readdir(join(store, 'uninstall'))).toEqual(['demo'])
})

test('a setup takes over a lock whose process is gone', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const lock = join(home, '.local/share/cmod/records/demo.json.lock')
  await writeFiles(lock, { [String(await goneProcessId())]: '' })

  const result = await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))

  expect(result.stdout).toEndWith('done demo 0.1.0\n')
  expect(result.exitCode).toBe(0)
  expect(existsSync(lock)).toBe(false)
})

test('a stale consent lock whose process is gone does not stall setup', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const lock = join(home, '.local/share/cmod/consent.json.lock')
  await writeFiles(lock, { [String(await goneProcessId())]: '' })

  const result = await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))

  expect(result.stdout).toEndWith('done demo 0.1.0\n')
  expect(result.exitCode).toBe(0)
  expect(existsSync(lock)).toBe(false)
}, 5_000)

test('a lock held by a live process that is not its holder is taken over', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const lock = join(home, '.local/share/cmod/records/demo.json.lock')
  await writeFiles(lock, { '1': 'Thu Jan  1 00:00:00 2026' })

  const setup = startCmod(home, 'setup', root, '--events', '--consent', await hashOf(root))
  const result = await Promise.race([setup.done, Bun.sleep(3000).then(() => ({ exitCode: -1, stdout: 'still waiting after 3 s', stderr: '' }))])
  setup.child.kill('SIGKILL')

  expect(result.stdout).toEndWith('done demo 0.1.0\n')
  expect(existsSync(lock)).toBe(false)
})

test('a setup that waits for a lock names the lock after a few seconds', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const holder = Bun.spawn(['sleep', '30'])
  await writeFiles(join(home, '.local/share/cmod/records/demo.json.lock'), { [String(holder.pid)]: await startOf(holder.pid) })
  const setup = startCmod(home, 'setup', root, '--events', '--consent', await hashOf(root))
  await Bun.sleep(3500)

  holder.kill()
  await holder.exited
  const result = await setup.done

  expect(result.stderr).toBe(`Waiting for ~/.local/share/cmod/records/demo.json.lock, which process ${holder.pid} holds.\n`)
  expect(result.stdout).toEndWith('done demo 0.1.0\n')
}, 10_000)

test('the spinner resumes after the lock-wait notice', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\n')
  const holder = Bun.spawn(['sleep', '30'])
  await writeFiles(join(home, '.local/share/cmod/records/demo.json.lock'), { [String(holder.pid)]: await startOf(holder.pid) })
  const setup = cmodInTerminal(home, 'setup', root, '--yes')
  await Bun.sleep(3500)

  holder.kill()
  await holder.exited
  const { output } = await setup

  const shown = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  expect(shown.slice(shown.indexOf('which process'))).toContain('Installing demo…')
}, 10_000)

test('a lock whose holder recorded no start time is held while its process lives', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const holder = Bun.spawn(['sleep', '30'])
  await writeFiles(join(home, '.local/share/cmod/records/demo.json.lock'), { [String(holder.pid)]: '' })
  const setup = startCmod(home, 'setup', root, '--events', '--consent', await hashOf(root))
  await Bun.sleep(1000)
  const isWaiting = !existsSync(join(home, '.local/share/cmod/records/demo.json'))

  holder.kill()
  await holder.exited
  const result = await setup.done

  expect(isWaiting).toBe(true)
  expect(result.stdout).toEndWith('done demo 0.1.0\n')
}, 10_000)

test("a holder file with cmod's own process ID is not held", async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const lock = join(home, '.local/share/cmod/records/demo.json.lock')
  const holder = Bun.spawn(['sleep', '30'])
  await writeFiles(lock, { [String(holder.pid)]: await startOf(holder.pid) })
  const setup = startCmod(home, 'setup', root, '--events', '--consent', await hashOf(root))
  await writeFiles(lock, { [String(setup.child.pid)]: '' })

  holder.kill()
  await holder.exited
  const result = await Promise.race([setup.done, Bun.sleep(3000).then(() => ({ exitCode: -1, stdout: 'still waiting after 3 s', stderr: '' }))])
  setup.child.kill('SIGKILL')

  expect(result.stdout).toEndWith('done demo 0.1.0\n')
  expect(existsSync(lock)).toBe(false)
}, 10_000)

test('the consent question says it puts the program into ~/.local/bin', async () => {
  const home = await temporaryHome()
  const root = await createProgramMod(home, 'http://127.0.0.1:9/owner/hello-mod')

  const result = await cmod(home, 'setup', root)

  expect(result.exitCode).toBe(10)
  expect(result.stdout).toContain('  It puts the program hello into ~/.local/bin.\n')
})

test('Ctrl+C while cmod remove waits for the lock prints a cancel line', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const store = join(home, '.local/share/cmod')
  expect((await cmod(home, 'setup', root, '--yes')).exitCode).toBe(0)
  const holder = Bun.spawn(['sleep', '30'])
  await writeFiles(join(store, 'records/demo.json.lock'), { [String(holder.pid)]: await startOf(holder.pid) })
  const removal = startCmod(home, 'remove', 'demo')
  await Bun.sleep(500)

  removal.child.kill('SIGINT')
  const result = await removal.done
  holder.kill()

  expect(result.exitCode).toBe(130)
  expect(result.stdout).toContain('✘ Cancelled uninstalling demo on SIGINT, before its uninstall step started. Run cmod teardown demo to finish.')
  expect(existsSync(join(store, 'records/demo.json'))).toBe(true)
})

test('a current mod whose approval is gone sets up without asking', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  expect((await cmod(home, 'setup', root, '--yes')).exitCode).toBe(0)
  await rm(join(home, '.local/share/cmod/consent.json'))

  const result = await cmod(home, 'setup', root)

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('✔ demo 0.1.0 is ready')
  expect(result.stdout).not.toContain('needs your consent')
  expect(await readFile(join(home, '.local/share/cmod/data/demo/runs'), 'utf8')).toBe(`ran in ${root} at 0.1.0\n`)
})

test('Ctrl+C while cmod waits for a lock ends it at once', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const store = join(home, '.local/share/cmod')
  const holder = Bun.spawn(['sleep', '30'])
  await writeFiles(join(store, 'records/demo.json.lock'), { [String(holder.pid)]: await startOf(holder.pid) })
  const setup = startCmod(home, 'setup', root, '--yes')
  await Bun.sleep(500)

  const cancelledAt = Date.now()
  setup.child.kill('SIGINT')
  const result = await setup.done
  const waitedMs = Date.now() - cancelledAt
  holder.kill()

  expect(result.exitCode).toBe(130)
  expect(waitedMs).toBeLessThan(1000)
  expect(result.stdout).toContain('Cancelled setting up demo on SIGINT, before its install step started.')
  expect(result.stdout).not.toContain('Cancelled the install step')
  for (const path of [join(store, 'data/demo'), join(store, 'records/demo.json'), join(store, 'uninstall/demo')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
})

test('a mod whose scripts change while its setup waits asks consent again', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\ntouch "$HOME/installing"\nsleep 2\necho ran >> "$CMOD_DATA/runs"\n')
  const approved = await hashOf(root)
  const first = startCmod(home, 'setup', root, '--events', '--consent', approved)
  await waitFor(join(home, 'installing'))
  const second = startCmod(home, 'setup', root, '--events', '--consent', approved)
  await Bun.sleep(700)
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\nrm -rf "$HOME/Documents"\n' })
  const changed = await hashOf(root)

  const asked = await second.done

  expect((await first.done).stdout).toBe('done demo 0.1.0\n')
  expect(asked.stdout).toBe(`needs-consent ${changed}\t./setup/install.sh\t./setup/uninstall.sh\n`)
  expect(asked.exitCode).toBe(10)
  expect(await readFile(join(home, '.local/share/cmod/data/demo/runs'), 'utf8')).toBe('ran\n')
}, 15_000)

test('setup --events prints failed with the fix when the release holds no build for this platform, and writes no record', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ SHA256SUMS: sha256Sums(helloBuild) })
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  const url = `${server.url.origin}${release}/hello-${platform}`

  const result = await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))

  expect(result.stdout).toBe(`progress 0 3 Downloading hello 0.2.0\nfailed 1\tDownloading ${url} returned 404. Attach hello-${platform} to the v0.2.0 release, as cmod publish does.\n`)
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(home, '.local/share/cmod/records/hello-mod.json'))).toBe(false)
  expect(existsSync(join(home, '.local/share/cmod/bin/hello'))).toBe(false)
})

test('setup refuses to replace a file in ~/.local/bin that CMod did not make', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) })
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  await writeFiles(home, { '.local/bin/hello': '#!/bin/sh\necho "my own hello"\n' })

  const result = await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))

  expect(result.stdout).toBe('failed 1\t~/.local/bin/hello exists and CMod did not make it, so CMod will not replace it with the hello program. Move it out of ~/.local/bin, then run the command again.\n')
  expect(result.exitCode).toBe(1)
  expect(await readFile(join(home, '.local/bin/hello'), 'utf8')).toBe('#!/bin/sh\necho "my own hello"\n')
  expect(existsSync(join(home, '.local/share/cmod/bin/hello'))).toBe(false)
})

test('setup refuses a program name PATH already finds elsewhere', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) })
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  await writeFiles(home, { 'bin/hello': '#!/bin/sh\necho "another hello"\n' })

  const result = await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))

  expect(result.stdout).toBe('failed 1\tPATH already finds hello at ~/bin/hello, so the hello program CMod installs would never run. Remove that hello from PATH, then run the command again.\n')
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(home, '.local/bin/hello'))).toBe(false)
  expect(existsSync(join(home, '.local/share/cmod/bin/hello'))).toBe(false)
})

test('setup links a program version already in the store, such as one the CMod bootstrap placed, without downloading it', async () => {
  const home = await temporaryHome()
  using server = serveRelease({})
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  await writeFiles(home, { '.local/share/cmod/bin/hello/0.2.0/hello': '#!/bin/sh\necho "placed by the bootstrap"\n' })
  await chmod(join(home, '.local/share/cmod/bin/hello/0.2.0/hello'), 0o755)

  const result = await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))

  expect(result.stdout).toBe('progress 2 3 Linking ~/.local/bin/hello\nprogress 3 3 hello 0.2.0 is installed\nprogress 4 5 Adding the alias\nprogress 5 5 Finishing\ndone hello-mod 0.2.0\n')
  expect(await new Response(Bun.spawn([join(home, '.local/bin/hello')], { stdout: 'pipe' }).stdout).text()).toBe('placed by the bootstrap\n')
})

test('teardown --events prints missing for a plugin with no record, deletes its data folder, and exits 0', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { '.local/share/cmod/data/other-plugin/cache': 'left behind\n' })

  const result = await cmod(home, 'teardown', 'other-plugin', '--events')

  expect(result.stdout).toBe('missing other-plugin\n')
  expect(result.exitCode).toBe(0)
  expect(existsSync(join(home, '.local/share/cmod/data/other-plugin'))).toBe(false)
})

test('teardown removes every installed version of the program', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) })
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  expect((await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))).exitCode).toBe(0)
  const store = join(home, '.local/share/cmod')
  await writeFiles(store, { 'bin/hello/0.1.0/hello': '#!/bin/sh\necho "hello 0.1.0"\n' })
  expect(await readFile(join(store, 'data/hello-mod/runs'), 'utf8')).toBe('ran\n')
  await rm(root, { recursive: true })

  const result = await cmod(home, 'teardown', 'hello-mod', '--events')

  expect(result.stdout).toBe('done hello-mod\n')
  expect(result.exitCode).toBe(0)
  for (const path of [join(home, '.local/bin/hello'), join(store, 'bin/hello'), join(store, 'data/hello-mod'), join(store, 'records/hello-mod.json'), join(store, 'uninstall/hello-mod')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
})
