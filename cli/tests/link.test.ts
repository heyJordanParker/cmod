import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readlink, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeAnswering, cmod, deleteTemporaryHomes, temporaryHome, writeFiles } from './cmod.js'

afterEach(deleteTemporaryHomes)

const settings = `{
  // stowed from dotfiles
  "model": "opus",
  "env": {
    "FOO": "1"
  },
  "permissions": { "allow": ["Bash(ls)"] }
}
`

async function linkedHome(text: string): Promise<{ home: string; checkout: string; target: string; link: string }> {
  const home = await temporaryHome()
  const checkout = join(home, 'Developer', 'demo')
  const target = join(home, 'dotfiles', 'settings.json')
  const link = join(home, '.claude', 'settings.json')
  await writeFiles(home, { 'dotfiles/settings.json': text, 'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }) })
  await mkdir(join(home, '.claude'))
  await symlink(target, link)
  return { home, checkout, target, link }
}

test('link writes the plugin folder into env.CLAUDE_CODE_PLUGIN_DIRS through a symlinked settings.json and leaves every other byte unchanged', async () => {
  const { home, checkout, target, link } = await linkedHome(settings)

  const linked = await cmod(home, 'link', checkout)

  expect(linked.exitCode).toBe(0)
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  expect(await readFile(target, 'utf8')).toBe(settings.replace('"FOO": "1"', '"FOO": "1",\n    "CLAUDE_CODE_PLUGIN_DIRS": "~/Developer/demo"'))

  const unlinked = await cmod(home, 'unlink', checkout)

  expect(unlinked.exitCode).toBe(0)
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  expect(await readFile(target, 'utf8')).toBe(settings)
})

test('link appends to an existing CLAUDE_CODE_PLUGIN_DIRS and keeps ~, and unlink removes only its entry', async () => {
  const existing = settings.replace('"FOO": "1"', '"CLAUDE_CODE_PLUGIN_DIRS": "~/Developer/other"')
  const { home, checkout, target } = await linkedHome(existing)

  expect((await cmod(home, 'link', checkout)).exitCode).toBe(0)
  expect(await readFile(target, 'utf8')).toBe(existing.replace('"~/Developer/other"', '"~/Developer/other:~/Developer/demo"'))
  expect((await cmod(home, 'link', checkout)).exitCode).toBe(0)
  expect(await readFile(target, 'utf8')).toBe(existing.replace('"~/Developer/other"', '"~/Developer/other:~/Developer/demo"'))

  expect((await cmod(home, 'unlink', checkout)).exitCode).toBe(0)
  expect(await readFile(target, 'utf8')).toBe(existing)
})

test('link creates settings.json with the env block when the config root has none', async () => {
  const home = await temporaryHome()
  const checkout = join(home, 'Developer', 'demo')
  await writeFiles(home, { 'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }) })

  expect((await cmod(home, 'link', checkout)).exitCode).toBe(0)
  expect(JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'))).toEqual({ env: { CLAUDE_CODE_PLUGIN_DIRS: '~/Developer/demo' } })
})

test('link builds the program cli/ declares into the store and points ~/.local/bin at it, and unlink removes both', async () => {
  const home = await temporaryHome()
  const checkout = join(home, 'Developer', 'hello-mod')
  const build = `mkdir -p dist && printf '#!/bin/sh\\necho hello from the build\\n' > dist/hello-${process.platform}-${process.arch}`
  await writeFiles(checkout, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.3.0' }),
    'cli/package.json': JSON.stringify({ name: 'hello', cmod: { build, output: 'dist' } }),
  })
  const entry = join(home, '.local/bin/hello')
  const target = join(home, '.local/share/cmod/bin/hello/0.3.0/hello')

  expect((await cmod(home, 'link', checkout)).exitCode).toBe(0)
  expect(await readlink(entry)).toBe(target)
  expect(await new Response(Bun.spawn([entry], { stdout: 'pipe' }).stdout).text()).toBe('hello from the build\n')

  expect((await cmod(home, 'unlink', checkout)).exitCode).toBe(0)
  expect(existsSync(entry)).toBe(false)
  expect(existsSync(join(home, '.local/share/cmod/bin/hello'))).toBe(false)
})

test('a failed build shows one sentence that ends with one period', async () => {
  const home = await temporaryHome()
  const checkout = join(home, 'Developer', 'hello-mod')
  const build = 'echo "make: no rule for dist?" >&2; exit 2'
  await writeFiles(checkout, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.3.0' }),
    'cli/package.json': JSON.stringify({ name: 'hello', cmod: { build, output: 'dist' } }),
  })

  const result = await cmod(home, 'link', checkout)

  expect(result.exitCode).toBe(1)
  expect(result.stdout).toContain(`✘ Building hello with "${build}" exited 2: make: no rule for dist.\n`)
})

test('link installs the CMod plugin through Claude Code when claude plugin list lacks it', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { 'bin/claude': claudeAnswering([]), 'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }) })

  const linked = await cmod(home, 'link', join(home, 'Developer/demo'))

  expect(linked.exitCode).toBe(0)
  expect(linked.stdout).toContain('✔ Installed cmod@cmod')
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toBe('plugin list --json\nplugin marketplace list --json\nplugin marketplace add heyJordanParker/cmod\nplugin install cmod@cmod --json\n')
})

test('link installs a listed CMod plugin again, so one Claude Code pulled in as a dependency stays installed on its own', async () => {
  const home = await temporaryHome()
  const dependency = [{ id: 'cmod@hello-market', version: '0.1.0', scope: 'user', enabled: true, installPath: '/cmod' }]
  await writeFiles(home, { 'bin/claude': claudeAnswering(dependency), 'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }) })

  const linked = await cmod(home, 'link', join(home, 'Developer/demo'))

  expect(linked.exitCode).toBe(0)
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toBe('plugin list --json\nplugin install cmod@hello-market --json\n')
})

test('link installs no CMod plugin when a linked CMod checkout provides it', async () => {
  const home = await temporaryHome()
  const checkout = [{ id: 'cmod@inline', version: '0.1.0', scope: 'session', enabled: true, installPath: join(home, 'Developer/cmod') }]
  await writeFiles(home, {
    'bin/claude': claudeAnswering(checkout),
    'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
  })

  const linked = await cmod(home, 'link', join(home, 'Developer/demo'))

  expect(linked.exitCode).toBe(0)
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toBe('plugin list --json\n')
})

const claudeBeforeCmodIsLinked = `#!/bin/sh
echo "$*" >> "$HOME/claude-calls"
case "$*" in
  "plugin list --json")
    if grep -q '~/Developer/cmod' "$HOME/.claude/settings.json" 2>/dev/null
    then echo '[{"id":"cmod@inline","version":"0.1.0","scope":"session","enabled":true,"installPath":"'"$HOME"'/Developer/cmod"}]'
    else echo '[]'
    fi ;;
  "plugin marketplace list --json") echo '[]' ;;
  *) echo 'Repository not found' >&2; exit 1 ;;
esac
`

test('cmod link of a mod before CMod is linked writes nothing to settings', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { 'bin/claude': claudeBeforeCmodIsLinked, 'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }) })

  const linked = await cmod(home, 'link', join(home, 'Developer/demo'))

  expect(linked.exitCode).toBe(1)
  expect(linked.stderr).toContain('plugin marketplace add heyJordanParker/cmod')
  expect(linked.stderr).toEndWith('Link the CMod checkout first: cmod link <checkout>\n')
  expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false)
})

test('cmod link of the CMod checkout still links it', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { 'bin/claude': claudeBeforeCmodIsLinked, 'Developer/cmod/.claude-plugin/plugin.json': JSON.stringify({ name: 'cmod', version: '0.1.0' }) })

  const linked = await cmod(home, 'link', join(home, 'Developer/cmod'))

  expect(linked.exitCode).toBe(0)
  expect(JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'))).toEqual({ env: { CLAUDE_CODE_PLUGIN_DIRS: '~/Developer/cmod' } })
})

test('link installs a repacked file: tarball dependency, not the copy already in node_modules', async () => {
  const home = await temporaryHome()
  const checkout = join(home, 'Developer', 'demo')
  const tarball = join(home, 'tiny', 'tiny-1.0.0.tgz')
  const pack = async (text: string) => {
    await writeFiles(home, { 'tiny/package.json': JSON.stringify({ name: 'tiny', version: '1.0.0' }), 'tiny/index.js': text })
    expect(await Bun.spawn([process.execPath, 'pm', 'pack', '--quiet'], { cwd: join(home, 'tiny'), stdout: 'ignore' }).exited).toBe(0)
  }
  await writeFiles(checkout, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo', private: true, dependencies: { tiny: `file:${tarball}` } }),
  })

  await pack('export const pack = 1\n')
  expect((await cmod(home, 'link', checkout)).exitCode).toBe(0)
  await pack('export const pack = 2\n')
  expect((await cmod(home, 'link', checkout)).exitCode).toBe(0)

  expect(await readFile(join(checkout, 'node_modules/tiny/index.js'), 'utf8')).toBe('export const pack = 2\n')
})
