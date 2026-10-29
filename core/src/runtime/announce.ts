import { isObject } from '../records.js'
import { ifMissing } from '../utils/paths.js'
import { listed } from '../utils/text.js'
import type { Claude } from './claude.js'
import type { Plugin } from './lifecycle.js'

export type Announcement = { readonly message: string; readonly description?: string; readonly action: { readonly label: string; readonly onClick: () => unknown } }

export const announcementMs = 10_000

export async function announcementOf(claude: Claude, plugin: Plugin, added: readonly string[], openSettings: () => Promise<void>): Promise<Announcement> {
  const manifest = jsonOf(await claude.fs.read(`${plugin.root}/.claude-plugin/plugin.json`).catch(ifMissing(undefined)))
  const { program, hotkeys } = plugin.steps
  const rules = (await claude.fs.list(`${plugin.root}/rules`).catch(ifMissing([]))).filter((entry) => entry.kind === 'file' && entry.name.endsWith('.md')).map((entry) => entry.name.slice(0, -'.md'.length)).toSorted()
  const lines = [
    isObject(manifest) && typeof manifest['description'] === 'string' ? manifest['description'] : undefined,
    added.length > 0 ? `Adds ${listed(added)}.` : undefined,
    rules.length > 0 ? `Adds ${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}: ${listed(rules)}.` : undefined,
    program === undefined ? undefined : `Installed the ${program} program.`,
    ...Object.values(hotkeys ?? {}).flatMap(({ title, default: combo }) => (combo === undefined ? [] : [`Binds ${combo} to ${title}.`])),
  ].filter((line) => line !== undefined)
  return { message: 'Installed', ...(lines.length === 0 ? {} : { description: lines.join('\n') }), action: { label: 'Settings', onClick: () => openSettings() } }
}

function jsonOf(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}
