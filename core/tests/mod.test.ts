import { expect, expectTypeOf, test } from 'bun:test'
import type { AgentInfo, ClassicHookInputs, EventResult, RenderElement } from 'claude-code'
import { slashCommand } from '../src/jobs/slash-command.js'
import { tool } from '../src/jobs/tool.js'
import corePackage from '../package.json' with { type: 'json' }
import { defineMod, messageOf, type HookInput, type Job, type Message, type Mod, type ModHook, type PaneHandle, type Session } from '../src/mod.js'
import { coreVersion } from '../src/records.js'
import type { Claude } from '../src/runtime/claude.js'
import { createLifecycle } from '../src/runtime/lifecycle.js'
import { testMod, type TestedMod } from '../src/testing.js'
import { calledAnswer, fakeClaude, type TestCall } from '../src/testing/fake-claude.js'
import { findElement, textOf } from '../src/testing/fake-elements.js'
import { definePane } from '../src/ui/define-pane.js'
import { Box, Button, Text } from '../src/ui/elements.js'
import type { TracerSignature } from './tracer.js'

const base = { session_id: 'session-1', transcript_path: '/tmp/transcript.jsonl', cwd: '/work', permission_mode: 'default' }

function postToolUse(tool: string): ClassicHookInputs['PostToolUse'] {
  return { ...base, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { file_path: '/work/a.ts' }, tool_response: {}, tool_use_id: 'toolu_1' }
}

function preToolUse(command: string): ClassicHookInputs['PreToolUse'] {
  return { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_2' }
}

const touchTracker = defineMod({
  name: 'touch-tracker',
  state: { session: { hasSetUp: false, touched: [] as string[] } },
  setup(mod) {
    mod.state.session.hasSetUp = true
    mod.on('PostToolUse', (input) => {
      mod.state.session.touched = [...mod.state.session.touched, input.tool_name]
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `touch-tracker saw ${input.tool_name}` } }
    })
  },
})

test("an installed mod's setup runs during session.start and its PostToolUse hook answers the first event", async () => {
  const tested = testMod(touchTracker, { permissions: ['prompt'] })
  await tested.start()
  expect(tested.state).toEqual({ session: { hasSetUp: true, touched: [] } })

  const answer = await tested.fire('PostToolUse', postToolUse('Read'))

  expect(answer).toEqual({ additionalContext: ['touch-tracker saw Read'] })
  expect(tested.state.session.touched).toEqual(['Read'])
})

test('fire fills the session fields a test leaves out of the hook input', async () => {
  const seen: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'prompt-counter',
      setup(mod) {
        mod.on('UserPromptSubmit', (input) => {
          seen.push(input)
        })
      },
    }),
  )

  await tested.fire('UserPromptSubmit', { prompt: 'hello' })

  expect(seen).toEqual([
    { session_id: 'test-session', transcript_path: '/test/transcripts/test-session.jsonl', cwd: '/test/plugins/prompt-counter', hook_event_name: 'UserPromptSubmit', prompt: 'hello' },
  ])
})

const safeDelete = defineMod({
  name: 'safe-delete',
  setup(mod) {
    mod.on('PreToolUse', (input) => {
      const { command } = input.tool_input as { command: string }
      if (!command.startsWith('rm ')) return
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { command: command.replace(/^rm( -rf?)? /, 'trash ') },
        },
      }
    })
  },
})

test('a PreToolUse hook that answers updatedInput rewrites the Bash command Claude Code runs', async () => {
  const tested = testMod(safeDelete, { permissions: ['tools'] })

  const answer = await tested.fire('PreToolUse', preToolUse('rm -rf build'))

  expect(answer).toEqual({ updatedInput: { command: 'trash build' } })
})

test("Claude Code's permission check and the tool get the input a PreToolUse hook rewrote, with tool.call's own keys kept", async () => {
  const fake = fakeClaude({ name: 'safe-delete', root: '/test/plugins/safe-delete' })
  fake.fakes.agent.list = async () => [{ id: 'agent-2', type: 'explorer' } as AgentInfo]
  const lifecycle = createLifecycle(safeDelete)
  await lifecycle.start(fake.claude, async () => ({ name: 'safe-delete', root: '/test/plugins/safe-delete', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {}, granted: ['tools'] }))
  const reached: unknown[] = []
  const core = async (e: unknown) => (reached.push(e), { result: '' }) as EventResult<'tool.call'>

  await lifecycle.route('tool.call', { tool: 'Bash', tool_use_id: 'toolu_5', agentId: 'agent-2', command: 'rm -rf build' }, core)
  await lifecycle.route('tool.call', { tool: 'Bash', tool_use_id: 'toolu_6', command: 'ls' }, core)

  expect(reached).toEqual([
    { tool: 'Bash', tool_use_id: 'toolu_5', agentId: 'agent-2', command: 'trash build' },
    { tool: 'Bash', tool_use_id: 'toolu_6', command: 'ls' },
  ])
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
  expect(tested.shown.toasts).toContainEqual({ type: 'error', message: 'The every 30000 ms hook failed', description: 'CI is down' })
})

test('mod.every refuses a time that is not a whole number of milliseconds', async () => {
  const lifecycle = createLifecycle(defineMod({ name: 'ticker', setup: (mod) => void mod.every(0.5, () => undefined) }))
  const fake = fakeClaude({ name: 'ticker', root: '/test/plugins/ticker' })

  await lifecycle.start(fake.claude, async () => ({ name: 'ticker', root: '/test/plugins/ticker', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {}, granted: [] }))

  expect(String(lifecycle.failure)).toContain('ticker: mod.every is 0.5. Give a whole number of milliseconds above 0 and at most 2147483647.')
})

test('mod.session.append adds a note Claude reads, and mod.session.submit asks Claude for a turn', async () => {
  const tested = testMod(
    defineMod({
      name: 'ci-watch',
      setup(mod) {
        mod.on('SessionStart', async () => {
          await mod.session.append('CI failed on main.')
          await mod.session.submit('Find the cause of the CI failure and fix it.')
        })
      },
    }),
    { permissions: ['prompt'] },
  )

  await tested.fire('SessionStart', { source: 'startup' })

  expect(tested.shown.notes).toEqual(['CI failed on main.'])
  expect(tested.shown.prompts).toEqual(['Find the cause of the CI failure and fix it.'])
  expect(tested.calls.find(({ call }) => call === 'session.append')?.args).toEqual([{ message: { type: 'user', content: [{ type: 'text', text: 'CI failed on main.' }] } }])
})

test('mod.session.append rejects with the reason when a plugin refuses the note', async () => {
  let failure = ''
  const tested = testMod(
    defineMod({
      name: 'ci-watch',
      setup: (mod) => mod.on('SessionStart', () => mod.session.append('CI failed.').catch((error: Error) => void (failure = error.message))),
    }),
    { permissions: ['prompt'] },
  )
  tested.fakes.session.append = async () => ({ deny: 'Notes are off in this organization.' })

  await tested.fire('SessionStart', { source: 'startup' })

  expect(failure).toBe('ci-watch: Claude Code refused the note: Notes are off in this organization.')
})

test("mod.model.complete passes the request and options to Claude Code's model call", async () => {
  let verdict: unknown
  const tested = testMod(
    defineMod({
      name: 'babysitter',
      setup: (mod) => mod.on('Stop', async () => void (verdict = await mod.model.complete({ model: 'haiku', prompt: 'Is this reply a waste of time?', timeoutMs: 8000 }))),
    }),
    { permissions: ['model'] },
  )
  tested.fakes.model.complete = async () => ({ isAnswered: true, text: 'no' }) as never

  await tested.fire('Stop', { stop_hook_active: false, last_assistant_message: 'Done.' } as never)

  expect(verdict).toEqual({ isAnswered: true, text: 'no' })
  expect(tested.calls.find(({ call }) => call === 'model.complete')?.args[0]).toEqual({ model: 'haiku', prompt: 'Is this reply a waste of time?', timeoutMs: 8000 })
})

test('a hook past its timeoutMs answers as if it were absent and warns of the timeout', async () => {
  let passTimeout: () => void = () => undefined
  const tested = testMod(
    defineMod({
      name: 'babysitter',
      setup(mod) {
        mod.on('Stop', () => new Promise(() => undefined), { timeoutMs: 8000 })
      },
    }),
  )
  tested.fakes.clock.after = (ms, fn) => {
    if (ms === 8000) passTimeout = fn
    return { cancel: () => undefined }
  }

  const answer = tested.fire('Stop', { stop_hook_active: false, last_assistant_message: 'Done.' } as never, {})
  await tested.settle()
  passTimeout()

  expect(await answer).toEqual({})
  expect(tested.shown.toasts).toContainEqual({ type: 'warning', message: 'The Stop hook passed its 8 s timeout' })
})

test('a hook that answers before its timeoutMs keeps its answer', async () => {
  const tested = testMod(
    defineMod({
      name: 'babysitter',
      setup: (mod) => mod.on('Stop', async () => ({ decision: 'block', reason: 'Answer the question directly.' }), { timeoutMs: 8000 }),
    }),
    { permissions: ['prompt'] },
  )

  expect(await tested.fire('Stop', { stop_hook_active: false, last_assistant_message: 'Done.' } as never, {})).toEqual({ block: 'Answer the question directly.' })
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
    { type: 'success', message: 'Ready' },
  ])
})

test('a PreToolUse hook that answers additionalContext adds it to the call', async () => {
  const tested = testMod(
    defineMod({
      name: 'docs',
      setup(mod) {
        mod.on('PreToolUse', () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'src/CLAUDE.md says: no default exports.' } }))
      },
    }),
    { permissions: ['prompt'] },
  )

  expect(await tested.fire('PreToolUse', preToolUse('cat src/a.ts'))).toEqual({ additionalContext: ['src/CLAUDE.md says: no default exports.'] })
  expect(await tested.fire('PreToolUse', preToolUse('cat src/a.ts'), { deny: 'org policy' })).toEqual({ deny: 'org policy' })
})

const decides = (permissionDecision: 'allow' | 'ask') =>
  defineMod({
    name: 'auto-approve',
    setup(mod) {
      mod.on('PreToolUse', () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: 'Checked by auto-approve.' } }))
    },
  })

test("a PreToolUse allow skips Claude Code's ask, and an ask puts the call to the person", async () => {
  expect(await testMod(decides('allow'), { permissions: ['approve'] }).fire('PreToolUse', preToolUse('ls'))).toEqual({ allow: true })
  expect(await testMod(decides('ask'), { permissions: ['approve'] }).fire('PreToolUse', preToolUse('ls'))).toEqual({ ask: 'Checked by auto-approve.' })
})

test('a PreToolUse allow without the grant to approve tool calls leaves the call to Claude Code, and says so once', async () => {
  const tested = testMod(decides('allow'), { permissions: [] })

  expect(await tested.fire('PreToolUse', preToolUse('ls'))).toEqual({})
  expect(await tested.fire('PreToolUse', preToolUse('pwd'))).toEqual({})
  expect(tested.shown.toasts.filter(({ type }) => type === 'warning')).toEqual([
    {
      type: 'warning',
      message: `Answered allow on a tool call without your grant to "Approve Claude's tool calls for you", so cmod dropped it`,
      description: 'It needs "permissions": { "approve": true } in package.json "cmod".',
    },
  ])
})

test('a deny beneath a PreToolUse allow stands', async () => {
  expect(await testMod(decides('allow'), { permissions: ['approve'] }).fire('PreToolUse', preToolUse('rm build'), { deny: 'org policy' })).toEqual({ deny: 'org policy' })
})

test('a PreToolUse hook that returns nothing leaves the call to the hooks beneath it', async () => {
  const tested = testMod(safeDelete)

  const answer = await tested.fire('PreToolUse', preToolUse('ls'))

  expect(answer).toEqual({})
})

test("Claude Code's deny of a rewritten call stays the call's answer", async () => {
  const tested = testMod(safeDelete, { permissions: ['tools'] })

  const answer = await tested.fire('PreToolUse', preToolUse('rm build'), { deny: 'org policy' })

  expect(answer).toEqual({ deny: 'org policy', updatedInput: { command: 'trash build' } })
})

test('a block denies the call before Claude Code checks its permission', async () => {
  const tested = testMod(
    defineMod({
      name: 'guard',
      setup(mod) {
        mod.on('PreToolUse', () => ({ decision: 'block', reason: 'Never deploy from a laptop.' }))
      },
    }),
  )

  expect(await tested.fire('PreToolUse', preToolUse('deploy'))).toEqual({ deny: 'Never deploy from a laptop.' })
})

test('the PreToolUse hook reads the settings.json input built from the tool call and the session as it is now', async () => {
  const seen: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'input-reader',
      setup(mod) {
        mod.on('PreToolUse', (input) => {
          seen.push(input)
        })
      },
    }),
  )
  await tested.fire('PreToolUse', preToolUse('git status'))

  expect(seen).toEqual([
    {
      session_id: 'test-session',
      cwd: '/test/plugins/input-reader',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      tool_use_id: 'toolu_2',
      files: { read: [], changed: [] },
    },
  ])
})

test('a PreToolUse hook in a subagent sees agent_id and agent_type', async () => {
  const seen: unknown[] = []
  const fake = fakeClaude({ name: 'input-reader', root: '/test/plugins/input-reader' })
  fake.fakes.agent.list = async () => [{ id: 'agent-7', type: 'code-reviewer' } as AgentInfo]
  const lifecycle = createLifecycle(
    defineMod({
      name: 'input-reader',
      setup(mod) {
        mod.on('PreToolUse', (input) => {
          seen.push(input)
        })
      },
    }),
  )
  await lifecycle.start(fake.claude, async () => ({ name: 'input-reader', root: '/test/plugins/input-reader', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {}, granted: [] }))

  await lifecycle.route('tool.call', { tool: 'Bash', tool_use_id: 'toolu_9', command: 'ls', agentId: 'agent-7' }, async () => ({ result: '' }))

  expect(seen).toEqual([
    {
      session_id: 'test-session',
      cwd: '/test/plugins/input-reader',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'toolu_9',
      agent_id: 'agent-7',
      agent_type: 'code-reviewer',
      files: { read: [], changed: [] },
    },
  ])
})

test('an answer field that the event does not read is logged with the field and the event named', async () => {
  const tested = testMod(
    defineMod({
      name: 'wrong-field',
      setup(mod) {
        mod.on('PostToolUse', () => ({ hookSpecificOutput: { sessionTitle: 'nope' } }))
      },
    }),
  )

  const answer = await tested.fire('PostToolUse', postToolUse('Read'), { additionalContext: ['from settings'] })

  expect(answer).toEqual({ additionalContext: ['from settings'] })
  expect(tested.shown.toasts).toContainEqual({
    type: 'error',
    message: 'The PostToolUse hook failed',
    description: 'it answered hookSpecificOutput.sessionTitle, which PostToolUse does not read. Remove it from the answer.',
  })
})

test("a PreToolUse hook that throws denies the call with the mod's name and the error, before the hooks after it", async () => {
  const tested = testMod(
    defineMod({
      name: 'guard',
      setup(mod) {
        mod.on('PreToolUse', () => {
          throw new Error('the policy file is missing')
        })
        mod.on('PreToolUse', () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'the second hook ran' } }))
      },
    }),
  )

  const answer = await tested.fire('PreToolUse', preToolUse('rm build'))

  expect(answer).toEqual({ deny: 'guard: the PreToolUse hook failed: the policy file is missing' })
})

test('a PermissionRequest hook that throws denies the request', async () => {
  const ran: string[] = []
  const tested = testMod(
    defineMod({
      name: 'guard',
      setup(mod) {
        mod.on('PermissionRequest', () => {
          throw new Error('the policy file is missing')
        })
        mod.on('PermissionRequest', (input) => {
          ran.push(input.tool_name)
        })
      },
    }),
  )

  const answer = await tested.fire('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm build' } }, { decision: { behavior: 'allow' } })

  expect(answer).toEqual({ decision: { behavior: 'deny', message: 'guard: the PermissionRequest hook failed: the policy file is missing' } })
  expect(ran).toEqual(['Bash'])
})

test('a Stop hook that throws is logged and the event passes on', async () => {
  const tested = testMod(
    defineMod({
      name: 'keep-going',
      setup(mod) {
        mod.on('Stop', () => {
          throw new Error('the test runner is missing')
        })
        mod.on('Stop', () => ({ decision: 'block', reason: 'Run the tests first.' }))
      },
    }),
    { permissions: ['prompt'] },
  )

  const answer = await tested.fire('Stop', { ...base, hook_event_name: 'Stop', stop_hook_active: false } as ClassicHookInputs['Stop'], { additionalContext: ['from settings'] })

  expect(answer).toEqual({ block: 'Run the tests first.', additionalContext: ['from settings'] })
  expect(tested.shown.toasts).toContainEqual({ type: 'error', message: 'The Stop hook failed', description: 'the test runner is missing' })
})

test('a PreToolUse answer with a field PreToolUse does not read denies the call', async () => {
  const tested = testMod(
    defineMod({
      name: 'wrong-field',
      setup(mod) {
        mod.on('PreToolUse', () => ({ hookSpecificOutput: { sessionTitle: 'nope' } }))
      },
    }),
  )

  const answer = await tested.fire('PreToolUse', preToolUse('ls'))

  expect(answer).toEqual({
    deny: 'wrong-field: the PreToolUse hook failed: it answered hookSpecificOutput.sessionTitle, which PreToolUse does not read. Remove it from the answer.',
  })
})

test('a Stop hook that blocks keeps Claude going with the reason', async () => {
  const tested = testMod(
    defineMod({
      name: 'keep-going',
      setup(mod) {
        mod.on('Stop', () => ({ decision: 'block', reason: 'Run the tests first.' }))
      },
    }),
    { permissions: ['prompt'] },
  )

  const answer = await tested.fire('Stop', { ...base, hook_event_name: 'Stop', stop_hook_active: false } as ClassicHookInputs['Stop'])

  expect(answer).toEqual({ block: 'Run the tests first.' })
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

  expect(textOf(await tested.fire('ui.render', abovePrompt as never, prompt))).toBe('>\n⠋  indexer  Indexing files  ✕\n✓  indexer  Ready  ✕')
  finish(12)
  await tested.settle()

  expect(await unwrapped).toBe(12)
  expect(tested.shown.toasts).toEqual([
    { type: 'success', message: 'Indexed 12 files' },
    { type: 'success', message: 'Ready' },
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
  expect(tested.shown.toasts.map(({ type, message }) => `${type}: ${message}`)).toEqual(['error: Indexing failed: disk full', 'error: Indexing failed again', 'success: Ready'])
})

const toastBand = { surface: 'terminal' as const, component: 'AbovePrompt' as const, requestId: 'band', props: { hasSurvey: false }, viewport: { columns: 100, rows: 24 } }

const belowBand = { type: 'Text', children: ['>'] } as unknown as RenderElement

async function pressInBand(tested: TestedMod<object>, label: string): Promise<void> {
  const button = findElement(await tested.fire('ui.render', toastBand as never, belowBand), 'Button', label)
  if (button === undefined) throw new Error(`The band draws no button ${label}.`)
  await (button['onPress'] as () => unknown)()
  await tested.settle()
}

test("a failure toast's Copy copies the mod and core versions, message, description, and stack, then reads Copied", async () => {
  const root = '/test/plugins/keep-going'
  const tested = testMod(defineMod({ name: 'keep-going', setup: (mod) => mod.on('Stop', () => Promise.reject(new Error('the test runner is missing'))) }), {
    files: { [`${root}/.claude-plugin/plugin.json`]: '{ "name": "keep-going", "version": "1.4.0" }' },
  })
  await tested.fire('Stop', { stop_hook_active: false } as never)

  await pressInBand(tested, 'Copy')

  const [copied] = tested.calls.filter(({ call }) => call === 'ui.copy').map(({ args }) => (args[0] as { text: string }).text)
  expect(copied).toStartWith(`keep-going 1.4.0, @cmodjs/core ${corePackage.version}\nThe Stop hook failed\nthe test runner is missing\n\nError: the test runner is missing\n    at `)
  expect(textOf(await tested.fire('ui.render', toastBand as never, belowBand))).toContain('Copied')
})

test('coreVersion, which a bundled mod reports in Copy, is the version in core/package.json', () => {
  expect(coreVersion).toBe(corePackage.version)
})

test('a Copy Claude Code refuses names the reason on the button', async () => {
  const tested = testMod(defineMod({ name: 'keep-going', setup: (mod) => mod.on('Stop', () => Promise.reject(new Error('the test runner is missing'))) }))
  tested.fakes.ui.copy = async () => ({ isCopied: false, reason: 'no-clipboard' })
  await tested.fire('Stop', { stop_hook_active: false } as never)

  await pressInBand(tested, 'Copy')

  expect(findElement(await tested.fire('ui.render', toastBand as never, belowBand), 'Button', 'Copy failed: no-clipboard')).toBeDefined()
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

  expect(await drawn()).toBe('>\n+2 more\n   notes  Note c  ✕\n   notes  Note d  ✕\n✓  notes  Ready  ✕')

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
  void job.mod.claude.command.register({ name: 'pushes', description: 'List refused pushes' })
  job.announce('the /pushes command')
  job.mod.claude.on('tool.check', async (e, next) => {
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

  const denied = await tested.fire('tool.check', { tool: 'Bash', input: { command: 'git push --force' } }, { decision: 'allow' })
  const allowed = await tested.fire('tool.check', { tool: 'Bash', input: { command: 'git push' } }, { decision: 'allow' })

  expect(denied).toEqual({ decision: 'deny', reason: 'Force pushes are off in this repository.' })
  expect(allowed).toEqual({ decision: 'allow' })
  expect(handle?.denied).toEqual(['git push --force'])
  expect(tested.shown.commands).toEqual(['pushes'])
  expect(tested.shown.toasts).toEqual([{ type: 'success', message: 'Ready' }])
  expect(tested.shown.logs).toEqual(['guard added the /pushes command.'])
})

test('mod.projectRoot and mod.cwd are set before setup runs', async () => {
  const seen: string[] = []
  const tested = testMod(
    defineMod({
      name: 'file-tree',
      setup(mod) {
        seen.push(mod.projectRoot, mod.cwd)
      },
    }),
    { projectRoot: '/work/app', cwd: '/work/app/src' },
  )

  await tested.start()

  expect(seen).toEqual(['/work/app', '/work/app/src'])
})

function projectFolders() {
  const mods: Mod<{ project: { expanded: string[] } }>[] = []
  const definition = defineMod({
    name: 'file-tree',
    state: { project: { expanded: [] as string[] } },
    setup(mod) {
      mods.push(mod)
    },
  })
  return { mods, definition }
}

test('a project value saved in one project is not seen in another', async () => {
  const { mods, definition } = projectFolders()
  const tested = testMod(definition, { projectRoot: '/work/a' })
  await tested.start()
  tested.state.project.expanded = ['src']

  await tested.moveTo('/work/b')

  expect(mods.map((mod) => [mod.projectRoot, mod.cwd])).toEqual([['/work/b', '/work/b']])
  expect(tested.state.project.expanded).toEqual([])

  await tested.moveTo('/work/a')

  expect(tested.state.project.expanded).toEqual(['src'])
})

test("a tool's mod reads the project the session moved to", async () => {
  const tested = testMod(
    defineMod({
      name: 'file-tree',
      setup(mod) {
        mod.use(tool({ name: 'where', description: 'Name the project folder', inputSchema: { type: 'object', properties: {} }, execute: (_input, mod) => `${mod.projectRoot} ${mod.cwd}` }))
      },
    }),
    { projectRoot: '/work/a' },
  )
  await tested.start()

  await tested.moveTo('/work/b')

  expect(await tested.callTool('where', {})).toEqual({ result: '/work/b /work/b' })
})

test('a CwdChanged hook that refreshes runs once after /cd, before the next prompt', async () => {
  const tested = testMod(
    defineMod({
      name: 'file-tree',
      setup(mod) {
        mod.on('CwdChanged', () => void mod.process.run(['git', 'status', '--porcelain'], { cwd: mod.projectRoot }))
      },
    }),
    { projectRoot: '/work/a', permissions: ['run:git'] },
  )
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  const refreshedFolders = () => tested.calls.filter((call) => call.call === 'process.run').map((call) => call.args[1])
  await tested.start()

  await tested.moveTo('/work/b')

  expect(refreshedFolders()).toEqual([{ cwd: '/work/b' }])

  await tested.fire('UserPromptSubmit', { prompt: 'hello' })

  expect(refreshedFolders()).toEqual([{ cwd: '/work/b' }])
})

test('a project value keeps only the 20 projects used most recently', async () => {
  const tested = testMod(projectFolders().definition, { projectRoot: '/work/0' })
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
  await tested.fire('SessionStart', { source: 'clear', session_id: 'second' })

  await tested.fire('SessionStart', { source: 'resume', session_id: 'test-session' })

  expect(tested.state.session.draft).toBe('buy milk')
})

test('a session value resets to its default on /clear', async () => {
  const tested = testMod(notes)
  await tested.start()
  tested.state.session.draft = 'buy milk'

  await tested.fire('SessionStart', { source: 'clear', session_id: 'second' })

  expect(tested.state.session.draft).toBe('')
})

test("a branched session starts with its parent's session values", async () => {
  const tested = testMod(notes)
  await tested.start()
  tested.state.session.draft = 'buy milk'

  await tested.fire('SessionStart', { source: 'fork', session_id: 'branch' })

  expect(tested.state.session.draft).toBe('buy milk')
  tested.state.session.draft = 'call mum'
  await tested.fire('SessionStart', { source: 'resume', session_id: 'test-session' })
  expect(tested.state.session.draft).toBe('buy milk')
  await tested.fire('SessionStart', { source: 'resume', session_id: 'branch' })
  expect(tested.state.session.draft).toBe('call mum')
})

test('a session value comes back on resume however many sessions ran since', async () => {
  const tested = testMod(notes)
  await tested.fire('SessionStart', { source: 'startup', session_id: 'first' })
  tested.state.session.draft = 'buy milk'
  for (let session = 0; session < 25; session += 1) {
    await tested.fire('SessionStart', { source: 'clear', session_id: `session-${session}` })
    tested.state.session.draft = `draft ${session}`
  }

  await tested.fire('SessionStart', { source: 'resume', session_id: 'first' })

  expect(tested.state.session.draft).toBe('buy milk')
})

test('a session value is deleted once Claude Code deletes the session transcript', async () => {
  const tested = testMod(notes)
  await tested.fire('SessionStart', { source: 'startup', session_id: 'gone', transcript_path: '/test/transcripts/gone.jsonl' })
  tested.state.session.draft = 'buy milk'
  await tested.fire('SessionStart', { source: 'clear', session_id: 'second' })

  await tested.fire('SessionStart', { source: 'resume', session_id: 'gone', transcript_path: '/test/transcripts/gone.jsonl' })

  expect(tested.state.session.draft).toBe('')
})

const gitChanges = defineMod({ name: 'file-tree', state: { memory: { changed: [] as string[] }, session: { touched: [] as string[] } }, setup() {} })

test('a memory value resets on /clear', async () => {
  const tested = testMod(gitChanges)
  await tested.start()
  tested.state.memory.changed = ['README.md']

  await tested.fire('SessionStart', { source: 'clear', session_id: 'second' })

  expect(tested.state.memory.changed).toEqual([])
})

test('a memory value starts from its default after a resume', async () => {
  const tested = testMod(gitChanges)
  await tested.start()
  tested.state.memory.changed = ['README.md']

  await tested.fire('SessionStart', { source: 'resume', session_id: 'earlier' })

  expect(tested.state.memory.changed).toEqual([])
})

test('a branched conversation keeps its session values and starts a memory value from its default', async () => {
  const tested = testMod(gitChanges)
  await tested.start()
  tested.state.memory.changed = ['README.md']
  tested.state.session.touched = ['src/mod.ts']

  await tested.fire('SessionStart', { source: 'fork', session_id: 'branch' })

  expect(tested.state).toEqual({ memory: { changed: [] }, session: { touched: ['src/mod.ts'] } })
})

test('a memory value stays through a compaction', async () => {
  const tested = testMod(gitChanges)
  await tested.start()
  tested.state.memory.changed = ['README.md']

  await tested.fire('SessionStart', { source: 'compact', session_id: 'test-session' })

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

test("mod.claude.settings.read({ source: 'user' }) reads one settings source", async () => {
  let enabled: unknown
  const tested = testMod(
    defineMod({
      name: 'cmod',
      async setup(mod) {
        enabled = (await mod.claude.settings.read({ source: 'user' }))['enabledPlugins']
      },
    }),
  )
  tested.fakes.settings.read = async (args) => (args?.source === 'user' ? { enabledPlugins: { 'demo@market': true } } : {})

  await tested.start()

  expect(enabled).toEqual({ 'demo@market': true })
})

test('mod.fs.exists and mod.fs.stat answer for files and folders', async () => {
  let answers: unknown
  const tested = testMod(
    defineMod({
      name: 'finder',
      async setup(mod) {
        answers = {
          file: await mod.fs.exists('/work/app/src/cart.ts'),
          folder: await mod.fs.exists('/work/app/src'),
          missing: await mod.fs.exists('/work/app/cart.ts'),
          kind: (await mod.fs.stat('/work/app/src')).kind,
        }
      },
    }),
    { files: { '/work/app/src/cart.ts': 'x\n' } },
  )

  await tested.start()

  expect(answers).toEqual({ file: true, folder: true, missing: false, kind: 'dir' })
})

const conversation: Message[] = [
  { id: 'm1', session: 'test-session', at: '2026-10-11T10:00:00.000Z', from: { kind: 'person' }, text: 'Rename the tree pane', tools: [] },
  { id: 'm2', session: 'test-session', at: '2026-10-11T10:00:05.000Z', from: { kind: 'claude' }, text: '', tools: [{ tool: 'Agent', input: { prompt: 'find the pane' }, id: 'toolu_1', result: 'found it', subagent: 'agent-3' }] },
  { id: 'a1', session: 'test-session', agent: 'agent-3', at: '2026-10-11T10:00:06.000Z', from: { kind: 'agent' }, text: 'find the pane', tools: [] },
  { id: 'o1', session: 'older', at: '2026-10-10T09:00:00.000Z', from: { kind: 'mod', name: 'modes' }, text: 'Switch to build mode, then rename the pane', tools: [] },
]

const sessions: Session[] = [
  { id: 'test-session', title: 'Rename the tree pane', project: '/test/plugins/history', startedAt: '2026-10-11T10:00:00.000Z', lastAt: '2026-10-11T10:00:06.000Z' },
  { id: 'older', title: 'Switch to build mode', project: '/test/plugins/history', startedAt: '2026-10-10T09:00:00.000Z', lastAt: '2026-10-10T09:00:00.000Z' },
]

async function readAll(messages: AsyncIterable<Message>): Promise<string[]> {
  const ids: string[] = []
  for await (const message of messages) ids.push(message.id)
  return ids
}

test("mod.history.messages reads this conversation, or a subagent's by its id", async () => {
  let mod: Mod | undefined
  const tested = testMod(defineMod({ name: 'history', setup: (started) => void (mod = started) }), { permissions: ['conversation'], history: { sessions, messages: conversation } })
  await tested.start()

  expect(await readAll(mod!.history.messages())).toEqual(['m1', 'm2'])
  expect(await readAll(mod!.history.messages({ agent: 'agent-3' }))).toEqual(['a1'])
  expect(await readAll(mod!.history.messages({ session: 'older' }))).toEqual(['o1'])
  expect(await readAll(mod!.history.messages({ last: 1 }))).toEqual(['m2'])
  expect(await readAll(mod!.history.messages({ subagents: true }))).toEqual(['m1', 'm2', 'a1'])
})

test('mod.history.messages with follow yields each message saved after the event that adds it', async () => {
  let mod: Mod | undefined
  const saved = conversation.slice(0, 1)
  const tested = testMod(defineMod({ name: 'history', setup: (started) => void (mod = started) }), { permissions: ['conversation'], history: { sessions, messages: saved } })
  await tested.start()
  const seen: string[] = []
  const following = (async () => {
    for await (const message of mod!.history.messages({ follow: true })) {
      seen.push(message.id)
      if (seen.length === 2) return
    }
  })()
  await tested.settle()
  expect(seen).toEqual(['m1'])

  saved.push(conversation[1] as Message)
  await tested.fire('Stop', { stop_hook_active: false, last_assistant_message: '' } as never)
  await following

  expect(seen).toEqual(['m1', 'm2'])
})

test("mod.history.messages with follow on another session's conversation reads it again each second", async () => {
  let mod: Mod | undefined
  const saved = conversation.slice(3)
  const tested = testMod(defineMod({ name: 'history', setup: (started) => void (mod = started) }), { permissions: ['conversation'], history: { sessions, messages: saved } })
  const ticks: (() => void)[] = []
  tested.fakes.clock.after = (ms, fn) => {
    if (ms === 1000) ticks.push(fn)
    return { cancel: () => undefined }
  }
  await tested.start()
  const seen: string[] = []
  const following = (async () => {
    for await (const message of mod!.history.messages({ session: 'older', follow: true })) {
      seen.push(message.id)
      if (seen.length === 2) return
    }
  })()
  await tested.settle()
  expect(seen).toEqual(['o1'])

  saved.push({ id: 'o2', session: 'older', at: '2026-10-10T09:00:05.000Z', from: { kind: 'claude' }, text: 'Build mode is on.', tools: [] })
  ticks.shift()?.()
  await following

  expect(seen).toEqual(['o1', 'o2'])
})

test('mod.history.search returns every message of the project containing the text, newest first, and sessions lists the project', async () => {
  let mod: Mod | undefined
  const tested = testMod(defineMod({ name: 'history', setup: (started) => void (mod = started) }), { permissions: ['conversation'], history: { sessions, messages: conversation } })
  await tested.start()

  expect((await mod!.history.search('RENAME')).map((message) => message.id)).toEqual(['m1', 'o1'])
  expect((await mod!.history.search('find the pane')).map((message) => message.id)).toEqual(['a1', 'm2'])
  expect((await mod!.history.search('find the pane', { limit: 1, before: { session: 'test-session', id: 'a1' } })).map((message) => message.id)).toEqual(['m2'])
  await expect(mod!.history.search('pa')).rejects.toThrow('cmod history search takes at least 3 characters.')
  await expect(mod!.history.search('pane', { before: { session: 'test-session', id: 'gone' } })).rejects.toThrow('No indexed message gone is in session test-session.')
  expect((await mod!.history.sessions({ since: '2026-10-11T00:00:00.000Z' })).map((session) => session.id)).toEqual(['test-session'])
})

test('mod.history refuses a mod without the conversation permission and names the fix', async () => {
  let mod: Mod | undefined
  const tested = testMod(defineMod({ name: 'history', setup: (started) => void (mod = started) }), { permissions: [], history: { sessions, messages: conversation } })
  await tested.start()

  await expect(mod!.history.sessions()).rejects.toThrow('history calls history, which needs "permissions": { "conversation": true } in package.json "cmod".')
})

test('mod.agent.spawn starts a subagent and returns its agentId', async () => {
  let spawned: unknown
  const tested = testMod(
    defineMod({
      name: 'caller',
      setup(mod) {
        mod.on('UserPromptSubmit', async () => {
          spawned = await mod.agent.spawn({ prompt: 'Read README.md.', subagentType: 'explorer' })
        })
      },
    }),
    { permissions: ['agents'] },
  )
  tested.fakes.agent.spawn = async () => ({ agentId: 'agent-7', model: 'test-model' })

  await tested.fire('UserPromptSubmit', { prompt: 'go' } as never)

  expect(spawned).toEqual({ agentId: 'agent-7', model: 'test-model' })
  expect(tested.calls.filter((call) => call.call === 'agent.spawn').map((call) => call.args)).toEqual([[{ prompt: 'Read README.md.', subagentType: 'explorer' }]])
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

test('a FileChanged hook gets the path and what happened to it', async () => {
  const changes: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'reloader',
      setup(mod) {
        mod.on('SessionStart', () => ({ hookSpecificOutput: { hookEventName: 'SessionStart', watchPaths: ['/work/app/history'] } }))
        mod.on('FileChanged', ({ file_path, event }) => void changes.push({ file_path, event }))
      },
    }),
  )

  const started = await tested.fire('SessionStart', { source: 'startup' } as never)
  await tested.fire('FileChanged', { file_path: '/work/app/history/a.json', event: 'change' })

  expect(started).toEqual({ watchPaths: ['/work/app/history'] })
  expect(changes).toEqual([{ file_path: '/work/app/history/a.json', event: 'change' }])
})

test('HookInput names the input of each hook', () => {
  expectTypeOf<HookInput<'FileChanged'>['event']>().toEqualTypeOf<'change' | 'add' | 'unlink'>()
  expectTypeOf<Parameters<ModHook<'PreToolUse'>>[0]>().toEqualTypeOf<HookInput<'PreToolUse'>>()
})

test('a clock.after with no fake answer fires on a real timer', async () => {
  let fired: Promise<void> | undefined
  const tested = testMod(
    defineMod({
      name: 'timer',
      setup(mod) {
        fired = new Promise<void>((resolve) => mod.claude.clock.after(1, resolve))
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
    signatures: async ({ path }: { path: string }, mod) =>
      (await mod.fs.read(path)).split('\n').flatMap((text, index) => {
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
  return async (call) => calledAnswer('outline', await provider.fire('cmod.call', call, { deny: `${call.to} is not installed. Run cmod install ${call.to}.` }))
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

  expect(await consumer.type('/outline src/a.ts')).toEqual({ text: '/outline failed: tracer is not installed. Run cmod install tracer.' })
})

test("a hook whose call is refused shows the refusal once, without Claude Code's prefix", async () => {
  const consumer = testMod(defineMod({ name: 'outline', setup: (mod) => mod.on('Stop', async () => void (await mod.dependencies.tracer.signatures({ path: 'src/a.ts' }))) }))

  await consumer.fire('Stop', { stop_hook_active: false } as never)

  expect(consumer.shown.toasts).toContainEqual({ type: 'error', message: 'The Stop hook failed', description: 'tracer is not installed. Run cmod install tracer.' })
})

test('an unknown method fails naming it', async () => {
  const provider = testMod(tracer)
  const below = { deny: 'tracer is not installed. Run cmod install tracer.' }

  expect(await provider.fire('cmod.call', { to: 'tracer', method: 'callers', input: { name: 'parse' } }, below)).toEqual({ deny: 'tracer has no method callers.' })
  expect(await provider.fire('cmod.call', { to: 'tracer', method: 'constructor', input: {} }, below)).toEqual({ deny: 'tracer has no method constructor.' })
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

  expect(await provider.fire('cmod.call', { to: 'symbols', method: 'signatures', input: { path: 'src/a.ts' } }, below)).toBe(below)
})

test("a dependency call that never answers fails at the deadline with the provider's name", async () => {
  const deadlines: number[] = []
  const tested = testMod(
    defineMod({
      name: 'outline',
      setup(mod) {
        mod.use(slashCommand({ name: 'outline', description: 'List the functions a file exports', reply: async ({ args }, mod) => (await mod.dependencies.tracer.signatures({ path: args })).length.toString() }))
        mod.on('UserPromptSubmit', async () => void (await mod.dependencies.tracer.signatures({ path: 'src/a.ts' })))
      },
    }),
  )
  tested.fakes.cmod.call = () => new Promise(() => undefined)
  tested.fakes.clock.after = (ms, fn) => {
    deadlines.push(ms)
    fn()
    return { cancel: () => undefined }
  }

  expect(await tested.type('/outline src/a.ts')).toEqual({ text: '/outline failed: mod.dependencies.tracer.signatures passed the 30 s deadline of slashCommand' })
  await tested.fire('UserPromptSubmit', { prompt: 'outline src/a.ts' })
  expect(tested.shown.toasts).toContainEqual({ type: 'error', message: 'The UserPromptSubmit hook failed', description: 'mod.dependencies.tracer.signatures passed its 30 s deadline' })
  expect(deadlines).toEqual([30000, 30000])
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

  expect(await tested.fire('cmod.call', { to: 'ci-watch', method: 'cmod:settingsPages', input: null })).toEqual({ value: [{ id: 'runs', title: 'Runs' }] })
  await tested.fire('cmod.call', { to: 'ci-watch', method: 'cmod:openPage', input: 'runs' })
  expect(tested.shown.openPanes.has('runs')).toBe(true)
  await started?.settings.open()
  expect(asked).toEqual([{ to: 'cmod', method: 'openSettings', input: { mod: 'ci-watch' } }])
  await expect(started?.settings.open('history') ?? Promise.resolve()).rejects.toThrow('ci-watch has no settings page "history". It has: runs.')
})
