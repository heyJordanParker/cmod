import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { appendFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { openHistory, searchQuery } from '../src/history.js'
import { cmod, cmodWith, deleteTemporaryHomes, startCmod, temporaryHome, writeFiles } from './cmod.js'

afterEach(deleteTemporaryHomes)

const at = (second: number, day = 11) => `2026-10-${String(day).padStart(2, '0')}T10:00:${String(second).padStart(2, '0')}.000Z`

const lines = (rows: readonly object[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join('')

const projectFolder = (project: string) => `.claude/projects/${project.replace(/[^A-Za-z0-9]/g, '-')}`

const ids = (found: unknown) => (found as { id: string }[]).map((message) => message.id)

function conversation(project: string) {
  return [
    { type: 'user', uuid: 'u1', timestamp: at(0), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: 'Rename the tree pane' } },
    { type: 'assistant', uuid: 'a1', timestamp: at(1), cwd: project, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'I will find it first.' }, { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { prompt: 'find the pane file' } }] } },
    { type: 'user', uuid: 'r1', timestamp: at(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'found src/panes/tree.tsx' }] } },
    { type: 'user', uuid: 'p1', timestamp: at(6), origin: { kind: 'plugin', name: 'modes' }, message: { role: 'user', content: 'Switch to build mode' } },
    { type: 'custom-title', customTitle: 'Tree pane rename', sessionId: 's1' },
  ]
}

async function writeHistory(home: string): Promise<{ project: string; other: string }> {
  const project = join(home, 'work/app')
  const other = join(home, 'work/site')
  await writeFiles(home, {
    [`${projectFolder(project)}/s1.jsonl`]: lines(conversation(project)),
    [`${projectFolder(project)}/s1/subagents/agent-a7.jsonl`]: lines([{ type: 'user', uuid: 'x1', timestamp: at(2), message: { role: 'user', content: 'find the pane file' } }]),
    [`${projectFolder(project)}/s1/subagents/agent-a7.meta.json`]: JSON.stringify({ agentType: 'explorer', description: 'Find the pane', toolUseId: 'toolu_1' }),
    [`${projectFolder(project)}/s0.jsonl`]: lines([{ type: 'user', uuid: 'o1', timestamp: at(0, 1), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: 'Add the tree pane' } }]),
    [`${projectFolder(other)}/s9.jsonl`]: lines([{ type: 'user', uuid: 'w1', timestamp: at(30), cwd: other, origin: { kind: 'scheduled-trigger' }, message: { role: 'user', content: 'Rename the deploy job' } }]),
  })
  return { project, other }
}

const json = async (home: string, ...args: string[]): Promise<unknown> => {
  const result = await cmod(home, 'history', ...args, '--json')
  expect(result.stderr).toBe('')
  return JSON.parse(result.stdout)
}

function firstTurn() {
  return { id: 'u1', type: 'prompt', at: at(0), session: 's1', context: 1, turn: 'u1', text: 'Rename the tree pane', from: { type: 'person' } }
}

function mainMessages(project: string) {
  return [
    firstTurn(),
    { id: 'a1:0', type: 'reply', at: at(1), session: 's1', context: 1, turn: 'u1', text: 'I will find it first.' },
    { id: 'a1:1', type: 'toolCall', at: at(1), session: 's1', context: 1, turn: 'u1', callId: 'toolu_1', name: 'Agent', input: { prompt: 'find the pane file' }, cwd: project, files: { read: [], changed: [] } },
    { id: 'r1', type: 'toolResult', at: at(5), session: 's1', context: 1, turn: 'u1', callId: 'toolu_1', name: 'Agent', input: { prompt: 'find the pane file' }, cwd: project, files: { read: [], changed: [] }, output: 'found src/panes/tree.tsx', isError: false },
    { id: 'p1', type: 'prompt', at: at(6), session: 's1', context: 1, turn: 'p1', text: 'Switch to build mode', from: { type: 'mod', name: 'modes' } },
  ]
}

test('messages reads a conversation as typed messages placed in their context and turn, and --task reads a task', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  expect(await json(home, 'messages', 's1', '--project', project)).toEqual(mainMessages(project))
  expect(await json(home, 'messages', 's1', '--project', project, '--task', 'a7')).toEqual([{ id: 'x1', type: 'prompt', at: at(2), session: 's1', context: 1, task: 'a7', turn: 'x1', text: 'find the pane file', from: { type: 'task' } }])
  expect(ids(await json(home, 'messages', 's1', '--project', project, '--last', '1'))).toEqual(['p1'])
  expect(ids(await json(home, 'messages', 's1', '--project', project, '--after', 'a1:1'))).toEqual(['r1', 'p1'])
  expect(ids(await json(home, 'messages', 's1', '--project', project, '--turn', 'p1'))).toEqual(['p1'])
})

test('turns, contexts, tasks, and goal read the shape of a conversation', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  expect(await json(home, 'turns', 's1', '--project', project)).toEqual([
    { prompt: firstTurn(), context: 1, openedAt: at(0), closedAt: at(6) },
    { prompt: mainMessages(project)[4], context: 1, openedAt: at(6) },
  ])
  expect(await json(home, 'turns', 's1', '--project', project, '--last', '1')).toEqual([{ prompt: mainMessages(project)[4], context: 1, openedAt: at(6) }])
  expect(await json(home, 'contexts', 's1', '--project', project)).toEqual([{ number: 1, openedAt: at(0) }])
  expect(await json(home, 'tasks', 's1', '--project', project)).toEqual([{ id: 'a7', title: 'Find the pane', agentType: 'explorer', openedBy: 'toolu_1', openedAt: at(1), closedAt: at(5) }])
  expect(await json(home, 'goal', 's1', '--project', project)).toEqual({ text: 'Rename the tree pane' })
})

test("--task reads the agent a task runs like a conversation: its turns, context, goal, and usage", async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await appendFile(join(home, `${projectFolder(project)}/s1/subagents/agent-a7.jsonl`), lines([{ type: 'assistant', uuid: 'x2', timestamp: at(3), message: { role: 'assistant', model: 'claude-haiku-5', content: [{ type: 'text', text: 'It is src/panes/tree.tsx.' }], usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 80, output_tokens: 10 } } }]))
  const prompt = { id: 'x1', type: 'prompt', at: at(2), session: 's1', context: 1, task: 'a7', turn: 'x1', text: 'find the pane file', from: { type: 'task' } }

  expect(await json(home, 'turns', 's1', '--project', project, '--task', 'a7')).toEqual([{ prompt, context: 1, openedAt: at(2), closedAt: at(5) }])
  expect(await json(home, 'contexts', 's1', '--project', project, '--task', 'a7')).toEqual([{ number: 1, openedAt: at(1), closedAt: at(5), task: 'a7' }])
  expect(await json(home, 'goal', 's1', '--project', project, '--task', 'a7')).toEqual({ text: 'find the pane file' })
  expect(await json(home, 'usage', 's1', '--project', project, '--task', 'a7')).toEqual({ model: 'claude-haiku-5', contextWindow: { tokenCount: 1000 } })
  expect(await json(home, 'usage', 's1', '--project', project)).toEqual({ model: '', contextWindow: {} })
})

test('search --session keeps one conversation, and --task, --turn, and --goal keep a part of it', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  expect(ids(await json(home, 'search', 'pane', '--project', project, '--session', 's1'))).toEqual(['x1', 'a1:1', 'u1'])
  expect(ids(await json(home, 'search', 'pane', '--project', project, '--session', 's1', '--task', 'a7'))).toEqual(['x1'])
  expect(ids(await json(home, 'search', 'pane', '--project', project, '--session', 's1', '--goal'))).toEqual(['x1'])
  expect(ids(await json(home, 'search', 'pane', '--project', project, '--session', 's1', '--turn', 'u1'))).toEqual(['a1:1', 'u1'])
  expect(ids(await json(home, 'search', 'pane', '--project', project, '--session', 's1', '--context', '1'))).toEqual(['a1:1', 'u1'])
  expect(ids(await json(home, 'search', 'pane', '--project', project, '--session', 's1', '--task', 'a7', '--context', '1'))).toEqual(['x1'])
  expect((await cmod(home, 'history', 'search', 'pane', '--task', 'a7')).stderr).toContain('cmod history search takes --task, --turn, --context, and --goal only with --session.')
})

test('a compaction closes the context and opens the next, and a turn closes when Claude finishes', async () => {
  const home = await temporaryHome()
  const project = join(home, 'work/app')
  await writeFiles(home, {
    [`${projectFolder(project)}/s1.jsonl`]: lines([
      ...conversation(project).slice(0, 2),
      { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: at(3), durationMs: 3000 },
      { type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: at(4), content: 'Conversation compacted' },
      { type: 'user', uuid: 'u2', timestamp: at(7), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: 'Now the file pane' } },
    ]),
  })

  expect(await json(home, 'contexts', 's1', '--project', project)).toEqual([
    { number: 1, openedAt: at(0), closedAt: at(4) },
    { number: 2, openedAt: at(4) },
  ])
  expect(await json(home, 'turns', 's1', '--project', project, '--context', '2')).toEqual([{ prompt: { id: 'u2', type: 'prompt', at: at(7), session: 's1', context: 2, turn: 'u2', text: 'Now the file pane', from: { type: 'person' } }, context: 2, openedAt: at(7) }])
  expect((await json(home, 'turns', 's1', '--project', project, '--context', '1')) as unknown[]).toEqual([{ prompt: firstTurn(), context: 1, openedAt: at(0), closedAt: at(3) }])
})

test('the goal a mod saved replaces the first prompt, and state resumes from it', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await writeFiles(home, { '.local/share/cmod/data/cmod/goals/s1.txt': 'Ship the tree pane' })

  expect(await json(home, 'goal', 's1', '--project', project)).toEqual({ text: 'Ship the tree pane' })
  expect(await json(home, 'state', 's1', '--project', project)).toMatchObject({ session: 's1', context: 1, goal: 'Ship the tree pane', turn: { prompt: { id: 'p1' } } })
})

test('messages and search print one line per message, with the local time, and search adds the date and session', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  const messages = await cmodWith(home, { TZ: 'UTC' }, 'history', 'messages', 's1', '--project', project)
  const found = await cmodWith(home, { TZ: 'UTC' }, 'history', 'search', 'rename', '--project', project)

  expect(messages.stdout).toBe(
    [
      '10:00  person   Rename the tree pane',
      '10:00  claude   I will find it first.',
      '10:00  claude   Agent  {"prompt":"find the pane file"}',
      '10:00  →        found src/panes/tree.tsx',
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
  await appendFile(join(home, `${projectFolder(project)}/s1.jsonl`), lines([{ type: 'assistant', uuid: 'a2', timestamp: at(9), message: { role: 'assistant', content: [{ type: 'text', text: 'Build mode is on.' }] } }]))

  expect(await json(home, 'messages', 's1', '--project', project, '--after', 'p1')).toEqual([{ id: 'a2', type: 'reply', at: at(9), session: 's1', context: 1, turn: 'p1', text: 'Build mode is on.' }])
})

test('follow prints a row Claude Code was still writing when follow started', async () => {
  const home = await temporaryHome()
  const project = join(home, 'work/app')
  const prompt = JSON.stringify({ type: 'user', uuid: 'u1', timestamp: at(0), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: 'Rename the pane' } })
  const reply = JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: at(1), message: { role: 'assistant', content: [{ type: 'text', text: 'Renamed.' }] } })
  const half = Math.floor(reply.length / 2)
  await writeFiles(home, { [`${projectFolder(project)}/s1.jsonl`]: `${prompt}\n${reply.slice(0, half)}` })
  const following = startCmod(home, 'history', 'follow', 's1', '--project', project, '--json')
  await following.waitForOutput('Following s1')

  await appendFile(join(home, `${projectFolder(project)}/s1.jsonl`), `${reply.slice(half)}\n${lines([{ type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: at(2) }])}`)
  await following.waitForOutput('"turnEnd"')
  following.child.kill()
  const { stdout } = await following.done

  expect(stdout).toContain('"Renamed."')
})

test('follow prints each change saved after it started, and nothing saved before', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  const following = startCmod(home, 'history', 'follow', 's1', '--project', project, '--json')
  await following.waitForOutput('Following s1')

  await appendFile(join(home, `${projectFolder(project)}/s1.jsonl`), lines([{ type: 'assistant', uuid: 'a2', timestamp: at(9), message: { role: 'assistant', content: [{ type: 'text', text: 'Build mode is on.' }] } }, { type: 'system', subtype: 'turn_duration', uuid: 'd2', timestamp: at(10) }]))
  await following.waitForOutput('"turnEnd"')
  following.child.kill()
  const { stdout } = await following.done

  expect(stdout.trim().split('\n').map((line) => JSON.parse(line) as unknown)).toEqual([
    { session: 's1', isInProject: true, change: { type: 'message', message: { id: 'a2', type: 'reply', at: at(9), session: 's1', context: 1, turn: 'p1', text: 'Build mode is on.' } } },
    { session: 's1', isInProject: true, change: { type: 'turnEnd', turn: { prompt: mainMessages(project)[4], context: 1, openedAt: at(6), closedAt: at(10) } } },
  ])
})

test('follow --running follows a session of the project that starts after it, and no other project', async () => {
  const home = await temporaryHome()
  const { project, other } = await writeHistory(home)
  const following = startCmod(home, 'history', 'follow', '--running', '--project', project, '--json')
  await following.waitForOutput('Following every running session of the project')

  await writeFiles(home, {
    '.claude/sessions/1.json': JSON.stringify({ pid: process.pid, sessionId: 's2', cwd: project }),
    '.claude/sessions/2.json': JSON.stringify({ pid: process.pid, sessionId: 's8', cwd: other }),
  })
  await Bun.sleep(500)
  await writeFiles(home, {
    [`${projectFolder(other)}/s8.jsonl`]: lines([{ type: 'user', uuid: 'w2', timestamp: at(40), cwd: other, origin: { kind: 'human' }, message: { role: 'user', content: 'Ship the site' } }]),
    [`${projectFolder(project)}/s2.jsonl`]: lines([{ type: 'user', uuid: 'n1', timestamp: at(41), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: 'Add a search pane' } }]),
  })
  await following.waitForOutput('"Add a search pane"')
  following.child.kill()
  const { stdout } = await following.done

  expect([...new Set(stdout.trim().split('\n').map((line) => (JSON.parse(line) as { session: string }).session))]).toEqual(['s2'])
})

test('the conversation the command runs in has no messages before its first is saved, and another unsaved session id fails', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  const running = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 's2' }, 'history', 'messages', '--project', project, '--json')
  const unknown = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 's2' }, 'history', 'messages', 's3', '--project', project, '--json')

  expect([running.exitCode, running.stdout]).toEqual([0, '[]\n'])
  expect([unknown.exitCode, unknown.stderr]).toEqual([1, `cmod history: No Claude Code transcript is named s3.jsonl under ${join(home, '.claude/projects')}. cmod history sessions --all lists the sessions.\n`])
})

test("sessions lists the project's conversations newest first, and --all, --since, and --running change the scope", async () => {
  const home = await temporaryHome()
  const { project, other } = await writeHistory(home)
  await writeFiles(home, { '.claude/sessions/1.json': JSON.stringify({ pid: process.pid, sessionId: 's1', cwd: project }), '.claude/sessions/2.json': JSON.stringify({ pid: 2 ** 22 + 7, sessionId: 's0', cwd: project }) })

  expect(await json(home, 'sessions', '--project', project)).toEqual([
    { id: 's1', title: 'Tree pane rename', project, cwd: project, model: 'claude-opus-5-5', startedAt: at(0), lastAt: at(6), isRunning: true },
    { id: 's0', title: 'Add the tree pane', project, cwd: project, model: '', startedAt: at(0, 1), lastAt: at(0, 1), isRunning: false },
  ])
  expect(ids(await json(home, 'sessions', '--project', project, '--all'))).toEqual(['s9', 's1', 's0'])
  expect(ids(await json(home, 'sessions', '--project', other, '--since', '2026-10-05'))).toEqual(['s9'])
  expect(ids(await json(home, 'sessions', '--project', project, '--since', '2026-10-05'))).toEqual(['s1'])
  expect(ids(await json(home, 'sessions', '--project', project, '--running'))).toEqual(['s1'])
  expect(ids(await json(home, 'search', 'tree pane', '--project', project, '--running'))).toEqual(['u1'])
})

test('search finds every message whose text or tool input holds the text, newest first, in the project or every project, and never a tool result', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  expect(ids(await json(home, 'search', 'RENAME', '--project', project))).toEqual(['u1'])
  expect(ids(await json(home, 'search', 'rename', '--project', project, '--all'))).toEqual(['w1', 'u1'])
  expect(ids(await json(home, 'search', 'pane file', '--project', project))).toEqual(['x1', 'a1:1'])
  expect(await json(home, 'search', 'panes/tree.tsx', '--project', project)).toEqual([])
})

test("a subagent whose meta.json is empty still reads, as a task opened at its first message", async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await writeFiles(home, { [`${projectFolder(project)}/s1/subagents/agent-a7.meta.json`]: '' })

  expect(ids(await json(home, 'messages', 's1', '--project', project, '--task', 'a7'))).toEqual(['x1'])
  expect(await json(home, 'tasks', 's1', '--project', project)).toEqual([{ id: 'a7', title: '', agentType: 'general-purpose', openedBy: '', openedAt: at(2) }])
})

test('two reads started together on a new transcript save each message once', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  await Promise.all([json(home, 'messages', 's1', '--project', project), json(home, 'messages', 's1', '--project', project, '--task', 'a7'), json(home, 'search', 'tree pane', '--project', project)])

  expect(await json(home, 'messages', 's1', '--project', project)).toEqual(mainMessages(project))
  expect(await json(home, 'turns', 's1', '--project', project)).toHaveLength(2)
})

test('search returns the newest messages up to --limit, and --before pages through a forked copy without repeats or gaps', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await writeFiles(home, { [`${projectFolder(project)}/s2.jsonl`]: lines([{ ...conversation(project)[0], forkedFrom: { sessionId: 's1' } }]) })

  const pages = [await json(home, 'search', 'rename', '--project', project, '--limit', '1')]
  pages.push(await json(home, 'search', 'rename', '--project', project, '--limit', '1', '--before', 's2:u1'))
  pages.push(await json(home, 'search', 'rename', '--project', project, '--limit', '1', '--before', 's1:u1'))

  expect(pages.map((page) => (page as { session: string; id: string }[]).map((message) => `${message.session}:${message.id}`))).toEqual([['s2:u1'], ['s1:u1'], []])
})

test('search finds a value in a tool input, misses one past its first 1,024 characters, and refuses fewer than 3 characters', async () => {
  const home = await temporaryHome()
  const project = join(home, 'work/app')
  const write = { type: 'tool_use', id: 'toolu_9', name: 'Write', input: { file_path: 'notes.md', content: `${'x'.repeat(1100)}needle-after-the-cut` } }
  const bash = { type: 'tool_use', id: 'toolu_8', name: 'Bash', input: { command: 'bun run deploy-preview' } }
  await writeFiles(home, { [`${projectFolder(project)}/s1.jsonl`]: lines([{ type: 'assistant', uuid: 'a1', timestamp: at(1), cwd: project, message: { role: 'assistant', content: [bash, write] } }]) })

  expect(ids(await json(home, 'search', 'deploy-preview', '--project', project))).toEqual(['a1:0'])
  expect(await json(home, 'search', 'needle-after-the-cut', '--project', project)).toEqual([])
  expect(await cmod(home, 'history', 'search', 'ab', '--project', project)).toMatchObject({ exitCode: 1, stderr: 'cmod history: cmod history search takes at least 3 characters.\n' })
})

test('sessions leaves out a session no one prompted, and lists one whose first prompt follows 64 KB of hook rows', async () => {
  const home = await temporaryHome()
  const project = join(home, 'work/app')
  const hook = (uuid: string, second: number) => ({ type: 'attachment', uuid, timestamp: at(second), cwd: project, attachment: { type: 'hook_success', content: 'x'.repeat(70_000) } })
  await writeFiles(home, {
    [`${projectFolder(project)}/quiet.jsonl`]: lines([hook('h1', 1)]),
    [`${projectFolder(project)}/late.jsonl`]: lines([hook('h2', 2), hook('h3', 3), { type: 'user', uuid: 'u9', timestamp: at(4), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: 'Start the late session' } }]),
  })
  const late = { id: 'late', title: 'Start the late session', project, cwd: project, model: '', startedAt: at(4), lastAt: at(4), isRunning: false }

  expect(await json(home, 'sessions', '--project', project)).toEqual([late])
  await cmod(home, 'history', 'index')
  expect(await json(home, 'sessions', '--project', project)).toEqual([late])
})

test('an index made by an older cmod is deleted, and the index is history-6.sqlite', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  const older = ['history.sqlite', 'history-2.sqlite', 'history-3.sqlite', 'history-4.sqlite', 'history-5.sqlite']
  await writeFiles(home, Object.fromEntries(older.map((name) => [`.local/share/cmod/${name}`, 'an older index\n'])))

  await json(home, 'sessions', '--project', project)

  expect([...older, 'history-6.sqlite'].map((name) => existsSync(join(home, '.local/share/cmod', name)))).toEqual([false, false, false, false, false, true])
})

test("a task's compaction gives its owner a new context, and contexts --task lists both", async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await appendFile(join(home, `${projectFolder(project)}/s1/subagents/agent-a7.jsonl`), lines([{ type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: at(3) }]))

  expect(await json(home, 'contexts', 's1', '--task', 'a7', '--project', project)).toEqual([
    { number: 1, openedAt: at(1), closedAt: at(3), task: 'a7' },
    { number: 2, openedAt: at(3), closedAt: at(5), task: 'a7' },
  ])
})

test("a deleted project folder's sessions leave the index after cmod history index", async () => {
  const home = await temporaryHome()
  const { project, other } = await writeHistory(home)
  await cmod(home, 'history', 'index')
  await rm(join(home, projectFolder(other)), { recursive: true })

  await cmod(home, 'history', 'index')

  expect(ids(await json(home, 'search', 'rename', '--project', project, '--all'))).toEqual(['u1'])
})

test('reading an unchanged transcript takes no write lock on the index', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await appendFile(join(home, `${projectFolder(project)}/s1.jsonl`), '{"type":"user","uuid":"half-written"')
  await json(home, 'sessions', '--project', project)
  await json(home, 'messages', 's1', '--project', project)
  const holder = new Database(join(home, '.local/share/cmod/history-3.sqlite'))
  holder.exec('begin immediate')

  const startedAt = Date.now()
  const listed = await cmod(home, 'history', 'sessions', '--project', project, '--json')
  const read = await cmod(home, 'history', 'messages', 's1', '--project', project, '--json')
  holder.exec('rollback')
  holder.close()

  expect([listed.exitCode, read.exitCode, Date.now() - startedAt < 5000]).toEqual([0, 0, true])
})

test('a transcript rewritten under the index returns its new messages', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await json(home, 'messages', 's1', '--project', project)
  const rewritten = [{ type: 'user', uuid: 'n1', timestamp: at(20), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: `A new first prompt ${'that is longer than before '.repeat(20)}` } }]
  await writeFiles(home, { [`${projectFolder(project)}/s1.jsonl`]: lines([...rewritten, ...conversation(project)]) })

  expect(ids(await json(home, 'messages', 's1', '--project', project))).toEqual(['u1', 'a1:0', 'a1:1', 'r1', 'p1', 'n1'])
  expect(await json(home, 'tasks', 's1', '--project', project)).toEqual([{ id: 'a7', title: 'Find the pane', agentType: 'explorer', openedBy: 'toolu_1', openedAt: at(1), closedAt: at(5) }])
})

test('a search with many matches walks the time order of its scope and never sorts every match', async () => {
  const home = await temporaryHome()
  const before = process.env['XDG_DATA_HOME']
  process.env['XDG_DATA_HOME'] = join(home, 'data')
  const db = openHistory()
  try {
    const planOf = (isScoped: boolean) =>
      db
        .query<{ detail: string }, (string | number)[]>(`explain query plan ${searchQuery({ isScoped, isRunning: false, hasBefore: true, path: isScoped ? 'folder' : 'time' })}`)
        .all('"tree"', ...(isScoped ? ['/folder'] : []), '', '', 0, 50)
        .map((row) => row.detail)
    expect([planOf(false)[0], planOf(true)[0]]).toEqual([expect.stringContaining('messages_by_time'), expect.stringContaining('messages_by_folder')])
    expect([...planOf(false), ...planOf(true)].some((detail) => detail.includes('TEMP B-TREE'))).toBe(false)
  } finally {
    db.close()
    process.env['XDG_DATA_HOME'] = before
  }
})

test('a conversation whose transcript was deleted leaves the sessions list and the search', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await json(home, 'search', 'tree pane', '--project', project)
  await rm(join(home, `${projectFolder(project)}/s0.jsonl`))

  expect(ids(await json(home, 'sessions', '--project', project))).toEqual(['s1'])
  expect(ids(await json(home, 'search', 'tree pane', '--project', project))).toEqual(['u1'])
})
