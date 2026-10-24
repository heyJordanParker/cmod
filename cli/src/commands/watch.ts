import { watch, type FSWatcher } from 'node:fs'
import { rm, utimes } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { buildFailuresPath, storeFolder } from '@cmodjs/core/src/records.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { relinkPluginFolders } from '../claude.js'
import { readJson, writeAtomically } from '../files.js'
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
every session. One cmod watch watches per machine: another one exits at once
while it runs. It touches its file in watch.lock every 5 seconds, and the cmod
plugin of each session with a linked mod starts cmod watch again once that file
is 15 seconds old. At its start it links each folder still in
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
  if ((await takeLock(lock, AbortSignal.abort())) === undefined) return 0
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

  const settle = async (folder: string) => {
    const files = [...(changedFiles.get(folder) ?? [])]
    changedFiles.delete(folder)
    if (!(await isAnySource(folder, files))) return
    const { name } = (await readJson(join(folder, '.claude-plugin', 'plugin.json'))) as { readonly name: string }
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
      }
    }
  }

  for (;;) {
    await follow().catch((error: unknown) => process.stderr.write(`cmod watch: kept the folders it watches: ${messageOf(error)}\n`))
    const now = new Date()
    await utimes(heartbeat, now, now)
    await Bun.sleep(pollMs)
  }
}
