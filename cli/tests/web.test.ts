import { afterAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { readdirSync, readFileSync } from 'node:fs'
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { interfaceServer, listenMethod, unlistenMethod, type Heard, type SessionsChange } from '@cmodjs/core/src/runtime/interfaces.js'
import { connectRpc, rpcRoutes, type RpcClient } from '@cmodjs/core/src/runtime/rpc.js'
import { stoppedClock } from '@cmodjs/core/src/testing/fake-serve.js'
import { ifMissing } from '../src/files.js'
import { openIndex, runningFolder } from '../src/history.js'
import { answered as answeredRpc, serveSessions, type SessionServer } from '../src/serve.js'
import { webApp } from '../src/web.js'
import { cmodWith, deleteTemporaryHomes, serveChanges, spawningTestLimitMs, startCmodWith, temporaryHome, writeFiles } from './cmod.js'

setDefaultTimeout(spawningTestLimitMs)
const store = (home: string, file: string) => join(home, '.local/share/cmod', file)

const projectFolder = (project: string) => `.claude/projects/${project.replace(/[^A-Za-z0-9]/g, '-')}`

const lines = (rows: readonly object[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join('')

const at = (second: number) => `2026-11-04T10:00:${String(second).padStart(2, '0')}.000Z`

const children: { kill(): void }[] = []

const clients: RpcClient[] = []

afterAll(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const child of children.splice(0)) child.kill()
  await deleteTemporaryHomes()
})

function answered(session: string, project: string, prompt: string, reply: string, isTurnOpen: boolean) {
  return lines([
    { type: 'user', uuid: `${session}-u`, sessionId: session, timestamp: at(0), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: prompt } },
    { type: 'assistant', uuid: `${session}-a`, sessionId: session, timestamp: at(2), cwd: project, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: reply }] } },
    ...(isTurnOpen ? [] : [{ type: 'system', subtype: 'turn_duration', uuid: `${session}-d`, sessionId: session, timestamp: at(3), cwd: project, durationMs: 3000 }]),
  ])
}

type Running = { readonly project: string; readonly prompt: string; readonly reply: string; readonly entrypoint?: string; readonly name?: string; readonly status?: string; readonly waitingFor?: string; readonly isTurnOpen?: boolean }

const registryEntry = (home: string, session: string, { project, entrypoint, name, status, waitingFor }: Running) =>
  JSON.stringify({ pid: process.pid, sessionId: session, cwd: join(home, project), kind: 'interactive', entrypoint: entrypoint ?? 'cli', ...(name === undefined ? {} : { name, nameSource: 'derived' }), ...(status === undefined ? {} : { status }), ...(waitingFor === undefined ? {} : { waitingFor }) })

async function homeWith(sessions: Record<string, Running>): Promise<string> {
  const home = await temporaryHome()
  const files: Record<string, string> = { '.local/share/cmod/preferences.json': JSON.stringify({ servesWebUi: true }) }
  for (const [index, [session, running]] of Object.entries(sessions).entries()) {
    const folder = join(home, running.project)
    files[`${projectFolder(folder)}/${session}.jsonl`] = answered(session, folder, running.prompt, running.reply, running.isTurnOpen === true)
    files[`.claude/sessions/${index + 1}.json`] = registryEntry(home, session, running)
  }
  await writeFiles(home, files)
  return home
}

const isListening = (url: string) => fetch(url).then(
  () => true,
  (error: unknown) => (error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED' ? false : Promise.reject(error)),
)

async function pageOf(home: string, isOther: (port: number) => boolean = () => true) {
  for (let waited = 0; waited < 15_000; waited += 50) {
    const saved = await readFile(store(home, 'web.json'), 'utf8').then((text) => (JSON.parse(text) as { readonly port: number }).port, ifMissing(undefined))
    if (saved !== undefined && isOther(saved) && (await isListening(`http://127.0.0.1:${saved}/`))) return saved
    await Bun.sleep(50)
  }
  throw new Error('cmod serve never served the browser app.')
}

async function served(home: string, { env = {}, args = ['serve'], isOther }: { readonly env?: Record<string, string>; readonly args?: readonly string[]; readonly isOther?: (port: number) => boolean } = {}) {
  const serving = startCmodWith(home, env, ...args)
  children.push(serving.child)
  await serving.waitForOutput('unix:')
  const port = await pageOf(home, isOther)
  const base = `http://127.0.0.1:${port}`
  const socket = store(home, 'serve.sock')
  const session = (path: string, body?: object) => fetch(`http://localhost${path}`, { unix: socket, ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  const hold = async (id: string, project: string, act: (action: string, input: unknown) => void = () => undefined, ui: Readonly<Record<string, unknown>> = {}) => {
    const plugin = connectRpc({
      call: async (path, init) => {
        const answer = await fetch(`http://localhost${path}`, { unix: socket, method: init.method, ...(init.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: init.body }) })
        return { status: answer.status, text: await answer.text() }
      },
      handle: async (method, params) => {
        const asked = (params as { readonly method?: string }).method ?? ''
        if (method === '$/ui' && asked in ui) return ui[asked]
        if (method !== '$/act') throw new Error(`The fake cmod plugin answers no ${method}.`)
        const { action, input } = params as { readonly action: string; readonly input: unknown }
        act(action, input)
        return null
      },
      clock: stoppedClock,
    })
    clients.push(plugin)
    await plugin.request('$/hold', { session: id, project: join(home, project), cwd: join(home, project) })
    return { tell: (status: object) => plugin.notify('$/status', { session: id, ...status }), uiEvent: (event: string, payload: object) => plugin.request('$/uiEvent', { event, payload }) }
  }
  const replied = async (id: string, project: string, reply: string) => (await hold(id, project)).tell({ status: 'idle', lastTurn: { reason: 'answered', at: at(3), reply } })
  return { serving, port, base, session, hold, replied }
}

async function browsed(base: string) {
  const screens: { readonly draw: number; readonly html: string }[] = []
  const shown = new Set<() => void>()
  const browsing = new AbortController()
  const stream = 'test-browser'
  const answer = await fetch(`${base}/api/stream?${new URLSearchParams({ stream, columns: '160' })}`, { signal: browsing.signal })
  void (async () => {
    let text = ''
    for await (const chunk of answer.body ?? []) {
      text += new TextDecoder().decode(chunk)
      const blocks = text.split('\n\n')
      text = blocks.pop() ?? ''
      for (const block of blocks) {
        const data = /^data: (.*)$/m.exec(block)?.[1]
        if (block.includes('event: screen') && data !== undefined) screens.push(JSON.parse(data) as (typeof screens)[number])
      }
      for (const each of shown) each()
    }
  })().catch((error: unknown) => {
    if (!(error instanceof Error && error.name === 'AbortError')) throw error
  })
  const showing = (...texts: readonly string[]) =>
    new Promise<(typeof screens)[number]>((resolve) => {
      const check = () => {
        const last = screens.at(-1)
        if (last === undefined || !texts.every((text) => last.html.includes(text))) return
        shown.delete(check)
        resolve(last)
      }
      shown.add(check)
      check()
    })
  const press = async (screen: { readonly draw: number; readonly html: string }, key: string, attribute: string, input: Record<string, string> = {}) => {
    const handler = new RegExp(`data-key="${key}"[^>]*?${attribute}="(\\d+)"`).exec(screen.html)?.[1]
    if (handler === undefined) throw new Error(`the screen draws no ${attribute} on ${key}:\n${screen.html}`)
    return fetch(`${base}/api/press`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ stream, handler: Number(handler), key, ...input }) })
  }
  return { screens, showing, press, close: () => browsing.abort() }
}

test.concurrent("loading / shows the browser app at once, with no sign-in, and the page refuses another host, a change from another page or none, and a session's call", async () => {
  const home = await homeWith({})
  const { base, port, serving } = await served(home)
  const page = await fetch(`${base}/`)
  const policy = page.headers.get('content-security-policy') ?? ''
  const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1]
  const html = await page.text()
  const change = (path: string, headers: Record<string, string>) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })

  expect(page.status).toBe(200)
  expect(policy).toContain("frame-ancestors 'none'")
  expect(html).toContain(`<script nonce="${nonce}">`)
  expect(html).not.toContain('/api/tokens')
  expect(html).not.toContain('localStorage')
  expect((await fetch(`${base}/`, { headers: { host: 'evil.example' } })).status).toBe(421)
  expect((await fetch(`${base}/`, { headers: { host: `localhost:${port}` } })).status).toBe(200)
  expect((await change('/api/press', { origin: 'http://evil.example' })).status).toBe(403)
  expect((await change('/api/press', {})).status).toBe(403)
  expect((await change('/rpc/connect', { origin: base })).status).toBe(403)
  expect((await change('/api/press', { origin: base })).status).toBe(410)
  serving.child.kill()
})

test.concurrent('the browser app answers you through your tailnet, by the Tailscale login of the request, and nobody else there', async () => {
  const home = await homeWith({})
  const { base, port, serving } = await served(home, { env: { CMOD_TAILNET_NAME: 'computer.example.ts.net', CMOD_TAILNET_LOGIN: 'person@example.com' } })
  const tailnet = 'computer.example.ts.net:62021'
  const through = (path: string, login: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { host: tailnet, 'tailscale-user-login': login, ...(init.headers as Record<string, string>) } })
  const change = (path: string, login: string, origin: string) => through(path, login, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })

  expect((await through('/', 'person@example.com')).status).toBe(200)
  expect((await through('/', 'someone@example.com')).status).toBe(421)
  expect((await fetch(`${base}/`, { headers: { host: tailnet } })).status).toBe(421)
  expect((await change('/api/press', 'person@example.com', `https://${tailnet}`)).status).toBe(410)
  expect((await change('/api/press', 'person@example.com', `http://${tailnet}`)).status).toBe(403)
  expect((await change('/rpc/connect', 'person@example.com', `https://${tailnet}`)).status).toBe(403)
  for (let waited = 0; !(await readFile(store(home, 'tailnet/cmod/cmod.json'), 'utf8').catch(ifMissing('')).then((text) => text.includes('https://'))) && waited < 15_000; waited += 50) await Bun.sleep(50)
  expect((await cmodWith(home, { BROWSER: 'true' }, 'web')).stdout).toBe(`${base}/\nFrom your other devices: https://computer.example.ts.net:${port}/\n`)
  serving.child.kill()
})

test.concurrent('the browser app lists a running session of every project, with its project folder and its reply, and leaves out an sdk-cli process', async () => {
  const home = await homeWith({
    s1: { project: 'work/app', prompt: 'Fix the login test', reply: 'The login test passes now.', name: 'app-1' },
    s2: { project: 'work/site', prompt: 'Rename the deploy job', reply: 'Renamed it to publish.', name: 'site-2' },
    s3: { project: 'work/site', prompt: 'Summarize the logs', reply: 'Nothing failed.', entrypoint: 'sdk-cli', name: 'site-3' },
  })
  const { base, serving, replied } = await served(home)
  await replied('s1', 'work/app', 'The login test passes now.')
  await replied('s2', 'work/site', 'Renamed it to publish.')
  const browser = await browsed(base)
  const screen = await browser.showing('site-2', 'Replied 2', 'app-1', '>app  </span>', '>site  </span>', 'Renamed it to publish.')
  browser.close()
  serving.child.kill()

  expect(screen.html).toContain('Replied 2')
  expect(screen.html).toContain('app-1')
  expect(screen.html).toContain('>app  </span>')
  expect(screen.html).toContain('>site  </span>')
  expect(screen.html).toContain('Renamed it to publish.')
  expect(screen.html).not.toContain('site-3')
  expect(screen.html).not.toContain('Nothing failed.')
})

test.concurrent('a running session no cmod plugin holds shows as Replied with the reply line the conversation index read from its transcript', async () => {
  const home = await homeWith({ s1: { project: 'work/app', prompt: 'Fix the login test', reply: 'The login test passes now.', name: 'app-1' } })
  const { base, serving } = await served(home)
  const browser = await browsed(base)
  const screen = await browser.showing('Replied 1', 'app-1', 'The login test passes now.</span>')
  browser.close()
  serving.child.kill()

  expect(screen.html).toContain('Replied 1')
  expect(screen.html).toContain('The login test passes now.</span>')
})

test.concurrent("a session's row and header carry the name Claude Code gives it, never its first prompt", async () => {
  const home = await homeWith({ s1: { project: 'work/app', prompt: 'Fix the login test', reply: 'The login test passes now.', name: 'app-3f' } })
  const { base, serving, replied } = await served(home)
  await replied('s1', 'work/app', 'The login test passes now.')
  const browser = await browsed(base)
  const screen = await browser.showing('Replied 1', '<span class="t" style="font-weight:700">app-3f</span>', '<span class="t size-heading">app-3f</span>', 'placeholder="Reply to app-3f"')
  browser.close()
  serving.child.kill()

  expect(screen.html).toContain('<span class="t" style="font-weight:700">app-3f</span>')
  expect(screen.html).toContain('<span class="t size-heading">app-3f</span>')
  expect(screen.html).toContain('placeholder="Reply to app-3f"')
  expect(screen.html).not.toContain('>Fix the login test</span>')
})

test.concurrent("a permission wait the session's cmod plugin tells cmod serve puts it in Needs you with the tool and its command, and the open session says to answer it in its terminal", async () => {
  const home = await homeWith({ s1: { project: 'work/app', prompt: 'Run the suite', reply: 'Running it.', isTurnOpen: true } })
  const { base, serving, hold } = await served(home)
  const plugin = await hold('s1', 'work/app')
  plugin.tell({ status: 'waiting', waitingFor: { dialog: 'permission prompt', tool: 'Bash', input: { command: 'bun test' } }, openCall: { tool: 'Bash', summary: 'bun test' } })
  const browser = await browsed(base)
  const screen = await browser.showing('Needs you 1', 'Wants to run Bash: bun test</span>', 'Wants to run Bash: bun test. Answer it in the session&#39;s terminal.', 'data-key="stop"')
  browser.close()
  serving.child.kill()

  expect(screen.html).toContain('Wants to run Bash: bun test</span>')
  expect(screen.html).toContain('Wants to run Bash: bun test. Answer it in the session&#39;s terminal.')
  expect(screen.html).toContain('data-key="stop"')
})

test.concurrent('a session moves to Needs you once Claude Code records it waits on a permission prompt or a question, before its cmod plugin names the tool', async () => {
  const running = { project: 'work/app', prompt: 'Run the suite', reply: 'Running it.' }
  const home = await homeWith({ s1: running, s2: { project: 'work/site', prompt: 'Pick a color', reply: 'Asking.', status: 'waiting', waitingFor: 'input needed' } })
  const { base, serving } = await served(home)
  const browser = await browsed(base)
  const asked = await browser.showing('Needs you 1', 'Asks you a question</span>')
  await writeFiles(home, { '.claude/sessions/1.json': registryEntry(home, 's1', { ...running, status: 'waiting', waitingFor: 'permission prompt' }) })
  const both = await browser.showing('Needs you 2', 'Wants permission to run a tool</span>')
  browser.close()
  serving.child.kill()

  expect(asked.html).toContain('Asks you a question</span>')
  expect(both.html).toContain('Wants permission to run a tool</span>')
})

test.concurrent("cmod serve follows Claude Code's session records with one watcher, and a record that changes to waiting reaches the browser as a cmod/Sessions Change", async () => {
  const running = { project: 'work/app', prompt: 'Run the suite', reply: 'Running it.', isTurnOpen: true }
  const home = await homeWith({ s1: { ...running, status: 'busy' } })
  const before = { CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'], XDG_DATA_HOME: process.env['XDG_DATA_HOME'] }
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_DATA_HOME: join(home, '.local/share') })
  const watching = spyOn(fs, 'watch')
  const index = openIndex()
  const reported: string[] = []
  const sessions = serveSessions({ index, report: (doing) => void reported.push(doing) })
  const web = webApp({ sessions })
  const heard: SessionsChange[] = []
  const listener = sessions.interfaces.handler({ request: () => Promise.reject(new Error('The test answers no request.')), notify: (_method, params) => void heard.push((params as Heard).payload as SessionsChange) })
  try {
    await listener(listenMethod, { id: 'test', interface: 'cmod/Sessions', event: 'Change', kind: 'on' }, AbortSignal.timeout(5000))
    const browser = await browsed(`http://127.0.0.1:${web.listen(0)}`)
    const working = await browser.showing('claude-opus-5-5', 'Working 1')
    await writeFiles(home, { 'tmp/1.json': registryEntry(home, 's1', { ...running, status: 'waiting', waitingFor: 'permission prompt' }) })
    await rename(join(home, 'tmp/1.json'), join(home, '.claude/sessions/1.json'))
    const waiting = await browser.showing('Needs you 1', 'Wants permission to run a tool</span>')
    browser.close()

    expect(working.html).toContain('Working 1')
    expect(working.html).not.toContain('Needs you')
    expect(waiting.html).toContain('Wants permission to run a tool</span>')
    expect(heard).toContainEqual({ session: 's1', part: 'status' })
    expect(watching.mock.calls.filter(([path]) => path === runningFolder())).toHaveLength(1)
    expect(reported).toEqual([])
  } finally {
    await web.stop()
    sessions.close()
    await index.close()
    watching.mockRestore()
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test.concurrent("a turn stopped while its command keeps running says so on its row and in its header, because Claude Code moved the command to the session's background", async () => {
  const home = await homeWith({ s1: { project: 'work/app', prompt: 'Ping the host', reply: 'Pinging.', status: 'shell' } })
  const { base, serving, hold } = await served(home)
  const plugin = await hold('s1', 'work/app')
  plugin.tell({ status: 'idle', lastTurn: { reason: 'stopped', at: at(9) } })
  const browser = await browsed(base)
  const screen = await browser.showing('Needs you 1', 'Stopped, and a command still runs in its terminal</span>', 'app · claude-opus-5-5 · Stopped, and a command still runs in its terminal</span>')
  browser.close()
  serving.child.kill()

  expect(screen.html).toContain('Stopped, and a command still runs in its terminal</span>')
  expect(screen.html).toContain('app · claude-opus-5-5 · Stopped, and a command still runs in its terminal</span>')
})

test.concurrent("a prompt typed in a session's prompt box reaches that session's cmod plugin as cmod/Sessions send of the person's prompt, and Stop reaches it as cmod/Sessions abort", async () => {
  const home = await homeWith({ s1: { project: 'work/app', prompt: 'Fix the login test', reply: 'The login test passes now.' } })
  const { base, serving, hold } = await served(home)
  const acted: { readonly action: string; readonly input: unknown }[] = []
  const reached: (() => void)[] = []
  const next = () => new Promise<void>((resolve) => void reached.push(resolve))
  const plugin = await hold('s1', 'work/app', (action, input) => {
    acted.push({ action, input })
    reached.shift()?.()
  })
  const browser = await browsed(base)
  const opened = await browser.showing('data-key="prompt:s1:0"')
  const prompted = next()
  const typed = await browser.press(opened, 'prompt:s1:0', 'data-submit', { kind: 'submit', value: 'Now run the whole suite' })
  await prompted
  plugin.tell({ status: 'busy' })
  const working = await browser.showing('Working 1', 'data-key="prompt:s1:1"')
  const stopped = next()
  await browser.press(working, 'stop', 'data-press', { kind: 'press' })
  await stopped
  browser.close()
  serving.child.kill()

  expect(typed.status).toBe(200)
  expect(working.html).toContain('data-key="prompt:s1:1"')
  expect(acted).toEqual([
    { action: 'send', input: { type: 'prompt', text: 'Now run the whole suite', as: 'person' } },
    { action: 'abort', input: {} },
  ])
})

test.concurrent("a page a mod opens in a session while no browser page is open shows as that session's tab once a browser page opens", async () => {
  const home = await homeWith({ s1: { project: 'work/app', prompt: 'Fix the login test', reply: 'The login test passes now.' } })
  const { base, serving, hold } = await served(home)
  const plugin = await hold('s1', 'work/app', undefined, { views: [], pages: [{ mod: 'demo', id: 'runs', title: 'Runs' }] })
  await plugin.uiEvent('Open', { mod: 'demo', id: 'runs' })

  const browser = await browsed(base)
  const screen = await browser.showing('Runs')
  browser.close()
  serving.child.kill()

  expect(screen.html).toContain('data-key="close:demo/runs"')
  expect(screen.html).not.toContain('data-key="page:demo/runs"')
})

test.concurrent("cmod serve deletes the before listeners an older cmod plugin kept for each session that ended, and keeps a running session's", async () => {
  const home = await homeWith({ s1: { project: 'work/app', prompt: 'Fix the login test', reply: 'The login test passes now.' } })
  await writeFiles(home, { '.local/share/cmod/data/cmod/before/s1.json': '[{"mod":"demo"}]', '.local/share/cmod/data/cmod/before/s9.json': '[]' })
  const { serving } = await served(home)
  serving.child.kill()

  expect(readdirSync(store(home, 'data/cmod/before'))).toEqual(['s1.json'])
})

type RemoteStatus = { readonly status: string; readonly isRunning?: boolean; readonly openCall?: { readonly tool: string; readonly summary: string }; readonly lastTurn?: { readonly reason: string; readonly at: string; readonly reply: string } }

type RemoteMessage = { readonly id: string; readonly session: string; readonly type: string; readonly at: string; readonly context: number; readonly turn: string; readonly text: string }

const otherInstance = '.local/share/cmod/instances/demo/sessions-server.json'

function anotherStore(home: string, ids: readonly string[] = ['r1'], { answersSession = true }: { readonly answersSession?: boolean } = {}) {
  const sent: unknown[] = []
  const received: (readonly [string, unknown])[] = []
  const waiting = new Set<() => void>()
  const messages = new Map<string, RemoteMessage[]>(ids.map((id) => [id, [{ id: `${id}-a`, session: id, type: 'reply', at: at(2), context: 1, turn: `${id}-u`, text: `Deployed it on build box ${id}.` }]]))
  const statuses = new Map<string, RemoteStatus>(ids.map((id, index) => [id, index === 0 ? { status: 'idle', lastTurn: { reason: 'answered', at: at(3), reply: `Deployed it on build box ${id}.` } } : { status: 'idle' }]))
  const summary = (id: string) => ({ id, title: `build-box-${id.slice(1)}`, project: '/srv/app', cwd: '/srv/app', model: 'claude-opus-5-5', startedAt: at(0), lastAt: at(3), isRunning: true, device: { id: '9c41d07e2b5a4f86a3e1c8d2f07b6e95', name: 'build-box' }, ...statuses.get(id) })
  const changed = (session: string, part: string) => server.emit('cmod/Sessions', 'Change', { session, part }, [session])
  const server = interfaceServer({
    implementations: {
      'cmod/Sessions': {
        sessions: ({ running }: { readonly running?: boolean } = {}) => ids.map(summary).filter((each) => running !== true || each.isRunning),
        ...(answersSession ? { session: (id: string) => summary(id) } : {}),
        read: (id: string, part: string, options: { readonly after?: string } = {}) => {
          if (part !== 'messages') return []
          const all = messages.get(id) ?? []
          return all.slice(options.after === undefined ? 0 : all.findIndex((message) => message.id === options.after) + 1)
        },
        send: (session: string, input: unknown) => {
          sent.push(['send', session, input])
          statuses.set(session, { status: 'busy' })
          changed(session, 'status')
        },
        abort: (session: string) => void sent.push(['abort', session]),
      },
    },
  })
  const socket = join(home, 'store.sock')
  const routes = rpcRoutes({
    handle: (connection) => {
      const handle = server.handler(connection)
      return async (method, params, signal) => {
        received.push([method, params])
        try {
          return await handle(method, params, signal)
        } finally {
          for (const each of waiting) each()
        }
      }
    },
    onClose: (connection) => server.closed(connection),
    now: () => Date.now(),
  })
  const http = Bun.serve({ unix: socket, fetch: (request) => answeredRpc(routes, request) ?? new Response('', { status: 404 }) })
  children.push({ kill: () => void (routes.close(), http.stop(true)) })
  const reply = (session: string, text: string) => {
    const kept = messages.get(session) ?? []
    kept.push({ id: `${session}-a${kept.length}`, session, type: 'reply', at: at(3 + kept.length), context: 1, turn: `${session}-u`, text })
    changed(session, 'messages')
  }
  const tell = (session: string, status: RemoteStatus) => {
    statuses.set(session, status)
    changed(session, 'status')
  }
  const end = (session: string) => {
    statuses.set(session, { status: 'idle', isRunning: false })
    changed(session, 'running')
  }
  const when = (isDone: () => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (!isDone()) return
        waiting.delete(check)
        resolve()
      }
      waiting.add(check)
      check()
    })
  const count = (method: string) => received.filter(([each]) => each === method).length
  const listening = (session?: string) => {
    const held = new Map<string, unknown>()
    for (const [method, params] of received) {
      const { id, args } = params as { readonly id: string; readonly args?: readonly unknown[] }
      if (method === listenMethod) held.set(id, args?.[0])
      if (method === unlistenMethod) held.delete(id)
    }
    return [...held.values()].filter((each) => session === undefined || each === session).length
  }
  return { sent, received, reply, tell, end, when, count, listening, instance: JSON.stringify({ address: `unix:${socket}`, pid: process.pid, started: at(0), provides: ['cmod/Sessions'] }) }
}

test.concurrent("a new reply in another provider's session reaches the browser once that provider tells its cmod/Sessions Change, with no look on a timer", async () => {
  const home = await homeWith({})
  const other = anotherStore(home)
  await writeFiles(home, { [otherInstance]: other.instance })
  const { base, serving } = await served(home)
  const browser = await browsed(base)
  await browser.showing('build-box-1', 'Deployed it on build box r1.')

  other.reply('r1', 'Rolled it back on the build box.')
  const replied = await browser.showing('Rolled it back on the build box.')
  browser.close()
  serving.child.kill()

  expect(replied.html).toContain('Rolled it back on the build box.')
})

test.concurrent('with no page open, the browser app sends another sessions provider nothing, before the first page opens and after the last one closes', async () => {
  const home = await homeWith({})
  const other = anotherStore(home)
  await writeFiles(home, { [otherInstance]: other.instance })
  const { base, serving } = await served(home)
  const beforeAnyPage = [...other.received]
  const browser = await browsed(base)
  await other.when(() => other.count(listenMethod) > 0)
  browser.close()
  await other.when(() => other.listening() === 0)
  serving.child.kill()

  expect(beforeAnyPage).toEqual([])
  expect(other.listening()).toBe(0)
})

test.concurrent("with the list open, a status Change of another provider's session reads only that session, and its row shows the tool call it runs", async () => {
  const home = await homeWith({})
  const other = anotherStore(home)
  await writeFiles(home, { [otherInstance]: other.instance })
  const { base, serving } = await served(home)
  const browser = await browsed(base)
  await browser.showing('build-box-1')
  await other.when(() => other.listening('r1') === 1 && other.count('cmod/Sessions.read') === 1)
  const from = other.received.length

  other.tell('r1', { status: 'busy', openCall: { tool: 'Bash', summary: 'bun run deploy' } })
  const working = await browser.showing('Working 1', 'Bash: bun run deploy</span>')
  browser.close()
  serving.child.kill()

  expect(working.html).toContain('Bash: bun run deploy</span>')
  expect(other.received.slice(from)).toEqual([['cmod/Sessions.session', ['r1']]])
})

test.concurrent("a status Change of a session on a device whose cmod is older than 8.8.0, which answers no cmod/Sessions.session, reads its sessions list, and its row shows the tool call it runs", async () => {
  const home = await homeWith({})
  const other = anotherStore(home, ['r1'], { answersSession: false })
  await writeFiles(home, { [otherInstance]: other.instance })
  const { base, serving } = await served(home)
  const browser = await browsed(base)
  await browser.showing('build-box-1')
  await other.when(() => other.listening('r1') === 1 && other.count('cmod/Sessions.read') === 1)

  other.tell('r1', { status: 'busy', openCall: { tool: 'Bash', summary: 'bun run deploy' } })
  const working = await browser.showing('Working 1', 'Bash: bun run deploy</span>')
  browser.close()
  serving.child.kill()

  expect(working.html).toContain('build-box-1')
})

test.concurrent("a burst of status Changes of another provider's session reads that session at most twice, and its row ends on the last status told", async () => {
  const home = await homeWith({})
  const other = anotherStore(home)
  await writeFiles(home, { [otherInstance]: other.instance })
  const { base, serving } = await served(home)
  const browser = await browsed(base)
  await browser.showing('build-box-1')
  await other.when(() => other.listening('r1') === 1 && other.count('cmod/Sessions.read') === 1)
  const before = other.count('cmod/Sessions.session')

  for (const step of [1, 2, 3, 4, 5]) other.tell('r1', { status: 'busy', openCall: { tool: 'Bash', summary: `bun run step-${step}` } })
  const last = await browser.showing('Bash: bun run step-5</span>')
  browser.close()
  serving.child.kill()

  expect(last.html).toContain('Bash: bun run step-5</span>')
  expect(other.count('cmod/Sessions.session') - before).toBeLessThanOrEqual(2)
})

test.concurrent("a running Change of another provider's session the list holds reads only that session, and drops its row once it no longer runs", async () => {
  const home = await homeWith({})
  const other = anotherStore(home, ['r1', 'r2'])
  await writeFiles(home, { [otherInstance]: other.instance })
  const { base, serving } = await served(home)
  const browser = await browsed(base)
  await browser.showing('build-box-1', 'Replied 1', 'Idle 1')
  await other.when(() => other.count('cmod/Sessions.read') === 1)
  const from = other.received.length

  other.end('r1')
  const dropped = await browser.showing('build-box-2')
  browser.close()
  serving.child.kill()

  expect(dropped.html).not.toContain('build-box-1')
  expect(other.received.slice(from).filter(([method]) => method === 'cmod/Sessions.session' || method === 'cmod/Sessions.sessions')).toEqual([['cmod/Sessions.session', ['r1']]])
})

test.concurrent("a page showing another provider's session reads only the messages after the last it holds, and another session's write there reads nothing", async () => {
  const home = await homeWith({})
  const other = anotherStore(home, ['r1', 'r2'])
  await writeFiles(home, { [otherInstance]: other.instance })
  const { base, serving } = await served(home)
  const browser = await browsed(base)
  await browser.showing('build-box-1', 'Idle 1', 'Deployed it on build box r1.')
  await other.when(() => other.listening('r1') === 1 && other.count('cmod/Sessions.read') === 1)
  const from = other.received.length

  other.reply('r2', 'Cleaned the cache on build box r2.')
  other.reply('r1', 'Rolled it back on build box r1.')
  const replied = await browser.showing('Rolled it back on build box r1.')
  browser.close()
  serving.child.kill()

  expect(replied.html).not.toContain('Cleaned the cache')
  expect(other.received.slice(from)).toEqual([['cmod/Sessions.read', ['r1', 'messages', { project: '/srv/app', after: 'r1-a', last: 80 }]]])
})

test.concurrent("a page opened again on another provider's session reads its last messages, never every message since the page closed", async () => {
  const home = await homeWith({})
  const other = anotherStore(home)
  await writeFiles(home, { [otherInstance]: other.instance })
  const { base, serving } = await served(home)
  const first = await browsed(base)
  await first.showing('build-box-1', 'Deployed it on build box r1.')
  await other.when(() => other.count('cmod/Sessions.read') === 1)
  first.close()
  await other.when(() => other.listening() === 0)
  other.reply('r1', 'Rolled it back on build box r1.')
  const from = other.received.length

  const again = await browsed(base)
  const reopened = await again.showing('Rolled it back on build box r1.')
  again.close()
  serving.child.kill()

  expect(reopened.html).toContain('Deployed it on build box r1.')
  expect(other.received.slice(from).filter(([method]) => method === 'cmod/Sessions.read')).toEqual([['cmod/Sessions.read', ['r1', 'messages', { project: '/srv/app', last: 80 }]]])
})

test.concurrent("a page opened again lists no session of another provider that ended while no page was open, from its first screen on", async () => {
  const home = await homeWith({})
  const other = anotherStore(home, ['r1', 'r2'])
  await writeFiles(home, { [otherInstance]: other.instance })
  const { base, serving } = await served(home)
  const first = await browsed(base)
  await first.showing('build-box-1', 'Replied 1', 'Idle 1')
  first.close()
  await other.when(() => other.listening() === 0)
  other.end('r1')

  const again = await browsed(base)
  const listed = await again.showing('build-box-2')
  again.close()
  serving.child.kill()

  expect(again.screens[0]?.html).not.toContain('build-box-1')
  expect(listed.html).not.toContain('build-box-1')
})

test.concurrent('closing the last page removes every listener the browser app holds on another sessions provider', async () => {
  const home = await homeWith({})
  const other = anotherStore(home)
  await writeFiles(home, { [otherInstance]: other.instance })
  const { base, serving } = await served(home)
  const browser = await browsed(base)
  await browser.showing('build-box-1')
  await other.when(() => other.listening() === 2)

  browser.close()
  await other.when(() => other.listening() === 0)
  serving.child.kill()

  expect(other.count(unlistenMethod)).toBe(2)
})

test.concurrent("the browser app lists the running sessions of every other sessions provider beside this computer's, and a prompt or Stop there reaches that provider's session", async () => {
  const home = await homeWith({ s1: { project: 'work/app', prompt: 'Fix the login test', reply: 'The login test passes now.', name: 'app-1' } })
  const other = anotherStore(home)
  await writeFiles(home, { [otherInstance]: other.instance })
  const { base, serving } = await served(home)
  const browser = await browsed(base)
  const listed = await browser.showing('app-1', 'build-box-1', 'Deployed it on build box r1.')
  await browser.press(listed, 'row:r1', 'data-press', { kind: 'press' })
  const opened = await browser.showing('data-key="prompt:r1:0"')
  await browser.press(opened, 'prompt:r1:0', 'data-submit', { kind: 'submit', value: 'Roll it back' })
  await other.when(() => other.sent.length === 1)
  await browser.press(await browser.showing('data-key="stop"'), 'stop', 'data-press', { kind: 'press' })
  await other.when(() => other.sent.length === 2)
  browser.close()
  serving.child.kill()

  expect(listed.html).toContain('app-1')
  expect(listed.html).toContain('Deployed it on build box r1.')
  expect(other.sent).toEqual([
    ['send', 'r1', { type: 'prompt', text: 'Roll it back', as: 'person' }],
    ['abort', 'r1'],
  ])
})

test.concurrent('opening a replied session marks it visited, done and unread move it, and the visit outlives a restart of cmod serve', async () => {
  const home = await homeWith({ s1: { project: 'work/app', prompt: 'Fix the login test', reply: 'The login test passes now.' } })
  const first = await served(home)
  await first.replied('s1', 'work/app', 'The login test passes now.')
  const browser = await browsed(first.base)
  const replied = await browser.showing('Replied 1')
  await browser.press(replied, 'row:s1', 'data-press', { kind: 'press' })
  const read = await browser.showing('Idle 1')
  await browser.press(read, 'unread', 'data-press', { kind: 'press' })
  const unread = await browser.showing('Replied 1')
  await browser.press(unread, 'done', 'data-press', { kind: 'press' })
  await browser.showing('Idle 1')
  browser.close()
  first.serving.child.kill()
  await first.serving.done
  const again = await served(home)
  await again.replied('s1', 'work/app', 'The login test passes now.')
  const restarted = await browsed(again.base)
  const after = await restarted.showing('Idle 1')
  restarted.close()
  again.serving.child.kill()

  expect(Object.keys(JSON.parse(readFileSync(store(home, 'visited.json'), 'utf8')) as object)).toEqual(['s1'])
  expect(after.html).not.toContain('Replied')
})

test.concurrent('visits pressed back to back reach the file in the order pressed, and cmod serve stopped at once still writes the last', async () => {
  const home = await homeWith({ s1: { project: 'work/app', prompt: 'Fix the login test', reply: 'The login test passes now.' } })
  const first = await served(home)
  await first.replied('s1', 'work/app', 'The login test passes now.')
  const browser = await browsed(first.base)
  const replied = await browser.showing('Replied 1')
  await browser.press(replied, 'row:s1', 'data-press', { kind: 'press' })
  const read = await browser.showing('Idle 1')
  const unread = await browser.press(read, 'unread', 'data-press', { kind: 'press' })
  const done = await browser.press(replied, 'done', 'data-press', { kind: 'press' })
  browser.close()
  first.serving.child.kill()
  await first.serving.done

  expect([unread.status, done.status]).toEqual([200, 200])
  expect(Date.parse((JSON.parse(readFileSync(store(home, 'visited.json'), 'utf8')) as { s1: string }).s1)).toBeGreaterThan(Date.parse(at(3)))
})

test.concurrent("a 7.0.0 cmod plugin's post about its session is answered as taken, and its poll stays open 8 seconds, under the 10-second idle timeout Bun keeps on a unix socket, and answers that no browser wants anything, so that session warns of nothing until it reloads", async () => {
  const { serving, session } = await served(await homeWith({}))
  const posted = await session('/api/sessions/one', { about: { tabs: [], pages: [], isWorking: false } })
  const postedAnswer = await posted.json()
  const startedAt = Date.now()
  const polled = await session('/api/sessions/one/events')

  expect([posted.status, postedAnswer]).toEqual([200, {}])
  expect([polled.status, await polled.json()]).toEqual([200, { views: [], actions: [] }])
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(7900)
  serving.child.kill()
})

test.concurrent('cmod serve serves the browser app on another port when the one in web.json is taken', async () => {
  const taken = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const home = await homeWith({})
  await writeFiles(home, { '.local/share/cmod/web.json': JSON.stringify({ port: taken.port }) })
  const { port, serving } = await served(home, { isOther: (saved) => saved !== taken.port })

  expect(port).not.toBe(taken.port)
  serving.child.kill()
  await taken.stop(true)
})

test.concurrent('cmod serve keeps the page port in web.json, closes the page once cmod/Store tells that the person turned the browser app off, and opens it on that port again once it tells it is on, while cmod web serve runs the same server', async () => {
  const home = await homeWith({})
  const { serving, port } = await served(home, { args: ['web', 'serve'] })
  const isAnswered = () => isListening(`http://127.0.0.1:${port}/`)

  const serve = serveChanges(home)
  expect(Object.keys(JSON.parse(await readFile(store(home, 'web.json'), 'utf8')) as object)).toEqual(['port'])
  await writeFiles(home, { '.local/share/cmod/preferences.json': JSON.stringify({ servesWebUi: false }) })
  await serve.tell('cmod/Store', 'changed', ['preferences'])
  await serving.waitForOutput('cmod serve: closed the browser app')
  expect(await isAnswered()).toBe(false)
  await writeFiles(home, { '.local/share/cmod/preferences.json': JSON.stringify({ servesWebUi: true }) })
  await serve.tell('cmod/Store', 'changed', ['preferences'])

  expect(await pageOf(home)).toBe(port)
  serving.child.kill()
})

test.concurrent('cmod web prints the address, opens it in the browser, and says how to turn the browser app on when it does not run', async () => {
  const home = await homeWith({})
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  await writeFiles(home, { [`bin/${opener}`]: '#!/bin/sh\necho "$1" > "$HOME/opened"\n', '.local/share/cmod/preferences.json': JSON.stringify({ servesWebUi: false }) })
  const before = await cmodWith(home, {}, 'web')
  await writeFiles(home, { '.local/share/cmod/preferences.json': JSON.stringify({ servesWebUi: true }) })
  const { port, serving } = await served(home)
  const opened = await cmodWith(home, { DISPLAY: ':0' }, 'web')
  const overSsh = await cmodWith(home, { SSH_CONNECTION: '10.0.0.2 52144 10.0.0.9 22' }, 'web')
  serving.child.kill()

  expect(before.exitCode).toBe(1)
  expect(before.stderr).toBe('cmod web: the browser app does not run now. Press open in browser on the Sidebar in Claude Code, which turns it on.\n')
  const address = `http://127.0.0.1:${port}/`
  expect([opened.exitCode, opened.stdout.split('\n')[0]]).toEqual([0, address])
  expect(readFileSync(join(home, 'opened'), 'utf8')).toBe(`${address}\n`)
  expect([overSsh.exitCode, overSsh.stdout.split('\n')[0], overSsh.stderr]).toEqual([1, address, 'cmod web: this computer has no browser to open, so open the address above yourself.\n'])
})

test('a sessions provider whose first listener failed is followed again at the next cmod/Providers Change, and its row then shows the tool call it runs', async () => {
  const home = await homeWith({})
  const before = process.env['CLAUDE_CONFIG_DIR']
  process.env['CLAUDE_CONFIG_DIR'] = join(home, '.claude')
  const store = { mod: 'demo', program: 'sessions-server' }
  let status: object = { status: 'idle' }
  const summary = () => ({ id: 'r1', title: 'build-box-1', project: '/srv/app', cwd: '/srv/app', model: 'claude-opus-5-5', startedAt: at(0), lastAt: at(3), isRunning: true, ...status })
  const listedOn: object[] = []
  const relistened = Promise.withResolvers<(payload: unknown) => void>()
  const interfaces = interfaceServer({ implementations: { 'cmod/Sessions': { sessions: () => [] }, 'cmod/Providers': {}, 'cmod/UI': {} } })
  const sessions = {
    interfaces,
    providers: {
      list: () => Promise.resolve([store]),
      hear: (listening, provider, heard) => {
        if (listening.args !== undefined) return Promise.resolve({ remove: () => undefined })
        listedOn.push(provider)
        if (listedOn.length === 1) return Promise.reject(new Error('cmod serve reaches no device build-box'))
        relistened.resolve(heard)
        return Promise.resolve({ remove: () => undefined })
      },
      call: ({ method }) => Promise.resolve(method === 'messages' ? [] : method === 'session' ? summary() : [summary()]),
    },
    call: () => Promise.reject(new Error('The test takes no session action.')),
    visits: () => Promise.resolve({}),
  } satisfies Pick<SessionServer, 'interfaces' | 'providers' | 'call' | 'visits'>
  const web = webApp({ sessions })
  try {
    const browser = await browsed(`http://127.0.0.1:${web.listen(0)}`)
    await browser.showing('build-box-1')
    interfaces.emit('cmod/Providers', 'Change', { interface: 'cmod/Sessions' })
    const heard = await relistened.promise
    status = { status: 'busy', openCall: { tool: 'Bash', summary: 'bun run deploy' } }
    heard({ session: 'r1', part: 'status' })
    const working = await browser.showing('Working 1', 'Bash: bun run deploy</span>')
    browser.close()

    expect(working.html).toContain('Bash: bun run deploy</span>')
    expect(listedOn).toEqual([store, store])
  } finally {
    await web.stop()
    if (before === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = before
  }
})
