import { expect, test } from 'bun:test'
import { slashCommand } from '../../src/jobs/slash-command.js'
import { defineMod, http } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'
import { claudeCodeOf } from '../../src/testing/claude-code.js'

test('/tree a b reaches reply with the args and their words, and the string reply is shown', async () => {
  const seen: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'file-tree',
      setup(mod) {
        mod.use(
          slashCommand({
            name: 'tree',
            description: 'Show or hide the file tree',
            reply: (input) => {
              seen.push(input)
              return `Showing ${input.positionals.length} folders`
            },
          }),
        )
      },
    }),
  )

  const answer = await tested.type('/tree a b')

  expect(seen).toEqual([{ args: 'a b', positionals: ['a', 'b'] }])
  expect(answer).toEqual({ text: 'Showing 2 folders' })
  expect(tested.shown.commands).toEqual(['tree'])
  expect(tested.shown.toasts.find(({ message }) => message === 'Installed')?.description).toContain('Adds /tree.')
})

test("a command that replies nothing and a hotkey answer Claude Code themselves, so it shows no warning row", async () => {
  let presses = 0
  const tested = testMod(
    defineMod({
      name: 'quiet',
      hotkeys: { show: { title: 'Show it', default: 'alt+p' } },
      setup(mod) {
        mod.hotkeys.show.onPress(() => void (presses += 1))
        mod.use(slashCommand({ name: 'open', description: 'Opens it', immediate: true, reply: () => undefined }))
      },
    }),
  )

  const reply = await tested.type('/open')
  await tested.hotkey('show')

  expect(reply).toEqual({})
  expect(presses).toBe(1)
})

test("reply gets the mod's own typed state, so a command counts its runs without capturing the mod from setup", async () => {
  const tested = testMod(
    defineMod({
      name: 'counter',
      state: { session: { count: 0 } },
      setup(mod) {
        mod.use(slashCommand({ name: 'count', description: 'Count the runs', reply: (_input, mod) => `${(mod.state.session.count += 1)} runs` }))
      },
    }),
  )

  expect(await tested.type('/count')).toEqual({ text: '1 runs' })
  expect(await tested.type('/count')).toEqual({ text: '2 runs' })
  expect(tested.state.session.count).toBe(2)
})

test('a second slashCommand with the same name throws in setup and names the command', async () => {
  const tested = testMod(
    defineMod({
      name: 'file-tree',
      setup(mod) {
        mod.use(slashCommand({ name: 'tree', description: 'Show the tree', reply: () => undefined }))
        mod.use(slashCommand({ name: 'tree', description: 'Hide the tree', reply: () => undefined }))
      },
    }),
  )

  await expect(tested.start()).rejects.toThrow('file-tree: the slash command /tree is already added. Give each slashCommand its own name.')
})

test('a command of another plugin passes on, and a reply that throws shows /<name> failed with the message', async () => {
  const tested = testMod(
    defineMod({
      name: 'file-tree',
      setup(mod) {
        mod.use(
          slashCommand({
            name: 'tree',
            description: 'Show the tree',
            reply: () => {
              throw new Error('git is not installed')
            },
          }),
        )
      },
    }),
  )

  const compact = { command: 'compact', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const
  expect(await claudeCodeOf(tested).fire('command.run', compact, { text: 'Compacted' })).toEqual({ text: 'Compacted' })
  expect(await tested.type('/tree')).toEqual({ text: '/tree failed: git is not installed' })
})

test('a reply that passes the 30 s deadline shows /<name> failed with the deadline and the job', async () => {
  const deadlines: number[] = []
  const tested = testMod(
    defineMod({
      name: 'weather',
      setup(mod) {
        mod.use(
          slashCommand({
            name: 'weather',
            description: 'Show the weather',
            reply: async () => (await http.fetch('https://weather.example/today')).text,
          }),
        )
      },
    }),
    { permissions: ['network:weather.example'] },
  )
  tested.fakes.http.fetch = () => new Promise(() => undefined)
  tested.fakes.clock.after = (ms, fn) => {
    deadlines.push(ms)
    fn()
    return { cancel: () => undefined }
  }

  expect(await tested.type('/weather')).toEqual({ text: '/weather failed: /weather passed the 30 s deadline of slashCommand' })
  expect(deadlines).toEqual([30000])
})
