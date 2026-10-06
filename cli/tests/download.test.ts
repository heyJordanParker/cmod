import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { cmod, cmodFromSource, deleteTemporaryHomes, hashOf, temporaryHome, writeFiles } from './cmod.js'

afterEach(deleteTemporaryHomes)

const machine = `${process.platform}-${process.arch}`
const otherMachine = machine === 'linux-x64' ? 'darwin-arm64' : 'linux-x64'
const hello = '#!/bin/sh\necho "hello 1.0.0"\n'

function sha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}

async function serve(files: Record<string, Uint8Array | string>) {
  const requested: string[] = []
  const server = createServer(async (request, response) => {
    const path = (request.url ?? '').slice(1)
    requested.push(path)
    const file = files[path]
    if (file === undefined) {
      response.writeHead(404).end()
      return
    }
    const bytes = typeof file === 'string' ? new TextEncoder().encode(file) : file
    response.writeHead(200, { 'content-length': bytes.byteLength })
    const quarter = Math.ceil(bytes.byteLength / 4)
    for (let start = 0; start < bytes.byteLength; start += quarter) {
      response.write(bytes.subarray(start, start + quarter))
      await Bun.sleep(100)
    }
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { origin: `http://127.0.0.1:${port}`, requested, [Symbol.dispose]: () => server.close() }
}

async function archives(home: string): Promise<{ tarGz: Uint8Array; zip: Uint8Array }> {
  const build = join(home, 'build')
  await writeFiles(build, { 'hello-1.0.0/hello': hello, 'hello-1.0.0/README.md': '# hello\n' })
  expect(Bun.spawnSync(['tar', '-czf', 'hello.tar.gz', 'hello-1.0.0'], { cwd: build }).exitCode).toBe(0)
  expect(Bun.spawnSync(['zip', '-qr', 'hello.zip', 'hello-1.0.0'], { cwd: build }).exitCode).toBe(0)
  return { tarGz: await Bun.file(join(build, 'hello.tar.gz')).bytes(), zip: await Bun.file(join(build, 'hello.zip')).bytes() }
}

async function setUp(home: string, install: string) {
  const root = join(home, 'demo')
  await writeFiles(home, { 'bin/cmod': cmodFromSource })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo', cmod: { install: './setup/install.sh' } }),
    'setup/install.sh': `#!/bin/sh\nset -e\n${install}\n`,
  })
  return cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))
}

const data = (home: string, ...path: string[]) => join(home, '.local/share/cmod/data/demo', ...path)
const output = (path: string) => new Response(Bun.spawn([path], { stdout: 'pipe' }).stdout).text()

test('download installs the program for this machine into CMOD_DATA/bin', async () => {
  const home = await temporaryHome()
  const { tarGz } = await archives(home)
  using server = await serve({ 'hello.tar.gz': tarGz, 'other.tar.gz': 'a build for another machine' })

  const result = await setUp(home, `cmod download hello ${otherMachine} ${server.origin}/other.tar.gz ${sha256('a build for another machine')} ${machine} ${server.origin}/hello.tar.gz ${sha256(tarGz)}`)

  expect(result.stdout).toEndWith('done demo 0.1.0\n')
  expect(result.exitCode).toBe(0)
  expect(server.requested).toEqual(['hello.tar.gz'])
  expect(await output(data(home, 'bin/hello'))).toBe('hello 1.0.0\n')
  expect(await readdir(data(home))).toEqual(['bin'])
  expect(await readdir(data(home, 'bin'))).toEqual(['hello'])
})

test('a SHA-256 that differs in an update installs nothing and keeps the program the mod had', async () => {
  const home = await temporaryHome()
  const { tarGz } = await archives(home)
  const record = { name: 'demo', version: '0.0.9', root: join(home, 'demo'), installedAt: '2026-10-01T00:00:00.000Z', scriptsSha256: '', uninstall: null, program: null }
  await writeFiles(home, { '.local/share/cmod/records/demo.json': JSON.stringify(record) })
  await writeFiles(data(home), { 'bin/hello': '#!/bin/sh\necho "hello 0.9.0"\n' })
  using server = await serve({ 'hello.tar.gz': tarGz })
  const listed = sha256('the archive the mod author checked')

  const result = await setUp(home, `cmod download hello ${machine} ${server.origin}/hello.tar.gz ${listed}`)

  expect(result.stdout.split('\n').at(-2)).toBe(
    `failed 1\tThe install step of demo exited 1: cmod download: ${server.origin}/hello.tar.gz has SHA-256 ${sha256(tarGz)}, but the install script lists ${listed}, so cmod installed nothing. Run the install again. If it repeats, the file at that link changed, and the mod needs an update.`,
  )
  expect(result.exitCode).toBe(1)
  expect(await readdir(data(home))).toEqual(['bin'])
  expect(await readdir(data(home, 'bin'))).toEqual(['hello'])
  expect(await readFile(data(home, 'bin/hello'), 'utf8')).toBe('#!/bin/sh\necho "hello 0.9.0"\n')
  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/records/demo.json'), 'utf8'))).toEqual(record)
})

test('a machine with no listed download fails naming the machines listed', async () => {
  const home = await temporaryHome()
  using server = await serve({})

  const result = await setUp(home, `cmod download hello freebsd-x64 ${server.origin}/hello-freebsd.tar.gz ${sha256('freebsd')} win32-arm64 ${server.origin}/hello-windows.zip ${sha256('windows')}`)

  expect(result.stdout).toBe(`log cmod download: hello has no download for this machine, ${machine}. The install script lists freebsd-x64, win32-arm64.\nfailed 1\tThe install step of demo exited 1: cmod download: hello has no download for this machine, ${machine}. The install script lists freebsd-x64, win32-arm64.\n`)
  expect(result.exitCode).toBe(1)
  expect(server.requested).toEqual([])
  expect(existsSync(data(home))).toBe(false)
})

test('download prints progress lines setup can read', async () => {
  const home = await temporaryHome()
  const program = `${hello}exit 0\n`.padEnd(400_000, '#')
  using server = await serve({ [`hello-${machine}`]: program })

  const result = await setUp(home, `cmod download hello ${machine} ${server.origin}/hello-${machine} ${sha256(program)}`)

  const lines = result.stdout.split('\n')
  const growing = lines.slice(1, -4)
  expect(lines[0]).toBe(`progress 0 7 Downloading hello for ${machine}`)
  expect(growing.length).toBeGreaterThan(1)
  for (const line of growing) expect(line).toMatch(/^progress [1-4] 7 Downloading hello: 0\.[1-4] of 0\.4 MB$/)
  expect(growing.map((line) => Number(line.split(' ')[1]))).toEqual(growing.map((line) => Number(line.split(' ')[1])).sort())
  expect(growing.at(-1)).toBe('progress 4 7 Downloading hello: 0.4 of 0.4 MB')
  expect(lines.slice(-4)).toEqual(["progress 5 7 Checking hello's SHA-256", 'progress 7 7 hello is installed', 'done demo 0.1.0', ''])
  expect(result.exitCode).toBe(0)
})

test('a .zip and a bare file both install', async () => {
  const home = await temporaryHome()
  const { zip } = await archives(home)
  const hi = '#!/bin/sh\necho "hi from a bare file"\n'
  using server = await serve({ 'hello.zip': zip, [`hi-${machine}`]: hi })

  const result = await setUp(home, [`cmod download hello ${machine} ${server.origin}/hello.zip ${sha256(zip)}`, `cmod download hi ${machine} ${server.origin}/hi-${machine} ${sha256(hi)}`].join('\n'))

  expect(result.stdout).toContain("progress 6 7 Unpacking hello\n")
  expect(result.stdout).toEndWith('done demo 0.1.0\n')
  expect(result.exitCode).toBe(0)
  expect(await output(data(home, 'bin/hello'))).toBe('hello 1.0.0\n')
  expect(await output(data(home, 'bin/hi'))).toBe('hi from a bare file\n')
  expect(await readdir(data(home))).toEqual(['bin'])
})

test('download without CMOD_DATA fails with the fix', async () => {
  const home = await temporaryHome()

  const result = await cmod(home, 'download', 'hello', machine, 'http://127.0.0.1:9/hello', sha256('hello'))

  expect(result.stderr).toBe("cmod download: CMOD_DATA is not set. Run this from a mod's install script; cmod setup sets CMOD_DATA.\n")
  expect(result.exitCode).toBe(1)
})
