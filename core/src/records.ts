import { listed, messageOf } from './utils/text.js'

export type InstallRecord = {
  name: string
  version: string
  root: string
  installedAt: string
  scriptsSha256: string
  uninstall: string | null
  program: string | null
  keys: Readonly<Record<string, string>>
}

export type Steps = {
  install?: string
  uninstall?: string
  program?: string
  keys?: Readonly<Record<string, string>>
  permissions?: readonly string[]
}

export const listPermissions = ['network', 'run', 'files'] as const
export const flagPermissions = ['conversation', 'prompt', 'model', 'agents', 'tools', 'config', 'approve'] as const
export type ListPermission = (typeof listPermissions)[number]
export type FlagPermission = (typeof flagPermissions)[number]
const permissionNames: readonly string[] = [...listPermissions, ...flagPermissions]
const hostName = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/
const programName = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

export type ReadFile = (path: string) => Promise<string | undefined>

export type RunnerEvent =
  | { kind: 'progress'; done: number; total: number; label: string }
  | { kind: 'log'; text: string }
  | { kind: 'needs-consent'; sha256: string; install: string; uninstall: string; keys: string; permissions: readonly string[] }
  | { kind: 'done'; name: string; version?: string }
  | { kind: 'missing'; name: string }
  | { kind: 'failed'; code: number; message: string }

export const pluginName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function storeFolder(env: Record<string, string | undefined>): string {
  const dataHome = env['XDG_DATA_HOME']
  const home = env['HOME']
  if (dataHome) return `${dataHome}/cmod`
  if (!home) throw new Error('Neither XDG_DATA_HOME nor HOME is set, so the cmod store has no folder. Set HOME.')
  return `${home}/.local/share/cmod`
}

export function recordPath(store: string, name: string): string {
  return `${store}/records/${checkedName(name)}.json`
}

export function dataFolder(store: string, name: string): string {
  return `${store}/data/${checkedName(name)}`
}

export function configFolder(env: Record<string, string | undefined>, name: string): string {
  const configRoot = env['CLAUDE_CONFIG_DIR']
  const home = env['HOME']
  if (configRoot) return `${configRoot}/cmods/${checkedName(name)}`
  if (!home) throw new Error(`Neither CLAUDE_CONFIG_DIR nor HOME is set, so ${name} has no config folder. Set HOME.`)
  return `${home}/.claude/cmods/${checkedName(name)}`
}

export function configFolders(env: Record<string, string | undefined>, name: string, root: string): { readonly tier: 'system' | 'project'; readonly folder: string }[] {
  return [
    { tier: 'system', folder: configFolder(env, name) },
    { tier: 'project', folder: `${root}/.claude/cmods/${checkedName(name)}` },
  ]
}

function checkedName(name: string): string {
  if (!pluginName.test(name) || name.includes('..')) {
    throw new Error(`"${name}" is not a plugin name: use letters, digits, ".", "_", and "-", starting with a letter or digit.`)
  }
  return name
}

export async function readRecord(read: ReadFile, store: string, name: string): Promise<InstallRecord | undefined> {
  const path = recordPath(store, name)
  const text = await read(path)
  if (text === undefined) return undefined
  return parseRecord(text, path)
}

export async function writeRecord(write: (path: string, text: string) => Promise<void>, store: string, record: InstallRecord): Promise<void> {
  await write(recordPath(store, record.name), `${JSON.stringify(record, null, 2)}\n`)
}

function parseRecord(text: string, path: string): InstallRecord {
  const fix = `Delete ${path} and run cmod setup on the plugin again.`
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} is not JSON (${messageOf(error)}). ${fix}`)
  }
  if (!isObject(value)) throw new Error(`${path} is not a cmod install record. ${fix}`)
  for (const key of ['name', 'version', 'root', 'installedAt', 'scriptsSha256'] as const) {
    if (typeof value[key] !== 'string') throw new Error(`${path} has no "${key}" text. ${fix}`)
  }
  const uninstall = value['uninstall']
  if (uninstall !== null && typeof uninstall !== 'string') throw new Error(`${path} has an "uninstall" that is neither a path nor null. ${fix}`)
  const program = value['program']
  if (program !== null && typeof program !== 'string') throw new Error(`${path} has a "program" that is neither a command name nor null. ${fix}`)
  const keys = value['keys'] ?? {}
  if (!isObject(keys) || Object.values(keys).some((command) => typeof command !== 'string')) throw new Error(`${path} has "keys" that are not key bindings. ${fix}`)
  return {
    name: value['name'] as string,
    version: value['version'] as string,
    root: value['root'] as string,
    installedAt: value['installedAt'] as string,
    scriptsSha256: value['scriptsSha256'] as string,
    uninstall,
    program,
    keys: keys as Record<string, string>,
  }
}

export function readSteps(pkg: unknown): Steps | undefined {
  if (pkg === undefined) return undefined
  if (!isObject(pkg)) throw new Error('package.json is not a JSON object.')
  const steps = pkg['cmod']
  if (steps === undefined) return undefined
  if (!isObject(steps)) throw new Error('package.json has a "cmod" key that is not an object. Write "cmod": { "install": "./setup/install.sh", "uninstall": "./setup/uninstall.sh" }.')
  const program = steps['program']
  if (program !== undefined && (typeof program !== 'string' || !pluginName.test(program))) throw new Error('package.json "cmod.program" must be the program\'s command, such as "hello".')
  const permissions = readPermissions(steps)
  return {
    ...readCommand(steps, 'install'),
    ...readCommand(steps, 'uninstall'),
    ...(program === undefined ? {} : { program }),
    ...readKeys(steps['keys']),
    ...(permissions.length === 0 ? {} : { permissions }),
  }
}

function readPermissions(steps: Record<string, unknown>): string[] {
  const declared = steps['permissions']
  if (declared === undefined) return []
  const at = 'package.json "cmod.permissions"'
  if (!isObject(declared)) throw new Error(`${at} must be an object, such as { "network": ["api.github.com"], "prompt": true }.`)
  const items: string[] = []
  for (const [name, value] of Object.entries(declared)) {
    if (!permissionNames.includes(name)) throw new Error(`${at} names "${name}", which is not a permission. Use ${listed(permissionNames.map((each) => `"${each}"`))}.`)
    if ((flagPermissions as readonly string[]).includes(name)) {
      if (value !== true) throw new Error(`${at} sets "${name}" to ${JSON.stringify(value)}. Write "${name}": true, or leave it out.`)
      items.push(name)
      continue
    }
    if (name === 'run' && value === '*') {
      items.push('run:*')
      continue
    }
    const example = name === 'network' ? '["api.github.com"]' : name === 'run' ? '["gh"], or "*" for any program' : '["~/.zshrc"]'
    if (!Array.isArray(value) || value.length === 0 || !value.every((each) => typeof each === 'string')) throw new Error(`${at} sets "${name}" to ${JSON.stringify(value)}. Write a list, such as "${name}": ${example}.`)
    for (const each of value as string[]) {
      const isPath = /^(~\/|\/)/.test(each) && !each.split('/').includes('..')
      const isValid = name === 'network' ? hostName.test(each) || isPath : name === 'run' ? programName.test(each) : isPath
      if (!isValid) throw new Error(`${at} lists "${each}" under "${name}". Write ${name === 'network' ? 'a host alone, such as "api.github.com", or a socket path, such as "/var/run/docker.sock"' : name === 'run' ? 'a program\'s command, such as "gh"' : 'a path that starts with ~/ or /, such as "~/.zshrc"'}.`)
      items.push(`${name}:${each}`)
    }
  }
  return items
}

export function permissionWords(item: string): string {
  const split = item.indexOf(':')
  const target = item.slice(split + 1)
  switch (split === -1 ? item : item.slice(0, split)) {
    case 'network':
      return `Connect to ${target}`
    case 'run':
      return target === '*' ? 'Run any program on your computer' : `Run ${target} on your computer`
    case 'files':
      return `Change ${target}`
    case 'conversation':
      return 'Read this conversation'
    case 'prompt':
      return 'Add text Claude reads and start turns'
    case 'model':
      return 'Ask a model, which uses your plan'
    case 'agents':
      return 'Start agents'
    case 'tools':
      return "Use and change Claude's tool calls"
    case 'config':
      return 'Change your Claude Code settings'
    case 'approve':
      return "Approve Claude's tool calls for you"
    default:
      return item
  }
}

export const settingsPagesMethod = 'cmod:settingsPages'

export const openPageMethod = 'cmod:openPage'

export const pendingStepsMethod = 'cmod:pendingSteps'

export const finishStepsMethod = 'cmod:finishSteps'

export function consentPath(store: string): string {
  return `${store}/consent.json`
}

export function parseConsent(value: unknown, path: string): Record<string, string[]> {
  if (value === undefined) return Object.create(null)
  if (!isObject(value) || Object.values(value).some((items) => !Array.isArray(items) || items.some((item) => typeof item !== 'string'))) {
    throw new Error(`${path} is not a map of plugin names to what each was approved for. Delete it, and cmod asks again.`)
  }
  return Object.assign(Object.create(null), value) as Record<string, string[]>
}

function readKeys(keys: unknown): Steps {
  if (keys === undefined) return {}
  if (!isObject(keys) || Object.keys(keys).length === 0) throw new Error('package.json "cmod.keys" must bind each key to a command, such as "keys": { "shift+tab": "/mode" }.')
  const commands: Record<string, string> = {}
  for (const [key, value] of Object.entries(keys)) {
    const command = typeof value === 'string' ? /^\/([A-Za-z0-9][A-Za-z0-9._:-]*)$/.exec(value)?.[1] : undefined
    if (key.trim() === '' || command === undefined) throw new Error(`package.json "cmod.keys" binds "${key}" to ${JSON.stringify(value)}. Bind each key to one of the mod's commands, such as "shift+tab": "/mode".`)
    commands[key] = command
  }
  return { keys: commands }
}

export function oldestCmodFor(steps: Steps): string {
  if (steps.permissions !== undefined) return '0.2.0'
  return Object.keys(steps.keys ?? {}).length > 0 ? '0.1.12' : '0.0.0'
}

export function keyWords(keys: Readonly<Record<string, string>> | undefined): string {
  return listed(Object.entries(keys ?? {}).map(([key, command]) => `${key} to /${command}`))
}

function readCommand(steps: Record<string, unknown>, key: 'install' | 'uninstall'): Steps {
  const command = steps[key]
  if (command === undefined) return {}
  if (typeof command !== 'string' || command.trim() === '') throw new Error(`package.json "cmod.${key}" must be a command, such as "./setup/${key}.sh".`)
  if (/[\n\t]/.test(command)) throw new Error(`package.json "cmod.${key}" holds a line break or a tab. Write one command, such as "./setup/${key}.sh".`)
  const atRoot = scriptPaths(command).find((path) => folderOf(path) === '.')
  if (atRoot !== undefined) throw new Error(`package.json "cmod.${key}" names ${atRoot}, a script at the plugin root. Move it into a folder, such as ./setup/${key}.sh: cmod asks consent for the whole folder of each script.`)
  return { [key]: command }
}

export function scriptPaths(command: string): string[] {
  const words = command
    .split(/[\s;&|()<>]+/)
    .map((word) => word.replace(/^['"]|['"]$/g, ''))
    .filter((word) => word.includes('/') && !word.startsWith('-') && !word.startsWith('/') && !word.startsWith('~') && !word.startsWith('$') && !word.includes('=') && !word.split('/').includes('..'))
  return [...new Set(words)]
}

function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

export async function scriptsSha256(steps: Steps, files: { read: ReadFile; list: (folder: string) => Promise<string[]> }): Promise<string> {
  const folders = new Set<string>()
  for (const key of ['install', 'uninstall'] as const) {
    const command = steps[key]
    if (command === undefined) continue
    const scriptFolders: string[] = []
    for (const path of scriptPaths(command)) {
      if ((await files.read(path)) !== undefined) scriptFolders.push(folderOf(path))
    }
    if (scriptFolders.length === 0) throw new Error(`package.json "cmod.${key}" runs "${command}", which names no script file in the mod, so consent cannot cover what it runs. Put the commands in a script, such as ./setup/${key}.sh.`)
    for (const folder of scriptFolders) folders.add(folder)
  }
  let text = [
    steps.install ?? '',
    steps.uninstall ?? '',
    steps.program ?? '',
    ...(steps.keys === undefined ? [] : [JSON.stringify(Object.entries(steps.keys).sort())]),
    ...(steps.permissions === undefined ? [] : [JSON.stringify([...steps.permissions].sort())]),
  ].join('\0')
  for (const folder of [...folders].sort()) {
    for (const name of (await files.list(folder)).sort()) {
      const path = `${folder}/${name}`
      const content = await files.read(path)
      if (content === undefined) throw new Error(`${path} links to a folder or to nothing, so consent cannot cover it. Point the link at a file, or delete it.`)
      text += `\0${path}\0${content}`
    }
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function formatEvent(event: RunnerEvent): string {
  switch (event.kind) {
    case 'progress':
      return `progress ${event.done} ${event.total}${event.label === '' ? '' : ` ${event.label}`}`
    case 'log':
      return `log ${event.text}`
    case 'needs-consent':
      return `needs-consent ${[event.sha256, event.install, event.uninstall, event.keys, ...event.permissions].join('\t')}`
    case 'done':
      return event.version === undefined ? `done ${event.name}` : `done ${event.name} ${event.version}`
    case 'missing':
      return `missing ${event.name}`
    case 'failed':
      return `failed ${event.code}\t${event.message.replace(/\s*\n\s*/g, ' ')}`
  }
}

export function parseEvent(line: string): RunnerEvent {
  const progress = /^progress (\d+) (\d+)(?: (.*))?$/.exec(line)
  if (progress !== null) return { kind: 'progress', done: Number(progress[1]), total: Number(progress[2]), label: progress[3] ?? '' }
  const consent = /^needs-consent (\S+)\t([^\t]*)\t([^\t]*)(?:\t(.*))?$/.exec(line)
  if (consent !== null) {
    const [keys = '', ...permissions] = (consent[4] ?? '').split('\t')
    return { kind: 'needs-consent', sha256: consent[1] as string, install: consent[2] as string, uninstall: consent[3] as string, keys, permissions: permissions.filter((item) => item !== '') }
  }
  const done = /^done (\S+)(?: (\S+))?$/.exec(line)
  if (done !== null) return { kind: 'done', name: done[1] as string, ...(done[2] === undefined ? {} : { version: done[2] }) }
  const missing = /^missing (\S+)$/.exec(line)
  if (missing !== null) return { kind: 'missing', name: missing[1] as string }
  const failed = /^failed (-?\d+)(?:\t(.*))?$/.exec(line)
  if (failed !== null) return { kind: 'failed', code: Number(failed[1]), message: failed[2] ?? '' }
  return { kind: 'log', text: line.replace(/^log /, '') }
}

export function isAtLeast(version: string, minimum: string): boolean {
  const parts = version.split('.').map(Number)
  const least = minimum.split('.').map(Number)
  for (let index = 0; index < Math.max(parts.length, least.length); index += 1) {
    const difference = (parts[index] ?? 0) - (least[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
