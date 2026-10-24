import { existsSync, readlinkSync } from 'node:fs'
import { mkdtemp, readdir, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { isObject } from '@cmodjs/core/src/records.js'
import { ifMissing } from '@cmodjs/core/src/utils/paths.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { version as cmodVersion } from '../package.json'
import { readText, tilde, writeAtomically } from './files.js'
import { readPlugin, type Plugin } from './plugin.js'
import { capture, run, runAttached, spawn, type Captured } from './process.js'
import { linkedEntries, linkedMarketplaceFile, linkedPlugins, pluginFolders, removePluginFolder, type LinkedEntry } from './settings.js'
import { changeLinks } from './store.js'

export type InstalledPlugin = { id: string; name: string; version: string; scope: string; enabled: boolean; isLinked: boolean; installPath: string; errors: string[]; unsatisfied: string[] }

export type Marketplace = { name: string; source: string; repo?: string; path?: string; installLocation?: string }

export const cmodPluginEntry = {
  name: 'cmod',
  description: 'Claude Mod Manager: runs the uninstall step of each mod Claude Code removes',
  source: { source: 'github', repo: 'heyJordanParker/cmod', ref: 'release' },
}

const claudeApiMs = 60_000

let startedBy: string | undefined

const claudeCode = (): string => (startedBy ??= present(process.env['CLAUDE_CODE_EXECPATH']) ?? parentClaudeCode() ?? 'claude')

const present = (path: string | undefined) => (path !== undefined && path !== '' && existsSync(path) ? path : undefined)

function parentClaudeCode(): string | undefined {
  const parent = process.platform === 'linux' ? readlinkOf(`/proc/${process.ppid}/exe`) : Bun.spawnSync(['/bin/ps', '-o', 'comm=', '-p', String(process.ppid)]).stdout.toString().trim()
  return parent !== undefined && /(?:^|\/)claude$|\/claude\/versions\/[^/]+$/.test(parent) ? present(parent) : undefined
}

function readlinkOf(path: string): string | undefined {
  try {
    return readlinkSync(path)
  } catch (error) {
    return ifMissing(undefined)(error)
  }
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
  const entries = parse(await run([claudeCode(), 'plugin', 'list', '--json']), 'claude plugin list --json')
  if (!Array.isArray(entries)) throw new Error('claude plugin list --json printed no list. Update Claude Code to 2.1.289 or later.')
  const linked = new Map((await linkedPlugins()).map((plugin) => [plugin.id, plugin.folder]))
  return entries.filter(isObject).map((entry) => {
    const id = String(entry['id'])
    const scope = String(entry['scope'])
    const checkout = linked.get(id)
    const errors = Array.isArray(entry['errors']) ? entry['errors'].map(String) : []
    const details = Array.isArray(entry['errorDetails']) ? entry['errorDetails'].filter(isObject) : []
    const unsatisfied = details.filter((detail) => detail['type'] === 'dependency-version-unsatisfied' && typeof detail['dependency'] === 'string').map((detail) => String(detail['dependency']))
    return { id, name: id.slice(0, id.lastIndexOf('@')), version: String(entry['version']), scope, enabled: entry['enabled'] === true, isLinked: scope === 'session' || checkout !== undefined, installPath: checkout ?? String(entry['installPath']), errors, unsatisfied }
  })
}

export async function listMarketplaces(): Promise<Marketplace[]> {
  const entries = parse(await run([claudeCode(), 'plugin', 'marketplace', 'list', '--json']), 'claude plugin marketplace list --json')
  if (!Array.isArray(entries)) throw new Error('claude plugin marketplace list --json printed no list. Update Claude Code to 2.1.289 or later.')
  return entries.filter(isObject) as Marketplace[]
}

export async function addMarketplace(source: string): Promise<void> {
  await run([claudeCode(), 'plugin', 'marketplace', 'add', source])
}

export async function linkPlugin(plugin: Plugin): Promise<string> {
  const parent = dirname(plugin.root)
  const file = linkedMarketplaceFile(parent)
  return changeLinks(async (links) => {
    const owned = Object.keys(links.marketplaces).find((name) => links.marketplaces[name] === parent)
    if (owned === undefined && existsSync(file)) throw new Error(`${tilde(file)} is a marketplace cmod did not write, so cmod cannot list ${plugin.name} beside it. Move ${tilde(plugin.root)} into a folder with no .claude-plugin/marketplace.json, then run cmod link again.`)
    const marketplaces = await listMarketplaces()
    const name = owned ?? freeName(`${basename(parent).replace(/[^\w.-]+/g, '-')}-linked`, [...Object.keys(links.marketplaces), ...marketplaces.map((marketplace) => marketplace.name)])
    const entry = { name: plugin.name, source: `./${basename(plugin.root)}`, description: plugin.description ?? plugin.name }
    await writeLinkedMarketplace(parent, name, [...(await linkedEntries(parent)).filter((each) => each.name !== plugin.name), entry])
    links.marketplaces[name] = parent
    if (owned === undefined) await excludeFromGit(parent, true)
    if (marketplaces.some((marketplace) => marketplace.name === name)) await run([claudeCode(), 'plugin', 'marketplace', 'update', name])
    else await addMarketplace(parent)
    const id = `${plugin.name}@${name}`
    await changePlugin('install', id)
    const published = (await listPlugins()).filter((each) => each.name === plugin.name && each.id !== id && each.enabled)
    for (const each of published) await changePlugin('disable', each.id)
    links.turnedOff[plugin.name] = [...new Set([...(links.turnedOff[plugin.name] ?? []), ...published.map((each) => each.id)])]
    return id
  })
}

export async function unlinkPlugin(plugin: Plugin): Promise<boolean> {
  const parent = dirname(plugin.root)
  return changeLinks(async (links) => {
    const name = Object.keys(links.marketplaces).find((each) => links.marketplaces[each] === parent)
    const entries = name === undefined ? [] : await linkedEntries(parent)
    const kept = entries.filter((entry) => join(parent, entry.source) !== plugin.root)
    if (name === undefined || kept.length === entries.length) return false
    await changePlugin('uninstall', `${plugin.name}@${name}`)
    if (kept.length > 0) {
      await writeLinkedMarketplace(parent, name, kept)
      await run([claudeCode(), 'plugin', 'marketplace', 'update', name])
    } else {
      const dependency = `${cmodPluginEntry.name}@${name}`
      if ((await listPlugins()).some((each) => each.id === dependency)) await changePlugin('uninstall', dependency)
      await run([claudeCode(), 'plugin', 'marketplace', 'remove', name])
      const file = linkedMarketplaceFile(parent)
      await rm(file, { force: true })
      if ((await readdir(dirname(file))).length === 0) await rmdir(dirname(file))
      await excludeFromGit(parent, false)
      delete links.marketplaces[name]
    }
    const installed = new Set((await listPlugins()).map((each) => each.id))
    for (const id of links.turnedOff[plugin.name] ?? []) if (installed.has(id)) await changePlugin('enable', id)
    delete links.turnedOff[plugin.name]
    return true
  })
}

export async function relinkPluginFolders(): Promise<void> {
  for (const folder of await pluginFolders()) {
    try {
      await linkPlugin(await readPlugin(folder))
      await removePluginFolder(folder)
    } catch (error) {
      process.stderr.write(`cmod kept ${tilde(folder)} in CLAUDE_CODE_PLUGIN_DIRS, because linking it as a marketplace failed: ${messageOf(error)}\n`)
    }
  }
}

function freeName(wanted: string, taken: readonly string[]): string {
  let name = wanted
  for (let suffix = 2; taken.includes(name); suffix += 1) name = `${wanted}-${suffix}`
  return name
}

async function writeLinkedMarketplace(folder: string, name: string, checkouts: readonly LinkedEntry[]): Promise<void> {
  const plugins = checkouts.some((checkout) => checkout.name === cmodPluginEntry.name) ? checkouts : [...checkouts, cmodPluginEntry]
  await writeAtomically(linkedMarketplaceFile(folder), `${JSON.stringify({ name, owner: { name: 'cmod link' }, plugins }, null, 2)}\n`)
}

async function excludeFromGit(folder: string, isExcluded: boolean): Promise<void> {
  const git = await capture(['git', '-C', folder, 'rev-parse', '--git-path', 'info/exclude', '--show-prefix'])
  if (git.exitCode !== 0) return
  const [excludes = '', prefix = ''] = git.stdout.split('\n')
  const path = resolve(folder, excludes)
  const line = `/${prefix}.claude-plugin/marketplace.json`
  const text = (await readText(path)) ?? ''
  const lines = text.split('\n')
  if (isExcluded && !lines.includes(line)) await writeAtomically(path, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`)
  if (!isExcluded && lines.includes(line)) await writeAtomically(path, lines.filter((each) => each !== line).join('\n'))
}

export async function addClaudeApi(plugin: Plugin): Promise<void> {
  const folder = join(plugin.root, '.claude-plugin', 'types')
  const types = join(folder, 'tsconfig.json')
  if (existsSync(types) && (await readdir(folder, { recursive: true })).every((entry) => existsSync(join(folder, entry)))) return
  await rm(folder, { recursive: true, force: true })
  const scratch = await mkdtemp(join(tmpdir(), 'cmod-claude-'))
  try {
    const cmodPlugin = join(scratch, 'cmod')
    await writeAtomically(join(cmodPlugin, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'cmod', version: cmodVersion })}\n`)
    const pluginDirs = plugin.name === 'cmod' ? [plugin.root] : [cmodPlugin, plugin.root]
    const env = { ...process.env, CLAUDE_CONFIG_DIR: join(scratch, 'config'), CLAUDE_CODE_PLUGIN_DIR_WATCH: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
    const claude = spawn([claudeCode(), ...pluginDirArguments(pluginDirs), '-p', 'ok'], { cwd: plugin.root, env, stdout: 'ignore', stderr: 'ignore' })
    const timeout = setTimeout(() => claude.kill(), claudeApiMs)
    await claude.exited
    clearTimeout(timeout)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  if (!existsSync(types)) throw new Error(`Claude Code wrote no .claude-plugin/types/ when cmod loaded ${plugin.name} with claude --plugin-dir. Run cmod link, start claude once, then run cmod check again.`)
}

export async function changePlugin(action: 'install' | 'uninstall' | 'update' | 'enable' | 'disable', id: string): Promise<void> {
  const result = await capture([claudeCode(), 'plugin', action, id, '--json'])
  const lastLine = result.stdout.trim().split('\n').at(-1) ?? ''
  const outcome = lastLine.startsWith('{') ? parse(lastLine, `claude plugin ${action} --json`) : undefined
  if (result.exitCode !== 0 || !isObject(outcome) || outcome['outcome'] !== 'ok') {
    const message = isObject(outcome) && typeof outcome['message'] === 'string' ? outcome['message'] : (result.stderr.trim() || result.stdout.trim())
    throw new Error(`claude plugin ${action} ${id} failed: ${message}`)
  }
}

export async function configurePlugin(id: string, values: Readonly<Record<string, string>>, pluginDirs: readonly string[] = []): Promise<void> {
  if (Object.keys(values).length === 0) return
  const result = await capture([claudeCode(), ...pluginDirArguments(pluginDirs), 'plugin', 'configure', id, '--values-stdin', '--json'], { stdin: { text: JSON.stringify(values) } })
  if (result.exitCode !== 0) throw new Error(`claude plugin configure ${id} failed: ${(result.stderr.trim() || result.stdout.trim()).split('\n').slice(-3).join('\n')}`)
}

export function validatePlugin(path: string): Promise<Captured> {
  return capture([claudeCode(), 'plugin', 'validate', path, '--strict'])
}

export function testPlugin(root: string): Promise<Captured> {
  return capture([claudeCode(), 'plugin', 'test', root])
}

export function startSession(args: readonly string[], pluginDirs: readonly string[] = []): Promise<number> {
  return runAttached([claudeCode(), ...pluginDirArguments(pluginDirs), ...args])
}

export async function startBackground(args: readonly string[], cwd: string): Promise<string> {
  const { exitCode, stdout, stderr } = await capture([claudeCode(), '--bg', ...args], { cwd, env: { ...process.env, CLAUDE_CODE_SESSION_ID: undefined } })
  const printed = `${stdout}${stderr}`.trim()
  if (exitCode !== 0) throw new Error(`claude --bg exited ${exitCode}${printed === '' ? '' : `:\n${printed.split('\n').slice(-5).join('\n')}`}`)
  const short = /backgrounded · (\S+)/.exec(printed)?.[1]
  if (short === undefined) throw new Error(`claude --bg printed no session id:\n${printed}`)
  const found = (await backgroundAgents()).find((agent) => agent.id === short || agent.sessionId.startsWith(short))
  if (found === undefined) throw new Error(`claude agents --json --all lists no background session ${short}.`)
  return found.sessionId
}

export async function backgroundAgents(): Promise<{ readonly id: string; readonly sessionId: string; readonly status: string }[]> {
  const entries = parse(await run([claudeCode(), 'agents', '--json', '--all']), 'claude agents --json --all')
  if (!Array.isArray(entries)) throw new Error('claude agents --json --all printed no list. Update Claude Code to 2.1.308 or later.')
  return entries.filter(isObject).flatMap((entry) => (typeof entry['sessionId'] === 'string' ? [{ id: String(entry['id']), sessionId: entry['sessionId'], status: String(entry['status']) }] : []))
}

function pluginDirArguments(pluginDirs: readonly string[]): string[] {
  return pluginDirs.flatMap((dir) => ['--plugin-dir', dir])
}

export function optionValues(given: readonly string[] | undefined, userConfig: Readonly<Record<string, unknown>>, plugin: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const pair of given ?? []) {
    const split = pair.indexOf('=')
    const key = pair.slice(0, split)
    if (split <= 0) throw new Error(`--option ${pair} is not key=value. Write it as --option ${pair || 'key'}=value.`)
    if (!Object.hasOwn(userConfig, key)) throw new Error(`${plugin} has no option ${key}. Its options are: ${Object.keys(userConfig).join(', ') || 'none'}.`)
    values[key] = pair.slice(split + 1)
  }
  return values
}

function parse(text: string, command: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${command} printed text that is not JSON:\n${text.trim().split('\n').slice(0, 5).join('\n')}`, { cause: error })
  }
}
