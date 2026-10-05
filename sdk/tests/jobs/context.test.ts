import { expect, test } from 'bun:test'
import type { EventResult } from 'claude-code'
import { context } from '../../src/jobs/context.js'
import { defineMod, type Part } from '../../src/mod.js'
import { testModWithEngine } from '../../src/testing.js'

const answered = { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as Extract<EventResult<'tool.call'>, { result: unknown; isError?: undefined }>
const bash = (command: string, toolUseId: string) => ({ tool: 'Bash', command, tool_use_id: toolUseId }) as never
const currentDate = { name: 'currentDate', text: "Today's date is 2026-10-05." }

function withContext(...parts: Part<void>[]) {
  return testModWithEngine(
    defineMod({
      name: 'notes',
      setup(mod) {
        for (const part of parts) mod.use(part)
      },
    }),
  )
}

test("context after { command: 'git commit' } adds its text after a git commit call and not after git status", async () => {
  const tested = withContext(context({ name: 'push-reminder', text: 'Push only when the user asks.', after: { command: 'git commit' } }))

  const afterCommit = await tested.fire('tool.call', bash('git add -A && git commit -m "fix: x"', 'toolu_1'), answered)
  const afterStatus = await tested.fire('tool.call', bash('git status', 'toolu_2'), answered)

  expect(afterCommit).toEqual({ ...answered, context: ['Push only when the user asks.'] })
  expect(afterStatus).toEqual(answered)
  expect(tested.shown.logs).toEqual(['notes added the push-reminder context after git commit.'])
})

test('context after a write gets the path from the folder the shell was in before the call', async () => {
  const bashMovesFolder: Part<void> = ({ claude, on }) => {
    on('tool.call', async (e, next) => {
      claude.session.cwd = async () => '/test/plugins/notes/app'
      return next(e)
    })
  }
  const tested = withContext(context({ name: 'cart', text: ({ call }) => (call !== undefined && 'path' in call ? call.path : undefined), after: { write: '**/cart.ts' } }), bashMovesFolder)

  expect(await tested.fire('tool.call', bash('cd app && echo x > cart.ts', 'toolu_1'), answered)).toEqual({ ...answered, context: ['/test/plugins/notes/app/cart.ts'] })
})

test('context with a name and a text and no trigger adds one prompt.context block', async () => {
  const tested = withContext(context({ name: 'house-rules', text: 'Write tests with bun test.' }))

  const answer = await tested.fire('prompt.context', { blocks: [currentDate] }, { blocks: [currentDate] })

  expect(answer).toEqual({ blocks: [currentDate, { name: 'house-rules', text: 'Write tests with bun test.' }] })
})

test("text gets the mod's own typed state, so a block shows state without capturing the mod from setup", async () => {
  const tested = testModWithEngine(
    defineMod({
      name: 'notes',
      state: { global: { notes: ['buy milk'] } },
      setup(mod) {
        mod.use(context({ name: 'notes', text: (_input, mod) => mod.state.global.notes.join('\n') }))
      },
    }),
  )

  expect(await tested.fire('prompt.context', { blocks: [] }, { blocks: [] })).toEqual({ blocks: [{ name: 'notes', text: 'buy milk' }] })
})

test('a block with the same name below adds nothing and writes one debug line', async () => {
  const tested = withContext(context({ name: 'currentDate', text: 'Some other day.' }))

  const answer = await tested.fire('prompt.context', { blocks: [currentDate] }, { blocks: [currentDate] })

  expect(answer).toEqual({ blocks: [currentDate] })
  expect(tested.shown.debug).toEqual(['context "currentDate" added nothing: a block named "currentDate" is already in the context'])
  expect(tested.shown.logs).toEqual(['notes added the currentDate context.'])
})

test('context with when adds its text beside each prompt that when accepts', async () => {
  const passedOn: unknown[] = []
  const recorder: Part<void> = (part) => {
    part.on('prompt.submit', async (e, next) => {
      passedOn.push(e.context)
      return next(e)
    })
  }
  const prompt = (text: string) => ({ text, wait: false, origin: { kind: 'user' } }) as never
  const entered = { text: '' } as never
  const byPattern = withContext(context({ name: 'release', text: ({ prompt }) => `Release steps for: ${prompt}`, when: /\brelease\b/i }), recorder)
  const byFunction = withContext(context({ name: 'release', text: 'Run bun run release.', when: (text) => text.startsWith('ship') }), recorder)

  await byPattern.fire('prompt.submit', prompt('Cut a Release'), entered)
  await byPattern.fire('prompt.submit', prompt('Fix the bug'), entered)
  await byFunction.fire('prompt.submit', prompt('ship it'), entered)

  expect(passedOn).toEqual([['Release steps for: Cut a Release'], undefined, ['Run bun run release.']])
  expect(byPattern.shown.logs).toEqual(['notes added the release context after matching prompts.'])
})

test('a text that throws adds nothing and writes one debug line', async () => {
  const tested = withContext(
    context({
      name: 'broken',
      text: () => {
        throw new Error('no notes file')
      },
    }),
  )

  expect(await tested.fire('prompt.context', { blocks: [] }, { blocks: [] })).toEqual({ blocks: [] })
  expect(tested.shown.debug).toEqual(['context "broken" added nothing: no notes file'])
  expect(tested.shown.logs).toEqual(['notes added the broken context.'])
})

test('one name two times in one mod, or when with after, throws in setup', async () => {
  const twice = withContext(context({ name: 'rules', text: 'a' }), context({ name: 'rules', text: 'b' }))
  await expect(twice.start()).rejects.toThrow('context: notes adds the name "rules" two times. Give each context its own name.')
  expect(() => context({ name: 'x', text: 'y', when: /x/, after: { command: 'git' } })).toThrow('context "x": use when or after, not both. Add a second context for the other trigger.')
})
