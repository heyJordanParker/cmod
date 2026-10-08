import type { ClassicHookInputs } from 'claude-code'
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
  changed(): void
  load(): Promise<void>
  moveTo(root: string): Promise<void>
  switchSession(session: string, source: ClassicHookInputs['SessionStart']['source']): Promise<void>
}

const lifetimes: readonly Lifetime[] = ['memory', 'session', 'project', 'global']

const keptPerValue = 20

const listeners = new WeakMap<object, Set<() => void>>()

export function onStateChange(state: object, listener: () => void): void {
  const own = listeners.get(state) ?? new Set()
  own.add(listener)
  listeners.set(state, own)
}

export function createState<State extends object>({ name, initial, session, root, claude, changed: redraw }: StateOptions): ModState<State> {
  const changed = () => {
    redraw()
    for (const listener of listeners.get(state) ?? []) listener()
  }
  const declared = declaredGroups(name, initial)
  const current = copied(declared)
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

  const loadGroups = async (only: readonly Lifetime[], next: { readonly root: string; readonly session: string }) => {
    const loaded: [Lifetime, string, unknown][] = []
    for (const lifetime of only) {
      for (const key of Object.keys(declared[lifetime])) loaded.push([lifetime, key, lifetime === 'memory' ? undefined : await read(lifetime, key, lifetime === 'project' ? next.root : next.session)])
    }
    projectRoot = next.root
    sessionId = next.session
    for (const [lifetime, key, saved] of loaded) current[lifetime][key] = saved === undefined ? declared[lifetime][key] : frozen(name, `${lifetime}.${key}`, saved)
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
    changed,
    load: () => inTurn(() => loadGroups(lifetimes, { root: projectRoot, session: sessionId })),
    moveTo: (nextRoot) => inTurn(async () => (nextRoot === projectRoot ? undefined : loadGroups(['project'], { root: nextRoot, session: sessionId }))),
    switchSession: (nextSession, source) =>
      inTurn(async () => {
        if (nextSession === sessionId) return
        if (source === 'fork') await copySession(nextSession)
        return loadGroups(['memory', 'session'], { root: projectRoot, session: nextSession })
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
