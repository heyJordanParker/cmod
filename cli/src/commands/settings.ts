import { parseArgs } from 'node:util'
import { isObject, isSettingCovered, permissionWords, readRecord, settingPaths, storeFolder } from '@cmodjs/core/src/records.js'
import { readText, tilde } from '../files.js'
import { changeSettings, settingsFileOf, type SettingsSource } from '../settings.js'
import { approvals } from '../store.js'

export const summary = "Change Claude Code settings for a mod, as its settings.user.update, settings.project.update, or settings.local.update does."

export const help = `Usage: cmod settings <mod> <user|project|local> <json> [--project <folder>]

${summary}

Merges the JSON object into the user, project, or local Claude Code settings as
a JSON Merge Patch: an object merges into the object already there, a null
removes that key, and an array or any other value replaces it. The project and
local settings are the ones of --project, the current folder when it is left
out, and mcpServers in the project settings is written to .mcp.json. Each value
needs the mod's grant to "Change <path> in your Claude Code settings", from its
package.json "cmod.permissions" "config" list, where "env" covers every key in
env and "env.ANTHROPIC_BASE_URL" covers that one. cmod keeps every other key and
the file's formatting, and removing the mod takes out each value it set that is
still the same, then each object that leaves empty.`

const sources: readonly string[] = ['user', 'project', 'local']

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { project: { type: 'string' } } })
  if (positionals.length !== 3) throw new Error(`cmod settings takes a mod, user, project, or local, and a JSON object.\n\n${help}`)
  const [name, source, json] = positionals as [string, string, string]
  if (!sources.includes(source)) throw new Error(`"${source}" is not a settings source. Use user, project, or local.`)
  const changed = parsedObject(json)
  const record = await readRecord(readText, storeFolder(process.env), name)
  if (record === undefined) throw new Error(`${name} is not set up. Run cmod install ${name} first.`)
  const granted = await approvals(name)
  const refused = settingPaths(changed)
    .map((path) => path.join('.'))
    .filter((path) => !isSettingCovered(granted, path))
  if (refused.length > 0) throw new Error(`${name} has no grant to ${refused.map((path) => `"${permissionWords(`config:${path}`)}"`).join(', ')}. It needs "permissions": { "config": [${refused.map((path) => `"${path}"`).join(', ')}] } in package.json "cmod", turned on in Settings.`)
  const project = values.project ?? process.cwd()
  const changes = Object.entries(changed).map(([key, value]) => ({ file: settingsFileOf(source as SettingsSource, project, key), key, value }))
  await changeSettings(name, changes)
  for (const { file, key } of changes) process.stdout.write(`Changed ${key} in ${tilde(file)} for ${name}.\n`)
  return 0
}

function parsedObject(json: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    throw new Error(`${json} is not JSON. Pass the settings as a JSON object, such as '{"cleanupPeriodDays":365}'.`, { cause: error })
  }
  if (!isObject(value) || Object.keys(value).length === 0) throw new Error(`${json} is not a JSON object with at least one setting, such as '{"cleanupPeriodDays":365}'.`)
  return value
}
