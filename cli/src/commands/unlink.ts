import { parseArgs } from 'node:util'
import { readRecord, storeFolder } from 'cmod-sdk/src/records.js'
import { readText, tilde } from '../files.js'
import { readPlugin } from '../plugin.js'
import { readProgram, removeProgram } from '../program.js'
import { startProgress } from '../progress.js'
import { removePluginFolder, settingsPath } from '../settings.js'
import { teardownInTerminal } from './teardown.js'

export const summary = 'Stop loading a linked checkout.'

export const help = `Usage: cmod unlink [path]

${summary}

Stops loading the checkout at path (default: the current folder) in new Claude
Code sessions. Removes the folder from CLAUDE_CODE_PLUGIN_DIRS in Claude Code's
settings.json, runs the checkout's uninstall step, and removes the program
cmod link built into ~/.local/bin.`

export async function run(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} })
  if (positionals.length > 1) throw new Error(`cmod unlink takes at most one path.\n\n${help}`)
  const plugin = await readPlugin(positionals[0] ?? '.')
  const progress = startProgress()

  if (!(await removePluginFolder(plugin.root))) throw new Error(`${tilde(plugin.root)} is not linked in ${tilde(settingsPath())}.`)
  progress.succeed(`Unlinked ${tilde(plugin.root)} from ${tilde(settingsPath())}`)

  const record = await readRecord(readText, storeFolder(process.env), plugin.name)
  const exitCode = record === undefined || record.root !== plugin.root ? 0 : await teardownInTerminal(plugin.name, progress)

  const program = await readProgram(plugin)
  if (program !== undefined && (await removeProgram(program.name))) progress.succeed(`Removed ${program.name} from ~/.local/bin`)
  return exitCode
}
