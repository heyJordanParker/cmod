import { afterEach, expect, test } from 'bun:test'
import { appendFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { cmod, cmodWith, deleteTemporaryHomes, startCmod, temporaryHome, writeFiles } from './cmod.js'

afterEach(deleteTemporaryHomes)

const at = (second: number, day = 11) => `2026-10-${String(day).padStart(2, '0')}T10:00:${String(second).padStart(2, '0')}.000Z`

const lines = (rows: readonly object[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join('')

function conversation(project: string) {
  return [
    { type: 'user', uuid: 'u1', timestamp: at(0), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: 'Rename the tree pane' } },
    { type: 'assistant', uuid: 'a1', timestamp: at(1), message: { role: 'assistant', content: [{ type: 'text', text: 'I will find it first.' }, { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { prompt: 'find the pane file' } }] } },
    { type: 'user', uuid: 'r1', timestamp: at(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'found src/panes/tree.tsx' }] } },
    { type: 'user', uuid: 'p1', timestamp: at(6), origin: { kind: 'plugin', name: 'modes' }, message: { role: 'user', content: 'Switch to build mode' } },
    { type: 'custom-title', customTitle: 'Tree pane rename', sessionId: 's1' },
  ]
}

async function writeHistory(home: string): Promise<{ project: string; other: string }> {
  const project = join(home, 'work/app')
  const other = join(home, 'work/site')
  const folder = (path: string) => `.claude/projects/${path.replace(/[^A-Za-z0-9]/g, '-')}`
  await writeFiles(home, {
    [`${folder(project)}/s1.jsonl`]: lines(conversation(project)),
    [`${folder(project)}/s1/subagents/agent-a7.jsonl`]: lines([{ type: 'user', uuid: 'x1', timestamp: at(2), message: { role: 'user', content: 'find the pane file' } }]),
    [`${folder(project)}/s1/subagents/agent-a7.meta.json`]: JSON.stringify({ agentType: 'explorer', toolUseId: 'toolu_1' }),
    [`${folder(project)}/s0.jsonl`]: lines([{ type: 'user', uuid: 'o1', timestamp: at(0, 1), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: 'Add the tree pane' } }]),
    [`${folder(other)}/s9.jsonl`]: lines([{ type: 'user', uuid: 'w1', timestamp: at(30), cwd: other, origin: { kind: 'scheduled-trigger' }, message: { role: 'user', content: 'Rename the deploy job' } }]),
  })
  return { project, other }
}

const json = async (home: string, ...args: string[]): Promise<unknown> => {
  const result = await cmod(home, 'history', ...args, '--json')
  expect(result.stderr).toBe('')
  return JSON.parse(result.stdout)
}

test("messages reads a conversation as messages with their sender, each tool call's result, and the subagent it started", async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  expect(await json(home, 'messages', 's1', '--project', project)).toEqual([
    { id: 'u1', session: 's1', at: at(0), from: { kind: 'person' }, text: 'Rename the tree pane', tools: [] },
    { id: 'a1', session: 's1', at: at(1), from: { kind: 'claude' }, text: 'I will find it first.', tools: [{ tool: 'Agent', input: { prompt: 'find the pane file' }, id: 'toolu_1', subagent: 'a7', result: 'found src/panes/tree.tsx' }] },
    { id: 'p1', session: 's1', at: at(6), from: { kind: 'mod', name: 'modes' }, text: 'Switch to build mode', tools: [] },
  ])
  expect(await json(home, 'messages', 's1', '--project', project, '--agent', 'a7')).toEqual([{ id: 'x1', session: 's1', agent: 'a7', at: at(2), from: { kind: 'agent' }, text: 'find the pane file', tools: [] }])
  expect(((await json(home, 'messages', 's1', '--project', project, '--last', '1')) as { id: string }[]).map((message) => message.id)).toEqual(['p1'])
  expect(((await json(home, 'messages', 's1', '--project', project, '--after', 'u1', '--limit', '1')) as { id: string }[]).map((message) => message.id)).toEqual(['a1'])
})

test('messages and search print one line per message and tool call, with the local time, and search adds the date and session', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  const messages = await cmodWith(home, { TZ: 'UTC' }, 'history', 'messages', 's1', '--project', project)
  const found = await cmodWith(home, { TZ: 'UTC' }, 'history', 'search', 'rename', '--project', project)

  expect(messages.stdout).toBe(
    [
      '10:00  person   Rename the tree pane',
      '10:00  claude   I will find it first.',
      '10:00  claude   Agent  {"prompt":"find the pane file"}  → found src/panes/tree.tsx',
      '10:00  mod modes  Switch to build mode',
      '',
    ].join('\n'),
  )
  expect(found.stdout).toBe('2026-10-11 10:00  s1  person   Rename the tree pane\n')
})

test('messages after the last one read returns only the lines saved since', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await json(home, 'messages', 's1', '--project', project)
  await appendFile(join(home, `.claude/projects/${project.replace(/[^A-Za-z0-9]/g, '-')}/s1.jsonl`), lines([{ type: 'assistant', uuid: 'a2', timestamp: at(9), message: { role: 'assistant', content: [{ type: 'text', text: 'Build mode is on.' }] } }]))

  expect(await json(home, 'messages', 's1', '--project', project, '--after', 'p1')).toEqual([{ id: 'a2', session: 's1', at: at(9), from: { kind: 'claude' }, text: 'Build mode is on.', tools: [] }])
})

test('messages --follow prints each message saved after it started', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  const following = startCmod(home, 'history', 'messages', 's1', '--project', project, '--follow')
  await following.waitForOutput('Switch to build mode')

  await appendFile(join(home, `.claude/projects/${project.replace(/[^A-Za-z0-9]/g, '-')}/s1.jsonl`), lines([{ type: 'assistant', uuid: 'a2', timestamp: at(9), message: { role: 'assistant', content: [{ type: 'text', text: 'Build mode is on.' }] } }]))
  await following.waitForOutput('Build mode is on.')
  following.child.kill()
})

test('the conversation the command runs in has no messages before its first is saved, and another unsaved session id fails', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  const running = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 's2' }, 'history', 'messages', '--project', project, '--json')
  const unknown = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 's2' }, 'history', 'messages', 's3', '--project', project, '--json')

  expect([running.exitCode, running.stdout]).toEqual([0, '[]\n'])
  expect([unknown.exitCode, unknown.stderr]).toEqual([1, `cmod history: No Claude Code transcript is named s3.jsonl under ${join(home, '.claude/projects')}. cmod history sessions --all lists the sessions.\n`])
})

test("sessions lists the project's conversations newest first with their titles, and --all and --since change the scope", async () => {
  const home = await temporaryHome()
  const { project, other } = await writeHistory(home)

  expect(await json(home, 'sessions', '--project', project)).toEqual([
    { id: 's1', title: 'Tree pane rename', project, startedAt: at(0), lastAt: at(6) },
    { id: 's0', title: 'Add the tree pane', project, startedAt: at(0, 1), lastAt: at(0, 1) },
  ])
  expect(((await json(home, 'sessions', '--project', project, '--all')) as { id: string }[]).map((session) => session.id)).toEqual(['s9', 's1', 's0'])
  expect(((await json(home, 'sessions', '--project', other, '--since', '2026-10-05')) as { id: string }[]).map((session) => session.id)).toEqual(['s9'])
  expect(((await json(home, 'sessions', '--project', project, '--since', '2026-10-05')) as { id: string }[]).map((session) => session.id)).toEqual(['s1'])
})

test('search finds every message whose text or tool input holds the text, newest first, in the project or every project, and never a tool result', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  expect(((await json(home, 'search', 'RENAME', '--project', project)) as { id: string }[]).map((message) => message.id)).toEqual(['u1'])
  expect(((await json(home, 'search', 'rename', '--project', project, '--all')) as { id: string }[]).map((message) => message.id)).toEqual(['w1', 'u1'])
  expect(((await json(home, 'search', 'pane file', '--project', project)) as { id: string }[]).map((message) => message.id)).toEqual(['x1', 'a1'])
  expect(await json(home, 'search', 'panes/tree.tsx', '--project', project)).toEqual([])
})

test('a conversation whose transcript was deleted leaves the sessions list and the search', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await json(home, 'search', 'tree pane', '--project', project)
  await rm(join(home, `.claude/projects/${project.replace(/[^A-Za-z0-9]/g, '-')}/s0.jsonl`))

  expect(((await json(home, 'sessions', '--project', project)) as { id: string }[]).map((session) => session.id)).toEqual(['s1'])
  expect(((await json(home, 'search', 'tree pane', '--project', project)) as { id: string }[]).map((message) => message.id)).toEqual(['u1'])
})
