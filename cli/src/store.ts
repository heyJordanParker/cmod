import { mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isObject, recordPath, storeFolder } from 'cmod-sdk/src/records.js'
import { readJson, readText, tilde, writeAtomically } from './files.js'
import { capture } from './process.js'
import { interruptProgress } from './progress.js'

const lockNoticeMs = 3000

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

export function modLock(name: string): string {
  return `${recordPath(storeFolder(process.env), name)}.lock`
}

export async function takeLock(path: string, cancel: AbortSignal): Promise<AsyncDisposable | undefined> {
  await mkdir(dirname(path), { recursive: true })
  const started = await startTime(process.pid)
  let noticeAt = Date.now() + lockNoticeMs
  while (!(await placeLock(path, started))) {
    const holders = await readdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const live: string[] = []
    for (const holder of holders) {
      const holderStarted = await startTime(Number(holder))
      if (holderStarted !== '' && (await readText(join(path, holder))) === holderStarted) live.push(holder)
      else await rm(join(path, holder), { force: true })
    }
    if (live.length === 0) continue
    if (cancel.aborted) return undefined
    if (Date.now() >= noticeAt) {
      noticeAt = Number.POSITIVE_INFINITY
      interruptProgress()
      process.stderr.write(`Waiting for ${tilde(path)}, which process ${live.join(', ')} holds.\n`)
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

async function startTime(processId: number): Promise<string> {
  const { stdout } = await capture(['ps', '-o', 'lstart=', '-p', String(processId)], { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } })
  return stdout.trim()
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

export async function revokeApprovals(name: string, sha256?: string): Promise<void> {
  await changeConsent((consent) => {
    if (!Object.hasOwn(consent, name)) return false
    const kept = (consent[name] ?? []).filter((approved) => sha256 !== undefined && approved !== sha256)
    if (kept.length > 0) consent[name] = kept
    else delete consent[name]
    return true
  })
}

async function changeConsent(change: (consent: Record<string, string[]>) => boolean): Promise<void> {
  const lock = await takeLock(storePath('consent.json.lock'), new AbortController().signal)
  try {
    const consent = await readConsent()
    if (change(consent)) await writeAtomically(storePath('consent.json'), `${JSON.stringify(consent, null, 2)}\n`)
  } finally {
    await lock?.[Symbol.asyncDispose]()
  }
}

async function readConsent(): Promise<Record<string, string[]>> {
  const path = storePath('consent.json')
  const value = await readJson(path)
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error(`${path} is not a map of plugin names to approved hashes. Delete it, and CMod asks again.`)
  return value as Record<string, string[]>
}
