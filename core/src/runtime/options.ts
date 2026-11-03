import type { PluginOptions } from 'claude-code'
import { fitsOption, isUnset, projectOptionsOf, type Option, type Options } from '../options.js'
import { configFolders } from '../records.js'
import { listed, messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import type { Failure } from './toaster.js'

export class MissingOptions extends Error {
  readonly keys: readonly string[]
  readonly titles: readonly string[]

  constructor(keys: readonly string[], titles: readonly string[]) {
    super(`it needs ${listed(titles)}`)
    this.keys = keys
    this.titles = titles
  }
}

export type ModOptions = {
  readonly values: Readonly<Record<string, unknown>>
  readonly missing: readonly string[]
  load(root: string): Promise<void>
}

export function createOptions({
  name,
  declared,
  fromClaude,
  claude,
  report,
  changed,
}: {
  readonly name: string
  readonly declared: Options
  readonly fromClaude: PluginOptions
  readonly claude: Claude
  readonly report: (failure: Failure) => void
  readonly changed: () => void
}): ModOptions {
  let values: Readonly<Record<string, unknown>> = merged(declared, fromClaude, {}, new Set())
  let locked: Set<string> | undefined
  let loadedRoot: string | undefined

  const readLocked = async () => {
    if (Object.keys(declared).length === 0) return new Set<string>()
    const rows = await claude.config.list().catch((error: unknown) => {
      claude.ui.warn('options:config', `${name} could not read /config, so a project's options.json may override a value your organization set: ${messageOf(error)}`)
      return []
    })
    return new Set(rows.filter((row) => row.isLocked && row.key.startsWith(`${name}.`)).map((row) => row.key.slice(name.length + 1)))
  }

  const readProject = async (root: string): Promise<Record<string, unknown>> => {
    const env = { HOME: await claude.env.home(), CLAUDE_CONFIG_DIR: await claude.env.configHome() }
    const project = configFolders(env, name, root).find(({ tier }) => tier === 'project')
    if (project === undefined) return {}
    const path = `${project.folder}/options.json`
    if (!(await claude.fs.exists(path))) return {}
    const { values: kept, ignored } = projectOptionsOf(name, declared, await claude.fs.read(path))
    for (const reason of ignored) report({ id: `options:${path} ${reason}`, message: `Ignores part of ${path}`, description: `${path} ${reason}` })
    return kept
  }

  return {
    get values() {
      return values
    },
    get missing() {
      return Object.entries(declared)
        .filter(([key, option]) => option.default === undefined && isUnset(values[key]))
        .map(([key]) => key)
    },
    async load(root) {
      if (Object.keys(declared).length === 0) return
      locked ??= await readLocked()
      const project = await readProject(root)
      const isFirst = loadedRoot === undefined
      loadedRoot = root
      const next = merged(declared, fromClaude, project, locked)
      if (!isFirst && JSON.stringify(next) === JSON.stringify(values)) return
      values = next
      if (!isFirst) changed()
    },
  }
}

function merged(declared: Options, fromClaude: PluginOptions, project: Readonly<Record<string, unknown>>, locked: ReadonlySet<string>): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(Object.entries(declared).map(([key, option]) => [key, valueOf(key, option, fromClaude[key], project, locked)])))
}

function valueOf(key: string, option: Option, own: unknown, project: Readonly<Record<string, unknown>>, locked: ReadonlySet<string>): unknown {
  if (locked.has(key)) return own
  if (Object.hasOwn(project, key)) return project[key]
  if (!isUnset(own) && fitsOption(option, own) === undefined) return Array.isArray(own) ? Object.freeze([...own]) : own
  return option.default ?? (option.type === 'list' ? Object.freeze([]) : option.type === 'number' ? undefined : '')
}
