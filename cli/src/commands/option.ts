import { parseArgs } from 'node:util'
import { configurePlugin, listPlugins } from '../claude.js'
import { manifestOptions } from './install.js'

export const summary = "Set one of a plugin's options, as /mods and a mod's first start do."

export const help = `Usage: cmod option <name> <key> <value>

${summary}

Sets the option <key> of an installed plugin through Claude Code, as /config
does, such as cmod option ci-watch branch main. A list option takes its items
separated by commas. The /mods panel and the option questions a mod asks at
its first start run it, and the mod reads the new value at its next start.`

export async function run(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} })
  if (positionals.length !== 3) throw new Error(`cmod option takes a plugin, an option, and its value.\n\n${help}`)
  const [name, key, value] = positionals as [string, string, string]
  const installed = (await listPlugins()).find((plugin) => plugin.name === name || plugin.id === name)
  if (installed === undefined) throw new Error(`No installed plugin is named ${name}. cmod list shows the installed plugins.`)
  const declared = await manifestOptions(installed.installPath)
  if (!Object.hasOwn(declared, key)) throw new Error(`${installed.name} has no option ${key}. Its options are: ${Object.keys(declared).join(', ') || 'none'}.`)
  await configurePlugin(installed.id, { [key]: value })
  process.stdout.write(`Set ${key} for ${installed.name}.\n`)
  return 0
}
