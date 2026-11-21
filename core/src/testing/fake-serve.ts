import type { HttpInit, HttpResponse } from 'claude-code'
import type { Claude } from '../runtime/claude.js'
import { devicesInterface, interfaceListeners, providerActs, routeSessions, serveProviders, type Implementation, type ProgramReach, type Provided, type ProvidedHeard, type ProviderIdentity, type ServedProviders, type SessionComputer, type SessionRouting } from '../runtime/interfaces.js'
import { addressCall, connectRpc, RpcError, rpcCodes, type RpcClient } from '../runtime/rpc.js'
import type { Device } from '../session/context/turn/device.js'

type Here = Pick<Device, 'id' | 'name'>

export type ServeConnection = {
  readonly provider?: ProviderIdentity
  readonly tell?: (caller: string, heard: ProvidedHeard, signal: AbortSignal) => Promise<unknown>
  readonly sessionCode?: (name: string) => readonly string[]
  readonly device?: () => Promise<Here>
  readonly after: Claude['clock']['after']
  readonly report: (error: unknown) => void
}

export type FakeProgram = { readonly name: string; readonly mod: string; readonly program: string; readonly device?: Here; readonly methods: Implementation }

export type FakeServe = {
  readonly routing: SessionRouting
  readonly requests: number
  fetch(url: string, init?: HttpInit): Promise<HttpResponse>
  connect(connection: ServeConnection): ServedProviders
  provide(programs: readonly FakeProgram[], connection: Pick<ServeConnection, 'after' | 'report'>): Promise<Provided[]>
  close(): void
}

export type ServeClock = { now(): number; after(ms: number, run: () => void): unknown }

declare function setTimeout(run: () => void, ms: number): unknown

const realClock: ServeClock = { now: () => Date.now(), after: (ms, run) => setTimeout(run, ms) }

const wait = (ms: number) => new Promise<void>((resolve) => void setTimeout(resolve, ms))

const notHere = (session: string) => new RpcError(rpcCodes.notHeld, `No session ${session} on this computer.`)

const unfaked: SessionComputer = {
  sessions: () => [],
  search: () => [],
  read: (_session, part) => (part === 'goal' ? { text: '' } : part === 'state' ? null : []),
  unheld: (session) => Promise.reject(notHere(session)),
  visit: async () => undefined,
  remove: async () => undefined,
}

const deviceLink: ProviderIdentity = { mod: 'testMod', program: 'devices' }

const socketOf = (device: string) => `/test/devices/${device}/serve.sock`

export function fakeServe(
  fakes: () => Partial<SessionComputer>,
  { device, programs, clock = realClock }: { readonly device: () => Promise<Here>; readonly programs?: ProgramReach; readonly clock?: ServeClock },
): FakeServe {
  const answer = <Key extends keyof SessionComputer>(key: Key): SessionComputer[Key] => (fakes()[key] ?? unfaked[key])
  const linked = new Map<string, FakeServe>()
  const reached = new Map<string, Here>()
  let devices: Provided | undefined
  let requests = 0
  const routing = routeSessions({
    device,
    programs: {
      store: programs?.store ?? '/test/store',
      files: programs?.files ?? { list: async () => [], read: async () => undefined },
      fetch: (url, init) => linked.get(init.socketPath ?? '')?.fetch(url, init) ?? programs?.fetch(url, init) ?? Promise.resolve({ status: 404, text: '' }),
      wait: programs?.wait ?? wait,
    },
    now: () => clock.now(),
    after: (ms, run) => clock.after(ms, run),
    report: (error) => {
      throw error
    },
    computer: {
      sessions: (...args) => answer('sessions')(...args),
      search: (...args) => answer('search')(...args),
      read: (...args) => answer('read')(...args),
      unheld: (...args) => answer('unheld')(...args),
      visit: (...args) => answer('visit')(...args),
      remove: (...args) => answer('remove')(...args),
    },
  })
  const serve: FakeServe = {
    routing,
    get requests() {
      return requests + [...linked.values()].reduce((sum, each) => sum + each.requests, 0)
    },
    async fetch(url, init = {}) {
      requests += 1
      const answered = await routing.routes.route({ method: init.method ?? 'GET', path: new URL(url).pathname, signal: new AbortController().signal, json: async () => JSON.parse(String(init.body)) as unknown })
      if (answered === undefined) return { status: 404, ok: false, headers: {}, text: '' }
      return { status: answered.status, ok: answered.status >= 200 && answered.status < 300, headers: {}, text: answered.json === undefined ? '' : JSON.stringify(answered.json) }
    },
    connect: (connection) => connectTo(serve, connection).served,
    async provide(given, connection) {
      if (given.length === 0) return []
      const here = await device()
      const added = new Map(given.flatMap(({ device: on }) => (on === undefined || on.id === here.id || reached.has(on.id) ? [] : [[on.id, on] as const])))
      for (const on of added.values()) {
        reached.set(on.id, on)
        linked.set(socketOf(on.id), fakeServe(() => ({}), { device: async () => on, clock }))
      }
      const provided = await Promise.all(
        given.map(async ({ name, mod, program, device: on, methods }) => {
          const { client, served } = connectTo((on === undefined ? undefined : linked.get(socketOf(on.id))) ?? serve, { ...connection, provider: { mod, program } })
          const each = served.provide(name, methods)
          await client.request(providerActs.providers, { interface: name })
          return each
        }),
      )
      if (added.size === 0) return provided
      if (devices !== undefined) {
        for (const on of added.keys()) devices.tell('Change', { device: on })
        return provided
      }
      const { client, served } = connectTo(serve, { ...connection, provider: deviceLink })
      devices = served.provide(devicesInterface, {
        devices: () => [...reached.values()].map(({ id, name }) => ({ id, name, address: socketOf(id) })),
        send: (to: string) => {
          throw new Error(`The test kit reaches device ${to} at its address, so it carries no message.`)
        },
      })
      await client.request(providerActs.providers, { interface: devicesInterface })
      return provided
    },
    close: () => {
      routing.close()
      for (const each of linked.values()) each.close()
    },
  }
  return serve
}

function connectTo(serve: Pick<FakeServe, 'fetch'>, { provider, tell = async () => null, sessionCode = () => [], device, after, report }: ServeConnection): { readonly client: RpcClient; readonly served: ServedProviders } {
  const listeners = interfaceListeners({ report })
  const client = connectRpc({
    call: addressCall((url, init) => serve.fetch(url, init), 'unix:/test/serve.sock'),
    handle: async (method, params, signal) => {
      const answered = await listeners.handler(method, params, signal)
      if (answered !== undefined) return answered.result
      const provided = served.handler(method, params, signal)
      if (provided !== undefined) return provided
      throw new RpcError(rpcCodes.methodNotFound, `This connection to cmod serve answers no ${method}.`)
    },
    onConnect: async (connected) => {
      await served.replay()
      await listeners.replay(connected)
    },
    wait,
  })
  const served = serveProviders({ serve: client, listeners, ...(provider === undefined ? {} : { provider }), tell, sessionCode, ...(device === undefined ? {} : { device }), after, report })
  return { client, served }
}
