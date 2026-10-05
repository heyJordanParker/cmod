import { expect, spyOn, test } from 'bun:test'
import type { Args, Frozen, Next, RenderElement } from 'claude-code'
import { defineMod, type ModDefinition } from '../../src/mod.js'
import { createLifecycle } from '../../src/runtime/lifecycle.js'
import { testMod } from '../../src/testing.js'
import * as vendorMarkdown from '../../src/vendor-markdown.js'
import { definePane } from '../../src/ui/define-pane.js'
import { Box, Markdown, Text } from '../../src/ui/elements.js'
import { markdownBlocks, markdownSlots } from '../../src/ui/markdown.js'
import { slots, type SlotProps } from '../../src/ui/slots.js'
import { fakeClaude } from '../../src/utils/fake-claude.js'
import { textOf } from '../../src/utils/fake-elements.js'

declare const Bun: { spawnSync(argv: readonly string[]): { readonly stdout: { toString(): string }; readonly stderr: { toString(): string } } }
declare const process: { readonly execPath: string }
declare global {
  interface ImportMeta {
    readonly dir: string
  }
}

function Shouted({ text }: SlotProps<typeof markdownSlots.Heading>): RenderElement {
  return <Text bold>{text.toUpperCase()}</Text>
}

function MermaidBlock({ lang, value, Default }: SlotProps<typeof markdownSlots.CodeBlock>): RenderElement {
  return lang === 'mermaid' ? <Text>diagram: {value}</Text> : <Default />
}

const everyBlock = defineMod({
  name: 'blocks',
  setup(mod) {
    for (const [name, slot] of Object.entries(markdownSlots)) mod.ui.render(slot, ({ Default, ...block }) => <Text>{`${name} ${JSON.stringify(block)}`}</Text>)
  },
})

function prefixesOf(reply: string): string[] {
  return Array.from({ length: reply.length }, (_, index) => reply.slice(0, index + 1))
}

async function streamedAgainstWhole(reply: string) {
  const streamed = testMod(everyBlock)
  const differences: { readonly text: string; readonly streamed: string[]; readonly whole: string[] }[] = []
  for (const text of prefixesOf(reply)) {
    await streamed.lines(slots.AssistantMessage, { text, isFirstOfReply: true }, 'msg_1')
    const drawn = await streamed.lines(slots.AssistantMessage, { text, isFirstOfReply: true }, 'msg_1')
    const whole = await testMod(everyBlock).lines(slots.AssistantMessage, { text, isFirstOfReply: true })
    if (JSON.stringify(drawn) !== JSON.stringify(whole)) differences.push({ text, streamed: drawn, whole })
  }
  return differences
}

test('a markdown slot draws its blocks and leaves the rest to Default', async () => {
  const tested = testMod(
    defineMod({
      name: 'headings',
      setup(mod) {
        mod.ui.render(markdownSlots.Heading, ({ depth, text, Default }) => (depth === 1 ? <Text bold>{text.toUpperCase()}</Text> : <Default />))
      },
    }),
  )

  const lines = await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nFirst we **read**.\n\n## Steps\n\n- one\n- two', isFirstOfReply: true })

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
        mod.ui.render(markdownSlots.Heading, Shouted)
      },
    }),
  )

  const lines = await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe read.', isFirstOfReply: true })

  expect(lines).toEqual(['⏺ PLAN', '  AssistantMessage', '    text: "We read."', '    isFirstOfReply: false'])
})

test("a mod's piece after the first has a blank line above it", async () => {
  const tested = testMod(
    defineMod({
      name: 'headings',
      setup(mod) {
        mod.ui.render(markdownSlots.Heading, Shouted)
      },
    }),
  )

  const lines = await tested.lines(slots.AssistantMessage, { text: 'Before\n\n# Plan', isFirstOfReply: true })

  expect(lines).toEqual(['AssistantMessage', '  text: "Before"', '  isFirstOfReply: true', '', 'PLAN'])
})

test("a mod's block opening a later text block of the reply has a blank line above it", async () => {
  const tested = testMod(
    defineMod({
      name: 'headings',
      setup(mod) {
        mod.ui.render(markdownSlots.Heading, Shouted)
      },
    }),
  )

  const lines = await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe read.', isFirstOfReply: false })

  expect(lines).toEqual(['', 'PLAN', 'AssistantMessage', '  text: "We read."', '  isFirstOfReply: false'])
})

test('a first block that draws its own row above Default keeps the bullet on the first row', async () => {
  const tested = testMod(
    defineMod({
      name: 'labels',
      setup(mod) {
        mod.ui.render(markdownSlots.Heading, ({ Default }) => (
          <Box flexDirection="column">
            <Text>Heading:</Text>
            <Default />
          </Box>
        ))
      },
    }),
  )

  const lines = await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe read.', isFirstOfReply: true })

  expect(lines).toEqual(['⏺ Heading:', '  AssistantMessage', '    text: "# Plan"', '    isFirstOfReply: false', '  AssistantMessage', '    text: "We read."', '    isFirstOfReply: false'])
})

test('a reply whose first block a mod leaves to Default keeps the bullet Claude Code draws', async () => {
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        mod.ui.render(markdownSlots.CodeBlock, MermaidBlock)
      },
    }),
  )

  const lines = await tested.lines(slots.AssistantMessage, { text: '```ts\nconst a = 1\n```\n\n```mermaid\ngraph TD\n```', isFirstOfReply: true })

  expect(lines).toEqual(['AssistantMessage', '  text: "```ts\\nconst a = 1\\n```"', '  isFirstOfReply: true', '', 'diagram: graph TD'])
})

test('a CodeBlock render draws a custom language and leaves other languages to Default', async () => {
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        mod.ui.render(markdownSlots.CodeBlock, MermaidBlock)
      },
    }),
  )

  const lines = await tested.lines(slots.AssistantMessage, { text: 'Before\n\n```mermaid\ngraph TD\n```\n\n```ts\nconst a = 1\n```', isFirstOfReply: true })

  expect(lines).toEqual(['AssistantMessage', '  text: "Before"', '  isFirstOfReply: true', '', 'diagram: graph TD', 'AssistantMessage', '  text: "```ts\\nconst a = 1\\n```"', '  isFirstOfReply: false'])
})

test('a block still streaming is drawn by Default', async () => {
  const tested = testMod(
    defineMod({
      name: 'headings',
      setup(mod) {
        mod.ui.render(markdownSlots.Heading, Shouted)
      },
    }),
  )
  await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe', isFirstOfReply: true }, 'msg_1')

  expect(await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe read.\n\n## Ste', isFirstOfReply: true }, 'msg_1')).toEqual(['⏺ PLAN', '  AssistantMessage', '    text: "We read.\\n\\n## Ste"', '    isFirstOfReply: false'])
  expect(await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe read.\n\n## Steps', isFirstOfReply: true }, 'msg_1')).toEqual(['⏺ PLAN', '  AssistantMessage', '    text: "We read.\\n\\n## Steps"', '    isFirstOfReply: false'])
  expect(await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe read.\n\n## Steps', isFirstOfReply: true }, 'msg_1')).toEqual(['⏺ PLAN', '  AssistantMessage', '    text: "We read."', '    isFirstOfReply: false', '', '  STEPS'])
})

test('a heading stays drawn by its render while the paragraph directly below it streams', async () => {
  const tested = testMod(
    defineMod({
      name: 'headings',
      setup(mod) {
        mod.ui.render(markdownSlots.Heading, Shouted)
      },
    }),
  )
  await tested.lines(slots.AssistantMessage, { text: '# Plan\nWe', isFirstOfReply: true }, 'msg_1')

  expect(await tested.lines(slots.AssistantMessage, { text: '# Plan\nWe read', isFirstOfReply: true }, 'msg_1')).toEqual(['⏺ PLAN', '  AssistantMessage', '    text: "We read"', '    isFirstOfReply: false'])
})

test('a streaming reply parses its finished blocks once', async () => {
  const parse = spyOn(vendorMarkdown, 'fromMarkdown')
  const tested = testMod(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        mod.ui.render(markdownSlots.CodeBlock, MermaidBlock)
      },
    }),
  )

  const reply = '# Plan\n\nWe read.\n\n```mermaid\ngraph TD\n```'

  await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe', isFirstOfReply: true }, 'msg_1')
  await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe read.\n\n```mermaid\ngra', isFirstOfReply: true }, 'msg_1')
  await tested.lines(slots.AssistantMessage, { text: reply, isFirstOfReply: true }, 'msg_1')
  await tested.lines(slots.AssistantMessage, { text: reply, isFirstOfReply: true }, 'msg_1')
  const charactersParsed = parse.mock.calls.reduce((sum, [text]) => sum + text.length, 0)
  parse.mockRestore()

  expect(charactersParsed).toBe(reply.length + 'We'.length + '```mermaid\ngra'.length)
})

test('a list that continues across a blank line while streaming draws as one list', async () => {
  const tested = testMod(
    defineMod({
      name: 'lists',
      setup(mod) {
        mod.ui.render(markdownSlots.List, ({ start, text }) => <Text>{`List from ${start}: ${JSON.stringify(text)}`}</Text>)
      },
    }),
  )
  for (const text of prefixesOf('1. a\n\n2. b')) await tested.lines(slots.AssistantMessage, { text, isFirstOfReply: true }, 'msg_1')

  expect(await tested.lines(slots.AssistantMessage, { text: '1. a\n\n2. b', isFirstOfReply: true }, 'msg_1')).toEqual(['⏺ List from 1: "a\\nb"'])
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
        mod.ui.render(markdownSlots.Heading, () => {
          throw new Error('no font')
        })
      },
    }),
  )

  expect(await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nBody', isFirstOfReply: true })).toEqual(['AssistantMessage', '  text: "# Plan"', '  isFirstOfReply: true', 'AssistantMessage', '  text: "Body"', '  isFirstOfReply: false'])
  expect(tested.shown.logs).toEqual(['broken added a render of markdown Heading.', 'broken: the markdown Heading render threw, so Claude Code draws its own: no font'])
})

test('Markdown in a pane applies the mod\'s markdown slots', async () => {
  const tested = testMod(
    defineMod({
      name: 'notes',
      async setup(mod) {
        mod.ui.render(markdownSlots.Heading, ({ depth, text, Default }) => (depth === 1 ? <Text bold>{text.toUpperCase()}</Text> : <Default />))
        mod.ui.render(markdownSlots.CodeBlock, MermaidBlock)
        const pane = mod.ui.pane(
          definePane({
            id: 'notes',
            title: 'Notes',
            render: () => (
              <Box flexDirection="column">
                <Markdown text={'# Notes\n\n## Shopping\n\nBuy milk.\n\n```mermaid\ngraph TD\n```'} />
              </Box>
            ),
          }),
        )
        await pane.open()
      },
    }),
  )

  expect(await tested.lines('notes')).toEqual(['NOTES', '', '## Shopping', '', 'Buy milk.', '', 'diagram: graph TD'])
})

test("a pane's Markdown puts a blank line above a mod's block, as a reply does", async () => {
  const tested = testMod(
    defineMod({
      name: 'notes',
      async setup(mod) {
        mod.ui.render(markdownSlots.Heading, Shouted)
        await mod.ui.pane(definePane({ id: 'notes', title: 'Notes', render: () => <Markdown text={'Before\n\n# Plan'} /> })).open()
      },
    }),
  )

  expect(await tested.lines('notes')).toEqual(['Before', '', 'PLAN'])
})

test('two mods drawing one reply give the same gaps as one mod', async () => {
  const drawHeading = ({ text }: SlotProps<typeof markdownSlots.Heading>) => Text({ bold: true, children: text.toUpperCase() })
  const drawDiagram = ({ lang, value, Default }: SlotProps<typeof markdownSlots.CodeBlock>) => (lang === 'mermaid' ? Text({ children: `diagram: ${value}` }) : Default({}))
  const headings = await started(
    defineMod({
      name: 'headings',
      setup(mod) {
        mod.ui.render(markdownSlots.Heading, drawHeading)
      },
    }),
  )
  const diagrams = await started(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        mod.ui.render(markdownSlots.CodeBlock, drawDiagram)
      },
    }),
  )
  const both = await started(
    defineMod({
      name: 'both',
      setup(mod) {
        mod.ui.render(markdownSlots.Heading, drawHeading)
        mod.ui.render(markdownSlots.CodeBlock, drawDiagram)
      },
    }),
  )
  const claude = fakeClaude({ name: 'claude', root: '/test' }).claude
  const claudeDraws = nextOf((e) => claude.ui.resolve(e).Text({ children: `claude: ${(e.props as { text: string }).text}` }))
  const reply = { surface: 'terminal', component: 'AssistantMessage', requestId: 'msg_1', props: { text: '# Plan\n\n```mermaid\ngraph TD\n```\n\nDone.', isFirstOfReply: true } } as Frozen<Args<'ui.render'>>

  const rows = (drawn: RenderElement) => textOf(drawn).split('\n').map((row) => row.trimEnd())

  const byOne = rows(await both.route('ui.render', reply, claudeDraws))
  const byTwo = rows(await headings.route('ui.render', reply, nextOf((e) => diagrams.route('ui.render', e, claudeDraws))))

  expect(byOne).toEqual(['⏺ PLAN', '', '  diagram: graph TD', '  claude: Done.'])
  expect(byTwo).toEqual(byOne)
})

test('a mod that renders no markdown slot never loads vendor-markdown', () => {
  const plain = loadsVendorMarkdown("mod.ui.render(slots.ToolUse, () => Text({ children: 'row' }))", 'slots.ToolUse', "{ tool_use_id: 'toolu_1', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false }")
  const markdown = loadsVendorMarkdown("mod.ui.render(markdownSlots.Heading, () => Text({ children: 'heading' }))", 'slots.AssistantMessage', "{ text: '# Plan', isFirstOfReply: true }")

  expect(plain).toBe('false')
  expect(markdown).toBe('true')
})

test('markdownBlocks returns the code blocks of a reply with their props', () => {
  const reply = '# Plan\n\n```mermaid\ngraph TD\n```\n\nThen:\n\n```ts\nconst a = 1\n```'

  expect(markdownBlocks(reply, markdownSlots.CodeBlock)).toEqual([
    { text: 'graph TD', source: '```mermaid\ngraph TD\n```', lang: 'mermaid', meta: undefined, value: 'graph TD' },
    { text: 'const a = 1', source: '```ts\nconst a = 1\n```', lang: 'ts', meta: undefined, value: 'const a = 1' },
  ])
})

test('a markdownBlocks block takes the props its slot carries', () => {
  const [diagram] = markdownBlocks('```mermaid\ngraph TD\n```', markdownSlots.CodeBlock)

  expect(diagram?.lang).toBe('mermaid')
  // @ts-expect-error
  expect(diagram?.depth).toBeUndefined()
})

test('a markdown slot component takes the props its block carries', () => {
  defineMod({
    name: 'typed',
    setup(mod) {
      mod.ui.render(markdownSlots.Heading, ({ depth, text, Default }) => (depth === 1 ? <Text>{text}</Text> : <Default />))
      // @ts-expect-error
      mod.ui.render(markdownSlots.Heading, ({ lang }) => <Text>{lang}</Text>)
    },
  })
})

async function started(definition: ModDefinition) {
  const root = `/test/plugins/${definition.name}`
  const lifecycle = createLifecycle(definition)
  await lifecycle.start(fakeClaude({ name: definition.name, root }).claude, async () => ({ name: definition.name, root, version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false }))
  return lifecycle
}

function nextOf(draw: (e: Frozen<Args<'ui.render'>>) => RenderElement | Promise<RenderElement>): Next<'ui.render'> {
  return Object.assign(async (e: Frozen<Args<'ui.render'>>) => draw(e), { event: 'ui.render' }) as unknown as Next<'ui.render'>
}

function loadsVendorMarkdown(render: string, slot: string, props: string): string {
  const src = `${import.meta.dir}/../../src/`
  const script = `
    const { defineMod } = await import('${src}mod.ts')
    const { testMod } = await import('${src}testing.ts')
    const { slots } = await import('${src}ui/slots.ts')
    const { Text } = await import('${src}ui/elements.ts')
    await import('${src}connect.ts')
    const { markdownSlots } = ${render.includes('markdownSlots') ? `await import('${src}ui/markdown.ts')` : '{}'}
    const tested = testMod(defineMod({ name: 'probe', setup(mod) { ${render} } }))
    await tested.lines(${slot}, ${props})
    console.log(Object.keys(require.cache).some((path) => path.endsWith('vendor-markdown.ts')))
  `
  const run = Bun.spawnSync([process.execPath, '-e', script])
  return `${run.stdout.toString().trim()}${run.stderr.toString().trim()}`
}
