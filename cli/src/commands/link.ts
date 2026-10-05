import { parseArgs } from 'node:util'
import { tilde } from '../files.js'
import { preparePackages, readPlugin } from '../plugin.js'
import { installProgram, readProgram } from '../program.js'
import { startProgress } from '../progress.js'
import { addPluginFolder, settingsPath } from '../settings.js'
import { installCmodPlugin } from './install.js'
import { noteNextStep, setupInTerminal } from './setup.js'

export const summary = 'Load a checkout in every new Claude Code session.'

export const help = `Usage: cmod link [path] [--yes]

${summary}

Loads the checkout at path (default: the current folder) in every new Claude
Code session, in place of the installed mod. Writes the folder into
CLAUDE_CODE_PLUGIN_DIRS in the env block of Claude Code's settings.json,
installs the checkout's packages, builds the program cli/ declares into
~/.local/bin, installs the CMod plugin when Claude Code lacks it, and runs the
checkout's install step.

Options:
  --yes  Approve the mod's install and uninstall commands without asking`

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { yes: { type: 'boolean', default: false } } })
  if (positionals.length > 1) throw new Error(`cmod link takes at most one path.\n\n${help}`)
  const plugin = await readPlugin(positionals[0] ?? '.')
  const progress = startProgress()

  progress.step(`Installing packages for ${plugin.name}`)
  if (await preparePackages(plugin)) progress.succeed(`Installed packages for ${plugin.name}`)
  else progress.succeed(`${plugin.name} has no package.json, so it has no packages to install`)

  const program = await readProgram(plugin)
  if (program !== undefined) await installProgram(program, plugin.version, progress)

  const added = await addPluginFolder(plugin.root)
  progress.succeed(`${added ? 'Linked' : 'Already linked'} ${tilde(plugin.root)} in ${tilde(settingsPath())}`)

  await installCmodPlugin(progress)
  const code = await setupInTerminal(plugin, { yes: values.yes }, progress)
  if (code === 0) noteNextStep(plugin, progress)
  return code
}
