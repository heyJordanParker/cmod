import { existsSync, realpathSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { version as cmodVersion } from '../../package.json'
import { isAtLeast, readRecord, storeFolder } from '@cmodjs/core/src/records.js'
import { listPlugins } from '../claude.js'
import { readText } from '../files.js'
import { readPlugin, usesCmod, type Plugin } from '../plugin.js'
import { linkedFolders } from '../settings.js'
import { recordNames } from '../store.js'

export const summary = 'List every plugin Claude Code has, and what cmod set up.'

export const help = `Usage: cmod list [--json]

${summary}

Lists every plugin Claude Code has installed or linked, with its version. A
mod shows whether cmod set it up, and any other plugin shows whether Claude
Code enabled it. A plugin Claude Code turned off shows why. Also lists every
mod Claude Code removed whose uninstall step has not run yet.

Options:
  --json  Print the list as JSON, with the dependencies Claude Code turned each
          plugin off for, because they are older than the plugin needs`

type Row = { name: string; version: string; state: string; unsatisfied: readonly string[] }

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, allowPositionals: false, options: { json: { type: 'boolean', default: false } } })
  const rows: Row[] = []
  const shown = new Set<string>()
  const loadedRoots = new Set<string>()

  for (const installed of await listPlugins()) {
    if (!existsSync(installed.installPath)) {
      rows.push({ name: installed.id, version: installed.version, state: `${installed.installPath} is missing: run claude plugin update ${installed.id}`, unsatisfied: installed.unsatisfied })
      continue
    }
    const root = realpathSync(installed.installPath)
    loadedRoots.add(root)
    const isCmodPlugin = installed.name === 'cmod' && existsSync(`${root}/.claude-plugin/plugin.json`)
    const mod = isCmodPlugin || (await usesCmod(root, installed.name)) ? await readPlugin(root) : undefined
    if (mod !== undefined) shown.add(mod.name)
    const origin = installed.scope === 'session' ? `linked from ${root}, ` : ''
    const errors = installed.errors.join('; ')
    const state = !installed.enabled ? `disabled${errors === '' ? '' : `: ${errors}`}` : errors !== '' ? `Claude Code turned it off: ${errors}` : mod === undefined ? 'enabled' : await setupState(mod)
    rows.push({ name: installed.id, version: mod?.version ?? installed.version, state: `${origin}${state}`, unsatisfied: installed.unsatisfied })
  }
  for (const folder of await linkedFolders()) {
    if (!existsSync(`${folder}/.claude-plugin/plugin.json`)) {
      rows.push({ name: folder, version: '', state: 'linked, but the folder holds no plugin: run cmod unlink on it', unsatisfied: [] })
      continue
    }
    const plugin = await readPlugin(folder)
    if (loadedRoots.has(plugin.root)) continue
    shown.add(plugin.name)
    rows.push({ name: plugin.name, version: plugin.version, state: `linked from ${plugin.root}, but claude plugin list does not show it`, unsatisfied: [] })
  }
  for (const name of await recordNames()) {
    if (shown.has(name)) continue
    const record = await readRecord(readText, storeFolder(process.env), name)
    rows.push({ name, version: record?.version ?? '', state: `removed: run cmod teardown ${name}`, unsatisfied: [] })
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(rows)}\n`)
    return 0
  }
  if (rows.length === 0) {
    process.stdout.write('No plugins. cmod install <owner/repo> installs one, and cmod new <name> starts a mod.\n')
    return 0
  }
  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length))
  const versionWidth = Math.max(7, ...rows.map((row) => row.version.length))
  process.stdout.write(`${'NAME'.padEnd(nameWidth)}  ${'VERSION'.padEnd(versionWidth)}  STATE\n`)
  for (const row of rows) process.stdout.write(`${row.name.padEnd(nameWidth)}  ${row.version.padEnd(versionWidth)}  ${row.state}\n`)
  return 0
}

async function setupState(plugin: Plugin): Promise<string> {
  if (plugin.name === 'cmod') return isAtLeast(cmodVersion, plugin.version) ? 'ready' : `the cmod program is ${cmodVersion}: start a Claude Code session to fetch ${plugin.version}`
  const record = await readRecord(readText, storeFolder(process.env), plugin.name)
  if (record === undefined) return `not set up: run cmod setup ${plugin.root}`
  if (record.version !== plugin.version) return `set up at ${record.version}: run cmod setup ${plugin.root}`
  return 'ready'
}
