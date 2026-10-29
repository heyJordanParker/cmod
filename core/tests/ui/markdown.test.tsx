import { expect, spyOn, test } from 'bun:test'
import type { Args, Frozen, RenderElement } from 'claude-code'
import { BelowPrompt, defineMod, Reply, type ModDefinition, type StyleProps } from '../../src/mod.js'
import { createLifecycle } from '../../src/runtime/lifecycle.js'
import { partMethods } from '../../src/runtime/ui.js'
import { testMod } from '../../src/testing.js'
import { calledAnswer, fakeClaude } from '../../src/testing/fake-claude.js'
import { checkKeys, elements, findElement, textOf } from '../../src/testing/fake-elements.js'
import * as vendorMarkdown from '../../src/vendor-markdown.js'
import { Box, Button, Input, Markdown, Text } from '../../src/ui/elements.js'
import { BlockQuote, CodeBlock, Heading, HtmlBlock, List, markdownBlocks, Paragraph, Table, ThematicBreak } from '../../src/ui/markdown.js'

const markdownPlaces = { Heading, Paragraph, CodeBlock, BlockQuote, List, Table, ThematicBreak, HtmlBlock } as const

declare const Bun: { spawnSync(argv: readonly string[]): { readonly stdout: { toString(): string }; readonly stderr: { toString(): string } } }
declare const process: { readonly execPath: string }
declare global {
  interface ImportMeta {
    readonly dir: string
  }
}

function Shouted({ text }: StyleProps<typeof Heading>): RenderElement {
  return <Text bold>{text.toUpperCase()}</Text>
}

function MermaidBlock({ lang, value, Default }: StyleProps<typeof CodeBlock>): RenderElement {
  return lang === 'mermaid' ? <Text>diagram: {value}</Text> : <Default />
}

const everyBlock = defineMod({
  name: 'blocks',
  setup(mod) {
    for (const [name, place] of Object.entries(markdownPlaces)) mod.styles.add({ kind: place, render: (_mod, { Default, surface, columns, id, ...block }) => <Text>{`${name} ${JSON.stringify(block)}`}</Text> })
  },
})

function prefixesOf(reply: string): string[] {
  return Array.from({ length: reply.length }, (_, index) => reply.slice(0, index + 1))
}

async function streamedAgainstWhole(reply: string) {
  const streamed = testMod(everyBlock)
  const differences: { readonly text: string; readonly streamed: string[]; readonly whole: string[] }[] = []
  for (const text of prefixesOf(reply)) {
    await streamed.lines(Reply, { text, isFirstOfReply: true }, 'msg_1')
    const drawn = await streamed.lines(Reply, { text, isFirstOfReply: true }, 'msg_1')
    const whole = await testMod(everyBlock).lines(Reply, { text, isFirstOfReply: true })
    if (JSON.stringify(drawn) !== JSON.stringify(whole)) differences.push({ text, streamed: drawn, whole })
  }
  return differences
}

test('a markdown place draws its blocks and leaves the rest to Default', async () => {
  const tested = testMod(
    defineMod({
      name: 'headings',
      setup(mod) {
        mod.styles.add({ kind: Heading, render: (_mod, { depth, text, Default }) => (depth === 1 ? <Text bold>{text.toUpperCase()}</Text> : <Default />) })
      },
    }),
  )

  const lines = await tested.lines(Reply, { text: '# Plan\n\nFirst we **read**.\n\n## Steps\n\n- one\n- two', isFirstOfReply: true })

  expect(lines).toEqual([
    '⏺ PLAN',
    '  AssistantMessage',
    '    text: "First we **read**."',
    '    isFirstOfReply: false',
    '  AssistantMessage',
    '    text: "## Steps"',
    '    isFirstOfReply: false',
    '  AssistantMessage',
    '    text: "- one\\n- two"',
    '    isFirstOfReply: false',
  ])
})

test('a reply whose first block a mod draws keeps the bullet', async () => {
  const tested = testMod(
    defineMod({
      name: 'headings',
      setup(mod) {
        mod.styles.add({ kind: Heading, render: (_mod, props) => Shouted(props) })
      },
    }),
  )

  const lines = await tested.lines(Reply, { text: '# Plan\n\nWe read.', isFirstOfReply: true })

  expect(lines).toEqual(['⏺ PLAN', '  AssistantMessage', '    text: "We read."', '    isFirstOfReply: false'])
})

test("a mod's piece after the first has a blank line above it", async () => {
  const tested = testMod(
    defineMod({
      name: 'headings',
      setup(mod) {
        mod.styles.add({ kind: Heading, render: (_mod, props) => Shouted(props) })
      },
    }),
  )

  const lines = await tested.lines(Reply, { text: 'Before\n\n# Plan', isFirstOfReply: true })

  expect(lines).toEqual(['AssistantMessage', '  text: "Before"', '  isFirstOfReply: true', '', '  PLAN'])
})

test("a mod's block opening a later text block of the reply has a blank line above it", async () => {
  const tested = testMod(
    defineMod({
      name: 'headings',
      setup(mod) {
        mod.styles.add({ kind: Heading, render: (_mod, props) => Shouted(props) })
      },
    }),
  )

  const lines = await tested.lines(Reply, { text: '# Plan\n\nWe read.', isFirstOfReply: false })

  expect(lines).toEqual(['', 'PLAN', 'AssistantMessage', '  text: "We read."', '  isFirstOfReply: false'])
})

test('a first block that draws its own row above Default keeps the bullet on the first row', async () => {
  const tested = testMod(
    defineMod({
      name: 'labels',
      setup(mod) {
        mod.styles.add({
          kind: Heading,
          render: (_mod, { Default }) => (
            <Box flexDirection="column">
              <Text>Heading:</Text>
              <Default />
            </Box>
          ),
        })
      },
    }),
  )

  const lines = await tested.lines(Reply, { text: '# Plan\n\nWe read.', isFirstOfReply: true })

  expect(lines).toEqual(['⏺ Heading:', '  AssistantMessage', '    text: "# Plan"', '    isFirstOfReply: false', '  AssistantMessage', '    text: "We read."', '    isFirstOfReply: false'])
})

test('a reply whose first block a mod leaves to Default keeps the bullet Claude Code draws', async () => {
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        mod.styles.add({ kind: CodeBlock, render: (_mod, props) => MermaidBlock(props) })
      },
    }),
  )

  const lines = await tested.lines(Reply, { text: '```ts\nconst a = 1\n```\n\n```mermaid\ngraph TD\n```', isFirstOfReply: true })

  expect(lines).toEqual(['AssistantMessage', '  text: "```ts\\nconst a = 1\\n```"', '  isFirstOfReply: true', '', '  diagram: graph TD'])
})

test('a CodeBlock render draws a custom language and leaves other languages to Default', async () => {
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        mod.styles.add({ kind: CodeBlock, render: (_mod, props) => MermaidBlock(props) })
      },
    }),
  )

  const lines = await tested.lines(Reply, { text: 'Before\n\n```mermaid\ngraph TD\n```\n\n```ts\nconst a = 1\n```', isFirstOfReply: true })

  expect(lines).toEqual(['AssistantMessage', '  text: "Before"', '  isFirstOfReply: true', '', '  diagram: graph TD', '  AssistantMessage', '    text: "```ts\\nconst a = 1\\n```"', '    isFirstOfReply: false'])
})

test('a block still streaming is drawn by Default', async () => {
  const tested = testMod(
    defineMod({
      name: 'headings',
      setup(mod) {
        mod.styles.add({ kind: Heading, render: (_mod, props) => Shouted(props) })
      },
    }),
  )
  await tested.lines(Reply, { text: '# Plan\n\nWe', isFirstOfReply: true }, 'msg_1')

  expect(await tested.lines(Reply, { text: '# Plan\n\nWe read.\n\n## Ste', isFirstOfReply: true }, 'msg_1')).toEqual(['⏺ PLAN', '  AssistantMessage', '    text: "We read.\\n\\n## Ste"', '    isFirstOfReply: false'])
  expect(await tested.lines(Reply, { text: '# Plan\n\nWe read.\n\n## Steps', isFirstOfReply: true }, 'msg_1')).toEqual(['⏺ PLAN', '  AssistantMessage', '    text: "We read.\\n\\n## Steps"', '    isFirstOfReply: false'])
  expect(await tested.lines(Reply, { text: '# Plan\n\nWe read.\n\n## Steps', isFirstOfReply: true }, 'msg_1')).toEqual(['⏺ PLAN', '  AssistantMessage', '    text: "We read."', '    isFirstOfReply: false', '', '  STEPS'])
})

test('a heading stays drawn by its render while the paragraph directly below it streams', async () => {
  const tested = testMod(
    defineMod({
      name: 'headings',
      setup(mod) {
        mod.styles.add({ kind: Heading, render: (_mod, props) => Shouted(props) })
      },
    }),
  )
  await tested.lines(Reply, { text: '# Plan\nWe', isFirstOfReply: true }, 'msg_1')

  expect(await tested.lines(Reply, { text: '# Plan\nWe read', isFirstOfReply: true }, 'msg_1')).toEqual(['⏺ PLAN', '  AssistantMessage', '    text: "We read"', '    isFirstOfReply: false'])
})

test('a streaming reply parses its finished blocks once', async () => {
  const parse = spyOn(vendorMarkdown, 'fromMarkdown')
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        mod.styles.add({ kind: CodeBlock, render: (_mod, props) => MermaidBlock(props) })
      },
    }),
  )

  const reply = '# Plan\n\nWe read.\n\n```mermaid\ngraph TD\n```'

  await tested.lines(Reply, { text: '# Plan\n\nWe', isFirstOfReply: true }, 'msg_1')
  await tested.lines(Reply, { text: '# Plan\n\nWe read.\n\n```mermaid\ngra', isFirstOfReply: true }, 'msg_1')
  await tested.lines(Reply, { text: reply, isFirstOfReply: true }, 'msg_1')
  await tested.lines(Reply, { text: reply, isFirstOfReply: true }, 'msg_1')
  const charactersParsed = parse.mock.calls.reduce((sum, [text]) => sum + text.length, 0)
  parse.mockRestore()

  expect(charactersParsed).toBe(reply.length + 'We'.length + '```mermaid\ngra'.length)
})

test('a list that continues across a blank line while streaming draws as one list', async () => {
  const tested = testMod(
    defineMod({
      name: 'lists',
      setup(mod) {
        mod.styles.add({ kind: List, render: (_mod, { start, text }) => <Text>{`List from ${start}: ${JSON.stringify(text)}`}</Text> })
      },
    }),
  )
  for (const text of prefixesOf('1. a\n\n2. b')) await tested.lines(Reply, { text, isFirstOfReply: true }, 'msg_1')

  expect(await tested.lines(Reply, { text: '1. a\n\n2. b', isFirstOfReply: true }, 'msg_1')).toEqual(['⏺ List from 1: "a\\nb"'])
})

test('a streamed list draws as a whole one when its next item starts after a blank line', async () => {
  expect(await streamedAgainstWhole('1. read\n\n2. write\n\n10. done')).toEqual([])
})

test('a streamed list draws as a whole one when a line directly below joins its last item', async () => {
  expect(await streamedAgainstWhole('- read\n#2 next')).toEqual([])
})

test('a streamed paragraph draws as a whole one when a line directly below joins it', async () => {
  expect(await streamedAgainstWhole('Tag it\n#urgent')).toEqual([])
})

test('a streamed block quote draws as a whole one when a line directly below joins it', async () => {
  expect(await streamedAgainstWhole('> Note\n#urgent')).toEqual([])
})

test('a streamed table draws as a whole one when a line directly below becomes its row', async () => {
  expect(await streamedAgainstWhole('| tag |\n| --- |\n#urgent')).toEqual([])
})

test('a streamed footnote draws as a whole one when a line directly below joins it', async () => {
  expect(await streamedAgainstWhole('[^1]: Source\n#urgent')).toEqual([])
})

test('a streamed link definition draws as a whole one when its title follows on the next line', async () => {
  expect(await streamedAgainstWhole("[docs]: https://example.com\n'Docs'\n\nSee [docs].")).toEqual([])
})

test('a streamed indented code block draws the block after a blank line as a whole parse does', async () => {
  expect(await streamedAgainstWhole('    npm test\n\n- run it')).toEqual([])
})

test('a link definition streamed after a block changes that block as a whole parse does', async () => {
  expect(await streamedAgainstWhole('See [docs].\n\n[docs]: https://example.com "Docs"\n\nFact[^1].\n\n[^1]: Source')).toEqual([])
})

test("a markdown component that throws keeps Claude's drawing of its block", async () => {
  const tested = testMod(
    defineMod({
      name: 'broken',
      setup(mod) {
        mod.styles.add({
          kind: Heading,
          render: () => {
            throw new Error('no font')
          },
        })
      },
    }),
  )

  expect(await tested.lines(Reply, { text: '# Plan\n\nBody', isFirstOfReply: true })).toEqual(['AssistantMessage', '  text: "# Plan"', '  isFirstOfReply: true', '  AssistantMessage', '    text: "Body"', '    isFirstOfReply: false'])
  expect(tested.shown.toasts.find(({ message }) => message === 'Installed')?.description).toContain('Adds the style of Heading.')
  expect(tested.shown.toasts).toContainEqual({ type: 'error', message: 'The Heading style failed', description: 'threw, so Claude Code draws its own: no font' })
})

test("Markdown in a pane applies the mod's block styles", async () => {
  const tested = testMod(
    defineMod({
      name: 'notes',
      async setup(mod) {
        mod.styles.add({ kind: Heading, render: (_mod, { depth, text, Default }) => (depth === 1 ? <Text bold>{text.toUpperCase()}</Text> : <Default />) })
        mod.styles.add({ kind: CodeBlock, render: (_mod, props) => MermaidBlock(props) })
        const pane = mod.panes.add({
          id: 'notes',
          title: 'Notes',
          render: () => (
            <Box flexDirection="column">
              <Markdown text={'# Notes\n\n## Shopping\n\nBuy milk.\n\n```mermaid\ngraph TD\n```'} />
            </Box>
          ),
        })
        await pane.open()
      },
    }),
  )

  await tested.start()
  expect(await tested.shown.pane.lines()).toEqual(['NOTES', '', '## Shopping', '', 'Buy milk.', '', 'diagram: graph TD'])
})

test("a pane's Markdown puts a blank line above a mod's block, as a reply does", async () => {
  const tested = testMod(
    defineMod({
      name: 'notes',
      async setup(mod) {
        mod.styles.add({ kind: Heading, render: (_mod, props) => Shouted(props) })
        await mod.panes.add({ id: 'notes', title: 'Notes', render: () => <Markdown text={'Before\n\n# Plan'} /> }).open()
      },
    }),
  )

  await tested.start()
  expect(await tested.shown.pane.lines()).toEqual(['Before', '', 'PLAN'])
})

const drawHeading = ({ text }: StyleProps<typeof Heading>) => Text({ bold: true, children: text.toUpperCase() })

const drawDiagram = ({ lang, value, Default }: StyleProps<typeof CodeBlock>) => (lang === 'mermaid' ? Text({ children: `diagram: ${value}` }) : Default({}))

const rows = (drawn: RenderElement) => textOf(drawn).split('\n').map((row) => row.trimEnd())

const claude = fakeClaude({ name: 'claude', root: '/test' }).claude

async function drawsLikeClaude(e: Frozen<Args<'ui.render'>>): Promise<RenderElement> {
  const table = claude.ui.resolve(e)
  const { text, isFirstOfReply } = e.props as { readonly text: string; readonly isFirstOfReply: boolean }
  return isFirstOfReply ? table.Box({ children: [table.Box({ minWidth: 2, children: table.Text({ children: '⏺' }) }), table.Text({ children: text })] }) : table.Text({ children: text })
}

test('two mods drawing one reply give the same gaps as one mod', async () => {
  const headings = await started(
    defineMod({
      name: 'headings',
      setup(mod) {
        mod.styles.add({ kind: Heading, render: (_mod, props) => drawHeading(props) })
      },
    }),
  )
  const diagrams = await started(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        mod.styles.add({ kind: CodeBlock, render: (_mod, props) => drawDiagram(props) })
      },
    }),
  )
  const both = await started(
    defineMod({
      name: 'both',
      setup(mod) {
        mod.styles.add({ kind: Heading, render: (_mod, props) => drawHeading(props) })
        mod.styles.add({ kind: CodeBlock, render: (_mod, props) => drawDiagram(props) })
      },
    }),
  )
  const reply = { surface: 'terminal', component: 'AssistantMessage', requestId: 'msg_1', props: { text: '# Plan\n\n```mermaid\ngraph TD\n```\n\nDone.', isFirstOfReply: true } } as Frozen<Args<'ui.render'>>

  const byOne = rows(await both.route('ui.render', reply, drawsLikeClaude))
  const byTwo = rows(await headings.route('ui.render', reply, (e) => diagrams.route('ui.render', e, drawsLikeClaude)))

  expect(byOne).toEqual(['⏺ PLAN', '', '  diagram: graph TD', '  Done.'])
  expect(byTwo).toEqual(byOne)
})

test("a reply drawn by two mods keeps every block under the bullet's text", async () => {
  const headings = await started(defineMod({ name: 'slots-demo', setup: (mod) => void mod.styles.add({ kind: Heading, render: (_mod, props) => drawHeading(props) }) }))
  const diagrams = await started(defineMod({ name: 'architecture-diagrams', setup: (mod) => void mod.styles.add({ kind: CodeBlock, render: (_mod, props) => drawDiagram(props) }) }))
  const reply = { surface: 'terminal', component: 'AssistantMessage', requestId: 'msg_1', props: { text: '## Request flow\n\n```mermaid\ngraph LR\n```\n\nThe flowchart shows a request.', isFirstOfReply: true } } as Frozen<Args<'ui.render'>>

  const diagramsAbove = rows(await diagrams.route('ui.render', reply, (e) => headings.route('ui.render', e, drawsLikeClaude)))
  const headingsAbove = rows(await headings.route('ui.render', reply, (e) => diagrams.route('ui.render', e, drawsLikeClaude)))

  expect(diagramsAbove).toEqual(['⏺ REQUEST FLOW', '', '  diagram: graph LR', '  The flowchart shows a request.'])
  expect(headingsAbove).toEqual(diagramsAbove)
})

test("a pane of one mod draws another mod's markdown style once that mod draws it, and Claude Code's markdown while it does", async () => {
  const diagrams = await started(defineMod({ name: 'diagrams', setup: (mod) => void mod.styles.add({ kind: CodeBlock, render: (_mod, props) => drawDiagram(props) }) }))
  const fake = fakeClaude({ name: 'notes', root: '/test/plugins/notes' })
  fake.fakes.cmod.call = async (call) => calledAnswer('notes', await diagrams.route('cmod.call', { ...call, caller: 'notes' } as never, async () => ({ deny: 'no mod answers it' })))
  const notes = createLifecycle(defineMod({ name: 'notes', setup: (mod) => void mod.panes.add({ id: 'notes', title: 'Notes', render: () => Markdown({ text: '```mermaid\ngraph TD\n```\n\nDone.' }) }) }))
  await notes.start(fake.claude, async () => ({ name: 'notes', root: '/test/plugins/notes', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {} }))
  await fake.settle()
  await notes.route('cmod.call', { to: 'notes', method: partMethods.stylers, input: ['diagrams'], caller: 'cmod' } as never, async () => ({ deny: 'no mod answers it' }))
  const pane = { surface: 'terminal', component: 'Pane', requestId: 'notes', props: { isFocused: false } } as unknown as Frozen<Args<'ui.render'>>

  expect(textOf(await notes.route('ui.render', pane, drawsLikeClaude))).not.toContain('diagram: graph TD')
  await fake.settle()
  expect(textOf(await notes.route('ui.render', pane, drawsLikeClaude))).toContain('diagram: graph TD')
})

test("a pane whose other mod's markdown style fails to draw draws Claude Code's markdown and reports it to the Log", async () => {
  const fake = fakeClaude({ name: 'notes', root: '/test/plugins/notes' })
  const logged: unknown[] = []
  fake.fakes.cmod.call = async (call) => {
    if (call.method === 'cmod:failed') return (logged.push(call.input), { showsToast: false })
    if (call.to === 'diagrams') throw new Error('diagrams: $.cmod.call: diagrams is not running')
    return null
  }
  const notes = createLifecycle(defineMod({ name: 'notes', setup: (mod) => void mod.panes.add({ id: 'notes', title: 'Notes', render: () => Markdown({ text: 'Done.' }) }) }))
  await notes.start(fake.claude, async () => ({ name: 'notes', root: '/test/plugins/notes', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {} }))
  await fake.settle()
  await notes.route('cmod.call', { to: 'notes', method: partMethods.stylers, input: ['diagrams'], caller: 'cmod' } as never, async () => ({ deny: 'no mod answers it' }))
  const pane = { surface: 'terminal', component: 'Pane', requestId: 'notes', props: { isFocused: false } } as unknown as Frozen<Args<'ui.render'>>

  await notes.route('ui.render', pane, drawsLikeClaude)
  await fake.settle()

  expect(textOf(await notes.route('ui.render', pane, drawsLikeClaude))).toBe('Done.')
  expect(logged).toEqual([expect.objectContaining({ mod: 'notes', id: 'draw:diagrams', message: 'The markdown style of diagrams drew nothing', details: expect.stringContaining('diagrams: $.cmod.call: diagrams is not running') })])
})

test('hearing which mods style markdown redraws only a mod with a pane, because the cmod plugin draws every widget and page', async () => {
  const redrawsOf = async (definition: ModDefinition) => {
    const fake = fakeClaude({ name: definition.name, root: `/test/plugins/${definition.name}` })
    const lifecycle = createLifecycle(definition)
    await lifecycle.start(fake.claude, async () => ({ name: definition.name, root: `/test/plugins/${definition.name}`, version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {} }))
    await fake.settle()
    const before = fake.calls.filter(({ call }) => call === 'ui.invalidate').length
    await lifecycle.route('cmod.call', { to: definition.name, method: partMethods.stylers, input: ['diagrams'], caller: 'cmod' } as never, async () => ({ deny: 'no mod answers it' }))
    return fake.calls.filter(({ call }) => call === 'ui.invalidate').length - before
  }

  const withWidget = await redrawsOf(defineMod({ name: 'usage', setup: (mod) => void mod.widgets.add({ id: 'usage', title: 'Usage', areas: [BelowPrompt], render: () => Markdown({ text: 'Usage.' }) }) }))
  const withPane = await redrawsOf(defineMod({ name: 'notes', setup: (mod) => void mod.panes.add({ id: 'notes', title: 'Notes', render: () => Markdown({ text: 'Done.' }) }) }))

  expect([withWidget, withPane]).toEqual([0, 1])
})

test("another mod's markdown drawing stays while this mod's own parts change and the stylers stay the same", async () => {
  const diagrams = await started(defineMod({ name: 'diagrams', setup: (mod) => void mod.styles.add({ kind: CodeBlock, render: (_mod, props) => drawDiagram(props) }) }))
  const fake = fakeClaude({ name: 'notes', root: '/test/plugins/notes' })
  let draws = 0
  fake.fakes.cmod.call = async (call) => {
    if (call.to === 'cmod') return { isHeld: false, stylers: ['diagrams'] }
    if (call.method === partMethods.draw) draws += 1
    return calledAnswer('notes', await diagrams.route('cmod.call', { ...call, caller: 'notes' } as never, async () => ({ deny: 'no mod answers it' })))
  }
  const notes = createLifecycle(defineMod({ name: 'notes', setup: (mod) => void mod.panes.add({ id: 'notes', title: 'Notes', render: () => Markdown({ text: '```mermaid\ngraph TD\n```\n\nDone.' }) }) }))
  await notes.start(fake.claude, async () => ({ name: 'notes', root: '/test/plugins/notes', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {} }))
  await fake.settle()
  await notes.route('cmod.call', { to: 'notes', method: partMethods.stylers, input: ['diagrams'], caller: 'cmod' } as never, async () => ({ deny: 'no mod answers it' }))
  const pane = { surface: 'terminal', component: 'Pane', requestId: 'notes', props: { isFocused: false } } as unknown as Frozen<Args<'ui.render'>>
  await notes.route('ui.render', pane, drawsLikeClaude)
  await fake.settle()

  notes.mod?.sidebar.add({ id: 'later', title: 'Later', render: () => Markdown({ text: 'Later.' }) })
  await fake.settle()

  expect(textOf(await notes.route('ui.render', pane, drawsLikeClaude))).toContain('diagram: graph TD')
  expect(draws).toBe(1)
})

test("a mod's markdown style draws in its own Sidebar page and widget under test, as the cmod plugin draws them", async () => {
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        mod.styles.add({ kind: CodeBlock, render: (_mod, props) => drawDiagram(props) })
        mod.widgets.add({ id: 'last', title: 'Last diagram', areas: [BelowPrompt], render: () => Markdown({ text: '```mermaid\ngraph LR\n```' }) })
        void mod.sidebar.add({ id: 'all', title: 'Diagrams', render: () => Markdown({ text: '```mermaid\ngraph TD\n```' }) }).open()
      },
    }),
  )

  expect(await tested.shown.page.lines()).toEqual(['diagram: graph TD'])
  expect(await tested.lines(BelowPrompt)).toEqual(['diagram: graph LR'])
})

const bulletItems = (source: string) => source.split(/\n(?=- )/).map((item) => item.slice(2))

const bullets = defineMod({
  name: 'bullets',
  setup(mod) {
    mod.styles.add({
      kind: List,
      render: (_mod, { source, Default }) => (
        <Box flexDirection="column">
          {bulletItems(source).map((item) => (
            <Box>
              <Text>• </Text>
              <Default source={item} />
            </Box>
          ))}
        </Box>
      ),
    })
    mod.widgets.add({ id: 'next', title: 'Next', areas: [BelowPrompt], render: () => <Markdown key="list" text={'- you\n- me'} /> })
    void mod.panes.add({ id: 'notes', title: 'Notes', render: () => <Markdown key="list" text={'Intro\n\n- you\n- me'} /> }).open()
    void mod.sidebar.add({ id: 'all', title: 'Bullets', render: () => <Markdown key="list" text={'- you\n- me'} /> }).open()
  },
})

test('a style that draws each list item with Default draws every item through Claude Code in a pane, each with its own key', async () => {
  const tested = testMod(bullets)
  await tested.start()

  expect(await tested.shown.pane.lines()).toEqual(['Intro', '', '• you', '• me'])
})

test('a style that draws each list item with Default draws every item through Claude Code in a Sidebar page and a widget', async () => {
  const tested = testMod(bullets)

  expect(await tested.shown.page.lines()).toEqual(['• you', '• me'])
  expect(await tested.lines(BelowPrompt)).toEqual(['• you', '• me'])
})

test('a style that draws each list item with Default draws every item through Claude Code in a reply', async () => {
  const tested = testMod(bullets)

  expect(await tested.lines(Reply, { text: '- you\n- me', isFirstOfReply: true })).toEqual([
    '⏺ • AssistantMessage',
    '      text: "you"',
    '      isFirstOfReply: false',
    '  • AssistantMessage',
    '      text: "me"',
    '      isFirstOfReply: false',
  ])
})

const docs = 'https://example.com/docs'

const linkList = `- [docs](${docs})\n- later`

const eachItemByDefault = ({ source, Default }: StyleProps<typeof List>) => Box({ flexDirection: 'column', children: bulletItems(source).map((item) => Default({ source: item })) })

const linkSteps = (pressed: string[]) =>
  defineMod({
    name: 'links',
    setup(mod) {
      mod.styles.add({ kind: List, render: (_mod, props) => eachItemByDefault(props) })
      const render = () => <Markdown key="steps" text={linkList} dimColor pressableLinks={[docs]} onLinkPress={({ href }) => void pressed.push(href)} />
      mod.widgets.add({ id: 'next', title: 'Next', areas: [BelowPrompt], render })
      void mod.sidebar.add({ id: 'all', title: 'Links', render }).open()
    },
  })

async function defaultPartsDrawn(draw: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const markdown = spyOn(elements, 'Markdown')
  try {
    await draw()
    return markdown.mock.calls.map(([props]) => props as Record<string, unknown>).filter(({ text }) => text === `[docs](${docs})` || text === 'later')
  } finally {
    markdown.mockRestore()
  }
}

const linkPart = (key: string, text: string) => ({ key, text, dimColor: true, pressableLinks: [docs], onLinkPress: expect.any(Function) })

const pressDocs = async (part: Record<string, unknown> | undefined) => (part?.['onLinkPress'] as ((link: { readonly href: string }) => unknown) | undefined)?.({ href: docs })

test("a Sidebar page's Markdown keeps its dim color and links in each part its style draws through Default", async () => {
  const pressed: string[] = []
  const tested = testMod(linkSteps(pressed))

  const parts = await defaultPartsDrawn(() => tested.shown.page.lines())
  await tested.shown.page.press('steps', docs)

  expect(parts).toEqual([linkPart('links/all:steps', `[docs](${docs})`), linkPart('links/all:steps:1', 'later')])
  expect(pressed).toEqual([docs])
})

test("a widget's Markdown keeps its dim color and links in each part its style draws through Default", async () => {
  const pressed: string[] = []
  const tested = testMod(linkSteps(pressed))

  const parts = await defaultPartsDrawn(() => tested.lines(BelowPrompt))
  await pressDocs(parts[0])
  await tested.settle()

  expect(parts).toEqual([linkPart('links/next:steps', `[docs](${docs})`), linkPart('links/next:steps:1', 'later')])
  expect(pressed).toEqual([docs])
})

test("a pane's Markdown keeps its dim color and links in each part another mod's style draws through Default", async () => {
  const lists = await started(defineMod({ name: 'lists', setup: (mod) => void mod.styles.add({ kind: List, render: (_mod, props) => eachItemByDefault(props) }) }))
  const pressed: string[] = []
  const fake = fakeClaude({ name: 'notes', root: '/test/plugins/notes' })
  fake.fakes.cmod.call = async (call) => calledAnswer('notes', await lists.route('cmod.call', { ...call, caller: 'notes' } as never, async () => ({ deny: 'no mod answers it' })))
  const notes = createLifecycle(defineMod({ name: 'notes', setup: (mod) => void mod.panes.add({ id: 'notes', title: 'Notes', render: () => Markdown({ key: 'steps', text: linkList, dimColor: true, pressableLinks: [docs], onLinkPress: ({ href }) => void pressed.push(href) }) }) }))
  await notes.start(fake.claude, async () => ({ name: 'notes', root: '/test/plugins/notes', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {} }))
  await fake.settle()
  await notes.route('cmod.call', { to: 'notes', method: partMethods.stylers, input: ['lists'], caller: 'cmod' } as never, async () => ({ deny: 'no mod answers it' }))
  const pane = { surface: 'terminal', component: 'Pane', requestId: 'notes', props: { isFocused: false } } as unknown as Frozen<Args<'ui.render'>>
  await notes.route('ui.render', pane, drawsLikeClaude)
  await fake.settle()

  const drawn = await notes.route('ui.render', pane, drawsLikeClaude)
  const parts = ['steps', 'steps:1'].map((key) => findElement(drawn, 'Markdown', key))
  await pressDocs(parts[0])

  expect(parts).toEqual([linkPart('steps', `[docs](${docs})`), linkPart('steps:1', 'later')])
  expect(pressed).toEqual([docs])
})

test("a pane's Markdown keeps its dim color and links in each keyless Markdown its own style draws", async () => {
  const pressed: string[] = []
  const fake = fakeClaude({ name: 'notes', root: '/test/plugins/notes' })
  const notes = createLifecycle(
    defineMod({
      name: 'notes',
      setup(mod) {
        mod.styles.add({ kind: List, render: (_mod, { source }) => Box({ flexDirection: 'column', children: bulletItems(source).map((item) => Markdown({ text: item })) }) })
        mod.panes.add({ id: 'notes', title: 'Notes', render: () => Markdown({ key: 'steps', text: linkList, dimColor: true, pressableLinks: [docs], onLinkPress: ({ href }) => void pressed.push(href) }) })
      },
    }),
  )
  await notes.start(fake.claude, async () => ({ name: 'notes', root: '/test/plugins/notes', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {} }))
  await fake.settle()
  const pane = { surface: 'terminal', component: 'Pane', requestId: 'notes', props: { isFocused: false } } as unknown as Frozen<Args<'ui.render'>>

  const drawn = await notes.route('ui.render', pane, drawsLikeClaude)
  const parts = ['steps', 'steps:1'].map((key) => findElement(drawn, 'Markdown', key))
  await pressDocs(parts[0])

  expect(parts).toEqual([linkPart('steps', `[docs](${docs})`), linkPart('steps:1', 'later')])
  expect(pressed).toEqual([docs])
})

test("a pane's Markdown that its own style and another mod's style both split through Default gives every part its own key", async () => {
  const lists = await started(defineMod({ name: 'lists', setup: (mod) => void mod.styles.add({ kind: List, render: (_mod, props) => eachItemByDefault(props) }) }))
  const fake = fakeClaude({ name: 'notes', root: '/test/plugins/notes' })
  fake.fakes.cmod.call = async (call) => calledAnswer('notes', await lists.route('cmod.call', { ...call, caller: 'notes' } as never, async () => ({ deny: 'no mod answers it' })))
  const notes = createLifecycle(
    defineMod({
      name: 'notes',
      setup(mod) {
        mod.styles.add({ kind: Heading, render: (_mod, props) => drawHeading(props) })
        mod.panes.add({ id: 'notes', title: 'Notes', render: () => Markdown({ key: 'steps', text: `${linkList}\n\n# Next\n\nDone.`, dimColor: true, pressableLinks: [docs], onLinkPress: () => undefined }) })
      },
    }),
  )
  await notes.start(fake.claude, async () => ({ name: 'notes', root: '/test/plugins/notes', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {} }))
  await fake.settle()
  await notes.route('cmod.call', { to: 'notes', method: partMethods.stylers, input: ['lists'], caller: 'cmod' } as never, async () => ({ deny: 'no mod answers it' }))
  const pane = { surface: 'terminal', component: 'Pane', requestId: 'notes', props: { isFocused: false } } as unknown as Frozen<Args<'ui.render'>>
  await notes.route('ui.render', pane, drawsLikeClaude)
  await fake.settle()

  const drawn = await notes.route('ui.render', pane, drawsLikeClaude)
  checkKeys(drawn, 'notes', 'Pane')

  expect(['steps', 'steps:1', 'steps:2'].map((key) => findElement(drawn, 'Markdown', key))).toEqual([linkPart('steps', `[docs](${docs})`), linkPart('steps:1', 'later'), linkPart('steps:2', 'Done.')])
  expect(rows(drawn)).toEqual([`[docs](${docs})`, 'later', '', 'NEXT', '', 'Done.'])
})

const indexKeyed = ({ source }: StyleProps<typeof List>) => (
  <Box flexDirection="column">
    {bulletItems(source).map((item, index) => (
      <Markdown key={`item-text:${index}`} text={item} />
    ))}
  </Box>
)

const ideasDrawing = (render: () => RenderElement) =>
  defineMod({
    name: 'ideas',
    setup(mod) {
      mod.styles.add({ kind: List, render: (_mod, props) => indexKeyed(props) })
      mod.widgets.add({ id: 'next', title: 'Next', areas: [BelowPrompt], render })
      void mod.sidebar.add({ id: 'all', title: 'Ideas', render }).open()
    },
  })

test('two keyed Markdown elements on a page, each holding a list its style keys by index, draw both lists', async () => {
  const tested = testMod(
    ideasDrawing(() => (
      <Box flexDirection="column">
        <Markdown key="first" text={'- Ship it\n- Tell the team'} />
        <Markdown key="second" text="- Rest" />
      </Box>
    )),
  )

  expect(await tested.shown.page.lines()).toEqual(['Ship it', 'Tell the team', 'Rest'])
})

test('two keyed Markdown elements in a widget, each holding a list its style keys by index, draw both lists', async () => {
  const tested = testMod(
    ideasDrawing(() => (
      <Box flexDirection="column">
        <Markdown key="first" text={'- Ship it\n- Tell the team'} />
        <Markdown key="second" text="- Rest" />
      </Box>
    )),
  )

  expect(await tested.lines(BelowPrompt)).toEqual(['Ship it', 'Tell the team', 'Rest'])
})

test('two Markdown elements without a key on a page, each holding a list its style keys by index, draw both lists', async () => {
  const tested = testMod(
    ideasDrawing(() => (
      <Box flexDirection="column">
        <Markdown text={'- Ship it\n- Tell the team'} />
        <Markdown text="- Rest" />
      </Box>
    )),
  )

  expect(await tested.shown.page.lines()).toEqual(['Ship it', 'Tell the team', 'Rest'])
})

const twoLists = '- Ship it\n- Tell the team\n\nThen:\n\n- Rest'

test('one Markdown element on a page holding two lists its style keys by index draws both lists', async () => {
  const tested = testMod(ideasDrawing(() => <Markdown key="idea" text={twoLists} />))

  expect(await tested.shown.page.lines()).toEqual(['Ship it', 'Tell the team', '', 'Then:', '', 'Rest'])
})

test("one Markdown element in the mod's own pane holding two lists its style keys by index draws both lists, beside a keyless one of the same text", async () => {
  const tested = testMod(
    defineMod({
      name: 'ideas',
      setup(mod) {
        mod.styles.add({ kind: List, render: (_mod, props) => indexKeyed(props) })
        void mod.panes
          .add({
            id: 'ideas',
            title: 'Ideas',
            render: () => (
              <Box flexDirection="column">
                <Markdown key="idea" text={twoLists} />
                <Markdown text={twoLists} />
              </Box>
            ),
          })
          .open()
      },
    }),
  )
  await tested.start()

  expect(await tested.shown.pane.lines()).toEqual(['Ship it', 'Tell the team', '', 'Then:', '', 'Rest', 'Ship it', 'Tell the team', '', 'Then:', '', 'Rest'])
})

test('a reply holding two lists its style keys by index draws both lists', async () => {
  const tested = testMod(ideasDrawing(() => <Box />))

  expect(await tested.lines(Reply, { text: twoLists, isFirstOfReply: true })).toEqual(['⏺ Ship it', '  Tell the team', '  AssistantMessage', '    text: "Then:"', '    isFirstOfReply: false', '', '  Rest'])
})

test("the test kit presses and types into a markdown style's elements by the keys the style wrote, in a page, a widget, and the mod's own pane", async () => {
  const done: string[] = []
  const tested = testMod(
    defineMod({
      name: 'ideas',
      setup(mod) {
        mod.styles.add({
          kind: List,
          render: (_mod, { source }) => (
            <Box flexDirection="column">
              {bulletItems(source).map((item, index) => (
                <Box>
                  <Button key={`done:${index}`} label="Done" onPress={() => void done.push(item)} />
                  <Input key={`note:${index}`} onSubmit={(value) => void done.push(`${item}: ${value}`)} />
                </Box>
              ))}
            </Box>
          ),
        })
        const render = () => (
          <Box flexDirection="column">
            <Markdown key="first" text="- Ship it" />
            <Markdown text="- Rest" />
          </Box>
        )
        mod.widgets.add({ id: 'next', title: 'Next', areas: [BelowPrompt], render })
        void mod.panes.add({ id: 'ideas', title: 'Ideas', render }).open()
        void mod.sidebar.add({ id: 'all', title: 'Ideas', render }).open()
      },
    }),
  )
  await tested.start()

  await tested.shown.page.press('done:0')
  await tested.shown.page.input('note:0', 'today')
  await tested.press(BelowPrompt, 'done:0')
  await tested.shown.pane.press('done:0')
  await tested.shown.pane.input('note:0', 'now')

  expect(done).toEqual(['Ship it', 'Ship it: today', 'Ship it', 'Ship it', 'Ship it: now'])
})

test("a pane draws three blocks of another mod's style that keys by index, each Button pressing its own block and each Input keeping its key across draws", async () => {
  const done: string[] = []
  const lists = await started(
    defineMod({
      name: 'lists',
      setup: (mod) =>
        void mod.styles.add({
          kind: List,
          render: (_mod, { source }) =>
            Box({
              flexDirection: 'column',
              children: bulletItems(source).map((item, index) =>
                Box({ children: [Button({ key: `done:${index}`, label: 'Done', onPress: () => void done.push(item) }), Input({ key: `note:${index}`, onSubmit: (value) => void done.push(`${item}: ${value}`) })] }),
              ),
            }),
        }),
    }),
  )
  const fake = fakeClaude({ name: 'notes', root: '/test/plugins/notes' })
  fake.fakes.cmod.call = async (call) => calledAnswer('notes', await lists.route('cmod.call', { ...call, caller: 'notes' } as never, async () => ({ deny: 'no mod answers it' })))
  const notes = createLifecycle(
    defineMod({
      name: 'notes',
      setup: (mod) =>
        void mod.panes.add({
          id: 'notes',
          title: 'Notes',
          render: () => Box({ flexDirection: 'column', children: [Markdown({ text: '- Ship it' }), Markdown({ key: 'later', text: '- Rest' }), Markdown({ text: '- Tell the team' })] }),
        }),
    }),
  )
  await notes.start(fake.claude, async () => ({ name: 'notes', root: '/test/plugins/notes', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {} }))
  await fake.settle()
  await notes.route('cmod.call', { to: 'notes', method: partMethods.stylers, input: ['lists'], caller: 'cmod' } as never, async () => ({ deny: 'no mod answers it' }))
  const pane = { surface: 'terminal', component: 'Pane', requestId: 'notes', props: { isFocused: false } } as unknown as Frozen<Args<'ui.render'>>
  await notes.route('ui.render', pane, drawsLikeClaude)
  await fake.settle()
  const scopes = ['lists/markdown:0:0:', 'lists/markdown:later:0:', 'lists/markdown:1:0:']
  const inputKeys = (drawn: RenderElement) => scopes.map((scope) => findElement(drawn, 'Input', `${scope}note:0`)?.['key'])

  const first = await notes.route('ui.render', pane, drawsLikeClaude)
  const second = await notes.route('ui.render', pane, drawsLikeClaude)
  checkKeys(second, 'notes', 'Pane')
  for (const scope of scopes) {
    const press = findElement(second, 'Button', `${scope}done:0`)?.['onPress'] as () => unknown
    const submit = findElement(second, 'Input', `${scope}note:0`)?.['onSubmit'] as (value: string) => unknown
    await press()
    await submit('later')
  }
  await fake.settle()

  expect(inputKeys(first)).toEqual(['lists/markdown:0:0:note:0', 'lists/markdown:later:0:note:0', 'lists/markdown:1:0:note:0'])
  expect(inputKeys(second)).toEqual(inputKeys(first))
  expect(done).toEqual(['Ship it', 'Ship it: later', 'Rest', 'Rest: later', 'Tell the team', 'Tell the team: later'])
})

test("a mod's markdown style under test draws at the terminal and at the width of each page and widget, as the cmod plugin asks it", async () => {
  const diagram = '```mermaid\ngraph TD\n```'
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        mod.styles.add({ kind: CodeBlock, render: (_mod, { surface, columns }) => <Text>{`${surface} ${columns}`}</Text> })
        mod.widgets.add({ id: 'last', title: 'Last diagram', areas: [BelowPrompt], render: () => Markdown({ text: diagram }) })
        void mod.sidebar.add({ id: 'all', title: 'Diagrams', render: () => Markdown({ text: diagram }) }).open()
      },
    }),
  )

  expect(await tested.shown.page.lines({ columns: 60 })).toEqual(['terminal 60'])
  expect(await tested.shown.page.lines({ columns: 40 })).toEqual(['terminal 40'])
  expect(await tested.lines(BelowPrompt, { columns: 100 })).toEqual(['terminal 100'])
})

test("a reply Claude's text opens keeps a mod's later block under the bullet's text", async () => {
  const headings = await started(defineMod({ name: 'slots-demo', setup: (mod) => void mod.styles.add({ kind: Heading, render: (_mod, props) => drawHeading(props) }) }))
  const reply = { surface: 'terminal', component: 'AssistantMessage', requestId: 'msg_1', props: { text: 'One sentence.\n\n### Done', isFirstOfReply: true } } as Frozen<Args<'ui.render'>>

  expect(rows(await headings.route('ui.render', reply, drawsLikeClaude))).toEqual(['⏺ One sentence.', '', '  DONE'])
})

test('a mod that renders no markdown place never loads vendor-markdown', () => {
  const plain = loadsVendorMarkdown("mod.styles.add({ kind: ToolCall, render: () => Text({ children: 'row' }) })", 'ToolCall', "{ tool_use_id: 'toolu_1', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false }")
  const markdown = loadsVendorMarkdown("mod.styles.add({ kind: Heading, render: () => Text({ children: 'heading' }) })", 'Reply', "{ text: '# Plan', isFirstOfReply: true }")

  expect(plain).toBe('false')
  expect(markdown).toBe('true')
})

test('markdownBlocks returns the code blocks of a reply with their props', () => {
  const reply = '# Plan\n\n```mermaid\ngraph TD\n```\n\nThen:\n\n```ts\nconst a = 1\n```'

  expect(markdownBlocks(reply, CodeBlock)).toEqual([
    { text: 'graph TD', source: '```mermaid\ngraph TD\n```', lang: 'mermaid', meta: undefined, value: 'graph TD' },
    { text: 'const a = 1', source: '```ts\nconst a = 1\n```', lang: 'ts', meta: undefined, value: 'const a = 1' },
  ])
})

test('a markdownBlocks block takes the props its place carries', () => {
  const [diagram] = markdownBlocks('```mermaid\ngraph TD\n```', CodeBlock)

  expect(diagram?.lang).toBe('mermaid')
  // @ts-expect-error
  expect(diagram?.depth).toBeUndefined()
})

test('a markdown place component takes the props its block carries', () => {
  defineMod({
    name: 'typed',
    setup(mod) {
      mod.styles.add({ kind: Heading, render: (_mod, { depth, text, Default }) => (depth === 1 ? <Text>{text}</Text> : <Default />) })
      // @ts-expect-error
      mod.styles.add({ kind: Heading, render: (_mod, { lang }) => <Text>{lang}</Text> })
    },
  })
})

async function started(definition: ModDefinition) {
  const root = `/test/plugins/${definition.name}`
  const lifecycle = createLifecycle(definition)
  await lifecycle.start(fakeClaude({ name: definition.name, root }).claude, async () => ({ name: definition.name, root, version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {} }))
  return lifecycle
}

function loadsVendorMarkdown(render: string, place: string, props: string): string {
  const src = `${import.meta.dir}/../../src/`
  const script = `
    const { defineMod, Reply, ToolCall } = await import('${src}mod.ts')
    const { Heading } = ${render.includes('Heading') ? `await import('${src}ui/markdown.ts')` : '{}'}
    const { testMod } = await import('${src}testing.ts')
    const { Text } = await import('${src}ui/elements.ts')
    await import('${src}register.ts')
    const tested = testMod(defineMod({ name: 'probe', setup(mod) { ${render} } }))
    await tested.lines(${place}, ${props})
    console.log(Object.keys(require.cache).some((path) => path.endsWith('vendor-markdown.ts')))
  `
  const run = Bun.spawnSync([process.execPath, '-e', script])
  return `${run.stdout.toString().trim()}${run.stderr.toString().trim()}`
}
