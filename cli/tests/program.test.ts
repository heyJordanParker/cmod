import { afterAll, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { cmod, cmodFromSource, cmodWith, deleteTemporaryHomes, environment, startCmod, temporaryHome, writeFiles } from './cmod.js'

afterAll(deleteTemporaryHomes)

const fakeServer = `#!/bin/sh
echo "start $$" >> "$HOME/server-log"
trap 'echo "stop $$" >> "$HOME/server-log"; exit 0' TERM
echo "unix:$HOME/$$.sock"
while :; do sleep 0.1; done
`

const crashServer = `#!/bin/sh
echo "no port is free" >&2
exit 3
`

const instances = (home: string) => join(home, '.local/share/cmod/instances/tools')

async function serverHome(): Promise<string> {
  const home = await temporaryHome()
  await writeFiles(home, { 'bin/fake-server': fakeServer, 'bin/crash-server': crashServer })
  return home
}

function serverLog(home: string): string[] {
  return existsSync(join(home, 'server-log')) ? readFileSync(join(home, 'server-log'), 'utf8').trim().split('\n') : []
}

function serverIds(home: string, event: 'start' | 'stop'): string[] {
  return serverLog(home)
    .filter((line) => line.startsWith(`${event} `))
    .map((line) => line.slice(event.length + 1))
}

function owner(home: string): number {
  return Number(readdirSync(join(instances(home), 'fake-server.json.lock'))[0])
}

async function until(isDone: () => boolean): Promise<void> {
  const deadline = Date.now() + 20000
  while (!isDone()) {
    if (Date.now() > deadline) throw new Error('waited 20 seconds')
    await Bun.sleep(100)
  }
}

test('two cmod program processes started together run one copy, and both print its address', async () => {
  const home = await serverHome()
  const first = startCmod(home, 'program', 'tools', '--', 'fake-server')
  const second = startCmod(home, 'program', 'tools', '--', 'fake-server')
  await until(() => serverIds(home, 'start').length > 0)
  const [copy] = serverIds(home, 'start')

  await first.waitForOutput(`unix:${home}/${copy}.sock`)
  await second.waitForOutput(`unix:${home}/${copy}.sock`)
  await Bun.sleep(1000)
  expect(serverIds(home, 'start')).toEqual([copy as string])
  expect(JSON.parse(readFileSync(join(instances(home), 'fake-server.json'), 'utf8'))).toMatchObject({ address: `unix:${home}/${copy}.sock`, pid: Number(copy) })
  first.child.kill()
  second.child.kill()
  await Promise.all([first.done, second.done])
}, 60000)

test("SIGTERM to the owner stops its copy, and the waiter starts the next copy and prints that copy's address", async () => {
  const home = await serverHome()
  const first = startCmod(home, 'program', 'tools', '--', 'fake-server')
  await until(() => serverIds(home, 'start').length === 1)
  const second = startCmod(home, 'program', 'tools', '--', 'fake-server')
  const [copy] = serverIds(home, 'start')
  await second.waitForOutput(`unix:${home}/${copy}.sock`)

  first.child.kill('SIGTERM')
  expect((await first.done).exitCode).toBe(0)
  await until(() => serverIds(home, 'start').length === 2)
  const next = serverIds(home, 'start')[1] as string

  await second.waitForOutput(`unix:${home}/${next}.sock`)
  expect(serverLog(home)).toEqual([`start ${copy}`, `stop ${copy}`, `start ${next}`])
  second.child.kill()
  await second.done
}, 60000)

test('after the owner is killed with SIGKILL, the next owner stops the orphaned copy before it starts its own', async () => {
  const home = await serverHome()
  const first = startCmod(home, 'program', 'tools', '--', 'fake-server')
  await until(() => serverIds(home, 'start').length === 1)
  const second = startCmod(home, 'program', 'tools', '--', 'fake-server')
  const [orphan] = serverIds(home, 'start')
  await second.waitForOutput(`unix:${home}/${orphan}.sock`)
  expect(owner(home)).toBe(first.child.pid)

  first.child.kill('SIGKILL')
  await until(() => serverIds(home, 'start').length === 2)
  const next = serverIds(home, 'start')[1] as string

  expect(serverLog(home)).toEqual([`start ${orphan}`, `stop ${orphan}`, `start ${next}`])
  await second.waitForOutput(`unix:${home}/${next}.sock`)
  second.child.kill()
  await second.done
}, 60000)

test('the owner stops its copy and gives up the election when its parent process dies', async () => {
  const home = await serverHome()
  await writeFiles(home, { 'bin/cmod': cmodFromSource })
  const parent = Bun.spawn(['sh', '-c', 'cmod program tools -- fake-server & wait'], { cwd: home, env: environment(home), stdout: 'ignore', stderr: 'ignore' })
  await until(() => serverIds(home, 'start').length === 1)
  const [copy] = serverIds(home, 'start')

  parent.kill('SIGKILL')
  await until(() => serverIds(home, 'stop').length === 1)

  expect(serverLog(home)).toEqual([`start ${copy}`, `stop ${copy}`])
  await until(() => !existsSync(join(instances(home), 'fake-server.json.lock')))
  expect(existsSync(join(instances(home), 'fake-server.json'))).toBe(false)
}, 60000)

test("SIGTERM stops the owner's copy even after the session's working folder is deleted", async () => {
  const home = await serverHome()
  await writeFiles(home, { 'bin/cmod': cmodFromSource, 'project/.keep': '' })
  const first = Bun.spawn([join(home, 'bin/cmod'), 'program', 'tools', '--', 'fake-server'], { cwd: join(home, 'project'), env: environment(home), stdout: 'ignore', stderr: 'ignore' })
  await until(() => serverIds(home, 'start').length === 1)
  await rm(join(home, 'project'), { recursive: true })

  first.kill('SIGTERM')

  expect(await first.exited).toBe(0)
  expect(serverIds(home, 'stop')).toEqual(serverIds(home, 'start'))
}, 60000)

test('the copy runs without CLAUDE_CODE_SESSION_ID, because it serves every session', async () => {
  const home = await serverHome()
  await writeFiles(home, { 'bin/session-server': '#!/bin/sh\necho "session ${CLAUDE_CODE_SESSION_ID:-none}" >> "$HOME/server-log"\necho "unix:$HOME/$$.sock"\n' })

  const { exitCode } = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'session-1' }, 'program', 'tools', '--', 'session-server')

  expect(exitCode).toBe(0)
  expect(serverLog(home)).toEqual(['session none'])
}, 60000)

test("cmod teardown deletes the removed mod's instances folder and keeps another mod's", async () => {
  const home = await temporaryHome()
  await writeFiles(home, { '.local/share/cmod/instances/tools/fake-server.json': '{}\n', '.local/share/cmod/instances/notes/fake-server.json': '{}\n' })

  const result = await cmod(home, 'teardown', 'tools', '--events')

  expect(result.exitCode).toBe(0)
  expect(existsSync(instances(home))).toBe(false)
  expect(existsSync(join(home, '.local/share/cmod/instances/notes/fake-server.json'))).toBe(true)
}, 60000)

test("a copy that crashes makes the owner exit with the copy's exit code and pass its standard error through", async () => {
  const home = await serverHome()

  const { exitCode, stderr } = await cmod(home, 'program', 'tools', '--', 'crash-server')

  expect(exitCode).toBe(3)
  expect(stderr).toContain('no port is free')
  expect(existsSync(join(instances(home), 'crash-server.json.lock'))).toBe(false)
}, 60000)
