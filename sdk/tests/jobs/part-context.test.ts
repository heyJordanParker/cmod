import { expect, test } from 'bun:test'
import type { EventResult, HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import { modOf, targetWords } from '../../src/jobs/part-context.js'
import { findProjectScope, type Workspace } from '../../src/jobs/permissions/find-project-scope.js'
import { prompt } from '../../src/jobs/prompt.js'
import { tool } from '../../src/jobs/tool.js'
import { defineMod, type PartContext } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'
import { fakeFileSystem } from './fake-file-system.js'

const root = '/work/dent'
const home = '/Users/jordan'
const deadline = { ms: 2000, job: 'permissions' }
const files = {
  [`${root}/.git/HEAD`]: 'ref: refs/heads/main\n',
  [`${root}/.git/worktrees/design/commondir`]: '../..\n',
  [`${root}/worktrees/design/.git`]: `gitdir: ${root}/.git/worktrees/design\n`,
  [`${root}/worktrees/design/Domain.md`]: '# Domain\n',
}
const fs = fakeFileSystem(files)

async function partFor() {
  let used: PartContext | undefined
  const tested = testMod(defineMod({ name: 'dent', setup: (mod) => mod.use((context) => void (used = context)) }), { projectRoot: root })
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  await tested.start()
  if (used === undefined) throw new Error('setup did not run')
  return { fake: tested, context: used }
}

test("in a project-scope plugin, a callback's mod.process.run runs in the work tree that holds the call's path", async () => {
  const { fake, context } = await partFor()
  const workspace: Workspace = { cwd: root, home, fs, scope: await findProjectScope(`${root}/.claude/skills/dent`, home, fs) }

  await modOf(context, { tool: 'Edit', path: `${root}/worktrees/design/Domain.md` }, root, workspace, deadline).process.run(['git', 'status'])
  await modOf(context, { tool: 'Bash', commands: [['git', 'commit']], isFullyParsed: true }, root, workspace, deadline).process.run(['git', 'status'])
  await modOf(context, { tool: 'Bash', commands: [['git', 'commit']], isFullyParsed: true }, `${root}/worktrees/design/app`, workspace, deadline).process.run(['git', 'status'])
  await modOf(context, { tool: 'Edit', path: `${root}/Domain.md` }, root, workspace, deadline).process.run(['git', 'status'], { cwd: '/tmp', timeoutMs: 9000 })

  expect(fake.calls.filter((call) => call.call === 'process.run').map((call) => call.args[1])).toEqual([
    { cwd: `${root}/worktrees/design`, timeoutMs: 2000 },
    { cwd: root, timeoutMs: 2000 },
    { cwd: `${root}/worktrees/design`, timeoutMs: 2000 },
    { cwd: '/tmp', timeoutMs: 2000 },
  ])
})

test("in any other plugin, a callback's mod.process.run runs in the session's folder", async () => {
  const { fake, context } = await partFor()
  const workspace: Workspace = { cwd: root, home, fs, scope: undefined }

  await modOf(context, { tool: 'Edit', path: `${root}/worktrees/design/Domain.md` }, root, workspace, deadline).process.run(['git', 'status'])

  expect(fake.calls.find((call) => call.call === 'process.run')?.args[1]).toEqual({ timeoutMs: 2000 })
})

test('targetWords names each target in words a user reads', () => {
  expect(targetWords({ write: '*.ts' })).toBe('edits to *.ts')
  expect(targetWords({ read: ['.env', '*.pem'] })).toBe('reads of .env and *.pem')
  expect(targetWords({ command: 'git commit' })).toBe('git commit')
  expect(targetWords({ command: '*' })).toBe('every shell command')
  expect(targetWords({ fetch: 'https://*.example/**' })).toBe('fetches of https://*.example/**')
  expect(targetWords({ subagent: 'explorer' })).toBe('the explorer subagent')
  expect(targetWords({ tool: 'mcp__github__*' })).toBe('the mcp__github__* tool')
})

type Stream = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

async function readAll(stream: Stream): Promise<string> {
  let text = ''
  for await (const piece of stream) text += piece.text
  return text
}

function written(text: string): Stream {
  async function* pieces(): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
    yield { stream: 'stdout', text }
    return { code: 0, signal: null }
  }
  return Object.assign(pieces(), { result: Promise.resolve({ code: 0, signal: null }) })
}

function endless(killed: () => void): Stream {
  const stream = {
    next: () => new Promise(() => undefined),
    return: async (value: ProcessSpawnResult) => {
      killed()
      return { done: true, value }
    },
    [Symbol.asyncIterator]: () => stream,
    result: new Promise(() => undefined),
  }
  return stream as unknown as Stream
}

test('spawn inside a prompt callback runs in the work tree', async () => {
  const tested = testMod(
    defineMod({
      name: 'dent',
      setup(mod) {
        mod.use(prompt({ name: 'status', after: { write: 'Domain.md' }, prompt: (_input, mod) => readAll(mod.process.spawn(['git', 'status'])) }))
      },
    }),
    { scope: 'project', projectRoot: root, files },
  )
  tested.fakes.clock.after = () => ({ cancel: () => undefined })
  tested.fakes.process.spawn = () => written('On branch design\n')
  const edit = { tool: 'Edit', file_path: `${root}/worktrees/design/Domain.md`, old_string: '#', new_string: '##', tool_use_id: 'toolu_1' } as never
  const answered = { result: { filePath: `${root}/worktrees/design/Domain.md` }, text: 'The file was updated.' } as Extract<EventResult<'tool.call'>, { result: unknown; isError?: undefined }>

  const answer = await tested.fire('tool.call', edit, answered)

  expect(tested.calls.filter((call) => call.call === 'process.spawn').map((call) => call.args)).toEqual([[{ argv: ['git', 'status'], cwd: `${root}/worktrees/design` }]])
  expect(answer.context).toEqual(['On branch design\n'])
})

test("a spawn inside a job stops at the job's deadline", async () => {
  let isKilled = false
  const tested = testMod(
    defineMod({
      name: 'tickets',
      setup(mod) {
        mod.use(tool({ name: 'sync', description: 'Sync the tickets', execute: (_input, mod) => readAll(mod.process.spawn(['tracker', 'sync'])) }))
      },
    }),
  )
  tested.fakes.process.spawn = () => endless(() => (isKilled = true))
  tested.fakes.clock.after = (ms, fire) => {
    if (ms === 30000) void Promise.resolve().then(fire)
    return { cancel: () => undefined }
  }

  expect(await tested.callTool('sync', {})).toEqual({ deny: 'The sync tool failed: mod.process.spawn passed the 30 s deadline of tool' })
  expect(isKilled).toBe(true)
})
