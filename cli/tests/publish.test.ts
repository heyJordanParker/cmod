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
  expect(result.stderr).toBe(`cmod publish: The build of hello wrote hello, which no platform downloads. Name each build <program>-<os>-<arch>: ${platforms.map((platform) => `hello-${platform}`).join(', ')}.\n`)
})
