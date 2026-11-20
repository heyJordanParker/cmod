import { afterAll, expect, test } from 'bun:test'
import { defineMod, type HttpResponse, type Subprocess, type View } from '../node_modules/@cmodjs/core/mod.js'
import { claudeCodeOf } from '../node_modules/@cmodjs/core/testing/claude-code.js'
import { calledAnswer } from '../node_modules/@cmodjs/core/testing/fake-claude.js'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { Box, Button, Input, Text } from '../node_modules/@cmodjs/core/ui/elements.js'
import { cmodPlugin } from '../src/mod.js'

const allHotkeys = Object.keys(cmodPlugin.hotkeys ?? {})

type Spawned = { readonly stdout: AsyncIterable<Uint8Array>; kill(): void }

type Fetched = { readonly ok: boolean; readonly status: number; readonly body: AsyncIterable<Uint8Array> | null; text(): Promise<string> }

type Screen = { readonly draw: number; readonly html: string }

declare const Bun: {
  sleep(ms: number): Promise<void>
  spawn(argv: readonly string[], options: { readonly env: Record<string, string>; readonly stdout: 'pipe'; readonly stderr: 'inherit' }): Spawned
  write(path: string, text: string): Promise<number>
  file(path: string): { text(): Promise<string> }
  readonly env: Record<string, string | undefined>
}

declare const process: { readonly pid: number }

declare const fetch: (url: string, init?: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string; readonly signal?: AbortSignal; readonly unix?: string }) => Promise<Fetched>

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
  throw new Error('cmod serve printed no address.')
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

function screensOf(body: AsyncIterable<Uint8Array>): (text: string) => Promise<Screen> {
  const seen: Screen[] = []
  const chunks: Uint8Array[] = []
  void (async () => {
    for await (const chunk of body) {
      chunks.push(chunk)
      const blocks = joined(chunks).split('\n\n').slice(0, -1)
      seen.length = 0
      for (const block of blocks) {
        const data = /^data: (.*)$/m.exec(block)?.[1]
        if (block.includes('event: screen') && data !== undefined) seen.push(JSON.parse(data) as Screen)
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

const promptRow = (cwd: string, uuid: string, text: string, timestamp: string) => `${JSON.stringify({ type: 'user', uuid, sessionId: 'test-session', cwd, timestamp, message: { role: 'user', content: text } })}\n`

let totalsView: View | undefined

const demo = defineMod({
  name: 'demo',
  state: { session: { presses: 0, name: '', surfaces: [] as string[] } },
  setup(mod) {
    const detail = mod.pages.add({ id: 'detail', title: 'Detail', render: () => Text({ children: 'The detail of the count' }) })
    totalsView = mod.views.add({ id: 'totals', title: 'Totals', render: (current) => Text({ children: `The totals: ${current.state.session.presses}` }) })
    mod.views.add({
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
            Button({ key: 'detail', label: 'Show the detail', onPress: () => void detail.open() }),
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
  await Bun.write(`${home}/.local/share/cmod/preferences.json`, JSON.stringify({ servesWebUi: true, servesTailnet: false }))
  const cwd = `${home}/work/app`
  await Bun.write(`${home}/.claude/sessions/1.json`, JSON.stringify({ pid: process.pid, sessionId: 'test-session', cwd, kind: 'interactive', entrypoint: 'cli', name: 'counting' }))
  const transcript = `${home}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/test-session.jsonl`
  const firstPrompt = promptRow(cwd, 'u1', 'Count the presses', '2026-11-20T10:00:00.000Z')
  await Bun.write(transcript, firstPrompt)
  const server = Bun.spawn(['bun', `${clone}/cli/src/main.ts`, 'serve'], { env: { HOME: home, PATH: Bun.env['PATH'] ?? '' }, stdout: 'pipe', stderr: 'inherit' })
  servers.push(server)
  const socket = (await firstLine(server.stdout)).replace(/^unix:/, '')
  let opened = ''
  void (async () => {
    while (opened === '') opened = await Bun.file(`${home}/.local/share/cmod/web.json`).text().catch(async (error: unknown) => (error instanceof Error && 'code' in error && error.code === 'ENOENT' ? (await Bun.sleep(50), '') : Promise.reject(error)))
  })()
  const address = `http://127.0.0.1:${(JSON.parse(await until(() => opened || undefined, () => 'cmod serve opened no browser app.')) as { readonly port: number }).port}`

  const counted = testMod(demo)
  await counted.start()
  const tested = testMod(cmodPlugin, { state: { global: { installedPlugins: ['cmod'], boundHotkeys: allHotkeys } }, files: { [`${store}/preferences.json`]: preferences } })
  tested.fakes.process.spawn = () => running('[]')
  tested.fakes.http.fetch = async (url, init): Promise<HttpResponse> => {
    const body = init?.body
    if (typeof body === 'object') throw new Error('cmod serve takes text bodies only.')
    const answer = await fetch(url, { method: init?.method ?? 'GET', headers: init?.headers ?? {}, ...(body === undefined ? {} : { body }), ...(init?.socketPath === undefined ? {} : { unix: socket }) })
    return { status: answer.status, ok: answer.ok, headers: {}, text: await answer.text() }
  }
  const waitingShown: { readonly isWanted: (inApps: readonly string[]) => boolean; readonly heard: () => void }[] = []
  const shownToDemo = (isWanted: (inApps: readonly string[]) => boolean) => new Promise<void>((heard) => void waitingShown.push({ isWanted, heard }))
  tested.fakes.cmod.call = async (input) => {
    if (input.to === 'demo') {
      const answer = calledAnswer('cmod', await counted.fire('cmod.call', { to: 'demo', method: input.method, input: input.input, caller: 'cmod' } as never))
      const told = input.method === 'cmod:shown' ? ((input.input as { readonly inApps?: readonly string[] }).inApps ?? []) : undefined
      for (const waiting of told === undefined ? [] : waitingShown.filter((each) => each.isWanted(told))) {
        waitingShown.splice(waitingShown.indexOf(waiting), 1)
        waiting.heard()
      }
      return answer
    }
    if (input.to === 'cmod') return calledAnswer('cmod', await tested.fire('cmod.call', { to: 'cmod', method: input.method, input: input.input, caller: 'cmod' } as never))
    return null
  }
  await tested.startSession({ source: 'startup' })
  await tested.fire('cmod.call', { to: 'cmod', method: 'cmod:partsChanged', input: { parts: { widgets: [], pages: [{ id: 'totals', title: 'Totals', place: 'sidebar' }, { id: 'count', title: 'Count', place: 'sidebar' }, { id: 'detail', title: 'Detail' }] }, requests: [{ open: 'count' }] }, caller: 'demo' } as never)
  await tested.settle()

  const browsing = new AbortController()
  const stream = await fetch(`${address}/api/stream?${new URLSearchParams({ stream: 'test-browser', columns: '160' })}`, { signal: browsing.signal })
  const showing = screensOf(stream.body ?? (async function* () {})())
  const press = (screen: Screen, key: string, attribute: string, input: { readonly kind: string; readonly value?: string }) => {
    const handler = new RegExp(`data-key="${key}"[^>]*?${attribute}="(\\d+)"`).exec(screen.html)?.[1]
    if (handler === undefined) throw new Error(`the screen draws no ${attribute} on ${key}:\n${screen.html}`)
    return fetch(`${address}/api/press`, { method: 'POST', headers: { origin: address, 'content-type': 'application/json' }, body: JSON.stringify({ stream: 'test-browser', handler: Number(handler), key, ...input }) })
  }
  const tab = async (key: string, text: string) => {
    const listed = await showing(`data-key="tab:${key}"`)
    await press(listed, `tab:${key}`, 'data-press', { kind: 'press' })
    return showing(text)
  }
  async function sidebar(): Promise<string> {
    await tested.settle()
    await tested.shown.pane.lines()
    await tested.settle()
    return (await tested.shown.pane.lines()).join('\n')
  }
  const leave = () => browsing.abort()
  function close(): void {
    leave()
    server.kill()
  }
  const prompted = (uuid: string, text: string, timestamp: string) => Bun.write(transcript, `${firstPrompt}${promptRow(cwd, uuid, text, timestamp)}`)
  return { tested, counted, showing, press, tab, sidebar, shownToDemo, prompted, leave, close }
}

test('the browser app lists the session with the status its cmod plugin tells cmod serve, and a turn the person stopped with Esc as stopped before it answered', async () => {
  const { tested, showing, close } = await browsed()
  const claudeCode = claudeCodeOf(tested)
  await claudeCode.fire('turn.start', { text: 'Run the suite', turnId: 'turn-1' })
  const working = await showing('Working 1')
  await claudeCode.fire('turn.complete', { answer: '', durationMs: 900, isAborted: true, reason: 'aborted', turnId: 'turn-1' } as never)
  const stopped = await showing('Stopped before it answered')
  close()

  expect(working.html).toContain('counting')
  expect(working.html).toContain('data-key="stop"')
  expect(stopped.html).toContain('Needs you 1')
}, 30_000)

test("a mod's view shows as a tab of its session in the browser app, drawn through cmod/UI as HTML, a press there runs the mod's onPress as a browser press, and the view redrawn on Redraw reaches the browser and the Sidebar", async () => {
  const { counted, showing, press, tab, sidebar, close } = await browsed()
  const before = await tab('demo/count', 'Pressed ')
  const pressed = await press(before, 'Press', 'data-press', { kind: 'press' })
  const after = await showing('Pressed 1 times')
  const lines = await sidebar()
  close()

  expect(before.html).toContain('<span class="t">Pressed 0 times</span>')
  expect(pressed.status).toBe(200)
  expect(counted.state.session.presses).toBe(1)
  expect(counted.state.session.surfaces).toEqual(['browser'])
  expect(after.html).toContain('<span class="t">Pressed 1 times</span>')
  expect(lines).toContain('Pressed 1 times')
}, 30_000)

test("text typed in a view's Input in the browser app reaches the mod's onInput, and the view it redraws reaches the browser and the Sidebar", async () => {
  const { counted, showing, press, tab, sidebar, close } = await browsed()
  const before = await tab('demo/count', 'Pressed ')
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

test('a mod that opens its own page from a press shows that page in the browser app, which follows the Open cmod/UI tells', async () => {
  const { showing, press, tab, close } = await browsed()
  const before = await tab('demo/count', 'Pressed ')
  await press(before, 'demo/count:detail', 'data-press', { kind: 'press' })
  const opened = await showing('The detail of the count')
  close()

  expect(before.html).toContain('data-key="page:demo/detail"')
  expect(opened.html).toContain('data-key="tab:demo/detail"')
  expect(opened.html).toContain('data-key="close:demo/detail"')
}, 30_000)

test("Stop in the browser app aborts the session's running turn, and a prompt typed there reaches Claude Code as the person's own prompt, both through cmod/Sessions", async () => {
  const { tested, showing, press, close } = await browsed()
  let isSubmitted: () => void = () => undefined
  const submitted = new Promise<void>((resolve) => (isSubmitted = resolve))
  tested.fakes.prompt.submit = async ({ text }) => {
    isSubmitted()
    return { text }
  }
  await claudeCodeOf(tested).fire('turn.start', { text: 'Run the suite', turnId: 'turn-7' })
  const working = await showing('data-key="stop"')
  await press(working, 'stop', 'data-press', { kind: 'press' })
  await press(working, 'prompt:test-session:0', 'data-submit', { kind: 'submit', value: 'Now run the whole suite' })
  await submitted
  close()

  expect(tested.calls.filter(({ call }) => call === 'turn.abort' || call === 'prompt.submit').map(({ call, args }) => [call, args[0]])).toEqual([
    ['turn.abort', { turnId: 'turn-7' }],
    ['prompt.submit', { text: 'Now run the whole suite', asUser: true }],
  ])
}, 30_000)

test("the cmod plugin's Dashboard, History, and Settings are views cmod/UI lists, and Settings draws in the browser app", async () => {
  const { tab, close } = await browsed()
  const settings = await tab('cmod/settings', 'Preferences')
  close()

  expect(settings.html).toContain('data-key="tab:cmod/dashboard"')
  expect(settings.html).toContain('data-key="tab:cmod/history"')
  expect(settings.html).toContain('Mods')
}, 30_000)

test("a mod's view only the browser app shows reads isShown true in the mod, and false once the browser's stream closes", async () => {
  const { tab, shownToDemo, leave, close } = await browsed()
  const before = totalsView?.isShown
  const shown = shownToDemo((ids) => ids.includes('totals'))
  await tab('demo/totals', 'The totals: 0')
  await shown
  const whileShown = totalsView?.isShown
  const hidden = shownToDemo((ids) => ids.length === 0)
  leave()
  await hidden
  close()

  expect([before, whileShown, totalsView?.isShown]).toEqual([false, true, false])
}, 30_000)

test("the cmod plugin's History, shown only in the browser app, refreshes on a new message of the session", async () => {
  const { tested, tab, showing, prompted, close } = await browsed()
  const before = await tab('cmod/history', 'data-key="cmod/history:history:find"')
  await prompted('u2', 'Ship the release', '2026-11-20T10:05:00.000Z')
  await claudeCodeOf(tested).fire('session.append', { uuid: 'u2', door: 'user', origin: { kind: 'composer' }, message: { type: 'user', content: [{ type: 'text', text: 'Ship the release' }] } } as never)
  const refreshed = await showing('Ship the release')
  close()

  expect(before.html).not.toContain('Ship the release')
  expect(refreshed.html).toContain('data-key="cmod/history:history:find"')
  expect(refreshed.html).toContain('Count the presses')
}, 30_000)
