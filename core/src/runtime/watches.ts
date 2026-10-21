import type { FileChange } from '../mod.js'
import { ifMissing } from '../utils/paths.js'
import type { Subscription } from '../utils/subscription.js'
import type { Claude } from './claude.js'
import type { Failure } from './toaster.js'

export type Watches = { add(paths: readonly string[], listener: (change: FileChange) => unknown): Subscription }

type Watch = { readonly paths: readonly string[]; readonly listener: (change: FileChange) => unknown; seen: ReadonlyMap<string, number> | undefined }

const watchMs = 500

const watchedFiles = 2000

export function createWatches(claude: Claude, report: (failure: Failure) => void): Watches {
  const watches = new Set<Watch>()
  let polling: { cancel(): void } | undefined
  let isPolling = false
  const stampsOf = async (paths: readonly string[]): Promise<Map<string, number>> => {
    const stamps = new Map<string, number>()
    const visit = async (path: string): Promise<void> => {
      const stat = await claude.fs.stat(path).catch(ifMissing(undefined))
      if (stat === undefined) return
      if (stat.kind !== 'dir') {
        if (stamps.size === watchedFiles) throw new Error(`fs.onChange watches at most ${watchedFiles} files, and ${paths.join(', ')} holds more, so it stopped. Watch a smaller folder.`)
        return void stamps.set(path, stat.mtimeMs)
      }
      for (const entry of await claude.fs.list(path).catch(ifMissing([]))) await visit(`${path}/${entry.name}`)
    }
    for (const path of paths) await visit(path)
    return stamps
  }
  const stop = (watch: Watch) => {
    watches.delete(watch)
    if (watches.size > 0) return
    polling?.cancel()
    polling = undefined
  }
  const stampsOrStop = (watch: Watch) =>
    stampsOf(watch.paths).catch((error: unknown) => {
      stop(watch)
      report({ id: 'fs:onChange', message: 'Could not read the files fs.onChange watches', error })
      return undefined
    })
  const poll = async () => {
    if (isPolling) return
    isPolling = true
    try {
      for (const watch of watches) {
        const now = await stampsOrStop(watch)
        if (now === undefined) continue
        const before = watch.seen
        watch.seen = now
        if (before === undefined) continue
        const changes: FileChange[] = [
          ...[...now].filter(([path, at]) => before.has(path) && before.get(path) !== at).map(([path]): FileChange => ({ path, type: 'change' })),
          ...[...now.keys()].filter((path) => !before.has(path)).map((path): FileChange => ({ path, type: 'add' })),
          ...[...before.keys()].filter((path) => !now.has(path)).map((path): FileChange => ({ path, type: 'unlink' })),
        ]
        for (const change of changes) await Promise.resolve().then(() => watch.listener(change)).catch((error: unknown) => report({ id: 'fs:onChange', message: 'The fs.onChange listener failed', error }))
      }
    } finally {
      isPolling = false
    }
  }
  return {
    add(paths, listener) {
      const watch: Watch = { paths, listener, seen: undefined }
      watches.add(watch)
      void stampsOrStop(watch).then((stamps) => void (watch.seen ??= stamps))
      polling ??= claude.clock.every(watchMs, () => void poll())
      return { remove: () => stop(watch) }
    },
  }
}
