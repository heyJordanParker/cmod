import { parseArgs } from 'node:util'
import { readRecord, storeFolder } from '@cmodjs/core/src/records.js'
import { changePlugin, listPlugins } from '../claude.js'
import { readText } from '../files.js'
import { startProgress } from '../progress.js'
import { teardownInTerminal } from './teardown.js'

export const summary = "Uninstall any plugin through Claude Code, and run a mod's uninstall step."

export const help = `Usage: cmod remove <name>

${summary}

Uninstalls the plugin through Claude Code. When cmod set the plugin up as a
mod, then runs the uninstall step cmod saved and removes what cmod set up.`

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
  return record === undefined ? 0 : teardownInTerminal(pluginName, progress)
}
