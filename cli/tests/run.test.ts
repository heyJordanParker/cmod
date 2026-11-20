import { afterAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { cmodWith, deleteTemporaryHomes, startCmod, temporaryHome, writeFiles } from './cmod.js'

afterAll(deleteTemporaryHomes)

const transcript = (session: string, project: string, prompt: string) =>
  [
    { type: 'user', uuid: `${session}-u`, sessionId: session, timestamp: '2026-11-04T10:00:00.000Z', cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: prompt } },
    { type: 'assistant', uuid: `${session}-a`, sessionId: session, timestamp: '2026-11-04T10:00:02.000Z', cwd: project, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }] } },
  ]
    .map((row) => `${JSON.stringify(row)}\n`)
    .join('')

test.concurrent("a cmod run script reads every session cmod serve reads through the sessions import, and its own arguments from Bun.argv", async () => {
  const home = await temporaryHome()
  const project = join(home, 'work/app')
  await writeFiles(home, {
    [`.claude/projects/${project.replace(/[^A-Za-z0-9]/g, '-')}/s1.jsonl`]: transcript('s1', project, 'Fix the login test'),
    'list.ts': "import { sessions } from '@cmodjs/core/mod.js'\nconst found = await sessions.list({ everyProject: true })\nconst first = await sessions.get(Bun.argv[2] ?? '')\nconsole.log(JSON.stringify({ ids: found.map((session) => session.id), title: first.title }))\n",
  })
  const serving = startCmod(home, 'serve')
  await serving.firstLine()

  const ran = await cmodWith(home, {}, 'run', 'list.ts', 's1')
  serving.child.kill()

  expect([ran.exitCode, ran.stderr]).toEqual([0, ''])
  expect(JSON.parse(ran.stdout)).toEqual({ ids: ['s1'], title: 'Fix the login test' })
}, 30_000)

test.concurrent('cmod run names a script it cannot find, and a script that imports what belongs to a session', async () => {
  const home = await temporaryHome()
  await writeFiles(home, { 'files.ts': "import { fs } from '@cmodjs/core/mod.js'\nawait fs.read('notes.md')\n" })

  const missing = await cmodWith(home, {}, 'run', 'gone.ts')
  const session = await cmodWith(home, {}, 'run', 'files.ts')

  expect([missing.exitCode, missing.stderr]).toEqual([1, `cmod run: there is no script at ${join(home, 'gone.ts')}.\n`])
  expect([session.exitCode, session.stderr]).toEqual([1, 'cmod run: a cmod run script imports only sessions, provide and providers from @cmodjs/core/mod.js, because fs belongs to a Claude Code session.\n'])
}, 30_000)
