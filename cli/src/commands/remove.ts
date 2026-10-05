import { parseArgs } from 'node:util'
import { readRecord, storeFolder } from 'cmod-sdk/src/records.js'
import { changePlugin, listPlugins } from '../claude.js'
import { readText } from '../files.js'
import { startProgress } from '../progress.js'
import { teardownInTerminal } from './teardown.js'

export const summary = 'Uninstall a mod through Claude Code and run its uninstall step.'

export const help = `Usage: cmod remove <name>

${summary}

Uninstalls the mod through Claude Code, then runs the uninstall step CMod saved
when it set the mod up.`

export async function run(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} })
  if (positionals.length !== 1) throw new Error(`cmod remove takes one name.\n\n${help}`)
  const name = positionals[0] as string
  const installed = (await listPlugins()).find((plugin) => plugin.name === name || plugin.id === name)
  const pluginName = installed?.name ?? name
  const record = await readRecord(readText, storeFolder(process.env), pluginName)
  if (installed === undefined && record === undefined) throw new Error(`${name} is neither installed nor set up. cmod list shows the mods.`)

  const progress = startProgress()
  if (installed !== undefined) {
    progress.step(`Uninstalling ${installed.id} from Claude Code`)
    await changePlugin('uninstall', installed.id)
    progress.succeed(`Uninstalled ${installed.id} from Claude Code`)
  }
  return record === undefined ? 0 : teardownInTerminal(pluginName, progress)
}
