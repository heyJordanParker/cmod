import { afterAll, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { version as coreVersion } from '@cmodjs/core/package.json'
import { claudeAnswering, cmod, cmodPluginListed, deleteTemporaryHomes, temporaryHome, writeFiles, writeLinked } from './cmod.js'

afterAll(deleteTemporaryHomes)

const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']

const releasedChangelog = '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-10-13\n\n### Changed\n- The greeter greets by name.\n\n## [0.1.0] - 2026-09-30\n\n- First release.\n'

async function committedMod(home: string, build: string, manifest: Record<string, unknown> = { name: 'hello' }): Promise<string> {
  const root = join(home, 'cmod')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'cmod', version: '0.2.0' }),
    'package.json': JSON.stringify({ name: 'cmod', cmod: { program: 'hello' } }),
    'cli/package.json': JSON.stringify({ ...manifest, cmod: { build, output: 'dist' } }),
    'cli/src/main.ts': 'console.log("hello")\n',
    'CHANGELOG.md': releasedChangelog,
  })
  const git = (...args: string[]) => Bun.spawn(['git', '-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { stdout: 'ignore', stderr: 'ignore' }).exited
  await git('init', '-q')
  await git('add', '.')
  await git('commit', '-q', '-m', 'mod')
  await git('remote', 'add', 'origin', 'https://github.com/owner/cmod.git')
  return root
}

test('publish refuses a mod whose cli/ declares a program the root package.json does not name', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.2.0' }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { install: './setup/install.sh' } }),
    'cli/package.json': JSON.stringify({ name: 'hello', cmod: { build: 'true', output: 'dist' } }),
  })

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe(
    'cmod publish: ~/hello-mod/cli declares the program hello, but ~/hello-mod/package.json does not name it, so installing the mod would not fetch hello. Write "program": "hello" in the "cmod" key of ~/hello-mod/package.json.\n',
  )
})

test('cmod publish refuses a file: dependency', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.2.0' }),
    'package.json': JSON.stringify({ name: 'hello-mod', dependencies: { '@cmodjs/core': 'file:../cmod/core/cmodjs-core-0.1.1.tgz', shared: 'link:shared' } }),
  })

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.stderr).toBe(
    `cmod publish: ~/hello-mod/package.json depends on @cmodjs/core at file:../cmod/core/cmodjs-core-0.1.1.tgz, shared at link:shared, which exist only on this machine, so the published mod would not install. Depend on versions published on npm, such as "@cmodjs/core": "^${coreVersion}", then run cmod publish again.\n`,
  )
  expect(result.exitCode).toBe(1)
})

test('publish --dry-run builds an archive without cli/ and a SHA256SUMS that lists every release file', async () => {
  const home = await temporaryHome()
  const root = await committedMod(home, `mkdir -p dist && for platform in ${platforms.join(' ')}; do echo "hello $platform" > dist/hello-$platform; done`)

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(0)
  const assets = result.stdout.split('\n').filter((line) => line.startsWith('  /')).map((line) => line.trim())
  expect(assets.map((asset) => basename(asset))).toEqual(['cmod-0.2.0.zip', ...platforms.map((platform) => `hello-${platform}`), 'SHA256SUMS'])
  const archive = assets[0] as string
  const entries = await new Response(Bun.spawn(['unzip', '-Z1', archive], { stdout: 'pipe' }).stdout).text()
  expect(entries.split('\n').filter((entry) => entry !== '').sort()).toEqual(['.claude-plugin/', '.claude-plugin/plugin.json', 'CHANGELOG.md', 'package.json'])
  const sums = await readFile(join(dirname(archive), 'SHA256SUMS'), 'utf8')
  const expected = []
  for (const asset of assets.slice(0, -1)) expected.push(`${new Bun.CryptoHasher('sha256').update(await Bun.file(asset).arrayBuffer()).digest('hex')}  ${basename(asset)}`)
  expect(sums).toBe(`${expected.join('\n')}\n`)
  expect(JSON.parse(await readFile(join(dirname(archive), 'marketplace.json'), 'utf8')).plugins[0].source.sha256).toBe(expected[0]?.split('  ')[0])
  expect(await Bun.file(join(root, '.claude-plugin/marketplace.json')).exists()).toBe(false)
})

test('publish uploads the release files before it pushes the marketplace, so no update reaches a release without them', async () => {
  const home = await temporaryHome()
  const root = await committedMod(home, `mkdir -p dist && for platform in ${platforms.join(' ')}; do echo "hello $platform" > dist/hello-$platform; done`)
  const remote = join(home, 'remote.git')
  await Bun.spawn(['git', 'init', '-q', '--bare', remote]).exited
  await Bun.spawn(['git', '-C', root, 'config', `url.${remote}.pushInsteadOf`, 'https://github.com/owner/cmod.git']).exited
  for (const [key, value] of [['protocol.https.allow', 'never'], ['user.name', 'Test'], ['user.email', 'test@example.com']]) await Bun.spawn(['git', '-C', root, 'config', key as string, value as string]).exited
  await answerAsGitHub(home, remote, 'main')

  const result = await cmod(home, 'publish', root)

  expect(result.stderr).toBe('')
  expect(result.exitCode).toBe(0)
  expect(await Bun.file(join(home, 'gh-edits')).exists()).toBe(false)
  const atRelease = (await readFile(join(home, 'refs-at-release'), 'utf8')).trim().split('\n')
  const after = (await new Response(Bun.spawn(['git', '--git-dir', remote, 'for-each-ref', '--format=%(refname)'], { stdout: 'pipe' }).stdout).text()).trim().split('\n')
  const branch = (await new Response(Bun.spawn(['git', '-C', root, 'branch', '--show-current'], { stdout: 'pipe' }).stdout).text()).trim()
  const commitOf = async (ref: string) => (await new Response(Bun.spawn(['git', '--git-dir', remote, 'rev-parse', `${ref}^{commit}`], { stdout: 'pipe' }).stdout).text()).trim()
  expect(atRelease).toContain('refs/tags/v0.2.0')
  expect(atRelease).toContain('refs/tags/cmod--v0.2.0')
  expect(await commitOf('refs/tags/cmod--v0.2.0')).toBe(await commitOf('refs/heads/release'))
  expect(atRelease).not.toContain(`refs/heads/${branch}`)
  expect(after).toContain(`refs/heads/${branch}`)
})

test("a first publish into an empty repository, where GitHub made the release branch the default, makes the mod's branch the default, where Claude Code reads marketplace.json", async () => {
  const home = await temporaryHome()
  const root = await committedMod(home, `mkdir -p dist && for platform in ${platforms.join(' ')}; do echo "hello $platform" > dist/hello-$platform; done`)
  const remote = join(home, 'remote.git')
  await Bun.spawn(['git', 'init', '-q', '--bare', remote]).exited
  await Bun.spawn(['git', '-C', root, 'config', `url.${remote}.pushInsteadOf`, 'https://github.com/owner/cmod.git']).exited
  for (const [key, value] of [['protocol.https.allow', 'never'], ['user.name', 'Test'], ['user.email', 'test@example.com']]) await Bun.spawn(['git', '-C', root, 'config', key as string, value as string]).exited
  await answerAsGitHub(home, remote, 'release')

  const result = await cmod(home, 'publish', root)

  expect(result.stderr).toBe('')
  expect(result.exitCode).toBe(0)
  const branch = (await new Response(Bun.spawn(['git', '-C', root, 'branch', '--show-current'], { stdout: 'pipe' }).stdout).text()).trim()
  expect(await readFile(join(home, 'gh-edits'), 'utf8')).toBe(`repo edit owner/cmod --default-branch ${branch}\n`)
})

async function answerAsGitHub(home: string, remote: string, defaultBranch: string): Promise<void> {
  await writeFiles(home, {
    'bin/gh': `#!/bin/sh
case "$1 $2" in
  "release create") git --git-dir="${remote}" for-each-ref --format='%(refname)' > "${home}/refs-at-release" ;;
  "repo view") echo ${defaultBranch} ;;
  "repo edit") echo "$*" >> "${home}/gh-edits" ;;
esac
`,
  })
}

test("publish writes the version's CHANGELOG.md section as the release notes, and ships the changelog in the release", async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home)

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('Its release notes would read:\n\n### Changed\n- The greeter greets by name.\n')
  const [archive = ''] = result.stdout.split('\n').filter((line) => line.startsWith('  /')).map((line) => line.trim())
  expect(await zipText(archive, 'CHANGELOG.md')).toBe(releasedChangelog)
})

test('publish refuses a version the committed CHANGELOG.md has no section for, and names the fix', async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home, { 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n- The greeter greets by name.\n' })

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe('cmod publish: The committed CHANGELOG.md has no "## [0.2.0]" section with notes. Write what changed for the people who use cmod under it, commit it, then run cmod publish again.\n')
})

test("a mod's marketplace lists the cmod plugin from cmod's release branch, so its cmod dependency follows each cmod release", async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'greeter', version: '0.2.0' }), 'package.json': JSON.stringify({ name: 'greeter' }) })

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(0)
  const [archive = ''] = result.stdout.split('\n').filter((line) => line.startsWith('  /')).map((line) => line.trim())
  const listed = JSON.parse(await readFile(join(dirname(archive), 'marketplace.json'), 'utf8')).plugins
  expect(listed[1]).toEqual({ name: 'cmod', description: 'Claude Mod Manager: runs the uninstall step of each mod Claude Code removes', source: { source: 'url', url: 'https://github.com/heyJordanParker/cmod.git', ref: 'release' } })
})

const dependsOnOneclaude = { '.claude-plugin/plugin.json': JSON.stringify({ name: 'greeter', version: '0.2.0', dependencies: [{ name: 'oneclaude', version: '>=0.9.0' }] }), 'package.json': JSON.stringify({ name: 'greeter' }) }

const oneclaudeEntry = { name: 'oneclaude', description: 'One Claude across every session', source: { source: 'url', url: 'https://github.com/heyJordanParker/oneclaude.git', ref: 'release' } }

const oneclaudeManifest = JSON.stringify({ name: 'oneclaude', version: '0.9.0', description: 'One Claude across every session', repository: 'https://github.com/heyJordanParker/oneclaude' })

async function installOneclaude(home: string, id: string, installPath: string): Promise<void> {
  await writeFiles(home, { 'bin/claude': claudeAnswering([...cmodPluginListed, { id, version: '0.9.0', scope: 'user', enabled: true, installPath }]) })
}

async function publishedListing(result: { stdout: string }): Promise<unknown[]> {
  const [archive = ''] = result.stdout.split('\n').filter((line) => line.startsWith('  /')).map((line) => line.trim())
  return JSON.parse(await readFile(join(dirname(archive), 'marketplace.json'), 'utf8')).plugins
}

test("a mod's marketplace lists each mod it depends on from the release branch of the GitHub repository its installed copy names, so the dependency resolves in the mod's marketplace", async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home, dependsOnOneclaude)
  await writeFiles(home, { 'cache/oneclaude/.claude-plugin/plugin.json': oneclaudeManifest })
  await installOneclaude(home, 'oneclaude@oneclaude', join(home, 'cache/oneclaude'))

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.stderr).toBe('')
  expect(result.exitCode).toBe(0)
  const listed = await publishedListing(result)
  expect(listed.map((plugin) => (plugin as { name: string }).name)).toEqual(['greeter', 'cmod', 'oneclaude'])
  expect(listed[2]).toEqual(oneclaudeEntry)
  expect(result.stdout).toContain('Listed oneclaude from the release branch of heyJordanParker/oneclaude, so the oneclaude dependency resolves in this marketplace and follows each oneclaude release\n')
})

test('a dependency installed only as a linked checkout lists from the repository its checkout names', async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home, dependsOnOneclaude)
  const checkout = join(home, 'Developer/oneclaude')
  await writeFiles(checkout, { '.claude-plugin/plugin.json': oneclaudeManifest })
  await writeLinked(home, checkout)
  await installOneclaude(home, 'oneclaude@Developer-linked', join(home, '.claude/plugins/cache/Developer-linked/oneclaude/0.9.0'))

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.stderr).toBe('')
  expect(result.exitCode).toBe(0)
  expect((await publishedListing(result))[2]).toEqual(oneclaudeEntry)
})

test('publish refuses a dependency installed nowhere here before it builds anything, and says to install or link it with its repository', async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home, dependsOnOneclaude)

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe(
    'cmod publish: .claude-plugin/plugin.json depends on oneclaude, and no copy installed here names its GitHub repository in .claude-plugin/plugin.json "repository", so greeter\'s marketplace cannot list it and Claude Code would leave greeter off. Install or link oneclaude, with "repository": "https://github.com/<owner>/<repo>" in its plugin.json, then run cmod publish again.\n',
  )
  expect(result.stdout).toBe('')
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toBe('plugin list --json\n')
})

test('publish refuses a cmod dependency other than >= the oldest cmod the bundled @cmodjs/core runs on, and names cmod check', async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'greeter', version: '0.2.0', dependencies: [{ name: 'cmod', version: '>=5.1.0' }] }),
    'package.json': JSON.stringify({ name: 'greeter' }),
    'node_modules/@cmodjs/core/package.json': JSON.stringify({ name: '@cmodjs/core', version: '5.1.0' }),
    'node_modules/@cmodjs/core/records.js': "export const oldestCmodVersion = '5.0.0'\n",
  })

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe(
    'cmod publish: .claude-plugin/plugin.json depends on cmod ">=5.1.0", and this mod bundles @cmodjs/core 5.1.0, which runs on cmod 5.0.0 or later, so it needs ">=5.0.0", which every newer cmod satisfies. Run cmod check, which writes it, commit .claude-plugin/plugin.json, then run cmod publish again.\n',
  )
})

test('publish of the cmod plugin, which installs @cmodjs/core and depends on no cmod, releases it', async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home, { '.gitignore': 'node_modules\n', 'node_modules/@cmodjs/core/package.json': JSON.stringify({ name: '@cmodjs/core', version: '4.0.0' }) })

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.stderr).toBe('')
  expect(result.exitCode).toBe(0)
})

async function committedHooksMod(home: string, files: Record<string, string> = {}): Promise<string> {
  const root = join(home, 'greeter')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'cmod', version: '0.2.0' }),
    'package.json': JSON.stringify({ name: 'cmod' }),
    'hooks/hooks.json': JSON.stringify({ description: 'greeter hooks module', modules: ['./register.ts'] }),
    'hooks/register.ts': "import { greet } from '../src/greet.js'\n\nexport function register(on) {\n  on('session.start', greet)\n}\n",
    'src/greet.ts': "export async function greet($, e, next) {\n  await $.ui.toast('hello')\n  return next(e)\n}\n",
    '.github/workflows/release.yml': 'name: Release\n',
    '.claude/skills/repack/SKILL.md': '# Repack\n',
    'CHANGELOG.md': releasedChangelog,
    ...files,
  })
  const git = (...args: string[]) => Bun.spawn(['git', '-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { stdout: 'ignore', stderr: 'ignore' }).exited
  await git('init', '-q')
  await git('add', '.')
  await git('commit', '-q', '-m', 'mod')
  await git('remote', 'add', 'origin', 'https://github.com/owner/greeter.git')
  return root
}

async function zipText(archive: string, entry: string): Promise<string> {
  return new Response(Bun.spawn(['unzip', '-p', archive, entry], { stdout: 'pipe' }).stdout).text()
}

test('publish --dry-run bundles the hooks module into one file, and leaves out .github/ and .claude/', async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home)

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.stderr).toBe('')
  expect(result.exitCode).toBe(0)
  const [archive = ''] = result.stdout.split('\n').filter((line) => line.startsWith('  /')).map((line) => line.trim())
  const entries = (await new Response(Bun.spawn(['unzip', '-Z1', archive], { stdout: 'pipe' }).stdout).text()).split('\n').filter((entry) => entry !== '' && !entry.endsWith('/'))
  expect(entries.sort()).toEqual(['.claude-plugin/plugin.json', 'CHANGELOG.md', 'hooks/hooks.json', 'hooks/register.js', 'hooks/register.ts', 'package.json', 'src/greet.ts'])
  expect(JSON.parse(await zipText(archive, 'hooks/hooks.json'))).toEqual({ description: 'greeter hooks module', modules: ['./register.js'] })
  const bundle = await zipText(archive, 'hooks/register.js')
  expect(bundle).toContain('function greet($, e, next)')
  expect(bundle).toContain('function register(on)')
  expect(bundle).not.toContain('import ')
  const tree = join(dirname(archive), 'release')
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toBe(`plugin validate ${tree}/.claude-plugin/plugin.json --strict\n`)
  expect(result.stdout).toContain(`and ${tree} to its release branch. Nothing was pushed:`)
})

test('publish writes a control character in the bundle as a \\u escape, so a reader sees it', async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home, { 'src/greet.ts': "export async function greet($, e, next) {\n  await $.ui.toast('delete\u007f')\n  return next(e)\n}\n" })

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(0)
  const [archive = ''] = result.stdout.split('\n').filter((line) => line.startsWith('  /')).map((line) => line.trim())
  const bundle = await zipText(archive, 'hooks/register.js')
  expect(bundle).toContain('"delete\\u007f"')
  expect(bundle).not.toContain('\u007f')
})

test('a "files" list in package.json limits the release to its paths, .claude-plugin/, package.json, tsconfig.json, the README, the license, and the changelog', async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home, {
    'package.json': JSON.stringify({ name: 'cmod', files: ['hooks', 'src'] }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react', jsxFactory: 'h' } }),
    'README.md': '# Greeter\n',
    LICENSE: 'MIT\n',
    'docs/notes.md': '# Notes\n',
    'tests/greet.test.ts': "test('greets', () => {})\n",
  })

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.stderr).toBe('')
  expect(result.exitCode).toBe(0)
  const [archive = ''] = result.stdout.split('\n').filter((line) => line.startsWith('  /')).map((line) => line.trim())
  const entries = (await new Response(Bun.spawn(['unzip', '-Z1', archive], { stdout: 'pipe' }).stdout).text()).split('\n').filter((entry) => entry !== '' && !entry.endsWith('/'))
  expect(entries.sort()).toEqual(['.claude-plugin/plugin.json', 'CHANGELOG.md', 'LICENSE', 'README.md', 'hooks/hooks.json', 'hooks/register.js', 'hooks/register.ts', 'package.json', 'src/greet.ts', 'tsconfig.json'])
})

test('a "files" list that leaves out the install step still releases its folder, so the mod installs', async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home, {
    'package.json': JSON.stringify({ name: 'cmod', files: ['hooks', 'src'], cmod: { install: './setup/install.sh' } }),
    'setup/install.sh': '#!/bin/sh\necho installed\n',
  })

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.stderr).toBe('')
  expect(result.exitCode).toBe(0)
  const [archive = ''] = result.stdout.split('\n').filter((line) => line.startsWith('  /')).map((line) => line.trim())
  const entries = (await new Response(Bun.spawn(['unzip', '-Z1', archive], { stdout: 'pipe' }).stdout).text()).split('\n').filter((entry) => entry !== '' && !entry.endsWith('/'))
  expect(entries).toContain('setup/install.sh')
})

test('publish refuses a plugin.json whose userConfig differs from the options defineMod declares', async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home, {
    'node_modules/@cmodjs/core/register.js': 'let registered\nexport const registerMod = (_addHook, definition) => { registered = definition }\nexport const registeredMod = () => registered\n',
    'node_modules/@cmodjs/core/options.js': 'export const userConfigOf = (options) => Object.fromEntries(Object.keys(options).map((key) => [key, { type: "string", title: key, description: "" }]))\n',
    'hooks/register.ts': "import { registerMod } from '../node_modules/@cmodjs/core/register.js'\nexport function register(addHook, options) {\n  registerMod(addHook, { name: 'cmod', options: { branch: {} }, setup() {} }, options)\n}\n",
  })

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe(
    'cmod publish: .claude-plugin/plugin.json userConfig differs from the options defineMod declares, so Claude Code would ask for and store the wrong options. Run cmod check, which writes them, commit .claude-plugin/plugin.json, then run cmod publish again.\n',
  )
})

test('publish refuses a "files" path that matches no file in the mod', async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home, { 'package.json': JSON.stringify({ name: 'cmod', files: ['hooks', 'skills'] }) })

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe('cmod publish: package.json "files" lists skills, which matches no file in the mod. Add the file or remove it from "files", then run the command again.\n')
})

test('publish prints every line claude plugin validate writes when it refuses the release', async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home)
  const lines = ['Validating plugin manifest', '✘ Found 6 errors:', '  ❯ types: Path not found: ./types/index.d.ts', '  ❯ icon: Path not found: ./icon.png', '  ❯ commands: Path not found: ./commands', '  ❯ agents: Path not found: ./agents', '  ❯ skills: Path not found: ./skills', '  ❯ hooks: Path not found: ./hooks.json', '✘ Validation failed']
  await writeFiles(home, { 'bin/claude': `#!/bin/sh\nprintf '%s\\n' ${lines.slice(0, 2).map((line) => `'${line}'`).join(' ')}\nprintf '%s\\n' ${lines.slice(2).map((line) => `'${line}'`).join(' ')} >&2\nexit 1\n` })

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain(`--strict exited 1:\n${lines.join('\n')}\n`)
})

test('publish stops when claude plugin validate refuses the release', async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home)
  await writeFiles(home, { 'bin/claude': "#!/bin/sh\necho '✘ register is exported as \"register\", which is not a function declared at the top of this file' >&2\nexit 1\n" })

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('--strict exited 1:\n✘ register is exported as "register", which is not a function declared at the top of this file')
})

test('publish names the program of a scoped npm package by its one bin command', async () => {
  const home = await temporaryHome()
  const build = `mkdir -p dist && for platform in ${platforms.join(' ')}; do echo "hello $platform" > dist/hello-$platform; done`
  const root = await committedMod(home, build, { name: '@owner/hello-cli', bin: { hello: 'bin/hello' } })

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.stderr).toBe('')
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain(`/hello-${platforms[0]}\n`)
})

test('publish refuses a build that is not named <program>-<os>-<arch>', async () => {
  const home = await temporaryHome()
  const root = await committedMod(home, 'mkdir -p dist && echo hello > dist/hello')

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe(`cmod publish: The build of hello wrote hello, which no machine downloads. Name each build <program>-<os>-<arch>: ${platforms.map((platform) => `hello-${platform}`).join(', ')}.\n`)
})

test('publish asks the build for every machine in CMOD_MACHINES, and refuses a release missing one, even when an earlier run left it in the output folder', async () => {
  const home = await temporaryHome()
  const root = await committedMod(home, 'mkdir -p dist && echo "$CMOD_MACHINES" > "$HOME/machines" && for machine in darwin-arm64 darwin-x64 linux-x64; do echo hello > dist/hello-$machine; done')
  await writeFiles(root, { 'cli/dist/hello-linux-arm64': 'built by an earlier run\n' })
  await Bun.spawn(['touch', '-t', '202001010000', join(root, 'cli/dist/hello-linux-arm64')]).exited

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(1)
  expect(await readFile(join(home, 'machines'), 'utf8')).toBe(`${platforms.join(' ')}\n`)
  expect(result.stderr).toBe('cmod publish: The build of hello wrote no hello-linux-arm64, but the mod runs on macOS and Linux. Build each machine CMOD_MACHINES names, or list only the machines it builds in the "os" and "cpu" keys of the mod\'s package.json, such as "os": ["darwin"].\n')
})

test('publish builds only the machines the "os" and "cpu" keys of package.json list', async () => {
  const home = await temporaryHome()
  const root = await committedMod(home, 'mkdir -p dist && echo "$CMOD_MACHINES" > "$HOME/machines" && for machine in $CMOD_MACHINES; do echo hello > dist/hello-$machine; done')
  await writeFiles(root, { 'package.json': JSON.stringify({ name: 'cmod', os: ['darwin'], cpu: ['arm64'], cmod: { program: 'hello' } }) })
  await Bun.spawn(['git', '-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qam', 'macOS on arm64']).exited

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(0)
  expect(await readFile(join(home, 'machines'), 'utf8')).toBe('darwin-arm64\n')
  expect(result.stdout).toContain('Built hello: hello-darwin-arm64\n')
})
