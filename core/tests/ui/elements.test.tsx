import { expect, test } from 'bun:test'
import type { Args, ElementTable, Frozen, RenderElement } from 'claude-code'
import { defineMod } from '../../src/mod.js'
import { createLifecycle } from '../../src/runtime/lifecycle.js'
import { testMod } from '../../src/testing.js'
import { fakeClaude } from '../../src/testing/fake-claude.js'
import { Box, Image, Svg, Text } from '../../src/ui/elements.js'

function Count({ count }: { readonly count: number }): RenderElement {
  return <Text bold>Count: {count}</Text>
}

const counter = defineMod({
  name: 'counter',
  state: { session: { count: 2 } },
  async setup(mod) {
    const pane = mod.panes.add({
      id: 'counter',
      title: 'Counter',
      render: (current) => (
        <Box flexDirection="column">
          <Count count={current.state.session.count} />
        </Box>
      ),
    })
    await pane.open()
  },
})

test('a component imports Box and draws without receiving the element table', async () => {
  const tested = testMod(counter)

  expect(await tested.shown.pane.lines()).toEqual(['Count: 2'])
})

test('an element built outside a render draws once a render places it', async () => {
  const early = (
    <Box flexDirection="column">
      <Count count={7} />
      <Text>built at setup</Text>
    </Box>
  )
  const tested = testMod(
    defineMod({
      name: 'early',
      async setup(mod) {
        await mod.panes.add({ id: 'early', title: 'Early', render: () => early }).open()
      },
    }),
  )

  expect(await tested.shown.pane.lines()).toEqual(['Count: 7', 'built at setup'])
})

test('a pane that draws Svg draws under test, with nothing of the Svg in the terminal', async () => {
  const tested = testMod(
    defineMod({
      name: 'charts',
      async setup(mod) {
        await mod.panes
          .add({
            id: 'chart',
            title: 'Chart',
            render: () => (
              <Box flexDirection="column">
                <Text>p95 latency</Text>
                <Svg source="<svg/>" alt="p95 latency" />
              </Box>
            ),
          })
          .open()
      },
    }),
  )

  expect(await tested.shown.pane.lines()).toEqual(['p95 latency'])
})

test('Image draws', async () => {
  const fake = fakeClaude({ name: 'charts', root: '/test/plugins/charts' })
  fake.claude.ui.resolve = () => ({ Image: (props: object) => ({ type: 'Image', props }) }) as unknown as ElementTable
  const chart = { source: { png: 'iVBORw0KGgo=' }, columns: 40, rows: 12, alt: 'p95 latency' }
  const lifecycle = createLifecycle(
    defineMod({
      name: 'charts',
      async setup(mod) {
        await mod.panes.add({ id: 'chart', title: 'Chart', render: () => Image(chart) }).open()
      },
    }),
  )
  await lifecycle.start(fake.claude, async () => ({ name: 'charts', root: '/test/plugins/charts', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {} }))
  const pane = { surface: 'terminal', component: 'Pane', requestId: 'chart', props: { title: 'Chart', isFocused: false, bodyColumns: 80, placement: 'dock' } } as Frozen<Args<'ui.render'>>

  expect(await lifecycle.route('ui.render', pane, async () => Box({}))).toEqual({ type: 'Image', props: chart } as unknown as RenderElement)
})
