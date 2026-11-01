import { afterAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { capture, run } from '../src/process.js'
import { deleteSecrets, readSecret, storeSecret } from '../src/store.js'
import { cmod, deleteTemporaryHomes, environment, temporaryHome } from './cmod.js'

const keychainHomes: string[] = []

afterAll(async () => {
  for (const home of keychainHomes.splice(0)) {
    if (existsSync(keychainOf(home))) await run(['/usr/bin/security', 'delete-keychain', keychainOf(home)])
    await rm(home, { recursive: true, force: true })
  }
  await deleteTemporaryHomes()
})

const main = join(import.meta.dir, '..', 'src', 'main.ts')

const token = 'ghp_s3cret "quoted" é\nsecond line'

const keychainOf = (home: string) => join(home, 'Library/Keychains/login.keychain-db')

const secretsOf = async (home: string) => JSON.parse(await readFile(join(home, '.local/share/cmod/secrets.json'), 'utf8')) as Record<string, Record<string, string>>

async function keychainHome(): Promise<string> {
  const home = await realpath(await mkdtemp('/private/tmp/cmod-secret-test-'))
  keychainHomes.push(home)
  await mkdir(join(home, 'Library/Keychains'), { recursive: true })
  await run(['/usr/bin/security', 'create-keychain', '-p', 'cmod-test', keychainOf(home)])
  await run(['/usr/bin/security', 'set-keychain-settings', keychainOf(home)])
  return home
}

async function secret(home: string, args: string[], stdin = ''): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, main, 'secret', ...args], { cwd: home, env: environment(home), stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { exitCode, stdout, stderr }
}

const onMac = test.skipIf(process.platform !== 'darwin')

onMac('cmod secret store keeps the value it reads from stdin sealed in secrets.json, mode 600, and get prints it back', async () => {
  const home = await keychainHome()

  const stored = await secret(home, ['store', 'anyhost', 'token'], token)
  const got = await secret(home, ['get', 'anyhost', 'token'])
  const file = join(home, '.local/share/cmod/secrets.json')
  const sealed = (await secretsOf(home))['anyhost']?.['token'] ?? ''

  expect(stored).toEqual({ exitCode: 0, stdout: 'Stored the secret token of anyhost.\n', stderr: '' })
  expect(got).toEqual({ exitCode: 0, stdout: token, stderr: '' })
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(await readFile(file, 'utf8')).not.toContain('ghp_s3cret')
  expect(Buffer.from(sealed, 'base64').subarray(0, 3).toString()).toBe('v10')
})

onMac('a 40 KB secret round-trips, because only the 32-byte key crosses security', async () => {
  const home = await keychainHome()
  const large = 'k'.repeat(40_000)

  await secret(home, ['store', 'anyhost', 'large'], large)

  expect((await secret(home, ['get', 'anyhost', 'large'])).stdout).toBe(large)
})

onMac('the login keychain holds one cmod Safe Storage item for every mod and secret, and a second store keeps its key', async () => {
  const home = await keychainHome()
  await secret(home, ['store', 'anyhost', 'token'], token)
  const keyBefore = await capture(['/usr/bin/security', 'find-generic-password', '-s', 'cmod Safe Storage', '-a', 'cmod', '-w', keychainOf(home)])

  await secret(home, ['store', 'anyhost', 'refresh'], 'refresh-token')
  await secret(home, ['store', 'notes', 'token'], 'notes-token')
  const keyAfter = await capture(['/usr/bin/security', 'find-generic-password', '-s', 'cmod Safe Storage', '-a', 'cmod', '-w', keychainOf(home)])
  const dumped = await run(['/usr/bin/security', 'dump-keychain', keychainOf(home)])

  expect(dumped.split('\n').filter((line) => line.startsWith('keychain: '))).toHaveLength(1)
  expect(dumped).toContain('"svce"<blob>="cmod Safe Storage"')
  expect(Buffer.from(keyAfter.stdout.trim(), 'base64')).toHaveLength(32)
  expect(keyAfter.stdout).toBe(keyBefore.stdout)
  expect((await secret(home, ['get', 'anyhost', 'token'])).stdout).toBe(token)
})

onMac("one mod gets nothing for another mod's secret, and its own secrets stay apart", async () => {
  const home = await keychainHome()
  await secret(home, ['store', 'anyhost', 'token'], token)

  const other = await secret(home, ['get', 'notes', 'token'])
  await secret(home, ['store', 'notes', 'token'], 'notes-token')

  expect(other).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  expect((await secret(home, ['get', 'anyhost', 'token'])).stdout).toBe(token)
  expect((await secret(home, ['get', 'notes', 'token'])).stdout).toBe('notes-token')
})

onMac('cmod secret delete removes one secret, and get then prints nothing', async () => {
  const home = await keychainHome()
  await secret(home, ['store', 'anyhost', 'token'], token)
  await secret(home, ['store', 'anyhost', 'refresh'], 'refresh-token')

  const deleted = await secret(home, ['delete', 'anyhost', 'token'])

  expect(deleted).toEqual({ exitCode: 0, stdout: 'Deleted the secret token of anyhost.\n', stderr: '' })
  expect((await secret(home, ['get', 'anyhost', 'token'])).stdout).toBe('')
  expect((await secret(home, ['get', 'anyhost', 'refresh'])).stdout).toBe('refresh-token')
})

onMac("cmod teardown deletes a removed mod's secrets with its data folder, and keeps every other mod's", async () => {
  const home = await keychainHome()
  await secret(home, ['store', 'anyhost', 'token'], token)
  await secret(home, ['store', 'notes', 'token'], 'notes-token')

  const tornDown = await cmod(home, 'teardown', 'anyhost')

  expect(tornDown.exitCode).toBe(0)
  expect(Object.keys(await secretsOf(home))).toEqual(['notes'])
  expect((await secret(home, ['get', 'notes', 'token'])).stdout).toBe('notes-token')
})

onMac('cmod secret keeps nothing in a home with no login keychain, because security would write to the default keychain instead', async () => {
  const home = await temporaryHome()

  const stored = await secret(home, ['store', 'anyhost', 'token'], token)

  expect([stored.exitCode, stored.stderr]).toEqual([1, 'cmod secret: ~/Library/Keychains/login.keychain-db does not exist, so cmod has no login keychain to keep the key to its secrets in. Run cmod with HOME set to your home folder.\n'])
  expect(existsSync(join(home, '.local/share/cmod/secrets.json'))).toBe(false)
})

test('cmod secret store refuses an empty stdin, and names delete for removing a secret', async () => {
  const home = await temporaryHome()

  const stored = await secret(home, ['store', 'anyhost', 'token'], '')

  expect([stored.exitCode, stored.stderr]).toEqual([1, 'cmod secret: cmod secret store read no value from stdin. cmod secret delete anyhost token deletes the secret.\n'])
})

test('on Linux the secrets live plain in secrets.json in the cmod store, which only its owner can read or write', async () => {
  const home = await temporaryHome()
  const before = { platform: process.platform, HOME: process.env['HOME'], XDG_DATA_HOME: process.env['XDG_DATA_HOME'] }
  Object.defineProperty(process, 'platform', { value: 'linux' })
  process.env['HOME'] = home
  process.env['XDG_DATA_HOME'] = ''
  try {
    await storeSecret('anyhost', 'token', token)
    await storeSecret('notes', 'token', 'notes-token')
    const path = join(home, '.local/share/cmod/secrets.json')

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ anyhost: { token }, notes: { token: 'notes-token' } })
    expect(await readSecret('anyhost', 'token')).toBe(token)

    await deleteSecrets('anyhost', ['token'])
    await deleteSecrets('notes')

    expect(existsSync(path)).toBe(false)
  } finally {
    Object.defineProperty(process, 'platform', { value: before.platform })
    process.env['HOME'] = before.HOME
    process.env['XDG_DATA_HOME'] = before.XDG_DATA_HOME
  }
})
