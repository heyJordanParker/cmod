import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isObject } from '@cmodjs/core/src/records.js'
import { version as cmodVersion } from '../package.json'
import { writeAtomically } from './files.js'
import type { Plugin } from './plugin.js'
import { capture, run, runAttached, spawn, type Captured } from './process.js'

export type InstalledPlugin = { id: string; name: string; version: string; scope: string; enabled: boolean; installPath: string; errors: string[] }

export type Marketplace = { name: string; source: string; repo?: string; path?: string; installLocation?: string }

const claudeApiMs = 60_000

export async function listPlugins(): Promise<InstalledPlugin[]> {
  const entries = parse(await run(['claude', 'plugin', 'list', '--json']), 'claude plugin list --json')
  if (!Array.isArray(entries)) throw new Error('claude plugin list --json printed no list. Update Claude Code to 2.1.289 or later.')
  return entries.filter(isObject).map((entry) => {
    const id = String(entry['id'])
    const errors = Array.isArray(entry['errors']) ? entry['errors'].map(String) : []
    return { id, name: id.slice(0, id.lastIndexOf('@')), version: String(entry['version']), scope: String(entry['scope']), enabled: entry['enabled'] === true, installPath: String(entry['installPath']), errors }
  })
}

export async function listMarketplaces(): Promise<Marketplace[]> {
  const entries = parse(await run(['claude', 'plugin', 'marketplace', 'list', '--json']), 'claude plugin marketplace list --json')
  if (!Array.isArray(entries)) throw new Error('claude plugin marketplace list --json printed no list. Update Claude Code to 2.1.289 or later.')
  return entries.filter(isObject) as Marketplace[]
}

export async function addMarketplace(source: string): Promise<void> {
  await run(['claude', 'plugin', 'marketplace', 'add', source])
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
    const claude = spawn(['claude', ...pluginDirs.flatMap((dir) => ['--plugin-dir', dir]), '-p', 'ok'], { cwd: plugin.root, env, stdout: 'ignore', stderr: 'ignore' })
    const timeout = setTimeout(() => claude.kill(), claudeApiMs)
    await claude.exited
    clearTimeout(timeout)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  if (!existsSync(types)) throw new Error(`Claude Code wrote no .claude-plugin/types/ when cmod loaded ${plugin.name} with claude --plugin-dir. Run cmod link, start claude once, then run cmod check again.`)
}

export async function changePlugin(action: 'install' | 'uninstall' | 'update' | 'enable' | 'disable', id: string): Promise<void> {
  const result = await capture(['claude', 'plugin', action, id, '--json'])
  const lastLine = result.stdout.trim().split('\n').at(-1) ?? ''
  const outcome = lastLine.startsWith('{') ? parse(lastLine, `claude plugin ${action} --json`) : undefined
  if (result.exitCode !== 0 || !isObject(outcome) || outcome['outcome'] !== 'ok') {
    const message = isObject(outcome) && typeof outcome['message'] === 'string' ? outcome['message'] : (result.stderr.trim() || result.stdout.trim())
    throw new Error(`claude plugin ${action} ${id} failed: ${message}`)
  }
}

export async function configurePlugin(id: string, values: Readonly<Record<string, string>>): Promise<void> {
  if (Object.keys(values).length === 0) return
  const result = await capture(['claude', 'plugin', 'configure', id, '--values-stdin', '--json'], { stdin: { text: JSON.stringify(values) } })
  if (result.exitCode !== 0) throw new Error(`claude plugin configure ${id} failed: ${(result.stderr.trim() || result.stdout.trim()).split('\n').slice(-3).join('\n')}`)
}

export function validatePlugin(path: string): Promise<Captured> {
  return capture(['claude', 'plugin', 'validate', path, '--strict'])
}

export function testPlugin(root: string): Promise<Captured> {
  return capture(['claude', 'plugin', 'test', root])
}

export function tryPlugins(plugins: readonly Plugin[], args: readonly string[]): Promise<number> {
  return runAttached(['claude', ...plugins.flatMap((plugin) => ['--plugin-dir', plugin.root]), ...args])
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
