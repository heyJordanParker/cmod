import { interfaceName, isObject, type ProgramInstance } from '../records.js'
import { matches, receivedMatcher, sentMatcher, type SentMatcher } from '../utils/matcher.js'
import type { Subscription } from '../utils/subscription.js'
import { cmodPluginName } from './dependencies.js'
import { addressCall, connectRpc, RpcError, rpcCodes, rpcRoutes, RpcUnreached, type HttpFetch, type Peer, type RpcClient, type RpcConnection, type RpcHandler, type RpcRoutes } from './rpc.js'

export type InterfaceName = `${string}/${string}`

export const listenMethod = '$/listen'

export const unlistenMethod = '$/unlisten'

export const onMethod = '$/on'

export const beforeMethod = '$/before'

export const sessionInterface = 'cmod/Session'

export const sessionStore = 'cmod/SessionStore'

export const terminalInterface = 'cmod/Terminal'

export const styleInterface = 'cmod/Style'

export const sessionActs = {
  hold: '$/hold',
  listeners: '$/listeners',
  act: '$/act',
  emit: '$/emit',
  ask: '$/ask',
  changed: '$/changed',
} as const

export type HeldSession = { readonly session: string; readonly project: string; readonly cwd: string }

export type SessionListening = Pick<Listening, 'id' | 'event' | 'kind' | 'matcher' | 'timeoutMs' | 'onFailure'> & { readonly isEvery: boolean; readonly extra: Readonly<Record<string, unknown>> }

export type VisitedAt = Readonly<Record<string, string>>

export type StoreChange = { readonly session: string; readonly part: 'visit' | 'running' | 'tasks' | 'goal' | 'deleted' }


export type ListenKind = 'on' | 'before'

export type Listening = {
  readonly id: string
  readonly interface: string
  readonly event: string
  readonly kind: ListenKind
  readonly args?: readonly unknown[]
  readonly matcher?: SentMatcher
  readonly timeoutMs?: number
  readonly onFailure?: 'pass' | 'refuse'
  readonly after?: string
  readonly extra?: Readonly<Record<string, unknown>>
}

export type Heard = { readonly id: string; readonly payload: unknown; readonly cursor?: string }

export type ListenOptions = { readonly timeoutMs?: number; readonly onFailure?: 'pass' | 'refuse' }

export type Provider = { readonly mod: string; readonly program: string; readonly address: string; readonly provides: readonly string[] }

export const interfaceMethods = { providers: 'cmod:providers', provided: 'cmod:provided', listen: 'cmod:listenProvided', unlisten: 'cmod:unlistenProvided', heard: 'cmod:heard' } as const

export type ProvidedCall = { readonly interface: string; readonly method: string; readonly args: readonly unknown[] } & Partial<ProviderIdentity>

export type InstanceFiles = {
  list(folder: string): Promise<readonly { readonly name: string; readonly kind: string }[]>
  read(path: string): Promise<string | undefined>
}

export async function readProviders(files: InstanceFiles, store: string, name: string): Promise<Provider[]> {
  const folder = `${store}/instances`
  const mods = (await files.list(folder)).filter((entry) => entry.kind === 'dir')
  const records = await Promise.all(
    mods.map(async (mod) =>
      Promise.all(
        (await files.list(`${folder}/${mod.name}`))
          .filter((file) => file.name.endsWith('.json'))
          .map(async (file) => ({ mod: mod.name, program: file.name.slice(0, -'.json'.length), instance: JSON.parse((await files.read(`${folder}/${mod.name}/${file.name}`)) ?? 'null') as unknown })),
      ),
    ),
  )
  return providersIn(records.flat(), name)
}

export function providersIn(records: readonly { readonly mod: string; readonly program: string; readonly instance: unknown }[], name: string): Provider[] {
  return records.flatMap(({ mod, program, instance }) => {
    if (!isObject(instance) || typeof instance['address'] !== 'string' || !Array.isArray(instance['provides'])) return []
    const provides = (instance as ProgramInstance).provides ?? []
    return provides.includes(name) ? [{ mod, program, address: instance['address'], provides }] : []
  })
}

export function checkInterfaceName(name: string): void {
  if (!interfaceName.test(name)) throw new Error(`${name} is no interface name, such as anyhost/Platform.`)
}

export function methodName(name: string, method: string): string {
  return `${name}.${method}`
}

export function isHeardAt(listening: Pick<Listening, 'args' | 'matcher'>, args: readonly unknown[], payload: unknown): boolean {
  const wanted = listening.args ?? []
  if (wanted.some((each, index) => each !== undefined && each !== '*' && each !== args[index])) return false
  return listening.matcher === undefined || matches(payload, receivedMatcher(listening.matcher))
}

export type Implementation = Readonly<Record<string, (...args: never[]) => unknown>>

export type InterfaceServer = {
  handler(connection: RpcConnection): RpcHandler
  emit(name: string, event: string, payload: unknown, args?: readonly unknown[]): void
  ask(name: string, event: string, payload: unknown, args?: readonly unknown[], signal?: AbortSignal): Promise<readonly { readonly listening: Listening; readonly answer: unknown }[]>
  listeners(name: string, event?: string): readonly (Listening & { readonly connection: RpcConnection })[]
  closed(connection: RpcConnection): void
}

const keptEvents = 500

export function interfaceServer({
  implementations,
  onListen,
  onUnlisten,
  extraMethod,
}: {
  readonly implementations: Readonly<Record<string, Implementation>>
  readonly onListen?: (connection: RpcConnection, listening: Listening) => void | Promise<void>
  readonly onUnlisten?: (connection: RpcConnection, listening: Listening) => void
  readonly extraMethod?: (connection: RpcConnection, method: string, params: unknown, signal: AbortSignal) => { readonly result: unknown } | undefined | Promise<{ readonly result: unknown } | undefined>
}): InterfaceServer {
  const held = new Map<RpcConnection, Map<string, Listening>>()
  const recent = new Map<string, { cursor: number; readonly kept: { readonly cursor: number; readonly args: readonly unknown[]; readonly payload: unknown }[] }>()

  const keyOf = (name: string, event: string) => `${name}\n${event}`

  const listeningOf = (params: unknown): Listening => {
    if (!isObject(params) || typeof params['id'] !== 'string' || typeof params['interface'] !== 'string' || typeof params['event'] !== 'string' || (params['kind'] !== 'on' && params['kind'] !== 'before')) throw new RpcError(rpcCodes.invalidParams, `${listenMethod} takes { id, interface, event, kind }.`)
    if (implementations[params['interface']] === undefined) throw new RpcError(rpcCodes.methodNotFound, `This program provides no ${params['interface']}.`)
    return params as Listening
  }

  const replay = (connection: RpcConnection, listening: Listening) => {
    if (listening.kind !== 'on' || listening.after === undefined) return
    const after = Number(listening.after)
    for (const each of recent.get(keyOf(listening.interface, listening.event))?.kept ?? []) {
      if (each.cursor > after && isHeardAt(listening, each.args, each.payload)) connection.notify(onMethod, { id: listening.id, payload: each.payload, cursor: String(each.cursor) } satisfies Heard)
    }
  }

  const server: InterfaceServer = {
    handler: (connection) => async (method, params, signal) => {
      if (method === listenMethod) {
        const listening = listeningOf(params)
        const list = held.get(connection) ?? new Map<string, Listening>()
        list.set(listening.id, listening)
        held.set(connection, list)
        await onListen?.(connection, listening)
        replay(connection, listening)
        return {}
      }
      if (method === unlistenMethod) {
        const id = isObject(params) ? params['id'] : undefined
        const listening = typeof id === 'string' ? held.get(connection)?.get(id) : undefined
        if (listening === undefined) return {}
        held.get(connection)?.delete(listening.id)
        onUnlisten?.(connection, listening)
        return {}
      }
      const extra = await extraMethod?.(connection, method, params, signal)
      if (extra !== undefined) return extra.result
      const dot = method.lastIndexOf('.')
      const implementation = dot === -1 ? undefined : implementations[method.slice(0, dot)]
      const run = implementation === undefined ? undefined : Object.hasOwn(implementation, method.slice(dot + 1)) ? implementation[method.slice(dot + 1)] : undefined
      if (run === undefined) throw new RpcError(rpcCodes.methodNotFound, `This program answers no ${method}.`)
      return (run as (...args: unknown[]) => unknown)(...(Array.isArray(params) ? params : []))
    },
    emit(name, event, payload, args = []) {
      const key = keyOf(name, event)
      const log = recent.get(key) ?? { cursor: 0, kept: [] }
      log.cursor += 1
      log.kept.push({ cursor: log.cursor, args, payload })
      if (log.kept.length > keptEvents) log.kept.shift()
      recent.set(key, log)
      for (const listening of server.listeners(name, event)) {
        if (listening.kind === 'on' && isHeardAt(listening, args, payload)) listening.connection.notify(onMethod, { id: listening.id, payload, cursor: String(log.cursor) } satisfies Heard)
      }
    },
    async ask(name, event, payload, args = [], signal) {
      const answers: { readonly listening: Listening; readonly answer: unknown }[] = []
      for (const listening of server.listeners(name, event)) {
        if (listening.kind !== 'before' || !isHeardAt(listening, args, payload)) continue
        const answer = await listening.connection.request(beforeMethod, { id: listening.id, payload } satisfies Heard, signal)
        answers.push({ listening, answer })
        if (isObject(answer) && typeof answer['refuse'] === 'string') break
      }
      return answers
    },
    listeners: (name, event) => [...held].flatMap(([connection, list]) => [...list.values()].filter((each) => each.interface === name && (event === undefined || each.event === event)).map((each) => ({ ...each, connection }))),
    closed(connection) {
      const list = held.get(connection)
      held.delete(connection)
      for (const listening of list?.values() ?? []) onUnlisten?.(connection, listening)
    },
  }
  return server
}

export type Listener = (payload: never, signal: AbortSignal) => unknown

type Registered = { readonly listening: Listening; readonly listener: Listener; cursor: string | undefined }

export type InterfaceListeners = {
  listen(request: Pick<Peer, 'request'>, listening: Omit<Listening, 'id'>, listener: Listener): Subscription
  handler(method: string, params: unknown, signal: AbortSignal): { readonly result: unknown } | undefined | Promise<{ readonly result: unknown }>
  replay(request: Pick<Peer, 'request'>): Promise<void>
}

export function interfaceListeners({ report: reportAll }: { readonly report: (error: unknown) => void }): InterfaceListeners {
  const registered = new Map<string, Registered>()
  let next = 0
  const report = (error: unknown) => {
    if (!(error instanceof RpcUnreached)) reportAll(error)
  }

  const send = (request: Pick<Peer, 'request'>, each: Registered) =>
    request.request(listenMethod, { ...each.listening, ...(each.cursor === undefined ? {} : { after: each.cursor }) } satisfies Listening)

  return {
    listen(request, listening, listener) {
      const id = `${(next += 1)}`
      const each: Registered = { listening: { ...listening, id }, listener, cursor: undefined }
      registered.set(id, each)
      void send(request, each).catch(report)
      return {
        remove() {
          if (!registered.delete(id)) return
          void request.request(unlistenMethod, { id }).catch(report)
        },
      }
    },
    handler(method, params, signal) {
      if (method !== onMethod && method !== beforeMethod) return undefined
      const heard = params as Heard
      const each = registered.get(heard.id)
      if (each === undefined) return method === beforeMethod ? Promise.resolve({ result: null }) : undefined
      if (heard.cursor !== undefined) each.cursor = heard.cursor
      if (method === onMethod) {
        void (async () => each.listener(heard.payload as never, signal))().catch(report)
        return undefined
      }
      return (async () => ({ result: (await each.listener(heard.payload as never, signal)) ?? null }))()
    },
    async replay(request) {
      await Promise.all([...registered.values()].map((each) => send(request, each).catch(report)))
    },
  }
}

export function listeningOf(name: string, kind: ListenKind, event: string, args: readonly unknown[], matcher: unknown, options: ListenOptions = {}): Omit<Listening, 'id'> {
  return {
    interface: name,
    event,
    kind,
    ...(args.length === 0 ? {} : { args }),
    ...(matcher === undefined ? {} : { matcher: sentMatcher(matcher) }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
  }
}

export type ProviderIdentity = { readonly mod: string; readonly program?: string }

export type ListenTo = (kind: ListenKind, event: string, matcher: unknown, listener: Listener, options: ListenOptions) => Subscription

export function providerClient(name: string, identity: ProviderIdentity, call: (method: string, args: readonly unknown[]) => Promise<unknown>, listen: ListenTo): Readonly<Record<string, unknown>> {
  return new Proxy(identity, {
    get: (known, key) => {
      if (typeof key !== 'string' || key === 'then') return undefined
      if (key === 'mod' || key === 'program') return known[key]
      const event = /^(on|before)([A-Z]\w*)$/.exec(key)
      if (event === null) return (...args: unknown[]) => call(key, args)
      return (...args: unknown[]) => {
        const hasMatcher = typeof args[1] === 'function'
        const listener = (hasMatcher ? args[1] : args[0]) as Listener
        if (typeof listener !== 'function') throw new Error(`${name}: ${key} takes a listener.`)
        return listen(event[1] as ListenKind, event[2] ?? '', hasMatcher ? args[0] : undefined, listener, ((hasMatcher ? args[2] : args[1]) ?? {}))
      }
    },
  })
}

export function interfaceClient(name: string, request: Pick<Peer, 'request'>, listeners: InterfaceListeners, identity: ProviderIdentity = { mod: '' }): Readonly<Record<string, unknown>> {
  return providerClient(
    name,
    identity,
    (method, args) => request.request(methodName(name, method), args),
    (kind, event, matcher, listener, options) => listeners.listen(request, listeningOf(name, kind, event, [], matcher, options), listener),
  )
}

export type SessionContext = Readonly<Record<string, unknown>>

export type HoldingOf = (session: string) => HeldSession | undefined

export type SessionComputer = {
  sessions(scope: Readonly<Record<string, unknown>>, holding: HoldingOf, held: ReadonlySet<string>): unknown
  search(text: string, options: Readonly<Record<string, unknown>>): unknown
  read(session: string, part: string, options: Readonly<Record<string, unknown>>, holding: HoldingOf): unknown
  unheld(session: string, action: string, input: unknown, context: SessionContext, holding: HoldingOf): Promise<unknown>
  visit(session: string, at: string): Promise<void>
  remove(session: string, context: SessionContext, holding: HoldingOf): Promise<void>
}

export type SessionRouting = {
  readonly routes: RpcRoutes
  readonly interfaces: InterfaceServer
  holding: HoldingOf
  heldSessions(): readonly HeldSession[]
  call<Result>(session: string, action: string, input: unknown, context?: SessionContext): Promise<Result>
  changed(change: StoreChange): void
  close(): void
}

export const sessionActions = ['send', 'abort', 'end', 'fork', 'startTask', 'callTool', 'usage', 'surfaces', 'visit', 'delete'] as const

export function routeSessions({ computer, now }: { readonly computer: SessionComputer; readonly now: () => number }): SessionRouting {
  type Holder = HeldSession & { readonly connection: RpcConnection }
  const holders = new Map<RpcConnection, Holder>()
  const listened = new Map<string, { readonly connection: RpcConnection; readonly listening: Listening }>()
  const globalId = (connection: RpcConnection, id: string) => `${connection.id}/${id}`
  const holderOf = (session: string) => [...holders.values()].find((holder) => holder.session === session)
  const holding: HoldingOf = (session) => {
    const holder = holderOf(session)
    return holder === undefined ? undefined : { session: holder.session, project: holder.project, cwd: holder.cwd }
  }

  const sessionListeners = (holder: Holder): SessionListening[] =>
    interfaces.listeners(sessionInterface).flatMap((listening) => {
      const [target] = listening.args ?? []
      const extra = listening.extra ?? {}
      const isEvery = target === undefined || target === '*'
      if (listening.connection === holder.connection) return []
      if (!isEvery && target !== holder.session) return []
      if (isEvery && typeof extra['project'] === 'string' && extra['project'] !== holder.project && extra['everyProject'] !== true) return []
      return [{ id: globalId(listening.connection, listening.id), event: listening.event, kind: listening.kind, ...(listening.matcher === undefined ? {} : { matcher: listening.matcher }), ...(listening.timeoutMs === undefined ? {} : { timeoutMs: listening.timeoutMs }), ...(listening.onFailure === undefined ? {} : { onFailure: listening.onFailure }), isEvery, extra }]
    })

  const tell = (holder: Holder) => holder.connection.notify(sessionActs.listeners, { session: holder.session, list: sessionListeners(holder) })
  const tellAll = () => {
    for (const holder of holders.values()) tell(holder)
  }
  const changed = (change: StoreChange) => interfaces.emit(sessionStore, 'Change', change, [change.session])

  const call = async (session: string, action: string, input: unknown, context: SessionContext = {}): Promise<unknown> => {
    if (!(sessionActions as readonly string[]).includes(action)) throw new RpcError(rpcCodes.methodNotFound, `A session takes no ${action}.`)
    if (action === 'visit') {
      await computer.visit(session, typeof input === 'string' ? input : new Date(now()).toISOString())
      changed({ session, part: 'visit' })
      return null
    }
    if (action === 'delete') {
      if (holderOf(session) !== undefined) throw new Error(`session ${session} runs, so it stays. End it first.`)
      await computer.remove(session, context, holding)
      changed({ session, part: 'deleted' })
      return null
    }
    const holder = holderOf(session)
    if (holder === undefined) return computer.unheld(session, action, input, context, holding)
    return holder.connection.request(sessionActs.act, { action, input, ...context })
  }

  const interfaces = interfaceServer({
    implementations: {
      [sessionStore]: {
        sessions: (scope: Readonly<Record<string, unknown>> = {}) => computer.sessions(scope, holding, new Set([...holders.values()].map((holder) => holder.session))),
        search: (text: string, options: Readonly<Record<string, unknown>> = {}) => computer.search(text, options),
        read: (session: string, part: string, options: Readonly<Record<string, unknown>> = {}) => computer.read(session, part, options, holding),
      },
      [sessionInterface]: Object.fromEntries(sessionActions.map((action) => [action, (session: string, input?: unknown, context?: unknown) => call(session, action, input ?? null, isObject(context) ? context : {})])),
    },
    onListen: (connection, listening) => {
      if (listening.interface !== sessionInterface) return
      listened.set(globalId(connection, listening.id), { connection, listening })
      tellAll()
    },
    onUnlisten: (connection, listening) => {
      if (listening.interface !== sessionInterface) return
      listened.delete(globalId(connection, listening.id))
      tellAll()
    },
    extraMethod: async (connection, method, params) => {
      if (method === sessionActs.hold) {
        const { session, project, cwd } = params as HeldSession
        for (const [each, holder] of holders) if (holder.session === session && each !== connection) holders.delete(each)
        const holder: Holder = { session, project, cwd, connection }
        holders.set(connection, holder)
        tell(holder)
        changed({ session, part: 'running' })
        return { result: {} }
      }
      if (method === sessionActs.changed) {
        changed(params as StoreChange)
        return { result: null }
      }
      if (method === sessionActs.emit) {
        const { id, payload } = params as { readonly id: string; readonly payload: unknown }
        const asked = listened.get(id)
        asked?.connection.notify(onMethod, { id: asked.listening.id, payload })
        return { result: null }
      }
      if (method === sessionActs.ask) {
        const { id, payload } = params as { readonly id: string; readonly payload: unknown }
        const asked = listened.get(id)
        if (asked === undefined) return { result: null }
        return { result: await asked.connection.request(beforeMethod, { id: asked.listening.id, payload }) }
      }
      return undefined
    },
  })

  const routes = rpcRoutes({
    handle: (connection) => interfaces.handler(connection),
    onClose: (connection) => {
      const holder = holders.get(connection)
      holders.delete(connection)
      interfaces.closed(connection)
      if (holder !== undefined) changed({ session: holder.session, part: 'running' })
    },
    now,
  })

  return {
    routes,
    interfaces,
    holding,
    heldSessions: () => [...holders.values()].map(({ session, project, cwd }) => ({ session, project, cwd })),
    call: (session, action, input, context) => call(session, action, input, context) as never,
    changed,
    close: () => routes.close(),
  }
}

export type ProviderList = { readonly mods: readonly string[]; readonly programs: readonly ProviderIdentity[] }

export type ProvidedListen = Omit<Listening, 'id' | 'args' | 'after' | 'extra'> & ProviderIdentity & { readonly id: string }

export type ProvidedHeard = { readonly id: string; readonly payload: unknown }

export type Providers = {
  provided(): readonly string[]
  provide(name: string, methods: Implementation): Subscription
  providers(name: string): Promise<Readonly<Record<string, unknown>>[]>
  answer(call: ProvidedCall): Promise<unknown>
  heard(heard: ProvidedHeard, signal: AbortSignal): Promise<unknown>
}

export function createProviders({ name, call, changed, report }: { readonly name: string; readonly call: (to: string, method: string, input: unknown) => Promise<unknown>; readonly changed: () => void; readonly report: (error: unknown) => void }): Providers {
  const provided = new Map<string, Implementation>()
  const heard = new Map<string, Listener>()
  let nextListener = 0
  const answer = async ({ interface: named, method, args }: ProvidedCall) => {
    const run = provided.get(named)?.[method] as ((...each: readonly unknown[]) => unknown) | undefined
    if (run === undefined) throw new Error(`${name} provides no ${named}.${method}.`)
    return (await run(...args)) ?? null
  }
  const client = (named: string, identity: ProviderIdentity) =>
    providerClient(
      named,
      identity,
      (method, args) => (identity.mod === name && identity.program === undefined ? answer({ interface: named, method, args }) : call(identity.program === undefined ? identity.mod : cmodPluginName, interfaceMethods.provided, { interface: named, method, args, ...identity } satisfies ProvidedCall)),
      (kind, event, matcher, listener, options) => {
        if (identity.program === undefined) throw new Error(`${identity.mod} tells ${named} events only from a program.`)
        const id = `${named}#${(nextListener += 1)}`
        heard.set(id, listener)
        const listening: ProvidedListen = { id, interface: named, kind, event, ...identity, ...(matcher === undefined ? {} : { matcher: sentMatcher(matcher) }), ...options }
        void call(cmodPluginName, interfaceMethods.listen, listening).catch((error: unknown) => {
          heard.delete(id)
          report(error)
        })
        return {
          remove() {
            if (heard.delete(id)) void call(cmodPluginName, interfaceMethods.unlisten, { id }).catch(report)
          },
        }
      },
    )
  return {
    provided: () => [...provided.keys()],
    provide(named, methods) {
      checkInterfaceName(named)
      provided.set(named, methods)
      changed()
      return {
        remove() {
          if (provided.get(named) === methods && provided.delete(named)) changed()
        },
      }
    },
    async providers(named) {
      const listed = (await call(cmodPluginName, interfaceMethods.providers, { name: named })) as ProviderList
      return [...listed.mods.map((mod) => client(named, { mod })), ...listed.programs.map((identity) => client(named, identity))]
    },
    answer,
    async heard({ id, payload }, signal) {
      const listener = heard.get(id)
      return listener === undefined ? null : ((await listener(payload as never, signal)) ?? null)
    },
  }
}

export type ProgramProviders = {
  answer(method: string, input: unknown, caller: string): Promise<unknown> | undefined
  close(): Promise<void>
}

export function servePrograms({
  store,
  fetch,
  files,
  wait,
  report,
  tell,
  sessionCode,
}: {
  readonly store: string
  readonly fetch: HttpFetch
  readonly files: InstanceFiles
  readonly wait: (ms: number) => Promise<void>
  readonly report: (error: unknown) => void
  readonly tell: (caller: string, heard: ProvidedHeard, signal: AbortSignal) => Promise<unknown>
  readonly sessionCode: (name: string) => readonly string[]
}): ProgramProviders {
  const listeners = interfaceListeners({ report })
  const clients = new Map<string, RpcClient>()
  const held = new Map<string, Subscription>()
  const handle = async (method: string, params: unknown, signal: AbortSignal) => {
    const answered = await listeners.handler(method, params, signal)
    if (answered === undefined) throw new RpcError(rpcCodes.methodNotFound, `The cmod plugin answers no ${method}.`)
    return answered.result
  }
  const clientOf = async (named: string, { mod, program }: ProviderIdentity) => {
    const found = (await readProviders(files, store, named)).find((each) => each.mod === mod && each.program === program)
    if (found === undefined) throw new Error(`${mod}'s ${program ?? mod} program does not run, so it answers no ${named}.`)
    const known = clients.get(found.address)
    if (known !== undefined) return known
    const client = connectRpc({ call: addressCall(fetch, found.address), handle, onConnect: (connected) => listeners.replay(connected), wait })
    clients.set(found.address, client)
    return client
  }
  const listen = async (caller: string, { id, interface: named, kind, event, matcher, timeoutMs, onFailure, mod, program }: ProvidedListen) => {
    const client = await clientOf(named, { mod, ...(program === undefined ? {} : { program }) })
    const key = `${caller}\n${id}`
    held.get(key)?.remove()
    held.set(key, listeners.listen(client, { interface: named, kind, event, ...(matcher === undefined ? {} : { matcher }), ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(onFailure === undefined ? {} : { onFailure }) }, (payload: unknown, signal) => tell(caller, { id, payload }, signal)))
    return null
  }
  const unlisten = (caller: string, id: string) => {
    const key = `${caller}\n${id}`
    held.get(key)?.remove()
    held.delete(key)
    return null
  }
  const listed = async (named: string): Promise<ProviderList> => ({ mods: sessionCode(named), programs: (await readProviders(files, store, named)).map(({ mod, program }) => ({ mod, program })) })
  return {
    answer(method, input, caller) {
      const asked = input as Readonly<Record<string, unknown>>
      if (method === interfaceMethods.providers) return listed(String(asked['name']))
      if (method === interfaceMethods.listen) return listen(caller, input as ProvidedListen)
      if (method === interfaceMethods.unlisten) return Promise.resolve(unlisten(caller, String(asked['id'])))
      const call = input as ProvidedCall
      if (method !== interfaceMethods.provided || call.program === undefined || call.mod === undefined) return undefined
      return clientOf(call.interface, { mod: call.mod, program: call.program }).then((client) => client.request(methodName(call.interface, call.method), call.args))
    },
    async close() {
      await Promise.all([...clients.values()].map((client) => client.close()))
    },
  }
}
