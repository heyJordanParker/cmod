import { parseArgs } from 'node:util'
import { changePlugin, listPlugins } from '../claude.js'
import { startProgress } from '../progress.js'

export const summary = 'Turn a plugin on in Claude Code.'

export const help = `Usage: cmod enable <name>

${summary}

Turns the plugin on through Claude Code, as /plugin does. A running session
loads it after /reload-plugins. A mod keeps its setup while it is off, so
turning it on runs nothing.`

export function run(argv: string[]): Promise<number> {
  return switchPlugin('enable', argv, help)
}

export async function switchPlugin(action: 'enable' | 'disable', argv: string[], usage: string): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} })
  if (positionals.length !== 1) throw new Error(`cmod ${action} takes one name.\n\n${usage}`)
  const name = positionals[0] as string
  const installed = (await listPlugins()).find((plugin) => plugin.name === name || plugin.id === name)
  if (installed === undefined) throw new Error(`No installed plugin is named ${name}. cmod list shows the installed plugins.`)
  if (installed.scope === 'session') throw new Error(`${installed.id} is linked from ${installed.installPath}, so Claude Code loads it in every session. cmod unlink stops loading it.`)

  const progress = startProgress()
  const word = action === 'enable' ? 'on' : 'off'
  progress.step(`Turning ${installed.id} ${word}`)
  await changePlugin(action, installed.id)
  progress.succeed(`Turned ${installed.id} ${word} in Claude Code. A running session follows after /reload-plugins.`)
  return 0
}
