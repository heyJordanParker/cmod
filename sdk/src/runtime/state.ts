import type { ClassicHookInputs } from 'claude-code'
import { configFolder, configFolders } from '../records.js'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'

type Lifetime = 'memory' | 'session' | 'project' | 'global'

type SavedLifetime = Exclude<Lifetime, 'memory'>

type Groups = Record<Lifetime, Record<string, unknown>>

export type StateOptions = {
  readonly name: string
  readonly initial: object
  readonly session: string
  readonly root: string
  readonly claude: Claude
  readonly changed: () => void
}

export type ModState<State extends object> = {
  readonly state: State
  readonly root: string
  load(): Promise<void>
  moveTo(root: string): Promise<void>
  switchSession(session: string, source: ClassicHookInputs['SessionStart']['source']): Promise<void>
}

const lifetimes: readonly Lifetime[] = ['memory', 'session', 'project', 'global']

const savedLifetimes: readonly SavedLifetime[] = ['session', 'project', 'global']

const keptPerValue = 20

export function createState<State extends object>({ name, initial, session, root, claude, changed }: StateOptions): ModState<State> {
  const declared = declaredGroups(name, initial)
  const current = copied(declared)
  let defaults = declared
  let projectRoot = root
  let sessionId = session
  let turn: Promise<unknown> = Promise.resolve()

  const inTurn = <Result>(task: () => Promise<Result>): Promise<Result> => {
    const run = turn.then(task)
    turn = run.catch(() => undefined)
    return run
  }

  const ownersKey = (lifetime: Exclude<SavedLifetime, 'global'>, key: string) => `${name}.${key}.${lifetime === 'project' ? 'projects' : 'sessions'}.`

  const storeKey = (lifetime: SavedLifetime, key: string, owner: string) => (lifetime === 'global' ? `${name}.${key}` : `${ownersKey(lifetime, key)}${owner}`)

  const read = (lifetime: SavedLifetime, key: string, owner: string) => claude.store.get(storeKey(lifetime, key, owner))

  const write = async (lifetime: SavedLifetime, key: string, value: unknown, owner: string) => {
    if (lifetime === 'global') return claude.store.set(storeKey(lifetime, key, owner), value)
    await claude.store.delete(storeKey(lifetime, key, owner))
    await claude.store.set(storeKey(lifetime, key, owner), value)
    const owners = (await claude.store.keys()).filter((stored) => stored.startsWith(ownersKey(lifetime, key)))
    for (const oldest of owners.slice(0, -keptPerValue)) await claude.store.delete(oldest)
  }

  const fileValues = (path: string, tier: 'system' | 'project', text: string, systemPath: string) => {
    const values: [SavedLifetime, string, unknown][] = []
    const ignore = (reason: string) => claude.ui.log(`${path} ${reason}`)
    let file: unknown
    try {
      file = JSON.parse(text)
    } catch (error) {
      ignore(`is not JSON (${messageOf(error)}). Fix the file, then run /reload-plugins.`)
      return values
    }
    if (!isPlainObject(file)) {
      ignore('is not a JSON object. Write one, such as { "global": { "key": "value" } }.')
      return values
    }
    for (const [group, entries] of Object.entries(file)) {
      if (!isLifetime(group)) {
        ignore(`sets ${group}, which ${name} does not declare. Remove it, or use one of: ${savedLifetimes.join(', ')}.`)
        continue
      }
      if (group === 'memory') {
        ignore('sets memory, and memory values are never saved, so a file cannot set them. Remove it.')
        continue
      }
      if (!isPlainObject(entries)) {
        ignore(`sets ${group} to ${typeOf(entries)}. Write an object of values, such as { "${group}": { "key": "value" } }.`)
        continue
      }
      for (const [key, value] of Object.entries(entries)) {
        const choices = Object.keys(declared[group])
        const wanted = typeOf(declared[group][key])
        if (!Object.hasOwn(declared[group], key)) ignore(`sets ${group}.${key}, which ${name} does not declare. ${choices.length === 0 ? 'Remove it.' : `Remove it, or use one of: ${choices.join(', ')}.`}`)
        else if (tier === 'project' && group === 'global') ignore(`sets ${group}.${key}, and one repository cannot change a value for every project. Move it to ${systemPath}.`)
        else if (typeOf(value) !== wanted) ignore(`sets ${group}.${key} to ${typeOf(value)}, and ${name} keeps ${wanted} there. Write ${wanted}, or remove it.`)
        else values.push([group, key, frozen(name, `${group}.${key}`, value)])
      }
    }
    return values
  }

  const readDefaults = async (nextRoot: string): Promise<Groups> => {
    const env = { HOME: await claude.env.home(), CLAUDE_CONFIG_DIR: await claude.env.configHome() }
    const systemPath = `${configFolder(env, name)}/state.json`
    const next = copied(declared)
    for (const { tier, folder } of configFolders(env, name, nextRoot)) {
      const path = `${folder}/state.json`
      if (!(await claude.fs.exists(path))) continue
      for (const [lifetime, key, value] of fileValues(path, tier, await claude.fs.read(path), systemPath)) next[lifetime][key] = value
    }
    return next
  }

  const loadGroups = async (only: readonly Lifetime[], next: { readonly root: string; readonly session: string; readonly defaults: Groups }) => {
    const loaded: [Lifetime, string, unknown][] = []
    for (const lifetime of only) {
      for (const key of Object.keys(declared[lifetime])) loaded.push([lifetime, key, lifetime === 'memory' ? undefined : await read(lifetime, key, lifetime === 'project' ? next.root : next.session)])
    }
    projectRoot = next.root
    sessionId = next.session
    defaults = next.defaults
    for (const [lifetime, key, saved] of loaded) current[lifetime][key] = saved === undefined ? defaults[lifetime][key] : frozen(name, `${lifetime}.${key}`, saved)
    changed()
  }

  const copySession = async (nextSession: string) => {
    for (const key of Object.keys(declared.session)) {
      const saved = await read('session', key, sessionId)
      if (saved !== undefined) await write('session', key, saved, nextSession)
    }
  }

  const group = (lifetime: Lifetime) =>
    new Proxy(current[lifetime], {
      set(target, key, value) {
        if (typeof key !== 'string') throw new Error(`${name}: mod.state.${lifetime} keys are text, not ${String(key)}.`)
        if (!Object.hasOwn(declared[lifetime], key)) throw new Error(`${name}: mod.state.${lifetime}.${key} is not declared. Add it to state.${lifetime} in defineMod with its starting value.`)
        if (Object.is(target[key], value)) return true
        target[key] = frozen(name, `${lifetime}.${key}`, value)
        if (lifetime !== 'memory') {
          const owner = lifetime === 'project' ? projectRoot : sessionId
          inTurn(() => write(lifetime, key, value, owner)).catch((error: unknown) => {
            claude.ui.log(`${name} could not keep state.${lifetime}.${key}: ${messageOf(error)}. Keep only JSON data in mod.state.`)
          })
        }
        changed()
        return true
      },
    })

  const state = Object.freeze(Object.fromEntries(Object.keys(initial).map((lifetime) => [lifetime, group(lifetime as Lifetime)]))) as State

  return {
    state,
    get root() {
      return projectRoot
    },
    load: () => inTurn(async () => loadGroups(lifetimes, { root: projectRoot, session: sessionId, defaults: await readDefaults(projectRoot) })),
    moveTo: (nextRoot) =>
      inTurn(async () => (nextRoot === projectRoot ? undefined : loadGroups(['project'], { root: nextRoot, session: sessionId, defaults: await readDefaults(nextRoot) }))),
    switchSession: (nextSession, source) =>
      inTurn(async () => {
        if (nextSession === sessionId) return
        if (source === 'fork') await copySession(nextSession)
        return loadGroups(['memory', 'session'], { root: projectRoot, session: nextSession, defaults })
      }),
  }
}

function declaredGroups(name: string, initial: object): Groups {
  const groups: Groups = { memory: {}, session: {}, project: {}, global: {} }
  for (const [lifetime, values] of Object.entries(initial)) {
    if (!isLifetime(lifetime)) throw new Error(`${name}: state.${lifetime} is not a lifetime. Put each value in state.memory, state.session, state.project, or state.global.`)
    if (!isPlainObject(values)) throw new Error(`${name}: state.${lifetime} is not an object of values. Write state: { ${lifetime}: { key: value } }.`)
    for (const [key, value] of Object.entries(values)) groups[lifetime][key] = frozen(name, `${lifetime}.${key}`, value)
  }
  return groups
}

function copied(groups: Groups): Groups {
  return { memory: { ...groups.memory }, session: { ...groups.session }, project: { ...groups.project }, global: { ...groups.global } }
}

function isLifetime(group: string): group is Lifetime {
  return (lifetimes as readonly string[]).includes(group)
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  if (value === undefined) return 'nothing'
  return `a ${typeof value}`
}

function frozen(name: string, path: string, value: unknown): unknown {
  const isArray = Array.isArray(value)
  if (!isArray && !isPlainObject(value)) return value
  const copy = isArray ? value.map((item) => frozen(name, path, item)) : Object.fromEntries(Object.entries(value).map(([field, item]) => [field, frozen(name, path, item)]))
  const example = isArray ? `mod.state.${path} = [...mod.state.${path}, item]` : `mod.state.${path} = { ...mod.state.${path}, field: value }`
  const refuse = (): never => {
    throw new Error(`${name}: mod.state.${path} cannot change in place. Assign it a new value, such as ${example}, so the mod redraws and keeps it.`)
  }
  return new Proxy(Object.freeze(copy), { set: refuse, defineProperty: refuse, deleteProperty: refuse })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
