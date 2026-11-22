import { afterAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { connectRpc, type RpcClient } from '@cmodjs/core/src/runtime/rpc.js'
import { cmod, deleteTemporaryHomes, startCmod, temporaryHome } from './cmod.js'

const clients: RpcClient[] = []

afterAll(async () => {
  for (const client of clients.splice(0)) await client.close()
  await deleteTemporaryHomes()
})

type Answers = Readonly<Record<string, (...args: readonly unknown[]) => unknown>>

const runsDrawing = { $cmodElement: 'Button', props: { key: 'demo/runs:rerun', label: 'Run again', onPress: { $cmodHandler: 3 } } }

async function served(home: string) {
  const serving = startCmod(home, 'serve')
  expect(await serving.firstLine()).toBe(`unix:${join(home, '.local/share/cmod/serve.sock')}`)
  return serving
}

async function servedSession(answers: Answers) {
  const home = await temporaryHome()
  let serving = await served(home)
  const socket = join(home, '.local/share/cmod/serve.sock')
  const asked: unknown[][] = []
  const session = connectRpc({
    call: async (path, init) => {
      const answer = await fetch(`http://localhost${path}`, { method: init.method, ...(init.body === undefined ? {} : { body: init.body, headers: { 'content-type': 'application/json' } }), unix: socket } as RequestInit)
      return { status: answer.status, text: await answer.text() }
    },
    handle: async (method, params) => {
      if (method !== '$/ui') throw new Error(`The fake session answers no ${method}.`)
      const { method: called, args } = params as { readonly method: string; readonly args: readonly unknown[] }
      asked.push([called, ...args])
      return answers[called]?.(...args) ?? null
    },
    wait: () => new Promise<void>(() => undefined),
  })
  clients.push(session)
  await session.request('$/hold', { session: 'worker', project: home, cwd: home })
  return {
    home,
    asked,
    tell: (event: 'Change' | 'Redraw' | 'Open' | 'Close', payload: object) => session.notify('$/uiEvent', { event, payload }),
    restart: async () => {
      serving.child.kill()
      await serving.done
      serving = await served(home)
    },
    stop: () => serving.child.kill(),
  }
}

const followed = async (home: string, ...args: string[]) => {
  const { exitCode, stdout, stderr } = await cmod(home, 'ui', 'follow', ...args)
  if (exitCode !== 0) throw new Error(stderr)
  return JSON.parse(stdout) as { readonly cursor: string; readonly events: readonly object[]; readonly missed: boolean }
}

test.concurrent("cmod ui lists a session's views, draws one, presses its handler, and opens it, through cmod serve and the session's cmod plugin", async () => {
  const { home, asked, stop } = await servedSession({ views: () => [{ mod: 'demo', id: 'runs', title: 'Runs' }], draw: () => runsDrawing })

  const listed = await cmod(home, 'ui', 'list', 'views', 'worker')
  const drawn = await cmod(home, 'ui', 'draw', 'worker', 'demo', 'runs', '--columns', '40', '--surface', 'herdr')
  const widget = await cmod(home, 'ui', 'draw', 'worker', 'demo', 'branch', '--surface', 'herdr', '--area', 'belowPrompt')
  const pressed = await cmod(home, 'ui', 'press', 'worker', '3', '{"surface":"herdr","key":"demo/runs:rerun"}')
  const opened = await cmod(home, 'ui', 'open', 'worker', 'demo', 'runs')
  stop()

  expect(listed).toEqual({ exitCode: 0, stdout: '[{"mod":"demo","id":"runs","title":"Runs"}]\n', stderr: '' })
  expect(JSON.parse(drawn.stdout)).toEqual(runsDrawing)
  expect([widget.exitCode, pressed, opened]).toEqual([
    0,
    { exitCode: 0, stdout: 'null\n', stderr: '' },
    { exitCode: 0, stdout: 'null\n', stderr: '' },
  ])
  expect(asked).toEqual([
    ['views', 'worker'],
    ['draw', 'worker', { mod: 'demo', id: 'runs' }, { columns: 40, surface: 'herdr' }],
    ['draw', 'worker', { mod: 'demo', id: 'branch' }, { columns: 80, surface: 'herdr', area: 'belowPrompt' }],
    ['press', 'worker', 3, { surface: 'herdr', key: 'demo/runs:rerun' }],
    ['open', 'worker', { mod: 'demo', id: 'runs' }],
  ])
}, 30_000)

test.concurrent("cmod ui show tells the session the parts a client shows, tells nothing on a renewal of the same parts, and tells the empty list when the client clears them", async () => {
  const { home, asked, stop } = await servedSession({})

  const shown = await cmod(home, 'ui', 'show', 'worker', 'herdr-dock', 'demo/runs', 'cmod/dashboard')
  const renewed = await cmod(home, 'ui', 'show', 'worker', 'herdr-dock', 'cmod/dashboard', 'demo/runs')
  const cleared = await cmod(home, 'ui', 'show', 'worker', 'herdr-dock')
  const malformed = await cmod(home, 'ui', 'show', 'worker', 'herdr-dock', 'runs')
  stop()

  expect([shown, renewed, cleared]).toEqual([
    { exitCode: 0, stdout: 'null\n', stderr: '' },
    { exitCode: 0, stdout: 'null\n', stderr: '' },
    { exitCode: 0, stdout: 'null\n', stderr: '' },
  ])
  expect(malformed).toEqual({ exitCode: 1, stdout: '', stderr: 'cmod ui: cmod ui show takes each part as <mod>/<id>, such as demo/runs, not runs.\n' })
  expect(asked).toEqual([
    ['shown', 'worker', [{ mod: 'cmod', id: 'dashboard' }, { mod: 'demo', id: 'runs' }], false],
    ['shown', 'worker', [], false],
  ])
}, 30_000)

test.concurrent('cmod ui refuses a session no cmod plugin on this computer holds, a surface no app is, and an area no widget shows in', async () => {
  const { home, stop } = await servedSession({})

  const unheld = await cmod(home, 'ui', 'list', 'views', 'gone')
  const surface = await cmod(home, 'ui', 'draw', 'worker', 'demo', 'runs', '--surface', 'kiosk')
  const area = await cmod(home, 'ui', 'draw', 'worker', 'demo', 'branch', '--area', 'BelowPrompt')
  stop()

  expect(unheld).toEqual({ exitCode: 1, stdout: '', stderr: 'cmod ui: No session gone runs on this computer, so it shows no UI.\n' })
  expect(surface).toEqual({ exitCode: 1, stdout: '', stderr: 'cmod ui: --surface takes terminal, desktop, mobile, vscode, browser, herdr, not kiosk.\n' })
  expect(area).toEqual({ exitCode: 1, stdout: '', stderr: 'cmod ui: --area takes abovePrompt, belowPrompt, working, turnEnd, dashboard, not BelowPrompt.\n' })
}, 30_000)

test.concurrent('cmod ui draws for every surface an app is', async () => {
  const { home, asked, stop } = await servedSession({ draw: () => runsDrawing })
  const every = ['terminal', 'desktop', 'mobile', 'vscode', 'browser', 'herdr']

  const drawn = []
  for (const surface of every) drawn.push((await cmod(home, 'ui', 'draw', 'worker', 'demo', 'runs', '--surface', surface)).exitCode)
  stop()

  expect(drawn).toEqual([0, 0, 0, 0, 0, 0])
  expect(asked.map((call) => (call[3] as { readonly surface: string }).surface)).toEqual(every)
}, 30_000)

test.concurrent('cmod ui follow prints the Redraw, Change, Open, and Close events after its cursor, waits for the next one, and counts every earlier one as missed on its first run', async () => {
  const { home, tell, stop } = await servedSession({})

  const first = await followed(home)
  tell('Redraw', { mod: 'demo', id: 'runs' })
  const replayed = await followed(home, '--after', first.cursor)
  const next = followed(home, '--after', replayed.cursor)
  tell('Change', { part: 'views' })
  const told = await next
  tell('Open', { mod: 'demo', id: 'log' })
  tell('Close', { mod: 'demo', id: 'log' })
  const opened = await followed(home, '--after', told.cursor)
  stop()

  expect([first.events, first.missed]).toEqual([[], true])
  expect([replayed.events, replayed.missed]).toEqual([[{ event: 'Redraw', session: 'worker', mod: 'demo', id: 'runs' }], false])
  expect([told.events, told.missed]).toEqual([[{ event: 'Change', session: 'worker', part: 'views' }], false])
  expect(told.cursor.split(':').slice(1)).toEqual(['4', '1', '0', '0'])
  expect(opened.events).toEqual([
    { event: 'Open', session: 'worker', mod: 'demo', id: 'log' },
    { event: 'Close', session: 'worker', mod: 'demo', id: 'log' },
  ])
  expect([opened.missed, opened.cursor.split(':').slice(1)]).toEqual([false, ['4', '1', '1', '1']])
}, 30_000)

test.concurrent('cmod ui follow counts the events as missed once cmod serve started again since its cursor', async () => {
  const { home, tell, restart, stop } = await servedSession({})
  tell('Redraw', { mod: 'demo', id: 'runs' })
  const before = await followed(home)

  await restart()
  const after = await followed(home, '--after', before.cursor)
  stop()

  expect([after.events, after.missed]).toEqual([[], true])
}, 30_000)

async function appConnection(home: string) {
  const { url, token } = JSON.parse(await Bun.file(join(home, '.local/share/cmod/serve.json')).text()) as { readonly url: string; readonly token: string }
  const socket = new WebSocket(`${url}?token=${token}`)
  const answers = new Map<number, (message: { readonly result?: unknown; readonly error?: { readonly message: string } }) => void>()
  const heard: unknown[] = []
  let nextHeard: () => void = () => undefined
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { readonly id?: number; readonly method?: string; readonly params?: { readonly payload?: unknown }; readonly result?: unknown; readonly error?: { readonly message: string } }
    if (message.method === '$/on') {
      heard.push(message.params?.payload)
      nextHeard()
    } else if (message.id !== undefined) answers.get(message.id)?.(message)
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', reject)
  })
  let id = 0
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      id += 1
      answers.set(id, (message) => (message.error === undefined ? resolve(message.result) : reject(new Error(message.error.message))))
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  return { socket, request, heard, nextChange: () => new Promise<void>((resolve) => (nextHeard = resolve)) }
}

test.concurrent("an app reaches cmod/UI over the WebSocket serve.json names, with the token it gives, as cmod ui does over serve.sock", async () => {
  const { home, asked, stop } = await servedSession({ views: () => [{ mod: 'demo', id: 'runs', title: 'Runs' }], draw: () => runsDrawing })
  const app = await appConnection(home)

  const listed = await app.request('cmod/UI.views', ['worker'])
  const drawn = await app.request('cmod/UI.draw', ['worker', { mod: 'demo', id: 'runs' }, { columns: 40, surface: 'herdr' }])
  const pressed = await app.request('cmod/UI.press', ['worker', 3, { surface: 'herdr', key: 'demo/runs:rerun' }])
  const refused = await fetch(JSON.parse(await Bun.file(join(home, '.local/share/cmod/serve.json')).text()).url.replace('ws:', 'http:'), { headers: { upgrade: 'websocket', connection: 'upgrade' } })
  app.socket.close()
  stop()

  expect([listed, drawn, pressed]).toEqual([[{ mod: 'demo', id: 'runs', title: 'Runs' }], runsDrawing, null])
  expect(asked.at(-1)).toEqual(['press', 'worker', 3, { surface: 'herdr', key: 'demo/runs:rerun' }])
  expect(refused.status).toBe(401)
}, 30_000)

test.concurrent("an app hears Change for a session's widgets, views, and pages when its cmod plugin holds the session again, as after /reload-plugins", async () => {
  const { home, stop } = await servedSession({})
  const app = await appConnection(home)
  await app.request('$/listen', { id: 'ui Change', interface: 'cmod/UI', event: 'Change', kind: 'on' })
  const socket = join(home, '.local/share/cmod/serve.sock')
  const reloaded = connectRpc({
    call: async (path, init) => {
      const answer = await fetch(`http://localhost${path}`, { method: init.method, ...(init.body === undefined ? {} : { body: init.body, headers: { 'content-type': 'application/json' } }), unix: socket } as RequestInit)
      return { status: answer.status, text: await answer.text() }
    },
    handle: async () => null,
    wait: () => new Promise<void>(() => undefined),
  })
  clients.push(reloaded)

  const told = app.nextChange()
  await reloaded.request('$/hold', { session: 'worker', project: home, cwd: home })
  await told
  while (app.heard.length < 3) await app.nextChange()
  app.socket.close()
  stop()

  expect(app.heard).toEqual([
    { session: 'worker', part: 'widgets' },
    { session: 'worker', part: 'views' },
    { session: 'worker', part: 'pages' },
  ])
}, 30_000)
