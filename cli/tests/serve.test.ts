import { afterAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectRpc, type RpcClient } from '@cmodjs/core/src/runtime/rpc.js'
import { cmod, deleteTemporaryHomes, startCmod, temporaryHome, writeFiles } from './cmod.js'

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
  --bg) printf '%s\\n' "$@" > "$HOME/bg-args"; echo 'backgrounded · ended00' ;;
  agents) echo '[{"pid":4242,"id":"ended00","cwd":"/work","kind":"background","sessionId":"ended","name":"Fix","status":"running","state":"working"}]' ;;
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

test.concurrent('cmod serve keeps the replies cmod web serve before 7.0.0 marked read as the visits of their sessions', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { '.local/share/cmod/web-read.json': JSON.stringify({ s1: '2026-11-18T09:00:00.000Z' }) })
  const serving = startCmod(home, 'serve')
  await serving.waitForOutput('unix:')
  serving.child.kill()

  expect(JSON.parse(readFileSync(join(home, '.local/share/cmod/visited.json'), 'utf8'))).toEqual({ s1: '2026-11-18T09:00:00.000Z' })
  expect(existsSync(join(home, '.local/share/cmod/web-read.json'))).toBe(false)
}, 30_000)

test.concurrent('cmod serve refuses an action on a session no transcript names, on a session an older cmod plugin runs, and the delete of a running session', async () => {
  const { act, stop } = await servedHome()

  const unknown = await act('abort', 'gone').catch((error: unknown) => (error as Error).message)
  const older = await act('send', 'older', { type: 'prompt', text: 'Go on' }).catch((error: unknown) => (error as Error).message)
  const running = await act('delete', 'older').catch((error: unknown) => (error as Error).message)
  const ended = await act('abort', 'ended').catch((error: unknown) => (error as Error).message)
  stop()

  expect(unknown).toBe('No session gone on this computer.')
  expect(older).toBe('Session older runs a cmod plugin from before 7.0.0, so it takes no send. Reload it with /reload-plugins.')
  expect(running).toBe('session older runs, so it stays. End it first.')
  expect(ended).toBe('session ended has ended, so it takes no abort. Message it to resume it.')
}, 30_000)
