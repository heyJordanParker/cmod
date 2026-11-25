import { existsSync, watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { ifMissing } from './files.js'

export type Stamp = { readonly modifiedMs: number; readonly size: number }

export type Observed = ReadonlyMap<string, Stamp | undefined>

export type Observer = { look(): Promise<void>; close(): void }

export const busyScanMs = 400

export const quietScanMs = 30_000

export const quietAfterMs = 60_000

export type Observing = {
  readonly folders: () => readonly string[]
  readonly isRecursive: boolean
  readonly list: () => Promise<readonly string[]>
  readonly onChange: (changed: Observed) => void
  readonly report: (error: unknown) => void
}

export function observe({ folders, isRecursive, list, onChange, report }: Observing): Observer {
  const watchers = new Map<string, FSWatcher>()
  let stamps: ReadonlyMap<string, Stamp> | undefined
  let changedAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let scanning: Promise<void> | undefined
  let due: Promise<void> | undefined
  let isClosed = false

  const hint = () => {
    const wanted = new Set(folders())
    for (const [folder, watcher] of watchers) {
      if (wanted.has(folder)) continue
      watcher.close()
      watchers.delete(folder)
    }
    for (const folder of wanted) {
      if (watchers.has(folder) || !existsSync(folder)) continue
      try {
        const watcher = watch(folder, { recursive: isRecursive }, () => void observer.look())
        watcher.on('error', () => {
          watcher.close()
          watchers.delete(folder)
        })
        watchers.set(folder, watcher)
      } catch (error) {
        report(error)
      }
    }
  }

  const scan = async () => {
    hint()
    const listed = await list()
    const found = new Map((await Promise.all(listed.map(async (path) => [path, await stat(path).catch(ifMissing(undefined))] as const))).flatMap(([path, info]) => (info === undefined ? [] : [[path, { modifiedMs: Math.trunc(info.mtimeMs), size: info.size }] as const])))
    const before = stamps
    stamps = found
    if (before === undefined) return
    const changed = new Map<string, Stamp | undefined>()
    for (const [path, now] of found) {
      const was = before.get(path)
      if (was?.modifiedMs !== now.modifiedMs || was.size !== now.size) changed.set(path, now)
    }
    for (const path of before.keys()) if (!found.has(path)) changed.set(path, undefined)
    if (changed.size === 0) return
    changedAt = Date.now()
    onChange(changed)
  }

  const next = () => {
    clearTimeout(timer)
    if (isClosed) return
    timer = setTimeout(() => void observer.look(), Date.now() - changedAt < quietAfterMs ? busyScanMs : quietScanMs)
  }

  const look = (): Promise<void> => {
    if (isClosed) return Promise.resolve()
    if (scanning !== undefined)
      return (due ??= scanning.then(() => {
        due = undefined
        return look()
      }))
    clearTimeout(timer)
    scanning = scan()
      .catch(report)
      .finally(() => {
        scanning = undefined
        if (due === undefined) next()
      })
    return scanning
  }

  const observer: Observer = {
    look,
    close() {
      isClosed = true
      clearTimeout(timer)
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    },
  }
  void observer.look()
  return observer
}
