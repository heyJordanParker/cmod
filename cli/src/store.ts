import { mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isObject, storeFolder } from 'cmod-sdk/src/records.js'
import { readJson, tilde, writeAtomically } from './files.js'

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

export async function takeLock(path: string, cancel: AbortSignal): Promise<AsyncDisposable | undefined> {
  await mkdir(dirname(path), { recursive: true })
  for (let hasWaited = false; !(await placeLock(path)); ) {
    const holders = await readdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const gone = holders.filter((holder) => !isRunning(Number(holder)))
    for (const holder of gone) await rm(join(path, holder), { force: true })
    if (gone.length === holders.length) continue
    if (hasWaited && cancel.aborted) return undefined
    hasWaited = true
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

async function placeLock(path: string): Promise<boolean> {
  const staged = `${path}.${process.pid}.tmp`
  await mkdir(staged, { recursive: true })
  await writeFile(join(staged, String(process.pid)), '')
  return rename(staged, path).then(
    () => true,
    async (error: NodeJS.ErrnoException) => {
      await rm(staged, { recursive: true })
      if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') return false
      throw error
    },
  )
}

function isRunning(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    if (code !== 'ESRCH' && code !== 'EPERM') throw error
    return code === 'EPERM'
  }
}

export async function isApproved(name: string, sha256: string): Promise<boolean> {
  return (await readConsent())[name]?.includes(sha256) ?? false
}

export async function approve(name: string, sha256: string, cancel: AbortSignal): Promise<void> {
  await changeConsent(cancel, (consent) => {
    const approved = consent[name] ?? []
    if (approved.includes(sha256)) return false
    consent[name] = [...approved, sha256]
    return true
  })
}

export async function revokeApprovals(name: string, cancel: AbortSignal): Promise<void> {
  await changeConsent(cancel, (consent) => {
    if (!Object.hasOwn(consent, name)) return false
    delete consent[name]
    return true
  })
}

async function changeConsent(cancel: AbortSignal, change: (consent: Record<string, string[]>) => boolean): Promise<void> {
  const path = storePath('consent.json.lock')
  await using lock = await takeLock(path, cancel)
  if (lock === undefined) throw new Error(`A running cmod command holds ${tilde(path)}, and a signal stopped the wait for it. Run the command again.`)
  const consent = await readConsent()
  if (change(consent)) await writeAtomically(storePath('consent.json'), `${JSON.stringify(consent, null, 2)}\n`)
}

async function readConsent(): Promise<Record<string, string[]>> {
  const path = storePath('consent.json')
  const value = await readJson(path)
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error(`${path} is not a map of plugin names to approved hashes. Delete it, and CMod asks again.`)
  return value as Record<string, string[]>
}
