import { expect, test } from 'bun:test'
import { schedule } from '../../src/jobs/schedule.js'
import { defineMod } from '../../src/mod.js'
import { createLifecycle } from '../../src/runtime/lifecycle.js'
import { fakeClaude } from '../../src/testing/fake-claude.js'
import { testMod } from '../../src/testing.js'

test('a schedule from the state makes one Claude Code cron, replaces it when the state changes it, and deletes it when the state turns it off', async () => {
  const tested = testMod(
    defineMod({
      name: 'loop',
      state: { project: { isOn: true, cron: '*/10 * * * *', prompt: 'Check the CI.' } },
      setup(mod) {
        mod.use(schedule((state) => (state.project.isOn ? { cron: state.project.cron, prompt: state.project.prompt } : undefined)))
      },
    }),
    { permissions: ['prompt'] },
  )
  await tested.start()
  await tested.settle()
  expect(tested.shown.schedules).toEqual([{ id: 'cron-1', cron: '*/10 * * * *', prompt: 'Check the CI.' }])

  tested.state.project.cron = '*/5 * * * *'
  await tested.settle()
  expect(tested.shown.schedules).toEqual([{ id: 'cron-2', cron: '*/5 * * * *', prompt: 'Check the CI.' }])

  tested.state.project.isOn = false
  await tested.settle()
  expect(tested.shown.schedules).toEqual([])
})

test('a schedule deletes the cron its mod made before /reload-plugins, so the cron is replaced and never doubled', async () => {
  const fake = fakeClaude({ name: 'loop', root: '/plugins/loop' })
  const definition = defineMod({ name: 'loop', setup: (mod) => mod.use(schedule({ cron: '7 * * * *', prompt: 'Summarize the hour.' })) })
  const plugin = { name: 'loop', root: '/plugins/loop', version: '0.1.0', store: '/home/.local/share/cmod', isInstalled: true, shouldRecord: false, steps: { permissions: ['prompt'] }, granted: ['prompt'] }

  for (let start = 0; start < 2; start += 1) {
    const lifecycle = createLifecycle(definition)
    await lifecycle.start(fake.claude, async () => plugin)
    await lifecycle.route('classic.UserPromptSubmit', { session_id: 's', transcript_path: '/t', cwd: '/work', hook_event_name: 'UserPromptSubmit', prompt: 'hi' } as never, async () => ({}))
    await fake.settle()
  }

  expect(fake.shown.schedules).toEqual([{ id: 'cron-2', cron: '7 * * * *', prompt: 'Summarize the hour.' }])
})

test('a schedule Claude Code refuses writes one log line naming why', async () => {
  const tested = testMod(defineMod({ name: 'loop', setup: (mod) => mod.use(schedule({ cron: 'every minute', prompt: 'Tick.' })) }), { permissions: ['prompt'] })
  tested.fakes.tool.call = (async () => ({ result: { id: '' }, text: 'Invalid cron expression: every minute', isError: true })) as never
  await tested.start()
  await tested.settle()

  expect(tested.shown.logs).toContain('loop: the schedule failed: Invalid cron expression: every minute')
})

test('a schedule without a cron or a prompt throws when the mod defines it', () => {
  expect(() => schedule({ cron: ' ', prompt: 'Tick.' })).toThrow('schedule: give it a cron, such as "*/10 * * * *" for every 10 minutes.')
  expect(() => schedule({ cron: '* * * * *', prompt: '' })).toThrow('schedule: give it the prompt Claude gets at each fire.')
})
