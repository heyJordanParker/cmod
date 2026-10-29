import { parseArgs } from 'node:util'
import { linkPlugin } from '../claude.js'
import { tilde } from '../files.js'
import { installPackages, readPlugin } from '../plugin.js'
import { installProgram, readProgram } from '../program.js'
import { startProgress } from '../progress.js'
import { installCmodPlugin, setOptions } from './install.js'
import { setupInTerminal } from './setup.js'

export const summary = 'Load a checkout in every Claude Code session.'

export const help = `Usage: cmod link [path]

${summary}

Loads the checkout at path (default: the current folder) in every Claude Code
session, the running ones too, in place of the installed mod. Installs the
cmod plugin when Claude Code lacks it, unless the checkout is cmod itself. Then
installs the checkout's packages, builds the program cli/ declares and links it
into cmod's programs folder and ~/.local/bin, and lists the checkout in the
marketplace cmod keeps in the checkout's parent folder, at
.claude-plugin/marketplace.json beside the cmod plugin. It installs the
checkout from that marketplace through Claude Code, turns off the installed
copy of the mod, and runs the checkout's install step. cmod watch reloads
every session once a change builds.

Options:
  --option key=value    Set one of the mod's options, as /config does. Repeat it for each option`

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { option: { type: 'string', multiple: true } } })
  if (positionals.length > 1) throw new Error(`cmod link takes at most one path.\n\n${help}`)
  const plugin = await readPlugin(positionals[0] ?? '.')
  const progress = startProgress()
  if (plugin.name !== 'cmod') await installCmodPlugin(progress)

  progress.step(`Installing packages for ${plugin.name}`)
  if (await installPackages(plugin)) progress.succeed(`Installed packages for ${plugin.name}`)
  else progress.succeed(`${plugin.name} has no package.json, so it has no packages to install`)

  const program = await readProgram(plugin)
  if (program !== undefined) await installProgram(program, plugin.version, progress)

  progress.step(`Linking ${tilde(plugin.root)}`)
  const id = await linkPlugin(plugin)
  progress.succeed(`Linked ${tilde(plugin.root)} as ${id}`)
  if (values.option !== undefined) await setOptions({ id, installPath: plugin.root }, values.option, progress)

  const code = await setupInTerminal(plugin, progress)
  if (code === 0) progress.note(`Every Claude Code session loads ${plugin.name} from ${tilde(plugin.root)}, and reloads it once a change you save builds.`)
  return code
}
