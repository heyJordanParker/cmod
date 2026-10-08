import { isObject } from '@cmodjs/core/src/records.js'
import { capture, run } from './process.js'

export type InstalledPlugin = { id: string; name: string; version: string; scope: string; enabled: boolean; installPath: string; errors: string[] }

export type Marketplace = { name: string; source: string; repo?: string; path?: string; installLocation?: string }

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

export async function changePlugin(action: 'install' | 'uninstall' | 'update', id: string): Promise<void> {
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
  } catch {
    throw new Error(`${command} printed text that is not JSON:\n${text.trim().split('\n').slice(0, 5).join('\n')}`)
  }
}
