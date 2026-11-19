import { afterAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectRpc, type RpcClient } from '@cmodjs/core/src/runtime/rpc.js'
import { deleteTemporaryHomes, startCmod, temporaryHome, writeFiles } from './cmod.js'

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

async function servedHome() {
  const home = await temporaryHome()
  const folder = `.claude/projects/${project(home).replace(/[^A-Za-z0-9]/g, '-')}`
  await writeFiles(home, {
    'bin/claude': backgroundClaude,
    'work/app/.keep': '',
    [`${folder}/ended.jsonl`]: transcript('ended', project(home)),
    [`${folder}/older.jsonl`]: transcript('older', project(home)),
    '.claude/sessions/1.json': JSON.stringify({ pid: process.pid, sessionId: 'older', cwd: project(home), kind: 'interactive', entrypoint: 'cli' }),
    '.local/share/cmod/data/cmod/goals/ended.txt': 'Fix the login test',
  })
  const serving = startCmod(home, 'serve')
  await serving.waitForOutput('unix:')
  const socket = join(home, '.local/share/cmod/serve.sock')
  const client = connectRpc({
    call: async (path, init) => {
      const answer = await fetch(`http://localhost${path}`, { method: init.method, ...(init.body === undefined ? {} : { body: init.body, headers: { 'content-type': 'application/json' } }), unix: socket } as RequestInit)
      return { status: answer.status, text: await answer.text() }
    },
    handle: (method) => Promise.reject(new Error(`no ${method}`)),
    wait: (ms) => new Promise((resolve) => void setTimeout(resolve, ms)),
  })
  clients.push(client)
  const act = (action: string, session: string, input: unknown = null) => client.request(`cmod/Session.${action}`, [session, input, { project: project(home) }])
  return { home, folder, act, stop: () => serving.child.kill() }
}

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
