import { expect, test } from 'bun:test'
import type { EventResult, HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import { targetWords } from '../../src/jobs/context.js'
import { prompt } from '../../src/jobs/prompt.js'
import { slashCommand } from '../../src/jobs/slash-command.js'
import { tool } from '../../src/jobs/tool.js'
import { defineMod, process, sessions } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'
import { claudeCodeOf } from '../../src/testing/claude-code.js'

const root = '/work/dent'
const files = {
  [`${root}/.git/HEAD`]: 'ref: refs/heads/main\n',
  [`${root}/.git/worktrees/design/commondir`]: '../..\n',
  [`${root}/worktrees/design/.git`]: `gitdir: ${root}/.git/worktrees/design\n`,
  [`${root}/worktrees/design/Domain.md`]: '# Domain\n',
}

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

test("a prompt callback gets the work tree that holds the edited file as the call's folder", async () => {
  const tested = testMod(
    defineMod({
      name: 'dent',
      setup(mod) {
        mod.use(prompt({ name: 'status', after: { write: 'Domain.md' }, prompt: ({ call }) => readAll(process.spawn(['git', 'status'], call === undefined ? {} : { cwd: call.folder })) }))
      },
    }),
    { scope: 'project', projectRoot: root, files, permissions: ['prompt', 'run:git'] },
  )
  tested.fakes.clock.after = () => ({ cancel: () => undefined })
  tested.fakes.process.spawn = () => written('On branch design\n')
  const edit = { tool: 'Edit', file_path: `${root}/worktrees/design/Domain.md`, old_string: '#', new_string: '##', tool_use_id: 'toolu_1' } as never
  const answered = { result: { filePath: `${root}/worktrees/design/Domain.md` }, text: 'The file was updated.' } as Extract<EventResult<'tool.call'>, { result: unknown; isError?: undefined }>

  const answer = await claudeCodeOf(tested).fire('tool.call', edit, answered)

  expect(tested.calls.filter((call) => call.call === 'process.spawn').map((call) => call.args)).toEqual([[{ argv: ['git', 'status'], cwd: `${root}/worktrees/design` }]])
  expect(answer.context).toEqual(['<dent_mod>\n# status\nOn branch design\n\n</dent_mod>'])
})

test("the current session's cwd follows a move", async () => {
  const tested = testMod(
    defineMod({
      name: 'where',
      setup(mod) {
        mod.use(slashCommand({ name: 'where', description: 'Name the working folder', reply: () => sessions.current.cwd }))
      },
    }),
    { projectRoot: '/work/a' },
  )

  expect(await tested.type('/where')).toEqual({ text: '/work/a' })
  await tested.moveTo('/work/b')
  expect(await tested.type('/where')).toEqual({ text: '/work/b' })
})

test("a tool's execute that outlasts the job's deadline answers that it passed the deadline", async () => {
  const tested = testMod(
    defineMod({
      name: 'tickets',
      setup(mod) {
        mod.use(tool({ name: 'sync', description: 'Sync the tickets', execute: () => new Promise<never>(() => undefined) }))
      },
    }),
  )
  tested.fakes.clock.after = (ms, fire) => {
    if (ms === 30000) void Promise.resolve().then(fire)
    return { cancel: () => undefined }
  }

  expect(await tested.callTool('sync', {})).toEqual({ deny: 'The sync tool failed: the sync tool passed the 30 s deadline of tool' })
})
