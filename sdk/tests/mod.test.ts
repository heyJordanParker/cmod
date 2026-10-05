import { expect, expectTypeOf, test } from 'bun:test'
import type { AgentInfo, Args, ClassicHookInputs, Frozen, Next, RenderElement } from 'claude-code'
import { slashCommand } from '../src/jobs/slash-command.js'
import { defineMod, type Mod, type PaneHandle, type Part } from '../src/mod.js'
import type { Claude } from '../src/runtime/claude.js'
import { createLifecycle } from '../src/runtime/lifecycle.js'
import { fakeClaude, testMod, testModWithEngine, textOf, type TestCall } from '../src/testing.js'
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
  const tested = testMod(touchTracker)
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
    { session_id: 'test-session', transcript_path: '/test/transcript.jsonl', cwd: '/test/plugins/prompt-counter', hook_event_name: 'UserPromptSubmit', prompt: 'hello' },
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
          permissionDecision: 'allow',
          updatedInput: { command: command.replace(/^rm( -rf?)? /, 'trash ') },
        },
      }
    })
  },
})

test('a PreToolUse hook that answers updatedInput rewrites the Bash command Claude Code runs', async () => {
  const tested = testMod(safeDelete)

  const answer = await tested.fire('PreToolUse', preToolUse('rm -rf build'))

  expect(answer).toEqual({ allow: true, updatedInput: { command: 'trash build' } })
})

test('a PreToolUse hook that returns nothing leaves the call to the hooks beneath it', async () => {
  const tested = testMod(safeDelete)

  const answer = await tested.fire('PreToolUse', preToolUse('ls'))

  expect(answer).toEqual({})
})

test('a deny beneath the mod outranks the allow the mod answers', async () => {
  const tested = testMod(safeDelete)

  const answer = await tested.fire('PreToolUse', preToolUse('rm build'), { deny: 'org policy' })

  expect(answer).toEqual({ deny: 'org policy', updatedInput: { command: 'trash build' } })
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
  await lifecycle.start(fake.claude, async () => ({ name: 'input-reader', root: '/test/plugins/input-reader', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false }))
  const envelope = { tool: 'Bash', tool_use_id: 'toolu_9', command: 'ls' } as Frozen<Args<'classic.PreToolUse'>>
  const preToolUse = Object.assign(() => lifecycle.route('classic.PreToolUse', envelope, Object.assign(async () => ({}), { event: 'classic.PreToolUse' }) as unknown as Next<'classic.PreToolUse'>), { event: 'tool.call' })

  await lifecycle.route('tool.call', { ...envelope, agentId: 'agent-7' } as Frozen<Args<'tool.call'>>, preToolUse as unknown as Next<'tool.call'>)

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
  expect(tested.shown.logs).toContain(
    'wrong-field: the PostToolUse hook failed: it answered hookSpecificOutput.sessionTitle, which PostToolUse does not read. Remove it from the answer.',
  )
})

test("a PreToolUse hook that throws denies the call with the mod's name and the error", async () => {
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

  const answer = await tested.fire('PreToolUse', preToolUse('rm build'), { allow: true })

  expect(answer).toEqual({ deny: 'guard: the PreToolUse hook failed: the policy file is missing', additionalContext: ['the second hook ran'] })
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
  )

  const answer = await tested.fire('Stop', { ...base, hook_event_name: 'Stop', stop_hook_active: false } as ClassicHookInputs['Stop'], { additionalContext: ['from settings'] })

  expect(answer).toEqual({ block: 'Run the tests first.', additionalContext: ['from settings'] })
  expect(tested.shown.logs).toContain('keep-going: the Stop hook failed: the test runner is missing')
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

  const answer = await tested.fire('PreToolUse', preToolUse('ls'), { allow: true })

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
  expect(await tested.lines('counter')).toEqual(['Count: 0', 'Add one'])
  expect(tested.shown.openPanes).toEqual(new Set(['counter']))

  await tested.press('counter', 'Add one')

  expect(tested.state.session.count).toBe(1)
  expect(await tested.lines('counter')).toEqual(['Count: 1', 'Add one'])
})

test('mod.ui.progress draws a bar line above the prompt while its task runs', async () => {
  let finish: () => void = () => undefined
  const indexer = defineMod({
    name: 'indexer',
    setup(mod) {
      void mod.ui.progress('Indexing files', async (report) => {
        report({ done: 2, total: 4, label: 'Reading src' })
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      })
    },
  })
  const tested = testModWithEngine(indexer)
  const prompt ={ type: 'Text', children: ['>'] } as unknown as RenderElement
  const abovePrompt = { surface: 'terminal' as const, component: 'AbovePrompt' as const, requestId: 'band', props: {}, viewport: { columns: 80, rows: 24 } }

  const drawn = await tested.fire('ui.render', abovePrompt as never, prompt)

  expect(textOf(drawn)).toBe(`>\n⠋ Indexing files  ${'█'.repeat(15)}${'░'.repeat(15)}  2/4  Reading src`)
  finish()
  await Promise.resolve()
  await Promise.resolve()
  expect(await tested.fire('ui.render', abovePrompt as never, prompt)).toBe(prompt)
})

const noForcePush: Part<{ readonly denied: string[] }> = ({ on, claude, adds }) => {
  const denied: string[] = []
  void claude.command.register({ name: 'pushes', description: 'List refused pushes' })
  adds('the /pushes command')
  on('tool.check', async (e, next) => {
    const command = (e.input as { command?: string }).command ?? ''
    if (e.tool !== 'Bash' || !command.includes('push --force')) return next(e)
    denied.push(command)
    return { decision: 'deny', reason: 'Force pushes are off in this repository.' }
  })
  return { denied }
}

test('a part added with mod.use answers tool.check, reaches Claude Code calls, and returns its handle', async () => {
  let handle: { readonly denied: string[] } | undefined
  const tested = testModWithEngine(
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
  expect(tested.shown.toasts).toEqual(['guard is ready'])
  expect(tested.shown.logs).toEqual(['guard added the /pushes command.'])
})

test('mod.session.root is set before setup runs', async () => {
  const seen: string[] = []
  const tested = testMod(
    defineMod({
      name: 'file-tree',
      setup(mod) {
        seen.push(mod.session.root, mod.session.cwd)
      },
    }),
    { projectRoot: '/work/app', cwd: '/work/app/src' },
  )

  await tested.start()

  expect(seen).toEqual(['/work/app', '/work/app/src'])
})

function projectFolders() {
  const sessions: Mod<{ project: { expanded: string[] } }>['session'][] = []
  const definition = defineMod({
    name: 'file-tree',
    state: { project: { expanded: [] as string[] } },
    setup(mod) {
      sessions.push(mod.session)
    },
  })
  return { sessions, definition }
}

test('a project value saved in one project is not seen in another', async () => {
  const { sessions, definition } = projectFolders()
  const tested = testMod(definition, { projectRoot: '/work/a' })
  await tested.start()
  tested.state.project.expanded = ['src']

  await tested.moveTo('/work/b', '/work/b/lib')

  expect(sessions.map((session) => [session.root, session.cwd])).toEqual([['/work/b', '/work/b/lib']])
  expect(tested.state.project.expanded).toEqual([])

  await tested.moveTo('/work/a')

  expect(tested.state.project.expanded).toEqual(['src'])
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

test('a session value keeps only the 20 sessions used most recently', async () => {
  const tested = testMod(notes)
  for (let session = 0; session <= 20; session += 1) {
    await tested.fire('SessionStart', { source: 'clear', session_id: `session-${session}` })
    tested.state.session.draft = `draft ${session}`
  }

  await tested.fire('SessionStart', { source: 'resume', session_id: 'session-0' })

  expect(tested.state.session.draft).toBe('')

  await tested.fire('SessionStart', { source: 'resume', session_id: 'session-1' })

  expect(tested.state.session.draft).toBe('draft 1')
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

const systemFile = '/test/home/.claude/cmods/commits/state.json'

function withFiles(files: Record<string, string>, options: { projectRoot?: string } = {}) {
  const tested = testMod(commits, options)
  tested.fakes.fs.exists = async (path) => files[path] !== undefined
  tested.fakes.fs.read = async (path) => files[path] as string
  return tested
}

test("a value in the system state.json replaces the mod's default", async () => {
  const tested = withFiles({ [systemFile]: '{ "global": { "retries": 5 } }' })
  await tested.start()

  expect(tested.state).toEqual({ session: { greeting: 'hello' }, project: { policy: 'ask' }, global: { retries: 5 } })
  expect(tested.shown.logs).toEqual([])
})

test('a value the mod saved wins over the system state.json', async () => {
  const tested = withFiles({ [systemFile]: '{ "project": { "policy": "never" } }' }, { projectRoot: '/work/a' })
  await tested.start()
  tested.state.project.policy = 'always'

  await tested.moveTo('/work/b')

  expect(tested.state.project.policy).toBe('never')

  await tested.moveTo('/work/a')

  expect(tested.state.project.policy).toBe('always')
})

test('a key the mod does not declare in state.json is ignored with a log line naming it', async () => {
  const tested = withFiles({ [systemFile]: '{ "global": { "retry": 5 }, "globl": { "retries": 5 } }' })
  await tested.start()

  expect(tested.state.global.retries).toBe(3)
  expect(tested.shown.logs).toEqual([
    `${systemFile} sets global.retry, which commits does not declare. Remove it, or use one of: retries.`,
    `${systemFile} sets globl, which commits does not declare. Remove it, or use one of: session, project, global.`,
  ])
})

test('a value of the wrong type in state.json is ignored with a log line', async () => {
  const tested = withFiles({ [systemFile]: '{ "global": { "retries": "five" } }' })
  await tested.start()

  expect(tested.state.global.retries).toBe(3)
  expect(tested.shown.logs).toEqual([`${systemFile} sets global.retries to a string, and commits keeps a number there. Write a number, or remove it.`])
})

test('a session default in state.json is what a new conversation starts with', async () => {
  const tested = withFiles({ [systemFile]: '{ "session": { "greeting": "hi" } }' })
  await tested.start()
  expect(tested.state.session.greeting).toBe('hi')
  tested.state.session.greeting = 'good morning'

  await tested.fire('SessionStart', { source: 'clear', session_id: 'second' })

  expect(tested.state.session.greeting).toBe('hi')
})

test('the project state.json overrides the system state.json', async () => {
  const tested = withFiles(
    {
      [systemFile]: '{ "project": { "policy": "never" }, "global": { "retries": 5 } }',
      '/work/app/.claude/cmods/commits/state.json': '{ "project": { "policy": "always" } }',
    },
    { projectRoot: '/work/app' },
  )
  await tested.start()

  expect(tested.state).toEqual({ session: { greeting: 'hello' }, project: { policy: 'always' }, global: { retries: 5 } })
})

test('a global value in a project state.json is ignored with a log line', async () => {
  const projectFile = '/work/app/.claude/cmods/commits/state.json'
  const tested = withFiles({ [projectFile]: '{ "global": { "retries": 9 } }' }, { projectRoot: '/work/app' })
  await tested.start()

  expect(tested.state.global.retries).toBe(3)
  expect(tested.shown.logs).toEqual([`${projectFile} sets global.retries, and one repository cannot change a value for every project. Move it to ${systemFile}.`])
})

test('a memory key in state.json is ignored with a log line', async () => {
  const userFile = '/test/home/.claude/cmods/file-tree/state.json'
  const projectFile = '/work/app/.claude/cmods/file-tree/state.json'
  const files: Record<string, string> = { [userFile]: '{ "memory": { "changed": ["a.ts"] } }', [projectFile]: '{ "memory": { "changed": ["b.ts"] } }' }
  const tested = testMod(gitChanges, { projectRoot: '/work/app' })
  tested.fakes.fs.exists = async (path) => files[path] !== undefined
  tested.fakes.fs.read = async (path) => files[path] as string
  await tested.start()

  expect(tested.state.memory.changed).toEqual([])
  expect(tested.shown.logs).toEqual([
    `${userFile} sets memory, and memory values are never saved, so a file cannot set them. Remove it.`,
    `${projectFile} sets memory, and memory values are never saved, so a file cannot set them. Remove it.`,
  ])
})

test("after a /cd the new project's state.json applies", async () => {
  const tested = withFiles({ '/work/b/.claude/cmods/commits/state.json': '{ "project": { "policy": "always" } }' }, { projectRoot: '/work/a' })
  await tested.start()

  await tested.moveTo('/work/b')

  expect(tested.state.project.policy).toBe('always')

  await tested.moveTo('/work/a')

  expect(tested.state.project.policy).toBe('ask')
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

test("mod.settings.read({ source: 'user' }) reads one settings source", async () => {
  let enabled: unknown
  const tested = testMod(
    defineMod({
      name: 'cmod',
      async setup(mod) {
        enabled = (await mod.settings.read({ source: 'user' }))['enabledPlugins']
      },
    }),
  )
  tested.fakes.settings.read = async (args) => (args?.source === 'user' ? { enabledPlugins: { 'demo@market': true } } : {})

  await tested.start()

  expect(enabled).toEqual({ 'demo@market': true })
})

test('a clock.after with no fake answer fires on a real timer', async () => {
  let fired: Promise<void> | undefined
  const tested = testMod(
    defineMod({
      name: 'timer',
      setup(mod) {
        mod.use(({ claude }) => {
          fired = new Promise<void>((resolve) => claude.clock.after(1, resolve))
        })
      },
    }),
  )

  await tested.start()
  await fired

  expect(tested.calls.filter((call) => call.call === 'clock.after').map((call) => call.args[0])).toEqual([1])
})

test('mod.dataFolder is the CMod store folder of the plugin, the one a step gets as CMOD_DATA', async () => {
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

test('a pane Claude Code shows later counts as open, so toggle closes it', async () => {
  let handle: PaneHandle | undefined
  const tested = testModWithEngine(
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
  expect(await tested.lines('diagrams')).toEqual(['Diagram 2', 'Next'])
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

  expect(await tested.lines('diagrams')).toEqual(['Diagram 3', 'Next'])
  expect(paneOpens(tested)).toEqual([{ id: 'diagrams', title: 'Diagrams', columns: 120 }])
})

test('a closed pane does not open when its state changes', async () => {
  const tested = testMod(diagrams)
  await tested.type('/diagrams')
  await tested.type('/diagrams')

  tested.state.session.shown = 1
  await Promise.resolve()

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

function relayTo(provider: ReturnType<typeof testModWithEngine>): Claude['cmod']['call'] {
  return async (call) => {
    const answer = await provider.fire('cmod.call', call, { value: { missing: call.to } })
    if (answer.deny !== undefined) throw new Error(answer.deny)
    return answer.value
  }
}

test("a mod calls another mod's api and gets its result", async () => {
  const provider = testModWithEngine(tracer)
  provider.fakes.fs.read = async () => 'export function parse(text: string) {}\nconst cache = new Map()\nexport function render() {}\n'
  const consumer = testMod(outline)
  consumer.fakes.cmod.call = relayTo(provider)

  expect(await consumer.type('/outline src/a.ts')).toEqual({ text: 'parse:1 render:3' })
  expect(provider.calls).toContainEqual({ call: 'fs.read', args: ['src/a.ts'] })
})

test('a call to a mod that is not installed fails with the install command', async () => {
  const consumer = testMod(outline)
  consumer.fakes.cmod.call = relayTo(testModWithEngine(defineMod({ name: 'file-tree', setup() {} })))

  expect(await consumer.type('/outline src/a.ts')).toEqual({ text: '/outline failed: tracer is not installed. Run cmod install tracer.' })
})

test('an unknown method fails naming it', async () => {
  const provider = testModWithEngine(tracer)
  const below = { value: { missing: 'tracer' } }

  expect(await provider.fire('cmod.call', { to: 'tracer', method: 'callers', input: { name: 'parse' } }, below)).toEqual({ deny: 'tracer has no method callers.' })
  expect(await provider.fire('cmod.call', { to: 'tracer', method: 'constructor', input: {} }, below)).toEqual({ deny: 'tracer has no method constructor.' })
})

test("a provider method that throws reaches the caller with the provider's name", async () => {
  const provider = testModWithEngine(tracer)
  provider.fakes.fs.read = async (path) => {
    throw new Error(`ENOENT: no such file ${path}`)
  }
  const consumer = testMod(outline)
  consumer.fakes.cmod.call = relayTo(provider)

  expect(await consumer.type('/outline src/gone.ts')).toEqual({ text: '/outline failed: tracer: ENOENT: no such file src/gone.ts' })
})

test('a mod passes on a call addressed to another mod', async () => {
  const provider = testModWithEngine(tracer)
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
  expect(tested.shown.logs).toContain('outline: the UserPromptSubmit hook failed: mod.dependencies.tracer.signatures passed the 30 s deadline of tool')
  expect(deadlines).toEqual([30000, 30000])
})

test("a dependency's method takes the input and returns the result its contract declares", () => {
  type Signatures = Mod['dependencies']['tracer']['signatures']

  expectTypeOf<Parameters<Signatures>>().toEqualTypeOf<[input: { path: string }]>()
  expectTypeOf<Awaited<ReturnType<Signatures>>>().toEqualTypeOf<TracerSignature[]>()
})
