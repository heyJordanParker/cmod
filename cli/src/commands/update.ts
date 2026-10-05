import { parseArgs } from 'node:util'
import { changePlugin, listPlugins } from '../claude.js'
import { isModFolder, readPlugin } from '../plugin.js'
import { startProgress } from '../progress.js'
import { setupInTerminal } from './setup.js'

export const summary = 'Update mods through Claude Code and rerun changed install steps.'

export const help = `Usage: cmod update [name] [--yes]

${summary}

Updates the named mod, or every installed mod, through Claude Code, then runs
the install step of each mod whose version or scripts changed. A running
session loads the new version after /reload-plugins.

Options:
  --yes  Approve changed install and uninstall commands without asking`

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { yes: { type: 'boolean', default: false } } })
  if (positionals.length > 1) throw new Error(`cmod update takes at most one name.\n\n${help}`)
  const name = positionals[0]
  const installed = await listPlugins()
  const mods = []
  for (const plugin of installed) {
    if ((name === undefined || plugin.name === name || plugin.id === name) && (await isModFolder(plugin.installPath))) mods.push(plugin)
  }
  if (mods.length === 0) throw new Error(name === undefined ? 'No installed mods. cmod list shows what Claude Code has.' : `No installed mod is named ${name}. cmod list shows the installed mods.`)

  const progress = startProgress()
  let exitCode = 0
  for (const mod of mods) {
    progress.step(`Updating ${mod.id}`)
    await changePlugin('update', mod.id)
    progress.succeed(`Updated ${mod.id} through Claude Code`)
    const updated = (await listPlugins()).find((plugin) => plugin.id === mod.id)
    if (updated === undefined) throw new Error(`Claude Code updated ${mod.id} but claude plugin list no longer shows it.`)
    exitCode = Math.max(exitCode, await setupInTerminal(await readPlugin(updated.installPath), { yes: values.yes }, progress))
  }
  return exitCode
}
