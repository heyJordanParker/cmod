import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cmodWith, deleteTemporaryHomes, spawningTestLimitMs, startCmod, startOf, temporaryHome, writeFiles } from './cmod.js'

setDefaultTimeout(spawningTestLimitMs)
afterAll(deleteTemporaryHomes)

const sessionId = '1a2b3c4d-0000-4000-8000-000000000001'

const backgroundClaude = `#!/bin/sh
case "$1" in
  --bg)
    printf '%s\\n' "$@" > "$HOME/bg-args"
    printf '%s\\n%s\\n' "$PWD" "\${CLAUDE_CODE_SESSION_ID-unset}" > "$HOME/bg-place"
    echo 'backgrounded · 1a2b3c4d'
    ;;
  agents) echo '[{"pid":4242,"id":"1a2b3c4d","cwd":"/work","kind":"background","sessionId":"${sessionId}","name":"Upgrade","status":"running","state":"working"}]' ;;
  stop) printf '%s\\n' "$@" > "$HOME/stop-args"; echo "stopped $2" ;;
  *) exit 1 ;;
esac
`

async function backgroundHome(): Promise<string> {
  const home = await temporaryHome()
  await writeFiles(home, { 'bin/claude': backgroundClaude, 'work/.keep': '' })
  return home
}

const lines = async (home: string, file: string) => (await readFile(join(home, file), 'utf8')).trimEnd().split('\n')

test('cmod task start runs claude --bg named with the task title and with the starting session in --settings env, resolves the short id through claude agents, and prints the task', async () => {
  const home = await backgroundHome()

  const started = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'starter' }, 'task', 'start', '--title', 'Upgrade', '--agent', 'Explore', '--model', 'haiku', '--cwd', join(home, 'work'), '--json', '--', 'Upgrade every dependency.')
  const args = await lines(home, 'bg-args')
  const settings = args[8] ?? ''
  const task = { title: 'Upgrade', agentType: 'Explore', model: 'haiku', openedBy: '', openedAt: expect.any(String), isBackground: true }

  expect(started.stderr).toBe('')
  expect(JSON.parse(started.stdout)).toEqual({ id: sessionId, ...task })
  expect(args).toEqual(['--bg', '--agent', 'Explore', '--model', 'haiku', '--name', 'Upgrade', '--settings', settings, '--', 'Upgrade every dependency.'])
  expect(JSON.parse((JSON.parse(settings) as { env: { CMOD_TASK: string } }).env.CMOD_TASK)).toEqual({ session: 'starter', ...task })
  expect(await lines(home, 'bg-place')).toEqual([join(home, 'work'), 'unset'])
})

test("cmod task start runs the task as a sub-agent of the starting session's herdr-core terminal, so Herdr lists, peeks, and keeps it under that session, and gives it its session id", async () => {
  const home = await backgroundHome()
  await writeFiles(home, {
    '.claude/sessions/1.json': JSON.stringify({ pid: process.pid, sessionId: 'starter', cwd: home, procStart: await startOf(process.pid), kind: 'interactive' }),
    'bin/hc': `#!/bin/sh
case "$1" in
  connect) read -r line; echo '{"jsonrpc":"2.0","id":1,"result":{"terminals":[{"address":"t2","pid":1},{"address":"t7","pid":7,"foreground":{"pid":${process.pid}}}]}}' ;;
  run) printf '%s\\n' "$@" > "$HOME/hc-args"; echo '{"address":"t9","agent":"claude-code","state":"live","turn":0}' ;;
  *) exit 2 ;;
esac
`,
  })

  const started = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'starter' }, 'task', 'start', '--title', 'Upgrade', '--agent', 'Explore', '--cwd', join(home, 'work'), '--json', '--', 'Upgrade every dependency.')
  const task = JSON.parse(started.stdout) as Readonly<Record<string, unknown>> & { readonly id: string }
  const args = await lines(home, 'hc-args')
  const claudeAt = args.indexOf('--') + 1

  expect(started.stderr).toBe('')
  expect(task).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), title: 'Upgrade', agentType: 'Explore', openedBy: '', openedAt: expect.any(String), isBackground: true })
  expect(args.slice(0, claudeAt)).toEqual(['run', '--bg', '--json', '--parent', 't7', '--no-notify', '--outlive-parent', '--cwd', join(home, 'work'), '--'])
  expect(args.slice(claudeAt + 1, claudeAt + 7)).toEqual(['--session-id', task.id, '--agent', 'Explore', '--name', 'Upgrade'])
  expect(args.slice(-2)).toEqual(['--', 'Upgrade every dependency.'])
  expect(existsSync(join(home, 'bg-args'))).toBe(false)
})

const row = (uuid: string, parentUuid: string | null, type: string, text: string) => ({ uuid, parentUuid, type, sessionId: 'starter', isSidechain: false, timestamp: '2026-11-19T10:00:00.000Z', message: { role: type, content: text } })

const starterTranscript = [
  row('m1', null, 'user', 'Build the parser.'),
  row('m2', 'm1', 'assistant', 'Built it on regexes.'),
  { ...row('s1', 'm2', 'user', 'a subagent prompt'), isSidechain: true },
  row('m3', 'm2', 'user', 'Now add tests.'),
  row('m4', 'm3', 'assistant', 'Added them.'),
  { type: 'content-replacement', sessionId: 'starter', replacements: [{ toolUseId: 't1' }] },
]
  .map((line) => `${JSON.stringify(line)}\n`)
  .join('')

async function forkedHome(): Promise<string> {
  const home = await backgroundHome()
  await writeFiles(home, { '.claude/projects/-work/starter.jsonl': starterTranscript })
  return home
}

async function forkOf(home: string, args: readonly string[]) {
  const started = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'starter' }, 'task', 'start', '--title', 'Try SQL', '--clone', ...args, '--json', 'Rebuild this on SQL.')
  const ran = (await lines(home, 'bg-args')).filter((arg) => !arg.startsWith('{'))
  const fork = ran[2] ?? ''
  const transcript = (await readFile(join(home, '.claude/projects/-work', `${fork}.jsonl`), 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  return { started, args: ran, fork, transcript }
}

test('cmod task start --clone writes a fork of the whole conversation of the starting session and resumes it in the background, and its task names the session it copies', async () => {
  const { started, args, fork, transcript } = await forkOf(await forkedHome(), [])

  expect(JSON.parse(started.stdout)).toEqual({ id: sessionId, title: 'Try SQL', forkedFrom: 'starter', openedBy: '', openedAt: expect.any(String), isBackground: true })
  expect(args).toEqual(['--bg', '--resume', fork, '--name', 'Try SQL', '--settings', '--', 'Rebuild this on SQL.'])
  expect(transcript.map((line) => [line['uuid'] ?? line['type'], line['parentUuid'], line['sessionId']])).toEqual([
    ['m1', null, fork],
    ['m2', 'm1', fork],
    ['m3', 'm2', fork],
    ['m4', 'm3', fork],
    ['content-replacement', undefined, fork],
  ])
  expect(transcript[0]?.['forkedFrom']).toEqual({ sessionId: 'starter', messageUuid: 'm1' })
})

test('cmod task start --clone --at forks the conversation from its first message through that message, and nothing after it', async () => {
  const home = await forkedHome()
  const { transcript } = await forkOf(home, ['--at', 'm2'])
  const missing = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'starter' }, 'task', 'start', '--title', 'Try SQL', '--clone', '--at', 'gone', 'Rebuild this on SQL.')

  expect(transcript.flatMap((line) => (typeof line['uuid'] === 'string' ? [line['uuid']] : []))).toEqual(['m1', 'm2'])
  expect([missing.exitCode, missing.stderr]).toEqual([1, 'cmod task: session starter holds no message gone to fork from. Its read lists each message\'s id.\n'])
})

test("the starting session's tasks list a background task, with the status claude agents gives it", async () => {
  const home = await backgroundHome()
  await writeFiles(home, { '.claude/sessions/1.json': JSON.stringify({ pid: process.pid, sessionId: 'starter', cwd: home }) })
  const serving = startCmod(home, 'serve')
  await serving.firstLine()
  await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'starter' }, 'task', 'start', '--title', 'Upgrade', '--json', 'Upgrade every dependency.')

  const listed = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'starter' }, 'sessions', 'read', 'tasks', '--json')

  expect(listed.stderr).toBe('')
  expect(JSON.parse(listed.stdout)).toEqual([{ id: sessionId, title: 'Upgrade', openedBy: '', openedAt: expect.any(String), isBackground: true, status: 'running' }])
})

test("cmod task stop stops a session Claude Code records as a background session with claude stop and its job id, and stops no other session", async () => {
  const home = await backgroundHome()
  const started = await startOf(process.pid)
  await writeFiles(home, {
    '.claude/sessions/1.json': JSON.stringify({ pid: process.pid, sessionId, cwd: home, procStart: started, kind: 'bg', jobId: '1a2b3c4d' }),
    '.claude/sessions/2.json': JSON.stringify({ pid: process.pid, sessionId: 'starter', cwd: home, procStart: started, kind: 'interactive' }),
  })

  const interactive = await cmodWith(home, {}, 'task', 'stop', 'starter', '--json')
  const leftAlone = existsSync(join(home, 'stop-args'))
  const background = await cmodWith(home, {}, 'task', 'stop', sessionId, '--json')

  expect(interactive).toEqual({ exitCode: 0, stdout: '{"isStopped":false}\n', stderr: '' })
  expect(leftAlone).toBe(false)
  expect(background).toEqual({ exitCode: 0, stdout: '{"isStopped":true}\n', stderr: '' })
  expect(await lines(home, 'stop-args')).toEqual(['stop', '1a2b3c4d'])
})

test('cmod task start outside Claude Code names the session it needs, and starts nothing', async () => {
  const home = await backgroundHome()

  const started = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: '' }, 'task', 'start', '--title', 'Upgrade', 'Upgrade every dependency.')

  expect([started.exitCode, started.stderr]).toEqual([1, 'cmod task: cmod task start runs inside Claude Code, which names the session the task belongs to in CLAUDE_CODE_SESSION_ID.\n'])
})
