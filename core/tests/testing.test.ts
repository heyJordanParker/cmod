import { expect, test } from 'bun:test'
import type { ProcessRunResult } from 'claude-code'
import type { Fakes, TestCall } from '@cmodjs/core/testing.js'
import { permissions } from '../src/jobs/permissions.js'
import { slashCommand } from '../src/jobs/slash-command.js'
import { statusLine } from '../src/jobs/status-line.js'
import { tool } from '../src/jobs/tool.js'
import { defineMod, fs, process, Prompt, PromptHint, Reply, sessions, type Mod } from '../src/mod.js'
import type { Claude } from '../src/runtime/claude.js'
import { engineOf } from '../src/runtime/engine.js'
import { testMod, type TestOptions } from '../src/testing.js'
import { claudeCodeOf } from '../src/testing/claude-code.js'
import { definePane } from '../src/ui/define-pane.js'
import { Box, Button, Image, Input, Markdown, Select, Text } from '../src/ui/elements.js'
import { Heading } from '../src/ui/markdown.js'

const tickets = defineMod({
  name: 'tickets',
  state: { project: { isFrozen: false, opened: [] as readonly string[] } },
  setup(mod) {
    mod.use(permissions({ deny: [{ tool: 'mcp__tickets__open_ticket', when: (_call, mod) => mod.state.project.isFrozen, reason: 'Tickets are frozen until the release ships.' }] }))
    mod.use(
      tool({
        name: 'open_ticket',
        description: 'Open a ticket',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        execute: (input, mod) => {
          mod.state.project.opened = [...mod.state.project.opened, input.title]
          return `Opened "${input.title}"`
        },
      }),
    )
  },
})

test("callTool runs the mod's permission rules before its tool", async () => {
  const tested = testMod(tickets, { state: { project: { isFrozen: true } } })

  expect(await tested.callTool('open_ticket', { title: 'Crash on save' })).toEqual({ deny: 'Tickets are frozen until the release ships.' })
  expect(tested.state.project.opened).toEqual([])
})

test("callTool returns the tool's result", async () => {
  const tested = testMod(tickets)

  expect(await tested.callTool('open_ticket', { title: 'Crash on save' })).toEqual({ result: 'Opened "Crash on save"' })
  expect(tested.state.project.opened).toEqual(['Crash on save'])
  await expect(tested.callTool('close_ticket', { title: 'Crash on save' })).rejects.toThrow("tickets has no tool close_ticket. Add it in setup with mod.use(tool({ name: 'close_ticket', … })).")
})

test('fire fills the tool_use_id Claude Code gives each tool call', async () => {
  const seen: string[] = []
  const tested = testMod(
    defineMod({
      name: 'reads',
      setup() {
        sessions.current.beforeToolResult((result) => void seen.push(result.callId))
      },
    }),
  )

  await claudeCodeOf(tested).fire('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/work/a.ts' }, tool_response: {} })
  await claudeCodeOf(tested).fire('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/work/b.ts' }, tool_response: {} })

  expect(seen).toEqual(['toolu_1', 'toolu_2'])
})

test('a Read of a file the test gave contents to lists it in files.read', async () => {
  const seen: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'reads',
      setup() {
        sessions.current.beforeToolResult((result) => void seen.push(result.files))
      },
    }),
    { files: { '/work/notes.md': '' } },
  )

  await claudeCodeOf(tested).fire('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/work/notes.md' }, tool_response: {} })
  await claudeCodeOf(tested).fire('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/work' }, tool_response: {} })
  await claudeCodeOf(tested).fire('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/work/gone.md' }, tool_response: {} })

  expect(seen).toEqual([
    { read: ['/work/notes.md'], changed: [] },
    { read: [], changed: [] },
    { read: [], changed: [] },
  ])
})

test("startSession starts a new session that has its own session values, and a resume brings the old session's back", async () => {
  const sources: string[] = []
  const tested = testMod(
    defineMod({
      name: 'counter',
      state: { session: { prompts: 0 } },
      setup(mod) {
        sessions.current.onPrompt(() => void (mod.state.session.prompts += 1))
        sessions.current.onSessionStart(({ source }) => void sources.push(source))
      },
    }),
  )
  await tested.add({ type: Prompt, text: 'one' })

  await tested.startSession({ source: 'clear', id: 'cleared-session' })
  const afterClear = tested.state.session.prompts
  await tested.startSession({ source: 'resume', id: 'test-session' })

  expect([afterClear, tested.state.session.prompts]).toEqual([0, 1])
  expect(sessions.current.id).toBe('test-session')
  expect(sources).toEqual(['clear', 'resume'])
  expect(tested.shown.toasts.filter(({ type }) => type === 'error')).toEqual([])
})

test('type runs a slash command and returns its reply', async () => {
  const tested = testMod(
    defineMod({
      name: 'file-tree',
      setup(mod) {
        mod.use(slashCommand({ name: 'tree', description: 'Show the tree', reply: ({ positionals }) => ({ text: `Showing ${positionals.join(' and ')}`, note: 'The user opened the tree.' }) }))
      },
    }),
  )

  expect(await tested.type('/tree src docs')).toEqual({ text: 'Showing src and docs', note: 'The user opened the tree.' })
  await expect(tested.type('/trees')).rejects.toThrow("file-tree has no slash command /trees. Add it in setup with mod.use(slashCommand({ name: 'trees', … })).")
})

test("testMod dependencies fakes another mod's api", async () => {
  const outline = defineMod({
    name: 'outline',
    setup(mod) {
      mod.use(
        slashCommand({
          name: 'outline',
          description: 'List the functions a file exports',
          reply: async ({ args }, mod) => (await mod.dependencies.tracer.signatures({ path: args })).map(({ name, line }) => `${name}:${line}`).join(' '),
        }),
      )
    },
  })
  const tested = testMod(outline, { dependencies: { tracer: { signatures: async ({ path }) => [{ name: path === 'src/a.ts' ? 'parse' : 'other', line: 1 }] } } })

  expect(await tested.type('/outline src/a.ts')).toEqual({ text: 'parse:1' })
  expect(tested.calls).toContainEqual({ call: 'cmod.call', args: [{ to: 'tracer', method: 'signatures', input: { path: 'src/a.ts' } }] })
})

test('testMod answers a call to a mod it does not fake with where to add it', async () => {
  const outline = defineMod({
    name: 'outline',
    setup(mod) {
      mod.use(slashCommand({ name: 'outline', description: 'List the functions a file exports', reply: async ({ args }, mod) => (await mod.dependencies.tracer.signatures({ path: args })).length.toString() }))
    },
  })

  expect(await testMod(outline).type('/outline src/a.ts')).toEqual({ text: '/outline failed: tracer is not installed. Add it with /plugin.' })
})

const project = '/work/dent'
const files = {
  [`${project}/.git/HEAD`]: 'ref: refs/heads/main\n',
  [`${project}/.git/worktrees/design/commondir`]: '../..\n',
  [`${project}/worktrees/design/.git`]: `gitdir: ${project}/.git/worktrees/design\n`,
  [`${project}/worktrees/design/Domain.md`]: '# Domain\n',
}

function domainGuard(options: TestOptions<Record<never, never>>) {
  return testMod(
    defineMod({
      name: 'dent',
      setup(mod) {
        mod.use(permissions({ deny: [{ write: 'Domain.md', reason: 'Edit Domain.md with the Architect.' }] }))
      },
    }),
    { ...options, files },
  )
}

test('testMod scope project makes the mod a project plugin, and projectRoot alone does not', async () => {
  const editInWorktree = { tool: 'Edit', input: { file_path: `${project}/worktrees/design/Domain.md`, old_string: '#', new_string: '##' }, tool_use_id: 'toolu_1' }
  const allowed = { decision: 'allow' } as const

  expect(await claudeCodeOf(domainGuard({ projectRoot: project, scope: 'project' })).fire('tool.check', editInWorktree, allowed)).toEqual({ decision: 'deny', reason: 'Edit Domain.md with the Architect.' })
  expect(await claudeCodeOf(domainGuard({ projectRoot: project })).fire('tool.check', editInWorktree, allowed)).toEqual(allowed)
})

type NotesState = { global: { notes: readonly string[] } }

const notesPane = definePane<NotesState>({
  id: 'notes',
  title: 'Notes',
  columns: 24,
  render: (mod) =>
    Box({
      flexDirection: 'column',
      gap: 1,
      children: [
        Box({ gap: 2, children: [Text({ bold: true, children: 'Notes' }), Text({ dimColor: true, children: `${mod.state.global.notes.length} saved` })] }),
        Box({ flexDirection: 'column', paddingLeft: 2, children: mod.state.global.notes.map((note) => Text({ children: note })) }),
        Button({
          label: 'Clear',
          onPress: () => {
            mod.state.global.notes = []
          },
        }),
      ],
    }),
})

const notes = defineMod({
  name: 'notes',
  state: { global: { notes: ['Buy milk', 'Call the plumber about the sink'] } },
  setup(mod) {
    const pane = mod.ui.pane(notesPane)
    mod.use(slashCommand({ name: 'notes', description: 'Show or hide the notes', reply: () => pane.toggle() }))
  },
})

test('lines reads a pane as rows of text', async () => {
  const tested = testMod(notes)
  await tested.type('/notes')

  expect(await tested.lines('notes')).toEqual(['Notes  2 saved', '', '  Buy milk', '  Call the plumber about', '  the sink', '', '[ Clear ]'])
})

test("tested.lines shows an Image's alt text", async () => {
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        void mod.ui.pane({ id: 'diagram', title: 'Diagram', render: () => Box({ flexDirection: 'column', children: [Text({ children: 'Login flow' }), Image({ source: { png: '' }, columns: 40, rows: 10, alt: 'A login flow diagram' })] }) }).open()
      },
    }),
  )

  expect(await tested.lines('diagram')).toEqual(['Login flow', 'A login flow diagram'])
})

test("lines draws a pane with the scroll and view Claude Code passes, the main conversation's at the top", async () => {
  const tested = testMod(
    defineMod({
      name: 'scroller',
      setup(mod) {
        void mod.ui.pane({ id: 'rows', title: 'Rows', render: (_mod, { scroll, view }) => Text({ children: `${scroll.offset} of ${scroll.bodyRows} rows, ${view.agentId ?? 'main'}` }) }).open()
      },
    }),
  )

  expect(await tested.lines('rows')).toEqual(['0 of 24 rows, main'])
})

type SearchState = { session: { query: string; draft: string; agent: string; opened: string[]; copiedFrom: string } }

const search = defineMod({
  name: 'history',
  state: { session: { query: '', draft: '', agent: 'all', opened: [] as string[], copiedFrom: '' } },
  setup(mod) {
    void mod.ui
      .pane(
        definePane<SearchState>({
          id: 'history',
          title: 'History',
          render: ({ state: { session } }) =>
            Box({
              flexDirection: 'column',
              children: [
                Input({ key: 'search', placeholder: 'Search', onInput: (draft) => void (session.draft = draft), onSubmit: (query) => void (session.query = query) }),
                Select({ key: 'agent', options: [{ value: 'all' }, { value: 'explorer' }], onSelect: (agent) => void (session.agent = agent) }),
                Markdown({ key: 'messages', text: '[run 42](https://example.com/run/42)', onLinkPress: ({ href }) => void (session.opened = [...session.opened, href]) }),
                Button({ label: 'Copy', onPress: (e) => void (session.copiedFrom = `${e.surface} ${e.component} ${e.requestId}`) }),
                Text({ children: `${session.query} by ${session.agent}` }),
              ],
            }),
        }),
      )
      .open()
  },
})

test('a test types into an Input, picks a Select option, and presses a link, the way the person does', async () => {
  const tested = testMod(search)

  await tested.input('history', 'search', 'dep', 'change')
  await tested.input('history', 'search', 'deploy')
  await tested.select('history', 'agent', 'explorer')
  await tested.press('history', 'messages', 'https://example.com/run/42')
  await tested.press('history', 'Copy')

  expect(tested.state.session).toEqual({ query: 'deploy', draft: 'dep', agent: 'explorer', opened: ['https://example.com/run/42'], copiedFrom: 'terminal Pane history' })
  expect(await tested.lines('history')).toContain('deploy by explorer')
})

test('input, select, and a link press refuse an element the pane does not draw', async () => {
  const tested = testMod(search)

  await expect(tested.input('history', 'filter', 'x')).rejects.toThrow('The pane "history" of history draws no Input with the key "filter".')
  await expect(tested.select('history', 'agent', 'tester')).rejects.toThrow('The Select "agent" in the pane "history" of history has no option "tester". Its options are "all", "explorer".')
  await expect(tested.press('history', 'log', 'https://example.com')).rejects.toThrow('The pane "history" of history draws no Markdown with the key "log".')
})

test('lines refuses a pane that is not open', async () => {
  const tested = testMod(notes)
  const refusal = `The pane "notes" of notes is not open, and a user sees a pane only while it is open. Open it first with tested.type('/notes'), or with pane.open() in the mod.`

  await expect(tested.lines('notes')).rejects.toThrow(refusal)
  await expect(tested.press('notes', 'Clear')).rejects.toThrow(refusal)
  expect(tested.state.global.notes).toEqual(['Buy milk', 'Call the plumber about the sink'])
})

test('tested.lines draws a place render with Default', async () => {
  const tested = testMod(
    defineMod({
      name: 'hints',
      setup(mod) {
        mod.ui.render(PromptHint, ({ hint, Default }) => Box({ flexDirection: 'column', children: [Default({ hint: hint.toUpperCase() }), Text({ dimColor: true, children: 'from hints' })] }))
      },
    }),
  )

  expect(await tested.lines(PromptHint, { isDraft: false, isWorking: false, hint: '? for shortcuts' })).toEqual([
    'PromptHint',
    '  isDraft: false',
    '  isWorking: false',
    '  hint: "? FOR SHORTCUTS"',
    'from hints',
  ])
})

const journal = defineMod({
  name: 'journal',
  setup(mod) {
    mod.use(
      slashCommand({
        name: 'jot',
        description: 'Add a line to the journal',
        reply: async ({ args }) => {
          await fs.write('/work/journal.md', `${await fs.read('/work/journal.md')}${args}\n`)
          return fs.read('/work/journal.md')
        },
      }),
    )
    mod.use(slashCommand({ name: 'ls', description: 'List a folder', reply: async ({ args }) => (await fs.list(args)).map(({ name, isFolder }) => `${name} ${isFolder ? 'folder' : 'file'}`).join(', ') }))
  },
})

test("a read after testMod's fake write sees the new text", async () => {
  const tested = testMod(journal, { files: { '/work/journal.md': 'buy milk\n' }, permissions: ['files:/work/journal.md'] })

  await tested.type('/jot call mum')

  expect(await tested.type('/jot fix the sink')).toEqual({ text: 'buy milk\ncall mum\nfix the sink\n' })
})

test("two tested mods in one test each read their own fake files through the fs import", async () => {
  const seen: string[] = []
  const reader = (name: string) => defineMod({ name, setup: () => void sessions.current.onPrompt(async () => void seen.push(await fs.read('/test/project/x.txt'))) })
  const a = testMod(reader('a'), { files: { '/test/project/x.txt': 'A' }, projectRoot: '/test/project' })
  const b = testMod(reader('b'), { files: { '/test/project/x.txt': 'B' }, projectRoot: '/test/project' })
  await a.start()
  await b.start()

  await a.add({ type: Prompt, text: 'hi' })
  await b.add({ type: Prompt, text: 'hi' })

  expect(seen).toEqual(['A', 'B'])
})

test("a tested mod's timer reads its own fake files while another tested mod runs", async () => {
  const seen: string[] = []
  const first = testMod(defineMod({ name: 'first', setup: (mod) => void mod.after(30, async () => void seen.push(await fs.read('/test/data.txt'))) }), { files: { '/test/data.txt': 'first' } })
  const second = testMod(defineMod({ name: 'second', setup() {} }), { files: { '/test/data.txt': 'second' } })
  const fires: (() => void)[] = []
  first.fakes.clock.after = (_ms, fire) => (fires.push(fire), { cancel: () => undefined })
  await first.start()
  await second.start()

  for (const fire of fires) fire()
  await first.settle()

  expect(seen).toEqual(['first'])
})

test('fs.list in testMod lists the files given', async () => {
  const tested = testMod(journal, { files: { '/work/journal.md': '', '/work/src/a.ts': 'a', '/work/src/lib/b.ts': 'b' } })

  expect(await tested.type('/ls /work')).toEqual({ text: 'journal.md file, src folder' })
  expect(await tested.type('/ls /work/src')).toEqual({ text: 'a.ts file, lib folder' })
})

const headings = defineMod({
  name: 'headings',
  setup(mod) {
    mod.ui.render(Heading, ({ text }) => Text({ bold: true, children: text.toUpperCase() }))
  },
})

test('a second AssistantMessage drawn in one test is its own reply', async () => {
  const tested = testMod(headings)
  const reply = { text: '# Plan\n\nWe read.\n\n## Steps', isFirstOfReply: true }

  await tested.lines(Reply, { text: '# Plan\n\nWe', isFirstOfReply: true })

  expect(await tested.lines(Reply, reply)).toEqual(await testMod(headings).lines(Reply, reply))
})

test('AssistantMessage draws that pass one requestId grow one streamed reply', async () => {
  const tested = testMod(headings)

  await tested.lines(Reply, { text: '# Plan\n\nWe', isFirstOfReply: true }, 'msg_1')

  expect(await tested.lines(Reply, { text: '# Plan\n\nWe read.\n\n## Steps', isFirstOfReply: true }, 'msg_1')).toEqual([
    '⏺ PLAN',
    '  AssistantMessage',
    '    text: "We read.\\n\\n## Steps"',
    '    isFirstOfReply: false',
  ])
})

test('clock.every in testMod fires only when the test ticks it', async () => {
  let branch = 'main'
  const branchLine = defineMod({
    name: 'branch-line',
    state: { memory: { branch: 'main' } },
    setup(mod) {
      mod.every(1, () => void (mod.state.memory.branch = branch))
      mod.use(statusLine({ text: (_usage, mod) => mod.state.memory.branch }))
    },
  })
  const unticked = testMod(branchLine)
  const ticked = testMod(branchLine)
  const intervals: number[] = []
  const ticks: (() => void)[] = []
  ticked.fakes.clock.every = (ms, tick) => {
    intervals.push(ms)
    ticks.push(tick)
    return { cancel: () => undefined }
  }
  await Promise.all([unticked.start(), ticked.start()])

  branch = 'feature'
  await unticked.settle()
  for (const tick of ticks) tick()
  await ticked.settle()

  expect(intervals).toEqual([1])
  expect(unticked.shown.statuses).toEqual(['main'])
  expect(ticked.shown.statuses).toEqual(['main', 'feature'])
})

async function showGitLetters(mod: Mod): Promise<void> {
  const root = (await process.run(['git', 'rev-parse', '--show-toplevel'])).stdout.trim()
  const status = await process.run(['git', 'status', '--porcelain'], { cwd: root })
  mod.ui.toast(`${root}: ${status.stdout.trim()}`)
}

const gitAnswer = (argv: readonly string[]): ProcessRunResult => ({ exitCode: 0, stdout: argv[1] === 'rev-parse' ? '/work/shop\n' : ' M README.md\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

test("settle runs a handler's unawaited work that chains two macrotasks", async () => {
  let clock: Claude['clock'] | undefined
  const tested = testMod(
    defineMod({
      name: 'git-letters',
      setup(mod) {
        clock = engineOf(mod).claude.clock
        sessions.current.onTurnEnd(() => void showGitLetters(mod))
      },
    }),
    { permissions: ['run:git'] },
  )
  tested.fakes.process.run = (argv) => new Promise((resolve) => clock?.after(0, () => resolve(gitAnswer(argv))))

  await tested.add({ type: Prompt, text: 'Commit it' })
  await tested.endTurn()
  await tested.settle()

  expect(tested.shown.toasts).toContainEqual({ type: 'default', message: '/work/shop: M README.md' })
})

test('settle returns while a fake is held open by the test', async () => {
  const answers: (() => void)[] = []
  const tested = testMod(defineMod({ name: 'git-letters', setup: (mod) => sessions.current.onTurnEnd(() => void showGitLetters(mod)) }), { permissions: ['run:git'] })
  tested.fakes.process.run = (argv) => new Promise((resolve) => answers.push(() => resolve(gitAnswer(argv))))

  await tested.add({ type: Prompt, text: 'Commit it' })
  await tested.endTurn()
  await tested.settle()

  expect(answers).toHaveLength(1)
  expect(tested.shown.toasts).not.toContainEqual({ type: 'default', message: '/work/shop: M README.md' })
})

function folderWatchIn(projectRoot: string) {
  const seen: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'folder-watch',
      setup() {
        sessions.current.onCwdChange((change) => void seen.push({ old: change.previous, new: change.cwd, cwd: sessions.current.cwd, projectRoot: sessions.current.project }))
      },
    }),
    { projectRoot },
  )
  return { tested, seen }
}

test('moveTo with only a new cwd fires CwdChanged with the session cwd already moved', async () => {
  const { tested, seen } = folderWatchIn('/work/shop')

  await tested.moveTo('/work/shop', '/work/shop/src')

  expect(seen).toEqual([{ old: '/work/shop', new: '/work/shop/src', cwd: '/work/shop/src', projectRoot: '/work/shop' }])
})

test('moveTo another project and a folder in it fires CwdChanged for the /cd, then for the Bash cd', async () => {
  const { tested, seen } = folderWatchIn('/work/a')

  await tested.moveTo('/work/b', '/work/b/src')

  expect(seen).toEqual([
    { old: '/work/a', new: '/work/b', cwd: '/work/b', projectRoot: '/work/b' },
    { old: '/work/b', new: '/work/b/src', cwd: '/work/b/src', projectRoot: '/work/b' },
  ])
})

test("after /cd while Claude Code still reports the old cwd, the mod's cwd is the new root and CwdChanged fires once", async () => {
  const { tested, seen } = folderWatchIn('/work/a')
  const moved = { old: '/work/a', new: '/work/b', cwd: '/work/b', projectRoot: '/work/b' }

  await tested.moveTo('/work/b')

  expect(seen).toEqual([moved])

  await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'hello' })

  expect(seen).toEqual([moved])
})

test('after moveTo another project, Claude Code reports the new root at once and the old cwd until the next prompt', async () => {
  let session: Claude['session'] | undefined
  const tested = testMod(defineMod({ name: 'session-reader', setup: (mod) => void (session = engineOf(mod).claude.session) }), { projectRoot: '/work/a' })
  const reported = async () => [await session?.root(), await session?.cwd()]

  await tested.moveTo('/work/b')

  expect(await reported()).toEqual(['/work/b', '/work/a'])

  await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'hello' })

  expect(await reported()).toEqual(['/work/b', '/work/b'])
})

test('a test helper names the Fakes and TestCall types that @cmodjs/core/testing.js exports', async () => {
  const onMain = (fakes: Fakes) => {
    fakes.process.run = async () => ({ exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  }
  const expectBranchAsked = (calls: readonly TestCall[]) => {
    expect(calls.filter((call) => call.call === 'process.run').map((call) => call.args[0])).toEqual([['git', 'branch', '--show-current']])
  }
  const tested = testMod(
    defineMod({
      name: 'branch',
      setup(mod) {
        mod.use(slashCommand({ name: 'branch', description: 'Name the branch', reply: async () => (await process.run(['git', 'branch', '--show-current'])).stdout.trim() }))
      },
    }),
    { permissions: ['run:git'] },
  )
  onMain(tested.fakes)

  expect(await tested.type('/branch')).toEqual({ text: 'main' })
  expectBranchAsked(tested.calls)
})

test("fire('cmod.call') answers a method of the mod's api with { value }, as dependencies.md shows", async () => {
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
  const tested = testMod(tracer, { files: { '/work/a.ts': 'export function greet() {}\n' } })

  expect(await tested.fire('cmod.call', { to: 'tracer', method: 'signatures', input: { path: '/work/a.ts' } })).toEqual({ value: [{ name: 'greet', line: 1 }] })
})

test('raise.beforeToolCall asks every beforeToolCall listener with the call and returns the merged answer', async () => {
  const tested = testMod(
    defineMod({
      name: 'guard',
      setup() {
        sessions.current.beforeToolCall({ name: 'Bash' }, (call) => (String(call.input['command']).startsWith('rm ') ? { refuse: 'Move it to the trash instead.' } : undefined))
      },
    }),
    { permissions: ['tools'] },
  )

  expect(await tested.raise.beforeToolCall({ name: 'Bash', input: { command: 'rm -rf build' } })).toEqual({ refuse: 'Move it to the trash instead.' })
  expect(await tested.raise.beforeToolCall({ name: 'Bash', input: { command: 'ls' } })).toBeUndefined()
  expect(await tested.raise.beforeToolCall({ name: 'Read', input: { file_path: '/work/a.ts' } })).toBeUndefined()
})

test('raise.beforePrompt gives the listener a Prompt placed in the open turn, and returns its note', async () => {
  const seen: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'release',
      setup() {
        sessions.current.beforePrompt({ text: /\brelease\b/i }, (prompt) => {
          seen.push({ type: prompt.type, text: prompt.text, from: prompt.from.type })
          return { note: 'Run bun run release.' }
        })
      },
    }),
    { permissions: ['prompt'] },
  )

  expect(await tested.raise.beforePrompt({ text: 'Cut a release' })).toEqual({ note: 'Run bun run release.' })
  expect(await tested.raise.beforePrompt({ text: 'Fix the bug' })).toBeUndefined()
  expect(seen).toEqual([{ type: Prompt, text: 'Cut a release', from: 'person' }])
})

test("raise.onSessionStart runs the mod's listeners with the session and cwd filled in", async () => {
  const seen: unknown[] = []
  const tested = testMod(defineMod({ name: 'greeter', setup: () => void sessions.current.onSessionStart((start) => void seen.push(start)) }), { projectRoot: '/work/shop' })

  await tested.raise.onSessionStart({ source: 'startup' })

  expect(seen).toEqual([{ session: 'test-session', cwd: '/work/shop', source: 'startup' }])
})

test('raise.beforeSessionStart returns the note every listener gives, the last title, and a refusal over both', async () => {
  const tested = testMod(
    defineMod({
      name: 'briefing',
      setup() {
        sessions.current.beforeSessionStart({ source: 'startup' }, () => ({ note: 'The build is red.', title: 'Fix the build' }))
        sessions.current.beforeSessionStart(() => ({ title: 'Morning' }))
      },
    }),
    { permissions: ['prompt'] },
  )

  expect(await tested.raise.beforeSessionStart({ source: 'startup' })).toEqual({ note: 'The build is red.', title: 'Morning' })
  expect(await tested.raise.beforeSessionStart({ source: 'resume' })).toEqual({ title: 'Morning' })
})

test('raise.beforeTurnEnd asks about the open turn, and says how to open one when none is open', async () => {
  const tested = testMod(defineMod({ name: 'reviewer', setup: () => void sessions.current.beforeTurnEnd((turn) => (turn.prompt.text === 'Ship it' ? { refuse: 'Run the tests first.' } : undefined)) }), { permissions: ['prompt'] })

  await expect(tested.raise.beforeTurnEnd()).rejects.toThrow("reviewer has no turn open to end. Open one with tested.add({ type: Prompt, text: '…' }).")
  await tested.add({ type: Prompt, text: 'Ship it' })
  expect(await tested.raise.beforeTurnEnd()).toEqual({ refuse: 'Run the tests first.' })
})
