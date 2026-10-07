import { expect, test } from 'bun:test'
import type { ProcessRunResult } from 'claude-code'
import type { Fakes, TestCall } from '@cmodjs/core/testing.js'
import { permissions } from '../src/jobs/permissions.js'
import { slashCommand } from '../src/jobs/slash-command.js'
import { statusLine } from '../src/jobs/status-line.js'
import { tool } from '../src/jobs/tool.js'
import { defineMod, type Mod } from '../src/mod.js'
import type { Claude } from '../src/runtime/claude.js'
import { testMod, type TestOptions } from '../src/testing.js'
import { definePane } from '../src/ui/define-pane.js'
import { Box, Button, Image, Input, Markdown, Select, Text } from '../src/ui/elements.js'
import { markdownSlots } from '../src/ui/markdown.js'
import { slots } from '../src/ui/slots.js'

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
      setup(mod) {
        mod.on('PostToolUse', (input) => void seen.push(input.tool_use_id))
      },
    }),
  )

  await tested.fire('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/work/a.ts' }, tool_response: {} })
  await tested.fire('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/work/b.ts' }, tool_response: {} })

  expect(seen).toEqual(['toolu_1', 'toolu_2'])
})

test('a Read of a file the test gave contents to lists it in files.read', async () => {
  const seen: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'reads',
      setup(mod) {
        mod.on('PostToolUse', (input) => void seen.push(input.files))
      },
    }),
    { files: { '/work/notes.md': '' } },
  )

  await tested.fire('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/work/notes.md' }, tool_response: {} })
  await tested.fire('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/work' }, tool_response: {} })
  await tested.fire('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/work/gone.md' }, tool_response: {} })

  expect(seen).toEqual([
    { read: ['/work/notes.md'], changed: [] },
    { read: [], changed: [] },
    { read: [], changed: [] },
  ])
})

test('type runs a slash command and returns its reply', async () => {
  const tested = testMod(
    defineMod({
      name: 'file-tree',
      setup(mod) {
        mod.use(slashCommand({ name: 'tree', description: 'Show the tree', reply: ({ positionals }) => ({ text: `Showing ${positionals.join(' and ')}`, context: 'The user opened the tree.' }) }))
      },
    }),
  )

  expect(await tested.type('/tree src docs')).toEqual({ text: 'Showing src and docs', context: 'The user opened the tree.' })
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

test('testMod answers a call to a mod it does not fake with the install command', async () => {
  const outline = defineMod({
    name: 'outline',
    setup(mod) {
      mod.use(slashCommand({ name: 'outline', description: 'List the functions a file exports', reply: async ({ args }, mod) => (await mod.dependencies.tracer.signatures({ path: args })).length.toString() }))
    },
  })

  expect(await testMod(outline).type('/outline src/a.ts')).toEqual({ text: '/outline failed: tracer is not installed. Run cmod install tracer.' })
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

  expect(await domainGuard({ projectRoot: project, scope: 'project' }).fire('tool.check', editInWorktree, allowed)).toEqual({ decision: 'deny', reason: 'Edit Domain.md with the Architect.' })
  expect(await domainGuard({ projectRoot: project }).fire('tool.check', editInWorktree, allowed)).toEqual(allowed)
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
  state: { global: { notes: ['Buy milk', 'Call the plumber about the sink'] } } as NotesState,
  setup(mod) {
    const pane = mod.ui.pane(notesPane)
    mod.use(slashCommand({ name: 'notes', description: 'Show or hide the notes', reply: () => pane.toggle() }))
  },
})

test('lines reads a pane as rows of text', async () => {
  const tested = testMod(notes)
  await tested.type('/notes')

  expect(await tested.lines('notes')).toEqual(['Notes  2 saved', '', '  Buy milk', '  Call the plumber about', '  the sink', '', 'Clear'])
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

test('tested.lines draws a slot render with Default', async () => {
  const tested = testMod(
    defineMod({
      name: 'hints',
      setup(mod) {
        mod.ui.render(slots.PromptHint, ({ hint, Default }) => Box({ flexDirection: 'column', children: [Default({ hint: hint.toUpperCase() }), Text({ dimColor: true, children: 'from hints' })] }))
      },
    }),
  )

  expect(await tested.lines(slots.PromptHint, { isDraft: false, isWorking: false, hint: '? for shortcuts' })).toEqual([
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
        reply: async ({ args }, mod) => {
          await mod.fs.write('/work/journal.md', `${await mod.fs.read('/work/journal.md')}${args}\n`)
          return mod.fs.read('/work/journal.md')
        },
      }),
    )
    mod.use(slashCommand({ name: 'ls', description: 'List a folder', reply: async ({ args }, mod) => (await mod.fs.list(args)).map(({ name, kind }) => `${name} ${kind}`).join(', ') }))
  },
})

test("a read after testMod's fake write sees the new text", async () => {
  const tested = testMod(journal, { files: { '/work/journal.md': 'buy milk\n' } })

  await tested.type('/jot call mum')

  expect(await tested.type('/jot fix the sink')).toEqual({ text: 'buy milk\ncall mum\nfix the sink\n' })
})

test('fs.list in testMod lists the files given', async () => {
  const tested = testMod(journal, { files: { '/work/journal.md': '', '/work/src/a.ts': 'a', '/work/src/lib/b.ts': 'b' } })

  expect(await tested.type('/ls /work')).toEqual({ text: 'journal.md file, src dir' })
  expect(await tested.type('/ls /work/src')).toEqual({ text: 'a.ts file, lib dir' })
})

const headings = defineMod({
  name: 'headings',
  setup(mod) {
    mod.ui.render(markdownSlots.Heading, ({ text }) => Text({ bold: true, children: text.toUpperCase() }))
  },
})

test('a second AssistantMessage drawn in one test is its own reply', async () => {
  const tested = testMod(headings)
  const reply = { text: '# Plan\n\nWe read.\n\n## Steps', isFirstOfReply: true }

  await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe', isFirstOfReply: true })

  expect(await tested.lines(slots.AssistantMessage, reply)).toEqual(await testMod(headings).lines(slots.AssistantMessage, reply))
})

test('AssistantMessage draws that pass one requestId grow one streamed reply', async () => {
  const tested = testMod(headings)

  await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe', isFirstOfReply: true }, 'msg_1')

  expect(await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe read.\n\n## Steps', isFirstOfReply: true }, 'msg_1')).toEqual([
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
    setup(mod) {
      mod.use(statusLine({ text: () => branch, interval: 1 }))
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
  const root = (await mod.process.run(['git', 'rev-parse', '--show-toplevel'])).stdout.trim()
  const status = await mod.process.run(['git', 'status', '--porcelain'], { cwd: root })
  mod.ui.toast(`${root}: ${status.stdout.trim()}`)
}

const gitAnswer = (argv: readonly string[]): ProcessRunResult => ({ exitCode: 0, stdout: argv[1] === 'rev-parse' ? '/work/shop\n' : ' M README.md\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

test("settle runs a handler's unawaited work that chains two macrotasks", async () => {
  let clock: Claude['clock'] | undefined
  const tested = testMod(
    defineMod({
      name: 'git-letters',
      setup(mod) {
        clock = mod.use(({ claude }) => claude.clock)
        mod.on('Stop', () => void showGitLetters(mod))
      },
    }),
  )
  tested.fakes.process.run = (argv) => new Promise((resolve) => clock?.after(0, () => resolve(gitAnswer(argv))))

  await tested.fire('Stop', { stop_hook_active: false })
  await tested.settle()

  expect(tested.shown.toasts).toContain('/work/shop: M README.md')
})

test('settle returns while a fake is held open by the test', async () => {
  const answers: (() => void)[] = []
  const tested = testMod(defineMod({ name: 'git-letters', setup: (mod) => mod.on('Stop', () => void showGitLetters(mod)) }))
  tested.fakes.process.run = (argv) => new Promise((resolve) => answers.push(() => resolve(gitAnswer(argv))))

  await tested.fire('Stop', { stop_hook_active: false })
  await tested.settle()

  expect(answers).toHaveLength(1)
  expect(tested.shown.toasts).not.toContain('/work/shop: M README.md')
})

function folderWatchIn(projectRoot: string) {
  const seen: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'folder-watch',
      setup(mod) {
        mod.on('CwdChanged', (input) => void seen.push({ old: input.old_cwd, new: input.new_cwd, cwd: mod.cwd, projectRoot: mod.projectRoot }))
      },
    }),
    { projectRoot },
  )
  return { tested, seen }
}

test('moveTo with only a new cwd fires CwdChanged with mod.cwd already moved', async () => {
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

  await tested.fire('UserPromptSubmit', { prompt: 'hello' })

  expect(seen).toEqual([moved])
})

test('after moveTo another project, Claude Code reports the new root at once and the old cwd until the next prompt', async () => {
  let session: Claude['session'] | undefined
  const tested = testMod(defineMod({ name: 'session-reader', setup: (mod) => mod.use((context) => void (session = context.claude.session)) }), { projectRoot: '/work/a' })
  const reported = async () => [await session?.root(), await session?.cwd()]

  await tested.moveTo('/work/b')

  expect(await reported()).toEqual(['/work/b', '/work/a'])

  await tested.fire('UserPromptSubmit', { prompt: 'hello' })

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
        mod.use(slashCommand({ name: 'branch', description: 'Name the branch', reply: async (_input, mod) => (await mod.process.run(['git', 'branch', '--show-current'])).stdout.trim() }))
      },
    }),
  )
  onMain(tested.fakes)

  expect(await tested.type('/branch')).toEqual({ text: 'main' })
  expectBranchAsked(tested.calls)
})
