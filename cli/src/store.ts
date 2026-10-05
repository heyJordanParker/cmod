import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isObject, storeFolder } from 'cmod-sdk/src/records.js'
import { readJson, writeAtomically } from './files.js'

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

export async function isApproved(name: string, sha256: string): Promise<boolean> {
  return (await readConsent())[name]?.includes(sha256) ?? false
}

export async function approve(name: string, sha256: string): Promise<void> {
  const consent = await readConsent()
  const approved = consent[name] ?? []
  if (approved.includes(sha256)) return
  consent[name] = [...approved, sha256]
  await writeConsent(consent)
}

export async function revokeApprovals(name: string): Promise<void> {
  const consent = await readConsent()
  if (!Object.hasOwn(consent, name)) return
  delete consent[name]
  await writeConsent(consent)
}

async function writeConsent(consent: Record<string, string[]>): Promise<void> {
  await writeAtomically(storePath('consent.json'), `${JSON.stringify(consent, null, 2)}\n`)
}

async function readConsent(): Promise<Record<string, string[]>> {
  const path = storePath('consent.json')
  const value = await readJson(path)
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error(`${path} is not a map of plugin names to approved hashes. Delete it, and CMod asks again.`)
  return value as Record<string, string[]>
}
