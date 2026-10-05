import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeAnswering, cmod, cmodFromSource, cmodPluginListed, deleteTemporaryHomes, temporaryHome, writeFiles } from './cmod.js'

afterEach(deleteTemporaryHomes)

const helloMod = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.2.0' }),
  'package.json': JSON.stringify({ name: 'hello-mod', cmod: { program: 'hello', install: './setup/install.sh', uninstall: './setup/uninstall.sh' } }),
  'setup/install.sh': '#!/bin/sh\necho ran >> "$CMOD_DATA/runs"\n',
  'setup/uninstall.sh': '#!/bin/sh\necho uninstalled >> "$HOME/uninstalls"\n',
}

const sessionListingSetup = `cmod setup "$2" --yes > /dev/null
for path in .local/share/cmod/records/hello-mod.json .local/share/cmod/data/hello-mod/runs .local/bin/hello; do
  test -e "$HOME/$path" && echo "$path" >> "$HOME/during"
done`

test('try prints each step for a mod with no steps, and passes the arguments after -- to claude', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(home, {
    'bin/claude': claudeAnswering(cmodPluginListed, 'echo "claude $*"'),
    'demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
  })

  const result = await cmod(home, 'try', root, '--', '-p', 'hello')

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe(
    [
      'Installing packages for demo…',
      '✔ demo has no packages to install',
      'Installing the CMod plugin into Claude Code…',
      '✔ Installed cmod@cmod into Claude Code',
      'Installing demo…',
      '✔ demo 0.1.0 is ready',
      `claude --plugin-dir ${root} -p hello`,
      'Uninstalling demo…',
      '✔ Removed what CMod set up for demo',
      '',
    ].join('\n'),
  )
})

test('cmod try loads a fresh cmod new mod in a home without the CMod plugin', async () => {
  const home = await temporaryHome()
  const root = join(home, 'my-mod')
  await writeFiles(home, { 'bin/claude': claudeAnswering([], 'true') })
  expect((await cmod(home, 'new', 'my-mod')).exitCode).toBe(0)

  const result = await cmod(home, 'try', root, '--yes')

  expect(result.exitCode).toBe(0)
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toBe(
    `plugin list --json\nplugin marketplace list --json\nplugin marketplace add heyJordanParker/cmod\nplugin install cmod@cmod --json\n--plugin-dir ${root}\n`,
  )
})

test('cmod try leaves no record, data, approval or program link after the session', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(home, { 'bin/claude': claudeAnswering(cmodPluginListed, sessionListingSetup), 'bin/cmod': cmodFromSource })
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, helloMod)

  const result = await cmod(home, 'try', root, '--yes')

  expect(result.exitCode).toBe(0)
  expect(await readFile(join(home, 'during'), 'utf8')).toBe('.local/share/cmod/records/hello-mod.json\n.local/share/cmod/data/hello-mod/runs\n.local/bin/hello\n')
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled\n')
  for (const path of [join(store, 'records/hello-mod.json'), join(store, 'data/hello-mod'), join(store, 'uninstall/hello-mod'), join(store, 'bin/hello'), join(home, '.local/bin/hello')]) {
    expect({ path, exists: existsSync(path) }).toEqual({ path, exists: false })
  }
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
})

test('cmod try refuses a mod another checkout has set up', async () => {
  const home = await temporaryHome()
  const installed = join(home, 'installed/hello-mod')
  const checkout = join(home, 'Developer/hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(installed, helloMod)
  await writeFiles(checkout, helloMod)
  expect((await cmod(home, 'setup', installed, '--yes')).exitCode).toBe(0)
  const record = await readFile(join(store, 'records/hello-mod.json'), 'utf8')

  const result = await cmod(home, 'try', checkout, '--yes')

  expect(result.stderr).toBe('cmod try: hello-mod is set up from ~/installed/hello-mod, so cmod try would replace its record and saved uninstall step. Run cmod remove hello-mod, or cmod unlink ~/installed/hello-mod for a linked checkout, then run cmod try again.\n')
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(home, 'claude-calls'))).toBe(false)
  expect(await readFile(join(store, 'records/hello-mod.json'), 'utf8')).toBe(record)
  expect(await readFile(join(store, 'uninstall/hello-mod/root/setup/uninstall.sh'), 'utf8')).toBe(helloMod['setup/uninstall.sh'])
})

test('cmod try keeps the setup of a checkout that was set up before it', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(home, { 'bin/claude': claudeAnswering(cmodPluginListed, sessionListingSetup), 'bin/cmod': cmodFromSource })
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, helloMod)
  expect((await cmod(home, 'setup', root, '--yes')).exitCode).toBe(0)

  const result = await cmod(home, 'try', root)

  expect(result.exitCode).toBe(0)
  expect(await readFile(join(home, 'during'), 'utf8')).toBe('.local/share/cmod/records/hello-mod.json\n.local/share/cmod/data/hello-mod/runs\n.local/bin/hello\n')
  expect(existsSync(join(home, 'uninstalls'))).toBe(false)
  expect(existsSync(join(store, 'records/hello-mod.json'))).toBe(true)
})
