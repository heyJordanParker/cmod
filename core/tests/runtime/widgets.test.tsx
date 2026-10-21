import { expect, test } from 'bun:test'
import { AbovePrompt, BelowPrompt, Dashboard, defineMod, Prompt, TurnEnd, Working, type Mod, type WidgetInit } from '../../src/mod.js'
import { widgetsPath } from '../../src/records.js'
import { createRouter } from '../../src/runtime/router.js'
import { partMethods } from '../../src/runtime/ui.js'
import { drawnParts } from '../../src/runtime/parts.js'
import { claudeHint, claudeModes, layoutOf, moved, serveWidgets, toggled, type PlacedWidget, type WidgetLayout } from '../../src/runtime/widgets.js'
import { testMod } from '../../src/testing.js'
import { fakeClaude } from '../../src/testing/fake-claude.js'
import { fakeFiles } from '../../src/testing/fake-files.js'
import { elements, rowsOf } from '../../src/testing/fake-elements.js'
import { Box, Button, elementData, elementOf, Text } from '../../src/ui/elements.js'

const layoutFile = widgetsPath('/test/home/.local/share/cmod')

const withWidgets = (name: string, ...widgets: WidgetInit[]) =>
  defineMod({
    name,
    setup(mod) {
      for (const widget of widgets) mod.widgets.add(widget)
    },
  })

const label = (id: string, text: string, areas: WidgetInit['areas'] = [BelowPrompt]): WidgetInit => ({ id, title: id, areas, render: () => <Text>{text}</Text> })

const layout = (areas: Partial<WidgetLayout['areas']>, hidden: readonly string[] = []): string => JSON.stringify({ areas: { ...layoutOf({}).areas, ...areas }, hidden })

test('a new widget goes into the first row of its first area, and only a change the person makes writes the layout', async () => {
  const tested = testMod(withWidgets('git', label('branch', 'main', [Working, BelowPrompt]), label('dirty', '2 changed')))

  expect(await tested.lines(Working)).toEqual(['main'])
  expect(await tested.lines(BelowPrompt)).toEqual(['2 changed'])
  await expect(tested.fakes.fs.read!(layoutFile)).rejects.toThrow('ENOENT')
})

test('a row draws its left widgets at the left and its right widgets at the right, at the width it is given', async () => {
  const tested = testMod(withWidgets('git', label('branch', 'main'), label('dirty', '2 changed'), label('ahead', '↑1')), {
    files: { [layoutFile]: layout({ belowPrompt: [{ left: ['git/branch', 'git/dirty'], right: ['git/ahead'] }] }) },
  })

  expect(await tested.lines(BelowPrompt, { columns: 30 })).toEqual(['main  2 changed             ↑1'])
})

test('a hidden widget keeps its place and draws nothing', async () => {
  const tested = testMod(withWidgets('git', label('branch', 'main'), label('dirty', '2 changed')), {
    files: { [layoutFile]: layout({ belowPrompt: [{ left: ['git/branch', 'git/dirty'], right: [] }] }, ['git/branch']) },
  })

  expect(await tested.lines(BelowPrompt)).toEqual(['2 changed'])
})

test("hiding Claude Code's hint leaves the BelowPrompt widgets, and hiding its mode labels draws none", async () => {
  const fire = async (hidden: readonly string[], component: 'PromptHint' | 'SessionMode') => {
    const tested = testMod(withWidgets('git', label('branch', 'main')), { files: { [layoutFile]: layout({ belowPrompt: [{ left: ['git/branch'], right: [] }] }, hidden) } })
    const props = component === 'PromptHint' ? { isDraft: false, isWorking: false, hint: '? for shortcuts' } : { modes: ['auto mode on'] }
    return rowsOf(await tested.fire('ui.render', { surface: 'terminal', component, requestId: component, props, viewport: { columns: 40, rows: 24 } } as never, elements.Text({ children: component === 'PromptHint' ? '? for shortcuts' : 'auto mode on' })), 40).map((row) => row.trimEnd())
  }

  expect(await fire([], 'PromptHint')).toEqual(['? for shortcuts', 'main'])
  expect(await fire([claudeHint], 'PromptHint')).toEqual(['main'])
  expect(await fire([], 'SessionMode')).toEqual(['auto mode on'])
  expect(await fire([claudeModes], 'SessionMode')).toEqual([])
})

test('a TurnEnd widget draws under the turn that ended, and reads that turn', async () => {
  const tested = testMod(withWidgets('turns', { id: 'prompt', title: 'Prompt', areas: [TurnEnd], render: (_mod, context) => <Text>{context.area === TurnEnd ? `answered: ${context.turn.prompt.text}` : ''}</Text> }))

  await tested.add({ type: Prompt, text: 'fix the build' })
  await tested.endTurn()

  expect(await tested.lines(TurnEnd)).toEqual(['answered: fix the build'])
})

test("a widget's button runs in the mod that drew it, and the widget draws its new state", async () => {
  const tested = testMod(
    defineMod({
      name: 'counter',
      state: { session: { count: 0 } },
      setup(mod) {
        mod.widgets.add({
          id: 'count',
          title: 'Count',
          areas: [AbovePrompt],
          render: (current) => (
            <Box gap={1}>
              <Text>{`${current.state.session.count}`}</Text>
              <Button key="add" label="Add" onPress={() => void (current.state.session.count += 1)} />
            </Box>
          ),
        })
      },
    }),
  )

  await tested.press(AbovePrompt, 'add')
  await tested.press(AbovePrompt, 'Add')

  expect(await tested.lines(AbovePrompt)).toEqual(['2 [ Add ]'])
  expect(tested.state.session.count).toBe(2)
})

test("a widget's button opens a page of the mod in the Sidebar", async () => {
  const tested = testMod(
    defineMod({
      name: 'git',
      setup(mod) {
        const log = mod.sidebar.add({ id: 'log', title: 'Log', render: () => <Text>3 commits</Text> })
        mod.widgets.add({ id: 'branch', title: 'Branch', areas: [BelowPrompt], render: () => <Button key="log" label="main" onPress={() => log.open({ focus: true })} /> })
      },
    }),
  )

  await tested.press(BelowPrompt, 'log')

  expect(tested.shown.page.id).toBe('log')
  expect(await tested.shown.page.lines()).toEqual(['3 commits'])
})

test('a widget that throws is reported and draws nothing, and the widgets beside it still draw', async () => {
  const tested = testMod(
    withWidgets(
      'git',
      {
        id: 'broken',
        title: 'Broken',
        areas: [BelowPrompt],
        render: () => {
          throw new Error('no repository')
        },
      },
      label('branch', 'main'),
    ),
    { files: { [layoutFile]: layout({ belowPrompt: [{ left: ['git/broken', 'git/branch'], right: [] }] }) } },
  )

  expect(await tested.lines(BelowPrompt)).toEqual(['main'])
  expect(tested.shown.toasts.map((toast) => toast.message)).toContain('The Broken widget could not draw')
})

test('a removed widget draws nothing, and an added one draws at once', async () => {
  let remove = () => {}
  let add = () => {}
  const tested = testMod(
    defineMod({
      name: 'git',
      setup(mod: Mod) {
        remove = () => mod.widgets.add(label('branch', 'main')).remove()
        add = () => void mod.widgets.add(label('dirty', '2 changed'))
      },
    }),
  )
  await tested.start()

  remove()
  add()

  expect(await tested.lines(BelowPrompt)).toEqual(['2 changed'])
})

test('a second widget with one id is refused in setup', async () => {
  await expect(testMod(withWidgets('git', label('branch', 'main'), label('branch', 'dev'))).start()).rejects.toThrow('git: the widget "branch" is already added. Give each widget its own id.')
})

test('widgets.add refuses an id that is not one', async () => {
  await expect(testMod(withWidgets('git', label('a b', 'main'))).start()).rejects.toThrow('git: "a b" is not a widget id. Use 1 to 64 letters, digits, "_", or "-".')
})

test('a press runs the button of the drawing the person saw, after the widget drew again at another width', async () => {
  const tested = testMod(
    defineMod({
      name: 'pick',
      state: { session: { picked: '' } },
      setup(mod) {
        mod.widgets.add({ id: 'choice', title: 'Choice', areas: [BelowPrompt], render: (current, { columns }) => <Button key="go" label="Go" onPress={() => void (current.state.session.picked = columns < 50 ? 'narrow' : 'wide')} /> })
      },
    }),
  )
  await tested.start()
  const draw = async (columns: number) => (await tested.fire('cmod.call', { to: 'pick', method: partMethods.draw, input: { widget: 'choice', area: BelowPrompt, columns }, caller: 'cmod' } as never)) as { readonly value: { readonly draw: number } }
  const narrow = await draw(30)
  await draw(80)

  await tested.fire('cmod.call', { to: 'pick', method: partMethods.press, input: { draw: narrow.value.draw, handler: 0, args: [] }, caller: 'cmod' } as never)
  await tested.settle()

  expect(tested.state.session.picked).toBe('narrow')
})

const servedLayout = (layout: string) => {
  const fake = fakeClaude({ name: 'cmod', root: '/test/cmod' })
  Object.assign(fake.fakes.fs, fakeFiles({ [layoutFile]: layout }))
  const widgets = serveWidgets({ claude: fake.claude, router: createRouter(), store: '/test/home/.local/share/cmod', report: () => undefined, turnClosedBy: () => undefined, parts: drawnParts({ claude: fake.claude, report: () => undefined, press: () => undefined }) })
  const tell = (caller: string, listed: unknown) => widgets.update(caller, { parts: { widgets: listed as never, pages: [] } })
  const saved = async () => layoutOf(JSON.parse(await fake.claude.fs.read(layoutFile)))
  return { fake, widgets, tell, saved }
}

test("a mod that lists an area that is not one still lets the other mods' new widgets be placed", async () => {
  const { fake, widgets, tell } = servedLayout(layout({}))
  await fake.settle()

  tell('broken', [{ id: 'x', title: 'X', areas: ['status'] }])
  tell('git', [{ id: 'branch', title: 'Branch', areas: [BelowPrompt] }])
  await fake.settle()

  expect(widgets.layout().areas.belowPrompt).toEqual([{ left: ['git/branch'], right: [] }])
})

test('two sessions place new widgets without writing, so a layout change in one is never lost to the start of another', async () => {
  const { fake, widgets, tell, saved } = servedLayout(layout({ belowPrompt: [{ left: ['git/branch'], right: [] }] }))
  await fake.settle()
  tell('notes', [{ id: 'count', title: 'Count', areas: [BelowPrompt] }])
  await fake.settle()

  expect(await saved()).toEqual(layoutOf(JSON.parse(layout({ belowPrompt: [{ left: ['git/branch'], right: [] }] }))))
  await widgets.change((current) => toggled(current, 'git/branch'))

  expect(await saved()).toEqual({ ...layoutOf({}), areas: { ...layoutOf({}).areas, belowPrompt: [{ left: ['git/branch', 'notes/count'], right: [] }] }, hidden: ['git/branch'] })
})

test('a change to the layout keeps the areas and fields a newer cmod in another session saved', async () => {
  const newer = { areas: { belowPrompt: [{ left: ['git/branch'], right: [], center: ['git/dirty'] }], sidebarTop: [{ left: ['notes/count'], right: [] }] }, hidden: [] as string[], order: ['git'] }
  const { fake, widgets, tell } = servedLayout(JSON.stringify(newer))
  await fake.settle()
  tell('notes', [{ id: 'count', title: 'Count', areas: ['abovePrompt'] }])
  tell('git', [{ id: 'dirty', title: 'Dirty', areas: ['belowPrompt'] }])

  await widgets.change((current) => toggled(current, 'git/branch'))

  const written = JSON.parse(await fake.claude.fs.read(layoutFile)) as typeof newer & { readonly areas: { readonly abovePrompt?: unknown } }
  expect(written.areas.sidebarTop).toEqual(newer.areas.sidebarTop)
  expect(written.areas.belowPrompt).toEqual(newer.areas.belowPrompt)
  expect(written.areas.abovePrompt).toEqual([])
  expect(written.order).toEqual(['git'])
  expect(written.hidden).toEqual(['git/branch'])
})

test('a change to the layout keeps what another session saved a moment before', async () => {
  const { fake, widgets, saved } = servedLayout(layout({ belowPrompt: [{ left: ['git/branch'], right: [] }] }))
  await fake.settle()
  await fake.claude.fs.write(layoutFile, layout({ belowPrompt: [{ left: ['git/branch'], right: [] }] }, ['git/dirty']))

  await widgets.change((current) => toggled(current, 'git/branch'))

  expect((await saved()).hidden).toEqual(['git/dirty', 'git/branch'])
})

test('the cmod plugin keeps the 200 drawings it showed last, and draws an older one again when it shows', async () => {
  const fake = fakeClaude({ name: 'cmod', root: '/test/cmod' })
  const asked: unknown[] = []
  fake.fakes.cmod.call = async (input) => (asked.push(input.input), { draw: asked.length, tree: { $cmodElement: 'Text', props: { children: 'run' } } })
  const parts = drawnParts({ claude: fake.claude, report: () => undefined, press: () => undefined })
  for (let run = 0; run <= 200; run += 1) await parts.fill('ci-watch', `runs ${run}`, { page: 'runs', params: { run } }, 'The runs page')

  expect(parts.element('ci-watch', 'runs 0', 'ci-watch/runs:', 'The runs page', 'page')).toBeUndefined()
  expect(parts.element('ci-watch', 'runs 1', 'ci-watch/runs:', 'The runs page', 'page')).toBeDefined()
  await parts.fill('ci-watch', 'runs 0', { page: 'runs', params: { run: 0 } }, 'The runs page')
  expect(parts.element('ci-watch', 'runs 1', 'ci-watch/runs:', 'The runs page', 'page')).toBeDefined()
  expect(parts.element('ci-watch', 'runs 2', 'ci-watch/runs:', 'The runs page', 'page')).toBeUndefined()
  expect(asked).toHaveLength(202)
})

test('a page keeps the handlers of its newest 200 params, so a page shown again with earlier params still takes a press', async () => {
  let pressed = 0
  const tested = testMod(defineMod({ name: 'pick', setup: (mod) => void mod.sidebar.add<{ readonly run: number }>({ id: 'runs', title: 'Runs', render: () => Button({ key: 'go', label: 'Go', onPress: () => void (pressed += 1) }) }) }))
  await tested.start()
  const draw = async (run: number) => ((await tested.fire('cmod.call', { to: 'pick', method: partMethods.draw, input: { page: 'runs', params: { run }, columns: 80, isFocused: false }, caller: 'cmod' } as never)) as { readonly value: { readonly draw: number } }).value.draw
  const press = (draw: number) => tested.fire('cmod.call', { to: 'pick', method: partMethods.press, input: { draw, handler: 0, args: [] }, caller: 'cmod' } as never)
  const first = await draw(0)
  const second = await draw(1)
  for (let run = 2; run <= 200; run += 1) await draw(run)

  await press(second)
  await tested.settle()

  expect(pressed).toBe(1)
  await expect(press(first)).rejects.toThrow('that button drew before the last redraw')
})

test("a widget's button keeps working however many other drawings come after it", async () => {
  let pressed = 0
  const tested = testMod(
    defineMod({
      name: 'pick',
      setup(mod) {
        mod.widgets.add({ id: 'choice', title: 'Choice', areas: [BelowPrompt], render: () => Button({ key: 'go', label: 'Go', onPress: () => void (pressed += 1) }) })
        mod.widgets.add({ id: 'clock', title: 'Clock', areas: [TurnEnd], render: (_mod, context) => Button({ key: 'turn', label: 'turn' in context ? context.turn.prompt.id : '', onPress: () => undefined }) })
      },
    }),
  )
  await tested.start()
  const drawn = (await tested.fire('cmod.call', { to: 'pick', method: partMethods.draw, input: { widget: 'choice', area: BelowPrompt, columns: 80 }, caller: 'cmod' } as never)) as { readonly value: { readonly draw: number } }
  const turnEnd = (turn: number) => tested.fire('cmod.call', { to: 'pick', method: partMethods.draw, input: { widget: 'clock', area: TurnEnd, columns: 80, turn: { prompt: { id: `p${turn}` } } }, caller: 'cmod' } as never) as Promise<{ readonly value: { readonly draw: number } }>
  const first = await turnEnd(0)
  for (let turn = 1; turn < 600; turn += 1) await turnEnd(turn)
  const recent = await turnEnd(600)

  await tested.fire('cmod.call', { to: 'pick', method: partMethods.press, input: { draw: drawn.value.draw, handler: 0, args: [] }, caller: 'cmod' } as never)
  await tested.fire('cmod.call', { to: 'pick', method: partMethods.press, input: { draw: recent.value.draw, handler: 0, args: [] }, caller: 'cmod' } as never)
  await tested.settle()

  expect(pressed).toBe(1)
  await expect(tested.fire('cmod.call', { to: 'pick', method: partMethods.press, input: { draw: first.value.draw, handler: 0, args: [] }, caller: 'cmod' } as never)).rejects.toThrow('that button drew before the last redraw')
})

test('a draw that was still running when its mod changed is dropped, and the next draw asks again', async () => {
  const { fake, widgets, tell } = servedLayout(layout({ dashboard: [{ left: ['git/branch'], right: [] }] }))
  const answers: ((value: unknown) => void)[] = []
  fake.fakes.cmod.call = (input) => (input.method === partMethods.draw ? new Promise((resolve) => answers.push(resolve)) : Promise.resolve({ widgets: [{ id: 'branch', title: 'Branch', areas: [Dashboard] }], pages: [] }))
  tell('git', [{ id: 'branch', title: 'Branch', areas: [Dashboard] }])
  await fake.settle()

  widgets.rows(Dashboard, 80)
  widgets.update('git', { redraw: true })
  answers.shift()?.({ draw: 1, tree: { $cmodElement: 'Text', props: { children: 'old' } } })
  await fake.settle()
  widgets.rows(Dashboard, 80)

  expect(answers).toHaveLength(1)
})

test('a mod that stops answering after a reload loses its widgets, and one that answers keeps them', async () => {
  const { fake, widgets, tell } = servedLayout(layout({}))
  tell('git', [{ id: 'branch', title: 'Branch', areas: [BelowPrompt] }])
  tell('notes', [{ id: 'count', title: 'Count', areas: [BelowPrompt] }])
  fake.fakes.cmod.call = async ({ to }) => {
    if (to === 'notes') throw new Error('notes is not installed. Install it in Plugins.')
    return { widgets: [{ id: 'branch', title: 'Branch', areas: [BelowPrompt] }], pages: [] }
  }

  await widgets.recheck()

  expect(widgets.widgets().filter((widget) => widget.mod !== 'claude').map((widget) => widget.key)).toEqual(['git/branch'])
})

test('the dashboard stops asking for a redraw when a widget placed there has no running mod', async () => {
  const { fake, widgets } = servedLayout(layout({ dashboard: [{ left: ['gone/status'], right: [] }] }))
  await fake.settle()
  let redraws = 0
  Object.assign(fake.claude.ui, { invalidate: () => void (redraws += 1) })

  widgets.rows(Dashboard, 80)
  widgets.rows(Dashboard, 80)
  await fake.settle()

  expect(redraws).toBe(0)
})

test('a widget draws on the dashboard only once the person moves it there', async () => {
  const branch: PlacedWidget = { key: 'git/branch', mod: 'git', title: 'branch', areas: [BelowPrompt, Dashboard] }
  const start: WidgetLayout = { ...layoutOf({}), areas: { ...layoutOf({}).areas, belowPrompt: [{ left: ['git/branch'], right: [] }] } }

  const down = moved(moved(moved(start, branch, 'down'), branch, 'down'), branch, 'down')

  expect(down.areas.belowPrompt).toEqual([])
  expect(down.areas.dashboard).toEqual([{ left: ['git/branch'], right: [] }])
  expect(moved(down, branch, 'up').areas.belowPrompt).toEqual([{ left: ['git/branch'], right: [] }])
})

test('moving a widget left and right walks it across its row, and down gives it its own row', () => {
  const dirty: PlacedWidget = { key: 'git/dirty', mod: 'git', title: 'dirty', areas: [BelowPrompt] }
  const start: WidgetLayout = { ...layoutOf({}), areas: { ...layoutOf({}).areas, belowPrompt: [{ left: ['git/branch', 'git/dirty'], right: ['git/ahead'] }] } }

  expect(moved(start, dirty, 'left').areas.belowPrompt).toEqual([{ left: ['git/dirty', 'git/branch'], right: ['git/ahead'] }])
  expect(moved(start, dirty, 'right').areas.belowPrompt).toEqual([{ left: ['git/branch'], right: ['git/dirty', 'git/ahead'] }])
  expect(moved(start, dirty, 'down').areas.belowPrompt).toEqual([{ left: ['git/branch'], right: ['git/ahead'] }, { left: ['git/dirty'], right: [] }])
  expect(moved(start, dirty, 'up')).toBe(start)
  const newer = layoutOf({ areas: { belowPrompt: [{ left: ['git/branch'], right: [] }, { left: ['git/dirty'], right: [], center: ['notes/count'] }] } })
  expect(moved(newer, dirty, 'up').areas.belowPrompt).toEqual([{ left: ['git/branch', 'git/dirty'], right: [] }, { left: [], right: [], center: ['notes/count'] }] as never)
  expect(toggled(toggled(start, 'git/dirty'), 'git/dirty').hidden).toEqual([])
})

test('a widget sends the cmod plugin only text, numbers, plain objects, and the elements cmod knows', () => {
  const handlers: ((...args: unknown[]) => unknown)[] = []

  expect(elementData(Text({ children: 'main' }), handlers)).toEqual({ $cmodElement: 'Text', props: { children: 'main' } })
  expect(() => elementData(new Map(), handlers)).toThrow('a widget draws only the elements of ui/elements.js and ui/components.js, text, numbers, and plain objects.')
  expect(() => elementOf({ $cmodElement: 'Script', props: {} }, 'git/branch:', () => {})).toThrow('a widget drew Script, which is not an element of ui/elements.js.')
})
