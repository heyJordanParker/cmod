import { expect, test } from 'bun:test'
import type { EventResult } from 'claude-code'
import { checks } from '../../src/jobs/checks.js'
import { defineMod, type Part } from '../../src/mod.js'
import { testModWithEngine } from '../../src/testing.js'

const root = '/test/plugins/typed'
const answered = { result: { filePath: `${root}/a.ts` }, text: 'The file was updated.' } as Extract<EventResult<'tool.call'>, { result: unknown; isError?: undefined }>
const editOf = (path: string, toolUseId: string) => ({ tool: 'Edit', file_path: path, old_string: 'let a = 1', new_string: "let a = 'one'", tool_use_id: toolUseId }) as never
const typeError = "a.ts(1,5): error TS2322: Type 'string' is not assignable to type 'number'."

function typed() {
  const tested = testModWithEngine(
    defineMod({
      name: 'typed',
      setup(mod) {
        mod.use(checks({ after: [{ write: '**/*.ts', run: ['tsc', '--noEmit'] }] }))
      },
    }),
  )
  tested.fakes.fs.exists = async (path) => path.endsWith('.ts')
  tested.fakes.clock.after = () => ({ cancel: () => undefined })
  tested.fakes.process.run = async () => ({ exitCode: 2, stdout: `${typeError}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  return tested
}

test('a check after write **/*.ts runs once after an Edit of a.ts with a.ts appended, and its failing output reaches Claude as context', async () => {
  const tested = typed()

  const answer = await tested.fire('tool.call', editOf(`${root}/a.ts`, 'toolu_1'), answered)

  expect(answer).toEqual({ ...answered, context: [`tsc --noEmit ${root}/a.ts exited with 2:\n${typeError}`] })
  expect(tested.calls.filter((call) => call.call === 'process.run').map((call) => call.args)).toEqual([[['tsc', '--noEmit', `${root}/a.ts`], { timeoutMs: 60000 }]])
  expect(tested.shown.logs).toEqual(['typed added a check after edits to **/*.ts.'])
})

test('a check adds nothing when its command exits 0, and does not run for an unmatched file or a refused call', async () => {
  const tested = typed()
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  expect(await tested.fire('tool.call', editOf(`${root}/a.ts`, 'toolu_1'), answered)).toEqual(answered)
  expect(await tested.fire('tool.call', editOf(`${root}/README.md`, 'toolu_2'), answered)).toEqual(answered)
  expect(await tested.fire('tool.call', editOf(`${root}/b.ts`, 'toolu_3'), { deny: 'No.' })).toEqual({ deny: 'No.' })
  expect(tested.calls.filter((call) => call.call === 'process.run')).toHaveLength(1)
})

test('a check that passes its deadline tells Claude the check and the deadline', async () => {
  const tested = typed()
  tested.fakes.process.run = () => new Promise(() => undefined)
  tested.fakes.clock.after = (_ms, fire) => {
    void Promise.resolve().then(fire)
    return { cancel: () => undefined }
  }

  const answer = await tested.fire('tool.call', editOf(`${root}/a.ts`, 'toolu_1'), answered)

  expect(answer.context).toEqual([`The check after edits to **/*.ts failed: tsc --noEmit ${root}/a.ts passed the 60 s deadline of checks`])
})

test('a check whose run is a function gives Claude the string it returns', async () => {
  const tested = testModWithEngine(
    defineMod({
      name: 'reread',
      setup(mod) {
        mod.use(checks({ after: [{ command: 'git commit', run: (call) => `Committed with ${call.commands.length} command.` }] }))
      },
    }),
  )

  const answer = await tested.fire('tool.call', { tool: 'Bash', command: 'git commit -m x', tool_use_id: 'toolu_1' } as never, answered)

  expect(answer.context).toEqual(['Committed with 1 command.'])
})

test("a check's run gets the mod's own typed state, so it counts commits without capturing the mod from setup", async () => {
  const tested = testModWithEngine(
    defineMod({
      name: 'reread',
      state: { project: { commits: 0 } },
      setup(mod) {
        mod.use(checks({ after: [{ command: 'git commit', run: (_call, mod) => `Commit ${(mod.state.project.commits += 1)} landed.` }] }))
      },
    }),
  )

  const answer = await tested.fire('tool.call', { tool: 'Bash', command: 'git commit -m x', tool_use_id: 'toolu_1' } as never, answered)

  expect(answer.context).toEqual(['Commit 1 landed.'])
  expect(tested.state.project.commits).toBe(1)
})

test('a check after cd app && echo x > cart.ts runs on app/cart.ts', async () => {
  const bashMovesFolder: Part<void> = ({ claude, on }) => {
    on('tool.call', async (e, next) => {
      claude.session.cwd = async () => `${root}/app`
      return next(e)
    })
  }
  const tested = testModWithEngine(
    defineMod({
      name: 'typed',
      setup(mod) {
        mod.use(checks({ after: [{ write: '**/*.ts', run: ['tsc', '--noEmit'] }] }))
        mod.use(bashMovesFolder)
      },
    }),
  )
  tested.fakes.fs.exists = async (path) => path === `${root}/app/cart.ts`
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  await tested.fire('tool.call', { tool: 'Bash', command: 'cd app && echo x > cart.ts', tool_use_id: 'toolu_1' } as never, answered)

  expect(tested.calls.filter((call) => call.call === 'process.run').map((call) => call.args)).toEqual([[['tsc', '--noEmit', `${root}/app/cart.ts`], { timeoutMs: 60000 }]])
})

test('a timeoutMs past 10 minutes throws in setup', () => {
  expect(() => checks({ after: [{ write: '**/*.ts', run: ['tsc'], timeoutMs: 600_001 }] })).toThrow(
    'checks: the check after edits to **/*.ts has timeoutMs 600001. Set it above 0 and at most 600000 (10 minutes).',
  )
})
