import { afterAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionEvents } from '@cmodjs/core/src/runtime/web.js'
import { cmodWith, deleteTemporaryHomes, startCmod, temporaryHome, writeFiles } from './cmod.js'

const store = (home: string, file: string) => join(home, '.local/share/cmod', file)

const projectFolder = (project: string) => `.claude/projects/${project.replace(/[^A-Za-z0-9]/g, '-')}`

const lines = (rows: readonly object[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join('')

const at = (second: number) => `2026-11-04T10:00:${String(second).padStart(2, '0')}.000Z`

const children: { kill(): void }[] = []

afterAll(async () => {
  for (const child of children.splice(0)) child.kill()
  await deleteTemporaryHomes()
})

function answered(session: string, project: string, prompt: string, reply: string) {
  return lines([
    { type: 'user', uuid: `${session}-u`, sessionId: session, timestamp: at(0), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: prompt } },
    { type: 'assistant', uuid: `${session}-a`, sessionId: session, timestamp: at(2), cwd: project, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: reply }] } },
    { type: 'system', subtype: 'turn_duration', uuid: `${session}-d`, sessionId: session, timestamp: at(3), cwd: project, durationMs: 3000 },
  ])
}

type Running = { readonly project: string; readonly prompt: string; readonly reply: string; readonly entrypoint?: string; readonly name?: string; readonly status?: string; readonly waitingFor?: string }

const registryEntry = (home: string, session: string, { project, entrypoint, name, status, waitingFor }: Running) =>
  JSON.stringify({ pid: process.pid, sessionId: session, cwd: join(home, project), kind: 'interactive', entrypoint: entrypoint ?? 'cli', ...(name === undefined ? {} : { name, nameSource: 'derived' }), ...(status === undefined ? {} : { status }), ...(waitingFor === undefined ? {} : { waitingFor }) })

async function homeWith(sessions: Record<string, Running>): Promise<string> {
  const home = await temporaryHome()
  const files: Record<string, string> = { '.local/share/cmod/preferences.json': JSON.stringify({ servesWebUi: true }) }
  for (const [index, [session, running]] of Object.entries(sessions).entries()) {
    const folder = join(home, running.project)
    files[`${projectFolder(folder)}/${session}.jsonl`] = answered(session, folder, running.prompt, running.reply)
    files[`.claude/sessions/${index + 1}.json`] = registryEntry(home, session, running)
  }
  await writeFiles(home, files)
  return home
}

async function served(home: string) {
  const serving = startCmod(home, 'web', 'serve')
  children.push(serving.child)
  await serving.waitForOutput('127.0.0.1:')
  const { port } = JSON.parse(await readFile(store(home, 'web.json'), 'utf8')) as { readonly port: number }
  const base = `http://127.0.0.1:${port}`
  return { serving, port, base }
}

async function browsed(base: string) {
  const screens: { readonly draw: number; readonly html: string }[] = []
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
    }
  })().catch((error: unknown) => {
    if (!(error instanceof Error && error.name === 'AbortError')) throw error
  })
  const showing = async (text: string) => {
    for (let waited = 0; waited < 15_000; waited += 50) {
      const found = screens.findLast((screen) => screen.html.includes(text))
      if (found !== undefined && found === screens.at(-1)) return found
      await Bun.sleep(50)
    }
    throw new Error(`the browser app never showed "${text}". It showed:\n${screens.at(-1)?.html ?? 'nothing'}`)
  }
  const press = async (screen: { readonly draw: number; readonly html: string }, key: string, attribute: string, input: Record<string, string> = {}) => {
    const handler = new RegExp(`data-key="${key}"[^>]*?${attribute}="(\\d+)"`).exec(screen.html)?.[1]
    if (handler === undefined) throw new Error(`the screen draws no ${attribute} on ${key}:\n${screen.html}`)
    return fetch(`${base}/api/press`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ stream, draw: screen.draw, handler: Number(handler), key, ...input }) })
  }
  return { showing, press, close: () => browsing.abort() }
}

test.concurrent('loading / shows the browser app at once, with no sign-in, and cmod web refuses another host and a change from another page or none', async () => {
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
  expect((await change('/api/sessions/s1', { origin: 'http://evil.example' })).status).toBe(403)
  expect((await change('/api/press', { origin: base })).status).toBe(410)
  serving.child.kill()
}, 30_000)

test.concurrent('the browser app lists a running session of every project, with its project folder and its reply, and leaves out an sdk-cli process', async () => {
  const home = await homeWith({
    s1: { project: 'work/app', prompt: 'Fix the login test', reply: 'The login test passes now.', name: 'app-1' },
    s2: { project: 'work/site', prompt: 'Rename the deploy job', reply: 'Renamed it to publish.', name: 'site-2' },
    s3: { project: 'work/site', prompt: 'Summarize the logs', reply: 'Nothing failed.', entrypoint: 'sdk-cli', name: 'site-3' },
  })
  const { base, serving } = await served(home)
  const browser = await browsed(base)
  const screen = await browser.showing('site-2')
  browser.close()
  serving.child.kill()

  expect(screen.html).toContain('Replied 2')
  expect(screen.html).toContain('app-1')
  expect(screen.html).toContain('>app  </span>')
  expect(screen.html).toContain('>site  </span>')
  expect(screen.html).toContain('Renamed it to publish.')
  expect(screen.html).not.toContain('site-3')
  expect(screen.html).not.toContain('Nothing failed.')
}, 30_000)

test.concurrent("a session's row and header carry the name Claude Code gives it, never its first prompt", async () => {
  const home = await homeWith({ s1: { project: 'work/app', prompt: 'Fix the login test', reply: 'The login test passes now.', name: 'app-3f' } })
  const { base, serving } = await served(home)
  const browser = await browsed(base)
  const screen = await browser.showing('Replied 1')
  browser.close()
  serving.child.kill()

  expect(screen.html).toContain('<span class="t" style="font-weight:700">app-3f</span>')
  expect(screen.html).toContain('<span class="t size-heading">app-3f</span>')
  expect(screen.html).toContain('placeholder="Reply to app-3f"')
  expect(screen.html).not.toContain('>Fix the login test</span>')
}, 30_000)

test.concurrent("a session's posted permission wait puts it in Needs you with the tool and its command, and the open session says to answer it in its terminal", async () => {
  const home = await homeWith({ s1: { project: 'work/app', prompt: 'Run the suite', reply: 'Running it.' } })
  const { base, serving } = await served(home)
  const about = { tabs: [], pages: [], isWorking: true, waiting: { kind: 'permission', tool: 'Bash', input: { command: 'bun test' } } }
  const posted = await fetch(`${base}/api/sessions/s1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ about }) })
  const browser = await browsed(base)
  const screen = await browser.showing('Needs you 1')
  browser.close()
  serving.child.kill()

  expect(posted.status).toBe(200)
  expect(screen.html).toContain('Wants to run Bash: bun test</span>')
  expect(screen.html).toContain('Wants to run Bash: bun test. Answer it in the session&#39;s terminal.')
  expect(screen.html).toContain('data-key="stop"')
}, 30_000)

test.concurrent('a session moves to Needs you once Claude Code records it waits on a permission prompt or a question, before its cmod plugin names the tool', async () => {
  const running = { project: 'work/app', prompt: 'Run the suite', reply: 'Running it.' }
  const home = await homeWith({ s1: running, s2: { project: 'work/site', prompt: 'Pick a color', reply: 'Asking.', status: 'waiting', waitingFor: 'input needed' } })
  const { base, serving } = await served(home)
  const browser = await browsed(base)
  const asked = await browser.showing('Needs you 1')
  await writeFiles(home, { '.claude/sessions/1.json': registryEntry(home, 's1', { ...running, status: 'waiting', waitingFor: 'permission prompt' }) })
  const both = await browser.showing('Needs you 2')
  browser.close()
  serving.child.kill()

  expect(asked.html).toContain('Asks you a question</span>')
  expect(both.html).toContain('Wants permission to run a tool</span>')
}, 30_000)

test.concurrent("a turn stopped while its command keeps running says so on its row and in its header, because Claude Code moved the command to the session's background", async () => {
  const home = await homeWith({ s1: { project: 'work/app', prompt: 'Ping the host', reply: 'Pinging.', status: 'shell' } })
  const { base, serving } = await served(home)
  await fetch(`${base}/api/sessions/s1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ about: { tabs: [], pages: [], isWorking: false, lastTurn: { reason: 'stopped', at: at(9) } } }) })
  const browser = await browsed(base)
  const screen = await browser.showing('Needs you 1')
  browser.close()
  serving.child.kill()

  expect(screen.html).toContain('Stopped, and a command still runs in its terminal</span>')
  expect(screen.html).toContain('app · claude-opus-5-5 · Stopped, and a command still runs in its terminal</span>')
}, 30_000)

test.concurrent("a prompt typed in a session's prompt box reaches that session's next poll as the person's prompt, and Stop reaches it as a stop", async () => {
  const home = await homeWith({ s1: { project: 'work/app', prompt: 'Fix the login test', reply: 'The login test passes now.' } })
  const { base, serving } = await served(home)
  const poll = () => fetch(`${base}/api/sessions/s1/events`).then(async (answer) => (await answer.json()) as SessionEvents)
  await fetch(`${base}/api/sessions/s1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ about: { tabs: [], pages: [], isWorking: false } }) })
  await poll()
  const next = poll()
  const browser = await browsed(base)
  const opened = await browser.showing('data-key="prompt:s1:0"')
  const typed = await browser.press(opened, 'prompt:s1:0', 'data-submit', { kind: 'submit', value: 'Now run the whole suite' })
  const prompted = await next
  await fetch(`${base}/api/sessions/s1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ about: { tabs: [], pages: [], isWorking: true } }) })
  const working = await browser.showing('Working 1')
  const stopped = poll()
  await browser.press(working, 'stop', 'data-press', { kind: 'press' })
  const stop = await stopped
  browser.close()
  serving.child.kill()

  expect(typed.status).toBe(200)
  expect(prompted.actions).toEqual([{ type: 'prompt', text: 'Now run the whole suite' }])
  expect(working.html).toContain('data-key="prompt:s1:1"')
  expect(stop.actions).toEqual([{ type: 'stop' }])
}, 30_000)

test.concurrent('opening a replied session marks it read, done and unread move it, and the mark outlives a restart of cmod web serve', async () => {
  const home = await homeWith({ s1: { project: 'work/app', prompt: 'Fix the login test', reply: 'The login test passes now.' } })
  const first = await served(home)
  const browser = await browsed(first.base)
  const replied = await browser.showing('Replied 1')
  await browser.press(replied, 'row:s1', 'data-press', { kind: 'press' })
  const read = await browser.showing('Idle 1')
  await browser.press(read, 'unread', 'data-press', { kind: 'press' })
  await browser.showing('Replied 1')
  const unread = await browser.showing('Replied 1')
  await browser.press(unread, 'done', 'data-press', { kind: 'press' })
  await browser.showing('Idle 1')
  browser.close()
  first.serving.child.kill()
  await first.serving.done
  const again = await served(home)
  const restarted = await browsed(again.base)
  const after = await restarted.showing('Idle 1')
  restarted.close()
  again.serving.child.kill()

  expect(JSON.parse(readFileSync(store(home, 'web-read.json'), 'utf8'))).toEqual({ s1: at(3) })
  expect(after.html).not.toContain('Replied')
}, 30_000)

test.concurrent('read marks pressed back to back reach the file in the order pressed, and cmod web serve stopped at once still writes the last', async () => {
  const home = await homeWith({ s1: { project: 'work/app', prompt: 'Fix the login test', reply: 'The login test passes now.' } })
  const first = await served(home)
  const browser = await browsed(first.base)
  const replied = await browser.showing('Replied 1')
  await browser.press(replied, 'row:s1', 'data-press', { kind: 'press' })
  const read = await browser.showing('Idle 1')
  await browser.press(read, 'unread', 'data-press', { kind: 'press' })
  await browser.press(read, 'done', 'data-press', { kind: 'press' })
  browser.close()
  first.serving.child.kill()
  await first.serving.done

  expect(JSON.parse(readFileSync(store(home, 'web-read.json'), 'utf8'))).toEqual({ s1: at(3) })
}, 30_000)

test.concurrent("a session's poll stays open its whole 15 seconds, past Bun's 10-second idle timeout, and then answers with nothing new", async () => {
  const { base, serving } = await served(await homeWith({}))
  await fetch(`${base}/api/sessions/one`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ about: { tabs: [], pages: [] } }) })
  await fetch(`${base}/api/sessions/one/events`)
  const startedAt = Date.now()

  expect(await (await fetch(`${base}/api/sessions/one/events`)).json()).toEqual({ views: [], actions: [] })
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(14_900)
  serving.child.kill()
}, 30_000)

test.concurrent('cmod web serve listens on another port when the one in web.json is taken', async () => {
  const taken = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const home = await homeWith({})
  await writeFiles(home, { '.local/share/cmod/web.json': JSON.stringify({ port: taken.port }) })
  const { port, serving } = await served(home)

  expect(port).not.toBe(taken.port)
  serving.child.kill()
  await taken.stop(true)
}, 30_000)

test.concurrent('cmod web serve keeps its port in web.json, listens on that port again, exits once the person turns the web UI off, and waits while it is off', async () => {
  const home = await homeWith({})
  const { serving } = await served(home)
  const saved = JSON.parse(await readFile(store(home, 'web.json'), 'utf8')) as { port: number }

  expect(Object.keys(saved)).toEqual(['port'])
  await writeFiles(home, { '.local/share/cmod/preferences.json': JSON.stringify({ servesWebUi: false }) })
  expect((await serving.done).exitCode).toBe(0)

  const waiting = startCmod(home, 'web', 'serve')
  children.push(waiting.child)
  await Bun.sleep(1000)
  const isAnswered = await fetch(`http://127.0.0.1:${saved.port}/`).then(
    () => true,
    (error: unknown) => {
      if (error instanceof TypeError) return false
      throw error
    },
  )
  expect(isAnswered).toBe(false)
  await writeFiles(home, { '.local/share/cmod/preferences.json': JSON.stringify({ servesWebUi: true }) })
  await waiting.waitForOutput(`127.0.0.1:${saved.port}`)
  expect(JSON.parse(await readFile(store(home, 'web.json'), 'utf8'))).toEqual(saved)
  waiting.child.kill()
}, 30_000)

test.concurrent('cmod web prints the address, opens it in the browser, and says how to turn the browser app on when it does not run', async () => {
  const home = await homeWith({})
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  await writeFiles(home, { [`bin/${opener}`]: '#!/bin/sh\necho "$1" > "$HOME/opened"\n', '.local/share/cmod/preferences.json': JSON.stringify({ servesWebUi: false }) })
  const before = await cmodWith(home, {}, 'web')
  await writeFiles(home, { '.local/share/cmod/preferences.json': JSON.stringify({ servesWebUi: true }) })
  const { port, serving } = await served(home)
  const opened = await cmodWith(home, {}, 'web')
  serving.child.kill()

  expect(before.exitCode).toBe(1)
  expect(before.stderr).toBe('cmod web: the browser app does not run now. Press open in browser on the Sidebar in Claude Code, which turns it on.\n')
  expect([opened.exitCode, opened.stdout]).toEqual([0, `http://127.0.0.1:${port}/\n`])
  expect(readFileSync(join(home, 'opened'), 'utf8')).toBe(opened.stdout)
}, 30_000)
