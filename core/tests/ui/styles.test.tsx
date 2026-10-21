import { expect, test } from 'bun:test'
import type { RenderElement, RenderPropsOf } from 'claude-code'
import { AbovePrompt, defineMod, Reply, ToolCall, TurnEnd, type Kind, type Mod } from '../../src/mod.js'
import { Heading } from '../../src/ui/markdown.js'
import { testMod } from '../../src/testing.js'
import { rowsOf, textOf } from '../../src/testing/fake-elements.js'
import { Progress } from '../../src/ui/components.js'
import { Box, Button, Text } from '../../src/ui/elements.js'

const bashRow: RenderPropsOf['ToolUse'] = { tool_use_id: 'toolu_1', tool: 'Bash', input: { command: 'deploy --token s3cret' }, isRunning: false, isErrored: false, isInterrupted: false }

const bashRowLines = (command: string) => ['ToolUse', '  tool_use_id: "toolu_1"', '  tool: "Bash"', `  input: {"command":"${command}"}`, '  isRunning: false', '  isErrored: false', '  isInterrupted: false']

test('a style changes the props Claude draws with', async () => {
  const tested = testMod(
    defineMod({
      name: 'redact',
      setup(mod) {
        mod.styles.add({ kind: ToolCall, render: (_mod, { input, Default }) => <Default input={{ command: String((input as { command: string }).command).replace('s3cret', '•••') }} /> })
      },
    }),
  )

  expect(await tested.lines(ToolCall, bashRow)).toEqual(bashRowLines('deploy --token •••'))
})

test("a style adds to Claude's drawing", async () => {
  const tested = testMod(
    defineMod({
      name: 'tool-count',
      setup(mod) {
        mod.styles.add({
          kind: TurnEnd,
          render: (_mod, { Default }) => (
            <Box flexDirection="column">
              <Default />
              <Text dimColor>4 tools</Text>
            </Box>
          ),
        })
      },
    }),
  )

  expect(await tested.lines(TurnEnd, { word: 'Baked', durationMs: 3000 })).toEqual(['TurnDuration', '  word: "Baked"', '  durationMs: 3000', '4 tools'])
})

test("a style replaces Claude's drawing", async () => {
  const tested = testMod(
    defineMod({
      name: 'modes',
      setup(mod) {
        mod.styles.add({ kind: TurnEnd, render: (_mod, { word }) => <Text>{word} in focus</Text> })
      },
    }),
  )

  expect(await tested.lines(TurnEnd, { word: 'Baked', durationMs: 3000 })).toEqual(['Baked in focus'])
})

test("a style that throws keeps Claude's drawing", async () => {
  const tested = testMod(
    defineMod({
      name: 'broken',
      setup(mod) {
        mod.styles.add({
          kind: ToolCall,
          render: () => {
            throw new Error('no git here')
          },
        })
      },
    }),
  )

  expect(await tested.lines(ToolCall, bashRow)).toEqual(bashRowLines('deploy --token s3cret'))
  expect(await tested.lines(ToolCall, bashRow)).toEqual(bashRowLines('deploy --token s3cret'))
  expect(tested.shown.toasts.find(({ message }) => message === 'Installed')?.description).toContain('Adds the style of ToolCall.')
  expect(tested.shown.toasts.filter(({ type }) => type === 'error')).toEqual([{ type: 'error', message: 'The ToolCall style failed', description: 'threw, so Claude Code draws its own: no git here' }])
})

test('a removed style leaves Claude drawing its own row', async () => {
  let redact: { remove(): void } | undefined
  const tested = testMod(
    defineMod({
      name: 'redact',
      setup(mod) {
        redact = mod.styles.add({ kind: ToolCall, render: () => <Text>hidden</Text> })
      },
    }),
  )

  expect(await tested.lines(ToolCall, bashRow)).toEqual(['hidden'])
  redact?.remove()
  expect(await tested.lines(ToolCall, bashRow)).toEqual(bashRowLines('deploy --token s3cret'))
})

test('a pane whose render throws shows why, and logs it once', async () => {
  const tested = testMod(
    defineMod({
      name: 'broken',
      async setup(mod) {
        await mod.panes
          .add({
            id: 'board',
            title: 'Board',
            render: () => {
              throw new Error('no board file')
            },
          })
          .open()
      },
    }),
  )

  await tested.start()
  expect(await tested.shown.pane.lines()).toEqual(['The Board pane could not draw: no board file'])
  expect(await tested.shown.pane.lines()).toEqual(['The Board pane could not draw: no board file'])
  expect(tested.shown.toasts.find(({ message }) => message === 'Installed')?.description).toContain('Adds the Board pane.')
  expect(tested.shown.toasts.filter(({ type }) => type === 'error')).toEqual([{ type: 'error', message: 'The Board pane failed', description: 'threw: no board file' }])
})

test("a pane's onScroll hears its own window move, and never another pane's or the band's", async () => {
  const seen: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'history',
      async setup(mod) {
        await mod.panes.add({ id: 'log', title: 'Log', render: () => Text({ children: 'rows' }), onScroll: (_mod, { offset, contentRows, bodyRows }) => void seen.push({ offset, contentRows, bodyRows }) }).open()
        await mod.panes.add({ id: 'other', title: 'Other', render: () => Text({ children: 'rows' }) }).open()
      },
    }),
  )
  const scroll = (requestId: string, component: 'Pane' | 'AbovePrompt', offset: number) => ({ component, requestId, offset, by: 1, bodyRows: 10, contentRows: 40, origin: { kind: 'person' } }) as never

  await tested.fire('ui.scroll', scroll('log', 'Pane', 3), {})
  await tested.fire('ui.scroll', scroll('other', 'Pane', 5), {})
  await tested.fire('ui.scroll', scroll('band', 'AbovePrompt', 7), {})
  await tested.fire('ui.scroll', scroll('log', 'Pane', 9), { deny: 'the window moved meanwhile' })

  expect(seen).toEqual([{ offset: 3, contentRows: 40, bodyRows: 10 }])
})

test('every open sends closeOnEscape and holdToasts, a resize included, and only an open that asks sends focus', async () => {
  const tested = testMod(
    defineMod({
      name: 'history',
      state: { session: { isWide: false } },
      async setup(mod) {
        const pane = mod.panes.add({
          id: 'log',
          title: 'Log',
          columns: (state) => (state.session.isWide ? 60 : 40),
          closeOnEscape: true,
          holdToasts: true,
          render: (current, { isFocused }) => (
            <Box flexDirection="column">
              <Text>{isFocused ? 'has the keyboard' : 'without the keyboard'}</Text>
              <Button label="Wider" onPress={() => void (current.state.session.isWide = true)} />
            </Box>
          ),
        })
        await pane.toggle({ focus: true })
      },
    }),
  )

  await tested.start()
  expect(await tested.shown.pane.lines()).toContain('has the keyboard')
  await tested.shown.pane.press('Wider')
  await tested.settle()

  expect(tested.calls.filter(({ call }) => call === 'ui.open').map(({ args }) => args[0])).toEqual([
    { id: 'log', title: 'Log', columns: 40, closeOnEscape: true, holdToasts: true, focus: true },
    { id: 'log', title: 'Log', columns: 60, closeOnEscape: true, holdToasts: true },
  ])
  expect(await tested.shown.pane.lines()).toContain('has the keyboard')
})

test('a pane opened with params draws them, and opening again replaces them', async () => {
  let pane: ReturnType<Mod['panes']['add']> | undefined
  const tested = testMod(
    defineMod({
      name: 'files',
      setup(mod) {
        pane = mod.panes.add<{ readonly path: string }>({ id: 'file', title: 'File', render: (_mod, { params }) => <Text>{params.path}</Text> })
      },
    }),
  )

  await tested.start()
  await (pane as unknown as { open(options: { params: { path: string } }): Promise<void> }).open({ params: { path: 'README.md' } })
  expect(await tested.shown.pane.lines()).toEqual(['README.md'])
  await (pane as unknown as { open(options: { params: { path: string } }): Promise<void> }).open({ params: { path: 'src/mod.ts' } })
  expect(await tested.shown.pane.lines()).toEqual(['src/mod.ts'])
  expect(pane?.params).toEqual({ path: 'src/mod.ts' })
})

test('a pane opened without focus draws without the keyboard', async () => {
  const tested = testMod(
    defineMod({
      name: 'history',
      async setup(mod) {
        await mod.panes.add({ id: 'log', title: 'Log', render: (_mod, { isFocused }) => <Text>{isFocused ? 'has the keyboard' : 'without the keyboard'}</Text> }).open()
      },
    }),
  )

  await tested.start()
  expect(await tested.shown.pane.lines()).toEqual(['without the keyboard'])
})

test("a pane's onClose hears it close, and a throwing handler is logged", async () => {
  const closed: string[] = []
  const tested = testMod(
    defineMod({
      name: 'history',
      async setup(mod) {
        await mod.panes.add({ id: 'log', title: 'Log', render: () => Text({ children: 'rows' }), onClose: (_mod, { origin }) => void closed.push(origin.kind) }).open()
        await mod.panes
          .add({
            id: 'board',
            title: 'Board',
            render: () => Text({ children: 'rows' }),
            onClose: () => {
              throw new Error('no board file')
            },
          })
          .open()
      },
    }),
  )

  await tested.fire('ui.close', { id: 'log', origin: { kind: 'person' } } as never, undefined)
  await tested.fire('ui.close', { id: 'board', origin: { kind: 'plugin', name: 'history' } } as never, undefined)

  expect(closed).toEqual(['person'])
  expect(tested.shown.toasts).toContainEqual({ type: 'error', message: "The Board pane's onClose threw", description: 'no board file' })
})

test('onScreen is passed on unchanged and cmod draws the bullet beside Default pieces it wraps', async () => {
  const tested = testMod(
    defineMod({
      name: 'pieces',
      setup(mod) {
        mod.styles.add({
          kind: Reply,
          render: (_mod, { text, Default }) => (
            <Box flexDirection="column">
              {text.split('\n\n').map((part) => (
                <Default text={part} />
              ))}
            </Box>
          ),
        })
      },
    }),
  )

  const lines = await tested.lines(Reply, { text: 'Intro\n\nOutro', isFirstOfReply: true, onScreen: { first: 0, last: 3, of: 4 } })

  expect(lines).toEqual([
    '⏺ AssistantMessage',
    '    text: "Intro"',
    '    isFirstOfReply: false',
    '    onScreen: {"first":0,"last":3,"of":4}',
    '  AssistantMessage',
    '    text: "Outro"',
    '    isFirstOfReply: false',
    '    onScreen: {"first":0,"last":3,"of":4}',
  ])
})

test('a Reply style that draws a row above Default keeps the bullet on the first row', async () => {
  const tested = testMod(
    defineMod({
      name: 'labels',
      setup(mod) {
        mod.styles.add({
          kind: Reply,
          render: (_mod, { Default }) => (
            <Box flexDirection="column">
              <Text>Claude says:</Text>
              <Default />
            </Box>
          ),
        })
      },
    }),
  )

  expect(await tested.lines(Reply, { text: 'We read.', isFirstOfReply: true })).toEqual(['⏺ Claude says:', '  AssistantMessage', '    text: "We read."', '    isFirstOfReply: false'])
})

test('a Reply style that returns Default unchanged leaves the bullet to Claude Code', async () => {
  const tested = testMod(
    defineMod({
      name: 'redact',
      setup(mod) {
        mod.styles.add({ kind: Reply, render: (_mod, { text, Default }) => <Default text={text.replace('s3cret', '•••')} /> })
      },
    }),
  )

  expect(await tested.lines(Reply, { text: 'The token is s3cret.', isFirstOfReply: true })).toEqual(['AssistantMessage', '  text: "The token is •••."', '  isFirstOfReply: true'])
})

test('a Reply style of a later block has a blank line above it', async () => {
  const tested = testMod(
    defineMod({
      name: 'quiet',
      setup(mod) {
        mod.styles.add({ kind: Reply, render: (_mod, { text }) => <Text>{text.toUpperCase()}</Text> })
      },
    }),
  )

  expect(await tested.lines(Reply, { text: 'We read.', isFirstOfReply: false })).toEqual(['', 'WE READ.'])
})

test("two Default pieces in one drawing each draw Claude's row", async () => {
  const tested = testMod(
    defineMod({
      name: 'twice',
      setup(mod) {
        mod.styles.add({
          kind: ToolCall,
          render: (_mod, { Default }) => (
            <Box flexDirection="column">
              <Default />
              <Default isErrored />
            </Box>
          ),
        })
      },
    }),
  )
  const claudeRow = { type: 'Text', children: ['Bash(deploy)'] } as unknown as RenderElement

  const drawn = await tested.fire('ui.render', { surface: 'terminal', component: 'ToolUse', requestId: 'toolu_1', props: bashRow }, claudeRow)

  expect(textOf(drawn)).toBe('Bash(deploy)\nBash(deploy)')
})

test("Default inside a Box draws Claude's row when the Box hides its children", async () => {
  const tested = testMod(
    defineMod({
      name: 'boxed',
      setup(mod) {
        mod.styles.add({
          kind: TurnEnd,
          render: (_mod, { Default }) => (
            <Box flexDirection="column">
              <Text>above</Text>
              <Default word="Brewed" />
            </Box>
          ),
        })
      },
    }),
  )

  expect(await tested.lines(TurnEnd, { word: 'Baked', durationMs: 3000 })).toEqual(['above', 'TurnDuration', '  word: "Brewed"', '  durationMs: 3000'])
})

test("a style that uses Default a different number of times on its second pass keeps Claude's drawing", async () => {
  let runs = 0
  const tested = testMod(
    defineMod({
      name: 'impure',
      setup(mod) {
        mod.styles.add({
          kind: TurnEnd,
          render: (_mod, { Default }) => {
            runs += 1
            return <Box flexDirection="column">{runs % 2 === 1 ? <Default /> : [<Default />, <Default />]}</Box>
          },
        })
      },
    }),
  )

  expect(await tested.lines(TurnEnd, { word: 'Baked', durationMs: 3000 })).toEqual(['TurnDuration', '  word: "Baked"', '  durationMs: 3000'])
  expect(tested.shown.toasts.find(({ message }) => message === 'Installed')?.description).toContain('Adds the style of TurnEnd.')
  expect(tested.shown.toasts).toContainEqual({
    type: 'error',
    message: 'The TurnEnd style failed',
    description: 'used Default 1 time, then 2 times, so Claude Code draws its own. A render must draw the same for the same props.',
  })
})

test('a style without Default runs once', async () => {
  let runs = 0
  const tested = testMod(
    defineMod({
      name: 'once',
      setup(mod) {
        mod.styles.add({
          kind: TurnEnd,
          render: (_mod, { word }) => {
            runs += 1
            return <Text>{word}</Text>
          },
        })
      },
    }),
  )

  expect(await tested.lines(TurnEnd, { word: 'Baked', durationMs: 3000 })).toEqual(['Baked'])
  expect(runs).toBe(1)
})

test("toasts and a mod's AbovePrompt widget share Claude Code's band above the prompt, and both hide while it shows a survey", async () => {
  let toast: Mod['toast'] | undefined
  const tested = testMod(
    defineMod({
      name: 'indexer',
      setup(mod) {
        toast = mod.toast
        mod.widgets.add({ id: 'prompts', title: 'Prompts', areas: [AbovePrompt], render: () => <Text>3 prompts</Text> })
        mod.toast.loading('Indexing files', { id: 'index', description: <Progress value={50} width={8} /> })
      },
    }),
  )
  const band = (hasSurvey: boolean) => ({ surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey, isWorking: false, maxRows: 12, bodyColumns: 75, scroll: { offset: 0, bodyRows: 12 }, view: {} } }) as never
  const lines = async (hasSurvey: boolean) => rowsOf(await tested.fire('ui.render', band(hasSurvey), Box({})), 75).map((row) => row.trimEnd())

  expect(await lines(false)).toEqual(['⠋  indexer  Indexing files  ✕', '            ████░░░░', '✓  indexer  Installed                 Settings  ✕', '            Adds the Prompts widget.', '3 prompts'])
  expect(await lines(true)).toEqual([''])
  toast?.dismiss()
  expect(await lines(false)).toEqual(['3 prompts'])
})

test('a mod that styles one kind twice is refused with the same message for every kind', async () => {
  const styledTwice = (kind: Kind) =>
    testMod(
      defineMod({
        name: 'twice',
        setup(mod) {
          mod.styles.add({ kind, render: () => <Text>once</Text> })
          mod.styles.add({ kind, render: () => <Text>twice</Text> })
        },
      }),
    ).start()

  await expect(styledTwice(ToolCall)).rejects.toThrow('twice: the style of ToolCall is already added. Add one style per kind.')
  await expect(styledTwice(Heading)).rejects.toThrow('twice: the style of Heading is already added. Add one style per kind.')
})

test('a style takes the props its kind carries', () => {
  defineMod({
    name: 'typed',
    setup(mod) {
      mod.styles.add({ kind: ToolCall, render: (_mod, { input, Default }) => <Default input={input} /> })
      // @ts-expect-error
      mod.styles.add({ kind: ToolCall, render: (_mod, { text }) => <Text>{text}</Text> })
    },
  })
})
