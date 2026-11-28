import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cmod, deleteTemporaryHomes, servedChanges, spawningTestLimitMs, startCmod, temporaryHome, writeFiles } from './cmod.js'

setDefaultTimeout(spawningTestLimitMs)
afterAll(deleteTemporaryHomes)

const webServer = `#!/bin/sh
trap 'echo "stop $$" >> "$HOME/server-log"; exit 0' TERM
echo "start $$ $1 \${CMOD_TAILNET_NAME:-none} \${CMOD_TAILNET_LOGIN:-none}" >> "$HOME/server-log"
echo "127.0.0.1:$1"
while :; do sleep 0.1; done
`

async function webHome(files: Record<string, string> = {}): Promise<string> {
  const home = await temporaryHome()
  await writeFiles(home, { 'bin/web-server': webServer, ...files })
  return home
}

const store = (home: string) => join(home, '.local/share/cmod')

const lines = (home: string, file: string) => (existsSync(join(home, file)) ? readFileSync(join(home, file), 'utf8').trim().split('\n') : [])

const serveCalls = (home: string) => lines(home, 'tailscale-calls').filter((line) => line.startsWith('tailscale serve') && line !== 'tailscale serve status --json')

const tailnetRecord = (home: string) => JSON.parse(readFileSync(join(store(home), 'tailnet/demo/web-server.json'), 'utf8')) as unknown

const instance = (home: string) => JSON.parse(readFileSync(join(store(home), 'instances/demo/web-server.json'), 'utf8')) as unknown

test.concurrent('a web app runs with your tailnet name and login, is on your tailnet before its address is written, and comes off it when it stops', async () => {
  const home = await webHome()
  const holder = startCmod(home, 'program', 'demo', '--web-app', '--no-wait', '--', 'web-server', '62021')

  await holder.waitForOutput('127.0.0.1:62021')

  expect(lines(home, 'server-log')).toEqual([expect.stringMatching(/^start \d+ 62021 computer\.example\.ts\.net person@example\.com$/)])
  expect(serveCalls(home)).toEqual(['tailscale serve --bg --https=62021 http://127.0.0.1:62021'])
  expect(instance(home)).toMatchObject({ address: '127.0.0.1:62021', tailnetUrl: 'https://computer.example.ts.net:62021/' })
  expect(tailnetRecord(home)).toEqual({ port: 62021, url: 'https://computer.example.ts.net:62021/', reason: null })

  holder.child.kill('SIGTERM')
  expect((await holder.done).exitCode).toBe(0)
  expect(serveCalls(home)).toEqual(['tailscale serve --bg --https=62021 http://127.0.0.1:62021', 'tailscale serve --https=62021 off'])
  expect(tailnetRecord(home)).toEqual({ port: 62021, url: null, reason: null })
})

test.concurrent('a web app keeps its tailnet port when it listens on another local port, so its address on your other devices stays the same', async () => {
  const home = await webHome()
  const first = startCmod(home, 'program', 'demo', '--web-app', '--no-wait', '--', 'web-server', '62021')
  await first.waitForOutput('127.0.0.1:62021')
  first.child.kill('SIGTERM')
  await first.done

  const next = startCmod(home, 'program', 'demo', '--web-app', '--no-wait', '--', 'web-server', '63000')
  await next.waitForOutput('127.0.0.1:63000')

  expect(serveCalls(home).at(-1)).toBe('tailscale serve --bg --https=62021 http://127.0.0.1:63000')
  expect(instance(home)).toMatchObject({ address: '127.0.0.1:63000', tailnetUrl: 'https://computer.example.ts.net:62021/' })
  next.child.kill('SIGTERM')
  await next.done
})

test.concurrent('a web app whose port already serves something else on your tailnet stays local, and Settings reads why', async () => {
  const home = await webHome({ 'tailscale-serve.json': '{"TCP":{"62021":{"HTTPS":true}}}' })
  const holder = startCmod(home, 'program', 'demo', '--web-app', '--no-wait', '--', 'web-server', '62021')

  await holder.waitForOutput('127.0.0.1:62021')

  expect(serveCalls(home)).toEqual([])
  expect(instance(home)).not.toHaveProperty('tailnetUrl')
  expect(tailnetRecord(home)).toEqual({ port: null, url: null, reason: 'Port 62021 of computer.example.ts.net already serves something else on your tailnet.' })
  holder.child.kill('SIGTERM')
  await holder.done
})

test.concurrent('a web app runs on 127.0.0.1 alone while Tailscale is signed out, with the reason and its fix for Settings', async () => {
  const home = await webHome({ 'tailscale-signed-out': '' })
  const holder = startCmod(home, 'program', 'demo', '--web-app', '--no-wait', '--', 'web-server', '62021')

  await holder.waitForOutput('127.0.0.1:62021')

  expect(lines(home, 'server-log')).toEqual([expect.stringMatching(/^start \d+ 62021 none none$/)])
  expect(serveCalls(home)).toEqual([])
  expect(tailnetRecord(home)).toEqual({ port: null, url: null, reason: 'Tailscale is not signed in on this computer. Sign in, and cmod puts the web app on your tailnet within a minute.' })
  holder.child.kill('SIGTERM')
  await holder.done
})

test.concurrent('turning servesTailnet off asks Tailscale nothing, and turning it on stops the copy once cmod/Store tells that the preferences changed, so it starts again on your tailnet', async () => {
  const home = await webHome({ '.local/share/cmod/preferences.json': '{ "servesTailnet": false }\n' })
  const serve = await servedChanges(home)
  const holder = startCmod(home, 'program', 'demo', '--web-app', '--no-wait', '--', 'web-server', '62021')
  await holder.waitForOutput('127.0.0.1:62021')

  expect(lines(home, 'tailscale-calls')).toEqual([])
  expect(tailnetRecord(home)).toEqual({ port: null, url: null, reason: 'Off in Settings, under cmod, Preferences.' })

  await writeFiles(home, { '.local/share/cmod/preferences.json': '{ "servesTailnet": true }\n' })
  await serve.tell('cmod/Store', 'changed', ['preferences'])
  expect((await holder.done).exitCode).toBe(0)
  expect(lines(home, 'server-log').some((line) => line.startsWith('stop '))).toBe(true)

  const next = startCmod(home, 'program', 'demo', '--web-app', '--no-wait', '--', 'web-server', '62021')
  await next.waitForOutput('127.0.0.1:62021')
  expect(serveCalls(home)).toEqual(['tailscale serve --bg --https=62021 http://127.0.0.1:62021'])
  next.child.kill('SIGTERM')
  await next.done
})

test.concurrent("cmod serve answers an agent's JSON-RPC on your tailnet with the token it keeps across restarts, while servesApi is on, and takes its API off once servesApi is off", async () => {
  const home = await webHome({ '.local/share/cmod/preferences.json': '{ "servesApi": true }\n' })
  const serve = await servedChanges(home)
  await serve.serving.waitForOutput('serves its API to your tailnet at https://computer.example.ts.net:')
  const apps = () => JSON.parse(readFileSync(join(store(home), 'serve.json'), 'utf8')) as { readonly url: string; readonly token: string; readonly api?: string }
  const { url, token, api } = apps()
  const local = `${url.replace('ws:', 'http:').replace(/\/ui$/, '')}/rpc`
  const posted = (headers: Record<string, string>) => fetch(local, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'cmod/Sessions.sessions', params: [{ running: true }] }) })

  const answered = await posted({ authorization: `Bearer ${token}` })
  const refused = await posted({})
  const status = await cmod(home, 'serve', 'status')

  expect(api).toMatch(/^https:\/\/computer\.example\.ts\.net:\d+\/$/)
  expect(serveCalls(home)).toEqual([`tailscale serve --bg --https=${new URL(url).port} http://127.0.0.1:${new URL(url).port}`])
  expect([answered.status, await answered.json()]).toEqual([200, { jsonrpc: '2.0', id: 1, result: [] }])
  expect(refused.status).toBe(401)
  expect(status.stdout).toContain(`agents on your tailnet     ${api}rpc`)
  expect(status.stdout).toContain(`token                      ${token}`)

  await writeFiles(home, { '.local/share/cmod/preferences.json': '{ "servesApi": false }\n' })
  await serve.tell('cmod/Store', 'changed', ['preferences'])
  await serve.serving.waitForOutput('took its API off your tailnet')
  expect(serveCalls(home).at(-1)).toBe(`tailscale serve --https=${new URL(url).port} off`)
  expect(apps()).not.toHaveProperty('api')

  serve.serving.child.kill('SIGTERM')
  await serve.serving.done
  const again = await servedChanges(home)
  expect(apps().token).toBe(token)
  again.serving.child.kill('SIGTERM')
  await again.serving.done
})

test.concurrent('cmod teardown takes every web app of the mod off your tailnet and deletes their tailnet addresses', async () => {
  const home = await webHome({ '.local/share/cmod/tailnet/demo/web-server.json': `${JSON.stringify({ port: 62021, url: 'https://computer.example.ts.net:62021/', reason: null })}\n` })

  expect((await cmod(home, 'teardown', 'demo', '--events')).stdout).toBe('missing demo\n')

  expect(serveCalls(home)).toEqual(['tailscale serve --https=62021 off'])
  expect(existsSync(join(store(home), 'tailnet/demo'))).toBe(false)
})
