import type { PluginOptions } from 'claude-code'
import { fitsOption, isUnset, type Option, type Options } from '../options.js'
import { configFolders } from '../records.js'
import { listed, messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'

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

export function createOptions({ name, declared, fromClaude, claude, changed }: { readonly name: string; readonly declared: Options; readonly fromClaude: PluginOptions; readonly claude: Claude; readonly changed: () => void }): ModOptions {
  let values: Readonly<Record<string, unknown>> = merged(declared, fromClaude, {}, new Set())
  let locked: Set<string> | undefined
  let loadedRoot: string | undefined

  const readLocked = async () => {
    if (Object.keys(declared).length === 0) return new Set<string>()
    const rows = await claude.config.list().catch((error: unknown) => {
      claude.ui.log(`${name} could not read /config, so a project's options.json may override a value your organization set: ${messageOf(error)}`, { to: 'debug' })
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
    const ignore = (reason: string) => claude.ui.log(`${path} ${reason}`)
    let file: unknown
    try {
      file = JSON.parse(await claude.fs.read(path))
    } catch (error) {
      ignore(`is not JSON (${messageOf(error)}). Fix the file; ${name} uses its other options until then.`)
      return {}
    }
    if (typeof file !== 'object' || file === null || Array.isArray(file)) {
      ignore('is not a JSON object. Write one, such as { "branch": "main" }.')
      return {}
    }
    const kept: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(file)) {
      const option = declared[key]
      if (option === undefined) ignore(`sets ${key}, which ${name} does not declare. ${Object.keys(declared).length === 0 ? 'Remove it.' : `Remove it, or use one of: ${Object.keys(declared).join(', ')}.`}`)
      else if (option.kind === 'secret') ignore(`sets ${key}, a secret, and a project file is committed for everyone to read. Remove it, and set it in /config.`)
      else {
        const misfit = fitsOption(option, value)
        if (misfit === undefined) kept[key] = value
        else ignore(`sets ${key} to ${JSON.stringify(value)}, and ${option.title} ${misfit}.`)
      }
    }
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
  return option.default ?? (option.kind === 'list' ? Object.freeze([]) : option.kind === 'number' ? undefined : '')
}
