import { expect, spyOn, test } from 'bun:test'
import type { Args, Frozen, Next, RenderElement } from 'claude-code'
import { defineMod, type ModDefinition } from '../../src/mod.js'
import { createLifecycle } from '../../src/runtime/lifecycle.js'
import { fakeClaude, testMod, textOf } from '../../src/testing.js'
import * as vendorMarkdown from '../../src/vendor-markdown.js'
import { definePane } from '../../src/ui/define-pane.js'
import { Box, Markdown, Text } from '../../src/ui/elements.js'
import { markdownSlots } from '../../src/ui/markdown.js'
import { slots, type SlotProps } from '../../src/ui/slots.js'

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
    'PLAN',
    'AssistantMessage',
    '  text: "First we **read**."',
    '  isFirstOfReply: false',
    'AssistantMessage',
    '  text: "## Steps"',
    '  isFirstOfReply: false',
    'AssistantMessage',
    '  text: "- one\\n- two"',
    '  isFirstOfReply: false',
  ])
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

  expect(lines).toEqual(['AssistantMessage', '  text: "Before"', '  isFirstOfReply: true', 'diagram: graph TD', 'AssistantMessage', '  text: "```ts\\nconst a = 1\\n```"', '  isFirstOfReply: false'])
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
  await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe', isFirstOfReply: true })

  expect(await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe read.\n\n## Ste', isFirstOfReply: true })).toEqual(['PLAN', 'AssistantMessage', '  text: "We read.\\n\\n## Ste"', '  isFirstOfReply: false'])
  expect(await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe read.\n\n## Steps', isFirstOfReply: true })).toEqual(['PLAN', 'AssistantMessage', '  text: "We read.\\n\\n## Steps"', '  isFirstOfReply: false'])
  expect(await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe read.\n\n## Steps', isFirstOfReply: true })).toEqual(['PLAN', 'AssistantMessage', '  text: "We read."', '  isFirstOfReply: false', 'STEPS'])
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

  await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe', isFirstOfReply: true })
  await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe read.\n\n```mermaid\ngra', isFirstOfReply: true })
  await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe read.\n\n```mermaid\ngraph TD\n```', isFirstOfReply: true })
  await tested.lines(slots.AssistantMessage, { text: '# Plan\n\nWe read.\n\n```mermaid\ngraph TD\n```', isFirstOfReply: true })

  expect(parse.mock.calls.map(([text]) => text)).toEqual(['# Plan\n\nWe', 'We read.\n\n```mermaid\ngra', '```mermaid\ngraph TD\n```'])
  parse.mockRestore()
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

test('a mod renders each markdown slot once', async () => {
  const tested = testMod(
    defineMod({
      name: 'twice',
      setup(mod) {
        mod.ui.render(markdownSlots.Heading, Shouted)
        mod.ui.render(markdownSlots.Heading, Shouted)
      },
    }),
  )

  await expect(tested.start()).rejects.toThrow('twice: a render of markdown Heading is already added. Render each markdown slot once.')
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

  expect(await tested.lines('notes')).toEqual(['NOTES', '## Shopping', 'Buy milk.', 'diagram: graph TD'])
})

test('two mods rendering different markdown slots both apply to one reply', async () => {
  const headings = await started(
    defineMod({
      name: 'headings',
      setup(mod) {
        mod.ui.render(markdownSlots.Heading, ({ text }) => Text({ bold: true, children: text.toUpperCase() }))
      },
    }),
  )
  const diagrams = await started(
    defineMod({
      name: 'diagrams',
      setup(mod) {
        mod.ui.render(markdownSlots.CodeBlock, ({ lang, value, Default }) => (lang === 'mermaid' ? Text({ children: `diagram: ${value}` }) : Default({})))
      },
    }),
  )
  const claude = fakeClaude({ name: 'claude', root: '/test' }).claude
  const claudeDraws = nextOf((e) => claude.ui.resolve(e).Text({ children: `claude: ${(e.props as { text: string }).text}` }))
  const reply = { surface: 'terminal', component: 'AssistantMessage', requestId: 'msg_1', props: { text: '# Plan\n\n```mermaid\ngraph TD\n```\n\nDone.', isFirstOfReply: true } } as Frozen<Args<'ui.render'>>

  const drawn = await headings.route('ui.render', reply, nextOf((e) => diagrams.route('ui.render', e, claudeDraws)))

  expect(textOf(drawn).split('\n')).toEqual(['PLAN', 'diagram: graph TD', 'claude: Done.'])
})

test('a mod that renders no markdown slot never loads vendor-markdown', () => {
  const plain = loadsVendorMarkdown("mod.ui.render(slots.ToolUse, () => Text({ children: 'row' }))", 'slots.ToolUse', "{ tool_use_id: 'toolu_1', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false }")
  const markdown = loadsVendorMarkdown("mod.ui.render(markdownSlots.Heading, () => Text({ children: 'heading' }))", 'slots.AssistantMessage', "{ text: '# Plan', isFirstOfReply: true }")

  expect(plain).toBe('false')
  expect(markdown).toBe('true')
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
