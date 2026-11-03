import { afterAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readRecord, recordPath } from '@cmodjs/core/src/records.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { readText } from '../src/files.js'
import { cmod, createMod, createProgramMod, deleteTemporaryHomes, helloBuild, isGone, serveRelease, sha256Sums, startCmod, temporaryHome, waitFor, writeFiles } from './cmod.js'

afterAll(deleteTemporaryHomes)

test('teardown runs the saved uninstall step after the plugin folder is deleted, then deletes the record and the saved step', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await cmod(home, 'setup', root, '--events')
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
  await cmod(home, 'setup', root, '--events')
  await writeFiles(home, { '.claude/cmods/demo/skills/architecture-diagram/SKILL.md': 'My own diagram rules.\n', '.claude/cmods/demo/state.json': '{ "global": { "retries": 5 } }\n' })
  await rm(root, { recursive: true })

  const result = await cmod(home, 'teardown', 'demo', '--events')

  expect(result.stdout).toBe('done demo\n')
  expect(await readFile(join(home, '.claude/cmods/demo/skills/architecture-diagram/SKILL.md'), 'utf8')).toBe('My own diagram rules.\n')
  expect(await readFile(join(home, '.claude/cmods/demo/state.json'), 'utf8')).toBe('{ "global": { "retries": 5 } }\n')
})

test('teardown deletes the mod\'s approvals from consent.json', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)

  expect((await cmod(home, 'teardown', 'demo', '--events')).stdout).toBe('done demo\n')

  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/consent.json'), 'utf8'))).toEqual({})
})

test('the saved uninstall runs a script that sources a sibling file after the plugin folder is gone', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await writeFiles(root, {
    'setup/uninstall.sh': '#!/bin/sh\n. "$(dirname "$0")/lib.sh"\nremove_alias\n',
    'setup/lib.sh': 'remove_alias() {\n  echo "alias removed" >> "$HOME/uninstalls"\n}\n',
  })
  await cmod(home, 'setup', root, '--events')
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
  await cmod(home, 'setup', root, '--events')
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
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
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
  await cmod(home, 'setup', root, '--events')
  await rm(root, { recursive: true })

  const results = await Promise.all([cmod(home, 'teardown', 'demo', '--events'), cmod(home, 'teardown', 'demo', '--events')])

  expect(results.map((result) => result.stdout).sort()).toEqual(['done demo\n', 'missing demo\n'])
  expect(results.map((result) => result.exitCode)).toEqual([0, 0])
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled\n')
})

test('reading a record while a teardown deletes it and a setup writes it again returns the record or nothing, never an error', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  await cmod(home, 'setup', root, '--events')
  const store = join(home, '.local/share/cmod')
  const record = recordPath(store, 'demo')
  const text = await readFile(record, 'utf8')
  let isRewriting = true as boolean
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
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  const teardown = startCmod(home, 'teardown', 'demo', '--events')
  await waitFor(join(home, 'uninstalling'))

  const setup = await cmod(home, 'setup', root, '--events')

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
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }), 'setup/install.sh': '#!/bin/sh\ntouch "$HOME/installing"\nsleep 1\n' })
  const upgrade = startCmod(home, 'setup', root, '--events')
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
  const setup = startCmod(home, 'setup', root, '--events')
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
  await cmod(home, 'setup', root, '--events')
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
  const setup = startCmod(home, 'setup', root, '--events')
  await waitFor(join(home, 'installing'))

  const result = await cmod(home, 'teardown', 'demo')

  expect((await setup.done).exitCode).toBe(0)
  expect(result.exitCode).toBe(1)
  expect(result.stdout).toContain('✘ The uninstall step of demo exited 2: zsh: no such file. Fix ~/.local/share/cmod/uninstall/demo/uninstall.sh, then run cmod teardown demo.\n')
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
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  const store = join(home, '.local/share/cmod')
  await writeFiles(store, { 'bin/hello/0.1.0/hello': '#!/bin/sh\necho "hello 0.1.0"\n' })
  expect(await readFile(join(store, 'data/hello-mod/runs'), 'utf8')).toBe('ran\n')
  await rm(root, { recursive: true })

  const result = await cmod(home, 'teardown', 'hello-mod', '--events')

  expect(result.stdout).toBe('done hello-mod\n')
  expect(result.exitCode).toBe(0)
  for (const path of [join(home, '.local/bin/hello'), join(store, 'programs/hello'), join(store, 'bin/hello'), join(store, 'data/hello-mod'), join(store, 'records/hello-mod.json'), join(store, 'uninstall/hello-mod')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
})
