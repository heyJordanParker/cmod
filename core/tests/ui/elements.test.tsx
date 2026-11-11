import { expect, test } from 'bun:test'
import type { Args, ElementTable, Frozen, RenderElement } from 'claude-code'
import { defineMod } from '../../src/mod.js'
import { createLifecycle } from '../../src/runtime/lifecycle.js'
import { testMod } from '../../src/testing.js'
import { fakeClaude } from '../../src/testing/fake-claude.js'
import { Box, Button, Image, Svg, Text } from '../../src/ui/elements.js'

function Count({ count }: { readonly count: number }): JSX.Element {
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

test("a Button with an https href draws as the desktop app's own link, and one with another href as a button that copies it there", async () => {
  const fake = fakeClaude({ name: 'docs', root: '/test/plugins/docs' })
  fake.claude.ui.resolve = () => ({ Box: (props: object) => ({ type: 'Box', props }), Button: (props: object) => ({ type: 'Button', props }), Link: (props: object) => ({ type: 'Link', props }) }) as unknown as ElementTable
  const lifecycle = createLifecycle(
    defineMod({
      name: 'docs',
      async setup(mod) {
        await mod.panes
          .add({
            id: 'docs',
            title: 'Docs',
            render: () => (
              <Box>
                <Button href="https://example.com/docs" label="Open the docs" />
                <Button href="http://127.0.0.1:4567/" label="Open the app" />
              </Box>
            ),
          })
          .open()
      },
    }),
  )
  await lifecycle.start(fake.claude, async () => ({ name: 'docs', root: '/test/plugins/docs', version: '1.0.0', store: '/test/store', isInstalled: true, shouldRecord: false, steps: {} }))
  const pane = { surface: 'desktop', component: 'Pane', requestId: 'docs', props: { title: 'Docs', isFocused: false, bodyColumns: 80, placement: 'dock' } } as Frozen<Args<'ui.render'>>

  const drawn = (await lifecycle.route('ui.render', pane, async () => Box({}))) as unknown as { readonly props: { readonly children: readonly { readonly type: string; readonly props: Record<string, unknown> }[] } }
  const [link, button] = drawn.props.children
  const press = button?.props['onPress'] as (press: object) => Promise<void>
  await press({ plugin: 'docs', element: 'Open the app', component: 'Pane', requestId: 'docs', surface: 'desktop' })
  await fake.settle()

  expect(link).toEqual({ type: 'Link', props: { href: 'https://example.com/docs', label: 'Open the docs' } })
  expect(button?.type).toBe('Button')
  expect(fake.calls.filter((call) => call.call === 'ui.copy').map((call) => call.args)).toEqual([[{ text: 'http://127.0.0.1:4567/', surface: 'desktop' }]])
})
