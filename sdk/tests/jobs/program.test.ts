import { expect, test } from 'bun:test'
import type { HookStream, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult } from 'claude-code'
import { program, type Program } from '../../src/jobs/program.js'
import { defineMod } from '../../src/mod.js'
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

function preview(spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>) {
  let handle: Program | undefined
  const tested = testMod(
    defineMod({
      name: 'preview',
      setup(mod) {
        handle = mod.use(program({ command: ['preview-server', '--port', '0'] }))
      },
    }),
  )
  tested.fakes.process.spawn = spawn
  const ready = async (): Promise<Program> => {
    await tested.start()
    return handle as Program
  }
  return { tested, ready }
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 200; tick += 1) await Promise.resolve()
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
  expect(spawned).toEqual([{ argv: ['preview-server', '--port', '0'] }])
  expect(tested.shown.logs).toEqual(['preview added the preview-server program.'])
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

  await expect(started.ready()).rejects.toThrow('preview: the preview-server program stopped: its first line is "hello".')
  expect(started.state).toBe('fatal')
  expect(isClosed).toBe(true)
  expect(tested.shown.logs).toContain(
    'preview: the preview-server program stopped: its first line is "hello". Write 127.0.0.1:<port> or unix:<socket path> as the first line on standard output.',
  )
})

test('a program that exits restarts after 1, 2, 4, 8, and 16 s, then is fatal with its last standard error line', async () => {
  const delays: number[] = []
  let starts = 0
  const { tested, ready } = preview(() => {
    starts += 1
    return written([{ stream: 'stderr', text: `listen EADDRINUSE (start ${starts})\n` }], true)
  })
  tested.fakes.clock.after = (ms, fn) => {
    delays.push(ms)
    fn()
    return { cancel: () => undefined }
  }

  const started = await ready()
  const answer = started.ready()
  await settle()

  expect(delays).toEqual([1000, 2000, 4000, 8000, 16000])
  expect(starts).toBe(6)
  expect(started.state).toBe('fatal')
  await expect(answer).rejects.toThrow(
    'preview: the preview-server program stopped: it did not start again after 5 tries: listen EADDRINUSE (start 6). Fix it, then run /reload-plugins.',
  )
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
  await settle()

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
  await settle()
  expect(started.state).toBe('backoff')
  const answer = started.ready()
  pending.shift()?.()

  expect(await answer).toEqual({ url: 'http://localhost', socketPath: '/tmp/y.sock' })
})
