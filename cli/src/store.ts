import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { consentPath, isAtLeast, isObject, linksPath, parseConsent, parseLinks, pluginsChangedMark, pluginsChangedPath, readCmodVersion, recordPath, storeChangedPath, storeFolder, type Links } from '@cmodjs/core/src/records.js'
import { version } from '../package.json'
import { home, ifMissing, readJson, readText, tilde, writeAtomically } from './files.js'
import { capture } from './process.js'
import { interruptProgress } from './progress.js'

const lockNoticeMs = 3000

let ownStartTime: Promise<string> | undefined

export function storePath(...parts: string[]): string {
  return join(storeFolder(process.env), ...parts)
}

export async function markPluginsChanged(checkout?: string): Promise<void> {
  const store = storeFolder(process.env)
  if (!existsSync(store)) return
  await writeAtomically(pluginsChangedPath(store), pluginsChangedMark(Date.now(), process.pid, checkout))
  await markStoreChanged()
}

export async function isNewerCmodInstalled(): Promise<boolean> {
  const installed = await readCmodVersion({ list: (folder) => readdir(folder).catch(ifMissing([])), exists: async (path) => existsSync(path) }, storeFolder(process.env))
  return installed !== undefined && !isAtLeast(version, installed)
}

export async function markStoreChanged(): Promise<void> {
  const store = storeFolder(process.env)
  if (existsSync(store)) await writeAtomically(storeChangedPath(store), '')
}

export async function recordNames(): Promise<string[]> {
  const entries = await readdir(storePath('records')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  return entries.filter((entry) => entry.endsWith('.json')).map((entry) => entry.slice(0, -'.json'.length)).sort()
}

export function modLock(name: string): string {
  return `${recordPath(storeFolder(process.env), name)}.lock`
}

export function takeLock(path: string): Promise<AsyncDisposable>
export function takeLock(path: string, cancel: AbortSignal): Promise<AsyncDisposable | undefined>
export async function takeLock(path: string, cancel?: AbortSignal): Promise<AsyncDisposable | undefined> {
  await mkdir(dirname(path), { recursive: true })
  const started = await (ownStartTime ??= startTime(process.pid))
  let noticeAt = Date.now() + lockNoticeMs
  while (!(await placeLock(path, started))) {
    const holders = await readdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const live: string[] = []
    for (const holder of holders) {
      if (await isHolding(Number(holder), await readText(join(path, holder)))) live.push(holder)
      else await rm(join(path, holder), { force: true })
    }
    if (live.length === 0) continue
    if (cancel?.aborted) return undefined
    if (Date.now() >= noticeAt) {
      noticeAt = Number.POSITIVE_INFINITY
      const resumeProgress = interruptProgress()
      process.stderr.write(`Waiting for ${tilde(path)}, which process ${live.join(', ')} holds.\n`)
      resumeProgress()
    }
    await Bun.sleep(100)
  }
  const holder = join(path, String(process.pid))
  return {
    async [Symbol.asyncDispose]() {
      await rm(holder)
      await rmdir(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
      })
    },
  }
}

async function placeLock(path: string, started: string): Promise<boolean> {
  const staged = `${path}.${process.pid}.tmp`
  await mkdir(staged, { recursive: true })
  await writeFile(join(staged, String(process.pid)), started)
  return rename(staged, path).then(
    () => true,
    async (error: NodeJS.ErrnoException) => {
      await rm(staged, { recursive: true })
      if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') return false
      throw error
    },
  )
}

export async function isHolding(processId: number, started: string | undefined): Promise<boolean> {
  if (started === undefined || processId === process.pid || !isRunning(processId)) return false
  if (started === '') return true
  const current = await startTime(processId)
  return current === '' || current === started
}

function isRunning(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function startTime(processId: number): Promise<string> {
  if (!existsSync('/bin/ps')) return ''
  const { stdout } = await capture(['/bin/ps', '-o', 'lstart=', '-p', String(processId)], { cwd: '/', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } })
  return stdout.trim()
}

export async function approvals(name: string): Promise<readonly string[]> {
  return (await readConsent())[name] ?? []
}

export async function approve(name: string, items: readonly string[]): Promise<void> {
  await changeConsent((consent) => {
    const approved = consent[name] ?? []
    const added = [...new Set(items)].filter((item) => !approved.includes(item))
    if (added.length === 0) return false
    consent[name] = [...approved, ...added]
    return true
  })
}

export async function revokeApprovals(name: string, items?: readonly string[]): Promise<void> {
  await changeConsent((consent) => {
    const approved = consent[name]
    if (approved === undefined) return false
    const kept = approved.filter((item) => items !== undefined && !items.includes(item))
    if (kept.length === approved.length) return false
    if (kept.length > 0) consent[name] = kept
    else delete consent[name]
    return true
  })
}

async function changeConsent(change: (consent: Record<string, string[]>) => boolean): Promise<void> {
  const lock = await takeLock(storePath('consent.json.lock'))
  try {
    const consent = await readConsent()
    if (change(consent)) await writeAtomically(consentPath(storeFolder(process.env)), `${JSON.stringify(consent, null, 2)}\n`)
  } finally {
    await lock[Symbol.asyncDispose]()
  }
}

async function readConsent(): Promise<Record<string, string[]>> {
  const path = consentPath(storeFolder(process.env))
  return parseConsent(await readJson(path), path)
}

export type LinksChange = { marketplaces: Record<string, string>; turnedOff: Record<string, string[]> }

export async function readLinks(): Promise<Links> {
  const path = linksPath(storeFolder(process.env))
  return parseLinks(await readJson(path), path)
}

export async function changeLinks<Result>(change: (links: LinksChange) => Promise<Result>): Promise<Result> {
  const lock = await takeLock(storePath('links.json.lock'))
  try {
    const links = structuredClone(await readLinks()) as LinksChange
    const before = JSON.stringify(links)
    try {
      return await change(links)
    } finally {
      const path = linksPath(storeFolder(process.env))
      const isEmpty = Object.keys(links.marketplaces).length === 0 && Object.keys(links.turnedOff).length === 0
      if (JSON.stringify(links) !== before) await (isEmpty ? rm(path, { force: true }) : writeAtomically(path, `${JSON.stringify(links, null, 2)}\n`))
    }
  } finally {
    await lock[Symbol.asyncDispose]()
  }
}

type Secrets = Record<string, string>

const safeStorage = 'cmod Safe Storage'

const safeStorageAccount = 'cmod'

const security = '/usr/bin/security'

const itemNotFound = 44

const sealedVersion = 'v10'

export async function readSecret(mod: string, key: string): Promise<string | undefined> {
  const value = (await readSecretsFile())[mod]?.[key]
  if (value === undefined || process.platform !== 'darwin') return value
  const where = `The secret ${key} of ${mod} in ${tilde(secretsPath())}`
  const safeKey = await readSafeStorageKey()
  if (safeKey === undefined) throw new Error(`${where} is sealed, and your login keychain has no ${safeStorage} item to open it. Store the secret again.`)
  return unseal(value, safeKey, where)
}

export async function storeSecret(mod: string, key: string, value: string): Promise<void> {
  await changeSecretsFile(async (all) => {
    const kept = process.platform === 'darwin' ? seal(value, await safeStorageKey()) : value
    all[mod] = Object.assign(all[mod] ?? Object.create(null), { [key]: kept })
  })
}

export async function deleteSecrets(mod: string, keys?: readonly string[]): Promise<void> {
  await changeSecretsFile(async (all) => {
    const secrets = all[mod]
    if (secrets === undefined) return
    for (const key of keys ?? Object.keys(secrets)) delete secrets[key]
    if (Object.keys(secrets).length === 0) delete all[mod]
  })
}

async function changeSecretsFile(change: (all: Record<string, Secrets>) => Promise<void>): Promise<void> {
  const lock = await takeLock(storePath('secrets.json.lock'))
  try {
    const all = await readSecretsFile()
    const before = JSON.stringify(all)
    await change(all)
    if (JSON.stringify(all) !== before) await writeSecretsFile(all)
  } finally {
    await lock[Symbol.asyncDispose]()
  }
}

function loginKeychain(): string {
  return join(home(), 'Library', 'Keychains', 'login.keychain-db')
}

async function readSafeStorageKey(): Promise<Buffer | undefined> {
  if (!existsSync(loginKeychain())) return undefined
  const found = await capture([security, 'find-generic-password', '-s', safeStorage, '-a', safeStorageAccount, '-w', loginKeychain()])
  if (found.exitCode === itemNotFound) return undefined
  if (found.exitCode !== 0) throw new Error(`Your login keychain refused cmod its ${safeStorage} key: ${found.stderr.trim().split('\n').at(-1) ?? ''}`)
  const key = Buffer.from(found.stdout.trim(), 'base64')
  if (key.length !== 32) throw new Error(`The ${safeStorage} item in your login keychain holds no 32-byte key, so cmod opens no secret. Delete it in Keychain Access, then store each secret again.`)
  return key
}

async function safeStorageKey(): Promise<Buffer> {
  const keychain = loginKeychain()
  if (!existsSync(keychain)) throw new Error(`${tilde(keychain)} does not exist, so cmod has no login keychain to keep the key to its secrets in. Run cmod with HOME set to your home folder.`)
  const found = await readSafeStorageKey()
  if (found !== undefined) return found
  const key = randomBytes(32)
  const written = await capture([security, '-i'], { stdin: { text: `add-generic-password -s "${safeStorage}" -a "${safeStorageAccount}" -X "${Buffer.from(key.toString('base64')).toString('hex')}" "${keychain}"\n` } })
  if (written.exitCode !== 0) throw new Error(`Your login keychain did not keep the ${safeStorage} key: security exited ${written.exitCode}.`)
  return key
}

function seal(value: string, key: Buffer): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  return Buffer.concat([Buffer.from(sealedVersion), nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64')
}

function unseal(text: string, key: Buffer, where: string): string {
  const sealed = Buffer.from(text, 'base64')
  if (sealed.length < sealedVersion.length + 12 + 16 || sealed.subarray(0, sealedVersion.length).toString() !== sealedVersion) throw new Error(`${where} is not sealed by cmod. Store it again.`)
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(sealedVersion.length, sealedVersion.length + 12))
  decipher.setAuthTag(sealed.subarray(-16))
  try {
    return Buffer.concat([decipher.update(sealed.subarray(sealedVersion.length + 12, -16)), decipher.final()]).toString('utf8')
  } catch (error) {
    throw new Error(`${where} does not open with the ${safeStorage} key in your login keychain. Store it again.`, { cause: error })
  }
}

function secretsPath(): string {
  return storePath('secrets.json')
}

async function readSecretsFile(): Promise<Record<string, Secrets>> {
  const path = secretsPath()
  const value = await readJson(path)
  const fix = 'Delete it, which deletes the secrets of every mod.'
  if (value === undefined) return Object.create(null)
  if (!isObject(value)) throw new Error(`${tilde(path)} is not a map of mods to their secrets. ${fix}`)
  return Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([mod, secrets]) => [mod, parseSecrets(secrets, `The secrets of ${mod} in ${tilde(path)}`, fix)])))
}

async function writeSecretsFile(all: Record<string, Secrets>): Promise<void> {
  const path = secretsPath()
  if (Object.keys(all).length === 0) return rm(path, { force: true })
  await writeAtomically(path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
}

function parseSecrets(value: unknown, where: string, fix: string): Secrets {
  if (!isObject(value) || !Object.values(value).every((secret) => typeof secret === 'string')) throw new Error(`${where} is not a map of secret keys to their values. ${fix}`)
  return Object.assign(Object.create(null), value) as Secrets
}
