import { expect, test } from 'bun:test'
import { defineMod, providers } from '../../src/mod.js'
import { createProviders, interfaceClient, interfaceListeners, interfaceServer, servePrograms, type ProvidedHeard } from '../../src/runtime/interfaces.js'
import { addressCall, connectRpc, rpcRoutes } from '../../src/runtime/rpc.js'
import { testMod } from '../../src/testing.js'

declare function setTimeout(run: () => void, ms: number): unknown

const settle = () => new Promise<void>((resolve) => void setTimeout(resolve, 50))

declare module 'claude-code' {
  interface CmodInterfaces {
    'demo/Echo': { methods: { echo(text: string): string } }
    'demo/Platform': { methods: { machines(region: string): string[] }; events: { MachineChange: { readonly name: string } } }
  }
}

test("a mod's session code provides an interface, and providers names the mod and answers its methods", async () => {
  const tested = testMod(
    defineMod({
      name: 'demo',
      setup(mod) {
        mod.provide('demo/Echo', { echo: (text) => `heard ${text}` })
      },
    }),
  )
  await tested.start()

  const found = await providers('demo/Echo')

  expect(found.map((each) => each.mod)).toEqual(['demo'])
  expect(await found[0]?.echo('ping')).toBe('heard ping')
})

test("a mod reaches a program's provider through the cmod plugin, which holds the one connection to it, calls its methods and hears its events", async () => {
  const server = interfaceServer({ implementations: { 'demo/Platform': { machines: (region: string) => [`${region}-1`] } } })
  const routes = rpcRoutes({ handle: (connection) => server.handler(connection), now: () => Date.now() })
  const fetch = async (url: string, init: { readonly method: string; readonly body?: string }) => {
    const answer = await routes.route({ method: init.method, path: new URL(url).pathname, signal: new AbortController().signal, json: async () => JSON.parse(String(init.body)) as unknown })
    return { status: answer?.status ?? 404, text: answer?.json === undefined ? '' : JSON.stringify(answer.json) }
  }
  const instance = JSON.stringify({ address: 'unix:/store/boat.sock', pid: 1, started: '', provides: ['demo/Platform'] })
  const files = {
    list: async (path: string) => (path === '/store/instances' ? [{ name: 'boat', kind: 'dir' }] : path === '/store/instances/boat' ? [{ name: 'boat.json', kind: 'file' }] : []),
    read: async (path: string) => (path === '/store/instances/boat/boat.json' ? instance : undefined),
  }
  const heard: string[] = []
  let mod: ReturnType<typeof createProviders> | undefined
  const programs = servePrograms({ store: '/store', fetch, files, wait: () => new Promise(() => undefined), report: (error) => void heard.push(String(error)), tell: (_caller, told: ProvidedHeard, signal) => mod?.heard(told, signal) ?? Promise.resolve(null), sessionCode: () => [] })
  mod = createProviders({ name: 'anyhost', call: async (_to, method, input) => programs.answer(method, input, 'anyhost'), changed: () => undefined, report: (error) => void heard.push(String(error)) })

  const [platform] = (await mod.providers('demo/Platform')) as unknown as readonly { readonly mod: string; readonly program: string; machines(region: string): Promise<string[]>; onMachineChange(listener: (machine: { readonly name: string }) => void): void }[]
  platform?.onMachineChange((machine) => void heard.push(machine.name))
  await settle()
  server.emit('demo/Platform', 'MachineChange', { name: 'eu-2' }, [])
  await settle()

  expect([platform?.mod, platform?.program]).toEqual(['boat', 'boat'])
  expect(await platform?.machines('eu')).toEqual(['eu-1'])
  expect(heard).toEqual(['eu-2'])
  await programs.close()
  routes.close()
})

test('a listener added before its program answers reports nothing, and hears the program once it connects', async () => {
  const server = interfaceServer({ implementations: { 'demo/Platform': { machines: () => [] } } })
  const routes = rpcRoutes({ handle: (connection) => server.handler(connection), now: () => Date.now() })
  let isUp = false
  const fetch = async (url: string, init: { readonly method: string; readonly body?: string }) => {
    if (!isUp) throw new Error('ECONNREFUSED')
    const answer = await routes.route({ method: init.method, path: new URL(url).pathname, signal: new AbortController().signal, json: async () => JSON.parse(String(init.body)) as unknown })
    return { status: answer?.status ?? 404, text: answer?.json === undefined ? '' : JSON.stringify(answer.json) }
  }
  const reported: string[] = []
  const listeners = interfaceListeners({ report: (error) => void reported.push(String(error)) })
  const client = connectRpc({ call: addressCall(fetch, 'unix:/store/boat.sock'), handle: (method, params, signal) => listeners.handler(method, params, signal), onConnect: (connected) => listeners.replay(connected), wait: settle, retryMs: 0, keepsConnecting: true })
  const platform = interfaceClient('demo/Platform', client, listeners) as unknown as { onMachineChange(listener: (machine: { readonly name: string }) => void): void }
  const heard: string[] = []

  platform.onMachineChange((machine) => void heard.push(machine.name))
  await settle()
  isUp = true
  await settle()
  await settle()
  server.emit('demo/Platform', 'MachineChange', { name: 'eu-2' }, [])
  await settle()

  expect(reported).toEqual([])
  expect(heard).toEqual(['eu-2'])
  await client.close()
  routes.close()
})
