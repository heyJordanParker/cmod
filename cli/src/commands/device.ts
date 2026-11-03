import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { readDevice } from '@cmodjs/core/src/runtime/device.js'
import { capture } from '../process.js'

export const summary = 'Print this computer as a mod reads it with device.read().'

export const help = `Usage: cmod device [--json]

${summary}

Prints the computer's id, name, operating system, and architecture, the same
device a mod's device.read() gives, so a program that runs with no Claude Code
session, such as one run over ssh, names the computer as its mod does. --json
prints it as { id, name, os, arch }. The id stays the same across restarts
and renames, and differs from the machine id it is made from.`

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean', default: false } } })
  if (positionals.length > 0) throw new Error(`cmod device takes no names.\n\n${help}`)
  const device = await readDevice({ process: { run: (command) => capture([...command]) }, fs: { read: (path) => readFile(path, 'utf8') } })
  process.stdout.write(values.json ? `${JSON.stringify(device)}\n` : `${device.name}  ${device.os} ${device.arch}  ${device.id}\n`)
  return 0
}
