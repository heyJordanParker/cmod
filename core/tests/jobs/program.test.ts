import { expect, test } from 'bun:test'
import type { HookStream, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult } from 'claude-code'
import { program, type Program } from '../../src/jobs/program.js'
import { defineMod, providers } from '../../src/mod.js'
import { engineOf } from '../../src/runtime/engine.js'
import { providerHoldMs } from '../../src/runtime/interfaces.js'
import { testMod } from '../../src/testing.js'

function written(chunks: readonly ProcessSpawnChunk[], exits: boolean, closed: () => void = () => undefined): HookStream<ProcessSpawnChunk, ProcessSpawnResult> {
  async function* read(): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
    try {
      yield* chunks
      if (!exits) await new Promise(() => undefined)
      return { code: 1, signal: null }
    } finally {
      closed()
    }
  }
  return Object.assign(read(), { result: new Promise<ProcessSpawnResult>(() => undefined) }) as HookStream<ProcessSpawnChunk, ProcessSpawnResult>
}

function preview(spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>, singleInstance = false, files: Record<string, string> = {}) {
  let handle: Program | undefined
  const tested = testMod(
    defineMod({
      name: 'demo',
      setup(mod) {
        handle = mod.use(program({ command: ['preview-server', '--port', '0'], singleInstance }))
      },
    }),
    { files },
  )
  tested.fakes.process.spawn = spawn
  const ready = async (): Promise<Program> => {
    await tested.start()
    return handle as Program
  }
  return { tested, ready }
}

test('a first line unix:/tmp/x.sock resolves ready() to the socket and http://localhost', async () => {
  const spawned: ProcessSpawnRequest[] = []
  const { tested, ready } = preview((request) => {
    spawned.push(request)
    return written([{ stream: 'stdout', text: 'unix:/tmp/x.sock\nlistening\n' }], false)
  })

  const started = await ready()

  expect(await started.ready()).toEqual({ url: 'http://localhost', socketPath: '/tmp/x.sock' })
  expect(started.state).toBe('running')
  expect(spawned).toEqual([{ argv: ['preview-server', '--port', '0'], env: { CMOD_DATA: '/test/home/.local/share/cmod/data/demo', CMOD_CACHE: '/test/home/.cache/cmod/demo' } }])
  expect(tested.shown.toasts.find(({ message }) => message === 'Installed')?.description).toContain('Adds the preview-server program.')
})

test("a program runs with CMOD_DATA and CMOD_CACHE, the folders mod.dataFolder and mod.cacheFolder name, beside the program's own environment", async () => {
  const spawned: ProcessSpawnRequest[] = []
  let folders: readonly string[] = []
  const tested = testMod(
    defineMod({
      name: 'demo',
      setup(mod) {
        folders = [mod.dataFolder, mod.cacheFolder]
        mod.use(program({ command: ['preview-server'], environment: { PREVIEW_ROOT: '/srv/site' } }))
      },
    }),
  )
  tested.fakes.process.spawn = (request) => {
    spawned.push(request)
    return written([{ stream: 'stdout', text: 'unix:/tmp/x.sock\n' }], false)
  }

  await tested.start()

  expect(spawned.map(({ env }) => env)).toEqual([{ CMOD_DATA: folders[0] as string, CMOD_CACHE: folders[1] as string, PREVIEW_ROOT: '/srv/site' }])
})

test('a first line 127.0.0.1:53211 resolves ready() to its http URL, even when the line comes in two pieces', async () => {
  const { ready } = preview(() =>
    written(
      [
        { stream: 'stdout', text: '127.0.0.1:' },
        { stream: 'stdout', text: '53211\n' },
      ],
      false,
    ),
  )

  expect(await (await ready()).ready()).toEqual({ url: 'http://127.0.0.1:53211' })
})

test('a first line hello fails the start, closes the program, and the notice and ready() show hello', async () => {
  let isClosed = false
  const { tested, ready } = preview(() =>
    written([{ stream: 'stdout', text: 'hello\n' }], false, () => {
      isClosed = true
    }),
  )
  const started = await ready()

  await expect(started.ready()).rejects.toThrow('demo: the preview-server program stopped: its first line is "hello".')
  expect(started.state).toBe('fatal')
  expect(isClosed).toBe(true)
  expect(tested.shown.toasts).toContainEqual({
    type: 'error',
    message: 'The preview-server program stopped',
    description: 'its first line is "hello". Write 127.0.0.1:<port> or unix:<socket path> as the first line on standard output.',
  })
})

test("a program that fails as ready() counts fatal rejects provider(name) with ready()'s error, whether it was asked before the failure or after", async () => {
  let printFirstLine: () => void = () => undefined
  const firstLine = new Promise<void>((resolve) => {
    printFirstLine = resolve
  })
  const { tested, ready } = preview(() =>
    Object.assign(
      (async function* () {
        await firstLine
        yield { stream: 'stdout' as const, text: 'hello\n' }
        await new Promise(() => undefined)
        return { code: 1, signal: null }
      })(),
      { result: new Promise<ProcessSpawnResult>(() => undefined) },
    ),
    true,
  )
  const holds: (() => void)[] = []
  tested.fakes.clock.after = (ms, fn) => {
    if (ms === providerHoldMs) holds.push(fn)
    else void Promise.resolve().then(fn)
    return { cancel: () => undefined }
  }
  const started = await ready()

  const askedBefore = started.provider('demo/Echo').catch((error: unknown) => (error as Error).message)
  printFirstLine()
  const before = await askedBefore
  const after = await started.provider('demo/Echo').catch((error: unknown) => (error as Error).message)
  const readied = await started.ready().catch((error: unknown) => (error as Error).message)

  expect(holds.length).toBeGreaterThan(0)
  expect(started.state).toBe('fatal')
  expect(before).toBe('demo: the preview-server program stopped: its first line is "hello". Write 127.0.0.1:<port> or unix:<socket path> as the first line on standard output.')
  expect([after, readied]).toEqual([before, before])
})

test("a singleInstance program whose holder prints provided runs from that line alone, with no cmod:provider call, and ready() asked before or after it rejects with the way to reach the program", async () => {
  let printProvided: () => void = () => undefined
  const isProvided = new Promise<void>((resolve) => {
    printProvided = resolve
  })
  const { tested, ready } = preview(
    () =>
      Object.assign(
        (async function* () {
          await isProvided
          yield { stream: 'stdout' as const, text: 'provided\n' }
          await new Promise(() => undefined)
          return { code: 0, signal: null }
        })(),
        { result: new Promise<ProcessSpawnResult>(() => undefined) },
      ),
    true,
  )
  const asked: string[] = []
  const answerCmod = tested.fakes.cmod.call
  tested.fakes.cmod.call = async (call) => (asked.push(call.method), answerCmod?.(call))
  const started = await ready()

  const askedBefore = started.ready().catch((error: unknown) => (error as Error).message)
  const beforeProvided = started.state
  printProvided()
  const before = await askedBefore
  const after = await started.ready().catch((error: unknown) => (error as Error).message)
  await tested.settle()

  expect(beforeProvided).toBe('starting')
  expect(started.state).toBe('running')
  expect([before, after]).toEqual(Array(2).fill('demo: the preview-server program printed no address, because it only provides interfaces. Reach them through provider(name).'))
  expect(asked.filter((method) => method === 'cmod:provider')).toEqual([])
})

test('a program with neither singleInstance nor isService rejects provider(name) at once, because each session runs its own copy', async () => {
  const { ready } = preview(() => written([{ stream: 'stdout', text: 'unix:/tmp/x.sock\n' }], false))
  const started = await ready()

  await expect(started.provider('demo/Echo')).rejects.toThrow('demo: provider(demo/Echo) needs the preview-server program to run as singleInstance or isService, because only one copy of a program can provide an interface.')
})

test("a program that exits restarts after 1, 2, 4, 8, and 16 s, then is fatal with its last standard error line, which reaches cmod's Log and toasts only where cmod answers show", async () => {
  const delays: number[] = []
  let starts = 0
  const { tested, ready } = preview(() => {
    starts += 1
    return written([{ stream: 'stderr', text: `listen EADDRINUSE (start ${starts})\n` }], true)
  })
  tested.fakes.clock.after = (ms, fn) => {
    if (ms === 30_000) return { cancel: () => undefined }
    delays.push(ms)
    fn()
    return { cancel: () => undefined }
  }
  const logged: unknown[] = []
  const answerCmod = tested.fakes.cmod.call
  tested.fakes.cmod.call = async (call) => (call.method === 'cmod:failed' ? (logged.push(call.input), { showsToast: false }) : answerCmod?.(call))

  const started = await ready()
  const answered = expect(started.ready()).rejects.toThrow(
    'demo: the preview-server program stopped: it did not start again after 5 tries: listen EADDRINUSE (start 6).',
  )
  await tested.settle()

  expect(delays.filter((ms) => ms > 0)).toEqual([1000, 2000, 4000, 8000, 16000])
  expect(starts).toBe(6)
  expect(started.state).toBe('fatal')
  expect(logged).toEqual([expect.objectContaining({ mod: 'demo', id: 'program:preview-server', message: 'The preview-server program stopped', isCritical: false })])
  expect(tested.shown.toasts.filter(({ type }) => type === 'error')).toEqual([])
  await answered
})

test('a program that crashes six times in a session with long runs between stays running', async () => {
  const delays: number[] = []
  let starts = 0
  const { tested, ready } = preview(() => {
    starts += 1
    return written([{ stream: 'stdout', text: `unix:/tmp/run-${starts}.sock\n` }], starts <= 6)
  })
  tested.fakes.clock.after = (ms, fn) => {
    delays.push(ms)
    fn()
    return { cancel: () => undefined }
  }

  const started = await ready()
  await started.ready()
  await tested.settle()

  expect(delays).toEqual([1000, 1000, 1000, 1000, 1000, 1000])
  expect(starts).toBe(7)
  expect(started.state).toBe('running')
  expect(await started.ready()).toEqual({ url: 'http://localhost', socketPath: '/tmp/run-7.sock' })
})

test('a program that has not exited is in backoff between starts, and ready() waits for the next copy', async () => {
  const pending: (() => void)[] = []
  let starts = 0
  const { tested, ready } = preview(() => {
    starts += 1
    return starts === 1 ? written([], true) : written([{ stream: 'stdout', text: 'unix:/tmp/y.sock\n' }], false)
  })
  tested.fakes.clock.after = (_ms, fn) => {
    pending.push(fn)
    return { cancel: () => undefined }
  }

  const started = await ready()
  await tested.settle()
  expect(started.state).toBe('backoff')
  const answer = started.ready()
  pending.shift()?.()

  expect(await answer).toEqual({ url: 'http://localhost', socketPath: '/tmp/y.sock' })
})

test("a singleInstance program runs as the store's cmod program demo --no-wait -- preview-server --port 0", async () => {
  const spawned: (readonly string[])[] = []
  const { ready } = preview((request) => {
    spawned.push(request.argv)
    return written([{ stream: 'stdout', text: 'unix:/tmp/x.sock\n' }], false)
  }, true)

  expect(await (await ready()).ready()).toEqual({ url: 'http://localhost', socketPath: '/tmp/x.sock' })
  expect(spawned).toEqual([['/test/home/.local/share/cmod/programs/cmod', 'program', 'demo', '--no-wait', '--', 'preview-server', '--port', '0']])
})

const instanceFile = '/test/home/.local/share/cmod/instances/demo/preview-server.json'

const heldCopy = { [instanceFile]: '{"address":"unix:/tmp/held.sock","pid":4242,"started":"Mon Nov  2 09:00:00 2026"}\n', [`${instanceFile}.lock/4242`]: 'Mon Nov  2 09:00:00 2026' }

test('a singleInstance program another session holds answers held, and ready() resolves the address in the instance file with no process left running', async () => {
  let isClosed = false
  const { ready } = preview(
    () =>
      written([{ stream: 'stdout', text: 'held\n' }], true, () => {
        isClosed = true
      }),
    true,
    heldCopy,
  )
  const started = await ready()

  expect(await started.ready()).toEqual({ url: 'http://localhost', socketPath: '/tmp/held.sock' })
  expect(started.state).toBe('running')
  expect(isClosed).toBe(true)
})

test('a singleInstance program whose holder touched its lock within 15 s reads the instance file and spawns nothing', async () => {
  const spawned: (readonly string[])[] = []
  const { tested, ready } = preview(
    (request) => {
      spawned.push(request.argv)
      return written([], false)
    },
    true,
    heldCopy,
  )
  tested.fakes.clock.now = async () => 14_999

  expect(await (await ready()).ready()).toEqual({ url: 'http://localhost', socketPath: '/tmp/held.sock' })
  expect(spawned).toEqual([])
})

test("a following session starts cmod program once the holder's instance file is gone and its lock is stale, and ready() moves to the new copy", async () => {
  const timers: (() => void)[] = []
  let starts = 0
  const { tested, ready } = preview(
    () => {
      starts += 1
      return starts === 1 ? written([{ stream: 'stdout', text: 'held\n' }], true) : written([{ stream: 'stdout', text: 'unix:/tmp/next.sock\n' }], false)
    },
    true,
    heldCopy,
  )
  tested.fakes.clock.every = (_ms, fn) => {
    timers.push(fn)
    return { cancel: () => undefined }
  }
  const started = await ready()
  expect(await started.ready()).toEqual({ url: 'http://localhost', socketPath: '/tmp/held.sock' })
  const read = tested.fakes.fs.read
  tested.fakes.fs.read = async (path) => {
    if (path === instanceFile) throw new Error(`ENOENT: no such file, read '${path}'`)
    return (read as NonNullable<typeof read>)(path)
  }

  for (const fire of timers) fire()
  await tested.settle()

  expect(starts).toBe(2)
  expect(await started.ready()).toEqual({ url: 'http://localhost', socketPath: '/tmp/next.sock' })
})

test("a following session's ready() reads the instance file again, so it never answers with the address of a copy whose holder removed the file, before the file watch notices", async () => {
  let starts = 0
  const { tested, ready } = preview(
    () => {
      starts += 1
      return starts === 1 ? written([{ stream: 'stdout', text: 'held\n' }], true) : written([{ stream: 'stdout', text: 'unix:/tmp/next.sock\n' }], false)
    },
    true,
    heldCopy,
  )
  tested.fakes.clock.every = () => ({ cancel: () => undefined })
  tested.fakes.clock.after = (_ms, fn) => {
    fn()
    return { cancel: () => undefined }
  }
  const started = await ready()
  const before = await started.ready()
  const read = tested.fakes.fs.read
  tested.fakes.fs.read = async (path) => {
    if (path === instanceFile) throw new Error(`ENOENT: no such file, read '${path}'`)
    return (read as NonNullable<typeof read>)(path)
  }

  const after = await started.ready()

  expect(before).toEqual({ url: 'http://localhost', socketPath: '/tmp/held.sock' })
  expect(after).toEqual({ url: 'http://localhost', socketPath: '/tmp/next.sock' })
  expect(starts).toBe(2)
})

test("a following session waits for a holder that has not written its instance file yet, and reads the file once cmod/Programs tells that the holder wrote it", async () => {
  const lock = { [`${instanceFile}.lock/4242`]: 'Mon Nov  2 09:00:00 2026' }
  const { tested, ready } = preview(() => written([{ stream: 'stdout', text: 'held\n' }], true), true, lock)
  tested.fakes.clock.now = async () => 14_999
  tested.fakes.clock.every = () => ({ cancel: () => undefined })
  const started = await ready()
  const address = started.ready()
  await tested.settle()
  expect(started.state).toBe('starting')

  await tested.fakes.fs.write?.(instanceFile, heldCopy[instanceFile])
  const [programs] = await providers('cmod/Programs')
  await programs?.changed('demo', 'preview-server')

  expect(await address).toEqual({ url: 'http://localhost', socketPath: '/tmp/held.sock' })
})

test('an isService program asks cmod program --service for the computer-wide copy, and ready() resolves the address the service wrote to the instance file', async () => {
  const spawned: ProcessSpawnRequest[] = []
  let handle: Program | undefined
  const tested = testMod(
    defineMod({
      name: 'demo',
      setup(mod) {
        handle = mod.use(program({ command: ['preview-server', '--port', '0'], environment: { PREVIEW_ROOT: '/srv/site' }, isService: true }))
      },
    }),
    { files: heldCopy },
  )
  tested.fakes.clock.now = async () => 14_999
  tested.fakes.process.spawn = (request) => {
    spawned.push(request)
    return written([{ stream: 'stdout', text: 'held\n' }], true)
  }
  await tested.start()

  expect(await handle?.ready()).toEqual({ url: 'http://localhost', socketPath: '/tmp/held.sock' })
  expect(handle?.state).toBe('running')
  expect(spawned.map(({ argv }) => argv)).toEqual([['/test/home/.local/share/cmod/programs/cmod', 'program', 'demo', '--service', '--env', 'PREVIEW_ROOT', '--', 'preview-server', '--port', '0']])
  expect(spawned[0]?.env).toMatchObject({ PREVIEW_ROOT: '/srv/site' })
})

test('two isService programs with one executable in a mod throw at mod.use, so the computer runs one copy', async () => {
  const tested = testMod(
    defineMod({
      name: 'demo',
      setup(mod) {
        mod.use(program({ command: ['preview-server', '--port', '0'], isService: true }))
        mod.use(program({ command: ['preview-server', '--port', '1'], isService: true }))
      },
    }),
  )
  tested.fakes.process.spawn = () => written([{ stream: 'stdout', text: 'held\n' }], true)

  await expect(tested.start()).rejects.toThrow('demo: the service preview-server is already added. Give each isService program its own executable.')
})

function webApp(options: { readonly singleInstance?: boolean; readonly isService?: boolean }, files: Record<string, string>, spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>) {
  let handle: Program | undefined
  const tested = testMod(defineMod({ name: 'demo', setup: (mod) => void (handle = mod.use(program({ command: ['preview-server', '--port', '0'], ...options, isWebApp: true }))) }), { files })
  tested.fakes.process.spawn = spawn
  return { tested, ready: async () => (await tested.start(), handle as Program) }
}

const onTailnet = (address: string) => ({ [instanceFile]: `${JSON.stringify({ address, pid: 4242, started: 'Mon Nov  2 09:00:00 2026', tailnetUrl: 'https://macbook.example.ts.net:62021/' })}\n` })

test('a singleInstance web app runs cmod program --web-app, and ready() resolves the tailnet address the holder wrote beside the local one', async () => {
  const spawned: (readonly string[])[] = []
  const { ready } = webApp({ singleInstance: true }, onTailnet('127.0.0.1:62021'), (request) => {
    spawned.push(request.argv)
    return written([{ stream: 'stdout', text: '127.0.0.1:62021\n' }], false)
  })

  expect(await (await ready()).ready()).toEqual({ url: 'http://127.0.0.1:62021', tailnetUrl: 'https://macbook.example.ts.net:62021/' })
  expect(spawned).toEqual([['/test/home/.local/share/cmod/programs/cmod', 'program', 'demo', '--web-app', '--no-wait', '--', 'preview-server', '--port', '0']])
})

test('an isService web app asks cmod program --web-app --service for the copy, and ready() resolves the tailnet address in the instance file', async () => {
  const spawned: (readonly string[])[] = []
  const { tested, ready } = webApp({ isService: true }, { ...onTailnet('127.0.0.1:62021'), [`${instanceFile}.lock/4242`]: 'Mon Nov  2 09:00:00 2026' }, (request) => {
    spawned.push(request.argv)
    return written([{ stream: 'stdout', text: 'held\n' }], true)
  })
  tested.fakes.clock.now = async () => 14_999

  expect(await (await ready()).ready()).toEqual({ url: 'http://127.0.0.1:62021', tailnetUrl: 'https://macbook.example.ts.net:62021/' })
  expect(spawned).toEqual([['/test/home/.local/share/cmod/programs/cmod', 'program', 'demo', '--web-app', '--service', '--', 'preview-server', '--port', '0']])
})

test('a web app off the tailnet resolves ready() to its local address alone', async () => {
  const { ready } = webApp({ singleInstance: true }, {}, () => written([{ stream: 'stdout', text: '127.0.0.1:62021\n' }], false))

  expect(await (await ready()).ready()).toEqual({ url: 'http://127.0.0.1:62021' })
})

test('a web app with a copy per session throws at mod.use, because the tailnet reaches one copy per computer', async () => {
  const { tested } = webApp({}, {}, () => written([], false))

  await expect(tested.start()).rejects.toThrow('demo: the web app preview-server runs a copy per session, and your tailnet reaches one copy per computer. Add singleInstance: true or isService: true.')
})

function exitedCleanly(): HookStream<ProcessSpawnChunk, ProcessSpawnResult> {
  async function* read(): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
    yield* []
    return { code: 0, signal: null }
  }
  return Object.assign(read(), { result: Promise.resolve<ProcessSpawnResult>({ code: 0, signal: null }) }) as HookStream<ProcessSpawnChunk, ProcessSpawnResult>
}

const recordedService = (program: string) => ({
  [`/test/home/.local/share/cmod/services/demo/${program}.json`]: `${JSON.stringify({ label: `com.claudemodmanager.demo.${program}`, unit: `/test/home/Library/LaunchAgents/com.claudemodmanager.demo.${program}.plist` })}\n`,
})

const cmodProgram = '/test/home/.local/share/cmod/programs/cmod'

test("a mod whose new version adds no isService program runs cmod program --remove-service at its start for the service the cmod store records, so the old program stops", async () => {
  const spawned: (readonly string[])[] = []
  const tested = testMod(defineMod({ name: 'demo', setup() {} }), { files: recordedService('preview-server') })
  tested.fakes.process.spawn = (request) => {
    spawned.push(request.argv)
    return exitedCleanly()
  }

  await tested.start()
  await tested.settle()

  expect(spawned).toEqual([[cmodProgram, 'program', 'demo', '--remove-service', '--', 'preview-server']])
  expect(tested.shown.toasts.filter(({ type }) => type === 'error')).toEqual([])
})

test('a mod whose new version still adds its isService program keeps that service at its start, and removes only the service of the program it renamed', async () => {
  const spawned: (readonly string[])[] = []
  const tested = testMod(
    defineMod({
      name: 'demo',
      setup(mod) {
        mod.use(program({ command: ['preview-server', '--port', '0'], isService: true }))
      },
    }),
    { files: { ...heldCopy, ...recordedService('preview-server'), ...recordedService('old-server') } },
  )
  tested.fakes.clock.now = async () => 14_999
  tested.fakes.process.spawn = (request) => {
    spawned.push(request.argv)
    return request.argv.includes('--service') ? written([{ stream: 'stdout', text: 'held\n' }], true) : exitedCleanly()
  }

  await tested.start()
  await tested.settle()

  expect(spawned.toSorted()).toEqual([
    [cmodProgram, 'program', 'demo', '--remove-service', '--', 'old-server'],
    [cmodProgram, 'program', 'demo', '--service', '--', 'preview-server', '--port', '0'],
  ])
})

test('a session on a copy other than the one set up follows the running service, and neither writes nor removes a service', async () => {
  const spawned: (readonly string[])[] = []
  const installed = { name: 'demo', version: '0.8.2', root: '/test/plugins/demo-0.8.2', installedAt: '2026-11-13T09:01:33.793Z', scriptsSha256: 'sha', uninstall: null, program: 'preview-server', keys: {}, permissions: [], grantedOnUpdate: [], installedBy: null }
  const tested = testMod(
    defineMod({
      name: 'demo',
      setup(mod) {
        mod.use(program({ command: ['preview-server', '--port', '0'], isService: true }))
      },
    }),
    { files: { ...heldCopy, ...recordedService('preview-server'), ...recordedService('old-server'), '/test/home/.local/share/cmod/records/demo.json': JSON.stringify(installed) } },
  )
  tested.fakes.clock.now = async () => 14_999
  tested.fakes.process.spawn = (request) => {
    spawned.push(request.argv)
    return exitedCleanly()
  }

  await tested.start()
  await tested.settle()

  expect(spawned).toEqual([])
})

test("every copy of the cmod plugin counts as the installed copy, even when a cmod setup recorded another, because Claude Code loads one cmod of the several marketplaces that list it, and its copy writes cmod serve's service, while another mod's copy the record does not name does not", async () => {
  const recordOf = (name: string) => ({ [`/test/home/.local/share/cmod/records/${name}.json`]: JSON.stringify({ name, version: '8.2.0', root: '/test/plugins/cache/anyhost/cmod/8.2.0', installedAt: '2026-11-21T10:02:49.000Z', scriptsSha256: 'sha', uninstall: null, program: null, keys: {}, permissions: [], grantedOnUpdate: [], installedBy: null }) })
  const copyOf = async (name: string) => {
    let engine: ReturnType<typeof engineOf> | undefined
    const tested = testMod(defineMod({ name, setup: (mod) => void (engine = engineOf(mod)) }), { files: recordOf(name) })
    await tested.start()
    return (engine as ReturnType<typeof engineOf>).isInstalledCopy()
  }

  expect(await copyOf('cmod')).toBe(true)
  expect(await copyOf('demo')).toBe(false)
})

test('a mod with no services folder in the cmod store spawns no cmod process at its start', async () => {
  const spawned: (readonly string[])[] = []
  const tested = testMod(defineMod({ name: 'demo', setup() {} }))
  tested.fakes.process.spawn = (request) => {
    spawned.push(request.argv)
    return exitedCleanly()
  }

  await tested.start()
  await tested.settle()

  expect(spawned).toEqual([])
})

test('two singleInstance programs with one executable in a mod throw at mod.use', async () => {
  const tested = testMod(
    defineMod({
      name: 'demo',
      setup(mod) {
        mod.use(program({ command: ['preview-server', '--port', '0'], singleInstance: true }))
        mod.use(program({ command: ['preview-server', '--port', '1'], singleInstance: true }))
      },
    }),
  )
  tested.fakes.process.spawn = () => written([{ stream: 'stdout', text: 'unix:/tmp/x.sock\n' }], false)

  await expect(tested.start()).rejects.toThrow('demo: the single instance of preview-server is already added. Give each singleInstance program its own executable.')
})
