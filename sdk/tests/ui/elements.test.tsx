import { expect, test } from 'bun:test'
import type { RenderElement } from 'claude-code'
import { defineMod } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'
import { definePane } from '../../src/ui/define-pane.js'
import { Box, Text } from '../../src/ui/elements.js'

type CounterState = { session: { count: number } }

function Count({ count }: { readonly count: number }): RenderElement {
  return <Text bold>Count: {count}</Text>
}

const counter = defineMod({
  name: 'counter',
  state: { session: { count: 2 } },
  async setup(mod) {
    const pane = mod.ui.pane(
      definePane<CounterState>({
        id: 'counter',
        title: 'Counter',
        render: (mod) => (
          <Box flexDirection="column">
            <Count count={mod.state.session.count} />
          </Box>
        ),
      }),
    )
    await pane.open()
  },
})

test('a component imports Box and draws without receiving the element table', async () => {
  const tested = testMod(counter)

  expect(await tested.lines('counter')).toEqual(['Count: 2'])
})

test("an element called outside a render throws with the element's name", async () => {
  expect(() => Text({ children: 'early' })).toThrow("Text was called outside a render. Use it inside a pane's render or a slot's component.")

  const tested = testMod(counter)
  await tested.lines('counter')

  expect(() => Box({})).toThrow("Box was called outside a render. Use it inside a pane's render or a slot's component.")
})
