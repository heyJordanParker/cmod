import { expect, test } from 'bun:test'
import { permissions } from '../src/jobs/permissions.js'
import { slashCommand } from '../src/jobs/slash-command.js'
import { tool } from '../src/jobs/tool.js'
import { defineMod } from '../src/mod.js'
import { testMod } from '../src/testing.js'
import { definePane } from '../src/ui/define-pane.js'
import { Box, Button, Text } from '../src/ui/elements.js'
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
