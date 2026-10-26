import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readdir, rm, utimes } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { buildFailuresPath, isAtLeast, readCmodVersion, storeFolder } from '@cmodjs/core/src/records.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { version } from '../../package.json'
import { relinkPluginFolders } from '../claude.js'
import { ifMissing, readJson, writeAtomically } from '../files.js'
import { capture } from '../process.js'
import { linkedFolders } from '../settings.js'
import { markPluginsChanged, markStoreChanged, storePath, takeLock } from '../store.js'
import { bundledHooks } from './publish.js'

export const summary = 'Reload every session once a linked mod builds after a change.'

export const help = `Usage: cmod watch

${summary}

Watches each folder cmod link linked. Once a folder has had no change for 2
seconds and its hooks module builds, every session reloads its mods once. A
change only to files git ignores, such as the .claude-plugin/types/ Claude Code
writes each time it loads the mod, reloads nothing. A build that still fails after 10 seconds without a change shows its error in
every session. At its start it builds again each mod an earlier cmod watch
left failing, so a failure an older cmod wrote goes once the mod builds. One cmod
watch watches per machine: another one exits at once while it runs. It touches
its file in watch.lock every 5 seconds, and the cmod plugin of each session
with a linked mod starts cmod watch again once that file is gone or 15 seconds
old. Before each touch it reads the newest cmod installed in the cmod store,
and a cmod watch older than that exits and lets go of watch.lock, so the newer
cmod watches with its own rules. At its start it links each folder still in
CLAUDE_CODE_PLUGIN_DIRS, which a cmod before 4.1.0 linked, as cmod link does
now, and takes it out of that list.`

const settleMs = 2000

const failMs = 10000

const pollMs = 5000

const skipped = new Set(['node_modules', '.git'])

async function isAnySource(folder: string, files: readonly string[]): Promise<boolean> {
  if (files.length === 0 || files.includes('')) return true
  const checked = await capture(['git', '-C', folder, 'check-ignore', '--stdin'], { stdin: { text: `${files.join('\n')}\n` } }).catch((error: unknown) => {
    process.stderr.write(`cmod watch: reloads for every change in ${folder}, because git could not say which files it ignores: ${messageOf(error)}\n`)
    return undefined
  })
  if (checked === undefined || checked.exitCode > 1) return true
  const ignored = new Set(checked.stdout.split('\n'))
  return files.some((file) => !ignored.has(file))
}

export async function run(argv: string[]): Promise<number> {
  if (argv.length > 0) throw new Error(`cmod watch takes no arguments.\n\n${help}`)
  const lock = storePath('watch.lock')
  await using held = await takeLock(lock, AbortSignal.abort())
  if (held === undefined) return 0
  const heartbeat = join(lock, String(process.pid))
  await relinkPluginFolders()
  const watchers = new Map<string, FSWatcher>()
  const timers = new Map<string, Timer>()
  const changedFiles = new Map<string, Set<string>>()
  const failures = new Map(Object.entries(((await readJson(buildFailuresPath(storeFolder(process.env)))) ?? {}) as Record<string, string>))

  const writeFailures = async () => {
    const path = buildFailuresPath(storeFolder(process.env))
    if (failures.size === 0) await rm(path, { force: true })
    else await writeAtomically(path, `${JSON.stringify(Object.fromEntries(failures), null, 2)}\n`)
    await markStoreChanged()
  }

  const nameOf = async (folder: string) => ((await readJson(join(folder, '.claude-plugin', 'plugin.json'))) as { readonly name: string }).name

  const isOutdated = async () => {
    const installed = await readCmodVersion({ list: (folder) => readdir(folder).catch(ifMissing([])), exists: async (path) => existsSync(path) }, storeFolder(process.env))
    return installed !== undefined && !isAtLeast(version, installed)
  }

  const settle = async (folder: string) => {
    const files = [...(changedFiles.get(folder) ?? [])]
    changedFiles.delete(folder)
    if (!(await isAnySource(folder, files))) return
    const name = await nameOf(folder)
    try {
      await bundledHooks(folder)
    } catch (error) {
      timers.set(
        folder,
        setTimeout(() => {
          failures.set(name, messageOf(error))
          void writeFailures()
        }, failMs - settleMs),
      )
      return
    }
    if (failures.delete(name)) await writeFailures()
    await markPluginsChanged()
  }

  const changed = (folder: string, file: string | null) => {
    if (file !== null && file.split(sep).some((part) => skipped.has(part))) return
    changedFiles.set(folder, (changedFiles.get(folder) ?? new Set()).add(file ?? ''))
    clearTimeout(timers.get(folder))
    timers.set(folder, setTimeout(() => void settle(folder), settleMs))
  }

  const follow = async () => {
    const folders = await linkedFolders()
    for (const [folder, watcher] of watchers) {
      if (folders.includes(folder)) continue
      watcher.close()
      watchers.delete(folder)
    }
    for (const folder of folders) {
      if (watchers.has(folder)) continue
      try {
        watchers.set(folder, watch(folder, { recursive: true }, (_event, file) => changed(folder, file)))
      } catch (error) {
        process.stderr.write(`cmod watch: ${folder} is not watched: ${messageOf(error)}\n`)
        continue
      }
      if (failures.has(await nameOf(folder))) changed(folder, null)
    }
  }

  while (!(await isOutdated())) {
    await follow().catch((error: unknown) => process.stderr.write(`cmod watch: kept the folders it watches: ${messageOf(error)}\n`))
    const now = new Date()
    await utimes(heartbeat, now, now)
    await Bun.sleep(pollMs)
  }
  for (const watcher of watchers.values()) watcher.close()
  for (const timer of timers.values()) clearTimeout(timer)
  return 0
}
