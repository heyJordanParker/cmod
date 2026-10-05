export type InstallRecord = {
  name: string
  version: string
  root: string
  installedAt: string
  scriptsSha256: string
  uninstall: string | null
  program: string | null
}

export type Steps = { install?: string; uninstall?: string; program?: string }

export type ReadFile = (path: string) => Promise<string | undefined>

export type RunnerEvent =
  | { kind: 'progress'; done: number; total: number; label: string }
  | { kind: 'log'; text: string }
  | { kind: 'needs-consent'; sha256: string; install: string; uninstall: string }
  | { kind: 'done'; name: string; version?: string }
  | { kind: 'missing'; name: string }
  | { kind: 'failed'; code: number; message: string }

const pluginName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function storeFolder(env: Record<string, string | undefined>): string {
  const dataHome = env['XDG_DATA_HOME']
  const home = env['HOME']
  if (dataHome) return `${dataHome}/cmod`
  if (!home) throw new Error('Neither XDG_DATA_HOME nor HOME is set, so the CMod store has no folder. Set HOME.')
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
    throw new Error(`${path} is not JSON (${(error as Error).message}). ${fix}`)
  }
  if (!isObject(value)) throw new Error(`${path} is not a CMod install record. ${fix}`)
  for (const key of ['name', 'version', 'root', 'installedAt', 'scriptsSha256'] as const) {
    if (typeof value[key] !== 'string') throw new Error(`${path} has no "${key}" text. ${fix}`)
  }
  const uninstall = value['uninstall']
  if (uninstall !== null && typeof uninstall !== 'string') throw new Error(`${path} has an "uninstall" that is neither a path nor null. ${fix}`)
  const program = value['program']
  if (program !== null && typeof program !== 'string') throw new Error(`${path} has a "program" that is neither a command name nor null. ${fix}`)
  return {
    name: value['name'] as string,
    version: value['version'] as string,
    root: value['root'] as string,
    installedAt: value['installedAt'] as string,
    scriptsSha256: value['scriptsSha256'] as string,
    uninstall,
    program,
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
  return { ...readCommand(steps, 'install'), ...readCommand(steps, 'uninstall'), ...(program === undefined ? {} : { program }) }
}

function readCommand(steps: Record<string, unknown>, key: 'install' | 'uninstall'): Steps {
  const command = steps[key]
  if (command === undefined) return {}
  if (typeof command !== 'string' || command.trim() === '') throw new Error(`package.json "cmod.${key}" must be a command, such as "./setup/${key}.sh".`)
  if (/[\n\t]/.test(command)) throw new Error(`package.json "cmod.${key}" holds a line break or a tab. Write one command, such as "./setup/${key}.sh".`)
  return { [key]: command }
}

export function scriptPaths(command: string): string[] {
  const words = command
    .split(/[\s;&|()<>]+/)
    .map((word) => word.replace(/^['"]|['"]$/g, ''))
    .filter((word) => word !== '' && !word.startsWith('-') && !word.startsWith('/') && !word.startsWith('~') && !word.startsWith('$') && !word.includes('=') && !word.split('/').includes('..'))
  return [...new Set(words)]
}

export async function scriptsSha256(steps: Steps, files: { read: ReadFile; list: (folder: string) => Promise<string[]> }): Promise<string> {
  const commands = [steps.install ?? '', steps.uninstall ?? '']
  let text = [...commands, steps.program ?? ''].join('\0')
  const folders = new Set<string>()
  for (const path of new Set(commands.flatMap(scriptPaths))) {
    if ((await files.read(path)) !== undefined) folders.add(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.')
  }
  for (const folder of [...folders].sort()) {
    for (const name of (await files.list(folder)).sort()) text += `\0${folder}/${name}\0${(await files.read(`${folder}/${name}`)) ?? ''}`
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
      return `needs-consent ${event.sha256}\t${event.install}\t${event.uninstall}`
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
  const consent = /^needs-consent (\S+)\t([^\t]*)\t(.*)$/.exec(line)
  if (consent !== null) return { kind: 'needs-consent', sha256: consent[1] as string, install: consent[2] as string, uninstall: consent[3] as string }
  const done = /^done (\S+)(?: (\S+))?$/.exec(line)
  if (done !== null) return { kind: 'done', name: done[1] as string, ...(done[2] === undefined ? {} : { version: done[2] }) }
  const missing = /^missing (\S+)$/.exec(line)
  if (missing !== null) return { kind: 'missing', name: missing[1] as string }
  const failed = /^failed (-?\d+)(?:\t(.*))?$/.exec(line)
  if (failed !== null) return { kind: 'failed', code: Number(failed[1]), message: failed[2] ?? '' }
  return { kind: 'log', text: line.replace(/^log /, '') }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
