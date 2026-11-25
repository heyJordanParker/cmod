import { existsSync } from 'node:fs'
import { readdir, rm, utimes } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { buildFailuresPath, storeFolder } from '@cmodjs/core/src/records.js'
import { relativePath } from '@cmodjs/core/src/utils/paths.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { hearServe } from '@cmodjs/core/src/runtime/bun.js'
import { listeningOf, storeInterface } from '@cmodjs/core/src/runtime/interfaces.js'
import { relinkPluginFolders } from '../claude.js'
import { readJson, writeAtomically } from '../files.js'
import { observe, type Observed, type Observer } from '../observer.js'
import { readPlugin } from '../plugin.js'
import { capture } from '../process.js'
import { buildReadsAny, installProgram, readProgram } from '../program.js'
import { startProgress } from '../progress.js'
import { linkedFolders } from '../settings.js'
import { isNewerCmodInstalled, markPluginsChanged, markStoreChanged, storePath, takeLock } from '../store.js'
import { bundledHooks } from './publish.js'

export const summary = 'Build each linked mod after a change, so every session running the old build offers Reload.'

export const help = `Usage: cmod watch

${summary}

Watches each folder cmod link linked: each file git lists in it, or each file
outside node_modules and .git when it is no git repository. It compares each
file's modification time and size with its last look whenever a file event
hints at a change, and every 400 ms for a minute after a change, then every 30
seconds, because macOS drops file events under load. Once the folder has been
quiet for 2 seconds, it bundles the hooks module of a folder whose file
changed. When a changed file is one the program's
build reads, a file in cli/ or one its JavaScript or TypeScript entry imports,
it also builds the program cli/ declares, as cmod link does, into cmod's
programs folder, then stops the program's running copy, so the next one starts
the new build. A build that writes the same program leaves the file and its running
copy as they are. Once both build, it writes the
time of the mod's last change to plugins-changed, and each session that has not
started the mod since offers Reload, 35 seconds after the change and between
turns. A session started with claude --plugin-dir <folder> reloads the mod by
itself between turns within that time, so it offers nothing for it. A change only to files git ignores, such as the
.claude-plugin/types/ Claude Code writes each time it loads the mod, to the
program's output folder, or to a file gone by then that git does not track,
such as a build's temporary file, offers nothing. A build that still fails
after 10 seconds without a change shows its error in every session, and the
last program that built keeps running. At its start it builds again each mod an earlier cmod watch
left failing, so a failure an older cmod wrote goes once the mod builds. One cmod
watch watches per device: another one exits at once while it runs. It touches
its file in watch.lock every 5 seconds, and the cmod plugin of each session
with a linked mod starts cmod watch again once that file is gone or 15 seconds
old. At its start, each time it connects to cmod serve, and each time
cmod/Store tells that the linked mods or the plugins changed, it reads the
linked folders and the newest cmod installed in the cmod store, and a cmod
watch older than that exits and lets go of watch.lock, so the newer cmod
watches with its own rules. It also exits once the process that started
it ends, so a session that crashed leaves no watcher behind. At its start it links each folder still in
CLAUDE_CODE_PLUGIN_DIRS, which a cmod before 4.1.0 linked, as cmod link does
now, and takes it out of that list.`

const settleMs = 2000

const failMs = 10000

const pollMs = 5000

const skipped = new Set(['node_modules', '.git'])

async function filesIn(folder: string, under = ''): Promise<string[]> {
  const entries = await readdir(join(folder, under), { withFileTypes: true })
  const found = await Promise.all(
    entries.map((entry) => {
      const path = under === '' ? entry.name : `${under}/${entry.name}`
      if (entry.isDirectory()) return skipped.has(entry.name) ? [] : filesIn(folder, path)
      return entry.isFile() ? [path] : []
    }),
  )
  return found.flat()
}

async function gitFiles(folder: string, ...listed: readonly string[]): Promise<string[] | undefined> {
  const found = await capture(['git', '-C', folder, 'ls-files', '-z', ...listed])
  if (found.exitCode !== 0) return undefined
  return found.stdout.split('\0').filter((file) => file !== '' && !file.split('/').some((part) => skipped.has(part)))
}

export async function checkoutFiles(folder: string): Promise<string[]> {
  return (await gitFiles(folder, '--cached', '--others', '--exclude-standard')) ?? filesIn(folder)
}

export function changesOf(folder: string, observed: Observed): Map<string, number> {
  return new Map([...observed].map(([path, stamp]) => [relative(folder, path), stamp?.modifiedMs ?? Date.now()]))
}

export async function withoutIgnored(folder: string, files: readonly string[]): Promise<string[]> {
  if (files.length === 0) return []
  const checked = await capture(['git', '-C', folder, 'check-ignore', '--stdin'], { stdin: { text: `${files.join('\n')}\n` } })
  if (checked.exitCode > 1) return [...files]
  const ignored = new Set(checked.stdout.split('\n'))
  return files.filter((file) => !ignored.has(file))
}

const nameOf = async (folder: string) => ((await readJson(join(folder, '.claude-plugin', 'plugin.json'))) as { readonly name: string }).name

async function writeFailures(failures: ReadonlyMap<string, string>): Promise<void> {
  const path = buildFailuresPath(storeFolder(process.env))
  if (failures.size === 0) await rm(path, { force: true })
  else await writeAtomically(path, `${JSON.stringify(Object.fromEntries(failures), null, 2)}\n`)
  await markStoreChanged('buildFailures')
}

export type LinkedChanges = { changed(folder: string, files: ReadonlyMap<string, number>): void; retry(folder: string): void; settled(): Promise<void>; close(): void }

export function linkedChanges(
  failures: Map<string, string>,
  written: { failures(failures: ReadonlyMap<string, string>): Promise<void>; changed(linked: { readonly mod: string; readonly at: number }): Promise<void> },
): LinkedChanges {
  const timers = new Map<string, Timer>()
  const failing = new Set<Timer>()
  const attempts = new Map<string, number>()
  const programsDue = new Set<string>()
  const pending = new Map<string, Map<string, number>>()
  const retriedAt = new Map<string, number>()
  const settling = new Map<string, Promise<void>>()
  const progress = { ...startProgress(process.stderr), note: () => {} }

  const settle = async (folder: string) => {
    const retried = retriedAt.get(folder)
    retriedAt.delete(folder)
    const changed = pending.get(folder) ?? new Map<string, number>()
    pending.delete(folder)
    const tracked = changed.size === 0 ? undefined : await gitFiles(folder, '--cached')
    const changes = [...changed].filter(([file]) => existsSync(join(folder, file)) || tracked === undefined || tracked.includes(file))
    if (changes.length === 0 && retried === undefined) return
    const name = await nameOf(folder)
    let attempt = attempts.get(folder) ?? 0
    let at = 0
    try {
      const plugin = await readPlugin(folder)
      const program = await readProgram(plugin)
      const output = program === undefined ? undefined : relative(plugin.root, resolve(program.folder, program.output))
      const sources = changes.filter(([file]) => output === undefined || relativePath(output, file) === undefined)
      if (sources.length === 0 && retried === undefined) return
      at = Math.max(...sources.map(([, changedAt]) => changedAt), ...(retried === undefined ? [] : [retried]))
      attempt += 1
      attempts.set(folder, attempt)
      if (program !== undefined && (retried !== undefined || (await buildReadsAny(program, sources.map(([file]) => join(plugin.root, file)))))) programsDue.add(folder)
      await bundledHooks(folder)
      if (program !== undefined && programsDue.has(folder)) {
        await installProgram(program, plugin.version, progress)
        programsDue.delete(folder)
      }
    } catch (error) {
      const timer = setTimeout(() => {
        failing.delete(timer)
        if (attempts.get(folder) !== attempt) return
        failures.set(name, messageOf(error))
        void written.failures(failures)
      }, failMs - settleMs)
      failing.add(timer)
      return
    }
    if (failures.delete(name)) await written.failures(failures)
    await written.changed({ mod: name, at })
  }

  const settleSoon = (folder: string) => {
    clearTimeout(timers.get(folder))
    timers.set(
      folder,
      setTimeout(() => {
        const next = () => settle(folder)
        settling.set(folder, (settling.get(folder) ?? Promise.resolve()).then(next, next))
      }, settleMs),
    )
  }

  return {
    changed: (folder, files) => {
      const known = pending.get(folder) ?? new Map<string, number>()
      for (const [file, at] of files) known.set(file, at)
      pending.set(folder, known)
      settleSoon(folder)
    },
    retry: (folder) => {
      retriedAt.set(folder, Date.now())
      settleSoon(folder)
    },
    settled: async () => {
      await Promise.all(settling.values())
    },
    close: () => {
      for (const timer of [...timers.values(), ...failing]) clearTimeout(timer)
    },
  }
}

export async function pollWhile(isCurrent: () => Promise<boolean>, poll: () => Promise<void>): Promise<void> {
  while (await isCurrent()) {
    await poll()
    await Bun.sleep(pollMs)
  }
}

export async function run(argv: string[]): Promise<number> {
  if (argv.length > 0) throw new Error(`cmod watch takes no arguments.\n\n${help}`)
  const parent = process.ppid
  const lock = storePath('watch.lock')
  await using held = await takeLock(lock, AbortSignal.abort())
  if (held === undefined) return 0
  const heartbeat = join(lock, String(process.pid))
  await relinkPluginFolders()
  const observers = new Map<string, Observer>()
  const failures = new Map(Object.entries(((await readJson(buildFailuresPath(storeFolder(process.env)))) ?? {}) as Record<string, string>))
  const changes = linkedChanges(failures, { failures: writeFailures, changed: markPluginsChanged })
  let watched: string | undefined

  const follow = async () => {
    const folders = await linkedFolders()
    for (const [folder, observer] of observers) {
      if (folders.includes(folder)) continue
      observer.close()
      observers.delete(folder)
    }
    for (const folder of folders) {
      if (observers.has(folder)) continue
      let listed: { readonly at: number; readonly files: Promise<string[]> } | undefined
      const list = async () => {
        if (listed === undefined || Date.now() - listed.at >= settleMs) listed = { at: Date.now(), files: checkoutFiles(folder) }
        return (await listed.files).map((file) => join(folder, file))
      }
      const observer = observe({ folders: () => [folder], isRecursive: true, list, onChange: (observed) => changes.changed(folder, changesOf(folder, observed)), report: (error) => void process.stderr.write(`cmod watch: missed a change in ${folder}: ${messageOf(error)}\n`) })
      observers.set(folder, observer)
      await observer.look()
      if (failures.has(await nameOf(folder))) changes.retry(folder)
    }
    const now = folders.toSorted().join(', ')
    if (now !== watched) process.stderr.write(`cmod watch: watching ${now === '' ? 'no linked checkout' : now}\n`)
    watched = now
  }

  let isNewer = false
  let checking = Promise.resolve()
  const check = () =>
    void (checking = checking
      .then(async () => {
        if (await isNewerCmodInstalled()) isNewer = true
        else await follow()
      })
      .catch((error: unknown) => void process.stderr.write(`cmod watch: kept the folders it watches: ${messageOf(error)}\n`)))
  check()
  await checking
  const serve = hearServe([listeningOf(storeInterface, 'on', 'Change', [], { part: ['links', 'plugins'] })], check, (error) => void process.stderr.write(`cmod watch: hears no change of the linked mods from cmod serve: ${messageOf(error)}\n`))
  try {
    await pollWhile(
      async () => process.ppid === parent && !isNewer,
      async () => {
        const now = new Date()
        await utimes(heartbeat, now, now)
      },
    )
    return 0
  } finally {
    await serve.close()
    for (const observer of observers.values()) observer.close()
    changes.close()
  }
}
