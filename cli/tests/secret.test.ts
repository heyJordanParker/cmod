import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { createCipheriv, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../src/process.js'
import { cmodBinary } from './cmod-binary.js'
import { captured, cmod, deleteTemporaryHomes, environment, spawningTestLimitMs, temporaryHome } from './cmod.js'

setDefaultTimeout(spawningTestLimitMs)
const keychainHomes: string[] = []

afterAll(async () => {
  for (const home of keychainHomes.splice(0)) {
    if (existsSync(keychainOf(home))) await run(['/usr/bin/security', 'delete-keychain', keychainOf(home)])
    await rm(home, { recursive: true, force: true })
  }
  await deleteTemporaryHomes()
})


const token = 'ghp_s3cret "quoted" é\nsecond line'

const keychainOf = (home: string) => join(home, 'Library/Keychains/login.keychain-db')

const secretsPathOf = (home: string) => join(home, '.local/share/cmod/secrets.json')

const secretsOf = async (home: string) => JSON.parse(await readFile(secretsPathOf(home), 'utf8')) as Record<string, Record<string, string>>

async function keychainHome(): Promise<string> {
  const home = await realpath(await mkdtemp('/private/tmp/cmod-secret-test-'))
  keychainHomes.push(home)
  await mkdir(join(home, 'Library/Keychains'), { recursive: true })
  await run(['/usr/bin/security', 'create-keychain', '-p', 'cmod-test', keychainOf(home)])
  await run(['/usr/bin/security', 'set-keychain-settings', keychainOf(home)])
  return home
}

async function secrets(home: string, args: string[], stdin = '', command = 'secrets'): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return captured([cmodBinary, command, ...args], { cwd: home, env: environment(home), stdin: { text: stdin } })
}

function sealedByOlderCmod(value: string, key: Buffer): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  return Buffer.concat([Buffer.from('v10'), nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64')
}

async function writeSecretsFile(home: string, all: Record<string, Record<string, string>>): Promise<void> {
  await mkdir(join(home, '.local/share/cmod'), { recursive: true })
  await writeFile(secretsPathOf(home), JSON.stringify(all), { mode: 0o600 })
}

async function sealingKeyIn(home: string): Promise<Buffer> {
  const key = randomBytes(32)
  await run(['/usr/bin/security', 'add-generic-password', '-s', 'cmod Safe Storage', '-a', 'cmod', '-w', key.toString('base64'), keychainOf(home)])
  return key
}

const onMac = test.skipIf(process.platform !== 'darwin')

test('cmod secrets store, which mod.secrets.store runs, keeps the value plain in secrets.json, mode 600, in a home with no keychain, and get prints it back', async () => {
  const home = await temporaryHome()

  const stored = await secrets(home, ['store', 'demo', 'token'], token)
  const got = await secrets(home, ['get', 'demo', 'token'])

  expect(stored).toEqual({ exitCode: 0, stdout: 'Stored the secret token of demo.\n', stderr: '' })
  expect(got).toEqual({ exitCode: 0, stdout: token, stderr: '' })
  expect((await stat(secretsPathOf(home))).mode & 0o777).toBe(0o600)
  expect(await secretsOf(home)).toEqual({ demo: { token } })
  expect(existsSync(join(home, 'Library'))).toBe(false)
})

test("one mod gets nothing for another mod's secret, and its own secrets stay apart", async () => {
  const home = await temporaryHome()
  await secrets(home, ['store', 'demo', 'token'], token)

  const other = await secrets(home, ['get', 'other', 'token'])
  await secrets(home, ['store', 'other', 'token'], 'other-token')

  expect(other).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  expect((await secrets(home, ['get', 'demo', 'token'])).stdout).toBe(token)
  expect((await secrets(home, ['get', 'other', 'token'])).stdout).toBe('other-token')
})

test('cmod secrets delete removes one secret, get then prints nothing, and deleting the last secret deletes secrets.json', async () => {
  const home = await temporaryHome()
  await secrets(home, ['store', 'demo', 'token'], token)
  await secrets(home, ['store', 'demo', 'refresh'], 'refresh-token')

  const deleted = await secrets(home, ['delete', 'demo', 'token'])

  expect(deleted).toEqual({ exitCode: 0, stdout: 'Deleted the secret token of demo.\n', stderr: '' })
  expect((await secrets(home, ['get', 'demo', 'token'])).stdout).toBe('')
  expect((await secrets(home, ['get', 'demo', 'refresh'])).stdout).toBe('refresh-token')

  await secrets(home, ['delete', 'demo', 'refresh'])

  expect(existsSync(secretsPathOf(home))).toBe(false)
})

test("cmod teardown deletes a removed mod's secrets with its data folder, and keeps every other mod's", async () => {
  const home = await temporaryHome()
  await secrets(home, ['store', 'demo', 'token'], token)
  await secrets(home, ['store', 'other', 'token'], 'other-token')

  const tornDown = await cmod(home, 'teardown', 'demo')

  expect(tornDown.exitCode).toBe(0)
  expect(Object.keys(await secretsOf(home))).toEqual(['other'])
  expect((await secrets(home, ['get', 'other', 'token'])).stdout).toBe('other-token')
})

test('cmod secrets store refuses an empty stdin, and names delete for removing a secret', async () => {
  const home = await temporaryHome()

  const stored = await secrets(home, ['store', 'demo', 'token'], '')

  expect([stored.exitCode, stored.stderr]).toEqual([1, 'cmod secrets: cmod secrets store read no value from stdin. cmod secrets delete demo token deletes the secret.\n'])
})

test('cmod secret store, get, and delete, which released cores run, still keep, print, and delete the value', async () => {
  const home = await temporaryHome()

  const stored = await secrets(home, ['store', 'demo', 'token'], token, 'secret')
  const got = await secrets(home, ['get', 'demo', 'token'], '', 'secret')
  const deleted = await secrets(home, ['delete', 'demo', 'token'], '', 'secret')

  expect(stored).toEqual({ exitCode: 0, stdout: 'Stored the secret token of demo.\n', stderr: '' })
  expect(got).toEqual({ exitCode: 0, stdout: token, stderr: '' })
  expect(deleted).toEqual({ exitCode: 0, stdout: 'Deleted the secret token of demo.\n', stderr: '' })
  expect((await secrets(home, ['get', 'demo', 'token'])).stdout).toBe('')
})

onMac('get opens a value an older cmod sealed once, writes every sealed value back plain, and reads the keychain no more', async () => {
  const home = await keychainHome()
  const key = await sealingKeyIn(home)
  await writeSecretsFile(home, { demo: { token: sealedByOlderCmod(token, key) }, other: { token: sealedByOlderCmod('other-token', key) } })

  const got = await secrets(home, ['get', 'demo', 'token'])
  const rewritten = await secretsOf(home)
  await run(['/usr/bin/security', 'delete-keychain', keychainOf(home)])

  expect(got).toEqual({ exitCode: 0, stdout: token, stderr: '' })
  expect(rewritten).toEqual({ demo: { token }, other: { token: 'other-token' } })
  expect((await stat(secretsPathOf(home))).mode & 0o777).toBe(0o600)
  expect((await secrets(home, ['get', 'other', 'token'])).stdout).toBe('other-token')
})

onMac('storing a secret writes every value an older cmod sealed back plain', async () => {
  const home = await keychainHome()
  const key = await sealingKeyIn(home)
  await writeSecretsFile(home, { demo: { token: sealedByOlderCmod(token, key) } })

  await secrets(home, ['store', 'other', 'token'], 'other-token')

  expect(await secretsOf(home)).toEqual({ demo: { token }, other: { token: 'other-token' } })
})

test('a sealed value with no keychain key to open it fails loud with its fix, and delete removes it', async () => {
  const home = await temporaryHome()
  await writeSecretsFile(home, { demo: { token: sealedByOlderCmod(token, randomBytes(32)) }, other: { token: 'other-token' } })

  const got = await secrets(home, ['get', 'demo', 'token'])
  const other = await secrets(home, ['get', 'other', 'token'])
  const deleted = await secrets(home, ['delete', 'demo', 'token'])

  expect([got.exitCode, got.stderr]).toEqual([1, 'cmod secrets: The secret token of demo in ~/.local/share/cmod/secrets.json, which an older cmod sealed, needs the cmod Safe Storage item in your login keychain to open, and there is none. Store it again, or delete it with cmod secrets delete demo token.\n'])
  expect(other).toEqual({ exitCode: 0, stdout: 'other-token', stderr: '' })
  expect(deleted.exitCode).toBe(0)
  expect(await secretsOf(home)).toEqual({ other: { token: 'other-token' } })
})
