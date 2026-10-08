import { expect, test } from 'bun:test'
import type { Args, ElementTable, Frozen, RenderElement } from 'claude-code'
import { defineMod } from '../../src/mod.js'
import { createLifecycle } from '../../src/runtime/lifecycle.js'
import { testMod } from '../../src/testing.js'
import { fakeClaude } from '../../src/testing/fake-claude.js'
import { definePane } from '../../src/ui/define-pane.js'
import { Box, Image, Text } from '../../src/ui/elements.js'

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

test('Image draws', async () => {
  const fake = fakeClaude({ name: 'charts', root: '/test/plugins/charts' })
  fake.claude.ui.resolve = () => ({ Image: (props: object) => ({ type: 'Image', props }) }) as unknown as ElementTable
  const chart = { source: { png: 'iVBORw0KGgo=' }, columns: 40, rows: 12, alt: 'p95 latency' }
  const lifecycle = createLifecycle(
    defineMod({
      name: 'charts',
      async setup(mod) {
        await mod.ui.pane(definePane({ id: 'chart', title: 'Chart', render: () => Image(chart) })).open()
      },
    }),
  )
  await lifecycle.start(fake.claude, async () => ({ name: 'charts', root: '/test/plugins/charts', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {}, granted: [] }))
  const pane = { surface: 'terminal', component: 'Pane', requestId: 'chart', props: { title: 'Chart', isFocused: false, bodyColumns: 80, placement: 'dock' } } as Frozen<Args<'ui.render'>>

  expect(await lifecycle.route('ui.render', pane, async () => Box({}))).toEqual({ type: 'Image', props: chart } as unknown as RenderElement)
})
