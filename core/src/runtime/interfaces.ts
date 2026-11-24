import { interfaceName, isObject, type ProgramInstance } from '../records.js'
import type { Device } from '../session/context/turn/device.js'
import type { SessionData } from '../session/conversation.js'
import { matches, receivedMatcher, sentMatcher, type SentMatcher } from '../utils/matcher.js'
import type { Subscription } from '../utils/subscription.js'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import { beforeDeadline, callDeadline, hookMs, listenerMs, listenerOf } from './deadline.js'
import { cmodPluginName } from './dependencies.js'
import { unaborted } from './router.js'
import { addressCall, connectRpc, isConnectionGone, RpcError, rpcCodes, rpcRoutes, RpcUnreached, type HttpFetch, type Peer, type RpcClient, type RpcConnection, type RpcHandler, type RpcMessage, type RpcRoutes } from './rpc.js'

export type InterfaceName = `${string}/${string}`

export const listenMethod = '$/listen'

export const unlistenMethod = '$/unlisten'

export const onMethod = '$/on'

export const beforeMethod = '$/before'

export const sessionsInterface = 'cmod/Sessions'

export const devicesInterface = 'cmod/Devices'

export const styleInterface = 'cmod/Style'

export const uiInterface = 'cmod/UI'

export const uiMethods = ['widgets', 'views', 'pages', 'draw', 'press', 'open', 'close'] as const

export const uiEvents: readonly string[] = ['Change', 'Redraw', 'Open', 'Close']

export const uiParts = ['widgets', 'views', 'pages'] as const

export const sessionActs = {
  hold: '$/hold',
  act: '$/act',
  changed: '$/changed',
  status: '$/status',
  ui: '$/ui',
  uiEvent: '$/uiEvent',
  tasks: '$/tasks',
} as const

export const terminalInterface = 'cmod/Terminal'

export const providersInterface = 'cmod/Providers'

export type ProvidersChange = { readonly interface: string; readonly device: Pick<Device, 'id' | 'name'> }

type ChangedProviders = (name: string | undefined, device: Pick<Device, 'id' | 'name'> | undefined) => void

export type TerminalPlace = 'focus' | 'peek' | 'tab' | 'right' | 'down' | 'hide'

export const terminalPlaces: readonly TerminalPlace[] = ['focus', 'peek', 'tab', 'right', 'down', 'hide']

const terminalEvents: readonly string[] = ['Shown', 'Pressed']

export type SessionTerminals = {
  screen(session: string): Promise<string>
  press(session: string, keys: string): Promise<void>
  show(session: string, place: TerminalPlace): Promise<void>
}

export type HeldSession = { readonly session: string; readonly project: string; readonly cwd: string }

export type HeldStatus = Pick<SessionData, 'status' | 'waitingFor' | 'contextPercent' | 'lastTurn'>

export type VisitedAt = Readonly<Record<string, string>>

export type StoreChange = { readonly session: string; readonly part: 'visit' | 'running' | 'tasks' | 'goal' | 'status' | 'deleted' }


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
  readonly provider?: ProviderIdentity
}

export type Heard = { readonly id: string; readonly payload: unknown; readonly cursor?: string }

export type ListenOptions = { readonly timeoutMs?: number; readonly onFailure?: 'pass' | 'refuse' }

export type Provider = { readonly mod: string; readonly program: string; readonly address: string; readonly provides: readonly string[] }

export const interfaceMethods = { providers: 'cmod:providers', provider: 'cmod:provider', provided: 'cmod:provided', listen: 'cmod:listenProvided', unlisten: 'cmod:unlistenProvided', tell: 'cmod:tellProvided', ask: 'cmod:askProvided', heard: 'cmod:heard' } as const

export const providerActs = { provide: '$/provide', unprovide: '$/unprovide', providers: '$/providers', provider: '$/provider', call: '$/call', link: '$/link' } as const

export const providerHoldMs = hookMs / 4

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
  if (!interfaceName.test(name)) throw new Error(`${name} is no interface name, such as demo/Platform.`)
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
  handler(connection: Pick<Peer, 'request' | 'notify'>): RpcHandler
  emit(name: string, event: string, payload: unknown, args?: readonly unknown[]): void
  listeners(name: string, event?: string): readonly (Listening & { readonly connection: Pick<Peer, 'request' | 'notify'> })[]
  closed(connection: Pick<Peer, 'request' | 'notify'>): void
}

const keptEvents = 500

export function interfaceServer({
  implementations,
  onListen,
  extraMethod,
}: {
  readonly implementations: Readonly<Record<string, Implementation>>
  readonly onListen?: (connection: Pick<Peer, 'request' | 'notify'>, listening: Listening) => void | Promise<void>
  readonly extraMethod?: (connection: Pick<Peer, 'request' | 'notify'>, method: string, params: unknown, signal: AbortSignal) => { readonly result: unknown } | undefined | Promise<{ readonly result: unknown } | undefined>
}): InterfaceServer {
  const held = new Map<Pick<Peer, 'request' | 'notify'>, Map<string, Listening>>()
  const recent = new Map<string, { cursor: number; readonly kept: { readonly cursor: number; readonly args: readonly unknown[]; readonly payload: unknown }[] }>()

  const keyOf = (name: string, event: string) => `${name}\n${event}`

  const listeningOf = (params: unknown): Listening => {
    if (!isObject(params) || typeof params['id'] !== 'string' || typeof params['interface'] !== 'string' || typeof params['event'] !== 'string' || (params['kind'] !== 'on' && params['kind'] !== 'before')) throw new RpcError(rpcCodes.invalidParams, `${listenMethod} takes { id, interface, event, kind }.`)
    if (implementations[params['interface']] === undefined) throw new RpcError(rpcCodes.methodNotFound, `This program provides no ${params['interface']}.`)
    return params as Listening
  }

  const replay = (connection: Pick<Peer, 'request' | 'notify'>, listening: Listening) => {
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
        await onListen?.(connection, listening)
        const list = held.get(connection) ?? new Map<string, Listening>()
        list.set(listening.id, listening)
        held.set(connection, list)
        replay(connection, listening)
        return {}
      }
      if (method === unlistenMethod) {
        const id = isObject(params) ? params['id'] : undefined
        if (typeof id === 'string') held.get(connection)?.delete(id)
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
    listeners: (name, event) => [...held].flatMap(([connection, list]) => [...list.values()].filter((each) => each.interface === name && (event === undefined || each.event === event)).map((each) => ({ ...each, connection }))),
    closed(connection) {
      held.delete(connection)
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
    if (!isConnectionGone(error)) reportAll(error)
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

export type ProviderIdentity = { readonly mod: string; readonly program?: string; readonly device?: Pick<Device, 'id' | 'name'> | undefined }

export type ListenTo = (kind: ListenKind, event: string, matcher: unknown, listener: Listener, options: ListenOptions) => Subscription

export function providerClient(name: string, identity: ProviderIdentity, call: (method: string, args: readonly unknown[]) => Promise<unknown>, listen: ListenTo): Readonly<Record<string, unknown>> {
  return new Proxy(identity, {
    get: (known, key) => {
      if (typeof key !== 'string' || key === 'then') return undefined
      if (key === 'mod' || key === 'program' || key === 'device') return known[key]
      const event = /^(on|before)([A-Z]\w*)$/.exec(key)
      if (event === null) return (...args: unknown[]) => call(key, args)
      return (...args: unknown[]) => {
        const { matcher, listener, options } = listenerOf<Listener>(name, key, args)
        return listen(event[1] as ListenKind, event[2] ?? '', matcher, listener, options)
      }
    },
  })
}

export type SessionContext = Readonly<Record<string, unknown>>

export type HoldingOf = (session: string) => HeldSession | undefined

export type ToldAt = ReadonlyMap<string, number>

export type SessionComputer = {
  sessions(scope: Readonly<Record<string, unknown>>, holding: HoldingOf, told: ToldAt): readonly SessionData[] | Promise<readonly SessionData[]>
  session(session: string, holding: HoldingOf, told: ToldAt): SessionData | undefined | Promise<SessionData | undefined>
  search(text: string, options: Readonly<Record<string, unknown>>): unknown
  read(session: string, part: string, options: Readonly<Record<string, unknown>>, holding: HoldingOf): unknown
  unheld(session: string, action: string, input: unknown, context: SessionContext, holding: HoldingOf): Promise<unknown>
  visit(session: string, at: string, holding: HoldingOf): Promise<void>
  remove(session: string, context: SessionContext, holding: HoldingOf): Promise<void>
}

export type SessionRouting = {
  readonly routes: RpcRoutes
  readonly interfaces: InterfaceServer
  readonly providers: Pick<ProviderRouting, 'list' | 'call'>
  holding: HoldingOf
  heldSessions(): readonly HeldSession[]
  call<Result>(session: string, action: string, input: unknown, context?: SessionContext): Promise<Result>
  changed(change: StoreChange): void
  close(): void
}

export const sessionActions = ['send', 'abort', 'end', 'fork', 'startTask', 'callTool', 'usage', 'surfaces', 'visit', 'delete'] as const

export const showLeaseMs = 16_000

export function routeSessions({
  computer,
  device,
  now,
  after,
  report,
  aliases = [],
  programs,
  terminals,
}: {
  readonly computer: SessionComputer
  readonly device: () => Promise<Pick<Device, 'id' | 'name'>>
  readonly now: () => number
  readonly after: (ms: number, run: () => void) => unknown
  readonly report: (error: unknown) => void
  readonly aliases?: readonly string[]
  readonly programs?: ProgramReach
  readonly terminals?: SessionTerminals
}): SessionRouting {
  type Holder = HeldSession & { readonly connection: Pick<Peer, 'request' | 'notify'>; readonly told: HeldStatus; readonly toldAt: number }
  const holders = new Map<Pick<Peer, 'request' | 'notify'>, Holder>()
  const holderOf = (session: string) => [...holders.values()].find((holder) => holder.session === session)
  const toldAt = (): ToldAt => new Map([...holders.values()].map((holder) => [holder.session, holder.toldAt]))
  const holding: HoldingOf = (session) => {
    const holder = holderOf(session)
    return holder === undefined ? undefined : { session: holder.session, project: holder.project, cwd: holder.cwd }
  }
  const names = [sessionsInterface, ...aliases]

  const changed = (change: StoreChange) => {
    for (const name of names) interfaces.emit(name, 'Change', change, [change.session])
  }

  const call = async (session: string, action: string, input: unknown, context: SessionContext = {}): Promise<unknown> => {
    if (!(sessionActions as readonly string[]).includes(action)) throw new RpcError(rpcCodes.methodNotFound, `A session takes no ${action}.`)
    if (action === 'visit') {
      await computer.visit(session, typeof input === 'string' ? input : new Date(now()).toISOString(), holding)
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

  const withStatus = (listed: SessionData, told: HeldStatus | undefined): SessionData => {
    if (told === undefined) return listed
    const status = listed.status ?? told.status
    const recorded = listed.waitingFor
    const waitingFor = status !== 'waiting' || told.waitingFor === undefined ? recorded : { ...told.waitingFor, ...(recorded === undefined ? {} : { dialog: recorded.dialog }) }
    return { ...listed, ...(status === undefined ? {} : { status }), ...(waitingFor === undefined ? {} : { waitingFor }), ...(told.contextPercent === undefined ? {} : { contextPercent: told.contextPercent }), ...(told.lastTurn === undefined ? {} : { lastTurn: told.lastTurn }) }
  }

  const implementation: Implementation = {
    sessions: async (scope: Readonly<Record<string, unknown>> = {}) => (await computer.sessions(scope, holding, toldAt())).map((listed) => withStatus(listed, holderOf(listed.id)?.told)),
    session: async (session: string) => {
      const found = await computer.session(session, holding, toldAt())
      if (found === undefined) throw new RpcError(rpcCodes.notHeld, `No session ${session} on this computer.`)
      return withStatus(found, holderOf(session)?.told)
    },
    search: (text: string, options: Readonly<Record<string, unknown>> = {}) => computer.search(text, options),
    read: async (session: string, part: string, options: Readonly<Record<string, unknown>> = {}) => {
      const saved = await computer.read(session, part, options, holding)
      const holder = holderOf(session)
      if (part !== 'tasks' || holder === undefined) return saved
      return holder.connection.request(sessionActs.tasks, { saved, options }).catch((error: unknown) => {
        if (error instanceof RpcError && error.code === rpcCodes.methodNotFound) return saved
        throw error
      })
    },
    ...Object.fromEntries(sessionActions.map((action) => [action, (session: string, input?: unknown, context?: unknown) => call(session, action, input ?? null, isObject(context) ? context : {})])),
  }

  const showing = async (session: string) => {
    const holder = holderOf(session)
    if (holder !== undefined) return holder.connection
    const isRunning = (await computer.sessions({ running: true }, holding, new Map())).some((listed) => listed.id === session)
    throw new RpcError(rpcCodes.notHeld, isRunning ? `Session ${session} runs here, but no cmod plugin of 7.0.0 or later in it reaches cmod serve, so its views show only in Claude Code. Run /reload-plugins in it to show them here.` : `No session ${session} runs on this computer, so it shows no UI.`)
  }

  const askedUi = async (session: string, method: string, args: readonly unknown[]) => {
    try {
      return await (await showing(session)).request(sessionActs.ui, { method, args: [session, ...args] })
    } catch (error) {
      if (!(error instanceof RpcError && error.code === rpcCodes.methodNotFound)) throw error
      throw new RpcError(rpcCodes.methodNotFound, `Session ${session} runs a cmod plugin older than this cmod serve, so its views show only in Claude Code. Run /reload-plugins in it to show them here.`)
    }
  }

  type ShownPart = { readonly mod: string; readonly id: string }
  type ShownSet = { readonly parts: readonly ShownPart[]; readonly isHost: boolean; readonly until: number }
  const shownSets = new Map<string, Map<string, ShownSet>>()
  const toldShown = new Map<string, string>()
  const toldNothing = JSON.stringify({ union: [], isHosted: false })

  const tellShown = (session: string) => {
    const sets = shownSets.get(session) ?? new Map<string, ShownSet>()
    for (const [client, set] of sets) if (set.until <= now()) sets.delete(client)
    if (sets.size === 0) shownSets.delete(session)
    const union = [...new Map([...sets.values()].flatMap(({ parts }) => parts).map(({ mod, id }) => [`${mod}/${id}`, { mod, id }])).values()].sort((first, second) => `${first.mod}/${first.id}`.localeCompare(`${second.mod}/${second.id}`))
    const isHosted = [...sets.values()].some((set) => set.isHost)
    const holder = holderOf(session)
    const told = JSON.stringify({ union, isHosted })
    if (holder === undefined || (toldShown.get(session) ?? toldNothing) === told) return
    toldShown.set(session, told)
    void holder.connection.request(sessionActs.ui, { method: 'shown', args: [session, union, isHosted] }).catch((error: unknown) => {
      if (!isConnectionGone(error)) report(error)
    })
  }

  const show = async (session: string, client: unknown, parts: unknown, options: unknown) => {
    await showing(session)
    if (typeof client !== 'string' || client === '') throw new RpcError(rpcCodes.invalidParams, `${uiInterface}.show takes the client that shows the parts, a name its app picks.`)
    if (!Array.isArray(parts) || !parts.every((each) => isObject(each) && typeof each['mod'] === 'string' && typeof each['id'] === 'string')) throw new RpcError(rpcCodes.invalidParams, `${uiInterface}.show takes the parts it shows as { mod, id }[].`)
    const isHost = isObject(options) && options['isHost'] === true
    const sets = shownSets.get(session) ?? new Map<string, ShownSet>()
    shownSets.set(session, sets)
    if (parts.length === 0 && !isHost) sets.delete(client)
    else sets.set(client, { parts: (parts as readonly ShownPart[]).map(({ mod, id }) => ({ mod, id })), isHost, until: now() + showLeaseMs })
    after(showLeaseMs, () => tellShown(session))
    tellShown(session)
    return null
  }

  const ui: Implementation = { ...Object.fromEntries(uiMethods.map((method) => [method, (session: string, ...args: unknown[]) => askedUi(session, method, args)])), show }

  const relisted = (session: string) => {
    for (const part of uiParts) interfaces.emit(uiInterface, 'Change', { session, part }, [session])
  }

  const terminal: Implementation | undefined =
    terminals === undefined
      ? undefined
      : {
          screen: (session: string) => terminals.screen(session),
          press: async (session: string, keys: unknown) => {
            if (typeof keys !== 'string') throw new RpcError(rpcCodes.invalidParams, `${terminalInterface}.press takes the keys as one string, such as "1\\r".`)
            await terminals.press(session, keys)
            interfaces.emit(terminalInterface, 'Pressed', { session }, [session])
            return null
          },
          show: async (session: string, place: unknown) => {
            if (!terminalPlaces.includes(place as TerminalPlace)) throw new RpcError(rpcCodes.invalidParams, `${terminalInterface}.show takes a place: ${terminalPlaces.join(', ')}.`)
            await terminals.show(session, place as TerminalPlace)
            interfaces.emit(terminalInterface, 'Shown', { session, place }, [session])
            return null
          },
        }

  const interfaces = interfaceServer({
    implementations: { ...Object.fromEntries(names.map((name) => [name, implementation])), [uiInterface]: ui, [providersInterface]: {}, ...(terminal === undefined ? {} : { [terminalInterface]: terminal }) },
    onListen: (_connection, listening) => {
      if (listening.interface === uiInterface) {
        if (!uiEvents.includes(listening.event)) throw new RpcError(rpcCodes.methodNotFound, `${uiInterface} tells only Change, Redraw, Open, and Close.`)
        return
      }
      if (listening.interface === terminalInterface) {
        if (!terminalEvents.includes(listening.event)) throw new RpcError(rpcCodes.methodNotFound, `${terminalInterface} tells only ${terminalEvents.join(' and ')}.`)
        return
      }
      if (listening.event !== 'Change') throw new RpcError(rpcCodes.methodNotFound, listening.interface === providersInterface ? `${providersInterface} tells only Change.` : `${listening.interface} tells only Change, because a mod hears only the session it runs in.`)
    },
    extraMethod: (connection, method, params) => {
      if (method === sessionActs.uiEvent) {
        const holder = holders.get(connection)
        const { event, payload } = (isObject(params) ? params : {}) as { readonly event?: unknown; readonly payload?: unknown }
        if (holder !== undefined && typeof event === 'string' && uiEvents.includes(event)) interfaces.emit(uiInterface, event, { ...(isObject(payload) ? payload : {}), session: holder.session }, [holder.session])
        return { result: null }
      }
      if (method === sessionActs.hold) {
        const { session, project, cwd } = params as HeldSession
        const known = holders.get(connection)
        for (const [each, holder] of holders) if (holder.session === session && each !== connection) holders.delete(each)
        holders.set(connection, { session, project, cwd, connection, ...(known?.session === session ? { told: known.told, toldAt: known.toldAt } : { told: {}, toldAt: 0 }) })
        changed({ session, part: 'running' })
        relisted(session)
        toldShown.delete(session)
        tellShown(session)
        return { result: {} }
      }
      if (method === sessionActs.changed) {
        changed(params as StoreChange)
        return { result: null }
      }
      if (method === sessionActs.status) {
        const holder = holders.get(connection)
        const { session, ...told } = (isObject(params) ? params : {}) as HeldStatus & { readonly session?: unknown }
        if (holder === undefined || holder.session !== session || JSON.stringify(told) === JSON.stringify(holder.told)) return { result: null }
        const isMoved = told.status !== holder.told.status || JSON.stringify(told.waitingFor) !== JSON.stringify(holder.told.waitingFor)
        holders.set(connection, { ...holder, told, toldAt: isMoved ? now() : holder.toldAt })
        changed({ session: holder.session, part: 'status' })
        return { result: null }
      }
      return undefined
    },
  })

  const toldNames = new Set<string>()
  const providersChanged: ChangedProviders = (name, from) =>
    void (async () => {
      const at = from ?? (await device())
      const listened = interfaces.listeners(providersInterface, 'Change').map(({ matcher }) => (isObject(matcher) ? (matcher as Readonly<Record<string, unknown>>)['interface'] : undefined))
      for (const each of name === undefined ? new Set([...toldNames, ...listened.filter((named): named is string => typeof named === 'string')]) : [name]) {
        toldNames.add(each)
        interfaces.emit(providersInterface, 'Change', { interface: each, device: at } satisfies ProvidersChange)
      }
    })().catch(report)

  const providers = routeProviders({ isOwn: (name) => names.includes(name) || name === uiInterface || name === providersInterface || (terminal !== undefined && name === terminalInterface), listsSelf: (name) => name === providersInterface || (terminal !== undefined && name === terminalInterface), changed: providersChanged, own: (connection) => interfaces.handler(connection), device, report, channel: (send) => routes.channel(send), ...(programs === undefined ? {} : { programs }) })

  const routes = rpcRoutes({
    handle: (connection) => {
      const own = interfaces.handler(connection)
      return (method, params, signal) => providers.handler(connection, method, params, signal) ?? own(method, params, signal)
    },
    onClose: (connection) => {
      const holder = holders.get(connection)
      holders.delete(connection)
      interfaces.closed(connection)
      providers.closed(connection)
      if (holder === undefined) return
      toldShown.delete(holder.session)
      if (holderOf(holder.session) === undefined) relisted(holder.session)
      changed({ session: holder.session, part: 'running' })
      if (Object.keys(holder.told).length > 0) changed({ session: holder.session, part: 'status' })
    },
    now,
  })

  return {
    routes,
    interfaces,
    providers,
    holding,
    heldSessions: () => [...holders.values()].map(({ session, project, cwd }) => ({ session, project, cwd })),
    call: (session, action, input, context) => call(session, action, input, context) as never,
    changed,
    close: () => {
      routes.close()
      void providers.close()
    },
  }
}

export type ProgramReach = { readonly store: string; readonly files: InstanceFiles; readonly fetch: HttpFetch; readonly wait: (ms: number) => Promise<void> }

export type ProviderRouting = {
  handler(connection: RpcConnection, method: string, params: unknown, signal: AbortSignal): Promise<unknown> | undefined
  list(name: string): Promise<ProviderIdentity[]>
  call(called: ProvidedCall, signal?: AbortSignal): Promise<unknown>
  closed(connection: RpcConnection): void
  close(): Promise<void>
}

type ProviderEnd = {
  readonly identity: ProviderIdentity
  readonly listeners: InterfaceListeners
  readonly link: Pick<Peer, 'request'>
  connection: RpcConnection | undefined
  names: Set<string>
  older: { readonly address: string; readonly client: RpcClient } | undefined
  readonly awaited: Set<{ readonly name: string | undefined; readonly provided: () => void }>
}

type DeviceListed = Pick<Device, 'id' | 'name'> & { readonly address?: string; readonly carrier: ProviderEnd }

type AddressServe = { readonly name: string; readonly listeners: InterfaceListeners; readonly address: string; readonly client: RpcClient }

type MessageServe = { name: string; readonly listeners: InterfaceListeners; readonly carrier: ProviderEnd; link: RpcConnection; theirs: string | undefined }

type DeviceServe = AddressServe | MessageServe

type Hello = { readonly link: string; readonly answers?: string }

type Target = Pick<ProviderEnd, 'listeners' | 'link'> & { readonly provider?: ProviderIdentity }

export function providerPeer(serve: Pick<Peer, 'request'>, identity: ProviderIdentity): Pick<Peer, 'request'> {
  return {
    request: <Result>(method: string, params?: unknown, signal?: AbortSignal) => {
      if (method.startsWith('$/')) return serve.request<Result>(method, params, signal)
      const dot = method.lastIndexOf('.')
      return serve.request<Result>(providerActs.call, { interface: method.slice(0, dot), method: method.slice(dot + 1), args: Array.isArray(params) ? params : [], ...identity } satisfies ProvidedCall, signal)
    },
  }
}

export function routeProviders({
  isOwn,
  listsSelf,
  own,
  device,
  report,
  channel,
  programs,
  changed,
}: {
  readonly isOwn: (name: string) => boolean
  readonly listsSelf: (name: string) => boolean
  readonly changed: ChangedProviders
  readonly own: (connection: RpcConnection) => RpcHandler
  readonly device: () => Promise<Pick<Device, 'id' | 'name'>>
  readonly report: (error: unknown) => void
  readonly channel: RpcRoutes['channel']
  readonly programs?: ProgramReach
}): ProviderRouting {
  const ends = new Map<string, ProviderEnd>()
  const forwarded = new Map<RpcConnection, Map<string, Subscription>>()
  const devices = new Map<string, DeviceServe>()
  const deviceListeners = new Map<string, InterfaceListeners>()
  const followed = new WeakSet<ProviderEnd>()
  let following: Promise<void> = Promise.resolve()
  const keyOf = ({ mod, program }: ProviderIdentity) => `${mod}\n${program ?? ''}`
  const named = ({ mod, program }: ProviderIdentity) => `${mod}'s ${program ?? mod} program`
  const isSelf = ({ mod, program }: Partial<ProviderIdentity>) => mod === cmodPluginName && program === cmodPluginName

  const endOf = (identity: ProviderIdentity): ProviderEnd => {
    const known = ends.get(keyOf(identity))
    if (known !== undefined) return known
    const end: ProviderEnd = {
      identity: { mod: identity.mod, ...(identity.program === undefined ? {} : { program: identity.program }) },
      listeners: interfaceListeners({ report }),
      link: {
        request: <Result>(method: string, params?: unknown, signal?: AbortSignal) => {
          const peer = end.connection ?? end.older?.client
          return peer === undefined ? Promise.reject(new RpcUnreached(`${named(identity)} does not run.`)) : peer.request<Result>(method, params, signal)
        },
      },
      connection: undefined,
      names: new Set(),
      older: undefined,
      awaited: new Set(),
    }
    ends.set(keyOf(identity), end)
    return end
  }

  const heardBy = (listeners: InterfaceListeners, who: string) => async (method: string, params: unknown, signal: AbortSignal) => {
    const answered = await listeners.handler(method, params, signal)
    if (answered !== undefined) return answered.result
    if (method === onMethod) return null
    throw new RpcError(rpcCodes.methodNotFound, `cmod serve answers ${who} no ${method}.`)
  }

  const instances = async (name: string): Promise<Provider[]> => (programs === undefined ? [] : (await readProviders(programs.files, programs.store, name)).filter((each) => each.mod !== cmodPluginName))

  const ownOf = async (name: string): Promise<ProviderIdentity[]> => {
    const registered = [...ends.values()].filter((end) => end.connection !== undefined && end.names.has(name)).map((end) => end.identity)
    const keys = new Set(registered.map(keyOf))
    const older = (await instances(name)).filter((each) => !keys.has(keyOf(each))).map(({ mod, program }) => ({ mod, program }))
    return [...registered, ...older]
  }

  const listed = async (name: string, asked: string | undefined): Promise<ProviderIdentity[]> => {
    const here = await device()
    const stamped = (identities: readonly ProviderIdentity[]) => identities.map((identity) => ({ ...identity, device: here }))
    const self = { mod: cmodPluginName, program: cmodPluginName }
    if (asked !== undefined) return asked === here.id ? stamped([...(await ownOf(name)), ...(isOwn(name) && name !== providersInterface ? [self] : [])]) : []
    await following
    const carried = await Promise.all(
      [...devices.entries()]
        .filter(([, each]) => isReached(each))
        .map(([id, each]) =>
          peerOf(each).request<ProviderIdentity[]>(providerActs.providers, { interface: name, device: id }).catch((error: unknown) => {
            report(new Error(`cmod serve lists no ${name} of ${each.name}: ${messageOf(error)}`))
            return []
          }),
        ),
    )
    return [...stamped([...(listsSelf(name) ? [self] : []), ...(await ownOf(name))]), ...carried.flat()]
  }

  const reachOlder = (end: ProviderEnd, address: string, reach: ProgramReach) => {
    if (end.older?.address === address) return
    void end.older?.client.close()
    const client = connectRpc({ call: addressCall(reach.fetch, address), handle: heardBy(end.listeners, named(end.identity)), onConnect: (connected) => end.listeners.replay(connected), wait: reach.wait })
    end.older = { address, client }
  }

  const isLinked = (each: DeviceServe): each is MessageServe => 'carrier' in each

  const isReached = (each: DeviceServe) => (isLinked(each) ? each.theirs !== undefined : each.client.isConnected)

  const peerOf = (each: DeviceServe): Pick<Peer, 'request'> =>
    isLinked(each)
      ? { request: <Result>(method: string, params?: unknown, signal?: AbortSignal) => (each.theirs === undefined ? Promise.reject(new RpcUnreached(`The cmod serve of ${each.name} has not linked yet.`)) : each.link.request<Result>(method, params, signal)) }
      : each.client

  const listenersOf = (id: string) => {
    const listeners = deviceListeners.get(id) ?? interfaceListeners({ report })
    deviceListeners.set(id, listeners)
    return listeners
  }

  const followedDevices = new Set<string>()

  const forward = (id: string, peer: Pick<Peer, 'request'>) => {
    if (followedDevices.has(id)) return
    followedDevices.add(id)
    listenersOf(id).listen(peer, listeningOf(providersInterface, 'on', 'Change', [], undefined), (told: unknown) => {
      if (isObject(told) && typeof told['interface'] === 'string' && isObject(told['device']) && told['device']['id'] === id) changed(told['interface'], { id, name: String(told['device']['name']) })
    })
  }

  const drop = (id: string, each: DeviceServe) => {
    devices.delete(id)
    changed(undefined, { id, name: each.name })
    if (!isLinked(each)) return each.client.close()
    each.link.close(new Error(`cmod serve dropped ${each.name}`))
    return undefined
  }

  const carry = (carrier: ProviderEnd, id: string, message: RpcMessage) => carrier.link.request(methodName(devicesInterface, 'send'), [id, message])

  const linkTo = (id: string, name: string, carrier: ProviderEnd, theirs: string | undefined) => {
    const link: RpcConnection = channel((message) => {
      void carry(carrier, id, message).catch((error: unknown) => {
        const failed = `${named(carrier.identity)} carried no message to ${name}: ${messageOf(error)}`
        if ('method' in message && 'id' in message) link.receive({ jsonrpc: '2.0', id: message.id, error: { code: rpcCodes.closed, message: failed } })
        else report(new Error(failed))
      })
    })
    const each: MessageServe = { name, listeners: listenersOf(id), carrier, link, theirs }
    devices.set(id, each)
    forward(id, peerOf(each))
    link.notify(providerActs.link, { link: link.id, ...(theirs === undefined ? {} : { answers: theirs }) } satisfies Hello)
    if (theirs === undefined) return
    changed(undefined, { id, name })
    void each.listeners.replay(peerOf(each))
  }

  const greeted = (id: string, known: MessageServe | undefined, carrier: ProviderEnd, hello: Hello) => {
    if (known === undefined) return linkTo(id, id, carrier, hello.link)
    if (known.theirs !== undefined && hello.answers !== known.link.id) {
      known.link.close(new Error(`the cmod serve of ${known.name} linked again`))
      return linkTo(id, known.name, carrier, hello.link)
    }
    if (known.theirs === hello.link) return
    known.theirs = hello.link
    if (hello.answers !== known.link.id) known.link.notify(providerActs.link, { link: known.link.id, answers: hello.link } satisfies Hello)
    changed(undefined, { id, name: known.name })
    void known.listeners.replay(peerOf(known))
  }

  const heardThrough = (carrier: ProviderEnd, told: unknown) => {
    if (!isObject(told) || typeof told['device'] !== 'string' || !isObject(told['message'])) return
    const id = told['device']
    const message = told['message']
    const known = devices.get(id)
    if (known !== undefined && !(isLinked(known) && known.carrier === carrier)) return report(new Error(`${named(carrier.identity)} carried a message from device ${id}, which cmod serve reaches another way.`))
    const params = message['params']
    if (message['method'] === providerActs.link && isObject(params) && typeof params['link'] === 'string') return greeted(id, known, carrier, params as Hello)
    if (known?.theirs !== undefined) return known.link.receive(message)
    const asked = message['id']
    if (known === undefined && typeof message['method'] === 'string' && (typeof asked === 'number' || typeof asked === 'string'))
      void carry(carrier, id, { jsonrpc: '2.0', id: asked, error: { code: rpcCodes.closed, message: `This cmod serve holds no link to device ${id}, so it answers nothing from it.` } }).catch(report)
  }

  const reachDevice = async ({ id, name, address }: Pick<Device, 'id' | 'name'> & { readonly address: string }, reach: ProgramReach) => {
    const listeners = listenersOf(id)
    let reached: () => void = () => undefined
    const isReached = new Promise<void>((resolve) => {
      reached = resolve
    })
    const client = connectRpc({
      call: addressCall(reach.fetch, address),
      handle: heardBy(listeners, `the cmod serve of ${name}`),
      onConnect: async (connected) => {
        reached()
        changed(undefined, { id, name })
        await listeners.replay(connected)
      },
      onError: () => reached(),
      wait: reach.wait,
      keepsConnecting: true,
    })
    devices.set(id, { name, address, client, listeners })
    forward(id, client)
    await isReached
  }

  const connectDevices = async () => {
    const here = await device()
    const sources = [...ends.values()].filter((end) => end.connection !== undefined && end.names.has(devicesInterface))
    const lists = await Promise.all(
      sources.map((end) =>
        end.link.request<Omit<DeviceListed, 'carrier'>[]>(methodName(devicesInterface, 'devices'), []).then(
          (list): DeviceListed[] => list.map((each) => ({ ...each, carrier: end })),
          (error: unknown) => {
            report(new Error(`${named(end.identity)} lists no ${devicesInterface}: ${messageOf(error)}`))
            return []
          },
        ),
      ),
    )
    const wanted = new Map(lists.flat().filter((each) => each.id !== here.id).map((each) => [each.id, each]))
    for (const [id, each] of devices) {
      const kept = wanted.get(id)
      if (kept === undefined || (isLinked(each) ? kept.address !== undefined || kept.carrier !== each.carrier : kept.address !== each.address)) void drop(id, each)
      else if (isLinked(each)) each.name = kept.name
    }
    const added = [...wanted.values()].filter((each) => !devices.has(each.id))
    for (const each of added) if (each.address === undefined) linkTo(each.id, each.name, each.carrier, undefined)
    await Promise.all(added.map(({ address, ...each }) => (address === undefined || programs === undefined ? undefined : reachDevice({ ...each, address }, programs))))
  }

  const followDevices = () => {
    following = following.then(connectDevices).catch(report)
  }

  const follow = (end: ProviderEnd) => {
    if (!followed.has(end)) {
      followed.add(end)
      end.listeners.listen(end.link, listeningOf(devicesInterface, 'on', 'Change', [], undefined), () => followDevices())
      end.listeners.listen(end.link, listeningOf(devicesInterface, 'on', 'Message', [], undefined), (told: unknown) => heardThrough(end, told))
    }
    followDevices()
  }

  const targetOf = async (name: string, asked: ProviderIdentity | undefined): Promise<Target | undefined> => {
    if (asked === undefined) {
      const found = await listed(name, undefined)
      const [only] = found
      if (only === undefined) throw new RpcError(rpcCodes.methodNotFound, `No program on this computer or the devices it reaches provides ${name}.`)
      if (found.length > 1) throw new RpcError(rpcCodes.methodNotFound, `${found.map(named).join(' and ')} provide ${name}, so cmod serve picks none. Call one through providers('${name}').`)
      return targetOf(name, only)
    }
    if (asked.device !== undefined && asked.device.id !== (await device()).id) {
      const carrier = devices.get(asked.device.id)
      if (carrier === undefined) throw new Error(`cmod serve reaches no device ${asked.device.name}, so ${named(asked)} there answers no ${name}.`)
      return { listeners: carrier.listeners, link: providerPeer(peerOf(carrier), asked), provider: asked }
    }
    if (isSelf(asked)) return undefined
    return providerOf(name, asked)
  }

  const providerOf = async (name: string, asked: ProviderIdentity): Promise<ProviderEnd> => {
    const end = endOf(asked)
    if (end.connection !== undefined && end.names.has(name)) return end
    const older = programs === undefined ? undefined : (await instances(name)).find((each) => keyOf(each) === keyOf(asked))
    if (older === undefined || programs === undefined) throw new Error(`${named(asked)} does not run, so it answers no ${name}.`)
    reachOlder(end, older.address, programs)
    return end
  }

  const provide = (connection: RpcConnection, params: unknown) => {
    if (!isObject(params) || typeof params['interface'] !== 'string' || typeof params['mod'] !== 'string' || (params['program'] !== undefined && typeof params['program'] !== 'string')) throw new RpcError(rpcCodes.invalidParams, `${providerActs.provide} takes { interface, mod, program }.`)
    checkInterfaceName(params['interface'])
    const end = endOf({ mod: params['mod'], ...(typeof params['program'] === 'string' ? { program: params['program'] } : {}) })
    const isNew = end.connection !== connection || !end.names.has(params['interface'])
    if (end.connection !== connection) {
      end.connection = connection
      end.names = new Set()
      void end.listeners.replay(end.link)
    }
    end.names.add(params['interface'])
    if (isNew) changed(params['interface'], undefined)
    for (const each of end.awaited) if (each.name === undefined || each.name === params['interface']) each.provided()
    if (params['interface'] === devicesInterface) follow(end)
    return {}
  }

  const provider = async (params: unknown, signal: AbortSignal): Promise<ProviderIdentity> => {
    if (!isObject(params) || (params['interface'] !== undefined && typeof params['interface'] !== 'string') || typeof params['mod'] !== 'string' || typeof params['program'] !== 'string') throw new RpcError(rpcCodes.invalidParams, `${providerActs.provider} takes { interface, mod, program }, or { mod, program } for any interface.`)
    const name = params['interface']
    const end = endOf({ mod: params['mod'], program: params['program'] })
    if (end.connection === undefined || (name === undefined ? end.names.size === 0 : !end.names.has(name))) {
      await new Promise<void>((resolve, reject) => {
        const each = {
          name,
          provided: () => {
            end.awaited.delete(each)
            resolve()
          },
        }
        end.awaited.add(each)
        signal.addEventListener(
          'abort',
          () => {
            end.awaited.delete(each)
            reject(signal.reason)
          },
          { once: true },
        )
      })
    }
    return { ...end.identity, device: await device() }
  }

  const unprovide = (connection: RpcConnection, params: unknown) => {
    const name = isObject(params) ? params['interface'] : undefined
    for (const end of ends.values()) if (end.connection === connection && typeof name === 'string' && end.names.delete(name)) changed(name, undefined)
    if (name === devicesInterface) followDevices()
    return {}
  }

  const listen = async (caller: RpcConnection, { id, provider, ...listening }: Listening, signal: AbortSignal) => {
    const target = await targetOf(listening.interface, provider)
    if (target === undefined) return own(caller)(listenMethod, { ...listening, id }, signal)
    const mine = forwarded.get(caller) ?? new Map<string, Subscription>()
    mine.get(id)?.remove()
    const sent = target.provider === undefined ? listening : { ...listening, provider: target.provider }
    mine.set(id, target.listeners.listen(target.link, sent, (payload, heard) => (listening.kind === 'on' ? caller.notify(onMethod, { id, payload } satisfies Heard) : caller.request(beforeMethod, { id, payload } satisfies Heard, heard))))
    forwarded.set(caller, mine)
    return {}
  }

  const call = async (caller: RpcConnection | undefined, { interface: name, method, args, ...asked }: ProvidedCall, signal: AbortSignal | undefined) => {
    const target = await targetOf(name, asked.mod === undefined ? undefined : { ...asked, mod: asked.mod })
    const sent = Array.isArray(args) ? args : []
    if (target !== undefined) return target.link.request(methodName(name, method), sent, signal)
    if (caller === undefined) throw new Error(`cmod serve answers its own ${name} on a connection.`)
    return own(caller)(methodName(name, method), sent, signal ?? caller.signal)
  }

  return {
    handler(connection, method, params, signal) {
      if (method === providerActs.provide) return new Promise((resolve) => resolve(provide(connection, params)))
      if (method === providerActs.unprovide) return Promise.resolve(unprovide(connection, params))
      if (method === providerActs.provider) return provider(params, signal)
      if (method === providerActs.providers) return listed(isObject(params) ? String(params['interface']) : '', isObject(params) && typeof params['device'] === 'string' ? params['device'] : undefined)
      if (method === providerActs.call) return call(connection, (isObject(params) ? params : {}) as ProvidedCall, signal)
      if (method === onMethod || method === beforeMethod) {
        const end = [...ends.values()].find((each) => each.connection === connection)
        if (end !== undefined) return heardBy(end.listeners, named(end.identity))(method, params, signal)
        const linked = [...devices.values()].find((each) => isLinked(each) && each.link === connection)
        return linked === undefined ? undefined : heardBy(linked.listeners, `the cmod serve of ${linked.name}`)(method, params, signal)
      }
      if (method === listenMethod) {
        if (!isObject(params) || typeof params['interface'] !== 'string') return undefined
        return params['provider'] === undefined && isOwn(params['interface']) ? undefined : listen(connection, params as Listening, signal)
      }
      if (method === unlistenMethod) {
        const id = isObject(params) ? params['id'] : undefined
        const mine = forwarded.get(connection)
        const listener = typeof id === 'string' ? mine?.get(id) : undefined
        if (listener === undefined) return undefined
        listener.remove()
        mine?.delete(String(id))
        return Promise.resolve({})
      }
      const dot = method.lastIndexOf('.')
      if (method.startsWith('$/') || dot === -1 || isOwn(method.slice(0, dot))) return undefined
      return call(connection, { interface: method.slice(0, dot), method: method.slice(dot + 1), args: Array.isArray(params) ? params : [] }, signal)
    },
    list: (name) => listed(name, undefined),
    call: (called, signal) => call(undefined, called, signal),
    closed(connection) {
      let listedDevices = false
      for (const end of ends.values()) {
        if (end.connection !== connection) continue
        listedDevices ||= end.names.has(devicesInterface)
        for (const name of end.names) changed(name, undefined)
        end.connection = undefined
        end.names = new Set()
      }
      for (const listener of forwarded.get(connection)?.values() ?? []) listener.remove()
      forwarded.delete(connection)
      if (listedDevices) followDevices()
    },
    async close() {
      await Promise.all([...[...ends.values()].map((end) => end.older?.client.close()), ...[...devices.entries()].map(([id, each]) => drop(id, each))])
    },
  }
}

export type ProviderList = { readonly mods: readonly string[]; readonly programs: readonly ProviderIdentity[]; readonly device?: Pick<Device, 'id' | 'name'> }

export type ProvidedListen = Omit<Listening, 'id' | 'args' | 'after' | 'provider'> & ProviderIdentity & { readonly id: string }

export type ProvidedHeard = { readonly id: string; readonly payload: unknown }

export type ProvidedTell = { readonly interface: string; readonly event: string; readonly payload: unknown }

type Asked = Pick<Listening, 'event' | 'timeoutMs' | 'onFailure'> & { readonly listener?: string; ask(signal: AbortSignal): Promise<unknown> }

async function askInTurn(asked: readonly Asked[], after: Claude['clock']['after'], report: (error: unknown) => void): Promise<unknown[]> {
  const answers: unknown[] = []
  for (const { event, timeoutMs = listenerMs, onFailure, listener, ask } of asked) {
    const passed = new AbortController()
    let timer: ReturnType<typeof after> | undefined
    const answer = await new Promise<unknown>((resolve, reject) => {
      timer = after(timeoutMs, () => {
        passed.abort()
        reject(new Error(`before${event} passed its ${timeoutMs / 1000} s timeout`))
      })
      ask(passed.signal).then(resolve, reject)
    }).catch((error: unknown) => {
      const failed = new Error(listener === undefined ? messageOf(error) : `${listener}: ${messageOf(error)}`)
      report(failed)
      return onFailure === 'refuse' ? { refuse: failed.message } : null
    })
    timer?.cancel()
    if (answer === null || answer === undefined) continue
    answers.push(answer)
    if (isObject(answer) && typeof answer['refuse'] === 'string') break
  }
  return answers
}

type SessionCodeListeners = {
  listen(caller: string, listening: ProvidedListen): null
  unlisten(caller: string, id: string): null
  tell(provider: string, told: ProvidedTell): null
  ask(provider: string, asked: ProvidedTell): Promise<unknown[]>
}

function sessionCodeListeners(hear: (caller: string, heard: ProvidedHeard, signal: AbortSignal) => Promise<unknown>, after: Claude['clock']['after'], report: (error: unknown) => void): SessionCodeListeners {
  const held = new Map<string, { readonly caller: string; readonly listening: ProvidedListen }>()
  const heldFor = (provider: string, { interface: named, event, payload }: ProvidedTell, kind: ListenKind) =>
    [...held.values()].filter(({ listening }) => listening.mod === provider && listening.interface === named && listening.event === event && listening.kind === kind && isHeardAt(listening, [], payload))
  return {
    listen(caller, listening) {
      held.set(`${caller}\n${listening.id}`, { caller, listening })
      return null
    },
    unlisten(caller, id) {
      held.delete(`${caller}\n${id}`)
      return null
    },
    tell(provider, told) {
      for (const { caller, listening } of heldFor(provider, told, 'on')) void hear(caller, { id: listening.id, payload: told.payload }, unaborted).catch(report)
      return null
    },
    ask: (provider, asked) => askInTurn(heldFor(provider, asked, 'before').map(({ caller, listening }) => ({ ...listening, listener: caller, ask: (signal: AbortSignal) => hear(caller, { id: listening.id, payload: asked.payload }, signal) })), after, report),
  }
}

export type Provided = Subscription & { tell(event: string, payload: unknown): void; ask(event: string, payload: unknown): Promise<unknown[]> }

export type Providers = {
  provided(): readonly string[]
  provide(name: string, methods: Implementation): Provided
  providers(name: string): Promise<Readonly<Record<string, unknown>>[]>
  answer(method: string, input: unknown, caller: string, signal: AbortSignal): Promise<unknown> | undefined
}

export function createProviders({ name, call, changed, after, report }: { readonly name: string; readonly call: (to: string, method: string, input: unknown) => Promise<unknown>; readonly changed: () => void; readonly after: Claude['clock']['after']; readonly report: (error: unknown) => void }): Providers {
  const provided = new Map<string, Implementation>()
  const heard = new Map<string, Listener>()
  let nextListener = 0
  const run = async ({ interface: named, method, args }: ProvidedCall) => {
    const runs = provided.get(named)?.[method] as ((...each: readonly unknown[]) => unknown) | undefined
    if (runs === undefined) throw new Error(`${name} provides no ${named}.${method}.`)
    return (await runs(...args)) ?? null
  }
  const answer = (method: string, asked: ProvidedCall & ProvidedHeard, caller: string, signal: AbortSignal): Promise<unknown> | undefined => {
    if (method === interfaceMethods.heard && caller === cmodPluginName) return (async () => (await heard.get(asked.id)?.(asked.payload as never, signal)) ?? null)()
    return method === interfaceMethods.provided && asked.program === undefined ? run(asked) : undefined
  }
  const client = (named: string, identity: ProviderIdentity) =>
    providerClient(
      named,
      identity,
      (method, args) => {
        const asked: ProvidedCall = { interface: named, method, args, ...identity }
        return beforeDeadline({ after }, callDeadline, methodName(named, method), () => identity.mod === name && identity.program === undefined ? run(asked) : call(identity.program === undefined ? identity.mod : cmodPluginName, interfaceMethods.provided, asked))
      },
      (kind, event, matcher, listener, options) => {
        const id = `${named}#${(nextListener += 1)}`
        heard.set(id, listener)
        void call(cmodPluginName, interfaceMethods.listen, { id, interface: named, kind, event, ...identity, ...(matcher === undefined ? {} : { matcher: sentMatcher(matcher) }), ...options } satisfies ProvidedListen).catch((error: unknown) => {
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
      const send = (method: string, event: string, payload: unknown) => new Promise<unknown>((resolve) => after(0, () => resolve(call(cmodPluginName, method, { interface: named, event, payload } satisfies ProvidedTell))))
      return {
        remove() {
          if (provided.get(named) === methods && provided.delete(named)) changed()
        },
        tell: (event, payload) => void send(interfaceMethods.tell, event, payload).catch(report),
        ask: (event, payload) => send(interfaceMethods.ask, event, payload) as Promise<unknown[]>,
      }
    },
    async providers(named) {
      const listed = (await call(cmodPluginName, interfaceMethods.providers, { name: named })) as ProviderList
      return [...listed.mods.map((mod) => client(named, { mod, device: listed.device })), ...listed.programs.map((identity) => client(named, identity))]
    },
    answer,
  }
}

export type KeptListen = { readonly caller: string; readonly listen: ProvidedListen }

export type ServedProviders = {
  listened(): readonly KeptListen[]
  providersChanged(name: string): Promise<void>
  forget(caller: string): void
  answer(method: string, input: unknown, caller: string | undefined): Promise<unknown> | undefined
  provide(name: string, methods: Implementation): Provided
  tell(name: string, event: string, payload: unknown): void
  ask(name: string, event: string, payload: unknown): Promise<unknown[]>
  handler(method: string, params: unknown, signal: AbortSignal): Promise<unknown> | undefined
  replay(): Promise<void>
}

export function serveProviders({
  serve,
  listeners,
  provider,
  tell,
  sessionCode,
  device,
  after,
  report,
  changed = () => undefined,
}: {
  readonly serve: Pick<Peer, 'request' | 'notify'>
  readonly changed?: () => void
  readonly listeners: InterfaceListeners
  readonly provider?: ProviderIdentity
  readonly tell: (caller: string, heard: ProvidedHeard, signal: AbortSignal) => Promise<unknown>
  readonly sessionCode: (name: string) => readonly string[]
  readonly device?: () => Promise<Pick<Device, 'id' | 'name'>>
  readonly after: Claude['clock']['after']
  readonly report: (error: unknown) => void
}): ServedProviders {
  const implementations: Record<string, Implementation> = {}
  const server = interfaceServer({ implementations })
  const handle = server.handler(serve)
  const held = new Map<string, Subscription>()
  const reported = (error: unknown) => {
    if (!isConnectionGone(error)) report(error)
  }
  const announce = (name: string) => serve.request(providerActs.provide, { interface: name, ...provider }).catch(reported)
  const listen = (caller: string | undefined, { id, interface: named, kind, event, matcher, timeoutMs, onFailure, mod, program, device: providerDevice }: ProvidedListen) => {
    if (caller === undefined) throw new Error('cmod hears no caller for this listener.')
    const key = `${caller}\n${id}`
    held.get(key)?.remove()
    const listening = { interface: named, kind, event, ...(matcher === undefined ? {} : { matcher }), ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(onFailure === undefined ? {} : { onFailure }), provider: { mod, ...(program === undefined ? {} : { program }), ...(providerDevice === undefined ? {} : { device: providerDevice }) } }
    held.set(key, listeners.listen(serve, listening, (payload: unknown, signal) => tell(caller, { id, payload }, signal)))
    return null
  }
  const unlisten = (caller: string | undefined, id: string) => {
    const key = `${caller}\n${id}`
    held.get(key)?.remove()
    held.delete(key)
    return null
  }
  const sessionListeners = sessionCodeListeners(tell, after, report)
  const kept = new Map<string, KeptListen>()
  const listenFor = (caller: string | undefined, listening: ProvidedListen) => {
    const answer = listening.program === undefined ? sessionListeners.listen(String(caller), listening) : listen(caller, listening)
    kept.set(`${caller}\n${listening.id}`, { caller: String(caller), listen: listening })
    changed()
    return answer
  }
  const stopListening = (caller: string | undefined, id: string) => {
    sessionListeners.unlisten(String(caller), id)
    unlisten(caller, id)
    if (kept.delete(`${caller}\n${id}`)) changed()
    return null
  }
  const ask = (name: string, event: string, payload: unknown) =>
    askInTurn(
      server.listeners(name, event).filter((listening) => listening.kind === 'before' && isHeardAt(listening, [], payload)).map((listening) => ({ ...listening, ask: (signal: AbortSignal) => listening.connection.request(beforeMethod, { id: listening.id, payload } satisfies Heard, signal) })),
      after,
      report,
    )
  const listed = async (named: string): Promise<ProviderList> => {
    const mods = sessionCode(named)
    const programs = await serve.request<ProviderIdentity[]>(providerActs.providers, { interface: named })
    return { mods, programs, ...(mods.length === 0 || device === undefined ? {} : { device: await device() }) }
  }
  const waitForProvider = async ({ interface: named, mod, program }: Readonly<Record<string, unknown>>): Promise<ProviderIdentity | null> => {
    const held = new AbortController()
    const timer = after(providerHoldMs, () => held.abort())
    try {
      return await serve.request<ProviderIdentity>(providerActs.provider, { interface: named, mod, program }, held.signal)
    } catch (error) {
      if (!held.signal.aborted && !isConnectionGone(error)) throw error
      await new Promise<void>((resolve) => (held.signal.aborted ? resolve() : held.signal.addEventListener('abort', () => resolve(), { once: true })))
      return null
    } finally {
      timer.cancel()
    }
  }
  return {
    answer(method, input, caller) {
      const asked = isObject(input) ? input : {}
      if (method === interfaceMethods.providers) return listed(String(asked['name']))
      if (method === interfaceMethods.provider) return waitForProvider(asked)
      if (method === interfaceMethods.listen) return new Promise((resolve) => resolve(listenFor(caller, input as ProvidedListen)))
      if (method === interfaceMethods.unlisten) return Promise.resolve(stopListening(caller, String(asked['id'])))
      if (method === interfaceMethods.tell) return Promise.resolve(sessionListeners.tell(String(caller), input as ProvidedTell))
      if (method === interfaceMethods.ask) return sessionListeners.ask(String(caller), input as ProvidedTell)
      const call = asked as Partial<ProvidedCall>
      if (method !== interfaceMethods.provided || call.program === undefined || call.mod === undefined) return undefined
      return beforeDeadline({ after }, callDeadline, methodName(String(call.interface), String(call.method)), (signal) => serve.request(providerActs.call, call, signal))
    },
    provide(name, methods) {
      checkInterfaceName(name)
      if (provider === undefined) throw new Error(`${name}: this connection to cmod serve provides nothing.`)
      implementations[name] = methods
      void announce(name)
      return {
        remove() {
          if (implementations[name] !== methods) return
          delete implementations[name]
          void serve.request(providerActs.unprovide, { interface: name }).catch(reported)
        },
        tell: (event, payload) => server.emit(name, event, payload),
        ask: (event, payload) => ask(name, event, payload),
      }
    },
    tell: (name, event, payload) => server.emit(name, event, payload),
    ask,
    listened: () => [...kept.values()],
    async providersChanged(name) {
      if (device === undefined) return
      const here = await device()
      const payload = { interface: name, device: here } satisfies ProvidersChange
      const isHere = (listened: ProvidedListen) => listened.mod === cmodPluginName && listened.program === cmodPluginName && (listened.device === undefined || listened.device.id === here.id)
      for (const { caller, listen } of kept.values()) {
        if (listen.interface === providersInterface && listen.event === 'Change' && listen.kind === 'on' && isHere(listen) && isHeardAt(listen, [], payload)) void tell(caller, { id: listen.id, payload }, unaborted).catch(reported)
      }
    },
    forget(caller) {
      for (const each of [...kept.values()].filter((listened) => listened.caller === caller)) stopListening(caller, each.listen.id)
    },
    handler(method, params, signal) {
      const isProvided = method === listenMethod || method === unlistenMethod || (!method.startsWith('$/') && method.includes('.'))
      return isProvided ? Promise.resolve(handle(method, params, signal)) : undefined
    },
    async replay() {
      await Promise.all(Object.keys(implementations).map(announce))
    },
  }
}

export type Connection = {
  call(name: string, method: string, params: readonly unknown[]): Promise<unknown>
  listen(name: string, event: string, listener: (payload: unknown, signal: AbortSignal) => unknown): Subscription
  tell(name: string, event: string, payload: unknown): void
  ask(name: string, event: string, payload: unknown): Promise<unknown[]>
  close(): Promise<void>
}

export function programConnection({ client, listeners, served, after }: { readonly client: RpcClient; readonly listeners: InterfaceListeners; readonly served: ServedProviders; readonly after: Claude['clock']['after'] }): Connection {
  return {
    call: (name, method, params) => {
      const called = methodName(name, method)
      return beforeDeadline({ after }, callDeadline, called, (signal) => client.request(called, params, signal))
    },
    listen: (name, event, listener) => listeners.listen(client, listeningOf(name, 'on', event, [], undefined), listener),
    tell: (name, event, payload) => served.tell(name, event, payload),
    ask: (name, event, payload) => served.ask(name, event, payload),
    close: () => client.close(),
  }
}
