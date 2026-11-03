import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { configFolders, isObject } from '@cmodjs/core/src/records.js'
import { optionsOf, projectOptionsOf } from '@cmodjs/core/src/options.js'
import { ifMissing } from '@cmodjs/core/src/utils/paths.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { listPlugins } from '../claude.js'
import { indexedProjects, openHistory } from '../history.js'
import { capture } from '../process.js'
import { settingsPath } from '../settings.js'
import { manifestOptions } from './install.js'

export const summary = "Print a mod's option values at each level: yours and each project's."

export const help = `Usage: cmod options <mod> [--project <folder>]... [--json]

${summary}

Prints the values of a mod's options in two levels: person, the values you set
in /config, and projects, the values each project's committed
.claude/cmods/<mod>/options.json sets, keyed by the project's git root as
git rev-parse --show-toplevel prints it. A project outside git keeps its own
folder as its key. With no --project, it reads every project cmod's
conversation index holds a session of, and lists only the projects whose
options.json exists. A mod's session uses a project's value over yours, and a
value your organization locks over both. --json prints { person, projects }.`

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { project: { type: 'string', multiple: true }, json: { type: 'boolean', default: false } } })
  if (positionals.length !== 1) throw new Error(`cmod options takes one mod.\n\n${help}`)
  const [name] = positionals as [string]
  const copies = (await listPlugins()).filter((plugin) => plugin.name === name || plugin.id === name)
  const installed = copies.find((plugin) => plugin.enabled) ?? copies[0]
  if (installed === undefined) throw new Error(`No installed plugin is named ${name}. cmod list shows the installed plugins.`)
  const declared = optionsOf(await manifestOptions(installed.installPath))
  const kept = (given: unknown) => (isObject(given) ? Object.fromEntries(Object.entries(given).filter(([key]) => declared[key] !== undefined && declared[key].type !== 'secret')) : {})
  const settings = await readJson(settingsPath())
  const configs = isObject(settings) && isObject(settings['pluginConfigs']) ? settings['pluginConfigs'][installed.id] : undefined
  const person = kept(isObject(configs) ? configs['options'] : undefined)
  const roots = values.project?.map((folder) => resolve(folder)) ?? indexedProjects(openHistory())
  const projects: Record<string, Record<string, unknown>> = {}
  for (const root of roots) {
    if (!existsSync(root)) continue
    const key = await gitRootOf(root)
    if (Object.hasOwn(projects, key)) continue
    const folder = configFolders(process.env, installed.name, key).find(({ tier }) => tier === 'project')?.folder
    const path = folder === undefined ? undefined : join(folder, 'options.json')
    if (path === undefined || !existsSync(path)) continue
    const read = projectOptionsOf(installed.name, declared, await readFile(path, 'utf8'))
    for (const reason of read.ignored) process.stderr.write(`cmod options: ignores part of ${path}: ${path} ${reason}\n`)
    projects[key] = read.values
  }
  process.stdout.write(values.json ? `${JSON.stringify({ person, projects })}\n` : levelLines(person, projects))
  return 0
}

async function gitRootOf(folder: string): Promise<string> {
  const { exitCode, stdout } = await capture(['git', '-C', folder, 'rev-parse', '--show-toplevel'])
  return exitCode === 0 && stdout.trim() !== '' ? stdout.trim() : folder
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8').catch(ifMissing(undefined))
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} is not JSON (${messageOf(error)}). Fix it, then run cmod options again.`)
  }
}

function levelLines(person: Readonly<Record<string, unknown>>, projects: Readonly<Record<string, Readonly<Record<string, unknown>>>>): string {
  const lines = (level: string, given: Readonly<Record<string, unknown>>) => Object.entries(given).map(([key, value]) => `${level}  ${key} = ${JSON.stringify(value)}\n`)
  return [...lines('person', person), ...Object.entries(projects).flatMap(([root, given]) => lines(root, given))].join('')
}
