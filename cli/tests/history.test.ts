import { Database } from 'bun:sqlite'
import { afterAll, afterEach, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import { appendFileSync, existsSync, readdirSync } from 'node:fs'
import { appendFile, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { folderOf, followSessions, openHistory, readSession, runningEntries, searchQuery } from '../src/history.js'
import { cmodWith as cmodWithHere, deleteTemporaryHomes, spawned, spawningTestLimitMs, startCmod, startOf, temporaryHome, writeFiles } from './cmod.js'

setDefaultTimeout(spawningTestLimitMs)
afterAll(deleteTemporaryHomes)

const serves = new Map<string, ReturnType<typeof startCmod>>()

afterEach(async () => {
  const stopped = [...serves.values()]
  serves.clear()
  for (const serving of stopped) serving.child.kill()
  await Promise.all(stopped.map((serving) => serving.done))
})

const served = (home: string, args: readonly string[]) => {
  if (args[0] !== 'sessions' && args[0] !== 'history') return Promise.resolve()
  const serving = serves.get(home) ?? startCmod(home, 'serve')
  serves.set(home, serving)
  return serving.firstLine()
}

const outside = { CLAUDE_CODE_SESSION_ID: '' }

const cmod = async (home: string, ...args: string[]) => {
  await served(home, args)
  return cmodWithHere(home, outside, ...args)
}

const cmodWith = async (home: string, env: Record<string, string>, ...args: string[]) => {
  await served(home, args)
  return cmodWithHere(home, { ...outside, ...env }, ...args)
}

const at = (second: number, day = 11) => `2026-10-${String(day).padStart(2, '0')}T10:00:${String(second).padStart(2, '0')}.000Z`

const lines = (rows: readonly object[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join('')

const projectFolder = (project: string) => `.claude/projects/${project.replace(/[^A-Za-z0-9]/g, '-')}`

const ids = (found: unknown) => (found as { id: string }[]).map((message) => message.id)

function conversation(project: string) {
  return [
    { type: 'user', uuid: 'u1', timestamp: at(0), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: 'Rename the tree pane' } },
    { type: 'assistant', uuid: 'a1', timestamp: at(1), cwd: project, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'I will find it first.' }, { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { prompt: 'find the pane file' } }] } },
    { type: 'user', uuid: 'r1', timestamp: at(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'found src/panes/tree.tsx' }] } },
    { type: 'user', uuid: 'p1', timestamp: at(6), origin: { kind: 'plugin', name: 'demo' }, message: { role: 'user', content: 'Switch to build mode' } },
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

function writeLockOn(home: string): Database {
  const before = process.env['XDG_DATA_HOME']
  process.env['XDG_DATA_HOME'] = join(home, '.local/share')
  try {
    const holder = openHistory()
    holder.exec('begin immediate')
    return holder
  } finally {
    if (before === undefined) delete process.env['XDG_DATA_HOME']
    else process.env['XDG_DATA_HOME'] = before
  }
}

const json = async (home: string, ...args: string[]): Promise<unknown> => {
  const result = await cmod(home, 'sessions', ...args, '--json')
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
    { id: 'p1', type: 'prompt', at: at(6), session: 's1', context: 1, turn: 'p1', text: 'Switch to build mode', from: { type: 'mod', name: 'demo' } },
  ]
}

test("the index names each message's agent type, a task's from its agent, and the main agent's from the session's agent-setting row, which cmod sessions list names too", async () => {
  const home = await temporaryHome()
  const project = join(home, 'work/app')
  await writeFiles(home, {
    [`${projectFolder(project)}/s1.jsonl`]: lines([{ type: 'agent-setting', agentSetting: 'release-captain', sessionId: 's1' }, ...conversation(project)]),
    [`${projectFolder(project)}/s1/subagents/agent-a7.jsonl`]: lines([{ type: 'user', uuid: 'x1', timestamp: at(2), message: { role: 'user', content: 'find the pane file' } }]),
    [`${projectFolder(project)}/s1/subagents/agent-a7.meta.json`]: JSON.stringify({ agentType: 'explorer', description: 'Find the pane', toolUseId: 'toolu_1' }),
  })

  const listed = (await json(home, 'list', '--project', project)) as { id: string; agentType?: string }[]
  const main = (await json(home, 'read', 'messages', 's1', '--project', project)) as { id: string; agentType?: string }[]
  const task = (await json(home, 'read', 'messages', 's1', '--project', project, '--task', 'a7')) as { id: string; agentType?: string }[]

  expect(listed.map((session) => [session.id, session.agentType])).toEqual([['s1', 'release-captain']])
  expect(main.map((message) => [message.id, message.agentType])).toEqual([
    ['u1', 'release-captain'],
    ['a1:0', 'release-captain'],
    ['a1:1', 'release-captain'],
    ['r1', 'release-captain'],
    ['p1', 'release-captain'],
  ])
  expect(task.map((message) => [message.id, message.agentType])).toEqual([['x1', 'explorer']])
})

test('readers of a session longer than several write batches, running at once, each read it whole, with no row twice', async () => {
  const home = await temporaryHome()
  const project = join(home, 'work/app')
  const long = 'x'.repeat(2_000_000)
  const time = (second: number) => new Date(Date.UTC(2026, 9, 11, 10, 0, 0) + second * 1000).toISOString()
  const rows = Array.from({ length: 20 }, (_, index) => [
    { type: 'user', uuid: `u${index}`, timestamp: time(index * 3), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: `Step ${index} ${long}` } },
    { type: 'assistant', uuid: `a${index}`, timestamp: time(index * 3 + 1), cwd: project, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: `Did step ${index}.` }, ...(index === 3 ? [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { prompt: 'look' } }] : [])] } },
  ]).flat()
  const taskRows = Array.from({ length: 6 }, (_, index) => ({ type: 'user', uuid: `t${index}`, timestamp: time(10 + index), message: { role: 'user', content: `task ${index} ${long}` } }))
  await writeFiles(home, {
    [`${projectFolder(project)}/s1.jsonl`]: lines(rows),
    [`${projectFolder(project)}/s1/subagents/agent-a7.jsonl`]: lines(taskRows),
    [`${projectFolder(project)}/s1/subagents/agent-a7.meta.json`]: JSON.stringify({ agentType: 'explorer', description: 'Look', toolUseId: 'toolu_1' }),
  })

  const commands = [
    ['messages', 's1', '--project', project, '--json'],
    ['messages', 's1', '--project', project, '--json'],
    ['messages', 's1', '--project', project, '--task', 'a7', '--json'],
    ['turns', 's1', '--project', project, '--json'],
  ]
  await served(home, ['sessions'])
  const results = await Promise.all(commands.map((args) => cmodWithHere(home, outside, 'sessions', 'read', ...args)))
  expect(results.map(({ exitCode, stderr }, index) => ({ command: commands[index]?.join(' '), exitCode, stderr }))).toEqual(commands.map((args) => ({ command: args.join(' '), exitCode: 0, stderr: '' })))
  const [first, second, task, turns] = results.map((result, index) => {
    try {
      return JSON.parse(result.stdout) as { id: string }[]
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      throw new Error(`cmod sessions read ${commands[index]?.join(' ')} printed ${result.stdout.length} characters of stdout that are not JSON`)
    }
  })
  const expected = rows.map((row) => row.uuid).flatMap((id) => (id === 'a3' ? ['a3:0', 'a3:1'] : [id]))
  const db = new Database(join(home, '.local/share/cmod/history-14.sqlite'), { readonly: true })
  const counts = db.query<{ total: number; ids: number; unordered: number }, []>("select count(*) as total, count(distinct id) as ids, (select count(*) from messages where seq is null) as unordered from messages where session = 's1'").get()
  db.close()

  expect(first?.map((message) => message.id)).toEqual(expected)
  expect(second?.map((message) => message.id)).toEqual(expected)
  expect(task?.map((message) => message.id)).toEqual(taskRows.map((row) => row.uuid))
  expect(turns).toHaveLength(20)
  expect(counts).toEqual({ total: counts?.ids ?? -1, ids: counts?.ids ?? -1, unordered: 0 })
})

test('each cmod history form a released session or the inbox runs prints what its cmod sessions form prints, on the same store', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  const forms = [
    [['history', 'sessions', '--all', '--json'], ['sessions', 'list', '--every-project', '--json']],
    [['history', 'sessions', '--project', project], ['sessions', 'list', '--project', project]],
    [['history', 'search', 'rename', '--all', '--json'], ['sessions', 'search', 'rename', '--every-project', '--json']],
    ...['messages', 'turns', 'contexts', 'tasks', 'goal', 'usage', 'state'].map((part) => [
      ['history', part, 's1', '--project', project, '--json'],
      ['sessions', 'read', part, 's1', '--project', project, '--json'],
    ]),
    [['history', 'index'], ['sessions', 'index']],
  ]

  for (const [old, current] of forms) {
    const [printed, expected] = [await cmod(home, ...(old as string[])), await cmod(home, ...(current as string[]))]
    expect({ form: old, ...printed }).toEqual({ form: old, ...expected, exitCode: 0, stderr: '' })
  }
  expect((await cmod(home, 'history', 'messages', 's3', '--project', project)).stderr).toBe('cmod history: no session s3 on any of your devices.\n')
})

test('messages reads a conversation as typed messages placed in their context and turn, and --task reads a task', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  expect(await json(home, 'read', 'messages', 's1', '--project', project)).toEqual(mainMessages(project))
  expect(await json(home, 'read', 'messages', 's1', '--project', project, '--task', 'a7')).toEqual([{ id: 'x1', type: 'prompt', at: at(2), session: 's1', context: 1, task: 'a7', agentType: 'explorer', turn: 'x1', text: 'find the pane file', from: { type: 'task' } }])
  expect(ids(await json(home, 'read', 'messages', 's1', '--project', project, '--last', '1'))).toEqual(['p1'])
  expect(ids(await json(home, 'read', 'messages', 's1', '--project', project, '--after', 'a1:1'))).toEqual(['r1', 'p1'])
  expect(ids(await json(home, 'read', 'messages', 's1', '--project', project, '--turn', 'p1'))).toEqual(['p1'])
})

test("read --transcripts reads a copied Claude Code folder's conversation through an index of its own, so cmod's index never lists it", async () => {
  const home = await temporaryHome()
  const copied = join(home, 'copied')
  const project = join(home, 'work/app')
  await writeFiles(copied, {
    [`projects/${project.replace(/[^A-Za-z0-9]/g, '-')}/s1.jsonl`]: lines(conversation(project)),
    [`projects/${project.replace(/[^A-Za-z0-9]/g, '-')}/s1/subagents/agent-a7.jsonl`]: lines([{ type: 'user', uuid: 'x1', timestamp: at(2), message: { role: 'user', content: 'find the pane file' } }]),
  })

  expect(await json(home, 'read', 'messages', 's1', '--project', project, '--transcripts', copied)).toEqual(mainMessages(project))
  expect(ids(await json(home, 'read', 'messages', 's1', '--project', project, '--transcripts', copied, '--task', 'a7'))).toEqual(['x1'])
  expect(await json(home, 'read', 'turns', 's1', '--transcripts', copied, '--last', '1')).toEqual([{ prompt: mainMessages(project)[4], context: 1, openedAt: at(6) }])
  expect(await json(home, 'list', '--every-project')).toEqual([])
  expect(await cmod(home, 'sessions', 'list', '--transcripts', copied)).toEqual({ exitCode: 1, stdout: '', stderr: 'cmod sessions: cmod sessions takes --transcripts only with read <part> <session>.\n' })
  expect(await cmod(home, 'sessions', 'read', 'messages', 's1', '--transcripts', join(home, 'work'))).toEqual({ exitCode: 1, stdout: '', stderr: `cmod sessions: ${join(home, 'work')} holds no projects folder, so it is not a Claude Code folder.\n` })
})

test("each mod's note in a hook row is indexed as a Note from that mod", async () => {
  const home = await temporaryHome()
  const project = join(home, 'work/app')
  const hookRow = { type: 'attachment', uuid: 'h1', timestamp: at(2), attachment: { type: 'hook_additional_context', hookName: 'PostToolUse', content: ['<demo_mod>\nsrc/CLAUDE.md is held.\n</demo_mod>'] } }
  await writeFiles(home, { [`${projectFolder(project)}/s1.jsonl`]: lines([conversation(project)[0] as object, hookRow]) })

  expect(await json(home, 'read', 'messages', 's1', '--project', project)).toEqual([firstTurn(), { id: 'h1', type: 'note', at: at(2), session: 's1', context: 1, turn: 'u1', text: 'src/CLAUDE.md is held.', from: { type: 'mod', name: 'demo' } }])
})

test("each turn ran on the device the cmod plugin's last note before it names, and a transcript without such a note has turns without a device", async () => {
  const home = await temporaryHome()
  const project = join(home, 'work/app')
  const mac = { id: '2e08a4bd6c674208b4d150deaa95ebc6', name: 'mac', os: 'darwin', arch: 'arm64' }
  const linux = { id: 'dc896649b2c644849a1caf192c072c77', name: 'linux', os: 'linux', arch: 'x64' }
  const noted = (uuid: string, second: number, device: typeof mac) => ({
    type: 'attachment',
    uuid,
    timestamp: at(second),
    attachment: { type: 'hook_additional_context', hookName: 'SessionStart', content: [`<cmod_mod>\nAs of ${at(second)}, this session runs on ${device.name}, a ${device.os} ${device.arch} computer with the cmod device id ${device.id}.\n\nThe demo mod adds these rules from now on:\n\nWrite a test first.\n</cmod_mod>`] },
  })
  const prompt = (uuid: string, second: number, text: string) => ({ type: 'user', uuid, timestamp: at(second), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: text } })
  const agentCall = { type: 'assistant', uuid: 'a3', timestamp: at(7), cwd: project, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_3', name: 'Agent', input: { prompt: 'look' } }] } }
  await writeFiles(home, {
    [`${projectFolder(project)}/moved.jsonl`]: lines([noted('n1', 0, mac), prompt('u1', 1, 'Plan it'), prompt('u2', 3, 'Build it'), noted('n2', 5, linux), prompt('u3', 6, 'Ship it'), agentCall, noted('n3', 9, mac), prompt('u4', 10, 'Check it')]),
    [`${projectFolder(project)}/moved/subagents/agent-t3.jsonl`]: lines([{ type: 'user', uuid: 'x3', timestamp: at(8), message: { role: 'user', content: 'look' } }]),
    [`${projectFolder(project)}/moved/subagents/agent-t3.meta.json`]: JSON.stringify({ agentType: 'explorer', description: 'Look', toolUseId: 'toolu_3' }),
    [`${projectFolder(project)}/older.jsonl`]: lines([prompt('o1', 1, 'Plan it'), prompt('o2', 3, 'Build it')]),
  })

  const devices = async (...args: string[]) => ((await json(home, 'read', 'turns', ...args, '--project', project)) as { prompt: { id: string }; device?: unknown }[]).map((turn) => [turn.prompt.id, turn.device])

  expect(await devices('moved')).toEqual([['u1', mac], ['u2', mac], ['u3', linux], ['u4', mac]])
  expect(await devices('moved', '--task', 't3')).toEqual([['x3', linux]])
  expect(await devices('older')).toEqual([['o1', undefined], ['o2', undefined]])
})

test('turns, contexts, tasks, and goal read the shape of a conversation', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  expect(await json(home, 'read', 'turns', 's1', '--project', project)).toEqual([
    { prompt: firstTurn(), context: 1, openedAt: at(0), closedAt: at(6) },
    { prompt: mainMessages(project)[4], context: 1, openedAt: at(6) },
  ])
  expect(await json(home, 'read', 'turns', 's1', '--project', project, '--last', '1')).toEqual([{ prompt: mainMessages(project)[4], context: 1, openedAt: at(6) }])
  expect(await json(home, 'read', 'contexts', 's1', '--project', project)).toEqual([{ number: 1, openedAt: at(0) }])
  expect(await json(home, 'read', 'tasks', 's1', '--project', project)).toEqual([{ id: 'a7', title: 'Find the pane', agentType: 'explorer', openedBy: 'toolu_1', openedAt: at(1), closedAt: at(5), status: 'completed' }])
  expect(await json(home, 'read', 'goal', 's1', '--project', project)).toEqual({ text: 'Rename the tree pane' })
})

test("--task reads the agent a task runs like a conversation: its turns, context, goal, and usage", async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await appendFile(join(home, `${projectFolder(project)}/s1/subagents/agent-a7.jsonl`), lines([{ type: 'assistant', uuid: 'x2', timestamp: at(3), message: { role: 'assistant', model: 'claude-haiku-5', content: [{ type: 'text', text: 'It is src/panes/tree.tsx.' }], usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 80, output_tokens: 10 } } }]))
  const prompt = { id: 'x1', type: 'prompt', at: at(2), session: 's1', context: 1, task: 'a7', agentType: 'explorer', turn: 'x1', text: 'find the pane file', from: { type: 'task' } }

  expect(await json(home, 'read', 'turns', 's1', '--project', project, '--task', 'a7')).toEqual([{ prompt, context: 1, openedAt: at(2), closedAt: at(5) }])
  expect(await json(home, 'read', 'contexts', 's1', '--project', project, '--task', 'a7')).toEqual([{ number: 1, openedAt: at(1), closedAt: at(5), task: 'a7' }])
  expect(await json(home, 'read', 'goal', 's1', '--project', project, '--task', 'a7')).toEqual({ text: 'find the pane file' })
  expect(await json(home, 'read', 'usage', 's1', '--project', project, '--task', 'a7')).toEqual({ model: 'claude-haiku-5', contextWindow: { tokenCount: 1000 } })
  expect(await json(home, 'read', 'usage', 's1', '--project', project)).toEqual({ model: '', contextWindow: {} })
})

test('search --session keeps one conversation, and --task, --turn, and --agent keep a part of it', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  expect(ids(await json(home, 'search', 'pane', '--project', project, '--session', 's1'))).toEqual(['x1', 'a1:1', 'u1'])
  expect(ids(await json(home, 'search', 'pane', '--project', project, '--session', 's1', '--task', 'a7'))).toEqual(['x1'])
  expect(ids(await json(home, 'search', 'pane', '--project', project, '--session', 's1', '--agent'))).toEqual(['a1:1', 'u1'])
  expect(ids(await json(home, 'search', 'pane', '--project', project, '--session', 's1', '--task', 'a7', '--agent'))).toEqual(['x1'])
  expect(ids(await json(home, 'search', 'pane', '--project', project, '--session', 's1', '--turn', 'u1'))).toEqual(['a1:1', 'u1'])
  expect(ids(await json(home, 'search', 'pane', '--project', project, '--session', 's1', '--context', '1'))).toEqual(['a1:1', 'u1'])
  expect(ids(await json(home, 'search', 'pane', '--project', project, '--session', 's1', '--task', 'a7', '--context', '1'))).toEqual(['x1'])
  expect((await cmod(home, 'sessions', 'search', 'pane', '--task', 'a7')).stderr).toContain('cmod sessions search takes --task, --turn, --context, and --agent only with --session.')
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

  expect(await json(home, 'read', 'contexts', 's1', '--project', project)).toEqual([
    { number: 1, openedAt: at(0), closedAt: at(4) },
    { number: 2, openedAt: at(4) },
  ])
  expect(await json(home, 'read', 'turns', 's1', '--project', project, '--context', '2')).toEqual([{ prompt: { id: 'u2', type: 'prompt', at: at(7), session: 's1', context: 2, turn: 'u2', text: 'Now the file pane', from: { type: 'person' } }, context: 2, openedAt: at(7) }])
  expect((await json(home, 'read', 'turns', 's1', '--project', project, '--context', '1')) as unknown[]).toEqual([{ prompt: firstTurn(), context: 1, openedAt: at(0), closedAt: at(3) }])
})

test('the goal a mod saved replaces the first prompt, and state resumes from it', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await writeFiles(home, { '.local/share/cmod/data/cmod/goals/s1.txt': 'Ship the tree pane' })

  expect(await json(home, 'read', 'goal', 's1', '--project', project)).toEqual({ text: 'Ship the tree pane' })
  expect(await json(home, 'read', 'state', 's1', '--project', project)).toMatchObject({ session: 's1', context: 1, goal: 'Ship the tree pane', turn: { prompt: { id: 'p1' } } })
})

test('messages and search print one line per message, with the local time, and search adds the date and session', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  const messages = await cmodWith(home, { TZ: 'UTC' }, 'sessions', 'read', 'messages', 's1', '--project', project)
  const found = await cmodWith(home, { TZ: 'UTC' }, 'sessions', 'search', 'rename', '--project', project)

  expect(messages.stdout).toBe(
    [
      '10:00  u1  person   Rename the tree pane',
      '10:00  a1:0  claude   I will find it first.',
      '10:00  a1:1  claude   Agent  {"prompt":"find the pane file"}',
      '10:00  r1  →        found src/panes/tree.tsx',
      '10:00  p1  mod demo  Switch to build mode',
      '',
    ].join('\n'),
  )
  expect(found.stdout).toBe('2026-10-11 10:00  s1  u1  person   Rename the tree pane\n')
})

test('messages after the last one read returns only the lines saved since', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await json(home, 'read', 'messages', 's1', '--project', project)
  await appendFile(join(home, `${projectFolder(project)}/s1.jsonl`), lines([{ type: 'assistant', uuid: 'a2', timestamp: at(9), message: { role: 'assistant', content: [{ type: 'text', text: 'Build mode is on.' }] } }]))

  expect(await json(home, 'read', 'messages', 's1', '--project', project, '--after', 'p1')).toEqual([{ id: 'a2', type: 'reply', at: at(9), session: 's1', context: 1, turn: 'p1', text: 'Build mode is on.' }])
})

test('follow prints a row Claude Code was still writing when follow started', async () => {
  const home = await temporaryHome()
  const project = join(home, 'work/app')
  const prompt = JSON.stringify({ type: 'user', uuid: 'u1', timestamp: at(0), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: 'Rename the pane' } })
  const reply = JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: at(1), message: { role: 'assistant', content: [{ type: 'text', text: 'Renamed.' }] } })
  const half = Math.floor(reply.length / 2)
  await writeFiles(home, { [`${projectFolder(project)}/s1.jsonl`]: `${prompt}\n${reply.slice(0, half)}` })
  await served(home, ['sessions'])
  const following = startCmod(home, 'sessions', 'follow', 's1', '--project', project, '--json')
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
  await served(home, ['sessions'])
  const following = startCmod(home, 'sessions', 'follow', 's1', '--project', project, '--json')
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

test('follow --running prints a session of the project that starts after it from its first row, whenever follow notices it, and no other project', async () => {
  const home = await temporaryHome()
  const { project, other } = await writeHistory(home)
  await served(home, ['sessions'])
  const following = startCmod(home, 'sessions', 'follow', '--running', '--project', project, '--json')
  await following.waitForOutput('Following every running session of the project')

  const startedAt = Date.now()
  const now = new Date(startedAt).toISOString()
  await writeFiles(home, {
    [`${projectFolder(other)}/s8.jsonl`]: lines([{ type: 'user', uuid: 'w2', timestamp: now, cwd: other, origin: { kind: 'human' }, message: { role: 'user', content: 'Ship the site' } }]),
    [`${projectFolder(project)}/s2.jsonl`]: lines([{ type: 'user', uuid: 'n1', timestamp: now, cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: 'Add a search pane' } }]),
    '.claude/sessions/1.json': JSON.stringify({ pid: process.pid, sessionId: 's2', cwd: project, startedAt }),
    '.claude/sessions/2.json': JSON.stringify({ pid: process.pid, sessionId: 's8', cwd: other, startedAt }),
  })
  await following.waitForOutput('"Add a search pane"')
  following.child.kill()
  const { stdout } = await following.done

  expect([...new Set(stdout.trim().split('\n').map((line) => (JSON.parse(line) as { session: string }).session))]).toEqual(['s2'])
})

test('follow --running prints a session resumed after it only from the rows the resume added', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await served(home, ['sessions'])
  const following = startCmod(home, 'sessions', 'follow', '--running', '--project', project, '--json')
  await following.waitForOutput('Following every running session of the project')

  const startedAt = Date.now()
  await writeFiles(home, { '.claude/sessions/1.json': JSON.stringify({ pid: process.pid, sessionId: 's1', cwd: project, startedAt }) })
  await appendFile(join(home, `${projectFolder(project)}/s1.jsonl`), lines([{ type: 'user', uuid: 'n1', timestamp: new Date(startedAt).toISOString(), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: 'Add a search pane' } }]))
  await following.waitForOutput('"Add a search pane"')
  following.child.kill()
  const { stdout } = await following.done

  const changes = stdout
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { change: { type: string; message?: { id: string }; turn?: { prompt: { id: string } } } }).change)
  expect(changes.map(({ type, message, turn }) => [type, message?.id ?? turn?.prompt.id])).toEqual([
    ['turnEnd', 'p1'],
    ['turnStart', 'n1'],
    ['message', 'n1'],
  ])
})

test('follow reads a session again only when told to, as cmod serve tells it each time the messages change', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  const configRoot = process.env['CLAUDE_CONFIG_DIR']
  process.env['CLAUDE_CONFIG_DIR'] = join(home, '.claude')
  const heard: unknown[] = []
  try {
    const follower = followSessions(openHistory({ isInMemory: true }), { sessions: ['s1'], isEveryRunning: false }, project, (_session, change) => void heard.push(change))

    appendFileSync(join(folderOf(project), 's1.jsonl'), lines([{ type: 'user', uuid: 'n1', timestamp: at(41), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: 'Add a search pane' } }]))
    const beforeTold = heard.length
    follower.step('s1')

    expect(beforeTold).toBe(0)
    expect(heard).toContainEqual({ type: 'message', message: expect.objectContaining({ id: 'n1', text: 'Add a search pane' }) })
  } finally {
    if (configRoot === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = configRoot
  }
})

test('the conversation the command runs in has no messages before its first is saved, and another unsaved session id fails', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await writeFiles(home, { '.claude/sessions/1.json': JSON.stringify({ pid: process.pid, sessionId: 's2', cwd: project }) })

  const running = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 's2' }, 'sessions', 'read', 'messages', '--project', project, '--json')
  const unknown = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 's2' }, 'sessions', 'read', 'messages', 's3', '--project', project, '--json')

  expect([running.exitCode, running.stdout]).toEqual([0, '[]\n'])
  expect([unknown.exitCode, unknown.stderr]).toEqual([1, 'cmod sessions: no session s3 on any of your devices.\n'])
})

test("list lists the project's conversations newest first, and --every-project, --since, and --running change the scope, --running to every project's running sessions unless --project names one", async () => {
  const home = await temporaryHome()
  const { project, other } = await writeHistory(home)
  await writeFiles(home, { '.claude/sessions/1.json': JSON.stringify({ pid: process.pid, sessionId: 's1', cwd: project }), '.claude/sessions/2.json': JSON.stringify({ pid: 2 ** 22 + 7, sessionId: 's0', cwd: project }), '.claude/sessions/3.json': JSON.stringify({ pid: process.pid, sessionId: 's9', cwd: other }) })

  expect(await json(home, 'list', '--project', project)).toEqual([
    { id: 's1', title: 'Tree pane rename', project, cwd: project, transcriptPath: join(home, projectFolder(project), 's1.jsonl'), model: 'claude-opus-5-5', startedAt: at(0), lastAt: at(6), isRunning: true, device: expect.any(Object) },
    { id: 's0', title: 'Add the tree pane', project, cwd: project, transcriptPath: join(home, projectFolder(project), 's0.jsonl'), model: '', startedAt: at(0, 1), lastAt: at(0, 1), isRunning: false, device: expect.any(Object) },
  ])
  expect(ids(await json(home, 'list', '--project', project, '--every-project'))).toEqual(['s9', 's1', 's0'])
  expect(ids(await json(home, 'list', '--project', other, '--since', '2026-10-05'))).toEqual(['s9'])
  expect(ids(await json(home, 'list', '--project', project, '--since', '2026-10-05'))).toEqual(['s1'])
  expect(ids(await json(home, 'list', '--project', project, '--running'))).toEqual(['s1'])
  expect(ids(await json(home, 'list', '--running'))).toEqual(['s9', 's1'])
  expect(ids(await json(home, 'search', 'tree pane', '--project', project, '--running'))).toEqual(['u1'])
})

test('a running session whose process started at another time than Claude Code recorded is a reused pid, so it does not count as running', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  const started = await startOf(process.pid)
  await writeFiles(home, { '.claude/sessions/1.json': JSON.stringify({ pid: process.pid, sessionId: 's1', cwd: project, procStart: 'Mon Jan  1 00:00:00 2001' }), '.claude/sessions/2.json': JSON.stringify({ pid: process.pid, sessionId: 's0', cwd: project, procStart: started }) })

  expect(ids(await json(home, 'list', '--project', project, '--running'))).toEqual(['s0'])
})

test('a registry write that changes only a status starts no process, and only a new pid is checked, in one ps run', async () => {
  const home = await temporaryHome()
  const project = join(home, 'work/app')
  const other = spawned(['/bin/sleep', '30'])
  const record = (session: string, pid: number, procStart: string, status: string) => JSON.stringify({ pid, sessionId: session, cwd: project, procStart, status })
  const ownStart = await startOf(process.pid)
  const otherStart = await startOf(other.pid)
  const listed = () => {
    const configRoot = process.env['CLAUDE_CONFIG_DIR']
    process.env['CLAUDE_CONFIG_DIR'] = join(home, '.claude')
    try {
      return runningEntries().map(({ session, status }) => `${session} ${status}`)
    } finally {
      if (configRoot === undefined) delete process.env['CLAUDE_CONFIG_DIR']
      else process.env['CLAUDE_CONFIG_DIR'] = configRoot
    }
  }
  const spawnedSync = spyOn(Bun, 'spawnSync')
  const psRuns: unknown[] = []
  try {
    await writeFiles(home, { '.claude/sessions/1.json': record('s1', process.pid, ownStart, 'busy') })
    expect(listed()).toEqual(['s1 busy'])
    await writeFiles(home, { '.claude/sessions/1.json': record('s1', process.pid, ownStart, 'idle') })
    expect(listed()).toEqual(['s1 idle'])
    await writeFiles(home, { '.claude/sessions/2.json': record('s2', other.pid, otherStart, 'busy') })
    expect(listed().sort()).toEqual(['s1 idle', 's2 busy'])
    for (const [command] of spawnedSync.mock.calls) if (Array.isArray(command) && command[0] === '/bin/ps') psRuns.push(command.at(-1))
  } finally {
    spawnedSync.mockRestore()
    other.kill()
  }

  expect(psRuns).toEqual([String(process.pid), String(other.pid)])
})

test('sessions carries the color each session last took with /color, and none after a reset to default', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  const transcript = (session: string) => join(home, projectFolder(project), `${session}.jsonl`)
  const colors = async () => Object.fromEntries(((await json(home, 'list', '--project', project)) as { id: string; color?: string }[]).map(({ id, color }) => [id, color ?? 'none']))
  await appendFile(transcript('s1'), lines([{ type: 'agent-color', agentColor: 'cyan', sessionId: 's1' }, { type: 'agent-color', agentColor: 'green', sessionId: 's1' }]))
  await json(home, 'read', 'messages', 's1', '--project', project)

  expect(await colors()).toEqual({ s1: 'green', s0: 'none' })

  await appendFile(transcript('s1'), lines([{ type: 'agent-color', agentColor: 'default', sessionId: 's1' }]))
  await appendFile(transcript('s0'), lines([{ type: 'agent-color', agentColor: 'purple', sessionId: 's0' }, { type: 'agent-color', agentColor: 'orange', sessionId: 's0' }]))

  expect(await colors()).toEqual({ s1: 'none', s0: 'orange' })
})

test('search finds every message whose text or tool input holds the text, newest first, in the project or every project, and never a tool result', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  expect(ids(await json(home, 'search', 'RENAME', '--project', project))).toEqual(['u1'])
  expect(ids(await json(home, 'search', 'rename', '--project', project, '--every-project'))).toEqual(['w1', 'u1'])
  expect(ids(await json(home, 'search', 'pane file', '--project', project))).toEqual(['x1', 'a1:1'])
  expect(await json(home, 'search', 'panes/tree.tsx', '--project', project)).toEqual([])
})

test("a subagent whose meta.json is empty still reads, as a task opened at its first message", async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await writeFiles(home, { [`${projectFolder(project)}/s1/subagents/agent-a7.meta.json`]: '' })

  expect(ids(await json(home, 'read', 'messages', 's1', '--project', project, '--task', 'a7'))).toEqual(['x1'])
  expect(await json(home, 'read', 'tasks', 's1', '--project', project)).toEqual([{ id: 'a7', title: '', agentType: 'general-purpose', openedBy: '', openedAt: at(2), closedAt: at(6), status: 'killed' }])
})

test("a fork Claude's Agent tool started reads as a task forked from its session, with no agent type", async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await writeFiles(home, { [`${projectFolder(project)}/s1/subagents/agent-a7.meta.json`]: JSON.stringify({ agentType: 'fork', isFork: true, description: 'Find the pane', toolUseId: 'toolu_1' }) })

  expect(await json(home, 'read', 'tasks', 's1', '--project', project)).toEqual([{ id: 'a7', title: 'Find the pane', forkedFrom: 's1', openedBy: 'toolu_1', openedAt: at(1), closedAt: at(5), status: 'completed' }])
})

test('two reads started together on a new transcript save each message once', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  await Promise.all([json(home, 'read', 'messages', 's1', '--project', project), json(home, 'read', 'messages', 's1', '--project', project, '--task', 'a7'), json(home, 'search', 'tree pane', '--project', project)])

  expect(await json(home, 'read', 'messages', 's1', '--project', project)).toEqual(mainMessages(project))
  expect(await json(home, 'read', 'turns', 's1', '--project', project)).toHaveLength(2)
})

test('search returns the newest messages up to --limit, and --before pages through a forked copy without repeats or gaps', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await writeFiles(home, { [`${projectFolder(project)}/s2.jsonl`]: lines([{ ...conversation(project)[0], forkedFrom: { sessionId: 's1' } }]) })

  const page = async (...before: string[]) => ((await json(home, 'search', 'tree pane', '--project', project, '--limit', '1', ...before)) as { session: string; id: string }[]).map((message) => `${message.session}:${message.id}`)

  const first = await page()
  const second = await page('--before', first[0] ?? '')
  const third = await page('--before', second[0] ?? '')
  const fourth = await page('--before', third[0] ?? '')

  expect([[...first, ...second].toSorted(), third, fourth]).toEqual([['s1:u1', 's2:u1'], ['s0:o1'], []])
})

test('search finds a value in a tool input, misses one past its first 1,024 characters, and refuses fewer than 3 characters', async () => {
  const home = await temporaryHome()
  const project = join(home, 'work/app')
  const write = { type: 'tool_use', id: 'toolu_9', name: 'Write', input: { file_path: 'notes.md', content: `${'x'.repeat(1100)}needle-after-the-cut` } }
  const bash = { type: 'tool_use', id: 'toolu_8', name: 'Bash', input: { command: 'bun run deploy-preview' } }
  await writeFiles(home, { [`${projectFolder(project)}/s1.jsonl`]: lines([{ type: 'assistant', uuid: 'a1', timestamp: at(1), cwd: project, message: { role: 'assistant', content: [bash, write] } }]) })

  expect(ids(await json(home, 'search', 'deploy-preview', '--project', project))).toEqual(['a1:0'])
  expect(await json(home, 'search', 'needle-after-the-cut', '--project', project)).toEqual([])
  expect(await cmod(home, 'sessions', 'search', 'ab', '--project', project)).toMatchObject({ exitCode: 1, stderr: 'cmod sessions: cmod sessions search takes at least 3 characters.\n' })
})

test('sessions leaves out a session no one prompted, and lists one whose first prompt follows 64 KB of hook rows', async () => {
  const home = await temporaryHome()
  const project = join(home, 'work/app')
  const hook = (uuid: string, second: number) => ({ type: 'attachment', uuid, timestamp: at(second), cwd: project, attachment: { type: 'hook_success', content: 'x'.repeat(70_000) } })
  await writeFiles(home, {
    [`${projectFolder(project)}/quiet.jsonl`]: lines([hook('h1', 1)]),
    [`${projectFolder(project)}/late.jsonl`]: lines([hook('h2', 2), hook('h3', 3), { type: 'user', uuid: 'u9', timestamp: at(4), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: 'Start the late session' } }]),
  })
  const late = { id: 'late', title: 'Start the late session', project, cwd: project, transcriptPath: join(home, projectFolder(project), 'late.jsonl'), model: '', startedAt: at(4), lastAt: at(4), isRunning: false, device: expect.any(Object) }

  expect(await json(home, 'list', '--project', project)).toEqual([late])
  await cmod(home, 'sessions', 'index')
  expect(await json(home, 'list', '--project', project)).toEqual([late])
})

test('an index made by an older cmod is deleted, and the index is history-14.sqlite', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  const older = ['history.sqlite', 'history-2.sqlite', 'history-3.sqlite', 'history-4.sqlite', 'history-5.sqlite', 'history-6.sqlite', 'history-7.sqlite', 'history-8.sqlite', 'history-9.sqlite', 'history-10.sqlite', 'history-11.sqlite', 'history-12.sqlite', 'history-13.sqlite']
  await writeFiles(home, Object.fromEntries(older.map((name) => [`.local/share/cmod/${name}`, 'an older index\n'])))

  await json(home, 'list', '--project', project)

  expect([...older, 'history-14.sqlite'].map((name) => existsSync(join(home, '.local/share/cmod', name)))).toEqual([...older.map(() => false), true])
})

test('the README names the conversation index cmod writes', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await json(home, 'list', '--project', project)
  const written = readdirSync(join(home, '.local/share/cmod')).filter((name) => /^history.*\.sqlite$/.test(name))

  const readme = await readFile(join(import.meta.dir, '..', '..', 'README.md'), 'utf8')

  expect([...new Set(readme.match(/history[-\d]*\.sqlite/g))]).toEqual(written)
})

test("a task's compaction gives its owner a new context, and contexts --task lists both", async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await appendFile(join(home, `${projectFolder(project)}/s1/subagents/agent-a7.jsonl`), lines([{ type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: at(3) }]))

  expect(await json(home, 'read', 'contexts', 's1', '--task', 'a7', '--project', project)).toEqual([
    { number: 1, openedAt: at(1), closedAt: at(3), task: 'a7' },
    { number: 2, openedAt: at(3), closedAt: at(5), task: 'a7' },
  ])
})

test("a deleted project folder's sessions leave the index after cmod sessions index", async () => {
  const home = await temporaryHome()
  const { project, other } = await writeHistory(home)
  await cmod(home, 'sessions', 'index')
  await rm(join(home, projectFolder(other)), { recursive: true })

  await cmod(home, 'sessions', 'index')

  expect(ids(await json(home, 'search', 'rename', '--project', project, '--every-project'))).toEqual(['u1'])
})

test('reading an unchanged transcript takes no write lock on the index', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await appendFile(join(home, `${projectFolder(project)}/s1.jsonl`), '{"type":"user","uuid":"half-written"')
  await json(home, 'list', '--project', project)
  await json(home, 'read', 'messages', 's1', '--project', project)
  const holder = writeLockOn(home)

  const startedAt = Date.now()
  const listed = await cmod(home, 'sessions', 'list', '--project', project, '--json')
  const read = await cmod(home, 'sessions', 'read', 'messages', 's1', '--project', project, '--json')
  holder.exec('rollback')
  holder.close()

  expect([listed.exitCode, read.exitCode, Date.now() - startedAt < 5000]).toEqual([0, 0, true])
})

test("sessions read state reads the lines the index has not yet saved while another cmod holds the index's write lock", async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await json(home, 'read', 'messages', 's1', '--project', project)
  await appendFile(join(home, `${projectFolder(project)}/s1.jsonl`), lines([{ type: 'user', uuid: 'u9', timestamp: at(9), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: 'Now the file pane' } }]))
  const holder = writeLockOn(home)

  const startedAt = Date.now()
  const state = await cmod(home, 'sessions', 'read', 'state', 's1', '--project', project)
  holder.exec('rollback')
  holder.close()

  expect([state.exitCode, Date.now() - startedAt < 5000]).toEqual([0, true])
  expect(JSON.parse(state.stdout)).toMatchObject({ session: 's1', context: 1, turn: { prompt: { id: 'u9', text: 'Now the file pane' } } })
})

test('sessions read state of a session with no transcript on this computer says it reads only this computer, and which command reads it on any device', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)

  const state = await cmod(home, 'sessions', 'read', 'state', 'elsewhere', '--project', project)

  expect([state.exitCode, state.stderr]).toEqual([1, 'cmod sessions: cmod sessions read state reads what a conversation on this computer resumes from, and session elsewhere has no transcript on this computer. cmod sessions read turns elsewhere reads it on any device.\n'])
})

test('a transcript rewritten under the index returns its new messages', async () => {
  const home = await temporaryHome()
  const { project } = await writeHistory(home)
  await json(home, 'read', 'messages', 's1', '--project', project)
  const rewritten = [{ type: 'user', uuid: 'n1', timestamp: at(20), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: `A new first prompt ${'that is longer than before '.repeat(20)}` } }]
  await writeFiles(home, { [`${projectFolder(project)}/s1.jsonl`]: lines([...rewritten, ...conversation(project)]) })

  expect(ids(await json(home, 'read', 'messages', 's1', '--project', project))).toEqual(['u1', 'a1:0', 'a1:1', 'r1', 'p1', 'n1'])
  expect(await json(home, 'read', 'tasks', 's1', '--project', project)).toEqual([{ id: 'a7', title: 'Find the pane', agentType: 'explorer', openedBy: 'toolu_1', openedAt: at(1), closedAt: at(5), status: 'completed' }])
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

test("a reader that finds another reader's offsets past its own after a write batch goes on from theirs, so it saves no row they saved", async () => {
  const home = await temporaryHome()
  const project = join(home, 'work/app')
  const rows = Array.from({ length: 1100 }, (_, index) => ({ type: 'user', uuid: `u${index}`, timestamp: at(index % 60), cwd: project, origin: { kind: 'human' }, message: { role: 'user', content: `Prompt ${index} ${'x'.repeat(8_000)}` } }))
  const path = join(home, `${projectFolder(project)}/s1.jsonl`)
  await writeFiles(home, { [`${projectFolder(project)}/s1.jsonl`]: lines(rows) })
  const end = Bun.file(path).size
  const before = process.env['XDG_DATA_HOME']
  process.env['XDG_DATA_HOME'] = join(home, 'data')
  const db = openHistory()
  try {
    db.exec(`create trigger another_reader after update of offset on files when new.offset > 0 and new.offset < ${end} begin update files set offset = ${end} where id = new.id; end`)

    readSession(db, [{ path, folder: dirname(path), session: 's1', task: undefined }])

    const saved = db.query<{ id: string }, []>("select id from messages where session = 's1'").all().map(({ id }) => id)
    expect([saved.length > 0, saved.includes('u0'), saved.includes('u1099')]).toEqual([true, true, false])
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

  expect(ids(await json(home, 'list', '--project', project))).toEqual(['s1'])
  expect(ids(await json(home, 'search', 'tree pane', '--project', project))).toEqual(['u1'])
})

test("each save's two questions about a session's order seek one index entry, so a session with millions of messages costs a save no walk of its rows", () => {
  const db = openHistory({ isInMemory: true })
  const plan = (query: string) => db.query<{ detail: string }, [string]>(`explain query plan ${query}`).all('s1').map((step) => step.detail).join('\n')

  expect(plan('select exists (select 1 from messages where session = ? and seq is null) as found')).toContain('messages_by_seq (session=? AND seq=?)')
  expect(plan('select coalesce(max(seq), 0) from messages where session = ?')).toContain('messages_by_seq')
})
