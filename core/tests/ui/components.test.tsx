import { expect, test } from 'bun:test'
import { defineMod } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'
import { Dialog, Help, Pagination, Panel, Progress, Split, Tabs, Toggle, Tooltip } from '../../src/ui/components.js'
import { Box, Button, Text } from '../../src/ui/elements.js'

const tabs = [
  { key: 'controls', label: 'Controls' },
  { key: 'split', label: 'Split' },
]

const kit = defineMod({
  name: 'kit',
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
  expect(await testMod(kit).shown.pane.lines()).toContain('██░░░░░░')
})

test('Pagination steps forward, and draws an end it cannot pass as text', async () => {
  const tested = testMod(kit)
  expect(await tested.shown.pane.lines()).toContain('p: Previous  1 of 2  n: Next')

  await tested.shown.pane.press('Next')

  expect(tested.state.session.page).toBe(2)
  expect(await tested.shown.pane.lines()).toContain('p: Previous  2 of 2  n: Next')
  await expect(tested.shown.pane.press('Next')).rejects.toThrow('The pane "kit" of kit draws no Button with the key or label "Next".')
})

test('Dialog draws its title, body, and actions in order', async () => {
  const tested = testMod(
    defineMod({
      name: 'confirm',
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
