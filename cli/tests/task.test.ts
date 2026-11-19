import { afterAll, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cmodWith, deleteTemporaryHomes, temporaryHome, writeFiles } from './cmod.js'

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
  *) exit 1 ;;
esac
`

async function backgroundHome(): Promise<string> {
  const home = await temporaryHome()
  await writeFiles(home, { 'bin/claude': backgroundClaude, 'work/.keep': '' })
  return home
}

const lines = async (home: string, file: string) => (await readFile(join(home, file), 'utf8')).trimEnd().split('\n')

test('cmod task start runs claude --bg with the starting session in --settings env, resolves the short id through claude agents, and prints the task', async () => {
  const home = await backgroundHome()

  const started = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'starter' }, 'task', 'start', '--title', 'Upgrade', '--agent', 'Explore', '--model', 'haiku', '--cwd', join(home, 'work'), '--json', '--', 'Upgrade every dependency.')
  const args = await lines(home, 'bg-args')
  const settings = args[6] ?? ''
  const task = { title: 'Upgrade', agentType: 'Explore', model: 'haiku', openedBy: '', openedAt: expect.any(String), isBackground: true }

  expect(started.stderr).toBe('')
  expect(JSON.parse(started.stdout)).toEqual({ id: sessionId, ...task })
  expect(args).toEqual(['--bg', '--agent', 'Explore', '--model', 'haiku', '--settings', settings, '--', 'Upgrade every dependency.'])
  expect(JSON.parse((JSON.parse(settings) as { env: { CMOD_TASK: string } }).env.CMOD_TASK)).toEqual({ session: 'starter', ...task })
  expect(await lines(home, 'bg-place')).toEqual([join(home, 'work'), 'unset'])
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
  expect(args).toEqual(['--bg', '--resume', fork, '--settings', '--', 'Rebuild this on SQL.'])
  expect(transcript.map((line) => [line['uuid'] ?? line['type'], line['parentUuid'], line['sessionId']])).toEqual([
    ['m1', null, fork],
    ['m2', 'm1', fork],
    ['m3', 'm2', fork],
    ['m4', 'm3', fork],
    ['content-replacement', undefined, fork],
    ['custom-title', undefined, fork],
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
  await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'starter' }, 'task', 'start', '--title', 'Upgrade', '--json', 'Upgrade every dependency.')

  const listed = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'starter' }, 'history', 'tasks', '--json')

  expect(JSON.parse(listed.stdout)).toEqual([{ id: sessionId, title: 'Upgrade', openedBy: '', openedAt: expect.any(String), isBackground: true, status: 'running' }])
})

test('cmod task start outside Claude Code names the session it needs, and starts nothing', async () => {
  const home = await backgroundHome()

  const started = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: '' }, 'task', 'start', '--title', 'Upgrade', 'Upgrade every dependency.')

  expect([started.exitCode, started.stderr]).toEqual([1, 'cmod task: cmod task start runs inside Claude Code, which names the session the task belongs to in CLAUDE_CODE_SESSION_ID.\n'])
})
