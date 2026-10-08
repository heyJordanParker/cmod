import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, symlink } from 'node:fs/promises'
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

  expect(result.stdout).toContain('✔ tsc 7.0.2 found no type errors with tsconfig.json\n')
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toContain(`--plugin-dir ${root} -p ok\n`)
  expect(JSON.parse(await readFile(join(home, 'cmod-plugin'), 'utf8'))).toEqual({ name: 'cmod', version: cmodVersion })
  const env = await readFile(join(home, 'claude-env'), 'utf8')
  expect(env).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:9\n')
  expect(env).toMatch(/^CLAUDE_CONFIG_DIR=.*cmod-claude-/m)
})

test('cmod check has Claude Code write .claude-plugin/types/ again when a link in it leads into a home cmod try deleted', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  const writeTypes = 'mkdir -p "$4/.claude-plugin/types" && echo "{}" > "$4/.claude-plugin/types/tsconfig.json"'
  await writeFiles(home, {
    'bin/claude': claudeAnswering(cmodPluginListed, writeTypes),
    '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n',
    '.local/share/cmod/tools/tsc/7.0.2/node_modules/.bin/tsc': 'process.exit(0)\n',
  })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    '.claude-plugin/types/tsconfig.json': JSON.stringify({ compilerOptions: { types: ['cmod'] } }),
    'package.json': JSON.stringify({ name: 'demo' }),
    'tsconfig.json': '{}\n',
  })
  await mkdir(join(root, '.claude-plugin/types/cmod'))
  await symlink(join(home, 'cmod-try-home-gone/.claude/plugins/cache/cmod/cmod/0.1.12/types/index.d.ts'), join(root, '.claude-plugin/types/cmod/index.d.ts'))

  const result = await cmod(home, 'check', root)

  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toContain(`--plugin-dir ${root} -p ok\n`)
  expect(existsSync(join(root, '.claude-plugin/types/cmod'))).toBe(false)
  expect(await readFile(join(root, '.claude-plugin/types/tsconfig.json'), 'utf8')).toBe('{}\n')
  expect(result.stdout).toContain('✔ tsc 7.0.2 found no type errors with tsconfig.json\n')
})

const declaringCore = {
  'node_modules/@cmodjs/core/register.js': 'let registered\nexport const registerMod = (_addHook, definition) => { registered = definition }\nexport const registeredMod = () => registered\n',
  'node_modules/@cmodjs/core/options.js': 'export const userConfigOf = (options) => Object.fromEntries(Object.entries(options).map(([key, option]) => [key, { type: "string", title: option.title, description: "" }]))\n',
  'hooks/hooks.json': JSON.stringify({ modules: ['./register.ts'] }),
  'hooks/register.ts': "import { registerMod } from '../node_modules/@cmodjs/core/register.js'\nexport function register(addHook, options) {\n  registerMod(addHook, { name: 'demo', options: { branch: { title: 'Branch' } }, setup() {} }, options)\n}\n",
}

test('cmod check writes the options defineMod declares into plugin.json userConfig, keeping the file as it was written', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(home, { '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n' })
  await writeFiles(root, { ...declaringCore, '.claude-plugin/plugin.json': '{\n    "name": "demo",\n    "version": "0.1.0"\n}\n', 'package.json': JSON.stringify({ name: 'demo' }) })

  const result = await cmod(home, 'check', root)

  expect(result.stdout).toContain('Writing the options into plugin.json…\n✔ Wrote the option defineMod declares into plugin.json userConfig: branch\n')
  expect(await readFile(join(root, '.claude-plugin/plugin.json'), 'utf8')).toBe(
    '{\n    "name": "demo",\n    "version": "0.1.0",\n    "userConfig": {\n        "branch": {\n            "type": "string",\n            "title": "Branch",\n            "description": ""\n        }\n    }\n}\n',
  )

  const again = await cmod(home, 'check', root)

  expect(again.stdout).toContain('✔ plugin.json userConfig holds the option defineMod declares: branch\n')
})

test('cmod check type-checks tests/ with tests/tsconfig.json beside the root config', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(home, {
    '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n',
    '.local/share/cmod/tools/tsc/7.0.2/node_modules/.bin/tsc': "require('node:fs').appendFileSync(`${process.env.HOME}/tsc-calls`, `${process.argv.slice(2).join(' ')}\\n`)\nprocess.exit(process.argv.includes(`${process.env.HOME}/demo/tests/tsconfig.json`) ? 2 : 0)\n",
  })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    '.claude-plugin/types/tsconfig.json': '{}\n',
    'package.json': JSON.stringify({ name: 'demo' }),
    'tsconfig.json': '{}\n',
    'tests/tsconfig.json': '{}\n',
  })

  const result = await cmod(home, 'check', root)

  expect(await readFile(join(home, 'tsc-calls'), 'utf8')).toBe(`-p ${root}/tsconfig.json --noEmit\n-p ${root}/tests/tsconfig.json --noEmit\n`)
  expect(result.stdout).toContain('✘ tsc 7.0.2 found type errors:\n      tests/tsconfig.json:\n')
  expect(result.exitCode).toBe(1)
})

test('cmod check bundles the hooks module as cmod publish does, and names each reason a bundle fails', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(home, { '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo' }),
    'hooks/hooks.json': JSON.stringify({ modules: ['./register.ts'] }),
    'hooks/register.ts': "import { missing } from './gone.js'\nimport { lost } from 'not-installed-anywhere'\nexport const register = () => [missing, lost]\n",
  })

  const result = await cmod(home, 'check', root)

  expect(result.stdout).toContain('Bundling the hooks…\n✘ Bundling hooks/./register.ts failed: ')
  expect(result.stdout).toContain('Could not resolve: "./gone.js"')
  expect(result.stdout).toContain('Could not resolve: "not-installed-anywhere"')
  expect(result.stdout).not.toContain('Bundle failed')
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
