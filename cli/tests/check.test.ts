import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { cmod, deleteTemporaryHomes, temporaryHome, writeFiles } from './cmod.js'

afterEach(deleteTemporaryHomes)

test('cmod check refuses an install command that names no script', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(home, { '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo', cmod: { install: 'npm run setup', uninstall: './setup/uninstall.sh' } }),
    'setup/uninstall.sh': '#!/bin/sh\necho "uninstalled"\n',
  })

  const result = await cmod(home, 'check', root)

  expect(result.stdout).toContain(
    'Checking the steps…\n✘ The steps have a problem\n    fix: package.json "cmod.install" runs "npm run setup", which names no script file in the mod: put the commands in a script, such as ./setup/install.sh\n',
  )
  expect(result.exitCode).toBe(1)
})
