import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { logFolder, logReport, newestLog, parseLog, storeFolder, type LogEntry } from '@cmodjs/core/src/records.js'
import { ifMissing } from '@cmodjs/core/src/utils/paths.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'

export const summary = "Print the Log: each mod's failures and warnings, with their versions."

export const help = `Usage: cmod log [<mod>] [--json]

${summary}

Prints what Settings shows in its Log, newest first: each failure and warning
a mod or cmod met in any session on this computer, with the versions it
happened on and how often. <mod> keeps one mod's. --json prints the entries
as a list of { mod, id, level, message, details, at, firstAt, count,
session, versions }.`

async function readEntries(path: string): Promise<LogEntry[]> {
  try {
    return parseLog(JSON.parse(await readFile(path, 'utf8')), path)
  } catch (error) {
    process.stderr.write(`cmod log: skips ${path}: ${messageOf(error)}\n`)
    return []
  }
}

function printed(entry: LogEntry): string {
  const details = logReport(entry)
    .split('\n')
    .map((line) => (line === '' ? '' : `  ${line}`))
    .join('\n')
  return `${entry.at}  ${entry.level ?? 'error'}  ${entry.mod}  ${entry.message}\n${details}\n`
}

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean', default: false } } })
  if (positionals.length > 1) throw new Error(`cmod log takes at most one mod name.\n\n${help}`)
  const [name] = positionals
  const folder = logFolder(storeFolder(process.env))
  const files = (await readdir(folder).catch(ifMissing([]))).filter((file) => file.endsWith('.json'))
  const entries = (await Promise.all(files.map((file) => readEntries(join(folder, file))))).flat().filter((entry) => name === undefined || entry.mod === name)
  const log = newestLog(entries)
  if (values.json) process.stdout.write(`${JSON.stringify(log)}\n`)
  else if (log.length === 0) process.stdout.write(name === undefined ? 'No mod has failed.\n' : `${name} has not failed.\n`)
  else process.stdout.write(log.map(printed).join('\n'))
  return 0
}
