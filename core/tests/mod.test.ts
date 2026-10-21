import { expect, expectTypeOf, test } from 'bun:test'
import type { RenderElement } from 'claude-code'
import { slashCommand } from '../src/jobs/slash-command.js'
import { tool } from '../src/jobs/tool.js'
import corePackage from '../package.json' with { type: 'json' }
import { clipboard, commands, config, defineMod, fs, messageOf, model, Note, Person, process, Prompt, Reply, sessions, settings, ToolCall, ToolResult, type CwdChange, type Job, type Listener, type ListenerTime, type Mod, type Page, type Pane, type PaneInit, type Subscription, type Task, type Timer } from '../src/mod.js'
import { coreVersion } from '../src/records.js'
import type { Claude } from '../src/runtime/claude.js'
import { createLifecycle } from '../src/runtime/lifecycle.js'
import { installerPaneOf } from '../src/runtime/installer.js'
import { engineOf } from '../src/runtime/engine.js'
import { testMod, type FakeSession, type TestedMod } from '../src/testing.js'
import { claudeCodeOf } from '../src/testing/claude-code.js'
import { calledAnswer, fakeClaude, type TestCall } from '../src/testing/fake-claude.js'
import { findElement, textOf } from '../src/testing/fake-elements.js'
import { Box, Button, Text } from '../src/ui/elements.js'
import type { TracerSignature } from './tracer.js'

const touchTracker = defineMod({
  name: 'touch-tracker',
  state: { session: { hasSetUp: false, touched: [] as string[] } },
  setup(mod) {
    mod.state.session.hasSetUp = true
    sessions.current.beforeToolResult((result) => {
      mod.state.session.touched = [...mod.state.session.touched, result.name]
      return { note: `touch-tracker saw ${result.name}` }
    })
  },
})

test("an installed mod's setup runs during session.start and its beforeToolResult answers the first result", async () => {
  const tested = testMod(touchTracker, { permissions: ['prompt'] })
  await tested.start()
  expect(tested.state).toEqual({ session: { hasSetUp: true, touched: [] } })

  const answer = await claudeCodeOf(tested).fire('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/work/a.ts' }, tool_response: {} })

  expect(answer).toEqual({ additionalContext: ['<touch-tracker_mod>\ntouch-tracker saw Read\n</touch-tracker_mod>'] })
  expect(tested.state.session.touched).toEqual(['Read'])
})

test('mod.every runs its hook on each tick, skips a tick while the last run is still going, and shows a failure', async () => {
  let tick: () => void = () => undefined
  let finishRun: () => void = () => undefined
  const runs: number[] = []
  const tested = testMod(
    defineMod({
      name: 'ci-watch',
      setup(mod) {
        mod.every(30_000, async () => {
          runs.push(runs.length + 1)
          if (runs.length === 1) await new Promise<void>((resolve) => (finishRun = resolve))
          if (runs.length === 2) throw new Error('CI is down')
        })
      },
    }),
  )
  tested.fakes.clock.every = (_ms, fn) => {
    tick = fn
    return { cancel: () => undefined }
  }
  await tested.start()

  tick()
  tick()
  await tested.settle()
  finishRun()
  await tested.settle()
  tick()
  await tested.settle()

  expect(runs).toEqual([1, 2])
  expect(tested.calls.filter(({ call }) => call === 'clock.every').map(({ args }) => args[0])).toEqual([30_000])
  expect(tested.shown.toasts).toContainEqual({ type: 'error', message: 'The every 30000 ms timer failed', description: 'CI is down' })
})

test('mod.every refuses a time that is not a whole number of milliseconds', async () => {
  const lifecycle = createLifecycle(defineMod({ name: 'ticker', setup: (mod) => void mod.every(0.5, () => undefined) }))
  const fake = fakeClaude({ name: 'ticker', root: '/test/plugins/ticker' })

  await lifecycle.start(fake.claude, async () => ({ name: 'ticker', root: '/test/plugins/ticker', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {}, granted: [] }))

  expect(String(lifecycle.failure)).toContain('ticker: mod.every is 0.5. Give a whole number of milliseconds above 0 and at most 2147483647.')
})

test('sessions.current.send adds a Note Claude reads, and a Prompt asks Claude for a turn', async () => {
  const tested = testMod(
    defineMod({
      name: 'ci-watch',
      setup() {
        sessions.current.onSessionStart(async () => {
          await sessions.current.send({ type: Note, text: 'CI failed on main.' })
          await sessions.current.send({ type: Prompt, text: 'Find the cause of the CI failure and fix it.' })
        })
      },
    }),
    { permissions: ['prompt'] },
  )

  await tested.raise.onSessionStart({ source: 'startup' })

  expect(tested.shown.notes).toEqual(['CI failed on main.'])
  expect(tested.shown.prompts).toEqual(['Find the cause of the CI failure and fix it.'])
  expect(tested.calls.find(({ call }) => call === 'session.append')?.args).toEqual([{ message: { type: 'user', content: [{ type: 'text', text: '<ci-watch_mod>\nCI failed on main.\n</ci-watch_mod>' }] } }])
})

test('sessions.current.send rejects with the reason when a plugin refuses the Note', async () => {
  let failure = ''
  const tested = testMod(
    defineMod({
      name: 'ci-watch',
      setup: () => void sessions.current.onSessionStart(() => sessions.current.send({ type: Note, text: 'CI failed.' }).catch((error: Error) => void (failure = error.message))),
    }),
    { permissions: ['prompt'] },
  )
  tested.fakes.session.append = async () => ({ deny: 'Notes are off in this organization.' })

  await tested.raise.onSessionStart({ source: 'startup' })

  expect(failure).toBe('ci-watch: Claude Code refused the note: Notes are off in this organization.')
})

test("model.complete passes the request and options to Claude Code's model call", async () => {
  let verdict: unknown
  const tested = testMod(
    defineMod({
      name: 'babysitter',
      setup: () => void sessions.current.onTurnEnd(async () => void (verdict = await model.complete({ model: 'haiku', prompt: 'Is this reply a waste of time?', timeoutMs: 8000 }))),
    }),
    { permissions: ['model'] },
  )
  tested.fakes.model.complete = async () => ({ isAnswered: true, text: 'no' }) as never

  await tested.add({ type: Prompt, text: 'Rename it' })
  await tested.endTurn({ answer: 'Done.' })

  expect(verdict).toEqual({ isAnswered: true, text: 'no' })
  expect(tested.calls.find(({ call }) => call === 'model.complete')?.args[0]).toEqual({ model: 'haiku', prompt: 'Is this reply a waste of time?', timeoutMs: 8000 })
})

test('a before listener past its timeoutMs answers as if it were absent and shows the timeout', async () => {
  const tested = testMod(defineMod({ name: 'babysitter', setup: () => void sessions.current.beforeSessionStart(() => new Promise(() => undefined), { timeoutMs: 20 }) }), { permissions: ['prompt'] })

  expect(await tested.raise.beforeSessionStart({ source: 'startup' })).toBeUndefined()
  expect(tested.shown.toasts).toContainEqual({ type: 'error', message: 'The beforeSessionStart listener failed', description: 'beforeSessionStart passed its 0.02 s timeout' })
})

test('two beforeToolBatch notes both reach Claude, joined in the order the listeners were added', async () => {
  const tested = testMod(
    defineMod({
      name: 'reviewer',
      setup() {
        sessions.current.beforeToolBatch(() => ({ note: 'Check the tests.' }))
        sessions.current.beforeToolBatch(() => ({ note: 'Check the docs.' }))
      },
    }),
    { permissions: ['prompt'] },
  )

  expect(await tested.raise.beforeToolBatch({ calls: [] })).toEqual({ note: 'Check the tests.\n\nCheck the docs.' })
})

test("an answer a process before method does not take refuses beforePermissionRequest and a gate with onFailure: 'refuse'", async () => {
  const tested = testMod(
    defineMod({
      name: 'gate',
      setup() {
        sessions.current.beforePermissionRequest(() => ({ deny: 'Not here.' }) as never)
        sessions.current.beforeModelChange(() => ({ deny: 'Not here.' }) as never, { onFailure: 'refuse' })
      },
    }),
    { permissions: ['approve', 'prompt'] },
  )

  expect(await tested.raise.beforePermissionRequest({ name: 'Bash', input: { command: 'ls' }, suggestions: [] })).toEqual({ refuse: 'gate: it answered deny, which beforePermissionRequest does not take. It takes { allow }, { input }, { updates }, { refuse }, { interrupt }.' })
  expect(await tested.raise.beforeModelChange({ model: 'haiku' } as never)).toEqual({ refuse: 'gate: it answered deny, which beforeModelChange does not take. It takes { ask }, { refuse }.' })
})

test("a process before method's result never stops a later listener: a later refusal still refuses, and the last result wins", async () => {
  const runner = testMod(
    defineMod({
      name: 'runner',
      setup() {
        commands.beforeRun(() => ({ result: 'from A' }))
        commands.beforeRun(() => ({ refuse: 'B refuses' }))
      },
    }),
    { permissions: ['prompt'] },
  )
  const trees = testMod(
    defineMod({
      name: 'trees',
      setup() {
        sessions.current.beforeWorktreeCreate(() => ({ result: '/a' }))
        sessions.current.beforeWorktreeCreate(() => ({ result: '/b' }))
      },
    }),
  )

  expect(await runner.raise.beforeRun({ name: 'compact', args: '', from: { type: Person } })).toMatchObject({ refuse: 'B refuses' })
  expect(await trees.raise.beforeWorktreeCreate({ name: 'x' })).toEqual({ result: '/b' })
})

test('a before listener that answers something other than an object fails, and beforePermissionRequest refuses, while false is no answer', async () => {
  const tested = testMod(
    defineMod({
      name: 'gate',
      setup() {
        sessions.current.beforePermissionRequest(() => false as never)
        sessions.current.beforePermissionRequest(() => 'deny' as never)
        sessions.current.beforeToolBatch(() => 'note' as never)
      },
    }),
    { permissions: ['approve', 'prompt'] },
  )

  expect(await tested.raise.beforePermissionRequest({ name: 'Bash', input: { command: 'ls' }, suggestions: [] })).toMatchObject({ refuse: expect.stringContaining('it answered "deny"') })
  expect(await tested.raise.beforeToolBatch({ calls: [] })).toBeUndefined()
  await tested.settle()
  expect(tested.shown.toasts.filter(({ type }) => type === 'error').map(({ message }) => message)).toEqual(['The beforePermissionRequest listener failed', 'The beforeToolBatch listener failed'])
})

test('a session before listener answering false, as cond && { refuse } does, is no answer for a mod without the tools grant', async () => {
  const tested = testMod(
    defineMod({
      name: 'guard',
      setup() {
        sessions.current.beforeToolCall((call) => (call.name === 'Bash' && { refuse: 'No Bash here.' }) as never)
      },
    }),
    { permissions: [] },
  )
  await tested.start()

  expect(await claudeCodeOf(tested).fire('tool.call', { tool: 'Bash', tool_use_id: 'toolu_1', command: 'ls' } as never)).toEqual({ deny: 'No Bash here.' })
  expect(await claudeCodeOf(tested).fire('tool.call', { tool: 'Read', tool_use_id: 'toolu_2', file_path: 'a.ts' } as never)).toEqual({} as never)
  await tested.settle()
  expect(tested.shown.toasts.filter(({ type }) => type === 'error')).toEqual([])
})

test("onFailure: 'refuse' on a method that cannot refuse lets the moment through and shows the listener's own error", async () => {
  const tested = testMod(
    defineMod({
      name: 'policy',
      setup() {
        sessions.current.beforeSessionStart(() => {
          throw new Error('the policy file is missing')
        }, { onFailure: 'refuse' })
      },
    }),
    { permissions: ['prompt'] },
  )

  expect(await tested.raise.beforeSessionStart({ source: 'startup' } as never)).toBeUndefined()
  await tested.settle()
  expect(tested.shown.toasts.filter(({ type }) => type === 'error').map(({ description }) => description)).toEqual(['the policy file is missing'])
})

test('an on listener past its timeoutMs stops quietly', async () => {
  const tested = testMod(defineMod({ name: 'watcher', setup: () => void sessions.current.onSessionStart(() => new Promise(() => undefined), { timeoutMs: 20 }) }))

  await tested.raise.onSessionStart({ source: 'startup' })

  expect(tested.shown.toasts.filter((toast) => toast.type === 'error')).toEqual([])
})

test("a before listener with onFailure: 'refuse' refuses when it throws or passes its timeoutMs", async () => {
  const tested = testMod(
    defineMod({
      name: 'gate',
      setup() {
        sessions.current.beforeTodoCreate(() => new Promise(() => undefined), { timeoutMs: 20, onFailure: 'refuse' })
        sessions.current.beforeToolCall(
          () => {
            throw new Error('the policy file is missing')
          },
          { onFailure: 'refuse' },
        )
      },
    }),
    { permissions: ['tools', 'prompt'] },
  )

  expect(await tested.raise.beforeTodoCreate({ id: '1', subject: 'Ship it' })).toEqual({ refuse: 'gate: beforeTodoCreate passed its 0.02 s timeout' })
  expect(await tested.raise.beforeToolCall({ name: 'Bash', input: { command: 'ls' } })).toEqual({ refuse: 'gate: the policy file is missing' })
})

test('a listener gets its deadline and a signal that aborts when its timeoutMs passes', async () => {
  let aborted: Promise<number> | undefined
  const tested = testMod(
    defineMod({
      name: 'slow',
      setup: () =>
        void sessions.current.beforeSessionStart((_start, { deadline, signal }) => {
          aborted = new Promise((resolve) => signal.addEventListener('abort', () => resolve(deadline)))
          return new Promise(() => undefined)
        }, { timeoutMs: 20 }),
    }),
  )
  const raisedAt = Date.now()

  await tested.raise.beforeSessionStart({ source: 'startup' })

  expect((await aborted) ?? 0).toBeGreaterThanOrEqual(raisedAt + 20)
})

test('a timeoutMs past 600000 ms or below 1 throws where the listener registers', async () => {
  const late = testMod(defineMod({ name: 'late', setup: () => void sessions.current.onTurnEnd(() => undefined, { timeoutMs: 600_001 }) }))
  const never = testMod(defineMod({ name: 'never', setup: () => void sessions.current.onSessionStart(() => undefined, { timeoutMs: 0 }) }))

  await expect(late.start()).rejects.toThrow("late: onTurnEnd's timeoutMs is 600001. Give a whole number of milliseconds above 0 and at most 600000.")
  await expect(never.start()).rejects.toThrow("never: onSessionStart's timeoutMs is 0. Give a whole number of milliseconds above 0 and at most 600000.")
})

test('mod.toast with an id updates that toast in place', async () => {
  const tested = testMod(
    defineMod({
      name: 'notes',
      setup(mod) {
        mod.toast.loading('Saving notes', { id: 'save' })
        mod.toast.success('Saved 3 notes', { id: 'save', description: 'notes.md\nand 2 more' })
      },
    }),
  )

  await tested.start()

  expect(tested.shown.toasts).toEqual([
    { type: 'success', message: 'Saved 3 notes', description: 'notes.md\nand 2 more' },
    { type: 'success', message: 'Installed' },
  ])
})

test('an answer a before method does not take is shown with the method and what it takes', async () => {
  const tested = testMod(defineMod({ name: 'wrong-field', setup: () => void sessions.current.beforeToolBatch(() => ({ title: 'nope' }) as never) }), { permissions: ['prompt'] })

  expect(await tested.raise.beforeToolBatch({ calls: [] })).toBeUndefined()
  expect(tested.shown.toasts).toContainEqual({ type: 'error', message: 'The beforeToolBatch listener failed', description: 'it answered title, which beforeToolBatch does not take. It takes { note }.' })
})

test('a beforePermissionRequest listener that throws refuses the request', async () => {
  const ran: string[] = []
  const tested = testMod(
    defineMod({
      name: 'guard',
      setup() {
        sessions.current.beforePermissionRequest(() => {
          throw new Error('the policy file is missing')
        })
        sessions.current.beforePermissionRequest((request) => void ran.push(request.name))
      },
    }),
  )

  const answer = await claudeCodeOf(tested).fire('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm build' } }, { decision: { behavior: 'allow' } })

  expect(answer).toEqual({ decision: { behavior: 'deny', message: 'guard: the policy file is missing' } })
  expect(ran).toEqual([])
})

test('a beforePermissionRequest answer without allow or refuse leaves the dialog to the person, and a beforeModelChange answer without ask or refuse leaves the switch alone', async () => {
  const tested = testMod(
    defineMod({
      name: 'quiet',
      setup() {
        sessions.current.beforePermissionRequest(() => ({ input: { command: 'rm -rf /' } }) as never)
        sessions.current.beforeModelChange(() => ({}) as never)
      },
    }),
    { permissions: ['approve', 'tools'] },
  )
  const asking = { decision: { behavior: 'ask' } } as never

  expect(await claudeCodeOf(tested).fire('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm build' } }, asking)).toEqual(asking)
  expect(await claudeCodeOf(tested).fire('PreModelSwitch', { model: 'haiku', previous_model: 'opus', source: 'command' } as never, {})).toEqual({})
})

test('beforeElicitation refuses an MCP server question', async () => {
  const tested = testMod(defineMod({ name: 'quiet', setup: () => void sessions.current.beforeElicitation({ server: 'tracker' }, () => ({ refuse: 'Not during a deploy.' })) }))

  const answer = await claudeCodeOf(tested).fire('Elicitation', { mcp_server_name: 'tracker', message: 'Sign in?', mode: 'form' } as never, {})

  expect(answer).toMatchObject({ block: 'Not during a deploy.' })
})

test('two beforeToolBatch notes both reach Claude', async () => {
  const tested = testMod(
    defineMod({
      name: 'notes',
      setup() {
        sessions.current.beforeToolBatch(() => ({ note: 'first' }))
        sessions.current.beforeToolBatch(() => ({ note: 'second' }))
      },
    }),
    { permissions: ['prompt'] },
  )

  expect(await tested.raise.beforeToolBatch({ calls: [] })).toEqual({ note: 'first\n\nsecond' })
})

test('a before listener that throws is shown, and the listeners after it still answer', async () => {
  const tested = testMod(
    defineMod({
      name: 'briefing',
      setup() {
        sessions.current.beforeSessionStart(() => {
          throw new Error('the notes file is missing')
        })
        sessions.current.beforeSessionStart(() => ({ note: 'The build is red.' }))
      },
    }),
    { permissions: ['prompt'] },
  )

  const answer = await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' }, { additionalContext: ['from settings'] })

  expect(answer).toEqual({ additionalContext: ['from settings', '<briefing_mod>\nThe build is red.\n</briefing_mod>'] })
  expect(tested.shown.toasts).toContainEqual({ type: 'error', message: 'The beforeSessionStart listener failed', description: 'the notes file is missing' })
})

type CounterState = { session: { count: number } }

const counterPane: PaneInit<CounterState> = {
  id: 'counter',
  title: 'Counter',
  render: (mod) =>
    Box({
      flexDirection: 'column',
      children: [Text({ children: `Count: ${mod.state.session.count}` }), Button({ label: 'Add one', onPress: () => (mod.state.session.count += 1) })],
    }),
}

const counter = defineMod({
  name: 'counter',
  state: { session: { count: 0 } },
  setup(mod) {
    void mod.panes.add(counterPane).open()
  },
})

test('a Button press changes mod.state and the pane draws the new state', async () => {
  const tested = testMod(counter)
  expect(await tested.shown.pane.lines()).toEqual(['Count: 0', '[ Add one ]'])
  expect(tested.shown.openPanes).toEqual(new Set(['counter']))

  await tested.shown.pane.press('Add one')

  expect(tested.state.session.count).toBe(1)
  expect(await tested.shown.pane.lines()).toEqual(['Count: 1', '[ Add one ]'])
})

test('mod.toast.promise draws a loading toast above the prompt that turns to success when its task ends', async () => {
  let finish: (count: number) => void = () => undefined
  let unwrapped: Promise<number> | undefined
  const indexer = defineMod({
    name: 'indexer',
    setup(mod) {
      const task = new Promise<number>((resolve) => {
        finish = resolve
      })
      unwrapped = mod.toast.promise(task, { loading: 'Indexing files', success: (count) => `Indexed ${count} files`, error: 'Indexing failed' }).unwrap()
    },
  })
  const tested = testMod(indexer)
  const prompt = { type: 'Text', children: ['>'] } as unknown as RenderElement
  const abovePrompt = { surface: 'terminal' as const, component: 'AbovePrompt' as const, requestId: 'band', props: { hasSurvey: false }, viewport: { columns: 80, rows: 24 } }
  await tested.start()

  expect(textOf(await tested.fire('ui.render', abovePrompt as never, prompt))).toBe('>\n⠋  indexer  Indexing files  ✕\n✓  indexer  Installed  Settings  ✕')
  finish(12)
  await tested.settle()

  expect(await unwrapped).toBe(12)
  expect(tested.shown.toasts).toEqual([
    { type: 'success', message: 'Indexed 12 files' },
    { type: 'success', message: 'Installed' },
  ])
})

test('mod.toast.promise rejects only through unwrap, and shows the error toast', async () => {
  let unwrapped: Promise<unknown> | undefined
  const tested = testMod(
    defineMod({
      name: 'indexer',
      setup(mod) {
        mod.toast.promise(Promise.reject(new Error('disk full')), { loading: 'Indexing files', success: 'Indexed', error: (error) => `Indexing failed: ${messageOf(error)}` })
        unwrapped = mod.toast.promise(() => Promise.reject(new Error('disk full')), { loading: 'Indexing again', success: 'Indexed', error: 'Indexing failed again' }).unwrap()
      },
    }),
  )

  await tested.start()
  await tested.settle()

  await expect(unwrapped).rejects.toThrow('disk full')
  expect(tested.shown.toasts.map(({ type, message }) => `${type}: ${message}`)).toEqual(['error: Indexing failed: disk full', 'error: Indexing failed again', 'success: Installed'])
})

const toastBand = { surface: 'terminal' as const, component: 'AbovePrompt' as const, requestId: 'band', props: { hasSurvey: false }, viewport: { columns: 100, rows: 24 } }

const belowBand = { type: 'Text', children: ['>'] } as unknown as RenderElement

async function pressInBand(tested: TestedMod<object>, label: string): Promise<void> {
  const button = findElement(await tested.fire('ui.render', toastBand as never, belowBand), 'Button', label)
  if (button === undefined) throw new Error(`The band draws no button ${label}.`)
  await (button['onPress'] as () => unknown)()
  await tested.settle()
}

const failingStop = (manifest: string) =>
  testMod(defineMod({ name: 'keep-going', setup: () => void sessions.current.beforeSessionStart(() => Promise.reject(new Error('the test runner is missing'))) }), {
    files: { '/test/plugins/keep-going/.claude-plugin/plugin.json': manifest },
  })

test("a failure toast's Report choices copy the mod and core versions, message, description, and stack", async () => {
  const tested = failingStop('{ "name": "keep-going", "version": "1.4.0" }')
  await tested.raise.beforeSessionStart({ source: 'startup' })

  await pressInBand(tested, 'Report')
  await pressInBand(tested, 'Copy the error')

  const [copied] = tested.calls.filter(({ call }) => call === 'ui.copy').map(({ args }) => (args[0] as { text: string }).text)
  expect(copied).toStartWith(`keep-going 1.4.0, @cmodjs/core ${corePackage.version}\nThe beforeSessionStart listener failed\nthe test runner is missing\n\nError: the test runner is missing\n    at `)
  expect(textOf(await tested.fire('ui.render', toastBand as never, belowBand))).toContain('Copied the error.')
})

test("Report opens its choices in the toast with the keys on Ask Claude, which asks Claude to report it to the mod's GitHub issues", async () => {
  const tested = failingStop('{ "name": "keep-going", "version": "1.4.0", "repository": "https://github.com/acme/keep-going" }')
  await tested.raise.beforeSessionStart({ source: 'startup' })

  await pressInBand(tested, 'Report')
  const choices = textOf(await tested.fire('ui.render', toastBand as never, belowBand))
  const focused = tested.calls.filter(({ call }) => call === 'ui.focus').map(({ args }) => args[0])
  await pressInBand(tested, 'Ask Claude to report it')

  expect(choices).toContain('Report it on GitHub (opens your browser)')
  expect(focused).toEqual([{ requestId: 'band', key: 'toast:session:beforeSessionStart:ask-claude' }])
  const [asked] = tested.calls.filter(({ call }) => call === 'prompt.submit').map(({ args }) => args[0] as { text: string; asUser?: boolean })
  expect(asked?.asUser).toBe(true)
  expect(asked?.text).toStartWith('The keep-going mod failed. Report it to its author. Report it as an issue on https://github.com/acme/keep-going.')
  expect(asked?.text).toContain('The beforeSessionStart listener failed\nthe test runner is missing')
})

test("one mod's popup pane is its own, so another mod never draws in it", async () => {
  const shown = { surface: 'terminal', component: 'Pane', requestId: installerPaneOf('keep-going'), props: { title: 'Report keep-going', isFocused: true, bodyColumns: 80, placement: 'dock' } }
  const tested = testMod(defineMod({ name: 'probe', setup() {} }))
  await tested.start()

  expect(installerPaneOf('keep-going')).not.toBe(installerPaneOf('probe'))
  expect(textOf(await tested.fire('ui.render', shown as never, { type: 'Text', children: ['keep-going draws this'] } as never))).toBe('keep-going draws this')
})

test('Hide keeps a failure hidden when it happens again, and a different failure shows', async () => {
  let reason = 'the test runner is missing'
  const tested = testMod(defineMod({ name: 'keep-going', setup: () => void sessions.current.beforeSessionStart(() => Promise.reject(new Error(reason))) }))
  await tested.raise.beforeSessionStart({ source: 'startup' })

  await pressInBand(tested, 'Hide')
  await tested.raise.beforeSessionStart({ source: 'startup' })
  const afterHide = tested.shown.toasts.filter((toast) => toast.type === 'error')
  reason = 'the disk is full'
  await tested.raise.beforeSessionStart({ source: 'startup' })

  expect(afterHide).toEqual([])
  expect(tested.shown.toasts.filter((toast) => toast.type === 'error')).toEqual([{ type: 'error', message: 'The beforeSessionStart listener failed', description: 'the disk is full' }])
})

test('coreVersion, which a bundled mod reports in Copy, is the version in core/package.json', () => {
  expect(coreVersion).toBe(corePackage.version)
})

test('the same failure happening again keeps the Report choices open, and a different failure closes them', async () => {
  let reason = 'the test runner is missing'
  const tested = testMod(defineMod({ name: 'keep-going', setup: () => void sessions.current.beforeSessionStart(() => Promise.reject(new Error(reason))) }))
  await tested.raise.beforeSessionStart({ source: 'startup' })

  await pressInBand(tested, 'Report')
  await tested.raise.beforeSessionStart({ source: 'startup' })
  const again = textOf(await tested.fire('ui.render', toastBand as never, belowBand))
  reason = 'the disk is full'
  await tested.raise.beforeSessionStart({ source: 'startup' })

  expect(again).toContain('Ask Claude to report it')
  expect(textOf(await tested.fire('ui.render', toastBand as never, belowBand))).not.toContain('Ask Claude to report it')
})

test('a Copy Claude Code refuses names the reason under the Report choices', async () => {
  const tested = failingStop('{ "name": "keep-going", "version": "1.4.0" }')
  tested.fakes.ui.copy = async () => ({ isCopied: false, reason: 'no-clipboard' })
  await tested.raise.beforeSessionStart({ source: 'startup' })

  await pressInBand(tested, 'Report')
  await pressInBand(tested, 'Copy the error')

  expect(textOf(await tested.fire('ui.render', toastBand as never, belowBand))).toContain('Could not copy it: no-clipboard')
})

test("clipboard.write rejects with Claude Code's reason", async () => {
  const tested = testMod(defineMod({ name: 'notes', setup: () => undefined }))
  await tested.start()
  tested.fakes.ui.copy = async () => ({ isCopied: false, reason: 'no-surface' })

  await expect(clipboard.write('a note')).rejects.toThrow('no-surface')
})

test('a press on a toast message unfolds its whole description, and a second press folds it', async () => {
  const tested = testMod(defineMod({ name: 'notes', setup: (mod) => void mod.toast.info('Saved 3 notes', { description: 'notes.md\ntodo.md\nideas.md' }) }))
  await tested.start()
  expect(textOf(await tested.fire('ui.render', toastBand as never, belowBand))).not.toContain('ideas.md')

  await pressInBand(tested, 'Saved 3 notes')
  expect(textOf(await tested.fire('ui.render', toastBand as never, belowBand))).toContain('ideas.md')

  await pressInBand(tested, 'Saved 3 notes')
  expect(textOf(await tested.fire('ui.render', toastBand as never, belowBand))).not.toContain('ideas.md')
})

test('the band shows the newest three toasts, and +N more shows every toast', async () => {
  const tested = testMod(defineMod({ name: 'notes', setup: (mod) => ['a', 'b', 'c', 'd'].forEach((note) => mod.toast(`Note ${note}`)) }))
  await tested.start()
  const drawn = () => tested.fire('ui.render', toastBand as never, belowBand).then(textOf)

  expect(await drawn()).toBe('>\n+2 more\n   notes  Note c  ✕\n   notes  Note d  ✕\n✓  notes  Installed  Settings  ✕')

  await pressInBand(tested, '+2 more')

  expect((await drawn()).split('\n')).toHaveLength(6)
})

test('a toast expires after its duration once the band draws it, and waits while Claude Code shows a survey', async () => {
  const timers: { ms: number; fire: () => void }[] = []
  const tested = testMod(defineMod({ name: 'notes', setup: (mod) => void mod.toast('Saved', { duration: 2000 }) }))
  tested.fakes.clock.after = (ms, fire) => {
    timers.push({ ms, fire })
    return { cancel: () => undefined }
  }
  await tested.start()
  expect(timers.filter(({ ms }) => ms === 2000)).toEqual([])

  await tested.fire('ui.render', toastBand as never, belowBand)
  await tested.fire('ui.render', { ...toastBand, props: { hasSurvey: true } } as never, belowBand)
  timers.find(({ ms }) => ms === 2000)?.fire()

  expect(tested.shown.toasts).toContainEqual({ type: 'default', message: 'Saved' })
  await tested.fire('ui.render', toastBand as never, belowBand)
  timers.findLast(({ ms }) => ms === 2000)?.fire()
  expect(tested.shown.toasts).not.toContainEqual({ type: 'default', message: 'Saved' })
})

test('an action that throws shows a failure toast instead of losing the error', async () => {
  const tested = testMod(
    defineMod({
      name: 'notes',
      setup: (mod) =>
        void mod.toast('Saved', {
          action: {
            label: 'Undo',
            onClick: () => {
              throw new Error('the backup is gone')
            },
          },
        }),
    }),
  )
  await tested.start()

  await pressInBand(tested, 'Undo')

  expect(tested.shown.toasts).toContainEqual({ type: 'error', message: 'Saved: the press failed', description: 'the backup is gone' })
})

const noForcePush: Job<{ readonly denied: string[] }> = (job) => {
  const denied: string[] = []
  const { claude, router } = engineOf(job.mod)
  void claude.command.register({ name: 'pushes', description: 'List refused pushes' })
  job.announce('the /pushes command')
  router.add('tool.check', async (e, next) => {
    const command = (e.input as { command?: string }).command ?? ''
    if (e.tool !== 'Bash' || !command.includes('push --force')) return next(e)
    denied.push(command)
    return { decision: 'deny', reason: 'Force pushes are off in this repository.' }
  })
  return { denied }
}

test('a job added with mod.use answers tool.check, reaches Claude Code calls, and returns its handle', async () => {
  let handle: { readonly denied: string[] } | undefined
  const tested = testMod(
    defineMod({
      name: 'guard',
      setup(mod) {
        handle = mod.use(noForcePush)
      },
    }),
  )

  const denied = await claudeCodeOf(tested).fire('tool.check', { tool: 'Bash', input: { command: 'git push --force' } }, { decision: 'allow' })
  const allowed = await claudeCodeOf(tested).fire('tool.check', { tool: 'Bash', input: { command: 'git push' } }, { decision: 'allow' })

  expect(denied).toEqual({ decision: 'deny', reason: 'Force pushes are off in this repository.' })
  expect(allowed).toEqual({ decision: 'allow' })
  expect(handle?.denied).toEqual(['git push --force'])
  expect(tested.shown.commands).toEqual(['pushes'])
  expect(tested.shown.toasts).toEqual([{ type: 'success', message: 'Installed', description: 'Adds the /pushes command.' }])
})

test("the Installed toast names the rules a mod adds", async () => {
  const tested = testMod(defineMod({ name: 'house-style', setup() {} }), { files: { '/test/plugins/house-style/rules/tests.md': 'Write a test before each fix.\n', '/test/plugins/house-style/rules/sql.md': 'Quote every identifier.\n' } })

  await tested.start()

  expect(tested.shown.toasts.find(({ message }) => message === 'Installed')?.description).toContain('Adds 2 rules: sql and tests.')
})

test("the current session's project and cwd are set before setup runs", async () => {
  const seen: string[] = []
  const tested = testMod(
    defineMod({
      name: 'file-tree',
      setup() {
        seen.push(sessions.current.project, sessions.current.cwd)
      },
    }),
    { projectRoot: '/work/app', cwd: '/work/app/src' },
  )

  await tested.start()

  expect(seen).toEqual(['/work/app', '/work/app/src'])
})

const fileTree = defineMod({ name: 'file-tree', state: { project: { expanded: [] as string[] } }, setup() {} })


test('a project value saved in one project is not seen in another', async () => {
  const tested = testMod(fileTree, { projectRoot: '/work/a' })
  await tested.start()
  tested.state.project.expanded = ['src']

  await tested.moveTo('/work/b')

  expect([sessions.current.project, sessions.current.cwd]).toEqual(['/work/b', '/work/b'])
  expect(tested.state.project.expanded).toEqual([])

  await tested.moveTo('/work/a')

  expect(tested.state.project.expanded).toEqual(['src'])
})

test("a tool's mod reads the project the session moved to", async () => {
  const tested = testMod(
    defineMod({
      name: 'file-tree',
      setup(mod) {
        mod.use(tool({ name: 'where', description: 'Name the project folder', inputSchema: { type: 'object', properties: {} }, execute: () => `${sessions.current.project} ${sessions.current.cwd}` }))
      },
    }),
    { projectRoot: '/work/a' },
  )
  await tested.start()

  await tested.moveTo('/work/b')

  expect(await tested.callTool('where', {})).toEqual({ result: '/work/b /work/b' })
})

test('an onCwdChange listener that refreshes runs once after /cd, before the next prompt', async () => {
  const tested = testMod(
    defineMod({
      name: 'file-tree',
      setup() {
        sessions.current.onCwdChange(() => void process.run(['git', 'status', '--porcelain'], { cwd: sessions.current.project }))
      },
    }),
    { projectRoot: '/work/a', permissions: ['run:git'] },
  )
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  const refreshedFolders = () => tested.calls.filter((call) => call.call === 'process.run').map((call) => call.args[1])
  await tested.start()

  await tested.moveTo('/work/b')
  await tested.settle()

  expect(refreshedFolders()).toEqual([{ cwd: '/work/b' }])

  await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'hello' })

  expect(refreshedFolders()).toEqual([{ cwd: '/work/b' }])
})

test('a project value keeps only the 20 projects used most recently', async () => {
  const tested = testMod(fileTree, { projectRoot: '/work/0' })
  for (let project = 0; project <= 20; project += 1) {
    await tested.moveTo(`/work/${project}`)
    tested.state.project.expanded = [`src-${project}`]
  }

  await tested.moveTo('/work/0')

  expect(tested.state.project.expanded).toEqual([])

  await tested.moveTo('/work/1')

  expect(tested.state.project.expanded).toEqual(['src-1'])
})

const notes = defineMod({ name: 'notes', state: { session: { draft: '' } }, setup() {} })

test('a session value comes back on resume', async () => {
  const tested = testMod(notes)
  await tested.start()
  tested.state.session.draft = 'buy milk'
  await claudeCodeOf(tested).fire('SessionStart', { source: 'clear', session_id: 'second' })

  await claudeCodeOf(tested).fire('SessionStart', { source: 'resume', session_id: 'test-session' })

  expect(tested.state.session.draft).toBe('buy milk')
})

test('a session value resets to its default on /clear', async () => {
  const tested = testMod(notes)
  await tested.start()
  tested.state.session.draft = 'buy milk'

  await claudeCodeOf(tested).fire('SessionStart', { source: 'clear', session_id: 'second' })

  expect(tested.state.session.draft).toBe('')
})

test("a branched session starts with its parent's session values", async () => {
  const tested = testMod(notes)
  await tested.start()
  tested.state.session.draft = 'buy milk'

  await claudeCodeOf(tested).fire('SessionStart', { source: 'fork', session_id: 'branch' })

  expect(tested.state.session.draft).toBe('buy milk')
  tested.state.session.draft = 'call mum'
  await claudeCodeOf(tested).fire('SessionStart', { source: 'resume', session_id: 'test-session' })
  expect(tested.state.session.draft).toBe('buy milk')
  await claudeCodeOf(tested).fire('SessionStart', { source: 'resume', session_id: 'branch' })
  expect(tested.state.session.draft).toBe('call mum')
})

test('a session value comes back on resume however many sessions ran since', async () => {
  const tested = testMod(notes)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup', session_id: 'first' })
  tested.state.session.draft = 'buy milk'
  for (let session = 0; session < 25; session += 1) {
    await claudeCodeOf(tested).fire('SessionStart', { source: 'clear', session_id: `session-${session}` })
    tested.state.session.draft = `draft ${session}`
  }

  await claudeCodeOf(tested).fire('SessionStart', { source: 'resume', session_id: 'first' })

  expect(tested.state.session.draft).toBe('buy milk')
})

test('a session value is deleted once Claude Code deletes the session transcript', async () => {
  const tested = testMod(notes)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup', session_id: 'gone', transcript_path: '/test/transcripts/gone.jsonl' })
  tested.state.session.draft = 'buy milk'
  await claudeCodeOf(tested).fire('SessionStart', { source: 'clear', session_id: 'second' })

  await claudeCodeOf(tested).fire('SessionStart', { source: 'resume', session_id: 'gone', transcript_path: '/test/transcripts/gone.jsonl' })

  expect(tested.state.session.draft).toBe('')
})

const gitChanges = defineMod({ name: 'file-tree', state: { memory: { changed: [] as string[] }, session: { touched: [] as string[] } }, setup() {} })

test('a memory value resets on /clear', async () => {
  const tested = testMod(gitChanges)
  await tested.start()
  tested.state.memory.changed = ['README.md']

  await claudeCodeOf(tested).fire('SessionStart', { source: 'clear', session_id: 'second' })

  expect(tested.state.memory.changed).toEqual([])
})

test('a memory value starts from its default after a resume', async () => {
  const tested = testMod(gitChanges)
  await tested.start()
  tested.state.memory.changed = ['README.md']

  await claudeCodeOf(tested).fire('SessionStart', { source: 'resume', session_id: 'earlier' })

  expect(tested.state.memory.changed).toEqual([])
})

test('a branched conversation keeps its session values and starts a memory value from its default', async () => {
  const tested = testMod(gitChanges)
  await tested.start()
  tested.state.memory.changed = ['README.md']
  tested.state.session.touched = ['src/mod.ts']

  await claudeCodeOf(tested).fire('SessionStart', { source: 'fork', session_id: 'branch' })

  expect(tested.state).toEqual({ memory: { changed: [] }, session: { touched: ['src/mod.ts'] } })
})

test('a memory value stays through a compaction', async () => {
  const tested = testMod(gitChanges)
  await tested.start()
  tested.state.memory.changed = ['README.md']

  await claudeCodeOf(tested).fire('SessionStart', { source: 'compact', session_id: 'test-session' })

  expect(tested.state.memory.changed).toEqual(['README.md'])
})

const commits = defineMod({
  name: 'commits',
  state: { session: { greeting: 'hello' }, project: { policy: 'ask' }, global: { retries: 3 } },
  setup() {},
})

test('a project value the mod saved comes back in that project, and another project starts from the declared value', async () => {
  const tested = testMod(commits, { projectRoot: '/work/a' })
  await tested.start()
  tested.state.project.policy = 'always'

  await tested.moveTo('/work/b')

  expect(tested.state.project.policy).toBe('ask')

  await tested.moveTo('/work/a')

  expect(tested.state.project.policy).toBe('always')
})

test('pushing into a state array throws and names assignment', async () => {
  const tested = testMod(defineMod({ name: 'notes', state: { session: { notes: ['buy milk'] } }, setup() {} }))
  await tested.start()

  expect(() => tested.state.session.notes.push('call mum')).toThrow(
    'notes: mod.state.session.notes cannot change in place. Assign it a new value, such as mod.state.session.notes = [...mod.state.session.notes, item], so the mod redraws and keeps it.',
  )

  tested.state.session.notes = [...tested.state.session.notes, 'call mum']

  expect(tested.state.session.notes).toEqual(['buy milk', 'call mum'])
})

test('settings.user.read reads the user settings file alone', async () => {
  let enabled: unknown
  const tested = testMod(
    defineMod({
      name: 'cmod',
      async setup() {
        enabled = (await settings.user.read())['enabledPlugins']
      },
    }),
  )
  tested.fakes.settings.read = async (args) => (args?.source === 'user' ? { enabledPlugins: { 'demo@market': true } } : {})

  await tested.start()

  expect(enabled).toEqual({ 'demo@market': true })
})

test('fs.exists and fs.stat answer for files and folders', async () => {
  let answers: unknown
  const tested = testMod(
    defineMod({
      name: 'finder',
      async setup() {
        answers = {
          file: await fs.exists('/work/app/src/cart.ts'),
          folder: await fs.exists('/work/app/src'),
          missing: await fs.exists('/work/app/cart.ts'),
          isFolder: (await fs.stat('/work/app/src')).isFolder,
        }
      },
    }),
    { files: { '/work/app/src/cart.ts': 'x\n' } },
  )

  await tested.start()

  expect(answers).toEqual({ file: true, folder: true, missing: false, isFolder: true })
})

test('fs reads a path under $HOME or $CLAUDE_CONFIG_DIR like one under ~', async () => {
  let read: string[] = []
  const tested = testMod(
    defineMod({
      name: 'rules',
      async setup() {
        read = [await fs.read('$CLAUDE_CONFIG_DIR/CLAUDE.md'), await fs.read('$HOME/notes.md')]
      },
    }),
    { permissions: ['files:~/.claude', 'files:~/notes.md'], files: { '/test/home/.claude/CLAUDE.md': 'config\n', '/test/home/notes.md': 'notes\n' } },
  )

  await tested.start()

  expect(read).toEqual(['config\n', 'notes\n'])
})

test('commands.beforeRun refuses a built-in command, and commands.onRun hears each command that ran, as it ran, whatever order they were added in', async () => {
  const ran: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'keeper',
      setup(mod) {
        mod.use(slashCommand({ name: 'keep', description: 'Keep the context', reply: () => 'Kept.' }))
        commands.onRun((run) => void ran.push({ name: run.name, args: run.args, from: run.from }))
        commands.beforeRun({ name: 'compact' }, () => ({ refuse: 'Compact after the tests pass.' }))
        commands.beforeRun({ name: 'model' }, () => ({ args: 'opus' }))
        commands.beforeRun({ name: 'keep' }, () => ({ refuse: 'Not now.' }))
      },
    }),
    { permissions: ['prompt'] },
  )
  const typed = (command: string, args = '') => claudeCodeOf(tested).fire('command.run', { command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }, { text: `ran /${command}` })
  await tested.start()

  expect(await typed('compact')).toEqual({ text: 'Compact after the tests pass.' })
  expect(await typed('model', 'haiku')).toEqual({ text: 'ran /model' })
  expect(await typed('keep')).toEqual({ text: 'Not now.' })
  await tested.settle()

  expect(ran).toEqual([{ name: 'model', args: 'opus', from: { type: Person } }])
})

test("commands.beforeRun rewrites a command's args and adds a note beside its output", async () => {
  const tested = testMod(
    defineMod({
      name: 'reviewer',
      setup() {
        commands.beforeRun({ name: 'review' }, (run) => ({ args: `${run.args} --strict`, note: 'Review against DESIGN.md.' }))
      },
    }),
    { permissions: ['prompt'] },
  )
  await tested.start()

  const answer = await claudeCodeOf(tested).fire('command.run', { command: 'review', args: '12', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }, { text: 'Reviewing' })

  expect(answer).toEqual({ text: 'Reviewing', context: ['<reviewer_mod>\nReview against DESIGN.md.\n</reviewer_mod>'] })
  expect(await tested.raise.beforeRun({ name: 'review', args: '7', from: { type: Person } })).toEqual({ args: '7 --strict', note: 'Review against DESIGN.md.' })
})

test('commands.beforeRun refuses without a grant, and a change without the prompt permission changes nothing and names the permission', async () => {
  const tested = testMod(
    defineMod({
      name: 'keeper',
      setup() {
        commands.beforeRun({ name: 'compact' }, () => ({ refuse: 'No.' }))
        commands.beforeRun({ name: 'model' }, () => ({ args: 'haiku' }))
      },
    }),
    { permissions: [] },
  )
  const typed = (command: string) => claudeCodeOf(tested).fire('command.run', { command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }, { text: `ran /${command}` })
  await tested.start()

  expect(await typed('compact')).toEqual({ text: 'No.' })
  expect(await typed('model')).toEqual({ text: 'ran /model' })
  expect(tested.shown.toasts.find(({ message }) => message === 'The beforeRun listener failed')?.description).toContain('keeper: its answer changes a command, which needs the prompt permission.')
})

test('commands.list lists every command, and commands.run runs one and answers its output and note', async () => {
  let listed: unknown
  let output: unknown
  const tested = testMod(
    defineMod({
      name: 'runner',
      async setup() {
        listed = await commands.list()
        output = await commands.run('compact', 'keep the plan')
      },
    }),
    { permissions: ['prompt'] },
  )
  tested.fakes.command.list = async () => [{ name: 'compact', description: 'Compact the conversation', source: 'builtin' }]
  tested.fakes.command.run = async ({ command, args }) => ({ text: `ran /${command} ${args ?? ''}`, context: ['Compacted.'] })

  await tested.start()

  expect(listed).toEqual([{ name: 'compact', description: 'Compact the conversation', source: 'builtin' }])
  expect(output).toEqual({ text: 'ran /compact keep the plan', note: 'Compacted.' })
})

test('commands.run needs the prompt permission', async () => {
  let failure = ''
  const tested = testMod(defineMod({ name: 'runner', setup: () => void commands.run('compact').catch((error: unknown) => void (failure = messageOf(error))) }))
  await tested.start()
  await tested.settle()

  expect(failure).toContain('prompt')
})

test('config.list lists every /config row, naming the plugin that owns a row', async () => {
  let listed: unknown
  const tested = testMod(
    defineMod({
      name: 'panel',
      async setup() {
        listed = await config.list()
      },
    }),
  )
  tested.fakes.config.list = async () => [
    { key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', options: ['dark', 'light'], provider: { plugin: 'engine', tier: 'core' }, isLocked: false },
    { key: 'tracer.depth', label: 'Depth', description: 'How deep to trace', kind: 'number', value: 3, provider: { plugin: 'tracer', tier: 'user' }, isLocked: true },
  ] as never

  await tested.start()

  expect(listed).toEqual([
    { key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', options: ['dark', 'light'], isLocked: false },
    { key: 'tracer.depth', label: 'Depth', description: 'How deep to trace', kind: 'number', value: 3, isLocked: true, plugin: 'tracer' },
  ])
})

test('beforeReplyDisplay changes what the person sees of a reply', async () => {
  const tested = testMod(defineMod({ name: 'display', setup: () => void sessions.current.beforeReplyDisplay({ isLast: true }, () => ({ text: 'Shortened.' })) }))

  expect(await claudeCodeOf(tested).fire('MessageDisplay', { message_id: 'm1', index: 0, final: true, delta: 'A long reply.' } as never)).toEqual({ displayContent: 'Shortened.' } as never)
  expect(await claudeCodeOf(tested).fire('MessageDisplay', { message_id: 'm1', index: 0, final: false, delta: 'A long reply.' } as never)).toEqual({} as never)
})

const older: FakeSession = {
  id: 'older',
  title: 'Switch to build mode',
  lastAt: '2026-10-10T09:00:00.000Z',
  messages: [{ type: Prompt, text: 'Switch to build mode, then rename the pane', from: { type: 'mod', name: 'modes' } }],
}

test('sessions.current.messages reads this conversation, and each message names its turn', async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  const [prompt] = await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  await tested.add({ type: ToolCall, name: 'Read', input: { file_path: '/work/tree.ts' }, callId: 'toolu_1' })
  await tested.add({ type: ToolResult, callId: 'toolu_1', output: 'export function Tree() {}' })
  await tested.add({ type: Reply, text: 'Renamed it.' })
  await tested.endTurn()

  const messages = await sessions.current.messages()
  const [turn] = await sessions.current.turns()

  expect(messages.map((message) => message.type)).toEqual([Prompt, ToolCall, ToolResult, Reply])
  expect(messages.find((message) => message.type === ToolResult)).toMatchObject({ name: 'Read', input: { file_path: '/work/tree.ts' }, output: 'export function Tree() {}', isError: false })
  expect(messages.every((message) => message.turn === prompt?.id)).toBe(true)
  expect(turn?.prompt.text).toBe('Rename the tree pane')
  expect(turn?.closedAt).toBeDefined()
  expect((await sessions.current.messages({ last: 1 })).map((message) => message.type)).toEqual([Reply])
})

test('sessions.current.on hears each new message of its type, and remove stops it', async () => {
  const heard: string[] = []
  let listening: Subscription | undefined
  const tested = testMod(
    defineMod({
      name: 'history',
      setup() {
        listening = sessions.current.onReply((reply) => void heard.push(reply.text))
      },
    }),
    { permissions: ['conversation'] },
  )
  await tested.start()

  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  await tested.add({ type: Reply, text: 'Renamed it.' })
  listening?.remove()
  await tested.add({ type: Reply, text: 'Anything else?' })

  expect(heard).toEqual(['Renamed it.'])
})

test('a compact starts a new context, and a task keeps its own messages', async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const task = await tested.startTask({ title: 'Find the pane', agentType: 'explorer' })
  await tested.add({ type: Reply, text: 'Found it in tree.ts.' }, { task })
  await tested.compact()

  const contexts = await sessions.current.contexts()
  const [found] = await sessions.current.goal.tasks()

  expect(contexts.map((context) => context.number)).toEqual([1, 2])
  expect(found?.title).toBe('Find the pane')
  expect((await found!.messages()).map((message) => message.task)).toEqual([task])
  expect((await sessions.current.messages()).map((message) => message.type)).toEqual([Prompt])
})

test('sessions.search finds messages of the project newest first, and sessions.list lists its sessions', async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'], sessions: [older] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })

  const found = await Array.fromAsync(sessions.search('RENAME'))
  const [newest] = found

  expect(found.map((message) => message.session)).toEqual(['test-session', 'older'])
  expect((await Array.fromAsync(sessions.search('rename', undefined, { before: newest! }))).map((message) => message.session)).toEqual(['older'])
  expect((await Array.fromAsync(sessions.search('rename', { session: 'older' }))).map((message) => message.session)).toEqual(['older'])
  await expect(Array.fromAsync(sessions.search('pa'))).rejects.toThrow('cmod history search takes at least 3 characters.')
  expect((await sessions.list()).map((session) => session.id)).toEqual(['test-session', 'older'])
  expect((await sessions.list({ running: true })).map((session) => session.id)).toEqual(['test-session'])
})

test("a send to another running session reaches cmod, and a Prompt to the current one asks Claude for a turn", async () => {
  const tested = testMod(
    defineMod({
      name: 'modes',
      async setup() {
        const other = (await sessions.list()).find((session) => session.id === 'older')
        await other?.send({ type: Prompt, text: 'Switch to build mode.', as: Person })
        await sessions.current.send({ type: Prompt, text: 'Build mode is on.' })
      },
    }),
    { permissions: ['conversation', 'prompt'], sessions: [{ ...older, isRunning: true }] },
  )

  await tested.start()

  expect(tested.shown.sent).toEqual([{ session: 'older', type: Prompt, text: 'Switch to build mode.', as: Person }])
  expect(tested.shown.prompts).toEqual(['Build mode is on.'])
})

test('a send to an ended session is refused with its id', async () => {
  let failure = ''
  const tested = testMod(
    defineMod({
      name: 'modes',
      async setup() {
        const other = (await sessions.list()).find((session) => session.id === 'older')
        await other?.send({ type: Prompt, text: 'Switch to build mode.' }).catch((error: Error) => void (failure = error.message))
      },
    }),
    { permissions: ['conversation', 'prompt'], sessions: [older] },
  )

  await tested.start()

  expect(failure).toBe('session older has ended')
})

test('sessions refuses a mod without the conversation permission and names the fix', async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: [] })
  await tested.start()

  await expect(sessions.list()).rejects.toThrow('history calls sessions.list, which needs "permissions": { "conversation": true } in package.json "cmod".')
})

test('sessions.current.startTask starts a task and returns it', async () => {
  let started: Task | undefined
  const tested = testMod(
    defineMod({
      name: 'caller',
      setup() {
        sessions.current.onSessionStart(async () => {
          started = await sessions.current.startTask({ prompt: 'Read README.md.', agentType: 'explorer', title: 'Read the readme' })
        })
      },
    }),
    { permissions: ['tasks'] },
  )
  tested.fakes.agent.spawn = async () => ({ agentId: 'agent-7', model: 'test-model' })

  await tested.raise.onSessionStart({ source: 'startup' })

  expect([started?.id, started?.title, started?.owner.agentType, started?.owner.model]).toEqual(['agent-7', 'Read the readme', 'explorer', 'test-model'])
  expect(tested.calls.filter((call) => call.call === 'agent.spawn').map((call) => call.args)).toEqual([[{ prompt: 'Read README.md.', description: 'Read the readme', subagentType: 'explorer' }]])
})

test('pane.scrollTo asks Claude Code to bring a row of the pane into view', async () => {
  const tested = testMod(
    defineMod({
      name: 'log',
      async setup(mod) {
        const pane: Pane = mod.panes.add({ id: 'log', title: 'Log', render: () => Button({ label: 'Latest', onPress: () => pane.scrollTo('end') }) })
        await pane.open()
      },
    }),
  )

  await tested.shown.pane.press('Latest')

  expect(tested.calls.filter((call) => call.call === 'ui.scroll').map((call) => call.args)).toEqual([[{ to: 'end', in: 'log' }]])
})

test("a mod's call to its own name is answered by its own methods, since Claude Code shows a call only to the plugins above the caller", async () => {
  let found: unknown
  const tested = testMod(
    defineMod({
      name: 'tracer',
      setup(mod) {
        mod.after(1, () => void mod.dependencies.tracer.signatures({ path: 'src/a.ts' }).then((signatures) => (found = signatures)))
        return { signatures: (input: { readonly path: string }) => (input.path === 'src/a.ts' ? [{ name: 'count', line: 3 }] : []) }
      },
    }),
  )
  await tested.start()
  await tested.settle()

  expect(found).toEqual([{ name: 'count', line: 3 }])
  expect(tested.calls.filter((call) => call.call === 'cmod.call' && (call.args[0] as { readonly to: string }).to !== 'cmod')).toEqual([])
})

test('settings.beforeFileChange refuses an edit to the settings files it matches', async () => {
  const heard: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'locked',
      setup() {
        settings.beforeFileChange({ source: /^(user|project)$/ }, (change) => {
          heard.push(change)
          return { refuse: 'Settings are locked while the deploy runs.' }
        })
        settings.beforeFileChange(() => false as never)
      },
    }),
  )

  const project = await claudeCodeOf(tested).fire('ConfigChange', { source: 'project_settings', file_path: '/work/app/.claude/settings.json' })
  const skills = await claudeCodeOf(tested).fire('ConfigChange', { source: 'skills' })

  expect(project).toEqual({ block: 'Settings are locked while the deploy runs.' })
  expect(skills).toEqual({})
  expect(heard).toEqual([{ source: 'project', path: '/work/app/.claude/settings.json' }])
})

test('fs.onChange hears each file that changes, appears, or goes under a folder, from setup or later', async () => {
  const changes: unknown[] = []
  const ticks: (() => void)[] = []
  const tested = testMod(
    defineMod({
      name: 'reloader',
      setup(mod) {
        mod.after(1, () => void fs.onChange({ path: '/work/app/history' }, (change) => void changes.push(change)))
      },
    }),
    { files: { '/work/app/history/a.json': '{}', '/work/app/history/b.json': '{}', '/work/app/notes.md': '' } },
  )
  tested.fakes.clock.after = (_ms, run) => (run(), { cancel: () => undefined })
  tested.fakes.clock.every = (_ms, run) => (ticks.push(run), { cancel: () => undefined })
  await tested.start()
  await tested.settle()
  const tick = async () => {
    for (const run of ticks) run()
    await tested.settle()
  }

  await tested.fakes.fs.write?.('/work/app/history/a.json', '{ "count": 1 }')
  await tested.fakes.fs.write?.('/work/app/history/c.json', '{}')
  await tested.fakes.fs.write?.('/work/app/notes.md', 'changed')
  await tick()

  expect(changes).toEqual([
    { path: '/work/app/history/a.json', type: 'change' },
    { path: '/work/app/history/c.json', type: 'add' },
  ])
})

test('an fs.onChange listener that throws shows an error toast, and the next change still reaches it', async () => {
  const heard: string[] = []
  const ticks: (() => void)[] = []
  const tested = testMod(
    defineMod({
      name: 'reloader',
      setup: () =>
        void fs.onChange({ path: '/work/app/history' }, ({ path }) => {
          heard.push(path)
          if (path.endsWith('a.json')) throw new Error('bad history')
        }),
    }),
    { files: { '/work/app/history/a.json': '{}', '/work/app/history/b.json': '{}' } },
  )
  tested.fakes.clock.every = (_ms, run) => (ticks.push(run), { cancel: () => undefined })
  await tested.start()
  await tested.settle()

  await tested.fakes.fs.write?.('/work/app/history/a.json', '{ "count": 1 }')
  await tested.fakes.fs.write?.('/work/app/history/b.json', '{ "count": 1 }')
  for (const run of ticks) run()
  await tested.settle()

  expect(heard).toEqual(['/work/app/history/a.json', '/work/app/history/b.json'])
  expect(tested.shown.toasts).toContainEqual(expect.objectContaining({ type: 'error', message: 'The fs.onChange listener failed' }))
})

test('fs.onChange over more than 2000 files stops with an error toast that names its paths', async () => {
  const files = Object.fromEntries(Array.from({ length: 2001 }, (_, index) => [`/work/app/cache/${index}.json`, '{}']))
  const tested = testMod(defineMod({ name: 'reloader', setup: () => void fs.onChange({ path: '/work/app/cache' }, () => undefined) }), { files })
  const cancelled: number[] = []
  tested.fakes.clock.every = () => ({ cancel: () => void cancelled.push(1) })

  await tested.start()
  await tested.settle()

  expect(tested.shown.toasts).toContainEqual({ type: 'error', message: 'Could not read the files fs.onChange watches', description: 'fs.onChange watches at most 2000 files, and /work/app/cache holds more, so it stopped. Watch a smaller folder.' })
  expect(cancelled).toEqual([1])
})

test("a method's listener takes the payload its event carries, with the time it has", () => {
  expectTypeOf<Parameters<Parameters<typeof fs.onChange>[1]>[0]['type']>().toEqualTypeOf<'change' | 'add' | 'unlink'>()
  expectTypeOf<Parameters<Listener<CwdChange>>>().toEqualTypeOf<[CwdChange, ListenerTime]>()
})

test('a clock.after with no fake answer fires on a real timer', async () => {
  let fired: Promise<void> | undefined
  const tested = testMod(
    defineMod({
      name: 'timer',
      setup(mod) {
        fired = new Promise<void>((resolve) => engineOf(mod).claude.clock.after(1, resolve))
      },
    }),
  )

  await tested.start()
  await fired

  expect(tested.calls.filter((call) => call.call === 'clock.after').map((call) => call.args[0])).toEqual([1])
})

test('mod.dataFolder is the cmod store folder of the plugin, the one a step gets as CMOD_DATA', async () => {
  let folder: string | undefined
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        folder = mod.dataFolder
      },
    }),
  )

  await tested.start()

  expect(folder).toBe('/test/home/.local/share/cmod/data/diagrams')
})

const drawingPane: PaneInit = {
  id: 'drawing',
  title: 'Drawing',
  columns: 100,
  rows: 30,
  render: (_mod, props) => Text({ children: `${props.placement} ${props.bodyColumns} ${props.isFocused}` }),
}

function paneOpens(tested: { readonly calls: readonly TestCall[] }): unknown[] {
  return tested.calls.filter((call) => call.call === 'ui.open').map((call) => call.args[0])
}

test('a pane opens at its defined size, and render gets the Pane props', async () => {
  let handle: Pane | undefined
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        handle = mod.panes.add(drawingPane)
      },
    }),
  )
  await tested.start()

  await handle?.open()

  expect(paneOpens(tested)).toEqual([{ id: 'drawing', title: 'Drawing', columns: 100, rows: 30 }])
  expect(await tested.shown.pane.lines()).toEqual(['dock 100 false'])
})

test('a pane Claude Code holds back is not open, so the first toggle opens it instead of closing it', async () => {
  let handle: { readonly isOpen: boolean; toggle(): Promise<void> } | undefined
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        handle = mod.panes.add(drawingPane)
      },
    }),
  )
  await tested.start()
  tested.fakes.ui.open = async () => ({ isPlaced: false, reason: 'below 144 columns: 120 now' })

  await handle?.toggle()

  expect(handle?.isOpen).toBe(false)
  expect(tested.shown.openPanes).toEqual(new Set())

  tested.fakes.ui.open = async () => ({ isPlaced: true })
  await handle?.toggle()

  expect(handle?.isOpen).toBe(true)
  expect(tested.calls.filter((call) => call.call === 'ui.open' || call.call === 'ui.close').map((call) => call.call)).toEqual(['ui.open', 'ui.open'])
})

test('a pane says whether it is the one shown and whether it has the keyboard', async () => {
  let first: Pane | undefined
  let second: Pane | undefined
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        first = mod.panes.add(drawingPane)
        second = mod.panes.add({ ...drawingPane, id: 'legend', title: 'Legend' })
      },
    }),
  )
  await tested.start()

  await first?.open({ focus: true })

  expect([first?.isShown, first?.isFocused]).toEqual([true, true])

  await second?.open()

  expect([first?.isShown, second?.isShown, second?.isFocused]).toEqual([false, true, false])

  await second?.close()

  expect([first?.isShown, second?.isShown]).toEqual([true, false])
})

test('the first toggle of a pane setup opened and Claude Code holds back opens it', async () => {
  let handle: Pane | undefined
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      async setup(mod) {
        handle = mod.panes.add(drawingPane)
        await handle.open()
      },
    }),
  )
  tested.fakes.ui.open = async () => ({ isPlaced: false, reason: 'unasked below 144 columns (120 now)' })
  await tested.start()
  tested.fakes.ui.open = async () => ({ isPlaced: true })

  await handle?.toggle()

  expect(handle?.isOpen).toBe(true)
  expect(tested.calls.filter((call) => call.call === 'ui.open' || call.call === 'ui.close').map((call) => call.call)).toEqual(['ui.open', 'ui.open'])
})

test('a pane Claude Code shows later counts as open, so toggle closes it', async () => {
  let handle: Pane | undefined
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        handle = mod.panes.add(drawingPane)
      },
    }),
  )
  await tested.start()
  tested.fakes.ui.open = async () => ({ isPlaced: false, reason: 'below 144 columns: 120 now' })
  await handle?.toggle()
  const paneRender = { surface: 'terminal', component: 'Pane', requestId: 'drawing', props: { title: 'Drawing', isFocused: false, bodyColumns: 100, placement: 'dock' } } as const

  await tested.fire('ui.render', paneRender as never, { type: 'Box', props: {} } as unknown as RenderElement)

  expect(handle?.isOpen).toBe(true)

  await handle?.toggle()

  expect(handle?.isOpen).toBe(false)
  expect(tested.calls.filter((call) => call.call === 'ui.open' || call.call === 'ui.close').map((call) => call.call)).toEqual(['ui.open', 'ui.close'])
})

test('a pane size that is not a whole number above 0 throws in panes.add', async () => {
  const tested = testMod(defineMod({ name: 'sized', setup: (mod) => void mod.panes.add({ id: 'x', title: 'X', columns: 0, render: () => Text({}) }) }))

  await expect(tested.start()).rejects.toThrow('sized: the pane "x" has columns 0. Use a whole number above 0, or leave it out.')
})

type DiagramsState = { session: { shown: number } }

const diagramWidths = [60, 120, 120, undefined, 0.5]

const diagramsPane: PaneInit<DiagramsState> = {
  id: 'diagrams',
  title: 'Diagrams',
  columns: (state) => diagramWidths[state.session.shown],
  render: (mod) =>
    Box({ flexDirection: 'column', children: [Text({ children: `Diagram ${mod.state.session.shown + 1}` }), Button({ label: 'Next', onPress: () => (mod.state.session.shown += 1) })] }),
}

const diagrams = defineMod({
  name: 'diagrams',
  state: { session: { shown: 0 } },
  setup(mod) {
    const pane = mod.panes.add(diagramsPane)
    mod.use(slashCommand({ name: 'diagrams', description: 'Show or hide the diagrams', reply: () => pane.toggle() }))
  },
})

test('a pane sized from state opens at the size its state gives', async () => {
  const tested = testMod(diagrams, { state: { session: { shown: 1 } } })

  await tested.type('/diagrams')

  expect(paneOpens(tested)).toEqual([{ id: 'diagrams', title: 'Diagrams', columns: 120 }])
  expect(await tested.shown.pane.lines()).toEqual(['Diagram 2', '[ Next ]'])
})

test('an open pane resizes when the state changes its size', async () => {
  const tested = testMod(diagrams)
  await tested.type('/diagrams')

  await tested.shown.pane.press('Next')

  expect(paneOpens(tested)).toEqual([
    { id: 'diagrams', title: 'Diagrams', columns: 60 },
    { id: 'diagrams', title: 'Diagrams', columns: 120 },
  ])
})

test('a state change that keeps the size does not reopen the pane', async () => {
  const tested = testMod(diagrams, { state: { session: { shown: 1 } } })
  await tested.type('/diagrams')

  await tested.shown.pane.press('Next')

  expect(await tested.shown.pane.lines()).toEqual(['Diagram 3', '[ Next ]'])
  expect(paneOpens(tested)).toEqual([{ id: 'diagrams', title: 'Diagrams', columns: 120 }])
})

test('a closed pane does not open when its state changes', async () => {
  const tested = testMod(diagrams)
  await tested.type('/diagrams')
  await tested.type('/diagrams')

  tested.state.session.shown = 1
  await tested.settle()

  expect(paneOpens(tested)).toEqual([{ id: 'diagrams', title: 'Diagrams', columns: 60 }])
  expect(tested.shown.openPanes).toEqual(new Set())
})

test("a size of undefined from the state asks for Claude Code's default size", async () => {
  const tested = testMod(diagrams, { state: { session: { shown: 2 } } })
  await tested.type('/diagrams')

  await tested.shown.pane.press('Next')

  expect(paneOpens(tested)).toStrictEqual([
    { id: 'diagrams', title: 'Diagrams', columns: 120 },
    { id: 'diagrams', title: 'Diagrams' },
  ])
})

test('a size from the state that is not a whole number above 0 keeps the pane at its size and logs the pane', async () => {
  const tested = testMod(diagrams, { state: { session: { shown: 3 } } })
  await tested.type('/diagrams')

  await tested.shown.pane.press('Next')

  expect(paneOpens(tested)).toEqual([{ id: 'diagrams', title: 'Diagrams' }])
  expect(tested.shown.debug).toEqual(['diagrams: the Diagrams pane kept its size: the pane "diagrams" gets columns 0.5 from its state. Return a whole number above 0, or undefined for Claude Code\'s default.'])
})

type HistoryState = { project: { count: number; stepsBack: number } }

const historyPane: PaneInit<HistoryState> = {
  id: 'history',
  title: 'History',
  columns: (state) => diagramWidths[state.project.count - 1 - state.project.stepsBack],
  render: (mod) =>
    Button({
      label: 'Draw',
      onPress: () => {
        mod.state.project.count += 1
        mod.state.project.stepsBack = 0
      },
    }),
}

test('one action that sets two state keys resizes the pane once, to the final size', async () => {
  const tested = testMod(
    defineMod({
      name: 'history',
      state: { project: { count: 3, stepsBack: 2 } },
      setup(mod) {
        const pane = mod.panes.add(historyPane)
        mod.use(slashCommand({ name: 'history', description: 'Show or hide the history', reply: () => pane.toggle() }))
      },
    }),
  )
  await tested.type('/history')

  await tested.shown.pane.press('Draw')

  expect(paneOpens(tested)).toStrictEqual([
    { id: 'history', title: 'History', columns: 60 },
    { id: 'history', title: 'History' },
  ])
})

const tracer = defineMod({
  name: 'tracer',
  setup: () => ({
    signatures: async ({ path }: { path: string }) =>
      (await fs.read(path)).split('\n').flatMap((text, index) => {
        const name = /^export function (\w+)/.exec(text)?.[1]
        return name === undefined ? [] : [{ name, line: index + 1 }]
      }),
  }),
})

const outline = defineMod({
  name: 'outline',
  setup(mod) {
    mod.use(
      slashCommand({
        name: 'outline',
        description: 'List the functions a file exports',
        reply: async ({ args }, mod) => {
          const signatures: TracerSignature[] = await mod.dependencies.tracer.signatures({ path: args })
          return signatures.map(({ name, line }) => `${name}:${line}`).join(' ')
        },
      }),
    )
  },
})

function relayTo(provider: Pick<TestedMod<object>, 'fire'>): Claude['cmod']['call'] {
  return async (call) => calledAnswer('outline', await claudeCodeOf(provider).fire('cmod.call', call, { deny: `${call.to} is not installed. Install it in Plugins.` }))
}

test("a mod calls another mod's api and gets its result", async () => {
  const provider = testMod(tracer)
  provider.fakes.fs.read = async () => 'export function parse(text: string) {}\nconst cache = new Map()\nexport function render() {}\n'
  const consumer = testMod(outline)
  consumer.fakes.cmod.call = relayTo(provider)

  expect(await consumer.type('/outline src/a.ts')).toEqual({ text: 'parse:1 render:3' })
  expect(provider.calls).toContainEqual({ call: 'fs.read', args: ['src/a.ts'] })
})

test('a call to a mod that is not installed fails with the install command', async () => {
  const consumer = testMod(outline)
  consumer.fakes.cmod.call = relayTo(testMod(defineMod({ name: 'file-tree', setup() {} })))

  expect(await consumer.type('/outline src/a.ts')).toEqual({ text: '/outline failed: tracer is not installed. Install it in Plugins.' })
})

test("a listener whose call is refused shows the refusal once, without Claude Code's prefix", async () => {
  const consumer = testMod(defineMod({ name: 'outline', setup: (mod) => void sessions.current.onSessionStart(async () => void (await mod.dependencies.tracer.signatures({ path: 'src/a.ts' }))) }))

  await consumer.raise.onSessionStart({ source: 'startup' })

  expect(consumer.shown.toasts).toContainEqual({ type: 'error', message: 'The onSessionStart listener failed', description: 'tracer is not installed. Install it in Plugins.' })
})

test('an unknown method fails naming it', async () => {
  const provider = testMod(tracer)
  const below = { deny: 'tracer is not installed. Install it in Plugins.' }

  expect(await claudeCodeOf(provider).fire('cmod.call', { to: 'tracer', method: 'callers', input: { name: 'parse' } }, below)).toEqual({ deny: 'tracer has no method callers.' })
  expect(await claudeCodeOf(provider).fire('cmod.call', { to: 'tracer', method: 'constructor', input: {} }, below)).toEqual({ deny: 'tracer has no method constructor.' })
})

test("a provider method that throws reaches the caller with the provider's name", async () => {
  const provider = testMod(tracer)
  provider.fakes.fs.read = async (path) => {
    throw new Error(`ENOENT: no such file ${path}`)
  }
  const consumer = testMod(outline)
  consumer.fakes.cmod.call = relayTo(provider)

  expect(await consumer.type('/outline src/gone.ts')).toEqual({ text: '/outline failed: tracer: ENOENT: no such file src/gone.ts' })
})

test('a mod passes on a call addressed to another mod', async () => {
  const provider = testMod(tracer)
  const below = { value: [{ name: 'main', line: 1 }] }

  expect(await claudeCodeOf(provider).fire('cmod.call', { to: 'symbols', method: 'signatures', input: { path: 'src/a.ts' } }, below)).toBe(below)
})

test('a dependency call that never answers fails the slash command at its deadline', async () => {
  const deadlines: number[] = []
  const tested = testMod(
    defineMod({
      name: 'outline',
      setup(mod) {
        mod.use(slashCommand({ name: 'outline', description: 'List the functions a file exports', reply: async ({ args }, mod) => (await mod.dependencies.tracer.signatures({ path: args })).length.toString() }))
        sessions.current.onSessionStart(async () => void (await mod.dependencies.tracer.signatures({ path: 'src/a.ts' })), { timeoutMs: 60_000 })
      },
    }),
  )
  tested.fakes.cmod.call = () => new Promise(() => undefined)
  tested.fakes.clock.after = (ms, fn) => {
    deadlines.push(ms)
    fn()
    return { cancel: () => undefined }
  }

  expect(await tested.type('/outline src/a.ts')).toEqual({ text: '/outline failed: /outline passed the 30 s deadline of slashCommand' })
  await tested.raise.onSessionStart({ source: 'startup' })
  expect(tested.shown.toasts).toContainEqual({ type: 'error', message: 'The onSessionStart listener failed', description: 'mod.dependencies.tracer.signatures passed its 30 s deadline' })
  expect(deadlines).toEqual([30000, 30000, 30000])
})

test("a dependency's method takes the input and returns the result its contract declares", () => {
  type Signatures = Mod['dependencies']['tracer']['signatures']

  expectTypeOf<Parameters<Signatures>>().toEqualTypeOf<[input: { path: string }]>()
  expectTypeOf<Awaited<ReturnType<Signatures>>>().toEqualTypeOf<TracerSignature[]>()
})

test('a provider whose api method returns the wrong type fails tsc', () => {
  const wrong = defineMod({
    name: 'tracer',
    // @ts-expect-error
    setup: () => ({ signatures: async ({ path }: { path: string }) => `${path}:1` }),
  })

  expect(wrong.name).toBe('tracer')
})

test('a setup that returns something other than methods does not start', async () => {
  const tested = testMod(defineMod({ name: 'notes', setup: () => ({ count: 3 }) as never }))

  await expect(tested.start()).rejects.toThrow('notes: setup returns its API, an object of methods other mods call, or nothing. It returned an object with values that are not methods.')
})

test('tested.api calls the methods setup returns, as another mod would', async () => {
  const tested = testMod(tracer)
  tested.fakes.fs.read = async () => 'export function parse(text: string) {}\n'

  expect(await tested.api['signatures']?.({ path: 'src/a.ts' })).toEqual([{ name: 'parse', line: 1 }])
  expect(await Promise.resolve(tested.api)).toBe(tested.api)
})

test('a slash command opens a Sidebar page with its params, and the page knows it shows', async () => {
  let page: Page<{ readonly run: number }> | undefined
  const tested = testMod(
    defineMod({
      name: 'ci-watch',
      setup(mod) {
        page = mod.sidebar.add<{ readonly run: number }>({ id: 'run', title: 'Run', render: (_mod, { params }) => Text({ children: `run ${params.run}` }) })
        mod.use(slashCommand({ name: 'run', description: 'Show a run', reply: ({ args }) => page?.open({ params: { run: Number(args) }, focus: true }) }))
      },
    }),
  )

  await tested.type('/run 42')

  expect(tested.shown.page.id).toBe('run')
  expect(await tested.shown.page.lines()).toEqual(['run 42'])
  expect([page?.isOpen, page?.isShown, page?.isFocused, page?.params]).toEqual([true, true, true, { run: 42 }])
  await page?.close()
  expect([page?.isOpen, page?.isShown]).toEqual([false, false])
})

test('a page a slash command opens reaches the cmod plugin as the person asking, so the Sidebar opens at any width', async () => {
  const sent: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'ci-watch',
      setup(mod) {
        const page = mod.sidebar.add({ id: 'runs', title: 'Runs', render: () => Text({ children: 'last run passed' }) })
        mod.use(slashCommand({ name: 'runs', description: 'Show the runs', reply: () => page.open() }))
        mod.every(1000, () => page.open())
      },
    }),
  )
  await tested.start()
  tested.fakes.cmod.call = async (input) => (sent.push(input.input), { isHeld: true })

  await tested.type('/runs')

  expect(sent).toEqual([{ requests: [{ open: 'runs' }], isAsked: true }])
})

test("settings.open shows the mod's first Settings page, and a press there runs in the mod", async () => {
  let settings: Mod['settings'] | undefined
  const tested = testMod(
    defineMod({
      name: 'ci-watch',
      state: { global: { branch: 'main' } },
      setup(mod) {
        settings = mod.settings
        mod.settings.add({ id: 'branches', title: 'Branches', render: (current) => Button({ label: `Watch ${current.state.global.branch === 'main' ? 'dev' : 'main'}`, onPress: () => void (current.state.global.branch = 'dev') }) })
      },
    }),
  )
  await tested.start()

  await settings?.open()

  expect(tested.shown.page.id).toBe('branches')
  await tested.shown.page.press('Watch dev')
  expect(tested.state.global.branch).toBe('dev')
  expect(await tested.shown.page.lines()).toEqual(['[ Watch main ]'])
})

test("a mod's hotkey runs its listeners, and a listener removed no longer runs", async () => {
  const pressed: string[] = []
  const tested = testMod(
    defineMod({
      name: 'tree',
      hotkeys: { toggle: { title: 'Show or hide the tree', default: 'ctrl+t' } },
      setup(mod) {
        const first = mod.hotkeys.toggle.onPress(() => void pressed.push('first'))
        mod.hotkeys.toggle.onPress(() => {
          pressed.push('second')
          first.remove()
        })
      },
    }),
  )

  await tested.hotkey('toggle')
  await tested.hotkey('toggle')

  expect(pressed).toEqual(['first', 'second', 'second'])
  expect(tested.shown.commands).toContain('tree--toggle')
})

test("a hotkey's combo is the one keybindings.json binds to it, which a person may have changed, and undefined while none does", async () => {
  let combos: unknown[] = []
  const keybindings = { bindings: [{ context: 'Chat', bindings: { 'ctrl+e': 'command:tree--toggle', 'ctrl+k': 'command:other--toggle' } }] }
  const tested = testMod(
    defineMod({
      name: 'tree',
      hotkeys: { toggle: { title: 'Show or hide the tree', default: 'ctrl+t' }, reveal: { title: 'Reveal the file', default: 'ctrl+r' } },
      setup: (mod) => void (combos = [mod.hotkeys.toggle.combo, mod.hotkeys.reveal.combo]),
    }),
    { files: { '/test/home/.claude/keybindings.json': JSON.stringify(keybindings) } },
  )

  await tested.start()

  expect(combos).toEqual(['ctrl+e', undefined])
})

test('a hotkey default that is not a combo throws in defineMod', () => {
  expect(() => defineMod({ name: 'tree', hotkeys: { toggle: { title: 'Toggle', default: 't' as never } }, setup: () => undefined })).toThrow('tree: hotkeys.toggle defaults to "t", which is not a combo. Give one or two of ctrl, alt, shift, meta in that order, then a key, such as "ctrl+q" or "ctrl+shift+k".')
  expect(() => defineMod({ name: 'tree', hotkeys: { a: { title: 'A', default: 'ctrl+t' }, b: { title: 'B', default: 'ctrl+t' } }, setup: () => undefined })).toThrow('tree: hotkeys.b defaults to ctrl+t, which hotkeys.a has too. Give each hotkey its own combo.')
})

test('a removed timer stops, and says it stopped', async () => {
  let timer: Timer | undefined
  let fired = 0
  const tested = testMod(defineMod({ name: 'tick', setup: (mod) => void (timer = mod.every(1000, () => void (fired += 1))) }))
  await tested.start()

  expect(timer?.isRunning).toBe(true)
  timer?.stop()

  expect(timer?.isRunning).toBe(false)
  expect(fired).toBe(0)
})
