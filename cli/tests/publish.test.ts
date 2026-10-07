import { afterEach, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { version as coreVersion } from '@cmodjs/core/package.json'
import { cmod, deleteTemporaryHomes, temporaryHome, writeFiles } from './cmod.js'

afterEach(deleteTemporaryHomes)

const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']

async function committedMod(home: string, build: string, manifest: Record<string, unknown> = { name: 'hello' }): Promise<string> {
  const root = join(home, 'cmod')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'cmod', version: '0.2.0' }),
    'package.json': JSON.stringify({ name: 'cmod', cmod: { program: 'hello' } }),
    'cli/package.json': JSON.stringify({ ...manifest, cmod: { build, output: 'dist' } }),
    'cli/src/main.ts': 'console.log("hello")\n',
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
  expect(entries.split('\n').filter((entry) => entry !== '').sort()).toEqual(['.claude-plugin/', '.claude-plugin/plugin.json', 'package.json'])
  const sums = await readFile(join(dirname(archive), 'SHA256SUMS'), 'utf8')
  const expected = []
  for (const asset of assets.slice(0, -1)) expected.push(`${new Bun.CryptoHasher('sha256').update(await Bun.file(asset).arrayBuffer()).digest('hex')}  ${basename(asset)}`)
  expect(sums).toBe(`${expected.join('\n')}\n`)
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
  expect(entries.sort()).toEqual(['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.js', 'hooks/register.ts', 'package.json', 'src/greet.ts'])
  expect(JSON.parse(await zipText(archive, 'hooks/hooks.json'))).toEqual({ description: 'greeter hooks module', modules: ['./register.js'] })
  const bundle = await zipText(archive, 'hooks/register.js')
  expect(bundle).toContain('function greet($, e, next)')
  expect(bundle).toContain('function register(on)')
  expect(bundle).not.toContain('import ')
  const tree = join(dirname(archive), 'release')
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toBe(`plugin validate ${tree} --strict\n`)
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

test('a "files" list in package.json limits the release to its paths, .claude-plugin/, package.json, the README, and the license', async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home, {
    'package.json': JSON.stringify({ name: 'cmod', files: ['hooks', 'src'] }),
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
  expect(entries.sort()).toEqual(['.claude-plugin/plugin.json', 'LICENSE', 'README.md', 'hooks/hooks.json', 'hooks/register.js', 'hooks/register.ts', 'package.json', 'src/greet.ts'])
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

test('publish refuses a "files" path that matches no committed file', async () => {
  const home = await temporaryHome()
  const root = await committedHooksMod(home, { 'package.json': JSON.stringify({ name: 'cmod', files: ['hooks', 'skills'] }) })

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe('cmod publish: package.json "files" lists skills, which matches no committed file. Commit it or remove it from "files", then run cmod publish again.\n')
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

test('publish asks the build for every machine in CMOD_MACHINES, and releases no build an earlier run left in the output folder', async () => {
  const home = await temporaryHome()
  const root = await committedMod(home, 'mkdir -p dist && echo "$CMOD_MACHINES" > "$HOME/machines" && for machine in darwin-arm64 linux-x64; do echo hello > dist/hello-$machine; done')
  await writeFiles(root, { 'cli/dist/hello-linux-arm64': 'built by an earlier run\n' })
  await Bun.spawn(['touch', '-t', '202001010000', join(root, 'cli/dist/hello-linux-arm64')]).exited

  const result = await cmod(home, 'publish', root, '--dry-run')

  expect(result.exitCode).toBe(0)
  expect(await readFile(join(home, 'machines'), 'utf8')).toBe(`${platforms.join(' ')}\n`)
  expect(result.stdout).toContain('Built hello: hello-darwin-arm64, hello-linux-x64\n')
})
