import { afterEach, expect, test } from 'bun:test'
import { existsSync, readlinkSync } from 'node:fs'
import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { deleteTemporaryHomes, temporaryHome, writeFiles } from './cmod.js'

afterEach(deleteTemporaryHomes)

const checkout = join(import.meta.dir, '..', '..')
const build = `cmod-${process.platform}-${process.arch}`

function program(version: string): string {
  return `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; else echo "cmod ${version} ran $*"; fi\n`
}

function sha256(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex')
}

function serveRelease(version: string, { sums = sha256(program(version)) } = {}) {
  const requested: string[] = []
  const files: Record<string, string> = { [`/v${version}/${build}`]: program(version), [`/v${version}/SHA256SUMS`]: `${sums}  ${build}\n` }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      const path = new URL(request.url).pathname
      requested.push(path)
      const file = files[path]
      return file === undefined ? new Response('Not Found', { status: 404 }) : new Response(file)
    },
  })
  return { origin: server.url.origin, requested, [Symbol.dispose]: () => server.stop(true) }
}

async function installPackage(folder: string, version: string): Promise<string> {
  const launcher = join(folder, 'bin', 'cmod')
  await mkdir(dirname(launcher), { recursive: true })
  await copyFile(join(checkout, 'cli', 'bin', 'cmod'), launcher)
  await chmod(launcher, 0o755)
  await writeFiles(folder, { 'package.json': JSON.stringify({ name: '@cmodjs/cli', version }, null, 2) })
  return launcher
}

async function run(argv: string[], home: string, origin: string, path = '/usr/bin:/bin') {
  const child = Bun.spawn(argv, { env: { HOME: home, PATH: path, CMOD_DIST_SERVER: origin }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, exitCode }
}

const storeOf = (home: string) => join(home, '.local/share/cmod/bin/cmod')

test('the cmod plugin, @cmodjs/cli, and @cmodjs/core share one version, which the bootstrap installs', async () => {
  const versionOf = async (path: string) => JSON.parse(await Bun.file(join(checkout, path)).text()).version
  const plugin = await versionOf('.claude-plugin/plugin.json')

  expect({ cli: await versionOf('cli/package.json'), core: await versionOf('core/package.json') }).toEqual({ cli: plugin, core: plugin })
})

test("the cmod plugin's release carries bun.lock, the file that makes Claude Code install @cmodjs/cli and the launcher the bootstrap runs", async () => {
  const manifest = JSON.parse(await Bun.file(join(checkout, 'package.json')).text())

  expect(manifest.files).toContain('bun.lock')
  expect(manifest.dependencies['@cmodjs/cli']).toBeString()
})

test('the cmod launcher downloads its version, checks it against SHA256SUMS, and runs it', async () => {
  const home = await temporaryHome()
  using release = serveRelease('0.1.1')
  const launcher = await installPackage(join(home, 'npm/cmod'), '0.1.1')

  const result = await run([launcher, 'list'], home, release.origin)

  expect(result.stdout).toBe('cmod 0.1.1 ran list\n')
  expect(result.exitCode).toBe(0)
  expect(existsSync(join(storeOf(home), '0.1.1/cmod'))).toBe(true)
})

test('the cmod launcher runs the newest cmod in the store, and downloads nothing it already has', async () => {
  const home = await temporaryHome()
  using release = serveRelease('0.1.1')
  await writeFiles(storeOf(home), { '0.1.1/cmod': program('0.1.1'), '0.2.0/cmod': program('0.2.0') })
  await chmod(join(storeOf(home), '0.1.1/cmod'), 0o755)
  await chmod(join(storeOf(home), '0.2.0/cmod'), 0o755)
  const launcher = await installPackage(join(home, 'npm/cmod'), '0.1.1')

  const result = await run([launcher, 'list'], home, release.origin)

  expect(result.stdout).toBe('cmod 0.2.0 ran list\n')
  expect(release.requested).toEqual([])
})

test('the cmod launcher installs nothing when the download does not match SHA256SUMS', async () => {
  const home = await temporaryHome()
  using release = serveRelease('0.1.1', { sums: sha256('something else') })
  const launcher = await installPackage(join(home, 'npm/cmod'), '0.1.1')

  const result = await run([launcher, 'list'], home, release.origin)

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain(`but SHA256SUMS lists ${sha256('something else')}, so nothing was installed`)
  expect(existsSync(join(storeOf(home), '0.1.1/cmod'))).toBe(false)
})

test("the cmod plugin's bootstrap installs the plugin's cmod and links ~/.local/bin/cmod to the store, beside a cmod npm put on PATH", async () => {
  const home = await temporaryHome()
  using release = serveRelease('0.1.1')
  const plugin = join(home, 'plugins/cmod')
  await writeFiles(plugin, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'cmod', version: '0.1.1' }) })
  await mkdir(join(plugin, 'setup'), { recursive: true })
  await copyFile(join(checkout, 'setup', 'bootstrap.sh'), join(plugin, 'setup', 'bootstrap.sh'))
  await installPackage(join(plugin, 'node_modules/@cmodjs/cli'), '0.1.1')
  const npmLauncher = await installPackage(join(home, 'npm/lib/node_modules/@cmodjs/cli'), '0.1.1')
  await mkdir(join(home, 'npm/bin'), { recursive: true })
  await Bun.write(join(home, 'npm/bin/cmod'), `#!/bin/sh\nexec ${npmLauncher} "$@"\n`)
  await chmod(join(home, 'npm/bin/cmod'), 0o755)
  const path = `${join(home, 'npm/bin')}:${join(home, '.local/bin')}:/usr/bin:/bin`

  const bootstrap = await run(['sh', join(plugin, 'setup/bootstrap.sh')], home, release.origin, path)

  expect(bootstrap.stdout).toBe(`progress 0 2 Downloading cmod 0.1.1\nprogress 1 2 Linking ${join(home, '.local/bin/cmod')}\nprogress 2 2 cmod 0.1.1 is installed\n`)
  expect(bootstrap.exitCode).toBe(0)
  expect(readlinkSync(join(home, '.local/bin/cmod'))).toBe(join(storeOf(home), 'cmod'))

  await writeFiles(storeOf(home), { '0.2.0/cmod': program('0.2.0') })
  await chmod(join(storeOf(home), '0.2.0/cmod'), 0o755)

  expect((await run([join(home, '.local/bin/cmod'), 'list'], home, release.origin)).stdout).toBe('cmod 0.2.0 ran list\n')
  expect((await run([join(home, 'npm/bin/cmod'), 'list'], home, release.origin, path)).stdout).toBe('cmod 0.2.0 ran list\n')
})
