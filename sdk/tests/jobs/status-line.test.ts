import { expect, test } from 'bun:test'
import type { Args } from 'claude-code'
import { statusLine } from '../../src/jobs/status-line.js'
import { defineMod } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'

const measured: Args<'session.measure'> = { context: { window: 200000 }, rateLimits: [], changed: ['cost'] }

test('the line shows when the mod turns on and is sent again only when its text changes', async () => {
  let branch = 'main'
  const seen: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'branch-line',
      setup(mod) {
        mod.use(
          statusLine({
            text: (usage) => {
              seen.push(usage)
              return `${branch} · ${usage.model}`
            },
          }),
        )
      },
    }),
  )
  await tested.start()
  await tested.settle()

  await tested.fire('session.measure', measured, { changed: ['cost'] })
  await tested.settle()
  branch = 'feature'
  await tested.fire('session.measure', measured, { changed: ['cost'] })
  await tested.settle()

  expect(tested.shown.statuses).toEqual(['main · test-model', 'feature · test-model'])
  expect(seen[0]).toEqual({ model: 'test-model', context: { window: 200000 }, cost: { usd: 0 } })
  expect(seen).toHaveLength(3)
})

test("text gets the mod's own typed state, so the line shows state without capturing the mod from setup", async () => {
  const tested = testMod(
    defineMod({
      name: 'branch-line',
      state: { project: { branch: 'main' } },
      setup(mod) {
        mod.use(statusLine({ text: (_usage, mod) => `on ${mod.state.project.branch}` }))
      },
    }),
  )
  await tested.start()
  await tested.settle()

  expect(tested.shown.statuses).toEqual(['on main'])
})

test('a text that throws keeps the last line and writes one debug line', async () => {
  let fails = false
  const tested = testMod(
    defineMod({
      name: 'branch-line',
      setup(mod) {
        mod.use(
          statusLine({
            text: () => {
              if (fails) throw new Error('git timed out')
              return 'main'
            },
          }),
        )
      },
    }),
  )
  await tested.start()
  await tested.settle()
  fails = true

  await tested.fire('session.measure', measured, { changed: ['cost'] })
  await tested.settle()

  expect(tested.shown.statuses).toEqual(['main'])
  expect(tested.shown.logs).toEqual(['branch-line added a status line.'])
  expect(tested.shown.debug).toEqual(['branch-line: the status line kept its last text: git timed out'])
})

test('a file read in text that passes the 2 s deadline keeps the line hidden and names the deadline in the debug line', async () => {
  const deadlines: number[] = []
  const tested = testMod(
    defineMod({
      name: 'branch-line',
      setup(mod) {
        mod.use(statusLine({ text: async (_usage, { fs }) => (await fs.read('.git/HEAD')).trim() }))
      },
    }),
  )
  tested.fakes.fs.read = () => new Promise(() => undefined)
  tested.fakes.clock.after = (ms, fn) => {
    deadlines.push(ms)
    fn()
    return { cancel: () => undefined }
  }
  await tested.start()
  await tested.settle()

  expect(deadlines).toEqual([2000])
  expect(tested.shown.statuses).toEqual([])
  expect(tested.shown.debug).toEqual(['branch-line: the status line kept its last text: mod.fs.read passed the 2 s deadline of statusLine'])
})

test('a second statusLine in one mod throws in setup', async () => {
  const tested = testMod(
    defineMod({
      name: 'branch-line',
      setup(mod) {
        mod.use(statusLine({ text: () => 'one' }))
        mod.use(statusLine({ text: () => 'two' }))
      },
    }),
  )

  await expect(tested.start()).rejects.toThrow('branch-line: a status line is already added. A mod has one status line: join the texts in one statusLine.')
})
