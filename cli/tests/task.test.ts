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

test('cmod task start --clone resumes the starting session as a fork in the background, and its task names the session it copies', async () => {
  const home = await backgroundHome()

  const started = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'starter' }, 'task', 'start', '--title', 'Try SQL', '--clone', '--json', 'Rebuild this on SQL.')
  const args = await lines(home, 'bg-args')

  expect(JSON.parse(started.stdout)).toEqual({ id: sessionId, title: 'Try SQL', forkedFrom: 'starter', openedBy: '', openedAt: expect.any(String), isBackground: true })
  expect(args.filter((arg) => !arg.startsWith('{'))).toEqual(['--bg', '--resume', 'starter', '--fork-session', '--settings', '--', 'Rebuild this on SQL.'])
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
