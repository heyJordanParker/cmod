import { afterEach, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { version as cmodVersion } from '../package.json'
import { claudeAnswering, cmod, cmodPluginListed, deleteTemporaryHomes, temporaryHome, writeFiles } from './cmod.js'

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
    'Checking the steps…\n✘ The steps have a problem\n    fix: package.json "cmod.install" runs "npm run setup", which names no script file in the mod, so consent cannot cover what it runs. Put the commands in a script, such as ./setup/install.sh.\n',
  )
  expect(result.exitCode).toBe(1)
})

test('cmod check has Claude Code write .claude-plugin/types/ for a fresh clone, beside a cmod plugin, with a config of its own and no reachable model, then type-checks', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  const writeTypes = 'env > "$HOME/claude-env"; cat "$2/.claude-plugin/plugin.json" > "$HOME/cmod-plugin"; mkdir -p "$4/.claude-plugin/types" && echo "{}" > "$4/.claude-plugin/types/tsconfig.json"'
  await writeFiles(home, {
    'bin/claude': claudeAnswering(cmodPluginListed, writeTypes),
    '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n',
    '.local/share/cmod/tools/tsc/7.0.2/node_modules/.bin/tsc': 'process.exit(0)\n',
  })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo' }),
    'tsconfig.json': '{}\n',
  })

  const result = await cmod(home, 'check', root)

  expect(result.stdout).toContain('✔ tsc 7.0.2 found no type errors\n')
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toContain(`--plugin-dir ${root} -p ok\n`)
  expect(JSON.parse(await readFile(join(home, 'cmod-plugin'), 'utf8'))).toEqual({ name: 'cmod', version: cmodVersion })
  const env = await readFile(join(home, 'claude-env'), 'utf8')
  expect(env).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:9\n')
  expect(env).toMatch(/^CLAUDE_CONFIG_DIR=.*cmod-claude-/m)
})

test('cmod check skips only the root cli/ folder, so a src/cli/ file is still checked for imports a mod cannot use', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(home, { '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo' }),
    'src/cli/args.ts': "import { argv } from 'node:process'\nexport const args = argv\n",
    'cli/main.ts': "import { readFileSync } from 'node:fs'\nexport const read = readFileSync\n",
  })

  const result = await cmod(home, 'check', root)

  expect(result.stdout).toContain('src/cli/args.ts imports node:process')
  expect(result.stdout).not.toContain('cli/main.ts imports')
})
