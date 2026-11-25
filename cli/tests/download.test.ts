import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, readlink, symlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { cmod, cmodExecutable, cmodWith, deleteTemporaryHomes, spawned, spawningTestLimitMs, temporaryHome, writeFiles } from './cmod.js'

setDefaultTimeout(spawningTestLimitMs)
afterAll(deleteTemporaryHomes)

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
  await writeFiles(home, { 'bin/cmod': cmodExecutable })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo', cmod: { install: './setup/install.sh' } }),
    'setup/install.sh': `#!/bin/sh\nset -e\n${install}\n`,
  })
  return cmod(home, 'setup', root, '--events')
}

const data = (home: string, ...path: string[]) => join(home, '.local/share/cmod/data/demo', ...path)
const cache = (home: string, ...path: string[]) => join(home, '.cache/cmod/demo', ...path)
const output = (path: string) => new Response(spawned([path], { stdout: 'pipe' }).stdout).text()
const byName = (home: string, program: string) => new Response(spawned(['sh', '-c', program], { env: { PATH: `${join(home, '.local/share/cmod/programs')}:/usr/bin:/bin` }, stdout: 'pipe' }).stdout).text()

test("download installs the program for this machine into CMOD_CACHE/bin, and links cmod's programs folder and CMOD_DATA/bin to it", async () => {
  const home = await temporaryHome()
  const { tarGz } = await archives(home)
  using server = await serve({ 'hello.tar.gz': tarGz, 'other.tar.gz': 'a build for another machine' })

  const result = await setUp(home, `cmod download hello ${otherMachine} ${server.origin}/other.tar.gz ${sha256('a build for another machine')} ${machine} ${server.origin}/hello.tar.gz ${sha256(tarGz)}`)
  const listed = await cmod(home, 'data', '--json')

  expect(result.stdout).toEndWith('done demo 0.1.0\n')
  expect(result.exitCode).toBe(0)
  expect(server.requested).toEqual(['hello.tar.gz'])
  expect((await lstat(cache(home, 'bin/hello'))).isFile()).toBe(true)
  expect(await output(cache(home, 'bin/hello'))).toBe('hello 1.0.0\n')
  expect(await readdir(cache(home))).toEqual(['bin'])
  expect(await readdir(cache(home, 'bin'))).toEqual(['hello'])
  expect(await readlink(join(home, '.local/share/cmod/programs/hello'))).toBe(cache(home, 'bin/hello'))
  expect(await readlink(data(home, 'bin/hello'))).toBe(cache(home, 'bin/hello'))
  expect(await readdir(data(home, 'bin'))).toEqual(['hello'])
  expect(await output(data(home, 'bin/hello'))).toBe('hello 1.0.0\n')
  expect(await byName(home, 'hello')).toBe('hello 1.0.0\n')
  expect(JSON.parse(listed.stdout)).toEqual([{ mod: 'demo', folder: data(home) }])
})

test("a program cmod 7 downloaded into CMOD_DATA/bin moves to CMOD_CACHE/bin at the next setup, and still runs by its 7.0.0 path and by its name, while the mod's own files there stay", async () => {
  const home = await temporaryHome()
  const record = { name: 'demo', version: '0.0.9', root: join(home, 'demo'), installedAt: '2026-10-01T00:00:00.000Z', scriptsSha256: '', uninstall: null, program: null }
  await writeFiles(home, { '.local/share/cmod/records/demo.json': JSON.stringify(record) })
  await writeFiles(data(home), { 'bin/hello': '#!/bin/sh\necho "hello 0.9.0"\n', 'bin/helper': '#!/bin/sh\necho "the mod wrote me"\n', 'history.db': 'kept\n' })
  await mkdir(join(home, '.local/share/cmod/programs'), { recursive: true })
  await symlink(data(home, 'bin/hello'), join(home, '.local/share/cmod/programs/hello'))

  const result = await setUp(home, 'true')

  expect(result.stdout).toEndWith('done demo 0.1.0\n')
  expect(result.exitCode).toBe(0)
  expect((await readdir(data(home))).sort()).toEqual(['bin', 'history.db'])
  expect((await readdir(data(home, 'bin'))).sort()).toEqual(['hello', 'helper'])
  expect(await readlink(data(home, 'bin/hello'))).toBe(cache(home, 'bin/hello'))
  expect(await output(data(home, 'bin/hello'))).toBe('hello 0.9.0\n')
  expect((await lstat(data(home, 'bin/helper'))).isFile()).toBe(true)
  expect(await output(data(home, 'bin/helper'))).toBe('the mod wrote me\n')
  expect(await readdir(cache(home, 'bin'))).toEqual(['hello'])
  expect((await lstat(cache(home, 'bin/hello'))).isFile()).toBe(true)
  expect(await readlink(join(home, '.local/share/cmod/programs/hello'))).toBe(cache(home, 'bin/hello'))
  expect(await byName(home, 'hello')).toBe('hello 0.9.0\n')
})

test("teardown removes a downloaded program's cache copy and both links, and keeps every file cmod did not place", async () => {
  const home = await temporaryHome()
  const { tarGz } = await archives(home)
  using server = await serve({ 'hello.tar.gz': tarGz })
  await writeFiles(home, { '.local/share/cmod/programs/kept': '#!/bin/sh\n', '.local/bin/hello': '#!/bin/sh\necho "my own hello"\n', '.local/share/cmod/data/other/bin/hello': 'kept\n', '.cache/cmod/other/bin/hello': 'kept\n' })
  expect((await setUp(home, `cmod download hello ${machine} ${server.origin}/hello.tar.gz ${sha256(tarGz)}`)).exitCode).toBe(0)
  expect(await byName(home, 'hello')).toBe('hello 1.0.0\n')

  const result = await cmod(home, 'teardown', 'demo', '--events')

  expect(result.stdout).toBe('done demo\n')
  expect(await readdir(join(home, '.local/share/cmod/programs'))).toEqual(['kept'])
  expect(existsSync(data(home))).toBe(false)
  expect(existsSync(cache(home))).toBe(false)
  expect(await readFile(join(home, '.local/bin/hello'), 'utf8')).toBe('#!/bin/sh\necho "my own hello"\n')
  expect(await readFile(join(home, '.local/share/cmod/data/other/bin/hello'), 'utf8')).toBe('kept\n')
  expect(await readFile(join(home, '.cache/cmod/other/bin/hello'), 'utf8')).toBe('kept\n')
})

test('a SHA-256 that differs in an update installs nothing and keeps the program the mod had', async () => {
  const home = await temporaryHome()
  const { tarGz } = await archives(home)
  const record = { name: 'demo', version: '0.0.9', root: join(home, 'demo'), installedAt: '2026-10-01T00:00:00.000Z', scriptsSha256: '', uninstall: null, program: null }
  await writeFiles(home, { '.local/share/cmod/records/demo.json': JSON.stringify(record) })
  await writeFiles(data(home), { 'bin/hello': '#!/bin/sh\necho "hello 0.9.0"\n' })
  await mkdir(join(home, '.local/share/cmod/programs'), { recursive: true })
  await symlink(data(home, 'bin/hello'), join(home, '.local/share/cmod/programs/hello'))
  using server = await serve({ 'hello.tar.gz': tarGz })
  const listed = sha256('the archive the mod author checked')

  const result = await setUp(home, `cmod download hello ${machine} ${server.origin}/hello.tar.gz ${listed}`)

  expect(result.stdout.split('\n').at(-2)).toBe(
    `failed 1\tThe install step of demo exited 1: cmod download: ${server.origin}/hello.tar.gz has SHA-256 ${sha256(tarGz)}, but the install script lists ${listed}, so cmod installed nothing. Run the install again. If it repeats, the file at that link changed, and the mod needs an update.`,
  )
  expect(result.exitCode).toBe(1)
  expect(await readdir(cache(home, 'bin'))).toEqual(['hello'])
  expect(await readFile(cache(home, 'bin/hello'), 'utf8')).toBe('#!/bin/sh\necho "hello 0.9.0"\n')
  expect(await output(data(home, 'bin/hello'))).toBe('hello 0.9.0\n')
  expect(await byName(home, 'hello')).toBe('hello 0.9.0\n')
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
  expect(existsSync(cache(home))).toBe(false)
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
  expect(await output(cache(home, 'bin/hello'))).toBe('hello 1.0.0\n')
  expect(await output(cache(home, 'bin/hi'))).toBe('hi from a bare file\n')
  expect(await readdir(cache(home))).toEqual(['bin'])
})

test('download without CMOD_DATA or CMOD_CACHE fails with the fix', async () => {
  const home = await temporaryHome()

  const neither = await cmod(home, 'download', 'hello', machine, 'http://127.0.0.1:9/hello', sha256('hello'))
  const noData = await cmodWith(home, { CMOD_CACHE: cache(home) }, 'download', 'hello', machine, 'http://127.0.0.1:9/hello', sha256('hello'))

  expect(neither.stderr).toBe("cmod download: CMOD_CACHE is not set. Run this from a mod's install script; cmod setup sets CMOD_DATA and CMOD_CACHE.\n")
  expect(neither.exitCode).toBe(1)
  expect(noData.stderr).toBe("cmod download: CMOD_DATA is not set. Run this from a mod's install script; cmod setup sets CMOD_DATA and CMOD_CACHE.\n")
  expect(noData.exitCode).toBe(1)
})
