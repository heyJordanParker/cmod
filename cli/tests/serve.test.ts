import { Database } from 'bun:sqlite'
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { bunClock, bunFetch } from '@cmodjs/core/src/runtime/bun.js'
import { addressCall, connectRpc, RpcError, rpcCodes, type RpcClient } from '@cmodjs/core/src/runtime/rpc.js'
import { scripts, version } from '../package.json'
import { cmod, cmodExecutable, cmodWith, deleteTemporaryHomes, servedChanges, serveChanges, spawningTestLimitMs, startCmod, temporaryHome, writeFiles } from './cmod.js'

setDefaultTimeout(spawningTestLimitMs)
const clients: RpcClient[] = []

afterAll(async () => {
  for (const client of clients.splice(0)) await client.close()
  await deleteTemporaryHomes()
})

const project = (home: string) => join(home, 'work/app')

const transcript = (session: string, folder: string) =>
  [
    { type: 'user', uuid: `${session}-u`, sessionId: session, timestamp: '2026-11-19T10:00:00.000Z', cwd: folder, message: { role: 'user', content: 'Fix the login test' } },
    { type: 'assistant', uuid: `${session}-a`, sessionId: session, timestamp: '2026-11-19T10:00:02.000Z', cwd: folder, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Fixed.' }] } },
  ]
    .map((row) => `${JSON.stringify(row)}\n`)
    .join('')

const backgroundClaude = `#!/bin/sh
case "$1" in
  --bg) printf '%s\\n' "$@" >> "$HOME/bg-args"; echo 'backgrounded · ended00' ;;
  agents) if [ "$3" = "--all" ]; then echo '[{"pid":4242,"id":"ended00","cwd":"/work","kind":"background","sessionId":"ended","name":"Fix","status":"running","state":"working"}]'; elif [ -f "$HOME/bg-args" ]; then echo '[{"pid":4243,"cwd":"/work","kind":"interactive","sessionId":"alive","name":"Alive","status":"idle"},{"pid":4242,"cwd":"/work","kind":"background","sessionId":"ended","name":"Fix","status":"running"}]'; else echo '[{"pid":4243,"cwd":"/work","kind":"interactive","sessionId":"alive","name":"Alive","status":"idle"}]'; fi ;;
  *) exit 1 ;;
esac
`

const olderRecord = (home: string, status: object = {}) => JSON.stringify({ pid: process.pid, sessionId: 'older', cwd: project(home), kind: 'interactive', entrypoint: 'cli', ...status })

async function servedHome(status: object = {}, served?: string) {
  const home = served ?? (await temporaryHome())
  const folder = `.claude/projects/${project(home).replace(/[^A-Za-z0-9]/g, '-')}`
  if (served === undefined) {
    await writeFiles(home, {
      'bin/claude': backgroundClaude,
      'work/app/.keep': '',
      [`${folder}/ended.jsonl`]: transcript('ended', project(home)),
      [`${folder}/older.jsonl`]: transcript('older', project(home)),
      '.claude/sessions/1.json': olderRecord(home, status),
      '.local/share/cmod/data/cmod/goals/ended.txt': 'Fix the login test',
    })
  }
  const heardAll: unknown[] = []
  let hear: (heard: unknown) => void = () => undefined
  const serving = startCmod(home, 'serve')
  await serving.waitForOutput('unix:')
  const socket = join(home, '.local/share/cmod/serve.sock')
  const client = connectRpc({
    call: addressCall(bunFetch, `unix:${socket}`),
    handle: async (method, params) => {
      if (method !== '$/on' && method !== '$/act') throw new Error(`no ${method}`)
      heardAll.push(params)
      hear(params)
      return null
    },
    clock: bunClock(true),
    keepsConnecting: true,
  })
  clients.push(client)
  const act = (action: string, session: string, input: unknown = null, context: object = {}) => client.request(`cmod/Sessions.${action}`, [session, input, { project: project(home), ...context }])
  const nextHeard = () => new Promise<unknown>((resolve) => void (hear = resolve))
  const stop = () => serving.child.kill()
  const mailChanges = (session: string) => serveChanges(home).listen('cmod/Sessions', { session, part: 'mail' })
  return { home, folder, client, act, nextHeard, heardAll, mailChanges, waitForOutput: serving.waitForOutput, stop, stopped: () => (stop(), serving.done), exited: serving.done }
}

test.concurrent('a running cmod serve exits 0 once cmod/Store tells that the plugins changed and a newer cmod is in the cmod store, so its service starts the newer one', async () => {
  const { home, client, exited } = await servedHome()
  await writeFiles(home, { '.local/share/cmod/programs/cmod': cmodExecutable, [`.local/share/cmod/bin/cmod/${Number(version.split('.')[0]) + 1}.0.0/cmod`]: cmodExecutable })

  await client.request('cmod/Store.changed', ['plugins'])

  expect((await exited).exitCode).toBe(0)
  expect(existsSync(join(home, '.local/share/cmod/serve.sock'))).toBe(false)
})

test.concurrent('a cmod the launcher just installed tells cmod/Store that the plugins changed, so every older cmod watch and cmod serve reads the newest cmod', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { '.local/share/cmod/records/.keep': '' })
  const serve = await servedChanges(home)
  const changes = await serve.listen('cmod/Store', { part: 'plugins' })

  expect((await cmodWith(home, { CMOD_INSTALLED_VERSION: version }, '--version')).exitCode).toBe(0)

  expect(await changes()).toEqual({ part: 'plugins' })
})

test.concurrent('a cmod serve older than the newest cmod installed exits 0 and takes its socket away, so its service starts the newer one', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { '.local/share/cmod/programs/cmod': cmodExecutable, [`.local/share/cmod/bin/cmod/${Number(version.split('.')[0]) + 1}.0.0/cmod`]: cmodExecutable })

  const { exitCode, stdout } = await cmod(home, 'serve')

  expect(exitCode).toBe(0)
  expect(stdout).toStartWith('unix:')
  expect(existsSync(join(home, '.local/share/cmod/serve.sock'))).toBe(false)
})

test.concurrent("cmod serve lists each of this computer's sessions with the name and id of the device cmod device reads", async () => {
  const { home, client, stop } = await servedHome()

  const listed = await client.request<readonly { readonly id: string; readonly device?: unknown }[]>('cmod/Sessions.sessions', [{ project: project(home), everyProject: true }])
  const { id, name } = JSON.parse((await cmod(home, 'device', '--json')).stdout) as { readonly id: string; readonly name: string }
  stop()

  expect(listed.map((session) => [session.id, session.device]).toSorted()).toEqual([
    ['ended', { id, name }],
    ['older', { id, name }],
  ])
})

test.concurrent('cmod serve measures this computer at each start and writes it to device.json in the cmod store, which cmod device reads', async () => {
  const deviceFile = (home: string) => JSON.parse(readFileSync(join(home, '.local/share/cmod/device.json'), 'utf8')) as Record<string, unknown>
  const first = await servedHome()
  await first.client.request('cmod/Sessions.sessions', [{ project: project(first.home), everyProject: true }])
  await first.stopped()
  const written = deviceFile(first.home)
  await writeFiles(first.home, { '.local/share/cmod/device.json': JSON.stringify({ ...written, name: 'renamed' }) })
  const read: unknown = JSON.parse((await cmod(first.home, 'device', '--json')).stdout)

  const second = await servedHome({}, first.home)
  await second.client.request('cmod/Sessions.sessions', [{ project: project(first.home), everyProject: true }])
  second.stop()

  expect(written).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/), name: expect.any(String), os: process.platform, arch: process.arch })
  expect(read).toEqual({ ...written, name: 'renamed' })
  expect(deviceFile(first.home)).toEqual(written)
})

test.concurrent('cmod serve lists a session Claude Code records as waiting with the dialog it waits on, and tells a Change of its status when the record changes', async () => {
  const { home, client, nextHeard, stopped } = await servedHome({ status: 'waiting', waitingFor: 'permission prompt' })
  const list = async () => (await client.request<readonly { readonly id: string; readonly status?: string; readonly waitingFor?: unknown }[]>('cmod/Sessions.sessions', [{ project: project(home) }])).map(({ id, status, waitingFor }) => ({ id, status, waitingFor }))

  const waiting = await list()
  await client.request('$/listen', { id: '1', interface: 'cmod/Sessions', event: 'Change', kind: 'on', args: ['older'] })
  const heard = nextHeard()
  await writeFiles(home, { '.claude/sessions/1.json': olderRecord(home, { status: 'busy' }) })
  const change = await heard
  const busy = await list()
  const { stderr } = await stopped()

  expect(waiting.toSorted((first, second) => first.id.localeCompare(second.id))).toEqual([
    { id: 'ended', status: undefined, waitingFor: undefined },
    { id: 'older', status: 'waiting', waitingFor: { dialog: 'permission prompt' } },
  ])
  expect(change).toEqual({ id: '1', payload: { session: 'older', part: 'status' }, cursor: '1' })
  expect(busy.find(({ id }) => id === 'older')).toEqual({ id: 'older', status: 'busy', waitingFor: undefined })
  expect(stderr).toBe('')
})

test.concurrent('cmod serve answers the cmod/SessionStore and cmod/Session names a cmod plugin from 7.0.0 calls, and refuses its listener on another session', async () => {
  const { home, client, stop } = await servedHome()

  const listed = await client.request<readonly { readonly id: string }[]>('cmod/SessionStore.sessions', [{ project: project(home), everyProject: true }])
  const goal = await client.request('cmod/SessionStore.read', ['ended', 'goal', { project: project(home) }])
  const unknown = await client.request('cmod/Session.abort', ['gone', null, { project: project(home) }]).catch((error: unknown) => (error as Error).message)
  const change = await client.request('$/listen', { id: '1', interface: 'cmod/SessionStore', event: 'Change', kind: 'on', args: ['ended'] })
  const listener = await client.request('$/listen', { id: '2', interface: 'cmod/Session', event: 'prompt', kind: 'before', args: ['older'] }).catch((error: unknown) => (error as Error).message)
  stop()

  expect(listed.map((session) => session.id).toSorted()).toEqual(['ended', 'older'])
  expect(goal).toEqual({ text: 'Fix the login test' })
  expect(unknown).toBe('No session gone on this computer.')
  expect(change).toEqual({})
  expect(listener).toBe('cmod/Session tells only Change, because a mod hears only the session it runs in.')
})

test.concurrent('cmod serve resumes an ended session in the background on a message, keeps a visit in visited.json, and deletes an ended session whole', async () => {
  const { home, folder, act, mailChanges, stop } = await servedHome()
  const nextMailChange = await mailChanges('ended')

  const resumed = await act('send', 'ended', { type: 'prompt', text: 'Run it again' })
  await nextMailChange()
  await nextMailChange()
  await act('visit', 'ended', '2026-11-19T11:00:00.000Z')
  const visited = JSON.parse(readFileSync(join(home, '.local/share/cmod/visited.json'), 'utf8')) as unknown
  await act('delete', 'ended')
  stop()

  expect(resumed).toEqual({ id: 1, state: 'queued' })
  expect(readFileSync(join(home, 'bg-args'), 'utf8').trimEnd().split('\n')).toEqual(['--bg', '--resume', 'ended', '--', 'Run it again'])
  expect(visited).toEqual({ ended: '2026-11-19T11:00:00.000Z' })
  expect([existsSync(join(home, folder, 'ended.jsonl')), existsSync(join(home, '.local/share/cmod/data/cmod/goals/ended.txt'))]).toEqual([false, false])
  expect(JSON.parse(readFileSync(join(home, '.local/share/cmod/visited.json'), 'utf8'))).toEqual({})
})

test.concurrent('cmod serve starts no copy of a session Claude Code still runs, even while no record or cmod plugin says it runs, and keeps the message queued here, so no other device answers for the session', async () => {
  const { home, folder, act, waitForOutput, stopped } = await servedHome()
  await writeFiles(home, { [`${folder}/alive.jsonl`]: transcript('alive', project(home)) })

  const queued = await act('send', 'alive', { type: 'prompt', text: 'Did this reach you?' })
  await waitForOutput('Session alive runs')
  const { stderr } = await stopped()

  expect(queued).toEqual({ id: 1, state: 'queued' })
  expect(stderr).toContain('Session alive runs, but no cmod plugin in it reaches cmod serve, so it takes no send, and cmod starts no copy of it. Run /reload-plugins in it.')
  expect(existsSync(join(home, 'bg-args'))).toBe(false)
})

test.concurrent('two messages that reach an ended session at once resume it once, and the later one stays queued for the resumed copy', async () => {
  const { home, client, act, mailChanges, stop } = await servedHome()
  const nextMailChange = await mailChanges('ended')

  const answers = (await Promise.all([act('send', 'ended', { type: 'prompt', text: 'Run it again' }), act('send', 'ended', { type: 'prompt', text: 'Run it again' })])) as readonly { readonly id: number; readonly state: string }[]
  for (let change = 0; change < 3; change += 1) await nextMailChange()
  const mail = await client.request<readonly { readonly id: number; readonly deliveredAt?: string }[]>('cmod/Sessions.read', ['ended', 'mail', {}])
  stop()

  expect(answers.map(({ id, state }) => [id, state]).toSorted()).toEqual([
    [1, 'queued'],
    [2, 'queued'],
  ])
  expect(mail.map((each) => [each.id, typeof each.deliveredAt])).toEqual([
    [1, 'string'],
    [2, 'undefined'],
  ])
  expect(readFileSync(join(home, 'bg-args'), 'utf8').trimEnd().split('\n')).toEqual(['--bg', '--resume', 'ended', '--', 'Run it again'])
})

test.concurrent("a message to a running session no cmod plugin holds survives a cmod serve restart in mail.sqlite, and its cmod plugin's $/hold after the restart delivers it once", async () => {
  const first = await servedHome()
  const queued = await first.act('send', 'older', { type: 'prompt', text: 'Go on', from: { session: '4b1e9c2a-7d3f-4e15-9a0b-2c6d8e1f3a57', title: 'Plan' } }, { caller: 'demo' })
  await first.stopped()

  const { home, client, act, mailChanges, heardAll, stop } = await servedHome({}, first.home)
  const nextMailChange = await mailChanges('older')
  const hold = () => client.request('$/hold', { session: 'older', project: project(home), cwd: project(home) })
  await hold()
  await nextMailChange()
  await hold()
  const after = await act('send', 'older', { type: 'note', text: 'Tests pass.' })
  await nextMailChange()
  await nextMailChange()
  const mail = await client.request<readonly { readonly id: number; readonly deliveredAt?: string }[]>('cmod/Sessions.read', ['older', 'mail', {}])
  stop()

  expect([queued, after]).toEqual([
    { id: 1, state: 'queued' },
    { id: 2, state: 'queued' },
  ])
  expect(heardAll.map((each) => [(each as { readonly input: unknown }).input, (each as { readonly caller?: unknown }).caller])).toEqual([
    [{ type: 'prompt', text: '<cmod-message from="4b1e9c2a-7d3f-4e15-9a0b-2c6d8e1f3a57" title="Plan" reply="cmod sessions send 4b1e9c2a --reply-to 1">\nGo on\n</cmod-message>' }, 'demo'],
    [{ type: 'note', text: 'Tests pass.' }, undefined],
  ])
  expect(mail.map((each) => [each.id, typeof each.deliveredAt])).toEqual([
    [1, 'string'],
    [2, 'string'],
  ])
})

test.concurrent('cmod serve reads a session record Claude Code left with bytes after its JSON, so a running session lists as running, and finds one session by its id', async () => {
  const { home, client, stop } = await servedHome()
  await writeFiles(home, { '.claude/sessions/1.json': `${olderRecord(home, { status: 'idle' })}}` })

  const running = await client.request<readonly { readonly id: string; readonly status?: string }[]>('cmod/Sessions.sessions', [{ project: project(home), running: true }])
  const found = await client.request<{ readonly id: string; readonly isRunning: boolean; readonly status?: string }>('cmod/Sessions.session', ['older'])
  const missing = await client.request('cmod/Sessions.session', ['gone']).catch((error: unknown) => (error as Error).message)
  stop()

  expect(running.map(({ id, status }) => ({ id, status }))).toEqual([{ id: 'older', status: 'idle' }])
  expect({ id: found.id, isRunning: found.isRunning, status: found.status }).toEqual({ id: 'older', isRunning: true, status: 'idle' })
  expect(missing).toBe('No session gone on this computer.')
})

test.concurrent("cmod serve reads and types into the herdr-core terminal that runs a session's process, though no cmod plugin in the session reaches it, and answers not held for a session no terminal of this computer runs", async () => {
  const { home, client, stop } = await servedHome()
  await writeFiles(home, {
    'bin/hc': `#!/bin/sh
[ "$1" = connect ] || exit 2
read -r line
case "$line" in
  *terminal.list*) echo '{"jsonrpc":"2.0","id":1,"result":{"terminals":[{"address":"mac-studio/t9","pid":${process.pid}},{"address":"t2","pid":1},{"address":"t4","pid":7,"foreground":{"pid":${process.pid}}}]}}' ;;
  *terminal.read*) echo '{"jsonrpc":"2.0","id":1,"result":{"text":"the screen"}}'; echo "$line" >> "$HOME/hc-calls" ;;
  *terminal.keys*) echo '{"jsonrpc":"2.0","id":1,"result":{}}'; echo "$line" >> "$HOME/hc-calls" ;;
esac
`,
  })

  const screen = await client.request('cmod/Terminal.screen', ['older'])
  await client.request('cmod/Terminal.press', ['older', '1\r'])
  const ended = await client.request('cmod/Terminal.screen', ['ended']).catch((error: unknown) => error as RpcError)
  stop()

  expect(screen).toBe('the screen')
  expect(readFileSync(join(home, 'hc-calls'), 'utf8').trimEnd().split('\n').map((line) => (JSON.parse(line) as { readonly params: unknown }).params)).toEqual([{ terminal: 't4' }, { terminal: 't4', keys: ['1', 'enter'] }])
  expect([(ended as RpcError).message, (ended as RpcError).code]).toEqual(['No session ended runs in a herdr-core terminal on this computer.', rpcCodes.notHeld])
})

test.concurrent('cmod serve keeps the replies cmod web serve before 7.0.0 marked read as the visits of their sessions', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { '.local/share/cmod/web-read.json': JSON.stringify({ s1: '2026-11-18T09:00:00.000Z' }) })
  const serving = startCmod(home, 'serve')
  await serving.waitForOutput('unix:')
  serving.child.kill()

  expect(JSON.parse(readFileSync(join(home, '.local/share/cmod/visited.json'), 'utf8'))).toEqual({ s1: '2026-11-18T09:00:00.000Z' })
  expect(existsSync(join(home, '.local/share/cmod/web-read.json'))).toBe(false)
})

test.concurrent('cmod serve refuses an action on a session no transcript names, on a session an older cmod plugin runs, the delete of a running session, and the visit of a session another device serves', async () => {
  const { act, stop } = await servedHome()

  const unknown = await act('abort', 'gone').catch((error: unknown) => (error as Error).message)
  const older = await act('send', 'older', { type: 'prompt', text: 'Go on' })
  const running = await act('delete', 'older').catch((error: unknown) => (error as Error).message)
  const ended = await act('abort', 'ended').catch((error: unknown) => (error as Error).message)
  const elsewhere = await act('visit', 'gone', '2026-11-19T11:00:00.000Z').catch((error: unknown) => (error as Error).message)
  stop()

  expect(unknown).toBe('No session gone on this computer.')
  expect(older).toEqual({ id: 1, state: 'queued' })
  expect(running).toBe('session older runs, so it stays. End it first.')
  expect(ended).toBe('session ended has ended, so it takes no abort. Message it to resume it.')
  expect(elsewhere).toBe('No session gone on this computer.')
})

test.concurrent("cmod serve answers every connection and every call outside the conversation index while another process holds the index's write lock, and answers the index read once the lock is free", async () => {
  const { home, folder, client, stop } = await servedHome()
  const read = () => client.request<readonly { readonly id: string; readonly text?: string }[]>('cmod/Sessions.read', ['ended', 'messages', { project: project(home) }])
  const before = await read()
  const holder = new Database(join(home, '.local/share/cmod/history-14.sqlite'))
  holder.exec('begin immediate')
  await appendFile(join(home, folder, 'ended.jsonl'), `${JSON.stringify({ type: 'assistant', uuid: 'ended-b', sessionId: 'ended', timestamp: '2026-11-19T10:00:04.000Z', cwd: project(home), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Ran it again.' }] } })}\n`)
  const reading = read()
  const connect = () => fetch('http://localhost/rpc/connect', { method: 'POST', unix: join(home, '.local/share/cmod/serve.sock') } as RequestInit).then((answer) => answer.status)
  const connected = [await connect(), await connect()]
  const usage = await client.request('cmod/Sessions.read', ['ended', 'usage', { project: project(home) }])
  const isWaiting = await Promise.race([reading.then(() => false), Promise.resolve(true)])
  holder.exec('commit')
  holder.close()
  const after = await reading
  stop()

  expect(connected).toEqual([200, 200])
  expect(usage).toEqual({ model: '', contextWindow: {} })
  expect(isWaiting).toBe(true)
  expect(after.length).toBe(before.length + 1)
  expect(after.at(-1)?.text).toBe('Ran it again.')
})

test.concurrent('cmod serve finds one session while a search of every project waits on the conversation index, so a lookup never queues behind a whole-index read', async () => {
  const { home, folder, client, stop } = await servedHome()
  await client.request('cmod/Sessions.session', ['older'])
  const holder = new Database(join(home, '.local/share/cmod/history-14.sqlite'))
  holder.exec('begin immediate')
  await appendFile(join(home, folder, 'ended.jsonl'), `${JSON.stringify({ type: 'assistant', uuid: 'ended-b', sessionId: 'ended', timestamp: '2026-11-19T10:00:04.000Z', cwd: project(home), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Ran it again.' }] } })}\n`)
  const searching = client.request('cmod/Sessions.search', ['again', { everyProject: true }])

  const found = await client.request<{ readonly id: string }>('cmod/Sessions.session', ['older'])
  const isSearchWaiting = await Promise.race([searching.then(() => false), Promise.resolve(true)])
  holder.exec('commit')
  holder.close()
  await searching
  stop()

  expect([found.id, isSearchWaiting]).toEqual(['older', true])
})

test.concurrent('a cmod command that changes the set of mods tells every listener of cmod/Store that the plugins changed, after it wrote plugins-changed', async () => {
  const { home, client, nextHeard, stop } = await servedHome()
  await client.request('$/listen', { id: 'store', interface: 'cmod/Store', event: 'Change', kind: 'on' })
  const heard = nextHeard()

  await cmod(home, 'remove', 'ghost')
  const told = await heard
  stop()

  expect(told).toEqual({ id: 'store', payload: { part: 'plugins' }, cursor: '1' })
  expect(existsSync(join(home, '.local/share/cmod/plugins-changed'))).toBe(true)
})

test('the build compiles each worker the cmod program starts, because a compiled cmod loads no file its build did not name', async () => {
  const source = join(import.meta.dir, '../src')
  const workers: string[] = []
  for await (const path of new Bun.Glob('**/*.ts').scan({ cwd: source })) {
    for (const [, file] of (await Bun.file(join(source, path)).text()).matchAll(/new Worker\(new URL\('\.\/([\w-]+\.ts)'/g)) workers.push(join(dirname(path), file ?? ''))
  }

  expect(workers).toContain('history-worker.ts')
  for (const worker of workers) expect(scripts.build).toContain(` src/${worker} `)
})
