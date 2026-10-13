import { expect, test } from 'bun:test'
import { defineMod, SessionStart, sessions, UserPromptSubmit } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'

function titles() {
  const seen: { current: string; listed: string }[] = []
  const mod = defineMod({
    name: 'titles',
    setup(mod) {
      mod.on(UserPromptSubmit, async () => {
        const current = sessions.current.title
        const listed = (await sessions.list()).find((session) => session.id === sessions.current.id)?.title ?? 'missing'
        seen.push({ current, listed })
      })
    },
  })
  return { tested: testMod(mod, { permissions: ['conversation'] }), seen }
}

test("a new session's title is the first line of its first prompt, in sessions.current and in sessions.list()", async () => {
  const { tested, seen } = titles()
  await tested.fire(SessionStart, { source: 'startup' })
  await tested.add({ type: 'prompt', text: 'Fix the login bug\nIt fails on Safari.' })
  await tested.fire(UserPromptSubmit, { prompt: 'Fix the login bug\nIt fails on Safari.' })
  await tested.fire(UserPromptSubmit, { prompt: 'Now add a test' })
  expect(seen).toEqual([
    { current: 'Fix the login bug', listed: 'Fix the login bug' },
    { current: 'Fix the login bug', listed: 'Fix the login bug' },
  ])
})

test('the name Claude Code gives a session is its title', async () => {
  const { tested, seen } = titles()
  await tested.fire(SessionStart, { source: 'startup' })
  await tested.fire(UserPromptSubmit, { prompt: 'Fix the login bug', session_title: 'Login fix' })

  expect(seen[0]?.current).toBe('Login fix')
})

test('a mod that starts after the first prompt takes the title from the index, never from the prompt it first hears', async () => {
  const { tested, seen } = titles()
  await tested.add({ type: 'prompt', text: 'Fix the login bug' })
  await tested.fire(UserPromptSubmit, { prompt: 'Now add a test' })
  await tested.fire(UserPromptSubmit, { prompt: 'Ship it' })

  expect(seen).toEqual([
    { current: '', listed: 'Fix the login bug' },
    { current: 'Fix the login bug', listed: 'Fix the login bug' },
  ])
})
