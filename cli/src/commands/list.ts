import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { readRecord, storeFolder } from 'cmod-sdk/src/records.js'
import { listPlugins } from '../claude.js'
import { readText } from '../files.js'
import { isModFolder, readPlugin, type Plugin } from '../plugin.js'
import { linkedFolders } from '../settings.js'
import { recordNames } from '../store.js'

export const summary = 'List the mods Claude Code has, and what CMod set up.'

export const help = `Usage: cmod list

${summary}

Lists every mod Claude Code has installed or linked, with its version and
whether CMod set it up, and every mod Claude Code removed whose uninstall step
has not run yet.`

type Row = { name: string; version: string; state: string }

export async function run(argv: string[]): Promise<number> {
  parseArgs({ args: argv, allowPositionals: false, options: {} })
  const rows: Row[] = []
  const shown = new Set<string>()
  const loadedRoots = new Set<string>()

  for (const installed of await listPlugins()) {
    if (!existsSync(installed.installPath)) {
      rows.push({ name: installed.id, version: installed.version, state: `${installed.installPath} is missing: run claude plugin update ${installed.id}` })
      continue
    }
    if (!(await isModFolder(installed.installPath))) continue
    const plugin = await readPlugin(installed.installPath)
    shown.add(plugin.name)
    loadedRoots.add(plugin.root)
    const origin = installed.scope === 'session' ? `linked from ${plugin.root}, ` : ''
    const disabled = `disabled${installed.errors.length > 0 ? `: ${installed.errors.join('; ')}` : ''}`
    rows.push({ name: installed.id, version: plugin.version, state: installed.enabled ? `${origin}${await setupState(plugin)}` : `${origin}${disabled}` })
  }
  for (const folder of await linkedFolders()) {
    if (!existsSync(`${folder}/.claude-plugin/plugin.json`)) {
      rows.push({ name: folder, version: '', state: 'linked, but the folder holds no plugin: run cmod unlink on it' })
      continue
    }
    const plugin = await readPlugin(folder)
    if (loadedRoots.has(plugin.root)) continue
    shown.add(plugin.name)
    rows.push({ name: plugin.name, version: plugin.version, state: `linked from ${plugin.root}, but claude plugin list does not show it` })
  }
  for (const name of await recordNames()) {
    if (shown.has(name)) continue
    const record = await readRecord(readText, storeFolder(process.env), name)
    rows.push({ name, version: record?.version ?? '', state: `removed: run cmod teardown ${name}` })
  }

  if (rows.length === 0) {
    process.stdout.write('No mods. cmod install <owner/repo> installs one, and cmod new <name> starts one.\n')
    return 0
  }
  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length))
  const versionWidth = Math.max(7, ...rows.map((row) => row.version.length))
  process.stdout.write(`${'NAME'.padEnd(nameWidth)}  ${'VERSION'.padEnd(versionWidth)}  STATE\n`)
  for (const row of rows) process.stdout.write(`${row.name.padEnd(nameWidth)}  ${row.version.padEnd(versionWidth)}  ${row.state}\n`)
  return 0
}

async function setupState(plugin: Plugin): Promise<string> {
  const record = await readRecord(readText, storeFolder(process.env), plugin.name)
  if (record === undefined) return `not set up: run cmod setup ${plugin.root}`
  if (record.version !== plugin.version) return `set up at ${record.version}: run cmod setup ${plugin.root}`
  return 'ready'
}
