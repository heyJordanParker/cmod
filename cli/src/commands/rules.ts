import { parseArgs } from 'node:util'
import { syncRules } from '../rules.js'

export const summary = "Link each mod's rules into Claude Code's rules folder."

export const help = `Usage: cmod rules [--project <folder>] [--json]

${summary}

Links the rules/ folder of each mod that is on and has the prompt permission
into Claude Code's rules folder: a user mod's at <config>/rules/<mod>, and a
mod turned on for one project at <project>/.claude/rules/<mod>. It removes the
link of a mod that is off, lacks the permission, or is removed, then prints the
rules it linked. --json prints them as { linked, placed, removed, watched }:
placed and removed name the mods whose link this run made or took away, and
watched lists the files and folders whose change can change the next run. cmod
runs it after install, update, remove, enable, disable, permission, setup,
teardown, link, and unlink.`

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { project: { type: 'string' }, json: { type: 'boolean', default: false } } })
  if (positionals.length > 0) throw new Error(`cmod rules takes no names.\n\n${help}`)
  const synced = await syncRules(values.project ?? process.cwd())
  process.stdout.write(values.json ? `${JSON.stringify(synced)}\n` : synced.linked.map(({ mod, folder, rules }) => `${mod}  ${folder}  ${rules.map((rule) => rule.name).join(', ')}\n`).join(''))
  return 0
}
