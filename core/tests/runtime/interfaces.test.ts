import { expect, test } from 'bun:test'
import { defineMod, provide, providers, sessions, type Provided } from '../../src/mod.js'
import { createProviders, interfaceListeners, interfaceMethods, interfaceServer, listeningOf, methodName, programConnection, providerHoldMs, routeSessions, serveProviders, showLeaseMs, uiInterface, type ProviderIdentity, type ServedProviders, type SessionComputer, type SessionTerminals } from '../../src/runtime/interfaces.js'
import { addressCall, connectRpc, RpcError, rpcCodes, rpcRoutes, type HttpFetch, type RpcHttpAnswer, type RpcRoutes } from '../../src/runtime/rpc.js'
import { didNotAnswer } from '../../src/runtime/dependencies.js'
import { testMod } from '../../src/testing.js'
import { claudeCodeOf } from '../../src/testing/claude-code.js'
import { program, type Program } from '../../src/jobs/program.js'
import { testDevice } from '../../src/testing/fake-claude.js'

const atOnce = async () => undefined

declare module 'claude-code' {
  interface CmodInterfaces {
    'demo/Echo': { methods: { echo(text: string): string }; events: { Change: { readonly text: string } } }
    'demo/Platform': { methods: { machines(region: string): string[] }; events: { MachineChange: { readonly name: string } } }
    'demo/Rules': { events: { Check: { readonly tool: string } } }
  }
}

type Rules = { readonly mod: string; beforeCheck(listener: (check: { readonly tool: string }) => unknown): unknown }

const noSessions: SessionComputer = {
  sessions: () => [],
  search: () => [],
  read: () => [],
  unheld: () => Promise.reject(new Error('no session')),
  visit: async () => undefined,
  remove: async () => undefined,
}

function fetchOf(routesAt: (socketPath: string | undefined) => RpcRoutes | undefined): HttpFetch {
  return async (url, init) => {
    const answer = await routesAt(init.socketPath)?.route({ method: init.method, path: `${new URL(url).pathname}${new URL(url).search}`, signal: new AbortController().signal, json: async () => JSON.parse(String(init.body)) as unknown })
    return { status: answer?.status ?? 404, text: answer?.json === undefined ? '' : JSON.stringify(answer.json) }
  }
}

function manualClock() {
  let at = 0
  const due: { readonly at: number; readonly run: () => void }[] = []
  return {
    now: () => at,
    after: (ms: number, run: () => void) => {
      const timer = { at: at + ms, run }
      due.push(timer)
      return {
        cancel() {
          if (due.includes(timer)) due.splice(due.indexOf(timer), 1)
        },
      }
    },
    pass(ms: number) {
      at += ms
      for (const timer of due.filter((each) => each.at <= at)) {
        due.splice(due.indexOf(timer), 1)
        timer.run()
      }
    },
  }
}

function servedComputer(programs: Readonly<Record<string, RpcRoutes>> = {}, instances: Readonly<Record<string, string>> = {}, { device = { id: 'mac-id', name: 'mac' }, computer = noSessions, terminals }: { readonly device?: { readonly id: string; readonly name: string }; readonly computer?: SessionComputer; readonly terminals?: SessionTerminals } = {}) {
  const files = {
    list: async (path: string) => {
      const prefix = `${path}/`
      const names = Object.keys(instances).filter((each) => each.startsWith(prefix)).map((each) => each.slice(prefix.length).split('/'))
      return [...new Set(names.map((parts) => parts[0] ?? ''))].map((name) => ({ name, kind: names.some((parts) => parts[0] === name && parts.length > 1) ? 'dir' : 'file' }))
    },
    read: async (path: string) => instances[path],
  }
  const reported: string[] = []
  const report = (error: unknown) => void reported.push(String(error))
  const fetch: HttpFetch = (url, init) => fetchOf((socketPath) => (socketPath === '/store/serve.sock' ? serve.routes : programs[socketPath ?? '']))(url, init)
  const clock = manualClock()
  const serve = routeSessions({ computer, device: async () => device, now: clock.now, after: clock.after, report, programs: { store: '/store', files, fetch, wait: atOnce }, ...(terminals === undefined ? {} : { terminals }) })
  const connect = (name: string, provider?: ProviderIdentity) => {
    const listeners = interfaceListeners({ report })
    let served: ServedProviders | undefined
    const client = connectRpc({
      call: addressCall(fetch, 'unix:/store/serve.sock'),
      handle: async (method, params, signal) => {
        const answered = await listeners.handler(method, params, signal)
        if (answered !== undefined) return answered.result
        return served?.handler(method, params, signal) ?? null
      },
      onConnect: async (connected) => {
        await served?.replay()
        await listeners.replay(connected)
      },
      wait: atOnce,
    })
    const mods = new Map<string, ReturnType<typeof createProviders>>()
    served = serveProviders({
      serve: client,
      listeners,
      ...(provider === undefined ? {} : { provider }),
      tell: async (caller, heard, signal) => mods.get(caller)?.answer(interfaceMethods.heard, heard, 'cmod', signal),
      sessionCode: (named) => [...mods].filter(([, each]) => each.provided().includes(named)).map(([each]) => each),
      after: clock.after,
      report,
    })
    const answering = served
    const join = (named: string) => {
      const made = createProviders({ name: named, call: async (_to, method, input) => answering.answer(method, input, named), changed: () => undefined, after: clock.after, report })
      mods.set(named, made)
      return made
    }
    return { client, listeners, served: answering, mod: join(name), join }
  }
  return { serve, connect, reported, fetch, clock }
}

test("a mod's session code provides an interface, and providers names the mod and answers its methods", async () => {
  const tested = testMod(
    defineMod({
      name: 'demo',
      setup() {
        provide('demo/Echo', { echo: (text) => `heard ${text}` })
      },
    }),
  )
  await tested.start()

  const found = await providers('demo/Echo')

  expect(found.map((each) => each.mod)).toEqual(['demo'])
  expect(await found[0]?.echo('ping')).toBe('heard ping')
})

test("a session-code provider's tell reaches an onChange listener in the same session, and only one its matcher matches", async () => {
  let echo: Provided<'demo/Echo'> | undefined
  const tested = testMod(defineMod({ name: 'demo', setup: () => void (echo = provide('demo/Echo', { echo: (text) => text })) }))
  await tested.start()
  const [found] = await providers('demo/Echo')

  const heard = new Promise<string>((resolve) => found?.onChange({ text: 'eu-2' }, (change) => resolve(change.text)))
  echo?.tell('Change', { text: 'eu-1' })
  echo?.tell('Change', { text: 'eu-2' })

  expect(await heard).toBe('eu-2')
})

test("a session-code provider's tell from inside its own method, answering another mod's call, reaches a listener in the same session", async () => {
  let echo: Provided<'demo/Echo'> | undefined
  const tested = testMod(defineMod({ name: 'demo', setup: () => void (echo = provide('demo/Echo', { echo: (text) => (echo?.tell('Change', { text }), `heard ${text}`) })) }))
  await tested.start()
  const [found] = await providers('demo/Echo')
  const heard = new Promise<string>((resolve) => found?.onChange((change) => resolve(change.text)))

  const answer = await claudeCodeOf(tested).fire('cmod.call', { to: 'demo', method: 'cmod:provided', input: { interface: 'demo/Echo', method: 'echo', args: ['eu-3'] }, caller: 'boat' } as never)

  expect(answer).toEqual({ value: 'heard eu-3' })
  expect(await heard).toBe('eu-3')
})

test("a session-code provider's ask returns what another mod's beforeCheck listener in the same session answers", async () => {
  const { serve, connect, reported, clock } = servedComputer()
  const { client, mod: rulebook, join } = connect('rulebook')
  const rules = rulebook.provide('demo/Rules', {})
  const [found] = (await join('modes').providers('demo/Rules')) as unknown as readonly Rules[]
  found?.beforeCheck(() => ({ rules: { a: 'off' } }))

  const asking = rules.ask('Check', { tool: 'Bash' })
  clock.pass(0)
  const answers = await asking

  expect(found?.mod).toBe('rulebook')
  expect(answers).toEqual([{ rules: { a: 'off' } }])
  expect(reported).toEqual([])
  await client.close()
  serve.close()
})

test('an ask stops at the first listener that refuses, and asks no listener after it', async () => {
  const { serve, connect, clock } = servedComputer()
  const { client, mod: rulebook, join } = connect('rulebook')
  const rules = rulebook.provide('demo/Rules', {})
  const [byModes] = (await join('modes').providers('demo/Rules')) as unknown as readonly Rules[]
  const [byAudit] = (await join('audit').providers('demo/Rules')) as unknown as readonly Rules[]
  const asked: string[] = []
  byModes?.beforeCheck(() => (asked.push('modes'), { refuse: 'Bash is off in this mode' }))
  byAudit?.beforeCheck(() => void asked.push('audit'))

  const asking = rules.ask('Check', { tool: 'Bash' })
  clock.pass(0)
  const answers = await asking

  expect(answers).toEqual([{ refuse: 'Bash is off in this mode' }])
  expect(asked).toEqual(['modes'])
  await client.close()
  serve.close()
})

test("a before listener past its timeoutMs counts as its onFailure says on the test kit's clock: 'pass' leaves its answer out, and 'refuse' refuses the ask", async () => {
  let rules: Provided<'demo/Rules'> | undefined
  const tested = testMod(defineMod({ name: 'demo', setup: () => void (rules = provide('demo/Rules', {})) }))
  await tested.start()
  const [own] = await providers('demo/Rules')
  own?.beforeCheck(() => new Promise(() => undefined), { timeoutMs: 20 })
  own?.beforeCheck(() => new Promise(() => undefined), { timeoutMs: 30, onFailure: 'refuse' })
  const due = new Map<number, () => void>()
  let added: () => void = () => undefined
  tested.fakes.clock.after = (ms, fire) => {
    if (ms === 0) void Promise.resolve().then(fire)
    else due.set(ms, fire)
    added()
    return { cancel: () => undefined }
  }
  const timerOf = (ms: number) =>
    new Promise<() => void>((resolve) => {
      added = () => {
        const fire = due.get(ms)
        if (fire !== undefined) resolve(fire)
      }
      added()
    })

  const asked = rules?.ask('Check', { tool: 'Bash' })
  ;(await timerOf(20))()
  ;(await timerOf(30))()

  expect(await asked).toEqual([{ refuse: 'demo: beforeCheck passed its 0.03 s timeout' }])
  expect(tested.shown.debug).toEqual(expect.arrayContaining(['cmod: A provider listener failed: demo: beforeCheck passed its 0.02 s timeout', 'cmod: A provider listener failed: demo: beforeCheck passed its 0.03 s timeout']))
})

test("a provider's ask from inside its own beforeToolCall listener, which the cmod plugin calls, waits one 0 ms timer before it calls the cmod plugin, and reaches the listener", async () => {
  const tested = testMod(
    defineMod({
      name: 'demo',
      setup() {
        const rules = provide('demo/Rules', {})
        sessions.current.beforeToolCall(async (call) => (await rules.ask('Check', { tool: call.name }))[0] as { readonly refuse: string } | undefined)
      },
    }),
  )
  await tested.start()
  const [own] = await providers('demo/Rules')
  own?.beforeCheck((check) => (check.tool === 'Bash' ? { refuse: 'Bash is off in this mode' } : undefined))
  const held: (() => void)[] = []
  let isHolding = true
  let heldOne: () => void = () => undefined
  const isHeld = new Promise<void>((resolve) => {
    heldOne = resolve
  })
  tested.fakes.clock.after = (ms, fire) => {
    if (ms === 0 && isHolding) {
      held.push(fire)
      heldOne()
    } else if (ms === 0) void Promise.resolve().then(fire)
    return { cancel: () => undefined }
  }
  const asks = () => tested.calls.filter(({ call, args }) => call === 'cmod.call' && (args[0] as { readonly method: string }).method === 'cmod:askProvided').length

  const answer = tested.raise.beforeToolCall({ name: 'Bash', input: { command: 'ls' } })
  await isHeld
  const asksWhileHeld = asks()
  isHolding = false
  for (const fire of held.splice(0)) fire()

  expect(asksWhileHeld).toBe(0)
  expect(await answer).toEqual({ refuse: 'Bash is off in this mode' })
  expect(asks()).toBe(1)
})

test("a program provider's ask reaches a session mod's beforeCheck listener through cmod serve, and one past its timeoutMs refuses as its onFailure says", async () => {
  const { serve, connect, reported, clock } = servedComputer()
  const program = connect('rulebook', { mod: 'rulebook', program: 'rules' })
  const session = connect('modes')
  const rules = program.served.provide('demo/Rules', {})
  await program.client.request('$/providers', { interface: 'demo/Rules' })
  const [found] = (await session.mod.providers('demo/Rules')) as unknown as readonly (Rules & { beforeCheck(listener: () => unknown, options: { readonly timeoutMs: number; readonly onFailure: 'refuse' }): unknown })[]
  let isSlow = false
  found?.beforeCheck(() => (isSlow ? new Promise(() => undefined) : { rules: { a: 'off' } }), { timeoutMs: 50, onFailure: 'refuse' })
  await session.client.request('$/providers', { interface: 'demo/Rules' })

  const answered = await rules.ask('Check', { tool: 'Bash' })
  isSlow = true
  const slow = rules.ask('Check', { tool: 'Bash' })
  clock.pass(50)

  expect(answered).toEqual([{ rules: { a: 'off' } }])
  expect(await slow).toEqual([{ refuse: 'beforeCheck passed its 0.05 s timeout' }])
  expect(reported).toEqual(['Error: beforeCheck passed its 0.05 s timeout'])
  for (const each of [program, session]) await each.client.close()
  serve.close()
})

test("a mod's session code that provides a name that is no interface name throws, with an interface name to give instead", async () => {
  const tested = testMod(defineMod({ name: 'demo', setup: () => void provide('Platform' as never, {} as never) }))

  await expect(tested.start()).rejects.toThrow('Platform is no interface name, such as demo/Platform.')
})

test('a program that provides through its connection to cmod serve answers a caller on another connection, tells it events, and leaves the list once its connection closes', async () => {
  const { serve, connect, reported } = servedComputer()
  const program = connect('demo', { mod: 'demo', program: 'echo' })
  const caller = connect('boat')
  program.served.provide('demo/Echo', { echo: (text: string) => `heard ${text}` })
  await program.client.request('$/providers', { interface: 'demo/Echo' })

  const [echo] = (await caller.mod.providers('demo/Echo')) as unknown as readonly { readonly mod: string; readonly program: string; echo(text: string): Promise<string>; onChange(listener: (change: { readonly text: string }) => void): void }[]
  const heard = new Promise<string>((resolve) => echo?.onChange((change) => resolve(change.text)))
  const answer = await echo?.echo('ping')
  program.served.tell('demo/Echo', 'Change', { text: 'eu-2' })
  const told = await heard
  await program.client.close()

  expect([echo?.mod, echo?.program]).toEqual(['demo', 'echo'])
  expect(answer).toBe('heard ping')
  expect(told).toBe('eu-2')
  expect(await caller.mod.providers('demo/Echo')).toEqual([])
  expect(reported).toEqual([])
  await caller.client.close()
  serve.close()
})

type ProvidersWatch = { readonly mod: string; readonly program?: string; onChange(matcher: { readonly interface: string }, listener: (change: { readonly interface: string; readonly device: { readonly id: string; readonly name: string } }) => void): unknown }

function heardChanges(watch: ProvidersWatch | undefined, name: string) {
  const changes: { readonly interface: string; readonly device: { readonly id: string; readonly name: string } }[] = []
  const pending: { readonly count: number; readonly resolve: () => void }[] = []
  watch?.onChange({ interface: name }, (change) => {
    changes.push(change)
    for (const each of pending.filter(({ count }) => changes.length >= count)) each.resolve()
  })
  return { changes, nth: (count: number) => new Promise<void>((resolve) => (changes.length >= count ? resolve() : void pending.push({ count, resolve }))) }
}

test("cmod serve's cmod/Providers tells a Change each time a program starts or stops providing an interface, so a caller that waits for a provider hears it arrive and leave", async () => {
  const { serve, connect, reported } = servedComputer()
  const caller = connect('boat')
  const watches = (await caller.mod.providers('cmod/Providers')) as unknown as readonly ProvidersWatch[]
  const heard = heardChanges(watches[0], 'demo/Echo')
  await caller.client.request('$/providers', { interface: 'demo/Echo' })
  const arrived = heard.nth(1)
  const left = heard.nth(2)

  const program = connect('demo', { mod: 'demo', program: 'echo' })
  program.served.provide('demo/Echo', { echo: (text: string) => text })
  await arrived
  const whileProvided = (await caller.mod.providers('demo/Echo')).map((each) => each['program'])
  await program.client.close()
  await left

  expect(watches.map((each) => [each.mod, each.program])).toEqual([['cmod', 'cmod']])
  expect(whileProvided).toEqual(['echo'])
  expect(heard.changes).toEqual([
    { interface: 'demo/Echo', device: macDevice },
    { interface: 'demo/Echo', device: macDevice },
  ])
  expect(await caller.mod.providers('demo/Echo')).toEqual([])
  expect(reported).toEqual([])
  await caller.client.close()
  serve.close()
})

test("cmod serve's cmod/Providers tells a session a program on another device that starts providing an interface, named with that device, once", async () => {
  const devices = linkedDevices()
  const session = devices.connect(devices.mac, 'boat')
  await devices.linked()
  const watches = (await session.mod.providers('cmod/Providers')) as unknown as readonly ProvidersWatch[]
  const heard = heardChanges(watches[0], 'demo/Echo')
  await devices.settled()
  const arrived = heard.nth(heard.changes.length + 1)
  const beforeProvided = heard.changes.length

  const program = devices.connect(devices.devbox, 'demo', { mod: 'demo', program: 'echo' })
  program.served.provide('demo/Echo', { echo: (text: string) => text })
  await arrived
  await devices.settled()

  expect(watches.map((each) => each.mod)).toEqual(['cmod'])
  expect(heard.changes.slice(beforeProvided)).toEqual([{ interface: 'demo/Echo', device: devboxDevice }])
  expect(((await session.mod.providers('demo/Echo')) as unknown as readonly Echo[]).map((each) => each.device)).toEqual([devboxDevice])
  expect([...devices.mac.reported, ...devices.devbox.reported]).toEqual([])
  await devices.close()
})

test("cmod serve provides cmod/Terminal ahead of every program for each session held in a herdr-core terminal, and answers not held for any other, so the next provider is asked", async () => {
  const done: string[] = []
  const terminals: SessionTerminals = {
    screen: async ({ id }) => `the screen of ${id}`,
    press: async ({ id, socket }, keys) => void done.push(`${socket} ${id} pressed ${JSON.stringify(keys)}`),
    show: async ({ id }, place) => void done.push(`${id} shown at ${place}`),
  }
  const { serve, connect, reported } = servedComputer({}, {}, { terminals })
  const plugin = connect('cmod')
  await plugin.client.request('$/hold', { session: 's1', project: '/work/app', cwd: '/work/app', herdrTerminal: { id: 't7', socket: '/hc.sock' } })
  const anyhost = connect('anyhost', { mod: 'anyhost', program: 'anyhost' })
  anyhost.served.provide('cmod/Terminal', { screen: () => 'anyhost', press: () => null, show: () => null })
  await anyhost.client.request('$/providers', { interface: 'cmod/Terminal' })
  const caller = connect('boat')

  const found = (await caller.mod.providers('cmod/Terminal')) as unknown as readonly { readonly mod: string; screen(session: string): Promise<string>; press(session: string, keys: string): Promise<unknown>; show(session: string, place: string): Promise<unknown>; onShown(listener: (shown: unknown) => void): unknown; onPressed(listener: (pressed: unknown) => void): unknown }[]
  const [ownTerminal] = found
  const heard: unknown[] = []
  const shownHeard = new Promise<void>((resolve) => ownTerminal?.onShown((shown) => resolve(void heard.push(['Shown', shown]))))
  ownTerminal?.onPressed((pressed) => void heard.push(['Pressed', pressed]))
  await caller.client.request('$/providers', { interface: 'cmod/Terminal' })
  const screen = await ownTerminal?.screen('s1')
  await ownTerminal?.press('s1', '1\r')
  await ownTerminal?.show('s1', 'peek')
  await shownHeard
  const elsewhere = await ownTerminal?.screen('s2').catch((error: unknown) => String(error))

  expect(found.map((each) => each.mod)).toEqual(['cmod', 'anyhost'])
  expect(screen).toBe('the screen of t7')
  expect(done).toEqual(['/hc.sock t7 pressed "1\\r"', 't7 shown at peek'])
  expect(heard).toEqual([
    ['Pressed', { session: 's1' }],
    ['Shown', { session: 's1', place: 'peek' }],
  ])
  expect(elsewhere).toContain('No session s2 runs in a herdr-core terminal on this computer.')
  expect(reported).toEqual([])
  await Promise.all([plugin.client.close(), anyhost.client.close(), caller.client.close()])
  serve.close()
})

test("cmod serve that stops while it forwards a session's listener to a program reports nothing, though the program's connection closes under the listener's removal", async () => {
  const { serve, connect, reported } = servedComputer()
  const caller = connect('boat')
  await caller.client.request('$/providers', { interface: 'demo/Echo' })
  const program = connect('demo', { mod: 'demo', program: 'echo' })
  program.served.provide('demo/Echo', { echo: (text: string) => `heard ${text}` })
  await program.client.request('$/providers', { interface: 'demo/Echo' })
  const [echo] = (await caller.mod.providers('demo/Echo')) as unknown as readonly { onChange(listener: () => void): void }[]
  echo?.onChange(() => undefined)
  await caller.client.request('$/providers', { interface: 'demo/Echo' })

  serve.close()
  await Promise.all([caller.client.close(), program.client.close()])

  expect(reported).toEqual([])
})

test("cmod serve that stops while it tells a session's cmod plugin the parts its apps show reports nothing", async () => {
  const { serve, fetch, reported } = servedComputer()
  let isTold: () => void = () => undefined
  const told = new Promise<void>((resolve) => {
    isTold = resolve
  })
  const plugin = connectRpc({
    call: addressCall(fetch, 'unix:/store/serve.sock'),
    handle: (method) => (method === '$/ui' ? new Promise(() => isTold()) : null),
    wait: atOnce,
  })
  await plugin.request('$/hold', { session: 's1', project: '/work/app', cwd: '/work/app' })
  const app = connectRpc({ call: addressCall(fetch, 'unix:/store/serve.sock'), handle: async () => null, wait: atOnce })
  await app.request(methodName(uiInterface, 'show'), ['s1', 'browser:1', [{ mod: 'demo', id: 'runs' }]])
  await told

  serve.close()
  await Promise.all([plugin.close(), app.close()])

  expect(reported).toEqual([])
})

test("the cmod plugin holds a mod's cmod:provider until that mod's program provides the interface, ignores another mod's program that provides it, and answers null once providerHoldMs passes", async () => {
  const { serve, connect, reported, clock } = servedComputer()
  const boat = connect('boat', { mod: 'boat', program: 'echo' })
  const session = connect('demo')
  boat.served.provide('demo/Echo', { echo: (text: string) => `boat heard ${text}` })
  await boat.client.request('$/providers', { interface: 'demo/Echo' })
  const asked = { interface: 'demo/Echo', mod: 'demo', program: 'echo' }

  const passed = session.served.answer(interfaceMethods.provider, asked, 'demo')
  clock.pass(providerHoldMs)
  const beforeProvide = await passed
  const waiting = session.served.answer(interfaceMethods.provider, asked, 'demo')
  const demo = connect('demo', { mod: 'demo', program: 'echo' })
  demo.served.provide('demo/Echo', { echo: (text: string) => `demo heard ${text}` })
  const afterProvide = await waiting
  const providedAlready = await session.served.answer(interfaceMethods.provider, asked, 'demo')

  expect(beforeProvide).toBeNull()
  expect(afterProvide).toEqual({ mod: 'demo', program: 'echo', device: { id: 'mac-id', name: 'mac' } })
  expect(providedAlready).toEqual(afterProvide)
  expect(reported).toEqual([])
  for (const each of [boat, session, demo]) await each.client.close()
  serve.close()
})

test("the cmod plugin holds a mod's cmod:provider that names no interface until that mod's program provides any interface, which is when the program counts as started", async () => {
  const { serve, connect, reported, clock } = servedComputer()
  const boat = connect('boat', { mod: 'boat', program: 'echo' })
  const session = connect('demo')
  boat.served.provide('demo/Echo', { echo: (text: string) => `boat heard ${text}` })
  await boat.client.request('$/providers', { interface: 'demo/Echo' })
  const asked = { mod: 'demo', program: 'echo' }

  const passed = session.served.answer(interfaceMethods.provider, asked, 'demo')
  clock.pass(providerHoldMs)
  const beforeProvide = await passed
  const waiting = session.served.answer(interfaceMethods.provider, asked, 'demo')
  const demo = connect('demo', { mod: 'demo', program: 'echo' })
  demo.served.provide('demo/Platform', { machines: () => [] })
  const afterProvide = await waiting
  const providedAlready = await session.served.answer(interfaceMethods.provider, asked, 'demo')

  expect(beforeProvide).toBeNull()
  expect(afterProvide).toEqual({ mod: 'demo', program: 'echo', device: { id: 'mac-id', name: 'mac' } })
  expect(providedAlready).toEqual(afterProvide)
  expect(reported).toEqual([])
  for (const each of [boat, session, demo]) await each.client.close()
  serve.close()
})

test("a program from a 7.0.0 core, which serves its own wire and names its interfaces in its instance file, still answers through cmod serve and tells its events", async () => {
  const server = interfaceServer({ implementations: { 'demo/Platform': { machines: (region: string) => [`${region}-1`] } } })
  const boat = rpcRoutes({ handle: (connection) => server.handler(connection), onClose: (connection) => server.closed(connection), now: () => Date.now() })
  const { serve, connect, reported } = servedComputer({ '/store/boat.sock': boat }, { '/store/instances/boat/boat.json': JSON.stringify({ address: 'unix:/store/boat.sock', pid: 1, started: '', provides: ['demo/Platform'] }) })
  const caller = connect('demo')

  const [platform] = (await caller.mod.providers('demo/Platform')) as unknown as readonly { readonly mod: string; readonly program: string; machines(region: string): Promise<string[]>; onMachineChange(listener: (machine: { readonly name: string }) => void): void }[]
  const heard = new Promise<string>((resolve) => platform?.onMachineChange((machine) => resolve(machine.name)))
  const machines = await platform?.machines('eu')
  server.emit('demo/Platform', 'MachineChange', { name: 'eu-2' }, [])

  expect([platform?.mod, platform?.program]).toEqual(['boat', 'boat'])
  expect(machines).toEqual(['eu-1'])
  expect(await heard).toBe('eu-2')
  expect(reported).toEqual([])
  await caller.client.close()
  serve.close()
  boat.close()
})

test('a call names one provider when several provide the interface, and a call that names none is refused with the providers to pick from', async () => {
  const { serve, connect } = servedComputer()
  const first = connect('demo', { mod: 'demo', program: 'echo' })
  const second = connect('boat', { mod: 'boat', program: 'echo' })
  const caller = connect('other')
  first.served.provide('demo/Echo', { echo: () => 'from demo' })
  second.served.provide('demo/Echo', { echo: () => 'from boat' })
  await Promise.all([first, second].map((each) => each.client.request('$/providers', { interface: 'demo/Echo' })))

  const found = (await caller.mod.providers('demo/Echo')) as unknown as readonly { readonly mod: string; echo(text: string): Promise<string> }[]
  const answers = await Promise.all(found.map((each) => each.echo('ping')))
  const unnamed = await caller.client.request('demo/Echo.echo', ['ping']).catch((error: unknown) => (error as Error).message)

  expect(answers.toSorted()).toEqual(['from boat', 'from demo'])
  expect(unnamed).toBe("demo's echo program and boat's echo program provide demo/Echo, so cmod serve picks none. Call one through providers('demo/Echo').")
  for (const each of [first, second, caller]) await each.client.close()
  serve.close()
})

test("a request sent while cmod serve starts again, which the new cmod serve answers 410 for the old connection, reaches the new cmod serve once the client connects again, instead of failing as closed", async () => {
  const served = (name: string) => rpcRoutes({ handle: () => async (method) => `${name} answered ${method}`, now: () => Date.now() })
  const first = served('first')
  let routes = first
  const client = connectRpc({ call: addressCall(fetchOf(() => routes), 'unix:/store/serve.sock'), handle: async () => null, wait: atOnce, retryMs: 0 })
  const before = await client.request<string>('demo/Echo.echo', ['ping'])

  first.close()
  routes = served('second')
  const after = await client.request<string>('demo/Echo.echo', ['ping'])

  expect(before).toBe('first answered demo/Echo.echo')
  expect(after).toBe('second answered demo/Echo.echo')
  await client.close()
  routes.close()
})

test("an answer larger than Claude Code's 4 MiB fetch limit reaches the client whole, in parts each poll carries under the limit, and keeps the connection", async () => {
  const conversation = 'a long conversation '.repeat(300_000)
  const routes = rpcRoutes({ handle: () => async (method) => (method === 'demo/Read.everything' ? conversation : 'still connected'), now: () => Date.now() })
  const polled: number[] = []
  const servedFetch = fetchOf(() => routes)
  const claudeFetch: HttpFetch = async (url, init) => {
    const answer = await servedFetch(url, init)
    const bytes = new TextEncoder().encode(answer.text).length
    if (bytes > 4_194_304) throw new Error(`$.http.fetch: ${url} refused: body of ${bytes} bytes is over the 4194304-byte limit`)
    if (init.method === 'GET') polled.push(bytes)
    return answer
  }
  const client = connectRpc({ call: addressCall(claudeFetch, 'unix:/store/serve.sock'), handle: async () => null, wait: atOnce })

  const read = await client.request<string>('demo/Read.everything')
  const after = await client.request<string>('demo/Echo.ping')

  expect([read.length, read === conversation, after]).toEqual([conversation.length, true, 'still connected'])
  expect(polled.filter((bytes) => bytes > 500_000).length).toBeGreaterThanOrEqual(6)
  expect(Math.max(...polled)).toBeLessThan(4_194_304)
  await client.close()
  routes.close()
})

test('a poll its client abandons drops its connection at once: cmod serve forgets it, its calls fail as closed, and its next poll answers 410', async () => {
  const closed: string[] = []
  const routes = rpcRoutes({ handle: () => async () => null, onClose: (connection) => void closed.push(connection.id), now: () => Date.now() })
  const asked = (method: string, path: string, signal = new AbortController().signal) => routes.route({ method, path, signal, json: async () => [] }) as Promise<RpcHttpAnswer>
  const id = ((await asked('POST', '/rpc/connect')).json as { readonly connection: string }).connection
  const [connection] = routes.connections()
  const left = new AbortController()

  const abandoned = asked('GET', `/rpc/${id}`, left.signal)
  left.abort()
  const call = await connection?.request('$/ping').catch((error: unknown) => (error as Error).message)

  expect(await abandoned).toEqual({ status: 200, json: [] })
  expect(closed).toEqual([id])
  expect(routes.connections()).toEqual([])
  expect(call).toBe('The connection closed: the client left its poll')
  expect((await asked('GET', `/rpc/${id}`)).status).toBe(410)
})

test('a listener added before its program answers reports nothing, and hears the program once it connects', async () => {
  const server = interfaceServer({ implementations: { 'demo/Platform': { machines: () => [] } } })
  const routes = rpcRoutes({ handle: (connection) => server.handler(connection), now: () => Date.now() })
  let isUp = false
  let comeUp: () => void = () => undefined
  const cameUp = new Promise<void>((resolve) => {
    comeUp = resolve
  })
  let connected: () => void = () => undefined
  const isConnected = new Promise<void>((resolve) => {
    connected = resolve
  })
  const fetch: HttpFetch = async (url, init) => {
    if (!isUp) throw new Error('ECONNREFUSED')
    return fetchOf(() => routes)(url, init)
  }
  const reported: string[] = []
  const listeners = interfaceListeners({ report: (error) => void reported.push(String(error)) })
  const replayed = async (client: Parameters<typeof listeners.replay>[0]) => {
    await listeners.replay(client)
    connected()
  }
  const client = connectRpc({ call: addressCall(fetch, 'unix:/store/boat.sock'), handle: (method, params, signal) => listeners.handler(method, params, signal), onConnect: replayed, wait: () => cameUp, keepsConnecting: true })

  const heard = new Promise<string>((resolve) => listeners.listen(client, listeningOf('demo/Platform', 'on', 'MachineChange', [], undefined), (machine: { readonly name: string }) => resolve(machine.name)))
  isUp = true
  comeUp()
  await isConnected
  server.emit('demo/Platform', 'MachineChange', { name: 'eu-2' }, [])

  expect(await heard).toBe('eu-2')
  expect(reported).toEqual([])
  await client.close()
  routes.close()
})

test("cmod serve tells a session's cmod plugin the parts its apps show, tells nothing for a renewal, and drops a set its app has not renewed for showLeaseMs", async () => {
  const { serve, fetch, clock } = servedComputer()
  const told: unknown[] = []
  const heard: (() => void)[] = []
  const nextTold = () => new Promise<void>((resolve) => void heard.push(resolve))
  const plugin = connectRpc({
    call: addressCall(fetch, 'unix:/store/serve.sock'),
    handle: async (method, params) => {
      if (method !== '$/ui') return null
      told.push((params as { readonly args: readonly unknown[] }).args)
      heard.shift()?.()
      return null
    },
    wait: atOnce,
  })
  await plugin.request('$/hold', { session: 's1', project: '/work/app', cwd: '/work/app' })
  const app = connectRpc({ call: addressCall(fetch, 'unix:/store/serve.sock'), handle: async () => null, wait: atOnce })
  const ui = { show: (...args: unknown[]) => app.request(methodName(uiInterface, 'show'), args) }

  const shown = nextTold()
  await ui.show('s1', 'browser:1', [{ mod: 'demo', id: 'runs' }])
  await shown
  clock.pass(showLeaseMs - 1000)
  await ui.show('s1', 'browser:1', [{ mod: 'demo', id: 'runs' }])
  clock.pass(showLeaseMs - 1000)
  const kept = [...told]
  const lapsed = nextTold()
  clock.pass(1000)
  await lapsed

  expect(kept).toEqual([['s1', [{ mod: 'demo', id: 'runs' }], false]])
  expect(told).toEqual([
    ['s1', [{ mod: 'demo', id: 'runs' }], false],
    ['s1', [], false],
  ])
  await app.close()
  await plugin.close()
  serve.close()
})

test("cmod serve tells a session's cmod plugin it is hosted while one app's show says isHost, even with no parts, until that app's host lapses", async () => {
  const { serve, fetch, clock } = servedComputer()
  const told: unknown[] = []
  const heard: (() => void)[] = []
  const nextTold = () => new Promise<void>((resolve) => void heard.push(resolve))
  const plugin = connectRpc({
    call: addressCall(fetch, 'unix:/store/serve.sock'),
    handle: async (method, params) => {
      if (method !== '$/ui') return null
      told.push((params as { readonly args: readonly unknown[] }).args)
      heard.shift()?.()
      return null
    },
    wait: atOnce,
  })
  await plugin.request('$/hold', { session: 's1', project: '/work/app', cwd: '/work/app' })
  const app = connectRpc({ call: addressCall(fetch, 'unix:/store/serve.sock'), handle: async () => null, wait: atOnce })
  const ui = { show: (...args: unknown[]) => app.request(methodName(uiInterface, 'show'), args) }

  const hosted = nextTold()
  await ui.show('s1', 'herdr:1', [], { isHost: true })
  await hosted
  await ui.show('s1', 'browser:1', [{ mod: 'demo', id: 'runs' }])
  const lapsed = nextTold()
  clock.pass(showLeaseMs)
  await lapsed

  expect(told).toEqual([
    ['s1', [], true],
    ['s1', [{ mod: 'demo', id: 'runs' }], true],
    ['s1', [], false],
  ])
  await app.close()
  await plugin.close()
  serve.close()
})

test("an app that asks for the views of a session whose cmod plugin predates cmod/UI hears that the session runs an older cmod plugin and to reload it", async () => {
  const { serve, fetch } = servedComputer()
  const plugin = connectRpc({ call: addressCall(fetch, 'unix:/store/serve.sock'), handle: async (method) => Promise.reject(new RpcError(rpcCodes.methodNotFound, `The cmod plugin of session s1 answers no ${method}.`)), wait: atOnce })
  await plugin.request('$/hold', { session: 's1', project: '/work/app', cwd: '/work/app' })
  const app = connectRpc({ call: addressCall(fetch, 'unix:/store/serve.sock'), handle: async () => null, wait: atOnce })

  const asked = app.request(methodName(uiInterface, 'views'), ['s1'])

  await expect(asked).rejects.toThrow('Session s1 runs a cmod plugin older than this cmod serve, so its views show only in Claude Code. Run /reload-plugins in it to show them here.')
  await app.close()
  await plugin.close()
  serve.close()
})

test("an app that asks for the views of a session that runs on this computer with no cmod plugin holding it hears to reload it, and one for a session that runs nowhere here hears that it runs nowhere here", async () => {
  const running: SessionComputer = { ...noSessions, sessions: (scope) => (scope['running'] === true ? [{ id: 's1', title: 'app', project: '/work/app', cwd: '/work/app', model: 'claude-opus-5-5', startedAt: '', lastAt: '', isRunning: true }] : []) }
  const { serve, fetch } = servedComputer({}, {}, { computer: running })
  const app = connectRpc({ call: addressCall(fetch, 'unix:/store/serve.sock'), handle: async () => null, wait: atOnce })

  const [unheld, elsewhere] = await Promise.allSettled([app.request(methodName(uiInterface, 'views'), ['s1']), app.request(methodName(uiInterface, 'views'), ['s2'])])

  expect(unheld.status === 'rejected' && (unheld.reason as Error).message).toBe('Session s1 runs here, but no cmod plugin of 7.0.0 or later in it reaches cmod serve, so its views show only in Claude Code. Run /reload-plugins in it to show them here.')
  expect(elsewhere.status === 'rejected' && (elsewhere.reason as Error).message).toBe('No session s2 runs on this computer, so it shows no UI.')
  await app.close()
  serve.close()
})

type Echo = { readonly mod: string; readonly program?: string; readonly device?: { readonly id: string; readonly name: string }; echo(text: string): Promise<string>; onChange(listener: (change: { readonly text: string }) => void): unknown }

const macDevice = { id: 'mac-id', name: 'mac' }

const devboxDevice = { id: 'devbox-id', name: 'devbox' }

function linkedDevices(devboxComputer: SessionComputer = noSessions) {
  const mac = servedComputer({}, {}, { device: macDevice })
  const devbox = servedComputer({}, {}, { device: devboxDevice, computer: devboxComputer })
  const sent: { readonly from: string; readonly message: unknown }[] = []
  const carriers = new Map<string, { readonly served: ServedProviders; flush(): Promise<unknown> }>()
  let answered: () => void = () => undefined
  const isAnswered = new Promise<void>((resolve) => {
    answered = resolve
  })
  const relayOn = (served: ReturnType<typeof servedComputer>, here: string, other: { readonly id: string; readonly name: string }) => {
    let listed = [other]
    const relay = served.connect('anyhost', { mod: 'anyhost', program: 'relay' })
    const flush = () => relay.client.request('$/providers', { interface: 'demo/Echo', device: here })
    carriers.set(here, { served: relay.served, flush })
    const devices = relay.served.provide('cmod/Devices', {
      devices: () => listed,
      send: (device: string, message: unknown) => {
        sent.push({ from: here, message })
        const to = carriers.get(device)
        to?.served.tell('cmod/Devices', 'Message', { device: here, message })
        if ((message as { readonly params?: { readonly answers?: string } }).params?.answers !== undefined) void to?.flush().then(answered)
      },
    })
    const forget = async () => {
      listed = []
      devices.tell('Change', { device: other.id })
      await flush()
    }
    return { ...relay, forget }
  }
  const relays = { mac: relayOn(mac, macDevice.id, devboxDevice), devbox: relayOn(devbox, devboxDevice.id, macDevice) }
  const settled = async () => {
    for (const { flush } of carriers.values()) for (let trip = 0; trip < 2; trip += 1) await flush()
  }
  const clients: { close(): Promise<void> }[] = [relays.mac.client, relays.devbox.client]
  const serves = [mac, devbox]
  return {
    mac,
    devbox,
    sent,
    relays,
    linked: () => isAnswered,
    settled,
    connect: (served: ReturnType<typeof servedComputer>, name: string, provider?: ProviderIdentity) => {
      const connected = served.connect(name, provider)
      clients.push(connected.client)
      return connected
    },
    devboxAgain: async (start: (served: ReturnType<typeof servedComputer>) => Promise<void>) => {
      const again = servedComputer({}, {}, { device: devboxDevice, computer: devboxComputer })
      serves.push(again)
      await start(again)
      clients.push(relayOn(again, devboxDevice.id, macDevice).client)
      return again
    },
    async close() {
      for (const client of clients) await client.close()
      for (const served of serves) served.serve.close()
    },
  }
}

test("a session reaches a program on another device over the message channel a cmod/Devices provider carries: providers names that device, the call answers, and its Change reaches the session", async () => {
  const devices = linkedDevices()
  const program = devices.connect(devices.devbox, 'demo', { mod: 'demo', program: 'echo' })
  const echo = program.served.provide('demo/Echo', { echo: (text: string) => `devbox heard ${text}` })
  await program.client.request('$/providers', { interface: 'demo/Echo' })
  const session = devices.connect(devices.mac, 'boat')
  await devices.linked()

  const found = (await session.mod.providers('demo/Echo')) as unknown as readonly Echo[]
  const heard = new Promise<string>((resolve) => found[0]?.onChange((change) => resolve(change.text)))
  const answer = await found[0]?.echo('ping')
  echo.tell('Change', { text: 'eu-2' })

  expect(found.map((each) => [each.mod, each.program, each.device])).toEqual([['demo', 'echo', devboxDevice]])
  expect(answer).toBe('devbox heard ping')
  expect(await heard).toBe('eu-2')
  expect([...devices.mac.reported, ...devices.devbox.reported]).toEqual([])
  await devices.close()
})

test("a session lists another device's sessions over the message channel, and a message to one of them reaches that device", async () => {
  const started: unknown[] = []
  const devices = linkedDevices({
    ...noSessions,
    sessions: () => [{ id: 'devbox-1', title: 'Upgrade the dependencies', project: '/work/app', cwd: '/work/app', model: 'claude-opus-5-5', startedAt: '2026-11-20T10:00:00.000Z', lastAt: '2026-11-20T10:00:02.000Z', isRunning: false, device: devboxDevice }],
    unheld: async (session, action, input) => void started.push([session, action, input]),
  })
  const session = devices.connect(devices.mac, 'boat')
  await devices.linked()

  const found = (await session.mod.providers('cmod/Sessions')) as unknown as readonly { readonly device?: { readonly id: string }; sessions(scope: object): Promise<readonly { readonly id: string; readonly device?: unknown }[]>; send(session: string, message: object): Promise<unknown> }[]
  const onDevbox = found.find((each) => each.device?.id === devboxDevice.id)
  const listed = await onDevbox?.sessions({ everyProject: true })
  await onDevbox?.send('devbox-1', { type: 'prompt', text: 'Run it again' })

  expect(found.map((each) => each.device?.id)).toEqual([devboxDevice.id])
  expect(listed?.map((each) => [each.id, each.device])).toEqual([['devbox-1', devboxDevice]])
  expect(started).toEqual([['devbox-1', 'send', { type: 'prompt', text: 'Run it again' }]])
  expect([...devices.mac.reported, ...devices.devbox.reported]).toEqual([])
  await devices.close()
})

test('a message channel carries nothing while it is idle, across every lease of cmod serve', async () => {
  const devices = linkedDevices()
  const session = devices.connect(devices.mac, 'boat')
  await devices.linked()
  await devices.settled()
  const sentLinked = devices.sent.length

  for (const served of [devices.mac, devices.devbox]) served.clock.pass(10 * showLeaseMs)
  for (const served of [devices.mac, devices.devbox]) served.clock.pass(10 * 60_000)
  await devices.settled()
  const sentIdle = devices.sent.length - sentLinked
  await session.mod.providers('demo/Echo')

  expect(sentIdle).toBe(0)
  expect(devices.sent.length - sentLinked).toBe(2)
  await devices.close()
})

test('a device on a message channel leaves providers once its cmod/Devices provider tells it is gone', async () => {
  const devices = linkedDevices()
  const program = devices.connect(devices.devbox, 'demo', { mod: 'demo', program: 'echo' })
  program.served.provide('demo/Echo', { echo: (text: string) => text })
  await program.client.request('$/providers', { interface: 'demo/Echo' })
  const session = devices.connect(devices.mac, 'boat')
  await devices.linked()
  const before = (await session.mod.providers('demo/Echo')) as unknown as readonly Echo[]

  await devices.relays.mac.forget()
  const failed = await before[0]?.echo('ping').then(
    () => 'answered',
    (error: unknown) => (error as Error).message,
  )

  expect(before.map((each) => each.device?.name)).toEqual(['devbox'])
  expect(await session.mod.providers('demo/Echo')).toEqual([])
  expect(failed).toBe("cmod serve reaches no device devbox, so demo's echo program there answers no demo/Echo.")
  expect([...devices.mac.reported, ...devices.devbox.reported]).toEqual([])
  await devices.close()
})

test("a device whose cmod serve starts again links again over the message channel: a call the old one never answered fails, and a session's listener there hears the new one", async () => {
  const devices = linkedDevices()
  const program = devices.connect(devices.devbox, 'demo', { mod: 'demo', program: 'echo' })
  program.served.provide('demo/Echo', { echo: (text: string) => (text === 'hang' ? new Promise(() => undefined) : `devbox heard ${text}`) })
  await program.client.request('$/providers', { interface: 'demo/Echo' })
  const session = devices.connect(devices.mac, 'boat')
  await devices.linked()
  const [echo] = (await session.mod.providers('demo/Echo')) as unknown as readonly Echo[]
  const heard = new Promise<string>((resolve) => echo?.onChange((change) => resolve(change.text)))
  const before = await echo?.echo('ping')
  const unanswered = echo?.echo('hang').then(
    () => 'answered',
    (error: unknown) => (error as Error).message,
  )

  let told: ReturnType<ServedProviders['provide']> | undefined
  const again = await devices.devboxAgain(async (served) => {
    const started = devices.connect(served, 'demo', { mod: 'demo', program: 'echo' })
    told = started.served.provide('demo/Echo', { echo: (text: string) => `devbox again heard ${text}` })
    await started.client.request('$/providers', { interface: 'demo/Echo' })
  })
  const failed = await unanswered
  const after = await echo?.echo('ping')
  told?.tell('Change', { text: 'eu-3' })

  expect(before).toBe('devbox heard ping')
  expect(failed).toBe('The connection closed: the cmod serve of devbox linked again')
  expect(after).toBe('devbox again heard ping')
  expect(await heard).toBe('eu-3')
  expect([...devices.mac.reported, ...again.reported]).toEqual([])
  await devices.close()
})

function echoOnProgram(echo: (clock: ReturnType<typeof manualClock>) => Promise<unknown>) {
  const clock = manualClock()
  const tested = testMod(defineMod({ name: 'notes', setup() {} }))
  const call = async ({ method }: { readonly method: string }) => (method === interfaceMethods.providers ? { mods: [], programs: [{ mod: 'demo', program: 'echo' }] } : method === interfaceMethods.provided ? echo(clock) : null)
  const start = async () => {
    await tested.start()
    tested.fakes.cmod.call = call
    tested.fakes.clock.after = clock.after
    const [found] = await providers('demo/Echo')
    return found
  }
  return { clock, start }
}

test("a session mod's call to a program's provider that never answers rejects once the test kit's clock passes 30 s", async () => {
  const { clock, start } = echoOnProgram(() => new Promise(() => undefined))
  const echo = await start()

  const outcome = { message: 'pending' }
  void echo?.echo('ping').then(
    () => void (outcome.message = 'resolved'),
    (error: unknown) => void (outcome.message = (error as Error).message),
  )
  clock.pass(29_999)
  const isEarly = await isDoneWithin(() => outcome.message !== 'pending')
  clock.pass(1)
  const isSettled = await isDoneWithin(() => outcome.message !== 'pending')

  expect([isEarly, isSettled]).toEqual([false, true])
  expect(outcome.message).toBe('demo/Echo.echo passed its 30 s deadline')
})

test("a session mod's call to a program's provider that answers at 29 s resolves with its answer", async () => {
  const { clock, start } = echoOnProgram((at) => new Promise((resolve) => void at.after(29_000, () => resolve('heard ping'))))
  const echo = await start()

  const called = echo?.echo('ping')
  clock.pass(29_000)

  expect(await called).toBe('heard ping')
})

async function isDoneWithin(isDone: () => boolean): Promise<boolean> {
  for (let tick = 0; tick < 10_000 && !isDone(); tick += 1) await Promise.resolve()
  return isDone()
}

async function silentEcho(computer: ReturnType<typeof servedComputer>) {
  let heard: AbortSignal | undefined
  const provider = connectRpc({
    call: addressCall(computer.fetch, 'unix:/store/serve.sock'),
    handle: (method, _params, signal) => {
      if (method !== 'demo/Echo.echo') return null
      heard = signal
      return new Promise(() => undefined)
    },
    wait: atOnce,
  })
  await provider.request('$/provide', { interface: 'demo/Echo', mod: 'demo', program: 'echo' })
  return { provider, heard: () => heard }
}

async function passedDeadline(computer: ReturnType<typeof servedComputer>, heard: () => AbortSignal | undefined, called: Promise<unknown>) {
  const outcome = { message: 'pending' }
  void called.then(
    () => void (outcome.message = 'resolved'),
    (error: unknown) => void (outcome.message = (error as Error).message),
  )
  const isReached = await isDoneWithin(() => heard() !== undefined)
  computer.clock.pass(30_000)
  const isSettled = await isDoneWithin(() => outcome.message !== 'pending')
  const isCancelled = await isDoneWithin(() => heard()?.aborted === true)
  return { isReached, isSettled, isCancelled, message: outcome.message }
}

test("a program's Connection.call to a provider that never answers rejects once the program's clock passes 30 s, and cancels the provider's request", async () => {
  const computer = servedComputer()
  const { provider, heard } = await silentEcho(computer)
  const caller = computer.connect('notes', { mod: 'notes', program: 'notes' })
  const connection = programConnection({ client: caller.client, listeners: caller.listeners, served: caller.served, after: computer.clock.after })

  const passed = await passedDeadline(computer, heard, connection.call('demo/Echo', 'echo', ['ping']))
  for (const each of [provider, caller.client]) await each.close()
  computer.serve.close()

  expect(passed).toEqual({ isReached: true, isSettled: true, isCancelled: true, message: 'demo/Echo.echo passed its 30 s deadline' })
  expect(computer.reported).toEqual([])
})

test("the cmod plugin's call to a program's provider for a session mod rejects once its clock passes 30 s, and cancels the provider's request", async () => {
  const computer = servedComputer()
  const { provider, heard } = await silentEcho(computer)
  const plugin = computer.connect('notes')
  const asked = { interface: 'demo/Echo', method: 'echo', args: ['ping'], mod: 'demo', program: 'echo' }

  const passed = await passedDeadline(computer, heard, plugin.served.answer(interfaceMethods.provided, asked, 'notes') ?? Promise.resolve())
  for (const each of [provider, plugin.client]) await each.close()
  computer.serve.close()

  expect(passed).toEqual({ isReached: true, isSettled: true, isCancelled: true, message: 'demo/Echo.echo passed its 30 s deadline' })
  expect(computer.reported).toEqual([])
})

const testComputer = { id: testDevice.id, name: testDevice.name }

test("testMod's fake program provider on another device lists with that device, answers the tested mod's call, and tells its onChange listener", async () => {
  const tested = testMod(defineMod({ name: 'notes', setup: () => undefined }), {
    providers: [{ name: 'demo/Echo', mod: 'demo', program: 'echo', device: devboxDevice, methods: { echo: (text) => `devbox heard ${text}` } }],
  })
  await tested.start()
  const [echo] = await providers('demo/Echo')
  const told: string[] = []
  echo?.onChange((change) => void told.push(change.text))

  const answer = await echo?.echo('ping')
  tested.providers[0].tell('Change', { text: 'eu-1' })
  await tested.settle()

  expect([echo?.mod, echo?.program, echo?.device]).toEqual(['demo', 'echo', devboxDevice])
  expect(answer).toBe('devbox heard ping')
  expect(told).toEqual(['eu-1'])
})

test("a tested mod's beforeCheck listener on testMod's fake provider answers the provider's ask", async () => {
  const tested = testMod(defineMod({ name: 'modes', setup: () => undefined }), { providers: [{ name: 'demo/Rules', mod: 'rulebook', program: 'rules', methods: {} }] })
  await tested.start()
  const [rules] = await providers('demo/Rules')
  rules?.beforeCheck((check) => (check.tool === 'Bash' ? { refuse: 'Bash is off in this mode' } : undefined))

  expect(await tested.providers[0].ask('Check', { tool: 'Bash' })).toEqual([{ refuse: 'Bash is off in this mode' }])
  expect(await tested.providers[0].ask('Check', { tool: 'Read' })).toEqual([])
})

test("program(...).provider resolves with testMod's fake provider of that program, and the program job spawns nothing the test fakes", async () => {
  let server: Program | undefined
  const tested = testMod(defineMod({ name: 'demo', setup: (mod) => void (server = mod.use(program({ command: ['echo-server'], singleInstance: true }))) }), {
    providers: [{ name: 'demo/Echo', mod: 'demo', program: 'echo-server', methods: { echo: (text) => `heard ${text}` } }],
  })
  await tested.start()

  const echo = await server?.provider('demo/Echo')

  expect([echo?.mod, echo?.program, echo?.device]).toEqual(['demo', 'echo-server', testComputer])
  expect(await echo?.echo('ping')).toBe('heard ping')
  expect(tested.shown.toasts.filter(({ type }) => type === 'error')).toEqual([])
})

test('program(...).provider asks the cmod plugin again when a cmod:provider goes unanswered, and resolves with its provider instead of failing while the program runs', async () => {
  let server: Program | undefined
  const tested = testMod(defineMod({ name: 'demo', setup: (mod) => void (server = mod.use(program({ command: ['echo-server'], singleInstance: true }))) }), {
    providers: [{ name: 'demo/Echo', mod: 'demo', program: 'echo-server', methods: { echo: (text) => `heard ${text}` } }],
  })
  const answer = tested.fakes.cmod.call
  let asks = 0
  tested.fakes.cmod.call = async (call) => {
    if (call.method === interfaceMethods.provider && (asks += 1) === 1) throw new Error(`demo: $.cmod.call: ${didNotAnswer(call.to)}`)
    return answer?.(call)
  }
  await tested.start()

  const echo = await server?.provider('demo/Echo')

  expect(asks).toBe(2)
  expect(await echo?.echo('ping')).toBe('heard ping')
})

test("testMod's fake provider that the test removes leaves providers, and a call to it then fails as in a session", async () => {
  const tested = testMod(defineMod({ name: 'notes', setup: () => undefined }), { providers: [{ name: 'demo/Echo', mod: 'demo', program: 'echo', methods: { echo: (text) => text } }] })
  await tested.start()
  const [echo] = await providers('demo/Echo')

  tested.providers[0].remove()
  await tested.settle()

  expect(await providers('demo/Echo')).toEqual([])
  await expect(echo?.echo('ping') ?? Promise.resolve()).rejects.toThrow("demo's echo program does not run, so it answers no demo/Echo.")
})

test("testMod's fake provider with no program is another mod's session code: it lists on this computer, answers, and tells", async () => {
  const tested = testMod(defineMod({ name: 'notes', setup: () => undefined }), { providers: [{ name: 'demo/Echo', mod: 'boat', methods: { echo: (text) => `boat heard ${text}` } }] })
  await tested.start()
  const [echo] = await providers('demo/Echo')
  const heard = new Promise<string>((resolve) => echo?.onChange((change) => resolve(change.text)))

  tested.providers[0].tell('Change', { text: 'eu-2' })

  expect([echo?.mod, echo?.program, echo?.device]).toEqual(['boat', undefined, testComputer])
  expect(await echo?.echo('ping')).toBe('boat heard ping')
  expect(await heard).toBe('eu-2')
})

test("testMod's fake provider with isStarted: false starts when the test calls start(), so a mod hears it arrive through cmod/Providers and reaches it", async () => {
  const heard: string[] = []
  const answers: string[] = []
  const tested = testMod(
    defineMod({
      name: 'modes',
      async setup() {
        const [watch] = await providers('cmod/Providers')
        watch?.onChange({ interface: 'demo/Echo' }, async (change) => {
          heard.push(`${change.interface} on ${change.device.name}`)
          for (const echo of await providers('demo/Echo')) answers.push(await echo.echo('ping'))
        })
      },
    }),
    { providers: [{ name: 'demo/Echo', mod: 'rulebook', program: 'rules', isStarted: false, methods: { echo: (text: string) => `rules heard ${text}` } }] },
  )
  await tested.start()
  const before = await providers('demo/Echo')

  tested.providers[0].start()
  await tested.settle()

  expect(before).toEqual([])
  expect(heard).toEqual(['demo/Echo on test-computer'])
  expect(answers).toEqual(['rules heard ping'])
})

test("cmod/Providers tells a mod when another mod's session code in its session starts or stops providing an interface, as it does for a program", async () => {
  const heard: string[] = []
  const lists: number[] = []
  const tested = testMod(
    defineMod({
      name: 'modes',
      async setup() {
        const [watch] = await providers('cmod/Providers')
        watch?.onChange({ interface: 'demo/Echo' }, async (change) => {
          heard.push(`${change.interface} on ${change.device.name}`)
          lists.push((await providers('demo/Echo')).length)
        })
      },
    }),
    { providers: [{ name: 'demo/Echo', mod: 'rulebook', isStarted: false, methods: { echo: (text: string) => `rulebook heard ${text}` } }] },
  )
  await tested.start()

  tested.providers[0].start()
  await tested.settle()
  const [echo] = await providers('demo/Echo')
  const answer = await echo?.echo('ping')
  tested.providers[0].remove()
  await tested.settle()

  expect(heard).toEqual(['demo/Echo on test-computer', 'demo/Echo on test-computer'])
  expect(lists).toEqual([1, 0])
  expect(answer).toBe('rulebook heard ping')
})

test("cmod/Providers tells a Change when a mod's own session code provides an interface, through the parts the mod tells the cmod plugin", async () => {
  const heard: string[] = []
  const tested = testMod(
    defineMod({
      name: 'rulebook',
      async setup() {
        const [watch] = await providers('cmod/Providers')
        watch?.onChange({ interface: 'demo/Echo' }, (change) => void heard.push(`${change.interface} on ${change.device.name}`))
      },
    }),
  )
  await tested.start()

  const provided = provide('demo/Echo', { echo: (text: string) => `rulebook heard ${text}` })
  await tested.settle()
  provided.remove()
  await tested.settle()

  expect(heard).toEqual(['demo/Echo on test-computer', 'demo/Echo on test-computer'])
})

test("testMod's fake provider on another device that starts later joins the devices already reached, and the first device stays", async () => {
  const devbox = { id: 'devbox-id', name: 'devbox' }
  const laptop = { id: 'laptop-id', name: 'laptop' }
  const tested = testMod(defineMod({ name: 'modes', setup() {} }), {
    providers: [
      { name: 'demo/Echo', mod: 'demo', program: 'echo', device: devbox, methods: { echo: (text: string) => `devbox heard ${text}` } },
      { name: 'demo/Echo', mod: 'demo', program: 'echo', device: laptop, isStarted: false, methods: { echo: (text: string) => `laptop heard ${text}` } },
    ],
  })
  await tested.start()

  tested.providers[1].start()
  await tested.settle()
  const found = await providers('demo/Echo')

  expect(found.map((each) => each.device.name).sort()).toEqual(['devbox', 'laptop'])
  expect((await Promise.all(found.map((each) => each.echo('ping')))).sort()).toEqual(['devbox heard ping', 'laptop heard ping'])
})

test("testMod refuses a fake session-code provider on another device, with the program to give instead", () => {
  expect(() => testMod(defineMod({ name: 'notes', setup: () => undefined }), { providers: [{ name: 'demo/Echo', mod: 'boat', device: devboxDevice, methods: { echo: (text) => text } }] })).toThrow(
    "boat's session code provides demo/Echo only in this session, on this computer, so it takes no device. Give the program that provides it on devbox, with program: '<executable>'.",
  )
})
