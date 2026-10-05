import { afterEach, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeAnswering, cmod, cmodPluginListed, deleteTemporaryHomes, temporaryHome, writeFiles } from './cmod.js'

afterEach(deleteTemporaryHomes)

const claudeCodeLine = 'Plugin is already installed (scope: user) — marked as manually installed — it loads in place from the cache'

async function marketplaceHome(mods: readonly string[]): Promise<string> {
  const home = await temporaryHome()
  const market = join(home, 'market')
  const files: Record<string, string> = {
    'market/.claude-plugin/marketplace.json': JSON.stringify({ name: 'market', owner: { name: 'test' }, plugins: [...mods, 'cmod'].map((name) => ({ name, source: `./${name}` })) }),
    'installed/.keep': '',
  }
  for (const name of mods) {
    files[`market/${name}/.claude-plugin/plugin.json`] = JSON.stringify({ name, version: '0.1.0' })
    files[`market/${name}/package.json`] = JSON.stringify({ name, private: true, dependencies: { 'cmod-sdk': '^0.1.0' } })
    files[`available/${name}@market`] = JSON.stringify({ id: `${name}@market`, version: '0.1.0', scope: 'user', enabled: true, installPath: join(market, name) })
  }
  files['bin/claude'] = `#!/bin/sh
echo "$*" >> "$HOME/claude-calls"
case "$*" in
  "plugin list --json")
    printf '[%s' '${JSON.stringify({ id: 'cmod@cmod', version: '0.1.0', scope: 'user', enabled: true, installPath: home })}'
    for entry in "$HOME"/installed/*@*; do [ -f "$entry" ] && printf ',%s' "$(cat "$entry")"; done
    echo ']' ;;
  "plugin marketplace list --json") echo '${JSON.stringify([{ name: 'market', source: 'directory', path: market, installLocation: market }])}' ;;
  "plugin marketplace add "*) ;;
  "plugin install cmod@cmod --json") echo '{"outcome":"ok","message":"${claudeCodeLine}"}' ;;
  "plugin install "*" --json") cp "$HOME/available/$3" "$HOME/installed/$3" && echo '{"outcome":"ok","message":"${claudeCodeLine}"}' ;;
  *) exit 1 ;;
esac
`
  await writeFiles(home, files)
  return home
}

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
  expect(result.stderr).toBe('cmod install: Claude Code holds no plugin named demo@nowhere. Install one from <owner/repo>, a path such as ./demo, or demo@<marketplace> of a marketplace Claude Code has added. cmod list shows the installed mods.\n')
})

test('install <name>@<marketplace> installs that plugin through Claude Code, prints one line per step, and list shows it ready', async () => {
  const home = await marketplaceHome(['file-tree'])

  const installed = await cmod(home, 'install', 'file-tree@market')

  expect(installed.exitCode).toBe(0)
  expect(installed.stdout).toContain('✔ Installed file-tree@market into Claude Code\n')
  expect(installed.stdout).toContain('✔ Installed cmod@cmod into Claude Code\n')
  expect(installed.stdout).toContain('✔ file-tree 0.1.0 is ready\n')
  expect(installed.stdout).not.toContain(claudeCodeLine)
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toContain('plugin install file-tree@market --json\n')

  const listed = await cmod(home, 'list')

  expect(listed.stdout).toBe('NAME              VERSION  STATE\nfile-tree@market  0.1.0    ready\n')
})

test('install <path> of a marketplace with several mods names them, and installs the one named after the path', async () => {
  const home = await marketplaceHome(['file-tree', 'diagrams'])
  const market = join(home, 'market')

  const asked = await cmod(home, 'install', market)

  expect(asked.exitCode).toBe(1)
  expect(asked.stderr).toBe(`cmod install: ${market} lists several mods: file-tree, diagrams. Name the one to install after it, such as cmod install ${market} file-tree.\n`)

  const chosen = await cmod(home, 'install', market, 'diagrams')

  expect(chosen.exitCode).toBe(0)
  expect(chosen.stdout).toContain('✔ Installed diagrams@market into Claude Code\n')
  expect(chosen.stdout).toContain('✔ diagrams 0.1.0 is ready\n')
})
