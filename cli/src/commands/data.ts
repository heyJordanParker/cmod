import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { dataFolder, storeFolder } from '@cmodjs/core/src/records.js'
import { cmodPluginName } from '@cmodjs/core/src/runtime/dependencies.js'
import { recordNames } from '../store.js'

export const summary = 'Print the data folder of each mod cmod set up.'

export const help = `Usage: cmod data [--json]

${summary}

Prints one line for each mod cmod set up whose data folder exists: the mod's
name, a space, and the folder its mod.dataFolder names. The cmod plugin's own
data folder is listed too, because it holds each session's goal, tasks, and
Log. The data folder holds what the mod cannot rebuild. Its cache folder,
mod.cacheFolder, holds what it can, so cmod data leaves it out.

Options:
  --json  Print a list of { "mod": <name>, "folder": <data folder> }`

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, allowPositionals: false, options: { json: { type: 'boolean', default: false } } })
  const store = storeFolder(process.env)
  const mods = [...new Set([...(await recordNames()), cmodPluginName])].sort()
  const folders = mods.map((mod) => ({ mod, folder: dataFolder(store, mod) })).filter(({ folder }) => existsSync(folder))
  process.stdout.write(values.json ? `${JSON.stringify(folders)}\n` : folders.map(({ mod, folder }) => `${mod} ${folder}\n`).join(''))
  return 0
}
