import { changelogPage, isObject, marketplaceOf, permissionWords } from '../records.js'
import { changeLines, changelogSections, unreleased } from '../utils/changelog.js'
import { ifMissing } from '../utils/paths.js'
import { listed } from '../utils/text.js'
import type { Claude } from './claude.js'
import { cmodPluginName } from './dependencies.js'
import type { Plugin } from './lifecycle.js'

export type Announced = { readonly version: string; readonly added: readonly string[] }

export type Announcement = { readonly message: string; readonly description?: string; readonly action?: { readonly label: string; readonly onClick: () => unknown } }

export const announcementMs = 10_000

const shownChanges = 3

export function announcedOf(saved: unknown): Announced | undefined {
  if (typeof saved === 'string') return { version: saved, added: [] }
  if (!isObject(saved) || typeof saved['version'] !== 'string') return undefined
  return { version: saved['version'], added: Array.isArray(saved['added']) ? saved['added'].map(String) : [] }
}

export async function announcementOf(claude: Claude, plugin: Plugin, granted: ReadonlySet<string>, added: readonly string[], previous: Announced | undefined): Promise<Announcement> {
  const read = (path: string) => claude.fs.read(`${plugin.root}/${path}`).catch(ifMissing(undefined))
  const manifest = jsonOf(await read('.claude-plugin/plugin.json'))
  const field = (key: string) => (isObject(manifest) && typeof manifest[key] === 'string' ? manifest[key] : undefined)
  const open = (page?: string) => () => claude.cmod.call({ to: cmodPluginName, method: 'openSettings', input: { mod: plugin.name, ...(page === undefined ? {} : { page }) } })
  if (previous === undefined) {
    const { program, keys } = plugin.steps
    const lines = [
      field('description'),
      added.length > 0 ? `Adds ${listed(added)}.` : undefined,
      program === undefined ? undefined : `Installed the ${program} program.`,
      ...Object.entries(keys ?? {}).map(([key, command]) => `Binds ${key} to /${command}.`),
      ...[...granted].map((item) => `${permissionWords(item)}.`),
    ]
    return { message: 'Installed', ...described(lines), action: { label: 'Settings', onClick: open() } }
  }
  const version = plugin.version ?? ''
  const isCheckout = marketplaceOf(plugin.root, plugin.name) === undefined
  const sections = changelogSections((await read('CHANGELOG.md')) ?? '')
  const section = sections.find((each) => each.version === version) ?? (isCheckout ? sections.find((each) => each.version === unreleased) : undefined)
  const changes = section === undefined ? [] : changeLines(section.text)
  const nowAdded = added.filter((each) => !previous.added.includes(each))
  const gone = previous.added.filter((each) => !added.includes(each))
  const fallback = previous.added.length === 0 ? [] : [nowAdded.length > 0 ? `Now adds ${listed(nowAdded)}.` : undefined, gone.length > 0 ? `No longer adds ${listed(gone)}.` : undefined]
  const home = await claude.env.home()
  const folder = home !== undefined && plugin.root.startsWith(`${home}/`) ? `~${plugin.root.slice(home.length)}` : plugin.root
  const repository = field('repository')
  const lines = [
    ...(changes.length === 0 ? fallback : changes.length > shownChanges ? [...changes.slice(0, shownChanges), '…'] : changes),
    `From ${previous.version}${isCheckout ? `, loaded from ${folder}` : ''}.`,
    repository === undefined || isCheckout ? undefined : `Release notes: ${repository.replace(/\/$/, '')}/releases/tag/v${version}`,
  ]
  return {
    message: `Updated to ${version}`,
    ...described(lines),
    ...(sections.length > 0 ? { action: { label: 'Changelog', onClick: open(changelogPage) } } : {}),
  }
}

function jsonOf(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

function described(lines: readonly (string | undefined)[]): { readonly description?: string } {
  const kept = lines.filter((line) => line !== undefined)
  return kept.length === 0 ? {} : { description: kept.join('\n') }
}
