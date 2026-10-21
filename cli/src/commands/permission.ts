import { parseArgs } from 'node:util'
import { flagPermissions, listPermissions, permissionWords, readRecord, storeFolder, type ListPermission } from '@cmodjs/core/src/records.js'
import { readText } from '../files.js'
import { readPlugin } from '../plugin.js'
import { approve, revokeApprovals } from '../store.js'

export const summary = 'Turn one of a mod\'s permissions on or off, as a toggle in Settings does.'

export const help = `Usage: cmod permission <mod> <name> [value] on|off

${summary}

Turns one permission the mod lists in its package.json "cmod.permissions" on or
off, written the way the mod's mod.permissions.has takes it: a list permission
with its value, such as network api.github.com, and any other with none, such as
model. Settings in Claude Code runs it, and the mod's next call sees it.`

const exampleValues: Readonly<Record<ListPermission, string>> = { network: 'api.github.com', run: 'gh', files: '~/.zshrc', config: 'cleanupPeriodDays' }

export async function run(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} })
  const state = positionals.at(-1)
  if ((positionals.length !== 3 && positionals.length !== 4) || (state !== 'on' && state !== 'off')) throw new Error(`cmod permission takes a mod, a permission, its value for a list permission, and on or off.\n\n${help}`)
  const [name, permission] = positionals as [string, string]
  const value = positionals.length === 4 ? positionals[2] : undefined
  const needsValue = (listPermissions as readonly string[]).includes(permission)
  if (needsValue !== (value !== undefined)) {
    const known = (flagPermissions as readonly string[]).includes(permission)
    throw new Error(needsValue ? `${permission} takes a value, such as cmod permission ${name} ${permission} ${exampleValues[permission as ListPermission]} ${state}.` : known ? `${permission} takes no value: cmod permission ${name} ${permission} ${state}.` : `"${permission}" is not a permission. Use ${[...listPermissions, ...flagPermissions].join(', ')}.`)
  }
  const item = value === undefined ? permission : `${permission}:${value}`
  const record = await readRecord(readText, storeFolder(process.env), name)
  if (record === undefined) throw new Error(`${name} is not set up. Run cmod install ${name} first.`)
  const declared = (await readPlugin(record.root)).steps.permissions ?? []
  if (!declared.includes(item)) throw new Error(`${name} does not list ${needsValue ? `${permission} ${value}` : permission} in its package.json "cmod.permissions", so there is nothing to turn ${state}. It lists: ${declared.join(', ') || 'none'}.`)
  if (state === 'on') await approve(name, [item])
  else await revokeApprovals(name, [item])
  process.stdout.write(`${state === 'on' ? 'Turned on' : 'Turned off'} for ${name}: ${permissionWords(item)}\n`)
  return 0
}
