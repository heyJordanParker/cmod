import { expect, test } from 'bun:test'
import type { Args, Frozen } from 'claude-code'
import { defineMod, process, sessions } from '../../src/mod.js'
import { engineOf } from '../../src/runtime/engine.js'
import { createLifecycle } from '../../src/runtime/lifecycle.js'
import { conversationMethods } from '../../src/runtime/sessions.js'
import { testMod } from '../../src/testing.js'
import { claudeCodeOf } from '../../src/testing/claude-code.js'
import { fakeClaude } from '../../src/testing/fake-claude.js'

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
  return { tested: testMod(mod), seen }
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

test('sessions.current.color follows /color, and /color default clears it', async () => {
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
  const tested = testMod(mod, { sessions: [{ id: 'test-session', color: 'cyan' }, { id: 'plain', title: 'No color picked' }] })
  await claudeCodeOf(tested).fire('SessionStart', { source: 'resume' })
  await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'Fix the login bug' })

  expect(seen).toEqual([{ current: 'cyan', listed: { 'test-session': 'cyan', plain: undefined } }])
})

test('/color with no color names the color to give in a test, because Claude Code picks one at random', async () => {
  const tested = testMod(colors(false).mod)

  await expect(tested.type('/color')).rejects.toThrow("tested.type('/color cyan')")
})

test("a listener under a task still hears that task's subtasks start after /clear moves it to the new session", async () => {
  const heard: string[] = []
  const tested = testMod(defineMod({ name: 'history', setup() {} }))
  await tested.start()
  const parent = await tested.startTask({ title: 'Find the pane' })
  const [task] = await sessions.current.goal.tasks()
  task!.onTaskStart((started) => void heard.push(started.title))
  await tested.settle()
  await tested.startSession({ source: 'clear', id: 'after-clear' })
  await tested.settle()

  await tested.startTask({ title: 'Read tree.ts', parent })

  expect(heard).toEqual(['Read tree.ts'])
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

async function installedMod(setup: () => void) {
  const fake = fakeClaude({ name: 'tracer', root: '/plugins/tracer' })
  fake.store.set('cmod:announced', { version: '1.0.0', added: [] })
  fake.fakes.cmod.call = async (call) => (call.method === 'cmod:failed' ? { showsToast: true } : null)
  const lifecycle = createLifecycle(defineMod({ name: 'tracer', setup }))
  await lifecycle.start(fake.claude, async () => ({ name: 'tracer', root: '/plugins/tracer', version: '1.0.0', store: '/home/.local/share/cmod', isInstalled: true, shouldRecord: false, steps: {} }))
  await fake.settle()
  return { fake, lifecycle }
}

test('a mod listens on every session, with nothing declared in package.json "cmod"', async () => {
  const { fake, lifecycle } = await installedMod(() => void sessions.onPrompt(() => undefined))

  expect(lifecycle.toasts).toEqual([])
  expect(fake.calls.flatMap(({ call, args: [input] }) => (call === 'cmod.call' && (input as { method: string }).method === conversationMethods.subscribe ? [(input as { input: unknown }).input] : []))).toEqual([{ session: '*', subscriptions: [{ event: 'prompt', matcher: undefined }] }])
})

test("a mod's note before a tool call reaches the cmod plugin, with nothing declared in package.json \"cmod\"", async () => {
  const { fake, lifecycle } = await installedMod(() => void sessions.current.beforeToolCall({ name: 'Bash' }, () => ({ note: 'Run it from the project root.' })))
  await lifecycle.route('classic.SessionStart', { session_id: 'test-session', transcript_path: '/t', cwd: '/work', hook_event_name: 'SessionStart', source: 'startup' } as unknown as Frozen<Args<'classic.SessionStart'>>, async () => ({}))
  const ask = { to: 'tracer', caller: 'cmod', method: conversationMethods.before, input: { session: 'test-session', event: 'toolCall', change: { type: 'message', message: { id: 't1', at: '', type: 'toolCall', session: 'test-session', context: 1, callId: 't1', name: 'Bash', input: {}, cwd: '/work', files: { read: [], changed: [] } } } } }

  const answer = await lifecycle.route('cmod.call', ask, async () => ({ deny: 'unanswered' }))
  await fake.settle()

  expect(answer).toEqual({ value: { note: '<tracer_mod>\nRun it from the project root.\n</tracer_mod>' } })
  expect(lifecycle.toasts).toEqual([])
})

const startSession = { session_id: 'test-session', transcript_path: '/t', cwd: '/work', hook_event_name: 'SessionStart', source: 'startup' } as unknown as Frozen<Args<'classic.SessionStart'>>

const askAbout = (event: 'toolCall' | 'toolResult') => {
  const message = { id: 't1', at: '', type: event, session: 'test-session', context: 1, callId: 't1', name: 'Bash', input: { command: 'make test' }, cwd: '/work', files: { read: [], changed: [] }, ...(event === 'toolResult' ? { output: 'Interrupted by user', isError: true } : {}) }
  return { to: 'tracer', caller: 'cmod', method: conversationMethods.before, input: { session: 'test-session', event, change: { type: 'message', message } } } as unknown as Frozen<Args<'cmod.call'>>
}

type RunsTrace = (time: { readonly signal: AbortSignal }) => Promise<undefined>

const listeners: readonly (readonly ['beforeToolCall' | 'beforeToolResult', 'toolCall' | 'toolResult', (listener: RunsTrace) => void])[] = [
  ['beforeToolCall', 'toolCall', (listener) => void sessions.current.beforeToolCall((_call, time) => listener(time))],
  ['beforeToolResult', 'toolResult', (listener) => void sessions.current.beforeToolResult((_result, time) => listener(time))],
]

for (const [method, event, listen] of listeners) {
  test(`a ${method} listener whose process.run Claude Code kills when the person presses Esc shows no toast, and its signal aborts`, async () => {
    const pressedEsc = new AbortController()
    const signals: AbortSignal[] = []
    const { fake, lifecycle } = await installedMod(() =>
      listen(async ({ signal }) => {
        signals.push(signal)
        await process.run(['trace', 'hook', 'PostToolUseFailure'])
        return undefined
      }),
    )
    fake.fakes.process.run = () => new Promise((_resolve, reject) => pressedEsc.signal.addEventListener('abort', () => reject(new Error('tracer: $.process.run(/home/.local/share/cmod/programs/trace) aborted'))))
    await lifecycle.route('classic.SessionStart', startSession, async () => ({}))

    const answer = lifecycle.route('cmod.call', askAbout(event), async () => ({ deny: 'unanswered' }), pressedEsc.signal)
    await fake.settle()
    pressedEsc.abort()

    expect(await answer).toEqual({ value: null })
    await fake.settle()
    expect(lifecycle.toasts).toEqual([])
    expect(signals.map((signal) => signal.aborted)).toEqual([true])
  })
}

test('a beforeToolCall listener that passes its timeoutMs still shows its toast, though Claude Code gave the ask a signal', async () => {
  const { fake, lifecycle } = await installedMod(() => void sessions.current.beforeToolCall(() => new Promise<undefined>(() => undefined), { timeoutMs: 20 }))
  await lifecycle.route('classic.SessionStart', startSession, async () => ({}))

  const answer = await lifecycle.route('cmod.call', askAbout('toolCall'), async () => ({ deny: 'unanswered' }), new AbortController().signal)
  await fake.settle()

  expect(answer).toEqual({ value: null })
  expect(lifecycle.toasts).toEqual([{ type: 'error', message: 'The beforeToolCall listener failed', description: 'beforeToolCall passed its 0.02 s timeout' }])
})
