import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isObject, storeFolder } from 'cmod-sdk/src/records.js'
import { readJson, writeAtomically } from './files.js'

export const abandonedClaimMs = 600_000

export function storePath(...parts: string[]): string {
  return join(storeFolder(process.env), ...parts)
}

export async function recordNames(): Promise<string[]> {
  const entries = await readdir(storePath('records')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  return entries.filter((entry) => entry.endsWith('.json')).map((entry) => entry.slice(0, -'.json'.length)).sort()
}

export async function takeLock(path: string, isCancelled: () => boolean = () => false): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  while (!isCancelled()) {
    const isLocked = await writeFile(path, '', { flag: 'wx' }).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return false
        throw error
      },
    )
    if (isLocked) return true
    const lockedAt = (await stat(path).catch(() => undefined))?.mtimeMs
    if (lockedAt !== undefined && Date.now() - lockedAt > abandonedClaimMs) await rm(path, { force: true })
    else await Bun.sleep(100)
  }
  return false
}

export async function isApproved(name: string, sha256: string): Promise<boolean> {
  return (await readConsent())[name]?.includes(sha256) ?? false
}

export async function approve(name: string, sha256: string): Promise<void> {
  await changeConsent((consent) => {
    const approved = consent[name] ?? []
    if (approved.includes(sha256)) return false
    consent[name] = [...approved, sha256]
    return true
  })
}

export async function revokeApprovals(name: string): Promise<void> {
  await changeConsent((consent) => {
    if (!Object.hasOwn(consent, name)) return false
    delete consent[name]
    return true
  })
}

async function changeConsent(change: (consent: Record<string, string[]>) => boolean): Promise<void> {
  const lock = storePath('consent.json.lock')
  await takeLock(lock)
  try {
    const consent = await readConsent()
    if (change(consent)) await writeAtomically(storePath('consent.json'), `${JSON.stringify(consent, null, 2)}\n`)
  } finally {
    await rm(lock, { force: true })
  }
}

async function readConsent(): Promise<Record<string, string[]>> {
  const path = storePath('consent.json')
  const value = await readJson(path)
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error(`${path} is not a map of plugin names to approved hashes. Delete it, and CMod asks again.`)
  return value as Record<string, string[]>
}
