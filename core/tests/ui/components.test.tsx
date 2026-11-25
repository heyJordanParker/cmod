import { expect, test } from 'bun:test'
import { defineMod } from '../../src/mod.js'
import { isNerdFontTerminal } from '../../src/records.js'
import { testMod } from '../../src/testing.js'
import { Badge, Banner, Dialog, Help, List, ListItem, Pagination, Panel, Progress, Split, Tabs, Toggle, Tooltip } from '../../src/ui/components.js'
import { Box, Button, drawWith, elementData, elementOf, forClaudeCode, Text } from '../../src/ui/elements.js'

const tabs = [
  { key: 'controls', label: 'Controls' },
  { key: 'split', label: 'Split' },
]

const kit = defineMod({
  name: 'demo',
  state: { session: { tab: 'controls', showHidden: false, isHelpOpen: false, page: 1 } },
  async setup(mod) {
    await mod.panes
      .add({
        id: 'kit',
        title: 'Kit',
        render: ({ state: { session } }) => (
          <Tabs tabs={tabs} selected={session.tab} onSelect={(tab) => void (session.tab = tab)}>
            {session.tab === 'split' ? (
              <Split>
                <Panel title="Changed files">
                  <Text>src/mod.tsx</Text>
                </Panel>
                <Panel title="Preview">
                  <Text>12 lines</Text>
                </Panel>
              </Split>
            ) : (
              <Box flexDirection="column">
                <Box gap={1}>
                  <Toggle label="Show hidden files" checked={session.showHidden} onChange={(checked) => void (session.showHidden = checked)} />
                  <Help text="Hidden files start with a dot." isOpen={session.isHelpOpen} onOpenChange={(isOpen) => void (session.isHelpOpen = isOpen)} />
                </Box>
                <Tooltip text="Files Claude read">
                  <Text>3 read</Text>
                </Tooltip>
                <Progress value={25} width={8} />
                <Pagination page={session.page} pages={2} onPage={(page) => void (session.page = page)} />
              </Box>
            )}
          </Tabs>
        ),
      })
      .open()
  },
})

test('Tabs draws the active tab as text and the others as buttons that switch to them, with no hotkeys of its own', async () => {
  const tested = testMod(kit)
  expect((await tested.shown.pane.lines())[0]).toBe('Controls   Split')

  await tested.shown.pane.press('Split')

  expect(tested.state.session.tab).toBe('split')
  expect(await tested.shown.pane.lines()).toEqual(['Controls   Split', '', '╭─ Changed files ─╮ ╭─ Preview ─╮', '│ src/mod.tsx     │ │ 12 lines  │', '╰─────────────────╯ ╰───────────╯'])
})

test('a tab given a hotkey draws it before its label and keeps it on the button', async () => {
  const keyed = [
    { key: 'open', label: 'Open', hotkey: 'o' },
    { key: 'done', label: 'Done', hotkey: 'd' },
    { key: 'all', label: 'All' },
  ]
  const tested = testMod(
    defineMod({
      name: 'keyed',
      state: { session: { tab: 'open' } },
      async setup(mod) {
        await mod.panes.add({ id: 'keyed', title: 'Keyed', render: ({ state: { session } }) => <Tabs tabs={keyed} selected={session.tab} onSelect={(tab) => void (session.tab = tab)} /> }).open()
      },
    }),
  )

  expect((await tested.shown.pane.lines())[0]).toBe('o: Open   d: Done   All')
  await tested.shown.pane.press('Done')
  expect((await tested.shown.pane.lines())[0]).toBe('o: Open   d: Done   All')
  expect(tested.state.session.tab).toBe('done')
})

test('Toggle flips its checked state on a press', async () => {
  const tested = testMod(kit)
  expect(await tested.shown.pane.lines()).toContain('[ ] Show hidden files ?')

  await tested.shown.pane.press('[ ] Show hidden files')

  expect(tested.state.session.showHidden).toBe(true)
  expect(await tested.shown.pane.lines()).toContain('[x] Show hidden files ?')
})

test('Help shows its card only while open, and a press of ? opens it', async () => {
  const tested = testMod(kit)
  expect(await tested.shown.pane.lines()).not.toContain('Hidden files start with a dot.')

  await tested.shown.pane.press('help-button:Hidden files start with a dot.')

  expect(tested.state.session.isHelpOpen).toBe(true)
  expect((await tested.shown.pane.lines()).join('\n')).toContain('Hidden files start with a dot.')
})

test('Tooltip draws its children and keeps its card for the pointer alone', async () => {
  const lines = await testMod(kit).shown.pane.lines()

  expect(lines).toContain('3 read')
  expect(lines.join('\n')).not.toContain('Files Claude read')
})

test('Progress fills its width in proportion to its percent', async () => {
  expect(await testMod(kit).shown.pane.lines()).toContain('████████')
  expect(cells(drawWith(table, () => Progress({ value: 25, width: 8 })))).toEqual([
    ['██', 'claude'],
    ['██████', 'subtle'],
  ])
})

test('Progress draws its sections left to right in their tones, and fills no more than its width when they add past 100', async () => {
  const tested = testMod(
    defineMod({
      name: 'demo',
      setup: (mod) =>
        void mod.panes.add({
          id: 'usage',
          title: 'Usage',
          render: () => (
            <Box flexDirection="column">
              <Progress sections={[{ value: 50 }, { value: 25, tone: 'warning' }]} width={8} label="Week used" />
              <Progress sections={[{ value: 75 }, { value: 50, tone: 'critical' }]} width={8} />
              <Progress value={50} tone="success" width={4} />
            </Box>
          ),
        }).open(),
    }),
  )

  await tested.start()

  expect((await tested.shown.pane.lines()).slice(0, 3)).toEqual(['████████', '████████', '████'])
  expect(cells(drawWith(table, () => Progress({ sections: [{ value: 75 }, { value: 50, tone: 'critical' }], width: 8 })))).toEqual([
    ['██████', 'claude'],
    ['██', 'error'],
  ])
  expect(cells(drawWith(table, () => Progress({ value: 50, tone: 'success', width: 4 })))).toEqual([
    ['██', 'success'],
    ['██', 'subtle'],
  ])
})

const table = { Box: (props: object) => ({ type: 'Box', props }), Text: (props: object) => ({ type: 'Text', props }), Button: (props: object) => ({ type: 'Button', props }) } as never

type DrawnText = { readonly props: { readonly children: readonly { readonly props: { readonly color: string; readonly backgroundColor?: string; readonly children: string } }[] } }

const cells = (drawn: unknown) => (drawn as DrawnText).props.children.map(({ props }) => (props.backgroundColor === undefined ? [props.children, props.color] : [props.children, props.color, props.backgroundColor]))

test('Progress draws a section given a Claude Code color in it, and splits both the fill and the buffer mid-cell', () => {
  const withNerdFont = forClaudeCode(table, 'terminal', () => undefined, { hasNerdFont: true })

  expect(cells(drawWith(withNerdFont, () => Progress({ sections: [{ value: 50, tone: 'critical' }, { value: 45, color: 'diffRemoved' }], buffer: 50, width: 22 })))).toEqual([
    ['\u{E0B6}', 'error'],
    ['██████████', 'error'],
    ['█████████', 'diffRemoved'],
    ['█', 'subtle'],
    ['\u{E0B4}', 'subtle'],
  ])
  expect(cells(drawWith(withNerdFont, () => Progress({ sections: [{ value: 33, tone: 'neutral' }], buffer: 50, width: 23 })))).toEqual([
    ['\u{E0B6}', 'inactive'],
    ['██████', 'inactive'],
    ['▉', 'inactive', 'promptBorder'],
    ['███', 'promptBorder'],
    ['▌', 'promptBorder', 'subtle'],
    ['██████████', 'subtle'],
    ['\u{E0B4}', 'subtle'],
  ])
})

test('a terminal has Nerd Font half circles in Herdr, Ghostty, and WezTerm, also inside tmux, which keeps Ghostty and WezTerm variables', () => {
  expect([{ program: 'herdr' }, { program: 'ghostty' }, { program: 'WezTerm' }, { program: 'tmux', ghostty: '/Applications/Ghostty.app/Contents/Resources/ghostty' }, { program: 'tmux', wezterm: '/Applications/WezTerm.app/Contents/MacOS/wezterm-gui' }, { program: 'tmux' }, { program: 'Apple_Terminal' }, {}].map(isNerdFontTerminal)).toEqual([true, true, true, true, true, false, false, false])
})

test('Progress splits a cell at an eighth where two parts meet, draws its buffer as raised track, and rounds its ends in a terminal whose font has the half circles', () => {
  const underPace = () => Progress({ sections: [{ value: 33, tone: 'neutral' }], buffer: 50, width: 22 })
  const overPace = () => Progress({ sections: [{ value: 50, tone: 'neutral' }, { value: 20, tone: 'warning' }], buffer: 50, width: 22 })
  const withNerdFont = forClaudeCode(table, 'terminal', () => undefined, { hasNerdFont: true })

  expect(cells(drawWith(withNerdFont, underPace))).toEqual([
    ['\u{E0B6}', 'inactive'],
    ['██████', 'inactive'],
    ['▋', 'inactive', 'promptBorder'],
    ['███', 'promptBorder'],
    ['██████████', 'subtle'],
    ['\u{E0B4}', 'subtle'],
  ])
  expect(cells(drawWith(withNerdFont, overPace))).toEqual([
    ['\u{E0B6}', 'inactive'],
    ['██████████', 'inactive'],
    ['████', 'warning'],
    ['██████', 'subtle'],
    ['\u{E0B4}', 'subtle'],
  ])
  expect(cells(drawWith(forClaudeCode(table, 'terminal', () => undefined, { hasNerdFont: false }), () => Progress({ value: 33, buffer: 50, width: 20 })))).toEqual([
    ['██████', 'claude'],
    ['▋', 'claude', 'promptBorder'],
    ['███', 'promptBorder'],
    ['██████████', 'subtle'],
  ])
})

test('Pagination steps forward, and draws an end it cannot pass as text', async () => {
  const tested = testMod(kit)
  expect(await tested.shown.pane.lines()).toContain('p: Previous  1 of 2  n: Next')

  await tested.shown.pane.press('Next')

  expect(tested.state.session.page).toBe(2)
  expect(await tested.shown.pane.lines()).toContain('p: Previous  2 of 2  n: Next')
  await expect(tested.shown.pane.press('Next')).rejects.toThrow('The pane "kit" of demo draws no Button with the key or label "Next".')
})

test('Dialog draws its title, body, and actions in order', async () => {
  const tested = testMod(
    defineMod({
      name: 'demo',
      state: { session: { kept: 0 } },
      async setup(mod) {
        await mod.panes
          .add({
            id: 'confirm',
            title: 'Delete branch',
            closeOnEscape: true,
            render: ({ state: { session } }) => (
              <Dialog title="Delete feature/kit?" actions={[<Button variant="primary" autoFocus label="Keep it" onPress={() => void (session.kept += 1)} />, <Button label="Delete" onPress={() => undefined} />]}>
                <Text>Its 3 commits are not on main.</Text>
              </Dialog>
            ),
          })
          .open({ focus: true })
      },
    }),
  )

  expect(await tested.shown.pane.lines()).toEqual([' Delete feature/kit?', '', ' Its 3 commits are not on main.', '', ' [ Keep it ]  [ Delete ]'])
  await tested.shown.pane.press('Keep it')
  expect(tested.state.session.kept).toBe(1)
})

test('Tabs reaches every other app as one Tabs element whose tabs each carry their own press', () => {
  const handlers: (() => unknown)[] = []
  const picked: string[] = []

  const data = elementData(Tabs({ tabs, selected: 'controls', onSelect: (tab) => void picked.push(tab) }), (run) => handlers.push(run) - 1)
  handlers[1]?.()

  expect(data).toEqual({
    $cmodElement: 'Tabs',
    props: {
      key: '',
      tabs: [
        { key: 'controls', label: 'Controls', isSelected: true, onSelect: { $cmodHandler: 0 } },
        { key: 'split', label: 'Split', isSelected: false, onSelect: { $cmodHandler: 1 } },
      ],
    },
  })
  expect(picked).toEqual(['split'])
})

test('a host component that arrives as data draws in the terminal as the mod drew it, with its keys under the part', async () => {
  const drawn = () => (
    <Box flexDirection="column">
      <Tabs tabs={tabs} selected="controls" onSelect={() => undefined} />
      <Toggle label="Show hidden files" checked onChange={() => undefined} />
    </Box>
  )
  const tested = testMod(
    defineMod({
      name: 'demo',
      async setup(mod) {
        await mod.panes.add({ id: 'direct', title: 'Direct', render: drawn }).open()
      },
    }),
  )
  const data = elementData(drawn(), () => 0)
  const roundTrip = testMod(
    defineMod({
      name: 'demo',
      async setup(mod) {
        await mod.panes.add({ id: 'data', title: 'Data', render: () => elementOf(data, 'demo/data:', () => undefined) as JSX.Element }).open()
      },
    }),
  )

  expect(await roundTrip.shown.pane.lines()).toEqual(await tested.shown.pane.lines())
  await roundTrip.shown.pane.press('demo/data:tab:split')
})

test('List, ListItem, Badge, and Banner draw a list of rows, a toned word, and a notice with its actions in the terminal', async () => {
  const tested = testMod(
    defineMod({
      name: 'demo',
      state: { session: { picked: '' } },
      async setup(mod) {
        await mod.panes
          .add({
            id: 'mods',
            title: 'Mods',
            render: ({ state: { session } }) => (
              <Box flexDirection="column" gap={1}>
                <List label="Mods">
                  <ListItem key="mod:cmod" label="cmod" tone="neutral" isSelected />
                  <ListItem key="mod:demo" label="demo" tone="warning" onPress={() => void (session.picked = 'demo')} />
                  <ListItem key="mod:old" label="old" description="(off)" tone="off" onPress={() => void (session.picked = 'old')} />
                </List>
                <Box gap={1}>
                  <Text>demo</Text>
                  <Badge tone="warning">warning</Badge>
                </Box>
                <Banner tone="warning" actions={[<Button key="finish" label="Finish setup" onPress={() => undefined} />]}>
                  Needs setup: Choose a branch
                </Banner>
              </Box>
            ),
          })
          .open()
      },
    }),
  )

  expect(await tested.shown.pane.lines()).toEqual([' ● cmod', ' ● demo', ' ○ old (off)', '', 'demo warning', '', 'Needs setup: Choose a branch', '[ Finish setup ]'])
  await tested.shown.pane.press('mod:demo')
  expect(tested.state.session.picked).toBe('demo')
})

test('a ListItem given a depth draws a row of a tree: indented, with its ▸ or ▾ that opens it, its leading text, and its trailing badge at the right edge', async () => {
  const tested = testMod(
    defineMod({
      name: 'demo',
      state: { session: { isOpen: false, pressed: '' } },
      async setup(mod) {
        await mod.panes
          .add({
            id: 'runs',
            title: 'Runs',
            render: ({ state: { session } }) => (
              <Box flexDirection="column" width={40}>
                <List label="Runs">
                  <ListItem key="run:1" leading="12:05" label="fix the login bug" depth={0} isOpen={session.isOpen} onOpenChange={(isOpen) => void (session.isOpen = isOpen)} trailing={<Badge tone="critical">1 failed</Badge>} onPress={() => void (session.pressed = 'run:1')} />
                  {session.isOpen ? <ListItem key="run:2" leading="Bash" label="bun test" depth={1} /> : null}
                </List>
              </Box>
            ),
          })
          .open()
      },
    }),
  )

  const closed = await tested.shown.pane.lines()
  await tested.shown.pane.press('run:1:toggle')
  const opened = await tested.shown.pane.lines()
  await tested.shown.pane.press('run:1')

  expect(closed).toEqual(['▸ 12:05 fix the login bug       1 failed'])
  expect(opened).toEqual(['▾ 12:05 fix the login bug       1 failed', '    Bash bun test'])
  expect(tested.state.session.pressed).toBe('run:1')
})

test('a Panel given a description and actions draws them on its first line, and a tree row draws its description at the right edge', async () => {
  const tested = testMod(
    defineMod({
      name: 'demo',
      async setup(mod) {
        await mod.panes
          .add({
            id: 'page',
            title: 'Page',
            render: () => (
              <Box flexDirection="column" width={40}>
                <Panel title="demo" description="0.2.0" actions={[<Button plain key="turn" label="Turn off" onPress={() => undefined} />]}>
                  <ListItem key="run:1" label="fix the login bug" description="12:05" depth={0} />
                </Panel>
              </Box>
            ),
          })
          .open()
      },
    }),
  )

  expect(await tested.shown.pane.lines()).toEqual(['╭─ demo ───────────────────────────────╮', '│ 0.2.0                       Turn off │', '│                                      │', '│   fix the login bug            12:05 │', '╰──────────────────────────────────────╯'])
})

test('drawWith lowers a host component with the table it draws with', () => {
  const table = { Box: (props: object) => ({ type: 'Box', props }), Text: (props: object) => ({ type: 'Text', props }), Button: (props: object) => ({ type: 'Button', props }) } as never

  expect(drawWith(table, () => Badge({ tone: 'critical', children: 'failed' }))).toEqual({ type: 'Text', props: { color: 'error', children: 'failed' } } as never)
})
