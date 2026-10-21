import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { version as cmodVersion } from '../package.json'
import { claudeAnswering, cmod, cmodPluginListed, cmodWith, deleteTemporaryHomes, temporaryHome, writeFiles } from './cmod.js'

afterEach(deleteTemporaryHomes)

const claudeCodeLine = 'Plugin is already installed (scope: user) — marked as manually installed — it loads in place from the cache'

const modFiles = (name: string): Record<string, string> => ({
  '.claude-plugin/plugin.json': JSON.stringify({ name, version: '0.1.0' }),
  'package.json': JSON.stringify({ name, private: true, cmod: { install: './setup/install.sh' }, dependencies: { '@cmodjs/core': '^0.1.1' } }),
  'setup/install.sh': '#!/bin/sh\necho ran >> "$CMOD_DATA/runs"\n',
})

const stepFreeFiles = (name: string): Record<string, string> => ({
  '.claude-plugin/plugin.json': JSON.stringify({ name, version: '0.1.0' }),
  'package.json': JSON.stringify({ name, private: true, dependencies: { '@cmodjs/core': '^0.1.1' } }),
})

const plainFiles = (name: string): Record<string, string> => ({ '.claude-plugin/plugin.json': JSON.stringify({ name }) })

async function marketplaceHome(plugins: Record<string, Record<string, string>>): Promise<string> {
  const home = await temporaryHome()
  const market = join(home, 'market')
  const cmodPlugin = JSON.stringify({ id: 'cmod@cmod', version: '0.1.0', scope: 'user', enabled: true, installPath: home })
  const files: Record<string, string> = {
    'market/.claude-plugin/marketplace.json': JSON.stringify({ name: 'market', owner: { name: 'test' }, plugins: [...Object.keys(plugins), 'cmod'].map((name) => ({ name, source: `./${name}` })) }),
    'available/cmod@cmod': cmodPlugin,
    'installed/cmod@cmod': cmodPlugin,
  }
  for (const [name, pluginFiles] of Object.entries(plugins)) {
    for (const [path, text] of Object.entries(pluginFiles)) files[`market/${name}/${path}`] = text
    files[`available/${name}@market`] = JSON.stringify({ id: `${name}@market`, version: '0.1.0', scope: 'user', enabled: true, installPath: join(market, name) })
  }
  files['bin/claude'] = `#!/bin/sh
echo "$*" >> "$HOME/claude-calls"
case "$*" in
  "plugin list --json")
    separator=''
    printf '['
    for entry in "$HOME"/installed/*@*; do [ -f "$entry" ] && printf '%s%s' "$separator" "$(cat "$entry")" && separator=','; done
    echo ']' ;;
  "plugin marketplace list --json") echo '${JSON.stringify([{ name: 'market', source: 'directory', path: market, repo: 'owner/market', installLocation: market }])}' ;;
  "plugin marketplace add "*) ;;
  "plugin install "*" --json") cp "$HOME/available/$3" "$HOME/installed/$3" && echo '{"outcome":"ok","message":"${claudeCodeLine}"}' ;;
  "plugin uninstall "*" --json") rm "$HOME/installed/$3" && echo '{"outcome":"ok"}' ;;
  "plugin enable "*" --json"|"plugin disable "*" --json") echo '{"command":"'"$2"'","outcome":"ok"}' ;;
  "plugin configure "*" --values-stdin --json") cat > "$HOME/configured-$3" && echo '{"outcome":"ok"}' ;;
  "plugin update "*" --json")
    if cp "$HOME/available/$3" "$HOME/installed/$3" 2>/dev/null; then echo '{"outcome":"ok"}'; else echo '{"outcome":"error","message":"'"$3"' is in no marketplace Claude Code has"}'; exit 1; fi ;;
  *) exit 1 ;;
esac
`
  await writeFiles(home, files)
  return home
}

async function claudeCalls(home: string): Promise<string> {
  const calls = await readFile(join(home, 'claude-calls'), 'utf8')
  await rm(join(home, 'claude-calls'))
  return calls
}

const storeOf = (home: string) => join(home, '.local/share/cmod')

test('install <name> runs the install step of a plugin Claude Code already holds', async () => {
  const home = await temporaryHome()
  const root = join(home, 'cache/demo/0.1.0')
  await writeFiles(home, {
    'bin/claude': claudeAnswering([...cmodPluginListed, { id: 'demo@market', version: '0.1.0', scope: 'user', enabled: true, installPath: root }]),
    'cache/demo/0.1.0/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'cache/demo/0.1.0/package.json': JSON.stringify({ name: 'demo', cmod: { install: './setup/install.sh' } }),
    'cache/demo/0.1.0/setup/install.sh': '#!/bin/sh\necho "progress 1 1 Ran"\necho ran >> "$CMOD_DATA/runs"\n',
  })

  const result = await cmod(home, 'install', 'demo', '--yes')

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('✔ demo 0.1.0 is ready')
  expect(await readFile(join(home, '.local/share/cmod/data/demo/runs'), 'utf8')).toBe('ran\n')
  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/records/demo.json'), 'utf8')).root).toBe(root)
})

test('install <name> names the fix when Claude Code holds no such plugin', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { 'bin/claude': `#!/bin/sh\necho '[]'\n` })

  const result = await cmod(home, 'install', 'demo@nowhere')

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe('cmod install: Claude Code holds no plugin named demo@nowhere. Install one from <owner/repo>, a path such as ./demo, or demo@<marketplace> of a marketplace Claude Code has added. cmod list shows every plugin.\n')
})

test('cmod install <name> of a linked plugin says it is linked, and asks Claude Code to install nothing', async () => {
  const home = await marketplaceHome({})
  const checkout = join(home, 'Developer/linked')
  await writeFiles(home, {
    'Developer/linked/.claude-plugin/plugin.json': JSON.stringify({ name: 'linked' }),
    'installed/linked@inline': JSON.stringify({ id: 'linked@inline', version: '0.1.0', scope: 'session', enabled: true, installPath: checkout }),
  })

  const result = await cmod(home, 'install', 'linked')

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe(`– linked@inline is linked from ${checkout}, so saving its files updates it.\n`)
  expect(await claudeCalls(home)).toBe('plugin list --json\n')
})

test('cmod runs the Claude Code that started it, so a claude missing from PATH changes nothing', async () => {
  const home = await marketplaceHome({ 'file-tree': modFiles('file-tree') })
  await rename(join(home, 'bin/claude'), join(home, 'claude-code'))

  const listed = await cmodWith(home, { CLAUDE_CODE_EXECPATH: join(home, 'claude-code') }, 'list')

  expect(listed.exitCode).toBe(0)
  expect(await claudeCalls(home)).toBe('plugin list --json\n')
})

test('cmod runs the claude on PATH when the Claude Code that started it was updated away', async () => {
  const home = await marketplaceHome({ 'file-tree': modFiles('file-tree') })

  const listed = await cmodWith(home, { CLAUDE_CODE_EXECPATH: join(home, 'versions/2.1.301') }, 'list')

  expect(listed.exitCode).toBe(0)
  expect(await claudeCalls(home)).toBe('plugin list --json\n')
})

test('cmod install says nothing about a cmod plugin that is already installed, and turns on one the person turned off', async () => {
  const home = await marketplaceHome({ 'file-tree': modFiles('file-tree'), diagrams: modFiles('diagrams') })
  expect((await cmod(home, 'install', 'file-tree@market', '--yes')).exitCode).toBe(0)
  await claudeCalls(home)

  const again = await cmod(home, 'install', 'diagrams@market', '--yes')

  expect(again.stdout).not.toContain('cmod@cmod')
  await claudeCalls(home)
  const installed = JSON.parse(await readFile(join(home, 'installed/cmod@cmod'), 'utf8'))
  await writeFiles(home, { 'installed/cmod@cmod': JSON.stringify({ ...installed, enabled: false }) })

  const turnedOn = await cmod(home, 'install', 'file-tree@market', '--yes')

  expect(turnedOn.stdout).toContain('✔ Turned cmod@cmod on in Claude Code\n')
  expect(await claudeCalls(home)).toContain('plugin enable cmod@cmod --json\n')
})

test('install <name>@<marketplace> installs that plugin through Claude Code, prints one line per step, and list shows it ready', async () => {
  const home = await marketplaceHome({ 'file-tree': modFiles('file-tree') })

  const installed = await cmod(home, 'install', 'file-tree@market', '--yes')

  expect(installed.exitCode).toBe(0)
  expect(installed.stdout).toContain('✔ Installed file-tree@market into Claude Code\n')
  expect(installed.stdout).toContain('✔ file-tree 0.1.0 is ready\n  Start Claude Code to use file-tree. A session that is running starts it on its own.\n')
  expect(installed.stdout).not.toContain(claudeCodeLine)
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toContain('plugin install file-tree@market --json\n')

  const listed = await cmod(home, 'list')

  expect(listed.stdout).toBe('NAME              VERSION  STATE\ncmod@cmod         0.1.0    enabled\nfile-tree@market  0.1.0    ready\n')
})

test('install <path> of a marketplace with several mods names them, and installs the one named after the path', async () => {
  const home = await marketplaceHome({ 'file-tree': modFiles('file-tree'), diagrams: modFiles('diagrams') })
  const market = join(home, 'market')

  const asked = await cmod(home, 'install', market)

  expect(asked.exitCode).toBe(1)
  expect(asked.stderr).toBe(`cmod install: ${market} lists several plugins: file-tree, diagrams. Name the one to install after it, such as cmod install ${market} file-tree.\n`)

  const chosen = await cmod(home, 'install', market, 'diagrams', '--yes')

  expect(chosen.exitCode).toBe(0)
  expect(chosen.stdout).toContain('✔ Installed diagrams@market into Claude Code\n')
  expect(chosen.stdout).toContain('✔ diagrams 0.1.0 is ready\n')
})

test('install <path> of a marketplace with more than 10 plugins names the first 10 and counts the rest', async () => {
  const names = Array.from({ length: 12 }, (_, index) => `plugin-${index + 1}`)
  const home = await marketplaceHome(Object.fromEntries(names.map((name) => [name, plainFiles(name)])))
  const market = join(home, 'market')

  const asked = await cmod(home, 'install', market)

  expect(asked.exitCode).toBe(1)
  expect(asked.stderr).toBe(
    `cmod install: ${market} lists several plugins: plugin-1, plugin-2, plugin-3, plugin-4, plugin-5, plugin-6, plugin-7, plugin-8, plugin-9, plugin-10, and 2 more. Name the one to install after it, such as cmod install ${market} plugin-1.\n`,
  )
})

test('cmod install of a plugin with no cmod steps runs only claude plugin install', async () => {
  const home = await marketplaceHome({ plain: plainFiles('plain') })

  const result = await cmod(home, 'install', 'plain@market')

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('✔ Installed plain@market into Claude Code\n')
  expect(await claudeCalls(home)).toBe('plugin list --json\nplugin marketplace list --json\nplugin install plain@market --json\nplugin list --json\n')
  expect(existsSync(storeOf(home))).toBe(false)
})

test('cmod install of a plain plugin from owner/repo adds the marketplace and installs it, nothing more', async () => {
  const home = await marketplaceHome({ plain: plainFiles('plain') })

  const result = await cmod(home, 'install', 'owner/market')

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('✔ Installed plain@market into Claude Code\n')
  expect(await claudeCalls(home)).toBe('plugin marketplace add owner/market\nplugin marketplace list --json\nplugin install plain@market --json\nplugin list --json\n')
  expect(existsSync(storeOf(home))).toBe(false)
})

test('cmod install <name> of a plain plugin Claude Code already holds installs it through Claude Code, nothing more', async () => {
  const home = await marketplaceHome({ plain: plainFiles('plain') })
  expect((await cmod(home, 'install', 'plain@market')).exitCode).toBe(0)
  await claudeCalls(home)

  const result = await cmod(home, 'install', 'plain')

  expect(result.exitCode).toBe(0)
  expect(await claudeCalls(home)).toBe('plugin list --json\nplugin install plain@market --json\nplugin list --json\n')
  expect(existsSync(storeOf(home))).toBe(false)
})

test('cmod remove of a plain plugin uninstalls it through Claude Code', async () => {
  const home = await marketplaceHome({ plain: plainFiles('plain') })
  expect((await cmod(home, 'install', 'plain@market')).exitCode).toBe(0)
  await claudeCalls(home)

  const result = await cmod(home, 'remove', 'plain')

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('✔ Uninstalled plain@market from Claude Code\n')
  expect(await claudeCalls(home)).toBe('plugin list --json\nplugin uninstall plain@market --json\n')
  expect(existsSync(storeOf(home))).toBe(false)
})

test('cmod remove of a name Claude Code does not hold and cmod never set up points at cmod list', async () => {
  const home = await marketplaceHome({})

  const result = await cmod(home, 'remove', 'ghost')

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe('cmod remove: ghost is neither installed nor set up. cmod list shows every plugin.\n')
})

test('cmod disable and cmod enable turn a mod off and on through Claude Code, and keep its setup', async () => {
  const home = await marketplaceHome({ demo: modFiles('demo') })
  expect((await cmod(home, 'install', 'demo@market', '--yes')).exitCode).toBe(0)
  await claudeCalls(home)

  const installed = await readFile(join(storeOf(home), 'plugins-changed'), 'utf8')

  const off = await cmod(home, 'disable', 'demo')
  const turnedOff = await readFile(join(storeOf(home), 'plugins-changed'), 'utf8')
  const on = await cmod(home, 'enable', 'demo@market')

  expect(turnedOff).not.toBe(installed)
  expect(await readFile(join(storeOf(home), 'plugins-changed'), 'utf8')).not.toBe(turnedOff)
  expect(off.exitCode).toBe(0)
  expect(off.stdout).toContain('✔ Turned demo@market off in Claude Code and every running session.\n')
  expect(on.stdout).toContain('✔ Turned demo@market on in Claude Code and every running session.\n')
  expect(await claudeCalls(home)).toBe('plugin list --json\nplugin disable demo@market --json\nplugin list --json\nplugin enable demo@market --json\n')
  expect(existsSync(join(storeOf(home), 'records/demo.json'))).toBe(true)
})

test('cmod option sets one declared option through claude plugin configure, and refuses an option the plugin lacks', async () => {
  const files = { ...plainFiles('demo'), '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', userConfig: { branch: { type: 'string', title: 'Branch' } } }) }
  const home = await marketplaceHome({ demo: files })
  expect((await cmod(home, 'install', 'demo@market')).exitCode).toBe(0)
  await claudeCalls(home)

  const set = await cmod(home, 'option', 'demo', 'branch', 'release')
  const missing = await cmod(home, 'option', 'demo', 'colour', 'red')

  expect(set.stdout).toBe('Set branch for demo.\n')
  expect(JSON.parse(await readFile(join(home, 'configured-demo@market'), 'utf8'))).toEqual({ branch: 'release' })
  expect(missing.exitCode).toBe(1)
  expect(missing.stderr).toBe('cmod option: demo has no option colour. Its options are: branch.\n')
})

test('cmod option sets an option of a linked mod by the id Claude Code lists it under, as Settings and the first-start questions do', async () => {
  const home = await marketplaceHome({})
  const checkout = join(home, 'Developer/linked')
  await writeFiles(home, {
    'Developer/linked/.claude-plugin/plugin.json': JSON.stringify({ name: 'linked', userConfig: { tracerOnly: { type: 'boolean', title: 'Tracer only' } } }),
    'installed/linked@inline': JSON.stringify({ id: 'linked@inline', version: '0.1.0', scope: 'session', enabled: true, installPath: checkout }),
  })

  const set = await cmod(home, 'option', 'linked', 'tracerOnly', 'true')

  expect(set.stdout).toBe('Set tracerOnly for linked.\n')
  expect(JSON.parse(await readFile(join(home, 'configured-linked@inline'), 'utf8'))).toEqual({ tracerOnly: 'true' })
})

test('cmod disable of a name Claude Code does not hold points at cmod list', async () => {
  const home = await marketplaceHome({})

  const result = await cmod(home, 'disable', 'ghost')

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe('cmod disable: No installed plugin is named ghost. cmod list shows the installed plugins.\n')
})

test('cmod update <name> of a plain plugin updates it through Claude Code, nothing more', async () => {
  const home = await marketplaceHome({ plain: plainFiles('plain') })
  expect((await cmod(home, 'install', 'plain@market')).exitCode).toBe(0)
  await claudeCalls(home)

  const result = await cmod(home, 'update', 'plain')

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('✔ Updated plain@market through Claude Code\n')
  expect(await claudeCalls(home)).toBe('plugin list --json\nplugin update plain@market --json\nplugin list --json\n')
  expect(existsSync(storeOf(home))).toBe(false)
})

test('cmod update cmod updates every copy of the cmod plugin, and asks no consent for the hotkeys the cmod plugin binds itself', async () => {
  const home = await marketplaceHome({})
  const copy = (id: string) => JSON.stringify({ id, version: '4.0.0', scope: 'user', enabled: true, installPath: join(home, 'cmod-plugin') })
  await writeFiles(home, {
    'cmod-plugin/.claude-plugin/plugin.json': JSON.stringify({ name: 'cmod', version: '4.0.0' }),
    'cmod-plugin/package.json': JSON.stringify({ name: 'cmod', cmod: { hotkeys: { sidebar: { title: 'Show or hide the Sidebar', default: 'ctrl+q' } } } }),
    'available/cmod@cmod': copy('cmod@cmod'),
    'installed/cmod@cmod': copy('cmod@cmod'),
    'available/cmod@market': copy('cmod@market'),
    'installed/cmod@market': copy('cmod@market'),
  })

  const result = await cmod(home, 'update', 'cmod')

  expect(result.exitCode).toBe(0)
  expect(await claudeCalls(home)).toBe('plugin list --json\nplugin update cmod@cmod --json\nplugin update cmod@market --json\nplugin list --json\n')
  expect(existsSync(storeOf(home))).toBe(false)
})

test('cmod update updates every plugin Claude Code holds, and checks the setup of the mods only', async () => {
  const home = await marketplaceHome({ plain: plainFiles('plain'), 'file-tree': modFiles('file-tree') })
  expect((await cmod(home, 'install', 'plain@market')).exitCode).toBe(0)
  expect((await cmod(home, 'install', 'file-tree@market', '--yes')).exitCode).toBe(0)
  await claudeCalls(home)

  const result = await cmod(home, 'update')

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('✔ file-tree 0.1.0 is already set up\n')
  expect(result.stdout).not.toContain('plain 0.1.0')
  expect(await claudeCalls(home)).toBe(
    'plugin list --json\nplugin update cmod@cmod --json\nplugin update file-tree@market --json\nplugin update plain@market --json\nplugin list --json\nplugin list --json\nplugin install cmod@cmod --json\n',
  )
  expect(existsSync(join(storeOf(home), 'records/plain.json'))).toBe(false)
})

test('cmod update of two mods installs the cmod plugin once', async () => {
  const home = await marketplaceHome({ 'file-tree': modFiles('file-tree'), diagrams: modFiles('diagrams') })
  expect((await cmod(home, 'install', 'file-tree@market', '--yes')).exitCode).toBe(0)
  expect((await cmod(home, 'install', 'diagrams@market', '--yes')).exitCode).toBe(0)
  await claudeCalls(home)

  const result = await cmod(home, 'update')

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('✔ file-tree 0.1.0 is already set up\n')
  expect(result.stdout).toContain('✔ diagrams 0.1.0 is already set up\n')
  expect(await claudeCalls(home)).toBe(
    'plugin list --json\nplugin update cmod@cmod --json\nplugin update diagrams@market --json\nplugin update file-tree@market --json\nplugin list --json\nplugin list --json\nplugin install cmod@cmod --json\n',
  )
})

test('cmod update with no name updates the mods after a plugin whose update fails, and exits 1', async () => {
  const home = await marketplaceHome({ archived: plainFiles('archived'), 'file-tree': modFiles('file-tree') })
  expect((await cmod(home, 'install', 'archived@market')).exitCode).toBe(0)
  expect((await cmod(home, 'install', 'file-tree@market', '--yes')).exitCode).toBe(0)
  await rm(join(home, 'available/archived@market'))
  await claudeCalls(home)

  const result = await cmod(home, 'update')

  expect(result.exitCode).toBe(1)
  expect(result.stdout).toContain('✘ claude plugin update archived@market failed: archived@market is in no marketplace Claude Code has\n')
  expect(result.stdout).toContain('✔ Updated file-tree@market through Claude Code\n')
  expect(result.stdout).toContain('✔ file-tree 0.1.0 is already set up\n')
  expect(await claudeCalls(home)).toBe(
    'plugin list --json\nplugin update archived@market --json\nplugin update cmod@cmod --json\nplugin update file-tree@market --json\nplugin list --json\nplugin list --json\nplugin install cmod@cmod --json\n',
  )
})

test('cmod update of a plugin whose new version adds steps installs the cmod plugin and sets it up', async () => {
  const home = await marketplaceHome({ demo: plainFiles('demo') })
  expect((await cmod(home, 'install', 'demo@market')).exitCode).toBe(0)
  await rm(join(home, 'installed/cmod@cmod'))
  await writeFiles(home, {
    'market/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }),
    'market/demo/package.json': JSON.stringify({ name: 'demo', private: true, cmod: { install: './setup/install.sh' } }),
    'market/demo/setup/install.sh': '#!/bin/sh\necho ran >> "$CMOD_DATA/runs"\n',
    'available/demo@market': JSON.stringify({ id: 'demo@market', version: '0.2.0', scope: 'user', enabled: true, installPath: join(home, 'market/demo') }),
  })
  await claudeCalls(home)

  const result = await cmod(home, 'update', 'demo', '--yes')

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('✔ Installed cmod@cmod into Claude Code\n')
  expect(result.stdout).toContain('✔ demo 0.2.0 is ready\n  Start Claude Code to use demo. In a session that is already open, run /reload-plugins once, so it loads the cmod plugin and demo.\n')
  expect(await readFile(join(storeOf(home), 'data/demo/runs'), 'utf8')).toBe('ran\n')
  expect(await claudeCalls(home)).toBe(
    'plugin list --json\nplugin update demo@market --json\nplugin list --json\nplugin list --json\nplugin marketplace list --json\nplugin marketplace add heyJordanParker/cmod\nplugin install cmod@cmod --json\n',
  )
})

test('cmod update with no name skips linked plugins', async () => {
  const home = await marketplaceHome({ plain: plainFiles('plain') })
  const checkout = join(home, 'Developer/linked')
  await writeFiles(home, {
    'Developer/linked/.claude-plugin/plugin.json': JSON.stringify({ name: 'linked' }),
    'installed/linked@inline': JSON.stringify({ id: 'linked@inline', version: '0.1.0', scope: 'session', enabled: true, installPath: checkout }),
  })
  expect((await cmod(home, 'install', 'plain@market')).exitCode).toBe(0)
  await claudeCalls(home)
  const linkedLine = `– linked@inline is linked from ${checkout}, so saving its files updates it.\n`

  const all = await cmod(home, 'update')

  expect(all.exitCode).toBe(0)
  expect(all.stdout).toContain(linkedLine)
  expect(await claudeCalls(home)).toBe('plugin list --json\nplugin update cmod@cmod --json\nplugin update plain@market --json\nplugin list --json\n')

  const named = await cmod(home, 'update', 'linked')

  expect(named.exitCode).toBe(0)
  expect(named.stdout).toBe(linkedLine)
  expect(await claudeCalls(home)).toBe('plugin list --json\n')
})

test('cmod list shows a plugin with no cmod steps as Claude Code holds it', async () => {
  const home = await marketplaceHome({ 'file-tree': stepFreeFiles('file-tree'), plain: plainFiles('plain') })
  await writeFiles(home, {
    'installed/file-tree@market': JSON.stringify({ id: 'file-tree@market', version: '0.1.0', scope: 'user', enabled: true, installPath: join(home, 'market/file-tree') }),
    'installed/plain@market': JSON.stringify({ id: 'plain@market', version: '2.0.0', scope: 'user', enabled: false, installPath: join(home, 'market/plain'), errors: ['hooks/hooks.json is not valid'] }),
  })

  const listed = await cmod(home, 'list')

  expect(listed.exitCode).toBe(0)
  expect(listed.stdout).toBe(
    'NAME              VERSION  STATE\ncmod@cmod         0.1.0    enabled\nfile-tree@market  0.1.0    enabled\nplain@market      2.0.0    disabled: hooks/hooks.json is not valid\n',
  )
  expect(existsSync(storeOf(home))).toBe(false)
})

test('cmod list says why Claude Code turned a mod off, and --json names each dependency it needs newer', async () => {
  const home = await marketplaceHome({ 'file-tree': stepFreeFiles('file-tree') })
  const unmet = 'Requires "cmod@market" >=4.0.3, installed 4.0.2'
  await writeFiles(home, {
    'installed/file-tree@market': JSON.stringify({ id: 'file-tree@market', version: '0.1.0', scope: 'user', enabled: true, installPath: join(home, 'market/file-tree'), errors: [unmet], errorDetails: [{ type: 'dependency-version-unsatisfied', plugin: 'file-tree', dependency: 'cmod@market' }] }),
  })

  const listed = await cmod(home, 'list')
  const json = await cmod(home, 'list', '--json')

  expect(listed.stdout).toContain(`file-tree@market  0.1.0    Claude Code turned it off: ${unmet}\n`)
  expect(JSON.parse(json.stdout)).toContainEqual({ name: 'file-tree@market', version: '0.1.0', state: `Claude Code turned it off: ${unmet}`, unsatisfied: ['cmod@market'] })
})

test('cmod list shows the cmod plugin ready when the cmod program is its version or newer, with no record', async () => {
  const home = await marketplaceHome({})
  const cmodPluginAt = (version: string) => ({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'cmod', version }),
    'package.json': JSON.stringify({ name: 'cmod', private: true, cmod: { program: 'cmod' } }),
  })
  await writeFiles(join(home, 'plugins/cmod'), cmodPluginAt(cmodVersion))
  await writeFiles(home, { 'installed/cmod@cmod': JSON.stringify({ id: 'cmod@cmod', version: cmodVersion, scope: 'user', enabled: true, installPath: join(home, 'plugins/cmod') }) })

  const current = await cmod(home, 'list')

  expect(current.stdout).toBe(`NAME       VERSION  STATE\ncmod@cmod  ${cmodVersion.padEnd(7)}  ready\n`)

  await writeFiles(join(home, 'plugins/cmod'), cmodPluginAt('0.0.1'))

  const ahead = await cmod(home, 'list')

  expect(ahead.stdout).toBe(`NAME       VERSION  STATE\ncmod@cmod  0.0.1    ready\n`)

  await writeFiles(join(home, 'plugins/cmod'), cmodPluginAt('9.9.9'))

  const behind = await cmod(home, 'list')

  expect(behind.stdout).toBe(`NAME       VERSION  STATE\ncmod@cmod  9.9.9    the cmod program is ${cmodVersion}: start a Claude Code session to fetch 9.9.9\n`)
  expect(existsSync(storeOf(home))).toBe(false)
})
