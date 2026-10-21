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
  'node_modules/@cmodjs/core/register.js': "let registered\nexport const registerMod = (addHook, definition) => {\n  addHook('classic.Setup', () => undefined).catch(() => undefined)\n  registered = definition\n}\nexport const registeredMod = () => registered\n",
  'node_modules/@cmodjs/core/options.js': 'export const userConfigOf = (options) => Object.fromEntries(Object.entries(options).map(([key, option]) => [key, { type: "string", title: option.title, description: "" }]))\n',
  'hooks/hooks.json': JSON.stringify({ modules: ['./register.ts'] }),
  'hooks/register.ts': "import { registerMod } from '../node_modules/@cmodjs/core/register.js'\nexport function register(addHook, options) {\n  registerMod(addHook, { name: 'demo', options: { branch: { title: 'Branch' } }, hotkeys: { runs: { title: 'Show the runs', default: 'ctrl+r' } }, setup() {} }, options)\n}\n",
}

test('cmod check writes the options defineMod declares into plugin.json userConfig and its hotkeys into package.json, keeping each file as it was written', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(home, { '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n' })
  await writeFiles(root, { ...declaringCore, '.claude-plugin/plugin.json': '{\n    "name": "demo",\n    "version": "0.1.0"\n}\n', 'package.json': '{\n  "name": "demo"\n}\n' })

  const result = await cmod(home, 'check', root)

  expect(result.stdout).toContain(
    'Writing the options and hotkeys…\n✔ Wrote the option defineMod declares into plugin.json userConfig: branch\n    Wrote the hotkey defineMod declares into package.json "cmod.hotkeys": runs\n',
  )
  expect(await readFile(join(root, '.claude-plugin/plugin.json'), 'utf8')).toBe(
    '{\n    "name": "demo",\n    "version": "0.1.0",\n    "userConfig": {\n        "branch": {\n            "type": "string",\n            "title": "Branch",\n            "description": ""\n        }\n    }\n}\n',
  )
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).toEqual({ name: 'demo', cmod: { hotkeys: { runs: { title: 'Show the runs', default: 'ctrl+r' } } } })

  const again = await cmod(home, 'check', root)

  expect(again.stdout).toContain('✔ plugin.json userConfig holds the option defineMod declares: branch\n    package.json "cmod.hotkeys" holds the hotkey defineMod declares: runs\n')
})

test('cmod check writes the cmod dependency as >= the @cmodjs/core the mod installed, keeping the rest of the entry', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(home, { '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n' })
  await writeFiles(root, {
    'node_modules/@cmodjs/core/package.json': JSON.stringify({ name: '@cmodjs/core', version: '4.2.0' }),
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0', dependencies: [{ name: 'cmod', marketplace: 'cmod', version: '^4.0.0' }, 'tracer'] }),
    'package.json': JSON.stringify({ name: 'demo' }),
  })

  const result = await cmod(home, 'check', root)
  const again = await cmod(home, 'check', root)

  expect(result.stdout).toContain('Pinning the cmod plugin…\n✔ Wrote the cmod dependency ">=4.2.0", the @cmodjs/core this mod bundles, so every newer cmod runs it\n')
  expect(JSON.parse(await readFile(join(root, '.claude-plugin/plugin.json'), 'utf8')).dependencies).toEqual([{ name: 'cmod', marketplace: 'cmod', version: '>=4.2.0' }, 'tracer'])
  expect(again.stdout).toContain('✔ plugin.json holds the cmod dependency ">=4.2.0"')
})

test('cmod check keeps the cmod range of a mod on @cmodjs/core 3, which cmod 4 does not run', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(home, { '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n' })
  await writeFiles(root, {
    'node_modules/@cmodjs/core/package.json': JSON.stringify({ name: '@cmodjs/core', version: '3.1.0' }),
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0', dependencies: [{ name: 'cmod', version: '^3.1.0' }] }),
    'package.json': JSON.stringify({ name: 'demo' }),
  })

  const result = await cmod(home, 'check', root)

  expect(result.stdout).toContain('Pinning the cmod plugin…\n– No @cmodjs/core 4 or later in node_modules, so the mod keeps its own cmod range\n')
  expect(JSON.parse(await readFile(join(root, '.claude-plugin/plugin.json'), 'utf8')).dependencies).toEqual([{ name: 'cmod', version: '^3.1.0' }])
})

test('cmod check adds the cmod dependency to a plugin.json that names none', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(home, { '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n' })
  await writeFiles(root, {
    'node_modules/@cmodjs/core/package.json': JSON.stringify({ name: '@cmodjs/core', version: '4.0.0' }),
    '.claude-plugin/plugin.json': '{\n  "name": "demo",\n  "version": "0.1.0"\n}\n',
    'package.json': JSON.stringify({ name: 'demo' }),
  })

  await cmod(home, 'check', root)

  expect(JSON.parse(await readFile(join(root, '.claude-plugin/plugin.json'), 'utf8')).dependencies).toEqual([{ name: 'cmod', version: '>=4.0.0' }])
})

test('cmod check names each machine package.json "os" and "cpu" allow that a cmod download line has no build for', async () => {
  const home = await temporaryHome()
  const root = join(home, 'trash-mod')
  const sha = 'a'.repeat(64)
  await writeFiles(home, { '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'trash-mod', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'trash-mod', os: ['darwin'], cmod: { install: './setup/install.sh' } }),
    'setup/install.sh': `#!/bin/sh\ncmod download trash \\\n  darwin-arm64 https://example.com/trash-arm64.zip ${sha}\n`,
  })

  const missing = await cmod(home, 'check', root)

  expect(missing.stdout).toContain(
    'Checking the machines…\n✘ The install step misses a download the mod needs on macOS\n    fix: trash has no download for darwin-x64. Add a <machine> <url> <sha256> line for each, or list only the machines it downloads for in the "os" and "cpu" keys of package.json.\n',
  )

  await writeFiles(root, { 'package.json': JSON.stringify({ name: 'trash-mod', os: ['darwin'], cpu: ['arm64'], cmod: { install: './setup/install.sh' } }) })

  expect((await cmod(home, 'check', root)).stdout).toContain('Checking the machines…\n✔ trash-mod runs on macOS on arm64, and the install step downloads a program for each\n')

  await writeFiles(root, { 'package.json': JSON.stringify({ name: 'trash-mod', os: ['darwin', 'win32'], cmod: { install: './setup/install.sh' } }) })

  expect((await cmod(home, 'check', root)).stdout).toContain(
    '✘ package.json "os" and "cpu" list win32, which cmod does not run mods on\n    fix: cmod runs mods on "darwin" and "linux", on "arm64" and "x64". List only those in the "os" and "cpu" keys of package.json.\n',
  )
})

test('cmod check shows what the person grants at install, and adds approve only for a mod that answers the permission check', async () => {
  const home = await temporaryHome()
  const root = join(home, 'guard')
  await writeFiles(home, { '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'guard', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'guard', cmod: { permissions: { network: ['api.github.com'] } } }),
  })

  const shown = await cmod(home, 'check', root)

  expect(shown.stdout).toContain('Reading the permissions…\n✔ At install the person grants: Connect to api.github.com\n')

  await writeFiles(root, {
    'hooks/register.ts': 'export function register(addHook, options) {\n  registerMod(addHook, guard, options)\n  registerPermissionCheck(addHook)\n}\n',
    'src/mod.ts': 'sessions.current.onPermissionCheck((check) => mod.log(check.name))\n',
  })

  expect((await cmod(home, 'check', root)).stdout).toContain('Reading the permissions…\n✔ At install the person grants: Connect to api.github.com\n')

  await writeFiles(root, { 'src/mod.ts': "sessions.current.beforePermissionCheck(() => ({ refuse: 'No deploys.' }))\n" })

  expect((await cmod(home, 'check', root)).stdout).toContain('Reading the permissions…\n✔ At install the person grants: Connect to api.github.com\n')

  await writeFiles(root, { 'src/mod.ts': "sessions.current.beforePermissionCheck(() => ({ ask: 'Check first.' }))\n" })

  const added = await cmod(home, 'check', root)

  expect(added.stdout).toContain(
    '✔ Added "approve": true to package.json "cmod", because the mod allows or asks on Claude Code\'s permission check\n    At install the person grants: Connect to api.github.com; Approve Claude\'s tool calls for you\n    Anthropic\'s plugin directory does not list a mod that approves Claude\'s tool calls\n',
  )
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).cmod).toEqual({ permissions: { network: ['api.github.com'], approve: true } })
})

test('cmod check fails a mod whose source hears permissions when register.ts does not call registerPermissionCheck', async () => {
  const home = await temporaryHome()
  const root = join(home, 'guard')
  await writeFiles(home, { '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'guard', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'guard' }),
    'hooks/register.ts': 'export function register(addHook, options) {\n  registerMod(addHook, guard, options)\n}\n',
    'src/mod.ts': "sessions.current.beforePermissionCheck(() => ({ ask: 'Check first.' }))\n",
    'src/targets.ts': "import type { Call } from '../node_modules/@cmodjs/core/jobs/permissions.js'\n",
  })

  expect((await cmod(home, 'check', root)).stdout).toContain(
    "Reading the permissions…\n✘ src/mod.ts hears Claude Code's permission check, and hooks/register.ts does not call registerPermissionCheck\n    fix: Add registerPermissionCheck(addHook) after registerMod in hooks/register.ts, then run cmod check again.\n",
  )

  await writeFiles(root, { 'src/mod.ts': "import { prompt } from '../node_modules/@cmodjs/core/jobs/prompt.js'\n" })

  expect((await cmod(home, 'check', root)).stdout).toContain('Reading the permissions…\n– package.json "cmod" asks for no permissions\n')

  await writeFiles(root, {
    'src/mod.ts': "// sessions.current.onPermissionCheck((check) => mod.log(check.name))\n/* import { readFileSync } from 'node:fs' */\nimport type { Stats } from 'node:fs'\nexport type Size = Stats['size']\n",
    'src/view.js': 'export const view = () => <b>hi</b>\n',
  })
  const commented = (await cmod(home, 'check', root)).stdout

  expect(commented).toContain('Reading the permissions…\n– package.json "cmod" asks for no permissions\n')
  expect(commented).toContain('Checking imports…\n✔ Imports reach only the mod, its packages, and claude-code\n')
})

test('cmod check names the line of a metadata block it cannot read', async () => {
  const home = await temporaryHome()
  const root = join(home, 'tagged')
  await writeFiles(home, { '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'tagged', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'tagged' }),
    'skills/commit/SKILL.md': '---\nname: commit\nmetadata:\n  tagged.mode:\n    - build\n---\n',
    'agents/reviewer.md': '---\nname: reviewer\nmetadata: { tagged.mode: review }\n---\n',
  })

  const shown = await cmod(home, 'check', root)

  expect(shown.stdout).toContain('Reading the metadata…\n✘ 1 file with metadata cmod cannot read\n    fix: skills/commit/SKILL.md line 5: a metadata value holds a list or a map.')
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

test('cmod check runs only the tests under the folder bunfig.toml names as the test root, as bun test does', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(home, { '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo' }),
    'bunfig.toml': '[test]\nroot = "tests"\n',
    'tests/mod.test.ts': "import { expect, test } from 'bun:test'\ntest('the mod', () => expect(1).toBe(1))\n",
    'lint/rule.test.ts': "throw new Error('this test runs on Node, never bun test')\n",
  })

  const result = await cmod(home, 'check', root)

  expect(result.stdout).toContain('✔ bun test passed: 1 pass, 0 fail')
  expect(result.stdout).not.toContain('runs on Node')
})

test('cmod check reads the imports of a script a Skill runs, whose first line is a shebang', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(home, { '.local/share/cmod/tools/oxlint/1.86.0/node_modules/.bin/oxlint': 'process.exit(0)\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo' }),
    'skills/status/scripts/live-status.mjs': "#!/usr/bin/env node\nimport { readFileSync } from 'node:fs'\nconsole.log(readFileSync('a'))\n",
  })

  const result = await cmod(home, 'check', root)

  expect(result.stdout).toContain('Checking imports…\n✔ Imports reach only the mod, its packages, and claude-code\n')
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
