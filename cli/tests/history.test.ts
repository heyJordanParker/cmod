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

const projectFolder = (project: string) => `.claude/projects/${project.replace(/[^A-Za-z0-9]/g, '-')}`

const ids = (found: unknown) => (found as { id: string }[]).map((message) => message.id)

test('messages --subagents reads the conversation with every subagent, in the order they were saved, and a later line comes after them', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  expect(ids(await json(home, 'messages', 's1', '--project', project, '--subagents'))).toEqual(['u1', 'a1', 'x1', 'p1'])
  await appendFile(join(home, `${projectFolder(project)}/s1/subagents/agent-a7.jsonl`), lines([{ type: 'assistant', uuid: 'x2', timestamp: at(3), message: { role: 'assistant', content: [{ type: 'text', text: 'It is src/panes/tree.tsx.' }] } }]))

  expect(ids(await json(home, 'messages', 's1', '--project', project, '--subagents', '--after', 'p1'))).toEqual(['x2'])
})

test("a subagent whose meta.json is empty still reads, without a link to its Agent call", async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await writeFiles(home, { [`${projectFolder(project)}/s1/subagents/agent-a7.meta.json`]: '' })

  expect(ids(await json(home, 'messages', 's1', '--project', project, '--subagents'))).toEqual(['u1', 'a1', 'x1', 'p1'])
})

test('two reads started together on a new transcript save each message once, and the Agent call keeps its result and subagent', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  await Promise.all([json(home, 'messages', 's1', '--project', project), json(home, 'messages', 's1', '--project', project, '--agent', 'a7'), json(home, 'search', 'tree pane', '--project', project)])

  expect(await json(home, 'messages', 's1', '--project', project)).toEqual([
    { id: 'u1', session: 's1', at: at(0), from: { kind: 'person' }, text: 'Rename the tree pane', tools: [] },
    { id: 'a1', session: 's1', at: at(1), from: { kind: 'claude' }, text: 'I will find it first.', tools: [{ tool: 'Agent', input: { prompt: 'find the pane file' }, id: 'toolu_1', subagent: 'a7', result: 'found src/panes/tree.tsx' }] },
    { id: 'p1', session: 's1', at: at(6), from: { kind: 'mod', name: 'modes' }, text: 'Switch to build mode', tools: [] },
  ])
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

  expect(ids(await json(home, 'search', 'deploy-preview', '--project', project))).toEqual(['a1'])
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

  expect(await json(home, 'sessions', '--project', project)).toEqual([{ id: 'late', title: 'Start the late session', project, startedAt: at(4), lastAt: at(4) }])
  await cmod(home, 'history', 'index')
  expect(await json(home, 'sessions', '--project', project)).toEqual([{ id: 'late', title: 'Start the late session', project, startedAt: at(4), lastAt: at(4) }])
})

test('an index made by an older cmod is deleted, and the index is history-2.sqlite', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await writeFiles(home, { '.local/share/cmod/history.sqlite': 'an older index\n' })

  await json(home, 'sessions', '--project', project)

  expect([existsSync(join(home, '.local/share/cmod/history.sqlite')), existsSync(join(home, '.local/share/cmod/history-2.sqlite'))]).toEqual([false, true])
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
  const holder = new Database(join(home, '.local/share/cmod/history-2.sqlite'))
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

  const messages = (await json(home, 'messages', 's1', '--project', project)) as { id: string; tools: unknown[] }[]
  expect(messages.map((message) => message.id)).toEqual(['u1', 'a1', 'p1', 'n1'])
  expect(messages[1]?.tools).toEqual([{ tool: 'Agent', input: { prompt: 'find the pane file' }, id: 'toolu_1', subagent: 'a7', result: 'found src/panes/tree.tsx' }])
})

test('a search with many matches walks the time order of its scope and never sorts every match', async () => {
  const home = await temporaryHome()
  const before = process.env['XDG_DATA_HOME']
  process.env['XDG_DATA_HOME'] = join(home, 'data')
  const db = openHistory()
  try {
    const planOf = (isScoped: boolean) =>
      db
        .query<{ detail: string }, (string | number)[]>(`explain query plan ${searchQuery({ isScoped, hasBefore: true, path: isScoped ? 'folder' : 'time' })}`)
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
  await rm(join(home, `.claude/projects/${project.replace(/[^A-Za-z0-9]/g, '-')}/s0.jsonl`))

  expect(((await json(home, 'sessions', '--project', project)) as { id: string }[]).map((session) => session.id)).toEqual(['s1'])
  expect(((await json(home, 'search', 'tree pane', '--project', project)) as { id: string }[]).map((message) => message.id)).toEqual(['u1'])
})
