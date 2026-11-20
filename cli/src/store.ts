import { createDecipheriv } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { consentPath, isAtLeast, isObject, linksPath, parseConsent, parseLinks, parsePluginsChanged, pluginsChangedPath, pluginsChangedText, readCmodVersion, recordPath, storeChangedPath, storeFolder, type Links } from '@cmodjs/core/src/records.js'
import { version } from '../package.json'
import { home, ifMissing, readJson, readText, tilde, writeAtomically } from './files.js'
import { capture } from './process.js'
import { interruptProgress } from './progress.js'

const lockNoticeMs = 3000

const lockPollMs = 100

const ownLocks = new Set<string>()

let ownStartTime: Promise<string> | undefined

export function storePath(...parts: string[]): string {
  return join(storeFolder(process.env), ...parts)
}

export async function markPluginsChanged(linked?: { readonly mod: string; readonly at: number }): Promise<void> {
  const store = storeFolder(process.env)
  if (!existsSync(store)) return
  const path = pluginsChangedPath(store)
  const marked = parsePluginsChanged((await readText(path)) ?? '')
  await writeAtomically(path, pluginsChangedText(linked === undefined ? { ...marked, command: `${Date.now()} ${process.pid}` } : { ...marked, linked: new Map(marked.linked).set(linked.mod, linked.at) }))
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
  while (ownLocks.has(path)) {
    if (cancel?.aborted) return undefined
    await Bun.sleep(lockPollMs)
  }
  ownLocks.add(path)
  let isTaken = false
  try {
    isTaken = await placeOnceFree(path, cancel)
  } finally {
    if (!isTaken) ownLocks.delete(path)
  }
  if (!isTaken) return undefined
  const holder = join(path, String(process.pid))
  return {
    async [Symbol.asyncDispose]() {
      try {
        await rm(holder)
        await rmdir(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
        })
      } finally {
        ownLocks.delete(path)
      }
    },
  }
}

async function placeOnceFree(path: string, cancel: AbortSignal | undefined): Promise<boolean> {
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
      const started = await readText(join(path, holder))
      if (started === undefined) continue
      if (await isHolding(Number(holder), started)) live.push(holder)
      else await rm(join(path, holder), { force: true })
    }
    if (live.length === 0) continue
    if (cancel?.aborted) return false
    if (Date.now() >= noticeAt) {
      noticeAt = Number.POSITIVE_INFINITY
      const resumeProgress = interruptProgress()
      process.stderr.write(`Waiting for ${tilde(path)}, which process ${live.join(', ')} holds.\n`)
      resumeProgress()
    }
    await Bun.sleep(lockPollMs)
  }
  return true
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
  if (value === undefined || !isSealed(value)) return value
  return (await changeSecretsFile(() => undefined))[mod]?.[key]
}

export async function storeSecret(mod: string, key: string, value: string): Promise<void> {
  await changeSecretsFile((all) => {
    all[mod] = Object.assign(all[mod] ?? Object.create(null), { [key]: value })
  })
}

export async function deleteSecrets(mod: string, keys?: readonly string[]): Promise<void> {
  await changeSecretsFile((all) => {
    const secrets = all[mod]
    if (secrets === undefined) return
    for (const key of keys ?? Object.keys(secrets)) delete secrets[key]
    if (Object.keys(secrets).length === 0) delete all[mod]
  })
}

async function changeSecretsFile(change: (all: Record<string, Secrets>) => void): Promise<Record<string, Secrets>> {
  const lock = await takeLock(storePath('secrets.json.lock'))
  try {
    const all = await readSecretsFile()
    const before = JSON.stringify(all)
    change(all)
    await unsealSecrets(all)
    if (JSON.stringify(all) !== before) await writeSecretsFile(all)
    return all
  } finally {
    await lock[Symbol.asyncDispose]()
  }
}

async function unsealSecrets(all: Record<string, Secrets>): Promise<void> {
  let safeKey: Promise<Buffer | undefined> | undefined
  for (const [mod, secrets] of Object.entries(all)) {
    for (const [key, value] of Object.entries(secrets)) {
      if (!isSealed(value)) continue
      const where = `The secret ${key} of ${mod} in ${tilde(secretsPath())}, which an older cmod sealed,`
      const fix = `Store it again, or delete it with cmod secrets delete ${mod} ${key}.`
      const opened = await (safeKey ??= readSafeStorageKey())
      if (opened === undefined) throw new Error(`${where} needs the ${safeStorage} item in your login keychain to open, and there is none. ${fix}`)
      secrets[key] = unseal(value, opened, `${where} does not open with the ${safeStorage} key in your login keychain. ${fix}`)
    }
  }
}

function loginKeychain(): string {
  return join(home(), 'Library', 'Keychains', 'login.keychain-db')
}

async function readSafeStorageKey(): Promise<Buffer | undefined> {
  if (!existsSync(loginKeychain())) return undefined
  const found = await capture([security, 'find-generic-password', '-s', safeStorage, '-a', safeStorageAccount, '-w', loginKeychain()])
  if (found.exitCode === itemNotFound) return undefined
  if (found.exitCode !== 0) throw new Error(`Your login keychain refused cmod its ${safeStorage} key, which opens the secrets an older cmod sealed: ${found.stderr.trim().split('\n').at(-1) ?? ''}`)
  const key = Buffer.from(found.stdout.trim(), 'base64')
  if (key.length !== 32) throw new Error(`The ${safeStorage} item in your login keychain holds no 32-byte key, so cmod opens none of the secrets an older cmod sealed. Store each of them again.`)
  return key
}

function isSealed(value: string): boolean {
  const sealed = Buffer.from(value, 'base64')
  return sealed.length >= sealedVersion.length + 12 + 16 && sealed.subarray(0, sealedVersion.length).toString() === sealedVersion && sealed.toString('base64') === value
}

function unseal(value: string, key: Buffer, failure: string): string {
  const sealed = Buffer.from(value, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(sealedVersion.length, sealedVersion.length + 12))
  decipher.setAuthTag(sealed.subarray(-16))
  try {
    return Buffer.concat([decipher.update(sealed.subarray(sealedVersion.length + 12, -16)), decipher.final()]).toString('utf8')
  } catch (error) {
    throw new Error(failure, { cause: error })
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
