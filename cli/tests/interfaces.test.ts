import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interfaceClient, interfaceListeners, interfaceServer, providersIn, type InterfaceListeners } from '@cmodjs/core/src/runtime/interfaces.js'
import { connectRpc, rpcRoutes, type RpcClient } from '@cmodjs/core/src/runtime/rpc.js'
import { answered } from '../src/serve.js'

const stops: (() => Promise<unknown>)[] = []

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

function serve(socket: string, server: ReturnType<typeof interfaceServer>) {
  const routes = rpcRoutes({ handle: (connection) => server.handler(connection), onClose: (connection) => server.closed(connection), now: () => Date.now() })
  const http = Bun.serve({ unix: socket, fetch: (request) => answered(routes, request) ?? new Response('', { status: 404 }) })
  stops.push(async () => {
    routes.close()
    await http.stop(true)
  })
  return routes
}

function connect(socket: string, onConnect?: (client: RpcClient, listeners: InterfaceListeners) => unknown) {
  const listeners = interfaceListeners({ report: (error) => console.error(error) })
  const client = connectRpc({
    call: async (path, init) => {
      const answer = await fetch(`http://localhost${path}`, { method: init.method, ...(init.body === undefined ? {} : { body: init.body, headers: { 'content-type': 'application/json' } }), unix: socket } as RequestInit)
      return { status: answer.status, text: await answer.text() }
    },
    handle: async (method, params, signal) => {
      const answered = await listeners.handler(method, params, signal)
      if (answered === undefined) throw new Error(`no ${method}`)
      return answered.result
    },
    onConnect: (connected) => onConnect?.(connected, listeners),
    wait: (ms) => new Promise((resolve) => void setTimeout(resolve, ms)),
    retryMs: 50,
  })
  stops.push(() => client.close())
  return { client, listeners }
}

function folder() {
  const made = mkdtempSync(join(tmpdir(), 'cmod-rpc-'))
  stops.push(async () => rmSync(made, { recursive: true, force: true }))
  return join(made, 'serve.sock')
}

test("a client calls a provider's method by its interface and gets the answer", async () => {
  const socket = folder()
  serve(socket, interfaceServer({ implementations: { 'demo/Platform': { machines: (region: string) => [{ name: `${region}-1` }] } } }))
  const { client, listeners } = connect(socket)

  const platform = interfaceClient('demo/Platform', client, listeners) as { machines(region: string): Promise<unknown> }

  expect(await platform.machines('eu')).toEqual([{ name: 'eu-1' }])
})

test('a method the provider lacks fails with its name', async () => {
  const socket = folder()
  serve(socket, interfaceServer({ implementations: { 'demo/Platform': {} } }))
  const { client, listeners } = connect(socket)

  const platform = interfaceClient('demo/Platform', client, listeners) as { destroy(): Promise<unknown> }

  expect(platform.destroy()).rejects.toThrow('This program answers no demo/Platform.destroy.')
})

test("an on listener hears each event its matcher matches, and a before listener's refusal reaches the provider", async () => {
  const socket = folder()
  const server = interfaceServer({ implementations: { 'demo/Platform': {} } })
  serve(socket, server)
  const { client, listeners } = connect(socket)
  const platform = interfaceClient('demo/Platform', client, listeners) as Record<string, (...args: unknown[]) => unknown>
  const heard: unknown[] = []

  platform['onMachineChange']?.({ state: 'ready' }, (machine: unknown) => void heard.push(machine))
  platform['beforeMachineCreate']?.((spec: { readonly size: string }) => (spec.size === 'huge' ? { refuse: 'too big' } : undefined), { timeoutMs: 5000 })
  await Bun.sleep(100)
  server.emit('demo/Platform', 'MachineChange', { name: 'a', state: 'booting' })
  server.emit('demo/Platform', 'MachineChange', { name: 'a', state: 'ready' })
  const answers = await server.ask('demo/Platform', 'MachineCreate', { size: 'huge' })
  await Bun.sleep(100)

  expect(heard).toEqual([{ name: 'a', state: 'ready' }])
  expect(answers.map(({ answer }) => answer)).toEqual([{ refuse: 'too big' }])
  expect(answers[0]?.listening.timeoutMs).toBe(5000)
})

test('a listener the client removed hears nothing, and a closed connection drops its listeners at the provider', async () => {
  const socket = folder()
  const server = interfaceServer({ implementations: { 'demo/Platform': {} } })
  serve(socket, server)
  const { client, listeners } = connect(socket)
  const platform = interfaceClient('demo/Platform', client, listeners) as Record<string, (...args: unknown[]) => { remove(): void }>

  const subscription = platform['onMachineChange']?.(() => undefined)
  platform['onMachineDelete']?.(() => undefined)
  await Bun.sleep(100)
  subscription?.remove()
  await Bun.sleep(100)
  const afterRemove = server.listeners('demo/Platform').map((each) => each.event)
  await client.close()
  await Bun.sleep(100)

  expect(afterRemove).toEqual(['MachineDelete'])
  expect(server.listeners('demo/Platform')).toEqual([])
})

test("a client that lost its connection connects again, listens again from the last event it heard, and hears what it missed", async () => {
  const socket = folder()
  const server = interfaceServer({ implementations: { 'demo/Platform': {} } })
  const routes = serve(socket, server)
  let connects = 0
  const { client, listeners } = connect(socket, (connected, held) => {
    connects += 1
    if (connects > 1) return held.replay(connected)
    return undefined
  })
  const platform = interfaceClient('demo/Platform', client, listeners) as Record<string, (...args: unknown[]) => unknown>
  const heard: unknown[] = []
  platform['onMachineChange']?.((machine: unknown) => void heard.push(machine))
  await Bun.sleep(100)
  server.emit('demo/Platform', 'MachineChange', { name: 'first' })
  await Bun.sleep(100)

  for (const connection of routes.connections()) connection.close(new Error('dropped'))
  routes.close()
  server.emit('demo/Platform', 'MachineChange', { name: 'missed' })
  await client.request('demo/Platform.ping', []).catch((error: unknown) => {
    expect(error).toBeInstanceOf(Error)
  })
  await Bun.sleep(300)

  expect(connects).toBe(2)
  expect(heard).toEqual([{ name: 'first' }, { name: 'missed' }])
})

test('providers are the programs whose instance record provides the interface', () => {
  const records = [
    { mod: 'anyhost', program: 'anyhost', instance: { address: 'unix:/run/anyhost.sock', pid: 1, started: '', provides: ['cmod/SessionStore', 'cmod/Terminal'] } },
    { mod: 'boat', program: 'boat', instance: { address: '127.0.0.1:4000', pid: 2, started: '', provides: ['anyhost/Platform'] } },
    { mod: 'preview', program: 'preview-server', instance: { address: '127.0.0.1:4001', pid: 3, started: '' } },
  ]

  expect(providersIn(records, 'cmod/Terminal')).toEqual([{ mod: 'anyhost', program: 'anyhost', address: 'unix:/run/anyhost.sock', provides: ['cmod/SessionStore', 'cmod/Terminal'] }])
  expect(providersIn(records, 'anyhost/Platform').map((each) => each.mod)).toEqual(['boat'])
})
