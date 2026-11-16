import { parseArgs } from 'node:util'
import { readRecord, storeFolder } from '@cmodjs/core/src/records.js'
import { changePlugin, listPlugins } from '../claude.js'
import { readText } from '../files.js'
import { readPlugin } from '../plugin.js'
import { startProgress } from '../progress.js'
import { installedCopyOf, setupInTerminal } from './setup.js'
import { teardownInTerminal } from './teardown.js'

export const summary = "Uninstall any plugin through Claude Code, and run a mod's uninstall step."

export const help = `Usage: cmod remove <name>

${summary}

Uninstalls the plugin through Claude Code. When cmod set the plugin up as a
mod and Claude Code still has another copy of it, such as one from another
marketplace or a linked checkout, sets that copy up, which keeps the mod's
data and secrets. When no copy is left, runs the uninstall step cmod saved and
removes what cmod set up.`

export async function run(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} })
  if (positionals.length !== 1) throw new Error(`cmod remove takes one name.\n\n${help}`)
  const name = positionals[0] as string
  const installed = (await listPlugins()).find((plugin) => plugin.name === name || plugin.id === name)
  const pluginName = installed?.name ?? name
  const record = await readRecord(readText, storeFolder(process.env), pluginName)
  if (installed === undefined && record === undefined) throw new Error(`${name} is neither installed nor set up. cmod list shows every plugin.`)

  const progress = startProgress()
  if (installed !== undefined) {
    progress.step(`Uninstalling ${installed.id} from Claude Code`)
    await changePlugin('uninstall', installed.id)
    progress.succeed(`Uninstalled ${installed.id} from Claude Code`)
  }
  if (record === undefined) return 0
  const copy = await installedCopyOf(pluginName)
  return copy === undefined ? teardownInTerminal(pluginName, progress) : setupInTerminal(await readPlugin(copy), progress)
}
