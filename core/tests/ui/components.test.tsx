import { expect, test } from 'bun:test'
import { defineMod } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'
import { Dialog, Help, Pagination, Panel, ProgressBar, Split, Tabs, Toggle, Tooltip } from '../../src/ui/components.js'
import { definePane } from '../../src/ui/define-pane.js'
import { Box, Button, Text } from '../../src/ui/elements.js'

type KitState = { session: { tab: string; showHidden: boolean; isHelpOpen: boolean; page: number } }

const tabs = [
  { key: 'controls', label: 'Controls' },
  { key: 'split', label: 'Split' },
]

const kit = defineMod({
  name: 'kit',
  state: { session: { tab: 'controls', showHidden: false, isHelpOpen: false, page: 1 } },
  async setup(mod) {
    await mod.ui
      .pane(
        definePane<KitState>({
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
                  <ProgressBar done={1} total={4} width={8} />
                  <Pagination page={session.page} pages={2} onPage={(page) => void (session.page = page)} />
                </Box>
              )}
            </Tabs>
          ),
        }),
      )
      .open()
  },
})

test('Tabs draws the active tab as text and the others as hotkey buttons that switch to them', async () => {
  const tested = testMod(kit)
  expect((await tested.lines('kit'))[0]).toBe('1: Controls   2: Split')

  await tested.press('kit', 'Split')

  expect(tested.state.session.tab).toBe('split')
  expect(await tested.lines('kit')).toEqual(['1: Controls   2: Split', '', ' Changed files  Preview', ' src/mod.tsx    12 lines'])
})

test('Tabs numbers only the first nine tabs, because a hotkey is one digit', async () => {
  const many = [...'abcdefghij'].map((letter, index) => ({ key: `t${index + 1}`, label: letter }))
  const tested = testMod(
    defineMod({
      name: 'many',
      state: { session: { tab: 't10' } },
      async setup(mod) {
        await mod.ui
          .pane(
            definePane<{ session: { tab: string } }>({
              id: 'many',
              title: 'Many',
              render: ({ state: { session } }) => <Tabs tabs={many} selected={session.tab} onSelect={(tab) => void (session.tab = tab)} />,
            }),
          )
          .open()
      },
    }),
  )

  expect((await tested.lines('many'))[0]).toBe('1: a   2: b   3: c   4: d   5: e   6: f   7: g   8: h   9: i   j')
  await tested.press('many', 'a')
  expect((await tested.lines('many'))[0]).toBe('1: a   2: b   3: c   4: d   5: e   6: f   7: g   8: h   9: i   j')
  expect(tested.state.session.tab).toBe('t1')
})

test('Toggle flips its checked state on a press', async () => {
  const tested = testMod(kit)
  expect(await tested.lines('kit')).toContain('[ ] Show hidden files ?')

  await tested.press('kit', '[ ] Show hidden files')

  expect(tested.state.session.showHidden).toBe(true)
  expect(await tested.lines('kit')).toContain('[x] Show hidden files ?')
})

test('Help shows its card only while open, and a press of ? opens it', async () => {
  const tested = testMod(kit)
  expect(await tested.lines('kit')).not.toContain('Hidden files start with a dot.')

  await tested.press('kit', 'help-button:Hidden files start with a dot.')

  expect(tested.state.session.isHelpOpen).toBe(true)
  expect((await tested.lines('kit')).join('\n')).toContain('Hidden files start with a dot.')
})

test('Tooltip draws its children and keeps its card for the pointer alone', async () => {
  const lines = await testMod(kit).lines('kit')

  expect(lines).toContain('3 read')
  expect(lines.join('\n')).not.toContain('Files Claude read')
})

test('ProgressBar fills its width in proportion and shows the count', async () => {
  expect(await testMod(kit).lines('kit')).toContain('██░░░░░░  1/4')
})

test('Pagination steps forward, and draws an end it cannot pass as text', async () => {
  const tested = testMod(kit)
  expect(await tested.lines('kit')).toContain('p: Previous  1 of 2  n: Next')

  await tested.press('kit', 'Next')

  expect(tested.state.session.page).toBe(2)
  expect(await tested.lines('kit')).toContain('p: Previous  2 of 2  n: Next')
  await expect(tested.press('kit', 'Next')).rejects.toThrow('The pane "kit" of kit draws no Button with the key or label "Next".')
})

test('Dialog draws its title, body, and actions in order', async () => {
  const tested = testMod(
    defineMod({
      name: 'confirm',
      state: { session: { kept: 0 } },
      async setup(mod) {
        await mod.ui
          .pane(
            definePane<{ session: { kept: number } }>({
              id: 'confirm',
              title: 'Delete branch',
              closeOnEscape: true,
              render: ({ state: { session } }) => (
                <Dialog title="Delete feature/kit?" actions={[<Button variant="primary" autoFocus label="Keep it" onPress={() => void (session.kept += 1)} />, <Button label="Delete" onPress={() => undefined} />]}>
                  <Text>Its 3 commits are not on main.</Text>
                </Dialog>
              ),
            }),
          )
          .open({ focus: true })
      },
    }),
  )

  expect(await tested.lines('confirm')).toEqual([' Delete feature/kit?', '', ' Its 3 commits are not on main.', '', ' [ Keep it ]  [ Delete ]'])
  await tested.press('confirm', 'Keep it')
  expect(tested.state.session.kept).toBe(1)
})
