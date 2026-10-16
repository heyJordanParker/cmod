import { expect, expectTypeOf, test } from 'bun:test'
import type { RenderElement } from 'claude-code'
import { slashCommand } from '../src/jobs/slash-command.js'
import { tool } from '../src/jobs/tool.js'
import corePackage from '../package.json' with { type: 'json' }
import { commands, config, defineMod, fs, messageOf, model, Note, Person, process, Prompt, Reply, sessions, settings, ToolCall, ToolResult, type CwdChange, type Disposable, type Job, type Listener, type ListenerTime, type Mod, type PaneHandle, type Task } from '../src/mod.js'
import { coreVersion } from '../src/records.js'
import type { Claude } from '../src/runtime/claude.js'
import { createLifecycle } from '../src/runtime/lifecycle.js'
import { installerPaneOf } from '../src/runtime/installer.js'
import { engineOf } from '../src/runtime/engine.js'
import { testMod, type FakeSession, type TestedMod } from '../src/testing.js'
import { claudeCodeOf } from '../src/testing/claude-code.js'
import { calledAnswer, fakeClaude, type TestCall } from '../src/testing/fake-claude.js'
import { findElement, textOf } from '../src/testing/fake-elements.js'
import { definePane } from '../src/ui/define-pane.js'
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

  expect(answer).toEqual({ additionalContext: ['touch-tracker saw Read'] })
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
  expect(tested.calls.find(({ call }) => call === 'session.append')?.args).toEqual([{ message: { type: 'user', content: [{ type: 'text', text: 'CI failed on main.' }] } }])
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

test('mod.ui.toast with an id updates that toast in place', async () => {
  const tested = testMod(
    defineMod({
      name: 'notes',
      setup(mod) {
        mod.ui.toast.loading('Saving notes', { id: 'save' })
        mod.ui.toast.success('Saved 3 notes', { id: 'save', description: 'notes.md\nand 2 more' })
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

  expect(answer).toEqual({ additionalContext: ['from settings', 'The build is red.'] })
  expect(tested.shown.toasts).toContainEqual({ type: 'error', message: 'The beforeSessionStart listener failed', description: 'the notes file is missing' })
})

type CounterState = { session: { count: number } }

const counterPane = definePane<CounterState>({
  id: 'counter',
  title: 'Counter',
  render: (mod) =>
    Box({
      flexDirection: 'column',
      children: [Text({ children: `Count: ${mod.state.session.count}` }), Button({ label: 'Add one', onPress: () => (mod.state.session.count += 1) })],
    }),
})

const counter = defineMod({
  name: 'counter',
  state: { session: { count: 0 } },
  setup(mod) {
    void mod.ui.pane(counterPane).open()
  },
})

test('a Button press changes mod.state and the pane draws the new state', async () => {
  const tested = testMod(counter)
  expect(await tested.lines('counter')).toEqual(['Count: 0', '[ Add one ]'])
  expect(tested.shown.openPanes).toEqual(new Set(['counter']))

  await tested.press('counter', 'Add one')

  expect(tested.state.session.count).toBe(1)
  expect(await tested.lines('counter')).toEqual(['Count: 1', '[ Add one ]'])
})

test('mod.ui.toast.promise draws a loading toast above the prompt that turns to success when its task ends', async () => {
  let finish: (count: number) => void = () => undefined
  let unwrapped: Promise<number> | undefined
  const indexer = defineMod({
    name: 'indexer',
    setup(mod) {
      const task = new Promise<number>((resolve) => {
        finish = resolve
      })
      unwrapped = mod.ui.toast.promise(task, { loading: 'Indexing files', success: (count) => `Indexed ${count} files`, error: 'Indexing failed' }).unwrap()
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

test('mod.ui.toast.promise rejects only through unwrap, and shows the error toast', async () => {
  let unwrapped: Promise<unknown> | undefined
  const tested = testMod(
    defineMod({
      name: 'indexer',
      setup(mod) {
        mod.ui.toast.promise(Promise.reject(new Error('disk full')), { loading: 'Indexing files', success: 'Indexed', error: (error) => `Indexing failed: ${messageOf(error)}` })
        unwrapped = mod.ui.toast.promise(() => Promise.reject(new Error('disk full')), { loading: 'Indexing again', success: 'Indexed', error: 'Indexing failed again' }).unwrap()
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

test("mod.ui.copy rejects with Claude Code's reason", async () => {
  let copy: Mod['ui']['copy'] | undefined
  const tested = testMod(defineMod({ name: 'notes', setup: (mod) => void (copy = mod.ui.copy) }))
  await tested.start()
  tested.fakes.ui.copy = async () => ({ isCopied: false, reason: 'no-surface' })

  await expect(copy?.('a note')).rejects.toThrow('no-surface')
})

test('a press on a toast message unfolds its whole description, and a second press folds it', async () => {
  const tested = testMod(defineMod({ name: 'notes', setup: (mod) => void mod.ui.toast.info('Saved 3 notes', { description: 'notes.md\ntodo.md\nideas.md' }) }))
  await tested.start()
  expect(textOf(await tested.fire('ui.render', toastBand as never, belowBand))).not.toContain('ideas.md')

  await pressInBand(tested, 'Saved 3 notes')
  expect(textOf(await tested.fire('ui.render', toastBand as never, belowBand))).toContain('ideas.md')

  await pressInBand(tested, 'Saved 3 notes')
  expect(textOf(await tested.fire('ui.render', toastBand as never, belowBand))).not.toContain('ideas.md')
})

test('the band shows the newest three toasts, and +N more shows every toast', async () => {
  const tested = testMod(defineMod({ name: 'notes', setup: (mod) => ['a', 'b', 'c', 'd'].forEach((note) => mod.ui.toast(`Note ${note}`)) }))
  await tested.start()
  const drawn = () => tested.fire('ui.render', toastBand as never, belowBand).then(textOf)

  expect(await drawn()).toBe('>\n+2 more\n   notes  Note c  ✕\n   notes  Note d  ✕\n✓  notes  Installed  Settings  ✕')

  await pressInBand(tested, '+2 more')

  expect((await drawn()).split('\n')).toHaveLength(6)
})

test('a toast expires after its duration once the band draws it, and waits while Claude Code shows a survey', async () => {
  const timers: { ms: number; fire: () => void }[] = []
  const tested = testMod(defineMod({ name: 'notes', setup: (mod) => void mod.ui.toast('Saved', { duration: 2000 }) }))
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
        void mod.ui.toast('Saved', {
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

test('commands.beforeRun refuses a built-in command, and commands.onRun hears each command that ran', async () => {
  const ran: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'keeper',
      setup() {
        commands.beforeRun({ name: 'compact' }, () => ({ refuse: 'Compact after the tests pass.' }))
        commands.onRun((run) => void ran.push({ name: run.name, args: run.args, from: run.from }))
      },
    }),
    { permissions: ['prompt'] },
  )
  const typed = (command: string, args = '') => claudeCodeOf(tested).fire('command.run', { command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }, { text: `ran /${command}` })
  await tested.start()

  expect(await typed('compact')).toEqual({ text: 'Compact after the tests pass.' })
  expect(await typed('model', 'haiku')).toEqual({ text: 'ran /model' })
  await tested.settle()

  expect(ran).toEqual([{ name: 'model', args: 'haiku', from: { type: Person } }])
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

  expect(answer).toEqual({ text: 'Reviewing', context: ['Review against DESIGN.md.'] })
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

test('sessions.current.on hears each new message of its type, and dispose stops it', async () => {
  const heard: string[] = []
  let listening: Disposable | undefined
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
  listening?.dispose()
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

test('mod.ui.scroll asks Claude Code to bring a row of a pane into view', async () => {
  const tested = testMod(
    defineMod({
      name: 'log',
      async setup(mod) {
        await mod.ui.pane(definePane({ id: 'log', title: 'Log', render: (paneMod) => Button({ label: 'Latest', onPress: () => paneMod.ui.scroll({ to: 'end', in: 'log' }) }) })).open()
      },
    }),
  )

  await tested.press('log', 'Latest')

  expect(tested.calls.filter((call) => call.call === 'ui.scroll').map((call) => call.args)).toEqual([[{ to: 'end', in: 'log' }]])
})

test("a mod's call to its own name is answered by its own methods, since Claude Code shows a call only to the plugins above the caller", async () => {
  let found: unknown
  const tested = testMod(
    defineMod({
      name: 'tracer',
      api: { signatures: (input: { readonly path: string }) => (input.path === 'src/a.ts' ? [{ name: 'count', line: 3 }] : []) },
      setup(mod) {
        mod.after(1, () => void mod.dependencies.tracer.signatures({ path: 'src/a.ts' }).then((signatures) => (found = signatures)))
      },
    }),
  )
  await tested.start()
  await tested.settle()

  expect(found).toEqual([{ name: 'count', line: 3 }])
  expect(tested.calls.filter((call) => call.call === 'cmod.call')).toEqual([])
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
      },
    }),
  )

  const project = await claudeCodeOf(tested).fire('ConfigChange', { source: 'project_settings', file_path: '/work/app/.claude/settings.json' })
  const skills = await claudeCodeOf(tested).fire('ConfigChange', { source: 'skills' })

  expect(project).toEqual({ block: 'Settings are locked while the deploy runs.' })
  expect(skills).toEqual({})
  expect(heard).toEqual([{ source: 'project', path: '/work/app/.claude/settings.json' }])
})

test('fs.onChange watches a folder from session start and hears each file that changes under it', async () => {
  const changes: unknown[] = []
  let late: unknown
  const tested = testMod(
    defineMod({
      name: 'reloader',
      setup() {
        fs.onChange({ path: '/work/app/history' }, (change) => {
          changes.push(change)
          try {
            fs.onChange({ path: '/work/app/other' }, () => {})
          } catch (error) {
            late = (error as Error).message
          }
        })
      },
    }),
  )

  const started = await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' } as never)
  await claudeCodeOf(tested).fire('FileChanged', { file_path: '/work/app/history/a.json', event: 'change' })
  await claudeCodeOf(tested).fire('FileChanged', { file_path: '/work/app/notes.md', event: 'add' })
  await tested.settle()

  expect(started).toEqual({ watchPaths: ['/work/app/history'] })
  expect(changes).toEqual([{ path: '/work/app/history/a.json', type: 'change' }])
  expect(late).toBe('reloader: fs.onChange works only in setup, because Claude Code reads the paths it watches when a session starts.')
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

const drawingPane = definePane({
  id: 'drawing',
  title: 'Drawing',
  columns: 100,
  rows: 30,
  render: (_mod, props) => Text({ children: `${props.placement} ${props.bodyColumns} ${props.isFocused}` }),
})

function paneOpens(tested: { readonly calls: readonly TestCall[] }): unknown[] {
  return tested.calls.filter((call) => call.call === 'ui.open').map((call) => call.args[0])
}

test('a pane opens at its defined size, and render gets the Pane props', async () => {
  let handle: PaneHandle | undefined
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        handle = mod.ui.pane(drawingPane)
      },
    }),
  )
  await tested.start()

  await handle?.open()

  expect(paneOpens(tested)).toEqual([{ id: 'drawing', title: 'Drawing', columns: 100, rows: 30 }])
  expect(await tested.lines('drawing')).toEqual(['dock 100 false'])
})

test('a pane Claude Code holds back is not open, so the first toggle opens it instead of closing it', async () => {
  let handle: { readonly isOpen: boolean; toggle(): Promise<void> } | undefined
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        handle = mod.ui.pane(drawingPane)
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

test('a pane handle says whether its pane is the one shown and whether it has the keyboard', async () => {
  let first: PaneHandle | undefined
  let second: PaneHandle | undefined
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        first = mod.ui.pane(drawingPane)
        second = mod.ui.pane({ ...drawingPane, id: 'legend', title: 'Legend' })
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
  let handle: PaneHandle | undefined
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      async setup(mod) {
        handle = mod.ui.pane(drawingPane)
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
  let handle: PaneHandle | undefined
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        handle = mod.ui.pane(drawingPane)
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

test('a pane size that is not a whole number above 0 throws in definePane', () => {
  expect(() => definePane({ id: 'x', title: 'X', columns: 0, render: () => Text({}) })).toThrow('definePane: the pane "x" has columns 0. Use a whole number above 0, or leave it out.')
})

type DiagramsState = { session: { shown: number } }

const diagramWidths = [60, 120, 120, undefined, 0.5]

const diagramsPane = definePane<DiagramsState>({
  id: 'diagrams',
  title: 'Diagrams',
  columns: (state) => diagramWidths[state.session.shown],
  render: (mod) =>
    Box({ flexDirection: 'column', children: [Text({ children: `Diagram ${mod.state.session.shown + 1}` }), Button({ label: 'Next', onPress: () => (mod.state.session.shown += 1) })] }),
})

const diagrams = defineMod({
  name: 'diagrams',
  state: { session: { shown: 0 } },
  setup(mod) {
    const pane = mod.ui.pane(diagramsPane)
    mod.use(slashCommand({ name: 'diagrams', description: 'Show or hide the diagrams', reply: () => pane.toggle() }))
  },
})

test('a pane sized from state opens at the size its state gives', async () => {
  const tested = testMod(diagrams, { state: { session: { shown: 1 } } })

  await tested.type('/diagrams')

  expect(paneOpens(tested)).toEqual([{ id: 'diagrams', title: 'Diagrams', columns: 120 }])
  expect(await tested.lines('diagrams')).toEqual(['Diagram 2', '[ Next ]'])
})

test('an open pane resizes when the state changes its size', async () => {
  const tested = testMod(diagrams)
  await tested.type('/diagrams')

  await tested.press('diagrams', 'Next')

  expect(paneOpens(tested)).toEqual([
    { id: 'diagrams', title: 'Diagrams', columns: 60 },
    { id: 'diagrams', title: 'Diagrams', columns: 120 },
  ])
})

test('a state change that keeps the size does not reopen the pane', async () => {
  const tested = testMod(diagrams, { state: { session: { shown: 1 } } })
  await tested.type('/diagrams')

  await tested.press('diagrams', 'Next')

  expect(await tested.lines('diagrams')).toEqual(['Diagram 3', '[ Next ]'])
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

  await tested.press('diagrams', 'Next')

  expect(paneOpens(tested)).toStrictEqual([
    { id: 'diagrams', title: 'Diagrams', columns: 120 },
    { id: 'diagrams', title: 'Diagrams' },
  ])
})

test('a size from the state that is not a whole number above 0 keeps the pane at its size and logs the pane', async () => {
  const tested = testMod(diagrams, { state: { session: { shown: 3 } } })
  await tested.type('/diagrams')

  await tested.press('diagrams', 'Next')

  expect(paneOpens(tested)).toEqual([{ id: 'diagrams', title: 'Diagrams' }])
  expect(tested.shown.debug).toEqual(['diagrams: the Diagrams pane kept its size: the pane "diagrams" gets columns 0.5 from its state. Return a whole number above 0, or undefined for Claude Code\'s default.'])
})

type HistoryState = { project: { count: number; stepsBack: number } }

const historyPane = definePane<HistoryState>({
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
})

test('one action that sets two state keys resizes the pane once, to the final size', async () => {
  const tested = testMod(
    defineMod({
      name: 'history',
      state: { project: { count: 3, stepsBack: 2 } },
      setup(mod) {
        const pane = mod.ui.pane(historyPane)
        mod.use(slashCommand({ name: 'history', description: 'Show or hide the history', reply: () => pane.toggle() }))
      },
    }),
  )
  await tested.type('/history')

  await tested.press('history', 'Draw')

  expect(paneOpens(tested)).toStrictEqual([
    { id: 'history', title: 'History', columns: 60 },
    { id: 'history', title: 'History' },
  ])
})

const tracer = defineMod({
  name: 'tracer',
  api: {
    signatures: async ({ path }: { path: string }) =>
      (await fs.read(path)).split('\n').flatMap((text, index) => {
        const name = /^export function (\w+)/.exec(text)?.[1]
        return name === undefined ? [] : [{ name, line: index + 1 }]
      }),
  },
  setup() {},
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
  return async (call) => calledAnswer('outline', await claudeCodeOf(provider).fire('cmod.call', call, { deny: `${call.to} is not installed. Add it with /plugin.` }))
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

  expect(await consumer.type('/outline src/a.ts')).toEqual({ text: '/outline failed: tracer is not installed. Add it with /plugin.' })
})

test("a listener whose call is refused shows the refusal once, without Claude Code's prefix", async () => {
  const consumer = testMod(defineMod({ name: 'outline', setup: (mod) => void sessions.current.onSessionStart(async () => void (await mod.dependencies.tracer.signatures({ path: 'src/a.ts' }))) }))

  await consumer.raise.onSessionStart({ source: 'startup' })

  expect(consumer.shown.toasts).toContainEqual({ type: 'error', message: 'The onSessionStart listener failed', description: 'tracer is not installed. Add it with /plugin.' })
})

test('an unknown method fails naming it', async () => {
  const provider = testMod(tracer)
  const below = { deny: 'tracer is not installed. Add it with /plugin.' }

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
    api: {
      // @ts-expect-error
      signatures: async ({ path }: { path: string }) => `${path}:1`,
    },
    setup() {},
  })

  expect(wrong.name).toBe('tracer')
})

test("a mod's settings pages are listed to /mods and open by id, and open() with no id asks cmod to show the mod", async () => {
  let started: Mod | undefined
  const tested = testMod(
    defineMod({
      name: 'ci-watch',
      setup(mod) {
        started = mod
        mod.settings.page(definePane({ id: 'runs', title: 'Runs', render: () => Text({ children: 'last run passed' }) }))
      },
    }),
  )
  const asked: unknown[] = []
  tested.fakes.cmod.call = async (input) => (asked.push(input), null)
  await tested.start()

  expect(await claudeCodeOf(tested).fire('cmod.call', { to: 'ci-watch', method: 'cmod:settingsPages', input: null })).toEqual({ value: [{ id: 'runs', title: 'Runs' }] })
  await claudeCodeOf(tested).fire('cmod.call', { to: 'ci-watch', method: 'cmod:openPage', input: 'runs' })
  expect(tested.shown.openPanes.has('runs')).toBe(true)
  await started?.settings.open()
  expect(asked).toEqual([{ to: 'cmod', method: 'openSettings', input: { mod: 'ci-watch' } }])
  await expect(started?.settings.open('history') ?? Promise.resolve()).rejects.toThrow('ci-watch has no settings page "history". It has: runs.')
})

test("a settings page cannot take the id changelog, which opens the mod's CHANGELOG.md in /mods", async () => {
  const tested = testMod(
    defineMod({
      name: 'ci-watch',
      setup: (mod) => mod.settings.page(definePane({ id: 'changelog', title: 'Changes', render: () => Text({ children: 'v2' }) })),
    }),
  )

  await expect(tested.start()).rejects.toThrow(`ci-watch: the settings page id "changelog" opens the mod's CHANGELOG.md in /mods. Give the page another id.`)
})
