import { expect, test } from 'bun:test'
import type { RenderElement, RenderPropsOf } from 'claude-code'
import { defineMod } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'
import { textOf } from '../../src/testing/fake-elements.js'
import { definePane } from '../../src/ui/define-pane.js'
import { Box, Button, Text } from '../../src/ui/elements.js'
import { markdownSlots } from '../../src/ui/markdown.js'
import { type Slot, slots } from '../../src/ui/slots.js'

const bashRow: RenderPropsOf['ToolUse'] = { tool_use_id: 'toolu_1', tool: 'Bash', input: { command: 'deploy --token s3cret' }, isRunning: false, isErrored: false, isInterrupted: false }

const bashRowLines = (command: string) => ['ToolUse', '  tool_use_id: "toolu_1"', '  tool: "Bash"', `  input: {"command":"${command}"}`, '  isRunning: false', '  isErrored: false', '  isInterrupted: false']

test('a slot component changes the props Claude draws with', async () => {
  const tested = testMod(
    defineMod({
      name: 'redact',
      setup(mod) {
        mod.ui.render(slots.ToolUse, ({ input, Default }) => <Default input={{ command: String((input as { command: string }).command).replace('s3cret', '•••') }} />)
      },
    }),
  )

  expect(await tested.lines(slots.ToolUse, bashRow)).toEqual(bashRowLines('deploy --token •••'))
})

test("a slot component adds to Claude's drawing", async () => {
  const tested = testMod(
    defineMod({
      name: 'tool-count',
      setup(mod) {
        mod.ui.render(slots.TurnDuration, ({ Default }) => (
          <Box flexDirection="column">
            <Default />
            <Text dimColor>4 tools</Text>
          </Box>
        ))
      },
    }),
  )

  expect(await tested.lines(slots.TurnDuration, { word: 'Baked', durationMs: 3000 })).toEqual(['TurnDuration', '  word: "Baked"', '  durationMs: 3000', '4 tools'])
})

test("a slot component replaces Claude's drawing", async () => {
  const tested = testMod(
    defineMod({
      name: 'modes',
      setup(mod) {
        mod.ui.render(slots.SessionMode, ({ modes }) => <Text>{modes.join(' + ')}</Text>)
      },
    }),
  )

  expect(await tested.lines(slots.SessionMode, { modes: ['focus', 'memory paused'] })).toEqual(['focus + memory paused'])
})

test("a component that throws keeps Claude's drawing", async () => {
  const tested = testMod(
    defineMod({
      name: 'broken',
      setup(mod) {
        mod.ui.render(slots.ToolUse, () => {
          throw new Error('no git here')
        })
      },
    }),
  )

  expect(await tested.lines(slots.ToolUse, bashRow)).toEqual(bashRowLines('deploy --token s3cret'))
  expect(await tested.lines(slots.ToolUse, bashRow)).toEqual(bashRowLines('deploy --token s3cret'))
  expect(tested.shown.logs).toEqual(['broken added a render of ToolUse.', 'broken: the ToolUse render threw, so Claude Code draws its own: no git here'])
})

test('a pane whose render throws shows why, and logs it once', async () => {
  const tested = testMod(
    defineMod({
      name: 'broken',
      async setup(mod) {
        await mod.ui.pane(definePane({ id: 'board', title: 'Board', render: () => { throw new Error('no board file') } })).open()
      },
    }),
  )

  expect(await tested.lines('board')).toEqual(['The Board pane could not draw: no board file'])
  expect(await tested.lines('board')).toEqual(['The Board pane could not draw: no board file'])
  expect(tested.shown.logs).toEqual(['broken added the Board pane.', 'broken: the Board pane render threw: no board file'])
})

test("a pane's onScroll hears its own window move, and never another pane's or the band's", async () => {
  const seen: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'history',
      async setup(mod) {
        await mod.ui.pane(definePane({ id: 'log', title: 'Log', render: () => Text({ children: 'rows' }), onScroll: (_mod, { offset, contentRows, bodyRows }) => void seen.push({ offset, contentRows, bodyRows }) })).open()
        await mod.ui.pane(definePane({ id: 'other', title: 'Other', render: () => Text({ children: 'rows' }) })).open()
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
        const pane = mod.ui.pane(
          definePane<{ session: { isWide: boolean } }>({
            id: 'log',
            title: 'Log',
            columns: (state) => (state.session.isWide ? 60 : 40),
            closeOnEscape: true,
            holdToasts: true,
            render: (pane, { isFocused }) => (
              <Box flexDirection="column">
                <Text>{isFocused ? 'has the keyboard' : 'without the keyboard'}</Text>
                <Button label="Wider" onPress={() => void (pane.state.session.isWide = true)} />
              </Box>
            ),
          }),
        )
        await pane.toggle({ focus: true })
      },
    }),
  )

  expect(await tested.lines('log')).toContain('has the keyboard')
  await tested.press('log', 'Wider')
  await tested.settle()

  expect(tested.calls.filter(({ call }) => call === 'ui.open').map(({ args }) => args[0])).toEqual([
    { id: 'log', title: 'Log', columns: 40, closeOnEscape: true, holdToasts: true, focus: true },
    { id: 'log', title: 'Log', columns: 60, closeOnEscape: true, holdToasts: true },
  ])
  expect(await tested.lines('log')).toContain('has the keyboard')
})

test('a pane opened without focus draws without the keyboard', async () => {
  const tested = testMod(
    defineMod({
      name: 'history',
      async setup(mod) {
        await mod.ui.pane(definePane({ id: 'log', title: 'Log', render: (_mod, { isFocused }) => <Text>{isFocused ? 'has the keyboard' : 'without the keyboard'}</Text> })).open()
      },
    }),
  )

  expect(await tested.lines('log')).toEqual(['without the keyboard'])
})

test("a pane's onClose hears it close, and a throwing handler is logged", async () => {
  const closed: string[] = []
  const tested = testMod(
    defineMod({
      name: 'history',
      async setup(mod) {
        await mod.ui.pane(definePane({ id: 'log', title: 'Log', render: () => Text({ children: 'rows' }), onClose: (_mod, { origin }) => void closed.push(origin.kind) })).open()
        await mod.ui.pane(definePane({ id: 'board', title: 'Board', render: () => Text({ children: 'rows' }), onClose: () => { throw new Error('no board file') } })).open()
      },
    }),
  )

  await tested.fire('ui.close', { id: 'log', origin: { kind: 'person' } } as never, undefined)
  await tested.fire('ui.close', { id: 'board', origin: { kind: 'plugin', name: 'history' } } as never, undefined)

  expect(closed).toEqual(['person'])
  expect(tested.shown.logs).toContain("history: the Board pane's onClose threw: no board file")
})

test('onScreen is passed on unchanged and the SDK draws the bullet beside Default pieces it wraps', async () => {
  const tested = testMod(
    defineMod({
      name: 'pieces',
      setup(mod) {
        mod.ui.render(slots.AssistantMessage, ({ text, Default }) => (
          <Box flexDirection="column">
            {text.split('\n\n').map((part) => (
              <Default text={part} />
            ))}
          </Box>
        ))
      },
    }),
  )

  const lines = await tested.lines(slots.AssistantMessage, { text: 'Intro\n\nOutro', isFirstOfReply: true, onScreen: { first: 0, last: 3, of: 4 } })

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

test('an AssistantMessage render that draws a row above Default keeps the bullet on the first row', async () => {
  const tested = testMod(
    defineMod({
      name: 'labels',
      setup(mod) {
        mod.ui.render(slots.AssistantMessage, ({ Default }) => (
          <Box flexDirection="column">
            <Text>Claude says:</Text>
            <Default />
          </Box>
        ))
      },
    }),
  )

  expect(await tested.lines(slots.AssistantMessage, { text: 'We read.', isFirstOfReply: true })).toEqual(['⏺ Claude says:', '  AssistantMessage', '    text: "We read."', '    isFirstOfReply: false'])
})

test('an AssistantMessage render that returns Default unchanged leaves the bullet to Claude Code', async () => {
  const tested = testMod(
    defineMod({
      name: 'redact',
      setup(mod) {
        mod.ui.render(slots.AssistantMessage, ({ text, Default }) => <Default text={text.replace('s3cret', '•••')} />)
      },
    }),
  )

  expect(await tested.lines(slots.AssistantMessage, { text: 'The token is s3cret.', isFirstOfReply: true })).toEqual(['AssistantMessage', '  text: "The token is •••."', '  isFirstOfReply: true'])
})

test('an AssistantMessage render of a later block has a blank line above it', async () => {
  const tested = testMod(
    defineMod({
      name: 'quiet',
      setup(mod) {
        mod.ui.render(slots.AssistantMessage, ({ text }) => <Text>{text.toUpperCase()}</Text>)
      },
    }),
  )

  expect(await tested.lines(slots.AssistantMessage, { text: 'We read.', isFirstOfReply: false })).toEqual(['', 'WE READ.'])
})

test("two Default pieces in one drawing each draw Claude's slot", async () => {
  const tested = testMod(
    defineMod({
      name: 'twice',
      setup(mod) {
        mod.ui.render(slots.ToolUse, ({ Default }) => (
          <Box flexDirection="column">
            <Default />
            <Default isErrored />
          </Box>
        ))
      },
    }),
  )
  const claudeRow = { type: 'Text', children: ['Bash(deploy)'] } as unknown as RenderElement

  const drawn = await tested.fire('ui.render', { surface: 'terminal', component: 'ToolUse', requestId: 'toolu_1', props: bashRow }, claudeRow)

  expect(textOf(drawn)).toBe('Bash(deploy)\nBash(deploy)')
})

test("Default inside a Box draws Claude's slot when the Box hides its children", async () => {
  const tested = testMod(
    defineMod({
      name: 'boxed',
      setup(mod) {
        mod.ui.render(slots.TurnDuration, ({ Default }) => (
          <Box flexDirection="column">
            <Text>above</Text>
            <Default word="Brewed" />
          </Box>
        ))
      },
    }),
  )

  expect(await tested.lines(slots.TurnDuration, { word: 'Baked', durationMs: 3000 })).toEqual(['above', 'TurnDuration', '  word: "Brewed"', '  durationMs: 3000'])
})

test('a component that uses Default a different number of times on its second pass keeps Claude\'s drawing', async () => {
  let runs = 0
  const tested = testMod(
    defineMod({
      name: 'impure',
      setup(mod) {
        mod.ui.render(slots.TurnDuration, ({ Default }) => {
          runs += 1
          return <Box flexDirection="column">{runs % 2 === 1 ? <Default /> : [<Default />, <Default />]}</Box>
        })
      },
    }),
  )

  expect(await tested.lines(slots.TurnDuration, { word: 'Baked', durationMs: 3000 })).toEqual(['TurnDuration', '  word: "Baked"', '  durationMs: 3000'])
  expect(tested.shown.logs).toEqual(['impure added a render of TurnDuration.', 'impure: the TurnDuration render used Default 1 time, then 2 times, so Claude Code draws its own. A render must draw the same for the same props.'])
})

test('a component without Default runs once', async () => {
  let runs = 0
  const tested = testMod(
    defineMod({
      name: 'once',
      setup(mod) {
        mod.ui.render(slots.SessionMode, ({ modes }) => {
          runs += 1
          return <Text>{modes.join(' + ')}</Text>
        })
      },
    }),
  )

  expect(await tested.lines(slots.SessionMode, { modes: ['focus'] })).toEqual(['focus'])
  expect(runs).toBe(1)
})

test("the install progress bar still draws above a mod's AbovePrompt render", async () => {
  let finish: () => void = () => undefined
  const tested = testMod(
    defineMod({
      name: 'indexer',
      setup(mod) {
        mod.ui.render(slots.AbovePrompt, () => <Text>3 prompts</Text>)
        void mod.ui.progress('Indexing files', async (report) => {
          report({ done: 2, total: 4, label: 'Reading src' })
          await new Promise<void>((resolve) => {
            finish = resolve
          })
        })
      },
    }),
  )
  const band: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 75, scroll: { offset: 0, bodyRows: 12 }, view: {} }

  expect(await tested.lines(slots.AbovePrompt, band)).toEqual(['3 prompts', `⠋ Indexing files  ${'█'.repeat(15)}${'░'.repeat(15)}  2/4  Reading src`])
  finish()
  await tested.settle()
  expect(await tested.lines(slots.AbovePrompt, band)).toEqual(['3 prompts'])
})

test('a mod that renders one slot twice is refused with the same message for every slot', async () => {
  const renderedTwice = (slot: Slot) =>
    testMod(
      defineMod({
        name: 'twice',
        setup(mod) {
          mod.ui.render(slot, () => <Text>once</Text>)
          mod.ui.render(slot, () => <Text>twice</Text>)
        },
      }),
    ).start()

  await expect(renderedTwice(slots.ToolUse)).rejects.toThrow('twice: a render of ToolUse is already added. Render each slot once.')
  await expect(renderedTwice(markdownSlots.Heading)).rejects.toThrow('twice: a render of markdown Heading is already added. Render each slot once.')
})

test('a slot component takes the props its slot carries', () => {
  defineMod({
    name: 'typed',
    setup(mod) {
      mod.ui.render(slots.ToolUse, ({ input, Default }) => <Default input={input} />)
      // @ts-expect-error
      mod.ui.render(slots.ToolUse, ({ text }) => <Text>{text}</Text>)
    },
  })
})
