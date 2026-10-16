import { expect, test } from 'bun:test'
import type { EventResult } from 'claude-code'
import { prompt } from '../../src/jobs/prompt.js'
import { defineMod, process, type Job } from '../../src/mod.js'
import { engineOf } from '../../src/runtime/engine.js'
import { testMod } from '../../src/testing.js'
import { claudeCodeOf } from '../../src/testing/claude-code.js'

const answered = { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as Extract<EventResult<'tool.call'>, { result: unknown; isError?: undefined }>
const bash = (command: string, toolUseId: string) => ({ tool: 'Bash', command, tool_use_id: toolUseId }) as never
const currentDate = { name: 'currentDate', text: "Today's date is 2026-10-05." }

function withPrompt(...jobs: Job<void>[]) {
  return testMod(
    defineMod({
      name: 'notes',
      setup(mod) {
        for (const job of jobs) mod.use(job)
      },
    }),
    { permissions: ['prompt', 'run:git'] },
  )
}

test('prompt adds its text after a matching call', async () => {
  const tested = withPrompt(prompt({ name: 'push-reminder', prompt: 'Push only when the user asks.', after: { command: 'git commit' } }))

  const afterCommit = await claudeCodeOf(tested).fire('tool.call', bash('git add -A && git commit -m "fix: x"', 'toolu_1'), answered)
  const afterStatus = await claudeCodeOf(tested).fire('tool.call', bash('git status', 'toolu_2'), answered)

  expect(afterCommit).toEqual({ ...answered, context: ['# push-reminder\nPush only when the user asks.'] })
  expect(afterStatus).toEqual(answered)
  expect(tested.shown.toasts.find(({ message }) => message === 'Installed')?.description).toContain('Adds the push-reminder prompt after git commit.')
})

test('a prompt after a call gives Claude the string its callback returns', async () => {
  const tested = withPrompt(prompt({ name: 'reread', after: { command: 'git commit' }, prompt: ({ call }) => (call !== undefined && 'commands' in call ? `Committed with ${call.commands.length} command.` : undefined) }))

  const answer = await claudeCodeOf(tested).fire('tool.call', bash('git commit -m x', 'toolu_1'), answered)

  expect(answer.context).toEqual(['# reread\nCommitted with 1 command.'])
})

test('a prompt after a write gets the call to build its text with', async () => {
  const tested = withPrompt(prompt({ name: 'reread', after: { write: '**/*.md' }, prompt: ({ call }) => (call !== undefined && 'path' in call ? `Reread ${call.path}.` : undefined) }))

  const answer = await claudeCodeOf(tested).fire('tool.call', { tool: 'Write', file_path: '/test/plugins/notes/README.md', content: 'x', tool_use_id: 'toolu_1' } as never, answered)

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
    { permissions: ['prompt'] },
  )

  const answer = await claudeCodeOf(tested).fire('tool.call', bash('git commit -m x', 'toolu_1'), answered)

  expect(answer.context).toEqual(['# commits\nCommit 1 landed.'])
  expect(tested.state.project.commits).toBe(1)
})

test('a prompt after a write gets the path from the folder the shell was in before the call', async () => {
  const bashMovesFolder: Job<void> = (job) => {
    const { claude, router } = engineOf(job.mod)
    router.add('tool.call', async (e, next) => {
      claude.session.cwd = async () => '/test/plugins/notes/app'
      return next(e)
    })
  }
  const tested = withPrompt(prompt({ name: 'cart', prompt: ({ call }) => (call !== undefined && 'path' in call ? call.path : undefined), after: { write: '**/cart.ts' } }), bashMovesFolder)

  expect(await claudeCodeOf(tested).fire('tool.call', bash('cd app && echo x > cart.ts', 'toolu_1'), answered)).toEqual({ ...answered, context: ['# cart\n/test/plugins/notes/app/cart.ts'] })
})

test('a prompt callback that passes its 5 s deadline adds nothing, and the mod logs why', async () => {
  const tested = withPrompt(prompt({ name: 'history', prompt: async () => (await process.run(['git', 'log', '-1'])).stdout }))
  tested.fakes.process.run = () => new Promise(() => undefined)
  tested.fakes.clock.after = (ms, fire) => {
    if (ms === 5000) void Promise.resolve().then(fire)
    return { cancel: () => undefined }
  }

  expect(await claudeCodeOf(tested).fire('prompt.context', { blocks: [] }, { blocks: [] })).toEqual({ blocks: [] })
  expect(tested.shown.debug).toContain('notes: prompt "history" added nothing: the history prompt passed the 5 s deadline of prompt')
})

test('a prompt with no trigger gives Claude its new text once each time the state it reads changes it', async () => {
  const tested = testMod(
    defineMod({
      name: 'modes',
      state: { session: { mode: 'propose', presses: 0 } },
      setup(mod) {
        mod.use(prompt({ name: 'Mode', prompt: (_input, mod) => `You are in ${mod.state.session.mode} mode.` }))
      },
    }),
    { permissions: ['prompt'] },
  )
  await tested.start()
  tested.state.session.mode = 'review'
  await tested.settle()
  expect(tested.shown.notes).toEqual([])

  expect(await claudeCodeOf(tested).fire('prompt.context', { blocks: [] }, { blocks: [] })).toEqual({ blocks: [{ name: 'Mode', text: 'You are in review mode.' }] })
  tested.state.session.mode = 'build'
  tested.state.session.presses = 1
  await tested.settle()
  tested.state.session.presses = 2
  await tested.settle()

  expect(tested.shown.notes).toEqual(['# Mode\nYou are in build mode.'])
})

test('after a resume, a prompt with no trigger gives Claude its text on the first change', async () => {
  const tested = testMod(
    defineMod({
      name: 'modes',
      state: { session: { mode: 'propose' } },
      setup(mod) {
        mod.use(prompt({ name: 'Mode', prompt: (_input, mod) => `You are in ${mod.state.session.mode} mode.` }))
      },
    }),
    { permissions: ['prompt'] },
  )
  await claudeCodeOf(tested).fire('SessionStart', { source: 'resume' })
  tested.state.session.mode = 'build'
  await tested.settle()

  expect(tested.shown.notes).toEqual(['# Mode\nYou are in build mode.'])
})

test('a prompt with a name and a text and no trigger adds one prompt.context block', async () => {
  const tested = withPrompt(prompt({ name: 'house-rules', prompt: 'Write tests with bun test.' }))

  const answer = await claudeCodeOf(tested).fire('prompt.context', { blocks: [currentDate] }, { blocks: [currentDate] })

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
    { permissions: ['prompt'] },
  )

  expect(await claudeCodeOf(tested).fire('prompt.context', { blocks: [] }, { blocks: [] })).toEqual({ blocks: [{ name: 'notes', text: 'buy milk' }] })
})

test('a prompt without the grant to add text Claude reads adds nothing, and says once which line to add', async () => {
  const tested = testMod(defineMod({ name: 'notes', setup: (mod) => mod.use(prompt({ name: 'house-rules', prompt: 'Write tests with bun test.' })) }), { permissions: [] })

  expect(await claudeCodeOf(tested).fire('prompt.context', { blocks: [] }, { blocks: [] })).toEqual({ blocks: [] })
  expect(await claudeCodeOf(tested).fire('prompt.context', { blocks: [] }, { blocks: [] })).toEqual({ blocks: [] })
  expect(tested.shown.toasts.filter(({ type }) => type === 'warning')).toEqual([
    {
      type: 'warning',
      message: 'Answered changed context without your grant to "Add text Claude reads and start turns", so cmod dropped it',
      description: 'It needs "permissions": { "prompt": true } in package.json "cmod".',
    },
  ])
})

test('a block with the same name below adds nothing and writes one debug line', async () => {
  const tested = withPrompt(prompt({ name: 'currentDate', prompt: 'Some other day.' }))

  const answer = await claudeCodeOf(tested).fire('prompt.context', { blocks: [currentDate] }, { blocks: [currentDate] })

  expect(answer).toEqual({ blocks: [currentDate] })
  expect(tested.shown.debug).toEqual(['notes: prompt "currentDate" added nothing: a block named "currentDate" is already in the context'])
  expect(tested.shown.toasts.find(({ message }) => message === 'Installed')?.description).toContain('Adds the currentDate prompt.')
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

  expect(await claudeCodeOf(tested).fire('prompt.context', { blocks: [] }, { blocks: [] })).toEqual({ blocks: [] })
  expect(tested.shown.debug).toEqual(['notes: prompt "broken" added nothing: no notes file'])
  expect(tested.shown.toasts.find(({ message }) => message === 'Installed')?.description).toContain('Adds the broken prompt.')
})

test('one name two times in one mod throws in setup', async () => {
  const twice = withPrompt(prompt({ name: 'rules', prompt: 'a' }), prompt({ name: 'rules', prompt: 'b' }))
  await expect(twice.start()).rejects.toThrow('prompt: notes adds the name "rules" two times. Give each prompt its own name.')
})
