import { expect, test } from 'bun:test'
import type { EventResult } from 'claude-code'
import { prompt } from '../../src/jobs/prompt.js'
import { defineMod, type Part } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'

const answered = { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as Extract<EventResult<'tool.call'>, { result: unknown; isError?: undefined }>
const bash = (command: string, toolUseId: string) => ({ tool: 'Bash', command, tool_use_id: toolUseId }) as never
const currentDate = { name: 'currentDate', text: "Today's date is 2026-10-05." }

function withPrompt(...parts: Part<void>[]) {
  return testMod(
    defineMod({
      name: 'notes',
      setup(mod) {
        for (const part of parts) mod.use(part)
      },
    }),
  )
}

test('prompt adds its text after a matching call', async () => {
  const tested = withPrompt(prompt({ name: 'push-reminder', prompt: 'Push only when the user asks.', after: { command: 'git commit' } }))

  const afterCommit = await tested.fire('tool.call', bash('git add -A && git commit -m "fix: x"', 'toolu_1'), answered)
  const afterStatus = await tested.fire('tool.call', bash('git status', 'toolu_2'), answered)

  expect(afterCommit).toEqual({ ...answered, context: ['# push-reminder\nPush only when the user asks.'] })
  expect(afterStatus).toEqual(answered)
  expect(tested.shown.logs).toEqual(['notes added the push-reminder prompt after git commit.'])
})

test('a prompt after a call gives Claude the string its callback returns', async () => {
  const tested = withPrompt(prompt({ name: 'reread', after: { command: 'git commit' }, prompt: ({ call }) => (call !== undefined && 'commands' in call ? `Committed with ${call.commands.length} command.` : undefined) }))

  const answer = await tested.fire('tool.call', bash('git commit -m x', 'toolu_1'), answered)

  expect(answer.context).toEqual(['# reread\nCommitted with 1 command.'])
})

test('a prompt after a write gets the call to build its text with', async () => {
  const tested = withPrompt(prompt({ name: 'reread', after: { write: '**/*.md' }, prompt: ({ call }) => (call !== undefined && 'path' in call ? `Reread ${call.path}.` : undefined) }))

  const answer = await tested.fire('tool.call', { tool: 'Write', file_path: '/test/plugins/notes/README.md', content: 'x', tool_use_id: 'toolu_1' } as never, answered)

  expect(answer.context).toEqual(['# reread\nReread /test/plugins/notes/README.md.'])
})

test("a prompt callback after a call gets the mod's own typed state, so it counts commits without capturing the mod from setup", async () => {
  const tested = testMod(
    defineMod({
      name: 'reread',
      state: { project: { commits: 0 } },
      setup(mod) {
        mod.use(prompt({ name: 'commits', after: { command: 'git commit' }, prompt: (_input, mod) => `Commit ${(mod.state.project.commits += 1)} landed.` }))
      },
    }),
  )

  const answer = await tested.fire('tool.call', bash('git commit -m x', 'toolu_1'), answered)

  expect(answer.context).toEqual(['# commits\nCommit 1 landed.'])
  expect(tested.state.project.commits).toBe(1)
})

test('a prompt after a write gets the path from the folder the shell was in before the call', async () => {
  const bashMovesFolder: Part<void> = ({ claude, on }) => {
    on('tool.call', async (e, next) => {
      claude.session.cwd = async () => '/test/plugins/notes/app'
      return next(e)
    })
  }
  const tested = withPrompt(prompt({ name: 'cart', prompt: ({ call }) => (call !== undefined && 'path' in call ? call.path : undefined), after: { write: '**/cart.ts' } }), bashMovesFolder)

  expect(await tested.fire('tool.call', bash('cd app && echo x > cart.ts', 'toolu_1'), answered)).toEqual({ ...answered, context: ['# cart\n/test/plugins/notes/app/cart.ts'] })
})

test('a prompt callback can run past 5 seconds within its deadline', async () => {
  const tested = withPrompt(prompt({ name: 'history', prompt: async (_input, mod) => (await mod.process.run(['git', 'log', '-1'], { timeoutMs: 60_000 })).stdout }))
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: 'fix: x', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  tested.fakes.clock.after = (ms, fire) => {
    if (ms <= 5000) void Promise.resolve().then(fire)
    return { cancel: () => undefined }
  }

  expect(await tested.fire('prompt.context', { blocks: [] }, { blocks: [] })).toEqual({ blocks: [{ name: 'history', text: 'fix: x' }] })
  expect(tested.calls.find((call) => call.call === 'process.run')?.args).toEqual([['git', 'log', '-1'], { timeoutMs: 60000 }])
})

test('a prompt with a name and a text and no trigger adds one prompt.context block', async () => {
  const tested = withPrompt(prompt({ name: 'house-rules', prompt: 'Write tests with bun test.' }))

  const answer = await tested.fire('prompt.context', { blocks: [currentDate] }, { blocks: [currentDate] })

  expect(answer).toEqual({ blocks: [currentDate, { name: 'house-rules', text: 'Write tests with bun test.' }] })
})

test("a prompt callback gets the mod's own typed state, so a block shows state without capturing the mod from setup", async () => {
  const tested = testMod(
    defineMod({
      name: 'notes',
      state: { global: { notes: ['buy milk'] } },
      setup(mod) {
        mod.use(prompt({ name: 'notes', prompt: (_input, mod) => mod.state.global.notes.join('\n') }))
      },
    }),
  )

  expect(await tested.fire('prompt.context', { blocks: [] }, { blocks: [] })).toEqual({ blocks: [{ name: 'notes', text: 'buy milk' }] })
})

test('a block with the same name below adds nothing and writes one debug line', async () => {
  const tested = withPrompt(prompt({ name: 'currentDate', prompt: 'Some other day.' }))

  const answer = await tested.fire('prompt.context', { blocks: [currentDate] }, { blocks: [currentDate] })

  expect(answer).toEqual({ blocks: [currentDate] })
  expect(tested.shown.debug).toEqual(['prompt "currentDate" added nothing: a block named "currentDate" is already in the context'])
  expect(tested.shown.logs).toEqual(['notes added the currentDate prompt.'])
})

const submitted = (text: string) => ({ text, wait: false, origin: { kind: 'user' } }) as never
const entered = { text: '' } as never

function contextBelow(passedOn: unknown[]): Part<void> {
  return (part) => {
    part.on('prompt.submit', async (e, next) => {
      passedOn.push(e.context)
      return next(e)
    })
  }
}

test('a prompt with when adds its text beside each user prompt that when accepts', async () => {
  const passedOn: unknown[] = []
  const byPattern = withPrompt(prompt({ name: 'release', prompt: ({ userPrompt }) => `Release steps for: ${userPrompt}`, when: /\brelease\b/i }), contextBelow(passedOn))
  const byFunction = withPrompt(prompt({ name: 'release', prompt: 'Run bun run release.', when: (userPrompt) => userPrompt.startsWith('ship') }), contextBelow(passedOn))

  await byPattern.fire('prompt.submit', submitted('Cut a Release'), entered)
  await byPattern.fire('prompt.submit', submitted('Fix the bug'), entered)
  await byFunction.fire('prompt.submit', submitted('ship it'), entered)

  expect(passedOn).toEqual([['# release\nRelease steps for: Cut a Release'], undefined, ['# release\nRun bun run release.']])
  expect(byPattern.shown.logs).toEqual(['notes added the release prompt after matching user prompts.'])
})

test('a prompt with when shows its name above its text', async () => {
  const passedOn: unknown[] = []
  const tested = withPrompt(prompt({ name: 'release', prompt: 'Run bun run release.', when: /release/ }), contextBelow(passedOn))

  await tested.fire('prompt.submit', submitted('release it'), entered)

  expect(passedOn).toEqual([['# release\nRun bun run release.']])
})

test('a prompt with after shows its name above its text', async () => {
  const tested = withPrompt(prompt({ name: 'push-reminder', prompt: 'Push only when the user asks.', after: { command: 'git commit' } }))

  const answer = await tested.fire('tool.call', bash('git commit -m x', 'toolu_1'), answered)

  expect(answer.context).toEqual(['# push-reminder\nPush only when the user asks.'])
})

test('a callback that throws adds nothing and writes one debug line', async () => {
  const tested = withPrompt(
    prompt({
      name: 'broken',
      prompt: () => {
        throw new Error('no notes file')
      },
    }),
  )

  expect(await tested.fire('prompt.context', { blocks: [] }, { blocks: [] })).toEqual({ blocks: [] })
  expect(tested.shown.debug).toEqual(['prompt "broken" added nothing: no notes file'])
  expect(tested.shown.logs).toEqual(['notes added the broken prompt.'])
})

test('one name two times in one mod, or when with after, throws in setup', async () => {
  const twice = withPrompt(prompt({ name: 'rules', prompt: 'a' }), prompt({ name: 'rules', prompt: 'b' }))
  await expect(twice.start()).rejects.toThrow('prompt: notes adds the name "rules" two times. Give each prompt its own name.')
  expect(() => prompt({ name: 'x', prompt: 'y', when: /x/, after: { command: 'git' } })).toThrow('prompt "x": use when or after, not both. Add a second prompt for the other trigger.')
})
