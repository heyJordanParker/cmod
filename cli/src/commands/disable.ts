import { switchPlugin } from './enable.js'

export const summary = 'Turn a plugin off in Claude Code, keeping its setup.'

export const help = `Usage: cmod disable <name>

${summary}

Turns the plugin off through Claude Code, as /plugin does. A running session
stops it after /reload-plugins. A mod keeps its setup, its data, and its
program, and runs no uninstall step. cmod remove uninstalls it.`

export function run(argv: string[]): Promise<number> {
  return switchPlugin('disable', argv, help)
}
