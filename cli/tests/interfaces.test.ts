import { afterAll, afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { program, type Program } from '@cmodjs/core/src/jobs/program.js'
import { defineMod, providers, sessions } from '@cmodjs/core/src/mod.js'
import type { ProgramInstance } from '@cmodjs/core/src/records.js'
import { interfaceListeners, interfaceServer, listeningOf, methodName, providersIn, type InterfaceListeners } from '@cmodjs/core/src/runtime/interfaces.js'
import { connectRpc, rpcRoutes, type RpcClient } from '@cmodjs/core/src/runtime/rpc.js'
import { testMod } from '@cmodjs/core/src/testing.js'
import { claudeCodeOf } from '@cmodjs/core/src/testing/claude-code.js'
import { calledAnswer } from '@cmodjs/core/src/testing/fake-claude.js'
import { answered } from '../src/serve.js'
import { startTime } from '../src/store.js'
import { cmod, cmodFromSource, cmodWith, deleteTemporaryHomes, environment, startCmod, temporaryHome, writeFiles } from './cmod.js'

const stops: (() => Promise<unknown>)[] = []

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
})

afterAll(deleteTemporaryHomes)

function serve(socket: string, server: ReturnType<typeof interfaceServer>, onClose: () => void = () => undefined) {
  const routes = rpcRoutes({
    handle: (connection) => server.handler(connection),
    onClose: (connection) => {
      server.closed(connection)
      onClose()
    },
    now: () => Date.now(),
  })
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
    wait: async () => undefined,
  })
  stops.push(() => client.close())
  return { client, listeners }
}

function folder() {
  const made = mkdtempSync(join(tmpdir(), 'cmod-rpc-'))
  stops.push(async () => rmSync(made, { recursive: true, force: true }))
  return join(made, 'serve.sock')
}

const platformServer = () => interfaceServer({ implementations: { 'demo/Platform': { ping: () => null } } })

test("a client calls a provider's method by its interface and gets the answer", async () => {
  const socket = folder()
  serve(socket, interfaceServer({ implementations: { 'demo/Platform': { machines: (region: string) => [{ name: `${region}-1` }] } } }))
  const { client } = connect(socket)

  expect(await client.request<unknown>(methodName('demo/Platform', 'machines'), ['eu'])).toEqual([{ name: 'eu-1' }])
})

test('a method the provider lacks fails with its name', async () => {
  const socket = folder()
  serve(socket, interfaceServer({ implementations: { 'demo/Platform': {} } }))
  const { client } = connect(socket)

  await expect(client.request(methodName('demo/Platform', 'destroy'), [])).rejects.toThrow('This program answers no demo/Platform.destroy.')
})

test("an on listener hears each event its matcher matches, and a before listener's refusal reaches the provider", async () => {
  const socket = folder()
  const server = platformServer()
  serve(socket, server)
  const { client, listeners } = connect(socket)

  const heard = new Promise<unknown>((resolve) => listeners.listen(client, listeningOf('demo/Platform', 'on', 'MachineChange', [], { state: 'ready' }), (machine: unknown) => resolve(machine)))
  listeners.listen(client, listeningOf('demo/Platform', 'before', 'MachineCreate', [], undefined, { timeoutMs: 5000 }), (spec: { readonly size: string }) => (spec.size === 'huge' ? { refuse: 'too big' } : undefined))
  await client.request('demo/Platform.ping', [])
  server.emit('demo/Platform', 'MachineChange', { name: 'a', state: 'booting' })
  server.emit('demo/Platform', 'MachineChange', { name: 'a', state: 'ready' })
  const [creating] = server.listeners('demo/Platform', 'MachineCreate')
  const answer = await creating?.connection.request('$/before', { id: creating.id, payload: { size: 'huge' } })

  expect(await heard).toEqual({ name: 'a', state: 'ready' })
  expect(answer).toEqual({ refuse: 'too big' })
  expect(creating?.timeoutMs).toBe(5000)
})

test('a listener the client removed hears nothing, and a closed connection drops its listeners at the provider', async () => {
  const socket = folder()
  const server = platformServer()
  let closed: () => void = () => undefined
  const isClosed = new Promise<void>((resolve) => {
    closed = resolve
  })
  serve(socket, server, () => closed())
  const { client, listeners } = connect(socket)

  const subscription = listeners.listen(client, listeningOf('demo/Platform', 'on', 'MachineChange', [], undefined), () => undefined)
  listeners.listen(client, listeningOf('demo/Platform', 'on', 'MachineDelete', [], undefined), () => undefined)
  await client.request('demo/Platform.ping', [])
  subscription.remove()
  await client.request('demo/Platform.ping', [])
  const afterRemove = server.listeners('demo/Platform').map((each) => each.event)
  await client.close()
  await isClosed

  expect(afterRemove).toEqual(['MachineDelete'])
  expect(server.listeners('demo/Platform')).toEqual([])
})

test("a client that lost its connection connects again, listens again from the last event it heard, and hears what it missed", async () => {
  const socket = folder()
  const server = platformServer()
  const routes = serve(socket, server)
  let connects = 0
  const replayed = Promise.withResolvers<void>()
  const { client, listeners } = connect(socket, async (connected, held) => {
    connects += 1
    if (connects === 1) return
    await held.replay(connected)
    replayed.resolve()
  })
  let hear: (machine: unknown) => void = () => undefined
  const nextHeard = () =>
    new Promise<unknown>((resolve) => {
      hear = resolve
    })
  listeners.listen(client, listeningOf('demo/Platform', 'on', 'MachineChange', [], undefined), (machine: unknown) => hear(machine))
  await client.request('demo/Platform.ping', [])
  const first = nextHeard()
  server.emit('demo/Platform', 'MachineChange', { name: 'first' })
  const heardFirst = await first

  const missed = nextHeard()
  for (const connection of routes.connections()) connection.close(new Error('dropped'))
  routes.close()
  server.emit('demo/Platform', 'MachineChange', { name: 'missed' })
  await client.request('demo/Platform.ping', []).catch((error: unknown) => {
    expect(error).toBeInstanceOf(Error)
  })

  await replayed.promise

  expect(heardFirst).toEqual({ name: 'first' })
  expect(await missed).toEqual({ name: 'missed' })
  expect(connects).toBe(2)
})

test('providers are the programs whose instance record provides the interface', () => {
  const records = [
    { mod: 'demo', program: 'demo', instance: { address: 'unix:/run/demo.sock', pid: 1, started: '', provides: ['cmod/Sessions', 'cmod/Terminal'] } },
    { mod: 'boat', program: 'boat', instance: { address: '127.0.0.1:4000', pid: 2, started: '', provides: ['demo/Platform'] } },
    { mod: 'preview', program: 'preview-server', instance: { address: '127.0.0.1:4001', pid: 3, started: '' } },
  ]

  expect(providersIn(records, 'cmod/Terminal')).toEqual([{ mod: 'demo', program: 'demo', address: 'unix:/run/demo.sock', provides: ['cmod/Sessions', 'cmod/Terminal'] }])
  expect(providersIn(records, 'demo/Platform').map((each) => each.mod)).toEqual(['boat'])
})

declare module 'claude-code' {
  interface CmodInterfaces {
    'demo/Echo': { methods: { echo(text: string): string; change(text: string): void }; events: { Change: { readonly text: string } } }
    'demo/DeviceList': { methods: { forget(id: string): void } }
    'demo/Rules': { methods: { check(tool: string): unknown[] }; events: { Check: { readonly tool: string } } }
  }
}

type Echo = { readonly mod: string; readonly program?: string; readonly device: { readonly id: string; readonly name: string }; echo(text: string): Promise<string>; change(text: string): Promise<void>; onChange(listener: (change: { readonly text: string }) => void): unknown }

type Rules = { readonly mod: string; check(tool: string): Promise<unknown[]>; beforeCheck(listener: (check: { readonly tool: string }) => unknown): unknown }

const coreSource = join(import.meta.dir, '..', '..', 'core', 'src')

const echoProgram = (heard: string) => `import { connect } from '${coreSource}/rpc.ts'
import { provide } from '${coreSource}/mod.ts'
await connect()
const echo = provide('demo/Echo', {
  echo: (text) => \`${heard} \${text}\`,
  change: (text) => echo.tell('Change', { text }),
})
`

const rulesProgram = `import { connect } from '${coreSource}/rpc.ts'
import { provide } from '${coreSource}/mod.ts'
await connect()
const rules = provide('demo/Rules', { check: (tool) => rules.ask('Check', { tool }) })
`

async function servedHome() {
  const home = await temporaryHome()
  await writeFiles(home, { 'echo.ts': echoProgram('heard'), 'bin/echo-provider': `#!/bin/sh\nexec "${process.execPath}" "$HOME/echo.ts"\n` })
  await startCmod(home, 'serve').firstLine()
  return home
}

async function providing(home: string) {
  const program = startCmod(home, 'program', 'demo', '--no-wait', '--', 'echo-provider')
  return { ...program, line: await program.firstLine() }
}

function sessionOn(home: string) {
  const socket = join(home, '.local/share/cmod/serve.sock')
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }))
  tested.fakes.http.fetch = async (url, init = {}) => {
    const answer = await fetch(url, { method: init.method ?? 'GET', ...(typeof init.body === 'string' ? { body: init.body } : {}), ...(init.headers === undefined ? {} : { headers: init.headers }), ...(init.socketPath === undefined ? {} : { unix: socket }) })
    return { status: answer.status, ok: answer.ok, headers: {}, text: await answer.text() }
  }
  return tested
}

test("a program cmod program started provides an interface through connect(), and a session's providers calls its method and hears what it tells", async () => {
  const home = await servedHome()
  const program = await providing(home)
  await sessionOn(home).start()

  const found = (await providers('demo/Echo')) as unknown as readonly Echo[]
  const heard = new Promise<string>((resolve) => found[0]?.onChange((change) => resolve(change.text)))
  const answer = await found[0]?.echo('ping')
  await found[0]?.change('eu-2')

  expect(program.line).toBe('provided')
  expect(found.map((each) => [each.mod, each.program])).toEqual([['demo', 'echo-provider']])
  expect(answer).toBe('heard ping')
  expect(await heard).toBe('eu-2')
}, 30_000)

test("a program that provides an interface through connect() asks a session mod's beforeCheck listener and gets its answer", async () => {
  const home = await servedHome()
  await writeFiles(home, { 'rules.ts': rulesProgram, 'bin/rules-provider': `#!/bin/sh\nexec "${process.execPath}" "$HOME/rules.ts"\n` })
  const program = startCmod(home, 'program', 'rulebook', '--no-wait', '--', 'rules-provider')
  const line = await program.firstLine()
  await sessionOn(home).start()

  const [rules] = (await providers('demo/Rules')) as unknown as readonly Rules[]
  rules?.beforeCheck((check) => (check.tool === 'Bash' ? { rules: { a: 'off' } } : undefined))
  const answers = await rules?.check('Bash')

  expect(line).toBe('provided')
  expect(rules?.mod).toBe('rulebook')
  expect(answers).toEqual([{ rules: { a: 'off' } }])
}, 30_000)

test('a provider program that dies leaves providers at once, and a call to it fails at once, naming it', async () => {
  const home = await servedHome()
  const program = await providing(home)
  await sessionOn(home).start()
  const [echo] = (await providers('demo/Echo')) as unknown as readonly Echo[]
  const { pid } = JSON.parse(readFileSync(join(home, '.local/share/cmod/instances/demo/echo-provider.json'), 'utf8')) as { readonly pid: number }

  process.kill(pid, 'SIGKILL')
  await program.child.exited
  const failed = await echo?.echo('ping').then(
    () => 'answered',
    (error: unknown) => (error as Error).message,
  )

  expect(echo?.mod).toBe('demo')
  expect(await providers('demo/Echo')).toEqual([])
  expect(failed).toBe("demo's echo-provider program does not run, so it answers no demo/Echo.")
}, 30_000)

test('a cmod run script calls the program that provides an interface through providers', async () => {
  const home = await servedHome()
  await writeFiles(home, { 'call.ts': "import { providers } from '@cmodjs/core/mod.js'\nconst [echo] = await providers('demo/Echo')\nconsole.log(JSON.stringify({ mod: echo.mod, program: echo.program, answer: await echo.echo('ping') }))\n" })
  await providing(home)

  const ran = await cmodWith(home, {}, 'run', 'call.ts')

  expect([ran.exitCode, ran.stderr]).toEqual([0, ''])
  expect(JSON.parse(ran.stdout)).toEqual({ mod: 'demo', program: 'echo-provider', answer: 'heard ping' })
}, 30_000)

test("a program from a 7.0.0 core, whose instance file names demo/Echo in provides, still answers a session's providers through cmod serve", async () => {
  const home = await servedHome()
  const socket = join(home, 'boat.sock')
  serve(socket, interfaceServer({ implementations: { 'demo/Echo': { echo: (text: string) => `boat heard ${text}` } } }))
  await writeFiles(home, { '.local/share/cmod/instances/boat/boat.json': JSON.stringify({ address: `unix:${socket}`, pid: process.pid, started: '', provides: ['demo/Echo'] }) })
  await sessionOn(home).start()

  const found = (await providers('demo/Echo')) as unknown as readonly Echo[]

  expect(found.map((each) => [each.mod, each.program])).toEqual([['boat', 'boat']])
  expect(await found[0]?.echo('ping')).toBe('boat heard ping')
}, 30_000)

const providesOnceTold = `import { existsSync, watch } from 'node:fs'
import { connect } from '${coreSource}/rpc.ts'
import { provide } from '${coreSource}/mod.ts'
const home = process.env.HOME
await connect()
await Bun.write(\`\${home}/connected\`, String(process.pid))
await new Promise((resolve) => {
  const told = () => existsSync(\`\${home}/provide\`) && (watcher.close(), resolve())
  const watcher = watch(home, told)
  told()
})
provide('demo/Echo', { echo: (text) => \`\${process.env.CMOD_MOD} heard \${text}\` })
`

function untilSeen(folder: string, isSeen: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = () => isSeen() && (watcher.close(), resolve())
    const watcher = watch(folder, check)
    check()
  })
}

function appears(folder: string, name: string): Promise<void> {
  return untilSeen(folder, () => existsSync(join(folder, name)))
}

async function writeServicePrograms(home: string, programs: Readonly<Record<string, string>>) {
  const folder = join(home, '.local/share/cmod/programs')
  await writeFiles(folder, { cmod: cmodFromSource, ...programs })
  for (const name of ['cmod', ...Object.keys(programs)]) await chmod(join(folder, name), 0o755)
}

async function writeLaterProvider(home: string) {
  await writeFiles(home, { 'later.ts': providesOnceTold })
  await writeServicePrograms(home, { 'later-provider': `#!/bin/sh\nexec "${process.execPath}" "$HOME/later.ts"\n` })
}

async function serviceProviderOn(home: string, elected: { readonly isService: true } | { readonly singleInstance: true } = { isService: true }) {
  await writeLaterProvider(home)
  const plugin = sessionOn(home)
  await plugin.start()
  let server: Program | undefined
  const demo = testMod(defineMod({ name: 'demo', setup: (mod) => void (server = mod.use(program({ command: ['later-provider'], ...elected }))) }))
  demo.fakes.cmod.call = async (call) => calledAnswer('demo', await claudeCodeOf(plugin).fire('cmod.call', { ...call, caller: 'demo' } as never, { deny: `${call.to} is not installed.` }))
  let isOver = false
  stops.push(async () => {
    isOver = true
  })
  demo.fakes.process.spawn = (request) => {
    const started = isOver ? undefined : startCmod(home, ...request.argv.slice(1))
    const ended = started === undefined ? new Promise<never>(() => undefined) : started.done.then(({ exitCode }) => ({ code: exitCode, signal: null }))
    return Object.assign(
      (async function* () {
        if (started !== undefined) yield { stream: 'stdout' as const, text: `${await started.firstLine()}\n` }
        return await ended
      })(),
      { result: ended },
    )
  }
  await demo.start()
  return server as Program
}

test("a mod's isService program that only connect()s and provides demo/Echo later: provider('demo/Echo'), asked before the provide, resolves after it, and its call answers", async () => {
  const home = await servedHome()
  const server = await serviceProviderOn(home)
  let isProvided = false

  const asked = server.provider('demo/Echo').then((echo) => ((isProvided = true), echo))
  await appears(home, 'connected')
  const wasProvidedBeforeTold = isProvided
  await writeFiles(home, { provide: '' })
  const echo = await asked

  expect(wasProvidedBeforeTold).toBe(false)
  expect([echo.mod, echo.program]).toEqual(['demo', 'later-provider'])
  expect(await echo.echo('ping')).toBe('demo heard ping')
}, 30_000)

test("provider('demo/Echo') of a mod's program ignores another mod's program on this computer that provides demo/Echo, and resolves with its own once it provides", async () => {
  const home = await servedHome()
  expect(await startCmod(home, 'program', 'boat', '--no-wait', '--', 'echo-provider').firstLine()).toBe('provided')
  const server = await serviceProviderOn(home)
  let isProvided = false

  const asked = server.provider('demo/Echo').then((echo) => ((isProvided = true), echo))
  await appears(home, 'connected')
  const wasProvidedBeforeTold = isProvided
  await writeFiles(home, { provide: '' })
  const echo = await asked

  expect(wasProvidedBeforeTold).toBe(false)
  expect((await providers('demo/Echo')).map((each) => each.mod).toSorted()).toEqual(['boat', 'demo'])
  expect([echo.mod, echo.program]).toEqual(['demo', 'later-provider'])
  expect(await echo.echo('ping')).toBe('demo heard ping')
}, 30_000)

test("a mod's singleInstance program that only connect()s and provides is starting until its holder prints provided, then running with no address, so ready() names provider(name)", async () => {
  const home = await servedHome()
  const server = await serviceProviderOn(home, { singleInstance: true })

  const readied = server.ready().catch((error: unknown) => (error as Error).message)
  await appears(home, 'connected')
  const beforeProvide = server.state
  await writeFiles(home, { provide: '' })
  const refusal = await readied

  expect(beforeProvide).toBe('starting')
  expect(server.state).toBe('running')
  expect(refusal).toBe('demo: the later-provider program printed no address, because it only provides interfaces. Reach them through provider(name).')
}, 30_000)

test("a holder that waits for its copy's first provide asks cmod serve again once it restarts, then writes the copy's record and prints provided", async () => {
  const home = await temporaryHome()
  await writeLaterProvider(home)
  const record = join(home, '.local/share/cmod/instances/demo/later-provider.json')
  const firstServe = startCmod(home, 'serve')
  await firstServe.firstLine()
  const holder = startCmod(home, 'program', 'demo', '--no-wait', '--', 'later-provider')
  await appears(home, 'connected')

  firstServe.child.kill('SIGTERM')
  await firstServe.done
  await startCmod(home, 'serve').firstLine()
  await writeFiles(home, { provide: '' })
  const line = await holder.firstLine()
  const pid = Number(readFileSync(join(home, 'connected'), 'utf8'))

  expect(line).toBe('provided')
  expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ pid, started: await startTime(pid) })
}, 30_000)

test("cmod program --service of a program that only connect()s and provides writes its instance record once it provides, with its pid and start time and no address, and prints held within a second of the provide, so it holds the mod's lock no longer", async () => {
  const home = await servedHome()
  await writeLaterProvider(home)
  const record = join(home, '.local/share/cmod/instances/demo/later-provider.json')
  const started = startCmod(home, 'program', 'demo', '--service', '--', 'later-provider')

  await appears(home, 'connected')
  const isRecordedBeforeProvide = existsSync(record)
  const providedAt = Date.now()
  await writeFiles(home, { provide: '' })
  const held = await started.done
  const pid = Number(readFileSync(join(home, 'connected'), 'utf8'))

  expect(isRecordedBeforeProvide).toBe(false)
  expect([held.exitCode, held.stdout, held.stderr]).toEqual([0, 'held\n', ''])
  expect(Date.now() - providedAt).toBeLessThan(1000)
  expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ pid, started: await startTime(pid) })
}, 30_000)

const loggedProvider = (heard: string) => `import { appendFileSync } from 'node:fs'
import { connect } from '${coreSource}/rpc.ts'
import { provide, providers } from '${coreSource}/mod.ts'
const log = \`\${process.env.HOME}/provider-log\`
process.on('SIGTERM', () => {
  appendFileSync(log, \`stop \${process.pid}\\n\`)
  process.exit(0)
})
await connect()
provide('demo/Echo', { echo: (text) => \`${heard} \${text}\` })
await providers('demo/Echo')
appendFileSync(log, \`start \${process.pid}\\n\`)
`

function providerLog(home: string): string[] {
  return existsSync(join(home, 'provider-log')) ? readFileSync(join(home, 'provider-log'), 'utf8').trim().split('\n') : []
}

test("a build of a linked checkout that changes the program of a service that only connect()s and provides stops its copy with SIGTERM, and the service starts the new build, which provides again", async () => {
  const home = await servedHome()
  const checkout = join(home, 'Developer', 'demo')
  const instances = join(home, '.local/share/cmod/instances/demo')
  const recorded = () => (existsSync(join(instances, 'linked-provider.json')) ? (JSON.parse(readFileSync(join(instances, 'linked-provider.json'), 'utf8')) as ProgramInstance) : undefined)
  const buildOf = (source: string) => `#!/bin/sh\nexec "${process.execPath}" "$HOME/${source}"\n`
  await writeServicePrograms(home, {})
  await writeFiles(home, { 'first.ts': loggedProvider('first'), 'second.ts': loggedProvider('second'), 'provider-build': buildOf('first.ts') })
  await writeFiles(checkout, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'cli/package.json': JSON.stringify({ name: 'linked-provider', cmod: { build: `mkdir -p dist && cp "$HOME/provider-build" dist/linked-provider-${process.platform}-${process.arch}`, output: 'dist' } }),
  })
  expect((await cmod(home, 'link', checkout)).exitCode).toBe(0)
  expect(await cmod(home, 'program', 'demo', '--service', '--', 'linked-provider')).toMatchObject({ exitCode: 0, stdout: 'held\n' })
  const first = recorded()?.pid

  await writeFiles(home, { 'provider-build': buildOf('second.ts') })
  expect((await cmod(home, 'link', checkout)).exitCode).toBe(0)
  await untilSeen(home, () => providerLog(home).length === 3)
  await untilSeen(instances, () => recorded() !== undefined && recorded()?.pid !== first)
  const next = recorded()?.pid as number
  await sessionOn(home).start()
  const [echo] = (await providers('demo/Echo')) as unknown as readonly Echo[]

  expect(providerLog(home)).toEqual([`start ${first}`, `stop ${first}`, `start ${next}`])
  expect(recorded()).toEqual({ pid: next, started: await startTime(next) })
  expect(await echo?.echo('ping')).toBe('second ping')
}, 60_000)

test('cmod program --service of a program that prints its address and provides nothing prints held once its address is in the instance file, which holds its address, pid, and start time and nothing else', async () => {
  const home = await servedHome()
  await writeServicePrograms(home, { 'address-server': '#!/bin/sh\necho "unix:$HOME/$$.sock"\nexec sleep 600\n' })
  const startedAt = Date.now()

  const held = await cmod(home, 'program', 'demo', '--service', '--', 'address-server')
  const instance = JSON.parse(readFileSync(join(home, '.local/share/cmod/instances/demo/address-server.json'), 'utf8')) as ProgramInstance

  expect([held.exitCode, held.stdout]).toEqual([0, 'held\n'])
  expect(Date.now() - startedAt).toBeLessThan(15_000)
  expect(instance).toEqual({ address: `unix:${home}/${instance.pid}.sock`, pid: instance.pid, started: await startTime(instance.pid) })
}, 30_000)

test('connect() outside a program cmod program started fails, naming CMOD_MOD', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { 'connect.ts': `import { connect } from '${coreSource}/rpc.ts'\nawait connect()\n` })

  const ran = Bun.spawn([process.execPath, join(home, 'connect.ts')], { cwd: home, env: { ...environment(home), CMOD_MOD: '' }, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stderr] = await Promise.all([ran.exited, new Response(ran.stderr).text()])

  expect(exitCode).toBe(1)
  expect(stderr).toContain('connect() names its mod by CMOD_MOD, which cmod program sets for every program it starts, and CMOD_MOD is not set. Start this program from a program job with singleInstance or isService.')
}, 30_000)

const devicesProgram = `import { connect } from '${coreSource}/rpc.ts'
import { provide, providers } from '${coreSource}/mod.ts'
await connect()
let listed = JSON.parse(await Bun.file(\`\${process.env.HOME}/devices.json\`).text())
const devices = provide('cmod/Devices', { devices: () => listed })
provide('demo/DeviceList', {
  forget: async (id) => {
    listed = listed.filter((device) => device.id !== id)
    devices.tell('Change', { device: id })
    await providers('demo/Echo')
  },
})
`

const devboxClaude = `#!/bin/sh
case "$1" in
  --bg) printf '%s\\n' "$@" > "$HOME/bg-args"; echo 'backgrounded · task0001' ;;
  agents) echo '[{"id":"task0001","sessionId":"task-on-devbox","status":"running"}]' ;;
  *) exit 1 ;;
esac
`

type DeviceHome = { readonly home: string; readonly device: { readonly id: string; readonly name: string }; readonly address: string }

async function deviceHome(name: string, platform: string, files: (home: string) => Record<string, string> = () => ({})): Promise<DeviceHome> {
  const home = await temporaryHome()
  await writeFiles(home, {
    'bin/uname': `#!/bin/sh\nif [ "$1" = -snm ]; then echo 'Darwin ${name} arm64'; else exec /usr/bin/uname "$@"; fi\n`,
    'bin/ioreg': `#!/bin/sh\necho '"IOPlatformUUID" = "${platform}"'\n`,
    'bin/scutil': `#!/bin/sh\necho ${name}\n`,
    'echo.ts': echoProgram(`${name} heard`),
    'bin/echo-provider': `#!/bin/sh\nexec "${process.execPath}" "$HOME/echo.ts"\n`,
    'devices.ts': devicesProgram,
    'bin/devices-provider': `#!/bin/sh\nexec "${process.execPath}" "$HOME/devices.ts"\n`,
    ...files(home),
  })
  await startCmod(home, 'serve').firstLine()
  const { id } = JSON.parse((await cmod(home, 'device', '--json')).stdout) as { readonly id: string }
  return { home, device: { id, name }, address: join(home, '.local/share/cmod/serve.sock') }
}

async function startProgram(home: string, program: string) {
  expect(await startCmod(home, 'program', 'demo', '--no-wait', '--', program).firstLine()).toBe('provided')
}

async function listsDevices(on: DeviceHome, ...devices: readonly DeviceHome[]) {
  await writeFiles(on.home, { 'devices.json': JSON.stringify(devices.map(({ device, address }) => ({ ...device, address }))) })
  await startProgram(on.home, 'devices-provider')
}

const transcript = (session: string, folder: string) =>
  [
    { type: 'user', uuid: `${session}-u`, sessionId: session, timestamp: '2026-11-20T10:00:00.000Z', cwd: folder, message: { role: 'user', content: 'Upgrade the dependencies' } },
    { type: 'assistant', uuid: `${session}-a`, sessionId: session, timestamp: '2026-11-20T10:00:02.000Z', cwd: folder, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Upgraded.' }] } },
  ]
    .map((row) => `${JSON.stringify(row)}\n`)
    .join('')

const endedOn = (home: string) => ({ 'bin/claude': devboxClaude, 'work/app/.keep': '', [`.claude/projects/${join(home, 'work/app').replace(/[^A-Za-z0-9]/g, '-')}/devbox-1.jsonl`]: transcript('devbox-1', join(home, 'work/app')) })

test("a session reaches a program on another device at the address a cmod/Devices provider gives: providers names that device, the call answers, and its Change reaches the session", async () => {
  const devbox = await deviceHome('devbox', '22222222-2222-2222-2222-222222222222')
  const mac = await deviceHome('mac', '11111111-1111-1111-1111-111111111111')
  await startProgram(devbox.home, 'echo-provider')
  await listsDevices(mac, devbox)
  await sessionOn(mac.home).start()

  const found = (await providers('demo/Echo')) as unknown as readonly Echo[]
  const heard = new Promise<string>((resolve) => found[0]?.onChange((change) => resolve(change.text)))
  const answer = await found[0]?.echo('ping')
  await found[0]?.change('eu-2')

  expect(found.map((each) => [each.mod, each.program, each.device])).toEqual([['demo', 'echo-provider', devbox.device]])
  expect(answer).toBe('devbox heard ping')
  expect(await heard).toBe('eu-2')
}, 30_000)

test("a session lists another device's sessions with that device, and a message to one of them resumes it on that device", async () => {
  const devbox = await deviceHome('devbox', '22222222-2222-2222-2222-222222222222', endedOn)
  const mac = await deviceHome('mac', '11111111-1111-1111-1111-111111111111')
  await listsDevices(mac, devbox)
  await sessionOn(mac.home).start()

  const listed = await sessions.list({ everyProject: true })
  await listed.find((each) => each.id === 'devbox-1')?.send({ type: 'prompt', text: 'Run it again' })

  expect(listed.map((each) => [each.id, each.device])).toEqual([['devbox-1', devbox.device]])
  expect(readFileSync(join(devbox.home, 'bg-args'), 'utf8').trimEnd().split('\n')).toEqual(['--bg', '--resume', 'devbox-1', '--', 'Run it again'])
}, 30_000)

test("a background task that names another device starts there, from that device's cmod serve", async () => {
  const devbox = await deviceHome('devbox', '22222222-2222-2222-2222-222222222222', endedOn)
  const mac = await deviceHome('mac', '11111111-1111-1111-1111-111111111111')
  await listsDevices(mac, devbox)
  const session = sessionOn(mac.home)
  await session.start()
  await claudeCodeOf(session).fire('SessionStart', { source: 'startup' })
  await session.settle()

  const task = await sessions.current.startTask({ title: 'Upgrade the dependencies', prompt: 'Upgrade every dependency.', cwd: join(devbox.home, 'work/app'), isBackground: true, device: 'devbox' })
  const args = readFileSync(join(devbox.home, 'bg-args'), 'utf8').trimEnd().split('\n')
  const settings = JSON.parse(args[args.indexOf('--settings') + 1] ?? '{}') as { readonly env: { readonly CMOD_TASK: string } }

  expect(task.id).toBe('task-on-devbox')
  expect(args.at(-1)).toBe('Upgrade every dependency.')
  expect(JSON.parse(settings.env.CMOD_TASK)).toMatchObject({ session: 'test-session', title: 'Upgrade the dependencies', isBackground: true })
}, 30_000)

test('two devices that list each other carry a call one hop, because each offers the other only its own providers', async () => {
  const mac = await deviceHome('mac', '11111111-1111-1111-1111-111111111111')
  const devbox = await deviceHome('devbox', '22222222-2222-2222-2222-222222222222')
  await startProgram(mac.home, 'echo-provider')
  await startProgram(devbox.home, 'echo-provider')
  await listsDevices(mac, devbox)
  await listsDevices(devbox, mac)
  await sessionOn(mac.home).start()
  const { client: devboxServe } = connect(devbox.address)

  const found = (await providers('demo/Echo')) as unknown as readonly Echo[]
  const answers = await Promise.all(found.map((each) => each.echo('ping')))
  const carriedByDevbox = await devboxServe.request<readonly { readonly device: { readonly name: string } }[]>('$/providers', { interface: 'demo/Echo' })
  const offeredByDevbox = await devboxServe.request('$/providers', { interface: 'demo/Echo', device: devbox.device.id })
  const offeredAsMac = await devboxServe.request('$/providers', { interface: 'demo/Echo', device: mac.device.id })

  expect(found.map((each) => each.device.name)).toEqual(['mac', 'devbox'])
  expect(answers).toEqual(['mac heard ping', 'devbox heard ping'])
  expect(carriedByDevbox.map((each) => each.device.name)).toEqual(['devbox', 'mac'])
  expect(offeredByDevbox).toEqual([{ mod: 'demo', program: 'echo-provider', device: devbox.device }])
  expect(offeredAsMac).toEqual([])
}, 30_000)

test('a device leaves providers once its cmod/Devices provider tells it is gone', async () => {
  const devbox = await deviceHome('devbox', '22222222-2222-2222-2222-222222222222')
  const mac = await deviceHome('mac', '11111111-1111-1111-1111-111111111111')
  await startProgram(devbox.home, 'echo-provider')
  await listsDevices(mac, devbox)
  await sessionOn(mac.home).start()
  const before = (await providers('demo/Echo')) as unknown as readonly Echo[]
  const [list] = await providers('demo/DeviceList')

  await list?.forget(devbox.device.id)

  expect(before.map((each) => each.device.name)).toEqual(['devbox'])
  expect(await providers('demo/Echo')).toEqual([])
}, 30_000)

const listedSession = (id: string) => ({ id, title: id, project: '/work/app', model: 'claude-opus-5-5', cwd: '/work/app', isRunning: true, startedAt: '2026-11-20T10:00:00.000Z', lastAt: '2026-11-20T10:00:02.000Z' })

const offlineProgram = `import { connect, NotHeld } from '${coreSource}/rpc.ts'
import { provide } from '${coreSource}/mod.ts'
await connect()
provide('cmod/Sessions', {
  sessions: () => [],
  usage: (session) => {
    if (session === 's1') throw new NotHeld(session)
    throw new Error(\`offline cannot reach \${session}\`)
  },
})
`

const devboxProgram = `import { connect } from '${coreSource}/rpc.ts'
import { provide } from '${coreSource}/mod.ts'
await connect()
provide('cmod/Sessions', {
  sessions: () => ${JSON.stringify([listedSession('s1'), listedSession('s2')])},
  usage: (session) => ({ model: \`devbox \${session}\`, contextWindow: { size: 200000 }, rateLimits: [] }),
})
`

async function sessionsProvidersOn(home: string) {
  await writeFiles(home, {
    'offline.ts': offlineProgram,
    'bin/offline-provider': `#!/bin/sh\nexec "${process.execPath}" "$HOME/offline.ts"\n`,
    'devbox.ts': devboxProgram,
    'bin/devbox-provider': `#!/bin/sh\nexec "${process.execPath}" "$HOME/devbox.ts"\n`,
  })
  expect(await startCmod(home, 'program', 'offline', '--no-wait', '--', 'offline-provider').firstLine()).toBe('provided')
  expect(await startCmod(home, 'program', 'devbox', '--no-wait', '--', 'devbox-provider').firstLine()).toBe('provided')
  await sessionOn(home).start()
}

test('a call on a session that a connect() program throws NotHeld for goes on to the next cmod/Sessions provider, which answers it', async () => {
  await sessionsProvidersOn(await servedHome())

  const usage = await (await sessions.get('s1')).usage()

  expect(usage.model).toBe('devbox s1')
}, 30_000)

test("any other error a connect() program's cmod/Sessions method throws ends the call with its message, and no later provider answers it", async () => {
  await sessionsProvidersOn(await servedHome())

  const failed = await (await sessions.get('s2')).usage().then(
    () => 'answered',
    (error: unknown) => (error as Error).message,
  )

  expect(failed).toBe('offline cannot reach s2')
}, 30_000)
