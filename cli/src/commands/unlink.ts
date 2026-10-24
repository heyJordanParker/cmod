import { parseArgs } from 'node:util'
import { readRecord, storeFolder } from '@cmodjs/core/src/records.js'
import { unlinkPlugin } from '../claude.js'
import { readText, tilde } from '../files.js'
import { readPlugin } from '../plugin.js'
import { readProgram, removeProgram } from '../program.js'
import { startProgress } from '../progress.js'
import { holdSignals } from './setup.js'
import { teardownInTerminal } from './teardown.js'

export const summary = 'Stop loading a linked checkout.'

export const help = `Usage: cmod unlink [path]

${summary}

Stops loading the checkout at path (default: the current folder) in every
Claude Code session. Uninstalls it through Claude Code and takes it out of the
marketplace cmod keeps in its parent folder, removing that marketplace with the
cmod plugin it lists once it lists no checkout. Turns the installed copy of the
mod that cmod link turned off back on, runs the checkout's uninstall step, and
removes the program cmod link built, with its links.`

export async function run(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} })
  if (positionals.length > 1) throw new Error(`cmod unlink takes at most one path.\n\n${help}`)
  const plugin = await readPlugin(positionals[0] ?? '.')
  const progress = startProgress()

  if (!(await unlinkPlugin(plugin))) throw new Error(`${tilde(plugin.root)} is not linked. cmod link links it.`)
  progress.succeed(`Unlinked ${tilde(plugin.root)}`)

  const hold = holdSignals()
  try {
    const record = await readRecord(readText, storeFolder(process.env), plugin.name)
    const exitCode = record === undefined || record.root !== plugin.root ? 0 : await teardownInTerminal(plugin.name, progress)

    const program = await readProgram(plugin)
    if (program !== undefined && (await removeProgram(program.name))) progress.succeed(`Removed the program ${program.name}`)
    return exitCode
  } finally {
    hold[Symbol.dispose]()
  }
}
