import { expect, test } from 'bun:test'
import type { EventResult } from 'claude-code'
import { check } from '../../src/jobs/check.js'
import { defineMod, type Job } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'

const root = '/test/plugins/typed'
const answered = { result: { filePath: `${root}/a.ts` }, text: 'The file was updated.' } as Extract<EventResult<'tool.call'>, { result: unknown; isError?: undefined }>
const editOf = (path: string, toolUseId: string) => ({ tool: 'Edit', file_path: path, old_string: 'let a = 1', new_string: "let a = 'one'", tool_use_id: toolUseId }) as never
const typeError = "a.ts(1,5): error TS2322: Type 'string' is not assignable to type 'number'."

function typed(...jobs: Job<void>[]) {
  const tested = testMod(
    defineMod({
      name: 'typed',
      setup(mod) {
        for (const job of jobs) mod.use(job)
      },
    }),
    { permissions: ['run:tsc', 'run:bun', 'prompt'] },
  )
  tested.fakes.fs.exists = async (path) => path.endsWith('.ts')
  tested.fakes.clock.after = () => ({ cancel: () => undefined })
  tested.fakes.process.run = async () => ({ exitCode: 2, stdout: `${typeError}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  return tested
}

const typeCheck = check({ after: { write: '**/*.ts' }, run: ['tsc', '--noEmit'] })

test('check runs its command after a matching call and reports a failure', async () => {
  const tested = typed(typeCheck)

  const answer = await tested.fire('tool.call', editOf(`${root}/a.ts`, 'toolu_1'), answered)

  expect(answer).toEqual({ ...answered, context: [`tsc --noEmit ${root}/a.ts exited with 2:\n${typeError}`] })
  expect(tested.calls.filter((call) => call.call === 'process.run').map((call) => call.args)).toEqual([[['tsc', '--noEmit', `${root}/a.ts`], { timeoutMs: 60000 }]])
  expect(tested.shown.logs).toEqual(['typed added a check after edits to **/*.ts.'])
})

test('a check adds nothing when its command exits 0, and does not run for an unmatched file or a refused call', async () => {
  const tested = typed(typeCheck)
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  expect(await tested.fire('tool.call', editOf(`${root}/a.ts`, 'toolu_1'), answered)).toEqual(answered)
  expect(await tested.fire('tool.call', editOf(`${root}/README.md`, 'toolu_2'), answered)).toEqual(answered)
  expect(await tested.fire('tool.call', editOf(`${root}/b.ts`, 'toolu_3'), { deny: 'No.' })).toEqual({ deny: 'No.' })
  expect(tested.calls.filter((call) => call.call === 'process.run')).toHaveLength(1)
})

test('a check after several targets runs its command once, with the matched files appended', async () => {
  const tested = typed(check({ after: [{ write: '**/*.ts' }, { command: 'git commit' }], run: ['bun', 'test'] }))
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  await tested.fire('tool.call', { tool: 'Bash', command: 'echo x > a.ts && git commit -am x', tool_use_id: 'toolu_1' } as never, answered)
  await tested.fire('tool.call', { tool: 'Bash', command: 'git commit -m x', tool_use_id: 'toolu_2' } as never, answered)

  expect(tested.calls.filter((call) => call.call === 'process.run').map((call) => call.args)).toEqual([
    [['bun', 'test', `${root}/a.ts`], { timeoutMs: 60000 }],
    [['bun', 'test'], { timeoutMs: 60000 }],
  ])
  expect(tested.shown.logs).toEqual(['typed added a check after edits to **/*.ts and git commit.'])
})

test('a check that passes its deadline tells Claude the check and the deadline', async () => {
  const tested = typed(typeCheck)
  tested.fakes.process.run = () => new Promise(() => undefined)
  tested.fakes.clock.after = (_ms, fire) => {
    void Promise.resolve().then(fire)
    return { cancel: () => undefined }
  }

  const answer = await tested.fire('tool.call', editOf(`${root}/a.ts`, 'toolu_1'), answered)

  expect(answer.context).toEqual(['The check after edits to **/*.ts failed: mod.process.run passed the 60 s deadline of check'])
})

test('a check after cd app && echo x > cart.ts runs on app/cart.ts', async () => {
  const bashMovesFolder: Job<void> = (job) => {
    const { claude } = job.mod
    claude.on('tool.call', async (e, next) => {
      claude.session.cwd = async () => `${root}/app`
      return next(e)
    })
  }
  const tested = typed(typeCheck, bashMovesFolder)
  tested.fakes.fs.exists = async (path) => path === `${root}/app/cart.ts`
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  await tested.fire('tool.call', { tool: 'Bash', command: 'cd app && echo x > cart.ts', tool_use_id: 'toolu_1' } as never, answered)

  expect(tested.calls.filter((call) => call.call === 'process.run').map((call) => call.args)).toEqual([[['tsc', '--noEmit', `${root}/app/cart.ts`], { timeoutMs: 60000 }]])
})

test('a check after edits to src/** still runs after cd src', async () => {
  const tested = testMod(
    defineMod({
      name: 'typed',
      setup(mod) {
        mod.use(check({ after: { write: 'src/**' }, run: ['tsc', '--noEmit'] }))
      },
    }),
    { cwd: `${root}/src`, files: { [`${root}/src/a.ts`]: 'let a = 1' }, permissions: ['run:tsc'] },
  )
  tested.fakes.clock.after = () => ({ cancel: () => undefined })
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  await tested.fire('tool.call', editOf(`${root}/src/a.ts`, 'toolu_1'), answered)

  expect(tested.calls.filter((call) => call.call === 'process.run').map((call) => call.args)).toEqual([[['tsc', '--noEmit', `${root}/src/a.ts`], { timeoutMs: 60000 }]])
})

test('a shell write that names several matching files runs one command with each file once', async () => {
  const tested = typed(typeCheck)

  await tested.fire('tool.call', { tool: 'Bash', command: 'sed -i s/a/b/ a.ts b.ts README.md a.ts', tool_use_id: 'toolu_1' } as never, answered)

  expect(tested.calls.filter((call) => call.call === 'process.run').map((call) => call.args)).toEqual([[['tsc', '--noEmit', `${root}/a.ts`, `${root}/b.ts`], { timeoutMs: 60000 }]])
})

test('a write check does not run when no matched file still exists', async () => {
  const tested = typed(typeCheck)
  tested.fakes.fs.exists = async () => false

  await tested.fire('tool.call', { tool: 'Bash', command: 'rm gone.ts', tool_use_id: 'toolu_1' } as never, answered)

  expect(tested.calls.filter((call) => call.call === 'process.run')).toEqual([])
})

test('a command check in a project runs in the work tree the matched command runs in', async () => {
  const project = '/work/dent'
  const tested = testMod(
    defineMod({
      name: 'dent',
      setup(mod) {
        mod.use(check({ after: { command: 'git commit' }, run: ['bun', 'run', 'test:smoke'] }))
      },
    }),
    {
      scope: 'project',
      projectRoot: project,
      permissions: ['run:bun'],
      files: {
        [`${project}/.git/HEAD`]: 'ref: refs/heads/main\n',
        [`${project}/.git/worktrees/design/commondir`]: '../..\n',
        [`${project}/worktrees/design/.git`]: `gitdir: ${project}/.git/worktrees/design\n`,
      },
    },
  )
  tested.fakes.clock.after = () => ({ cancel: () => undefined })
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  await tested.fire('tool.call', { tool: 'Bash', command: 'cd worktrees/design && git commit -m x', tool_use_id: 'toolu_1' } as never, answered)
  await tested.fire('tool.call', { tool: 'Bash', command: 'git add -A && git commit -m x', tool_use_id: 'toolu_2' } as never, answered)

  expect(tested.calls.filter((call) => call.call === 'process.run').map((call) => call.args)).toEqual([
    [['bun', 'run', 'test:smoke'], { cwd: `${project}/worktrees/design`, timeoutMs: 60000 }],
    [['bun', 'run', 'test:smoke'], { cwd: project, timeoutMs: 60000 }],
  ])
})

test('a check with no target, no command, or a timeoutMs past 10 minutes throws in setup', () => {
  expect(() => check({ after: [], run: ['tsc'] })).toThrow("check: give after a target, such as { write: '**/*.ts' }.")
  expect(() => check({ after: { write: '**/*.ts' }, run: [] })).toThrow("check: the check after edits to **/*.ts has no command. Give run a command, such as ['bun', 'test'].")
  expect(() => check({ after: { write: '**/*.ts' }, run: ['tsc'], timeoutMs: 600_001 })).toThrow(
    'check: the check after edits to **/*.ts has timeoutMs 600001. Set it above 0 and at most 600000 (10 minutes).',
  )
})
