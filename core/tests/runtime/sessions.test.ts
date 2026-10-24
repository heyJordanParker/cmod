import { expect, test } from 'bun:test'
import { defineMod, sessions } from '../../src/mod.js'
import { engineOf } from '../../src/runtime/engine.js'
import { testMod } from '../../src/testing.js'
import { claudeCodeOf } from '../../src/testing/claude-code.js'

function titles() {
  const seen: { current: string; listed: string }[] = []
  const mod = defineMod({
    name: 'titles',
    setup(mod) {
      engineOf(mod).router.add('classic.UserPromptSubmit', async (e, next) => {
        const current = sessions.current.title
        const listed = (await sessions.list()).find((session) => session.id === sessions.current.id)?.title ?? 'missing'
        seen.push({ current, listed })
        return next(e)
      })
    },
  })
  return { tested: testMod(mod, { permissions: ['conversation'] }), seen }
}

test("a new session's title is the first line of its first prompt, in sessions.current and in sessions.list()", async () => {
  const { tested, seen } = titles()
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tested.add({ type: 'prompt', text: 'Fix the login bug\nIt fails on Safari.' })
  await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'Fix the login bug\nIt fails on Safari.' })
  await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'Now add a test' })
  expect(seen).toEqual([
    { current: 'Fix the login bug', listed: 'Fix the login bug' },
    { current: 'Fix the login bug', listed: 'Fix the login bug' },
  ])
})

test('the name Claude Code gives a session is its title', async () => {
  const { tested, seen } = titles()
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'Fix the login bug', session_title: 'Login fix' })

  expect(seen[0]?.current).toBe('Login fix')
})

function colors(isListing: boolean) {
  const seen: { readonly current: string | undefined; readonly listed?: Readonly<Record<string, string | undefined>> }[] = []
  const mod = defineMod({
    name: 'colors',
    setup(mod) {
      engineOf(mod).router.add('classic.UserPromptSubmit', async (e, next) => {
        const current = sessions.current.color
        seen.push(isListing ? { current, listed: Object.fromEntries((await sessions.list()).map((session) => [session.id, session.color])) } : { current })
        return next(e)
      })
    },
  })
  return { mod, seen }
}

test('sessions.current.color follows /color in a mod without the conversation grant, and /color default clears it', async () => {
  const { mod, seen } = colors(false)
  const tested = testMod(mod)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'Fix the login bug' })
  await tested.type('/color cyan')
  await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'Now add a test' })
  await tested.type('/color default')
  await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'Ship it' })

  expect(seen).toEqual([{ current: undefined }, { current: 'cyan' }, { current: undefined }])
})

test("the color a session already has reaches sessions.current when the mod starts, and each listed session carries its own", async () => {
  const { mod, seen } = colors(true)
  const tested = testMod(mod, { permissions: ['conversation'], sessions: [{ id: 'test-session', color: 'cyan' }, { id: 'plain', title: 'No color picked' }] })
  await claudeCodeOf(tested).fire('SessionStart', { source: 'resume' })
  await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'Fix the login bug' })

  expect(seen).toEqual([{ current: 'cyan', listed: { 'test-session': 'cyan', plain: undefined } }])
})

test('/color with no color names the color to give in a test, because Claude Code picks one at random', async () => {
  const tested = testMod(colors(false).mod)

  await expect(tested.type('/color')).rejects.toThrow("tested.type('/color cyan')")
})

test('a mod that starts after the first prompt takes the title from the index, never from the prompt it first hears', async () => {
  const { tested, seen } = titles()
  await tested.add({ type: 'prompt', text: 'Fix the login bug' })
  await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'Now add a test' })
  await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'Ship it' })

  expect(seen).toEqual([
    { current: '', listed: 'Fix the login bug' },
    { current: 'Fix the login bug', listed: 'Fix the login bug' },
  ])
})
