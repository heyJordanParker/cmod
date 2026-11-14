import { afterAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cmod, deleteTemporaryHomes, startCmod, temporaryHome, writeFiles } from './cmod.js'

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

async function until(isDone: () => boolean): Promise<void> {
  const deadline = Date.now() + 20000
  while (!isDone()) {
    if (Date.now() > deadline) throw new Error('waited 20 seconds')
    await Bun.sleep(100)
  }
}

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
}, 60000)

test.concurrent('a web app keeps its tailnet port when it listens on another local port, so its address on your other machines stays the same', async () => {
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
}, 60000)

test.concurrent('a web app whose port already serves something else on your tailnet stays local, and Settings reads why', async () => {
  const home = await webHome({ 'tailscale-serve.json': '{"TCP":{"62021":{"HTTPS":true}}}' })
  const holder = startCmod(home, 'program', 'demo', '--web-app', '--no-wait', '--', 'web-server', '62021')

  await holder.waitForOutput('127.0.0.1:62021')

  expect(serveCalls(home)).toEqual([])
  expect(instance(home)).not.toHaveProperty('tailnetUrl')
  expect(tailnetRecord(home)).toEqual({ port: null, url: null, reason: 'Port 62021 of computer.example.ts.net already serves something else on your tailnet.' })
  holder.child.kill('SIGTERM')
  await holder.done
}, 60000)

test.concurrent('a web app runs on 127.0.0.1 alone while Tailscale is signed out, with the reason and its fix for Settings', async () => {
  const home = await webHome({ 'tailscale-signed-out': '' })
  const holder = startCmod(home, 'program', 'demo', '--web-app', '--no-wait', '--', 'web-server', '62021')

  await holder.waitForOutput('127.0.0.1:62021')

  expect(lines(home, 'server-log')).toEqual([expect.stringMatching(/^start \d+ 62021 none none$/)])
  expect(serveCalls(home)).toEqual([])
  expect(tailnetRecord(home)).toEqual({ port: null, url: null, reason: 'Tailscale is not signed in on this computer. Sign in, and cmod puts the web app on your tailnet within a minute.' })
  holder.child.kill('SIGTERM')
  await holder.done
}, 60000)

test.concurrent('turning servesTailnet off asks Tailscale nothing, and turning it on stops the copy so it starts again on your tailnet', async () => {
  const home = await webHome({ '.local/share/cmod/preferences.json': '{ "servesTailnet": false }\n' })
  const holder = startCmod(home, 'program', 'demo', '--web-app', '--no-wait', '--', 'web-server', '62021')
  await holder.waitForOutput('127.0.0.1:62021')

  expect(lines(home, 'tailscale-calls')).toEqual([])
  expect(tailnetRecord(home)).toEqual({ port: null, url: null, reason: 'Off in Settings, under cmod, Preferences.' })

  await writeFiles(home, { '.local/share/cmod/preferences.json': '{ "servesTailnet": true }\n' })
  await until(() => lines(home, 'server-log').some((line) => line.startsWith('stop ')))
  expect((await holder.done).exitCode).toBe(0)

  const next = startCmod(home, 'program', 'demo', '--web-app', '--no-wait', '--', 'web-server', '62021')
  await next.waitForOutput('127.0.0.1:62021')
  expect(serveCalls(home)).toEqual(['tailscale serve --bg --https=62021 http://127.0.0.1:62021'])
  next.child.kill('SIGTERM')
  await next.done
}, 60000)

test.concurrent('cmod teardown takes every web app of the mod off your tailnet and deletes their tailnet addresses', async () => {
  const home = await webHome({ '.local/share/cmod/tailnet/demo/web-server.json': `${JSON.stringify({ port: 62021, url: 'https://computer.example.ts.net:62021/', reason: null })}\n` })

  expect((await cmod(home, 'teardown', 'demo', '--events')).stdout).toBe('missing demo\n')

  expect(serveCalls(home)).toEqual(['tailscale serve --https=62021 off'])
  expect(existsSync(join(store(home), 'tailnet/demo'))).toBe(false)
}, 60000)
