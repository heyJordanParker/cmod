import { afterAll, expect, test } from 'bun:test'
import { defineMod, type HttpResponse, type Subprocess } from '../node_modules/@cmodjs/core/mod.js'
import type { SessionAbout, SessionEvents } from '../node_modules/@cmodjs/core/runtime/web.js'
import { claudeCodeOf } from '../node_modules/@cmodjs/core/testing/claude-code.js'
import { calledAnswer } from '../node_modules/@cmodjs/core/testing/fake-claude.js'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { Box, Button, Input, Text } from '../node_modules/@cmodjs/core/ui/elements.js'
import { cmodPlugin } from '../src/mod.js'

type Spawned = { readonly stdout: AsyncIterable<Uint8Array>; kill(): void }

type Fetched = { readonly ok: boolean; readonly status: number; readonly body: AsyncIterable<Uint8Array> | null; text(): Promise<string> }

declare const Bun: {
  sleep(ms: number): Promise<void>
  spawn(argv: readonly string[], options: { readonly env: Record<string, string>; readonly stdout: 'pipe'; readonly stderr: 'inherit' }): Spawned
  write(path: string, text: string): Promise<number>
  readonly env: Record<string, string | undefined>
}

declare const process: { readonly pid: number }

declare const fetch: (url: string, init?: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string; readonly signal?: AbortSignal }) => Promise<Fetched>

const clone = (import.meta as unknown as { readonly dir: string }).dir.replace(/\/tests$/, '')

const store = '/test/home/.local/share/cmod'

const preferences = JSON.stringify({ servesWebUi: true })

const servers: Spawned[] = []

const homes: string[] = []

afterAll(() => {
  for (const each of servers) each.kill()
  Bun.spawn(['rm', '-rf', ...homes], { env: {}, stdout: 'pipe', stderr: 'inherit' })
})

function joined(chunks: readonly Uint8Array[]): string {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return new TextDecoder().decode(bytes)
}

async function firstLine(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
    const text = joined(chunks)
    if (text.includes('\n')) return text.slice(0, text.indexOf('\n'))
  }
  throw new Error('cmod web serve printed no address.')
}

function running(line: string): Subprocess {
  async function* read() {
    yield { stream: 'stdout' as const, text: `${line}\n` }
    return await new Promise<never>(() => undefined)
  }
  return Object.assign(read(), { result: new Promise<never>(() => undefined) })
}

async function until<Value>(found: () => Value | undefined, what: () => string): Promise<Value> {
  for (let waited = 0; waited < 15_000; waited += 50) {
    const value = found()
    if (value !== undefined) return value
    await Bun.sleep(50)
  }
  throw new Error(what())
}

function screensOf(body: AsyncIterable<Uint8Array>): (text: string) => Promise<{ readonly draw: number; readonly html: string }> {
  const seen: { readonly draw: number; readonly html: string }[] = []
  const chunks: Uint8Array[] = []
  void (async () => {
    for await (const chunk of body) {
      chunks.push(chunk)
      const blocks = joined(chunks).split('\n\n').slice(0, -1)
      seen.length = 0
      for (const block of blocks) {
        const data = /^data: (.*)$/m.exec(block)?.[1]
        if (block.includes('event: screen') && data !== undefined) seen.push(JSON.parse(data) as (typeof seen)[number])
      }
    }
  })().catch((error: unknown) => {
    if (!(error instanceof Error && error.name === 'AbortError')) throw error
  })
  return (text) =>
    until(
      () => {
        const last = seen.at(-1)
        return last?.html.includes(text) === true ? last : undefined
      },
      () => `the browser app never showed "${text}". It showed:\n${seen.at(-1)?.html ?? 'nothing'}`,
    )
}

const demo = defineMod({
  name: 'demo',
  state: { session: { presses: 0, name: '', surfaces: [] as string[] } },
  setup(mod) {
    mod.sidebar.add({
      id: 'count',
      title: 'Count',
      render: (current) =>
        Box({
          flexDirection: 'column',
          children: [
            Text({ children: `Pressed ${current.state.session.presses} times` }),
            Button({
              label: 'Press',
              onPress: (press) => {
                current.state.session.presses += 1
                current.state.session.surfaces = [...current.state.session.surfaces, press.surface]
              },
            }),
            Input({ key: 'name', label: 'Name', value: current.state.session.name, onInput: (name: string) => void (current.state.session.name = name), onSubmit: () => undefined }),
            Text({ children: `Hello ${current.state.session.name}` }),
          ],
        }),
    })
  },
})

async function browsed() {
  const home = `/tmp/cmod-web-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  homes.push(home)
  await Bun.write(`${home}/.local/share/cmod/preferences.json`, preferences)
  await Bun.write(`${home}/.claude/sessions/1.json`, JSON.stringify({ pid: process.pid, sessionId: 'test-session', cwd: `${home}/work/app`, kind: 'interactive', entrypoint: 'cli', name: 'counting' }))
  const server = Bun.spawn(['bun', `${clone}/cli/src/main.ts`, 'web', 'serve'], { env: { HOME: home, PATH: Bun.env['PATH'] ?? '' }, stdout: 'pipe', stderr: 'inherit' })
  servers.push(server)
  const address = `http://${await firstLine(server.stdout)}`

  const counted = testMod(demo)
  await counted.start()
  const tested = testMod(cmodPlugin, { state: { global: { installedPlugins: ['cmod'], areHotkeysBound: true } }, files: { [`${store}/preferences.json`]: preferences } })
  tested.fakes.process.spawn = ({ argv }) => (argv.includes('serve') ? running(address.replace('http://', '')) : running('[]'))
  tested.fakes.http.fetch = async (url, init): Promise<HttpResponse> => {
    const body = init?.body
    if (typeof body === 'object') throw new Error('cmod web serve takes text bodies only.')
    const answer = await fetch(url, { method: init?.method ?? 'GET', headers: init?.headers ?? {}, ...(body === undefined ? {} : { body }) })
    return { status: answer.status, ok: answer.ok, headers: {}, text: await answer.text() }
  }
  tested.fakes.cmod.call = async (input) => (input.to === 'demo' ? calledAnswer('cmod', await counted.fire('cmod.call', { to: 'demo', method: input.method, input: input.input, caller: 'cmod' } as never)) : null)
  await tested.start()
  await tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input: { parts: { widgets: [], pages: [{ id: 'count', title: 'Count', place: 'sidebar' }] }, requests: [{ open: 'count' }] }, caller: 'demo' } as never)
  await tested.settle()

  const browsing = new AbortController()
  const stream = await fetch(`${address}/api/stream?${new URLSearchParams({ stream: 'test-browser', columns: '160' })}`, { signal: browsing.signal })
  const showing = screensOf(stream.body ?? (async function* () {})())
  const press = (screen: { readonly draw: number; readonly html: string }, key: string, attribute: string, input: { readonly kind: string; readonly value?: string }) => {
    const handler = new RegExp(`data-key="${key}"[^>]*?${attribute}="(\\d+)"`).exec(screen.html)?.[1]
    return fetch(`${address}/api/press`, { method: 'POST', headers: { origin: address, 'content-type': 'application/json' }, body: JSON.stringify({ stream: 'test-browser', draw: screen.draw, handler: Number(handler), key, ...input }) })
  }
  const page = async () => {
    const listed = await showing('data-key="tab:demo/count"')
    await press(listed, 'tab:demo/count', 'data-press', { kind: 'press' })
    return showing('Pressed ')
  }
  async function sidebar(): Promise<string> {
    await tested.settle()
    await tested.shown.pane.lines()
    await tested.settle()
    return (await tested.shown.pane.lines()).join('\n')
  }
  function close(): void {
    browsing.abort()
    server.kill()
  }
  return { counted, showing, press, page, sidebar, close }
}

function sessionChannel() {
  const told: SessionAbout[] = []
  const queued: SessionEvents[] = []
  let deliver: ((events: SessionEvents) => void) | undefined
  const answered = (text: string): HttpResponse => ({ status: 200, ok: true, headers: {}, text })
  const fetched = async (_url: string, init?: { readonly method?: string; readonly body?: string }): Promise<HttpResponse> => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}') as { readonly about?: SessionAbout }
      if (body.about !== undefined) told.push(body.about)
      return answered('{}')
    }
    const next = queued.shift() ?? (await new Promise<SessionEvents>((resolve) => void (deliver = resolve)))
    return answered(JSON.stringify(next))
  }
  const send = (events: SessionEvents) => {
    if (deliver === undefined) return void queued.push(events)
    deliver(events)
    deliver = undefined
  }
  const about = (matches: (about: SessionAbout) => boolean) =>
    until(
      () => told.findLast(matches),
      () => `the session never told the browser app such an about. It told:\n${JSON.stringify(told)}`,
    )
  return { fetched, send, about }
}

async function poster() {
  const channel = sessionChannel()
  const tested = testMod(cmodPlugin, { state: { global: { installedPlugins: ['cmod'], areHotkeysBound: true } }, files: { [`${store}/preferences.json`]: preferences } })
  tested.fakes.process.spawn = ({ argv }) => (argv.includes('serve') ? running('127.0.0.1:4567') : running('[]'))
  tested.fakes.http.fetch = channel.fetched
  await tested.start()
  await tested.settle()
  return { tested, ...channel }
}

test('the session tells the browser app it works, what permission it waits on with the tool and its input, and that the person stopped its turn with Esc', async () => {
  const { tested, about } = await poster()
  const claudeCode = claudeCodeOf(tested)
  await claudeCode.fire('turn.start', { text: 'Run the suite', turnId: 'turn-1' })
  const working = await about((told) => told.isWorking === true)
  let allow: (result: unknown) => void = () => undefined
  const call = claudeCode.fire('tool.call', { tool: 'Bash', tool_use_id: 'call-1', command: 'bun test' } as never, new Promise((resolve) => void (allow = resolve)) as never)
  await claudeCode.fire('Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } as never)
  const waiting = await about((told) => told.waiting !== undefined)
  allow({ result: 'ok' })
  await call
  const allowed = await about((told) => told.waiting === undefined && told.isWorking === true && told !== working)
  await claudeCode.fire('turn.complete', { answer: '', durationMs: 900, isAborted: true, reason: 'aborted', turnId: 'turn-1' } as never)
  const stopped = await about((told) => told.lastTurn !== undefined)

  expect(working).toMatchObject({ tabs: [{ key: 'dashboard', label: 'Dashboard' }, { key: 'settings', label: 'Settings' }], isWorking: true })
  expect(waiting.waiting).toEqual({ kind: 'permission', tool: 'Bash', input: { command: 'bun test' } })
  expect(allowed.waiting).toBeUndefined()
  expect(stopped).toMatchObject({ isWorking: false, lastTurn: { reason: 'stopped' } })
  expect(stopped.waiting).toBeUndefined()
})

test('a prompt the browser app queues reaches Claude Code as the person own prompt, and its Stop aborts the running turn', async () => {
  const { tested, send } = await poster()
  await claudeCodeOf(tested).fire('turn.start', { text: 'Run the suite', turnId: 'turn-7' })
  send({ views: [], actions: [{ type: 'stop' }, { type: 'prompt', text: 'Now run the whole suite' }] })
  const calls = await until(
    () => {
      const made = tested.calls.filter((call) => call.call === 'turn.abort' || call.call === 'prompt.submit')
      return made.length === 2 ? made : undefined
    },
    () => `the session made no abort and submit. It made:\n${JSON.stringify(tested.calls.map((call) => call.call))}`,
  )

  expect(calls.map(({ call, args }) => [call, args[0]])).toEqual([
    ['turn.abort', { turnId: 'turn-7' }],
    ['prompt.submit', { text: 'Now run the whole suite', asUser: true }],
  ])
})

test("a mod's Sidebar page shows in a tab of its session in the browser app as HTML, a press there runs the mod's onPress as a desktop press, and the redrawn page reaches the browser and the Sidebar", async () => {
  const { counted, showing, press, page, sidebar, close } = await browsed()
  const before = await page()
  const pressed = await press(before, 'Press', 'data-press', { kind: 'press' })
  const after = await showing('Pressed 1 times')
  const lines = await sidebar()
  close()

  expect(before.html).toContain('<span class="t">Pressed 0 times</span>')
  expect(before.html).toContain('counting')
  expect(pressed.status).toBe(200)
  expect(counted.state.session.presses).toBe(1)
  expect(counted.state.session.surfaces).toEqual(['desktop'])
  expect(after.html).toContain('<span class="t">Pressed 1 times</span>')
  expect(lines).toContain('Pressed 1 times')
}, 30_000)

test("text typed in a page's Input in the browser app reaches the mod's onInput, and the page it redraws reaches the browser and the Sidebar", async () => {
  const { counted, showing, press, page, sidebar, close } = await browsed()
  const before = await page()
  const typed = await press(before, 'demo/count:name', 'data-input', { kind: 'change', value: 'Ada' })
  const after = await showing('Hello Ada')
  const lines = await sidebar()
  close()

  expect(before.html).toContain('<input type="text" class="input" data-key="demo/count:name" data-input=')
  expect(typed.status).toBe(200)
  expect(counted.state.session.name).toBe('Ada')
  expect(after.html).toContain('value="Ada"')
  expect(lines).toContain('Hello Ada')
}, 30_000)
