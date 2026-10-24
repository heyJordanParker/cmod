import { afterAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, readlink, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeAnswering, cmod, cmodPluginListed, deleteTemporaryHomes, temporaryHome, writeFiles, writeLinked } from './cmod.js'

afterAll(deleteTemporaryHomes)

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

const published = { id: 'demo@market', version: '0.1.0', scope: 'user', enabled: true, installPath: '/demo' }

const claudeWithPublished = claudeAnswering([...cmodPluginListed, published]).replace(
  '  "plugin "*) exit 1 ;;',
  '  "plugin disable demo@market --json"|"plugin enable demo@market --json") echo \'{"outcome":"ok"}\' ;;\n  "plugin "*) exit 1 ;;',
)

const linkedMarketplace = (home: string) => join(home, 'Developer', '.claude-plugin', 'marketplace.json')

test("link lists the checkout in a marketplace in its parent folder beside the cmod plugin, excludes that file from the parent's git, installs it from there, and turns the published copy off, and unlink undoes each", async () => {
  const { home, checkout, target, link } = await linkedHome(settings)
  await writeFiles(home, { 'bin/claude': claudeWithPublished })
  expect(await Bun.spawn(['git', 'init', '--quiet', join(home, 'Developer')]).exited).toBe(0)
  const excludes = join(home, 'Developer', '.git', 'info', 'exclude')
  const excludedBefore = await readFile(excludes, 'utf8')

  const linked = await cmod(home, 'link', checkout)

  expect(linked.exitCode).toBe(0)
  expect(linked.stdout).toContain('✔ Linked ~/Developer/demo as demo@Developer-linked')
  expect(JSON.parse(await readFile(linkedMarketplace(home), 'utf8'))).toEqual({
    name: 'Developer-linked',
    owner: { name: 'cmod link' },
    plugins: [
      { name: 'demo', source: './demo', description: 'demo' },
      { name: 'cmod', description: 'Claude Mod Manager: runs the uninstall step of each mod Claude Code removes', source: { source: 'github', repo: 'heyJordanParker/cmod', ref: 'release' } },
    ],
  })
  expect(await readFile(excludes, 'utf8')).toBe(`${excludedBefore}/.claude-plugin/marketplace.json\n`)
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toContain(`plugin marketplace add ${join(home, 'Developer')}\nplugin install demo@Developer-linked --json\nplugin list --json\nplugin disable demo@market --json\n`)
  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/links.json'), 'utf8'))).toEqual({ marketplaces: { 'Developer-linked': join(home, 'Developer') }, turnedOff: { demo: ['demo@market'] } })
  expect(await readFile(target, 'utf8')).toBe(settings)
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  await writeFiles(home, { 'claude-calls': '' })

  const unlinked = await cmod(home, 'unlink', checkout)

  expect(unlinked.exitCode).toBe(0)
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toContain('plugin uninstall demo@Developer-linked --json\nplugin list --json\nplugin marketplace remove Developer-linked\nplugin list --json\nplugin enable demo@market --json\n')
  expect(existsSync(join(home, 'Developer', '.claude-plugin'))).toBe(false)
  expect(await readFile(excludes, 'utf8')).toBe(excludedBefore)
  expect(existsSync(join(home, '.local/share/cmod/links.json'))).toBe(false)
  expect(await readFile(target, 'utf8')).toBe(settings)
})

test('two checkouts in one folder share its marketplace, and unlinking one keeps the other listed', async () => {
  const home = await temporaryHome()
  await writeFiles(home, {
    'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'Developer/notes/.claude-plugin/plugin.json': JSON.stringify({ name: 'notes', version: '0.1.0', description: 'Keeps notes' }),
  })

  expect((await cmod(home, 'link', join(home, 'Developer/demo'))).exitCode).toBe(0)
  expect((await cmod(home, 'link', join(home, 'Developer/notes'))).exitCode).toBe(0)
  expect((await cmod(home, 'unlink', join(home, 'Developer/demo'))).exitCode).toBe(0)

  const listed = JSON.parse(await readFile(linkedMarketplace(home), 'utf8')) as { plugins: { name: string; source: unknown }[] }
  expect(listed.plugins.map((plugin) => [plugin.name, plugin.source])).toEqual([
    ['notes', './notes'],
    ['cmod', { source: 'github', repo: 'heyJordanParker/cmod', ref: 'release' }],
  ])
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toContain('plugin uninstall demo@Developer-linked --json\nplugin marketplace update Developer-linked\n')
  expect((await cmod(home, 'unlink', join(home, 'Developer/demo'))).stderr).toBe('cmod unlink: ~/Developer/demo is not linked. cmod link links it.\n')
})

test('cmod update and cmod list name a linked install by its checkout, not the copy Claude Code keeps, and update leaves it to the saved files', async () => {
  const home = await temporaryHome()
  const checkout = join(home, 'Developer/demo')
  const installed = { id: 'demo@Developer-linked', version: '0.1.0', scope: 'user', enabled: true, installPath: join(home, 'cache/demo') }
  await writeFiles(home, { 'bin/claude': claudeAnswering([...cmodPluginListed, installed]), 'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }) })
  await writeLinked(home, checkout)

  const updated = await cmod(home, 'update', 'demo')
  const listed = await cmod(home, 'list', '--json')

  expect(updated.exitCode).toBe(0)
  expect(updated.stdout).toBe(`– demo@Developer-linked is linked from ${checkout}, so saving its files updates it.\n`)
  expect(JSON.parse(listed.stdout)).toEqual([
    { name: 'cmod@cmod', version: '0.1.0', state: '/cmod is missing: run claude plugin update cmod@cmod', unsatisfied: [] },
    { name: 'demo@Developer-linked', version: '0.1.0', state: `linked from ${checkout}, enabled`, unsatisfied: [] },
  ])
})

test('cmod enable of a linked mod refuses, so it never turns on the published copy cmod link turned off', async () => {
  const home = await temporaryHome()
  const checkout = join(home, 'Developer/demo')
  const listed = [{ ...published, enabled: false }, { id: 'demo@Developer-linked', version: '0.1.0', scope: 'user', enabled: true, installPath: join(home, 'cache/demo') }]
  await writeFiles(home, { 'bin/claude': claudeAnswering(listed), 'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }) })
  await writeLinked(home, checkout)

  const enabled = await cmod(home, 'enable', 'demo')

  expect(enabled.exitCode).toBe(1)
  expect(enabled.stderr).toBe(`cmod enable: demo@Developer-linked is linked from ${checkout}, so Claude Code loads it in every session. cmod unlink stops loading it.\n`)
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toBe('plugin list --json\n')
})

test('link refuses a folder whose marketplace.json cmod did not write, and leaves that file as it was', async () => {
  const home = await temporaryHome()
  const release = JSON.stringify({ name: 'tools', owner: { name: 'someone' }, plugins: [] })
  await writeFiles(home, { 'Developer/.claude-plugin/marketplace.json': release, 'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }) })

  const linked = await cmod(home, 'link', join(home, 'Developer/demo'))

  expect(linked.exitCode).toBe(1)
  expect(linked.stderr).toBe('cmod link: ~/Developer/.claude-plugin/marketplace.json is a marketplace cmod did not write, so cmod cannot list demo beside it. Move ~/Developer/demo into a folder with no .claude-plugin/marketplace.json, then run cmod link again.\n')
  expect(await readFile(join(home, 'Developer/.claude-plugin/marketplace.json'), 'utf8')).toBe(release)
})

test('link keeps the checkout\'s own committed marketplace.json as it was', async () => {
  const home = await temporaryHome()
  const release = JSON.stringify({ name: 'demo', owner: { name: 'someone' }, plugins: [{ name: 'demo', source: { source: 'archive', url: 'https://example.com/demo.zip' } }] })
  await writeFiles(home, { 'Developer/demo/.claude-plugin/marketplace.json': release, 'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }) })

  expect((await cmod(home, 'link', join(home, 'Developer/demo'))).exitCode).toBe(0)
  expect(await readFile(join(home, 'Developer/demo/.claude-plugin/marketplace.json'), 'utf8')).toBe(release)
  expect(existsSync(linkedMarketplace(home))).toBe(true)
})

test('cmod setup links each folder an older cmod put in CLAUDE_CODE_PLUGIN_DIRS as a marketplace, takes it out of the list, and keeps a folder it cannot link with its error', async () => {
  const home = await temporaryHome()
  await writeFiles(home, {
    '.claude/settings.json': JSON.stringify({ env: { FOO: '1', CLAUDE_CODE_PLUGIN_DIRS: '~/Developer/demo:~/Developer/missing', CLAUDE_CODE_PLUGIN_DIR_WATCH: 'false' } }),
    'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
  })

  const setUp = await cmod(home, 'setup', join(home, 'Developer/demo'), '--yes')

  expect(setUp.exitCode).toBe(0)
  expect(JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'))).toEqual({ env: { FOO: '1', CLAUDE_CODE_PLUGIN_DIRS: '~/Developer/missing', CLAUDE_CODE_PLUGIN_DIR_WATCH: 'false' } })
  expect(setUp.stderr).toBe(`cmod kept ~/Developer/missing in CLAUDE_CODE_PLUGIN_DIRS, because linking it as a marketplace failed: ${join(home, 'Developer/missing')} does not exist.\n`)
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toContain(`plugin marketplace add ${join(home, 'Developer')}\nplugin install demo@Developer-linked --json\n`)
  expect(JSON.parse(await readFile(linkedMarketplace(home), 'utf8')).plugins[0]).toEqual({ name: 'demo', source: './demo', description: 'demo' })
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

test('link asks the build for this machine alone in CMOD_MACHINES', async () => {
  const home = await temporaryHome()
  const checkout = join(home, 'Developer', 'hello-mod')
  const build = 'mkdir -p dist && echo "$CMOD_MACHINES" > "$HOME/machines" && for machine in $CMOD_MACHINES; do printf "#!/bin/sh\\necho hello\\n" > dist/hello-$machine; done'
  await writeFiles(checkout, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.3.0' }),
    'cli/package.json': JSON.stringify({ name: 'hello', cmod: { build, output: 'dist' } }),
  })

  expect((await cmod(home, 'link', checkout)).exitCode).toBe(0)
  expect(await readFile(join(home, 'machines'), 'utf8')).toBe(`${process.platform}-${process.arch}\n`)
  expect(await readdir(join(checkout, 'cli/dist'))).toEqual([`hello-${process.platform}-${process.arch}`])
})

test("two builds of one checkout take turns, so one never clears the other's output", async () => {
  const home = await temporaryHome()
  const checkout = join(home, 'Developer', 'hello-mod')
  const build = 'echo start >> "$HOME/builds" && rm -rf dist && mkdir dist && sleep 1 && for machine in $CMOD_MACHINES; do printf "#!/bin/sh\\necho hello\\n" > dist/hello-$machine; done && echo end >> "$HOME/builds"'
  await writeFiles(checkout, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.3.0' }),
    'cli/package.json': JSON.stringify({ name: 'hello', cmod: { build, output: 'dist' } }),
  })

  const linked = await Promise.all([cmod(home, 'link', checkout), cmod(home, 'link', checkout)])

  expect(linked.map((each) => each.exitCode)).toEqual([0, 0])
  expect(await readFile(join(home, 'builds'), 'utf8')).toBe('start\nend\nstart\nend\n')
})

test('link names a Rust program by its one [[bin]], not by its package', async () => {
  const home = await temporaryHome()
  const checkout = join(home, 'Developer', 'greet-mod')
  const build = `mkdir -p dist && printf '#!/bin/sh\\necho greeted by cargo\\n' > dist/greet-binary-${process.platform}-${process.arch}`
  await writeFiles(checkout, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'greet-mod', version: '0.3.0' }),
    'cli/Cargo.toml': `[package]\nname = "greet-crate"\nversion = "0.3.0"\n\n[package.metadata.cmod]\nbuild = "${build.replaceAll('\\', '\\\\')}"\noutput = "dist"\n\n[[bin]]\nname = "greet-binary"\npath = "src/main.rs"\n`,
  })

  expect((await cmod(home, 'link', checkout)).exitCode).toBe(0)
  expect(await new Response(Bun.spawn([join(home, '.local/bin/greet-binary')], { stdout: 'pipe' }).stdout).text()).toBe('greeted by cargo\n')
  expect(existsSync(join(home, '.local/bin/greet-crate'))).toBe(false)
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
  expect(result.stdout).toContain('✘ Could not build hello\n')
  expect(result.stderr).toBe(`cmod link: Building hello with "${build}" exited 2: make: no rule for dist. Fix the build in ~/Developer/hello-mod/cli, then save a file there or run the command again.\n`)
})

test('link installs the cmod plugin through Claude Code when claude plugin list lacks it', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { 'bin/claude': claudeAnswering([]), 'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }) })

  const linked = await cmod(home, 'link', join(home, 'Developer/demo'))

  expect(linked.exitCode).toBe(0)
  expect(linked.stdout).toContain('✔ Installed cmod@cmod')
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toStartWith('plugin list --json\nplugin marketplace list --json\nplugin marketplace add heyJordanParker/cmod\nplugin install cmod@cmod --json\nplugin marketplace list --json\n')
})

test('link installs a listed cmod plugin again, so one Claude Code pulled in as a dependency stays installed on its own', async () => {
  const home = await temporaryHome()
  const dependency = [{ id: 'cmod@hello-market', version: '0.1.0', scope: 'user', enabled: true, installPath: '/cmod' }]
  await writeFiles(home, { 'bin/claude': claudeAnswering(dependency), 'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }) })

  const linked = await cmod(home, 'link', join(home, 'Developer/demo'))

  expect(linked.exitCode).toBe(0)
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toStartWith('plugin list --json\nplugin install cmod@hello-market --json\nplugin marketplace list --json\n')
})

test('link installs no cmod plugin when a linked cmod checkout provides it', async () => {
  const home = await temporaryHome()
  const checkout = [{ id: 'cmod@inline', version: '0.1.0', scope: 'session', enabled: true, installPath: join(home, 'Developer/cmod') }]
  await writeFiles(home, {
    'bin/claude': claudeAnswering(checkout),
    'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
  })

  const linked = await cmod(home, 'link', join(home, 'Developer/demo'))

  expect(linked.exitCode).toBe(0)
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toStartWith('plugin list --json\nplugin marketplace list --json\n')
})

const claudeConfiguring = claudeAnswering(cmodPluginListed).replace('  "plugin "*) exit 1 ;;', '  "plugin configure demo@Developer-linked --values-stdin --json") cat > "$HOME/configured" ;;\n  "plugin "*) exit 1 ;;')

test('link --option sets each option through claude plugin configure', async () => {
  const home = await temporaryHome()
  const userConfig = { branch: { type: 'string', title: 'Branch', description: '' }, interval: { type: 'number', title: 'Interval', description: '' } }
  await writeFiles(home, { 'bin/claude': claudeConfiguring, 'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0', userConfig }) })

  const linked = await cmod(home, 'link', join(home, 'Developer/demo'), '--option', 'branch=main', '--option', 'interval=30')

  expect(linked.exitCode).toBe(0)
  expect(linked.stdout).toContain('✔ Set branch, interval for demo@Developer-linked')
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toContain('plugin configure demo@Developer-linked --values-stdin --json\n')
  expect(JSON.parse(await readFile(join(home, 'configured'), 'utf8'))).toEqual({ branch: 'main', interval: '30' })
})

test('link --option names the options a mod has when the key is not one of them', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { 'bin/claude': claudeConfiguring, 'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0', userConfig: { branch: { type: 'string', title: 'Branch', description: '' } } }) })

  const linked = await cmod(home, 'link', join(home, 'Developer/demo'), '--option', 'brnach=main')

  expect(linked.exitCode).toBe(1)
  expect(`${linked.stdout}${linked.stderr}`).toContain('demo@Developer-linked has no option brnach. Its options are: branch.')
  expect(existsSync(join(home, 'configured'))).toBe(false)
})

const claudeBeforeCmodIsLinked = claudeAnswering([]).replace('  "plugin marketplace add heyJordanParker/cmod") ;;', "  \"plugin marketplace add heyJordanParker/cmod\") echo 'Repository not found' >&2; exit 1 ;;")

test('cmod link of a mod before cmod is linked lists nothing', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { 'bin/claude': claudeBeforeCmodIsLinked, 'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }) })

  const linked = await cmod(home, 'link', join(home, 'Developer/demo'))

  expect(linked.exitCode).toBe(1)
  expect(linked.stderr).toContain('plugin marketplace add heyJordanParker/cmod')
  expect(linked.stderr).toEndWith('Link the cmod checkout first: cmod link <checkout>\n')
  expect(existsSync(linkedMarketplace(home))).toBe(false)
  expect(existsSync(join(home, '.local/share/cmod/links.json'))).toBe(false)
})

test('cmod link of the cmod checkout lists it in place of the cmod plugin from GitHub, and a mod linked after it installs no other cmod', async () => {
  const home = await temporaryHome()
  await writeFiles(home, {
    'bin/claude': claudeBeforeCmodIsLinked.replace(/  "plugin list --json"\) echo '.*' ;;/, `  "plugin list --json") grep -q Developer-linked "$HOME/.claude/plugins/known_marketplaces.json" 2>/dev/null && echo '[{"id":"cmod@Developer-linked","version":"0.1.0","scope":"user","enabled":true,"installPath":"/cache"}]' || echo '[]' ;;`),
    'Developer/cmod/.claude-plugin/plugin.json': JSON.stringify({ name: 'cmod', version: '0.1.0' }),
    'Developer/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
  })

  expect((await cmod(home, 'link', join(home, 'Developer/cmod'))).exitCode).toBe(0)
  expect(JSON.parse(await readFile(linkedMarketplace(home), 'utf8')).plugins).toEqual([{ name: 'cmod', source: './cmod', description: 'cmod' }])
  expect((await cmod(home, 'link', join(home, 'Developer/demo'))).exitCode).toBe(0)
  expect(JSON.parse(await readFile(linkedMarketplace(home), 'utf8')).plugins.map((plugin: { source: unknown }) => plugin.source)).toEqual(['./cmod', './demo'])
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).not.toContain('heyJordanParker/cmod')
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
