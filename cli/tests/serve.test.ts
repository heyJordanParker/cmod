import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { connectRpc, RpcError, rpcCodes, type RpcClient } from '@cmodjs/core/src/runtime/rpc.js'
import { scripts, version } from '../package.json'
import { cmod, cmodFromSource, deleteTemporaryHomes, startCmod, temporaryHome, writeFiles } from './cmod.js'

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

async function servedHome(status: object = {}) {
  const home = await temporaryHome()
  const folder = `.claude/projects/${project(home).replace(/[^A-Za-z0-9]/g, '-')}`
  await writeFiles(home, {
    'bin/claude': backgroundClaude,
    'work/app/.keep': '',
    [`${folder}/ended.jsonl`]: transcript('ended', project(home)),
    [`${folder}/older.jsonl`]: transcript('older', project(home)),
    '.claude/sessions/1.json': olderRecord(home, status),
    '.local/share/cmod/data/cmod/goals/ended.txt': 'Fix the login test',
  })
  let hear: (heard: unknown) => void = () => undefined
  const serving = startCmod(home, 'serve')
  await serving.waitForOutput('unix:')
  const socket = join(home, '.local/share/cmod/serve.sock')
  const client = connectRpc({
    call: async (path, init) => {
      const answer = await fetch(`http://localhost${path}`, { method: init.method, ...(init.body === undefined ? {} : { body: init.body, headers: { 'content-type': 'application/json' } }), unix: socket } as RequestInit)
      return { status: answer.status, text: await answer.text() }
    },
    handle: (method, params) => (method === '$/on' ? hear(params) : Promise.reject(new Error(`no ${method}`))),
    wait: (ms) => new Promise((resolve) => void setTimeout(resolve, ms)),
  })
  clients.push(client)
  const act = (action: string, session: string, input: unknown = null) => client.request(`cmod/Sessions.${action}`, [session, input, { project: project(home) }])
  const nextHeard = () => new Promise<unknown>((resolve) => void (hear = resolve))
  const stop = () => serving.child.kill()
  return { home, folder, client, act, nextHeard, stop, stopped: () => (stop(), serving.done) }
}

test.concurrent('a cmod serve older than the newest cmod installed exits 0 and takes its socket away, so its service starts the newer one', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { '.local/share/cmod/programs/cmod': cmodFromSource, [`.local/share/cmod/bin/cmod/${Number(version.split('.')[0]) + 1}.0.0/cmod`]: cmodFromSource })

  const { exitCode, stdout } = await cmod(home, 'serve')

  expect(exitCode).toBe(0)
  expect(stdout).toStartWith('unix:')
  expect(existsSync(join(home, '.local/share/cmod/serve.sock'))).toBe(false)
}, 60000)

test.concurrent("cmod serve lists each of this computer's sessions with the name and id of the device cmod device reads", async () => {
  const { home, client, stop } = await servedHome()

  const listed = await client.request<readonly { readonly id: string; readonly device?: unknown }[]>('cmod/Sessions.sessions', [{ project: project(home), everyProject: true }])
  const { id, name } = JSON.parse((await cmod(home, 'device', '--json')).stdout) as { readonly id: string; readonly name: string }
  stop()

  expect(listed.map((session) => [session.id, session.device]).toSorted()).toEqual([
    ['ended', { id, name }],
    ['older', { id, name }],
  ])
}, 30_000)

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
}, 30_000)

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
}, 30_000)

test.concurrent('cmod serve resumes an ended session in the background on a message, keeps a visit in visited.json, and deletes an ended session whole', async () => {
  const { home, folder, act, stop } = await servedHome()

  const resumed = await act('send', 'ended', { type: 'prompt', text: 'Run it again' })
  await act('visit', 'ended', '2026-11-19T11:00:00.000Z')
  const visited = JSON.parse(readFileSync(join(home, '.local/share/cmod/visited.json'), 'utf8')) as unknown
  await act('delete', 'ended')
  stop()

  expect(resumed).toEqual({ session: 'ended' })
  expect(readFileSync(join(home, 'bg-args'), 'utf8').trimEnd().split('\n')).toEqual(['--bg', '--resume', 'ended', '--', 'Run it again'])
  expect(visited).toEqual({ ended: '2026-11-19T11:00:00.000Z' })
  expect([existsSync(join(home, folder, 'ended.jsonl')), existsSync(join(home, '.local/share/cmod/data/cmod/goals/ended.txt'))]).toEqual([false, false])
  expect(JSON.parse(readFileSync(join(home, '.local/share/cmod/visited.json'), 'utf8'))).toEqual({})
}, 30_000)

test.concurrent('cmod serve sends no message to a session Claude Code still runs, so a message never starts a second copy of it, even while no record or cmod plugin says it runs, and its refusal is final, so no other device answers for the session', async () => {
  const { home, folder, act, stop } = await servedHome()
  await writeFiles(home, { [`${folder}/alive.jsonl`]: transcript('alive', project(home)) })

  const refused = await act('send', 'alive', { type: 'prompt', text: 'Did this reach you?' }).catch((error: unknown) => error as RpcError)
  stop()

  expect(refused).toBeInstanceOf(RpcError)
  expect([(refused as RpcError).message, (refused as RpcError).code === rpcCodes.notHeld]).toEqual(['Session alive runs, but no cmod plugin in it reaches cmod serve, so it takes no send, and cmod starts no copy of it. Run /reload-plugins in it.', false])
  expect(existsSync(join(home, 'bg-args'))).toBe(false)
}, 30_000)

test.concurrent('two messages that reach an ended session at once resume it once, and the later one is refused because the resumed copy runs', async () => {
  const { home, act, stop } = await servedHome()

  const [first, second] = await Promise.allSettled([act('send', 'ended', { type: 'prompt', text: 'Run it again' }), act('send', 'ended', { type: 'prompt', text: 'Run it again' })])
  stop()

  expect([first.status, second.status].toSorted()).toEqual(['fulfilled', 'rejected'])
  expect([first, second].flatMap((each) => (each.status === 'rejected' ? [(each.reason as Error).message] : []))).toEqual(['Session ended runs, but no cmod plugin in it reaches cmod serve, so it takes no send, and cmod starts no copy of it. Run /reload-plugins in it.'])
  expect(readFileSync(join(home, 'bg-args'), 'utf8').trimEnd().split('\n')).toEqual(['--bg', '--resume', 'ended', '--', 'Run it again'])
}, 30_000)

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
}, 30_000)

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
}, 30_000)

test.concurrent('cmod serve keeps the replies cmod web serve before 7.0.0 marked read as the visits of their sessions', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { '.local/share/cmod/web-read.json': JSON.stringify({ s1: '2026-11-18T09:00:00.000Z' }) })
  const serving = startCmod(home, 'serve')
  await serving.waitForOutput('unix:')
  serving.child.kill()

  expect(JSON.parse(readFileSync(join(home, '.local/share/cmod/visited.json'), 'utf8'))).toEqual({ s1: '2026-11-18T09:00:00.000Z' })
  expect(existsSync(join(home, '.local/share/cmod/web-read.json'))).toBe(false)
}, 30_000)

test.concurrent('cmod serve refuses an action on a session no transcript names, on a session an older cmod plugin runs, the delete of a running session, and the visit of a session another device serves', async () => {
  const { act, stop } = await servedHome()

  const unknown = await act('abort', 'gone').catch((error: unknown) => (error as Error).message)
  const older = await act('send', 'older', { type: 'prompt', text: 'Go on' }).catch((error: unknown) => (error as Error).message)
  const running = await act('delete', 'older').catch((error: unknown) => (error as Error).message)
  const ended = await act('abort', 'ended').catch((error: unknown) => (error as Error).message)
  const elsewhere = await act('visit', 'gone', '2026-11-19T11:00:00.000Z').catch((error: unknown) => (error as Error).message)
  stop()

  expect(unknown).toBe('No session gone on this computer.')
  expect(older).toBe('Session older runs, but no cmod plugin in it reaches cmod serve, so it takes no send, and cmod starts no copy of it. Run /reload-plugins in it.')
  expect(running).toBe('session older runs, so it stays. End it first.')
  expect(ended).toBe('session ended has ended, so it takes no abort. Message it to resume it.')
  expect(elsewhere).toBe('No session gone on this computer.')
}, 30_000)

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
}, 30_000)

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
}, 30_000)

test('the build compiles each worker the cmod program starts, because a compiled cmod loads no file its build did not name', async () => {
  const source = join(import.meta.dir, '../src')
  const workers: string[] = []
  for await (const path of new Bun.Glob('**/*.ts').scan({ cwd: source })) {
    for (const [, file] of (await Bun.file(join(source, path)).text()).matchAll(/new Worker\(new URL\('\.\/([\w-]+\.ts)'/g)) workers.push(join(dirname(path), file ?? ''))
  }

  expect(workers).toContain('history-worker.ts')
  for (const worker of workers) expect(scripts.build).toContain(` src/${worker} `)
})
