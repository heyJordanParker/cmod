import { expect, test } from 'bun:test'
import type { Args } from 'claude-code'
import { tool } from '../../src/jobs/tool.js'
import { defineMod, http, process } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'
import { claudeCodeOf } from '../../src/testing/claude-code.js'

test('a call without the required title is denied with title named, and execute never runs', async () => {
  const executed: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'tickets',
      setup(mod) {
        mod.use(
          tool({
            name: 'ticket',
            description: 'Open a ticket',
            inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
            execute: (input) => {
              executed.push(input.title.toUpperCase())
            },
          }),
        )
      },
    }),
  )

  const answer = await tested.callTool('ticket', { body: 'it broke' })

  expect(answer).toEqual({ deny: 'The ticket tool input is not valid:\n- #: Instance does not have required property "title".' })
  expect(executed).toEqual([])
})

test("execute gets the mod's own typed state, so a tool counts its calls without capturing the mod from setup", async () => {
  const tested = testMod(
    defineMod({
      name: 'tickets',
      state: { project: { opened: [] as string[] } },
      setup(mod) {
        mod.use(
          tool({
            name: 'ticket',
            description: 'Open a ticket',
            inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
            execute: (input, own) => {
              own.state.project.opened = [...own.state.project.opened, input.title]
              return `${own.state.project.opened.length} open`
            },
          }),
        )
      },
    }),
  )

  expect(await tested.callTool('ticket', { title: 'Crash' })).toEqual({ result: '1 open' })
  expect(await tested.callTool('ticket', { title: 'Hang' })).toEqual({ result: '2 open' })
  expect(tested.state.project.opened).toEqual(['Crash', 'Hang'])
})

test('execute gets the input without the keys Claude Code adds, and an object result reaches Claude as JSON text', async () => {
  const executed: unknown[] = []
  let handle: { readonly name: string } | undefined
  const tested = testMod(
    defineMod({
      name: 'tickets',
      setup(mod) {
        handle = mod.use(
          tool({
            name: 'ticket',
            description: 'Open a ticket',
            execute: (input) => {
              executed.push(input)
              return { a: 1 }
            },
          }),
        )
      },
    }),
  )

  const answer = await claudeCodeOf(tested).fire('tool.call', { tool: 'mcp__tickets__ticket', tool_use_id: 'toolu_1', agentId: 'a1', consent: 'yes', title: 'Crash' } as Args<'tool.call'>)

  expect(answer).toEqual({ result: '{"a":1}' })
  expect(executed).toEqual([{ title: 'Crash' }])
  expect(handle?.name).toBe('mcp__tickets__ticket')
  expect(tested.shown.toasts.find(({ message }) => message === 'Installed')?.description).toContain('Adds the ticket tool.')
})

test('a call of another tool passes on, and an execute that throws is denied with its message', async () => {
  const tested = testMod(
    defineMod({
      name: 'tickets',
      setup(mod) {
        mod.use(
          tool({
            name: 'ticket',
            description: 'Open a ticket',
            execute: () => {
              throw new Error('the tracker is down')
            },
          }),
        )
      },
    }),
  )

  const below = { result: 'other plugin' }
  expect(await claudeCodeOf(tested).fire('tool.call', { tool: 'mcp__other__ticket', tool_use_id: 'toolu_2' } as Args<'tool.call'>, below)).toBe(below)
  expect(await tested.callTool('ticket', {})).toEqual({ deny: 'The ticket tool failed: the tracker is down' })
})

test('an execute whose fetch passes the 30 s deadline is denied, and the next call runs', async () => {
  const tested = testMod(
    defineMod({
      name: 'tickets',
      setup(mod) {
        mod.use(
          tool({
            name: 'ticket',
            description: 'Open a ticket',
            execute: async (input) => (input['sync'] === true ? (await process.run(['tracker', 'sync'])).stdout : (await http.fetch('https://tracker.example/new')).text),
          }),
        )
      },
    }),
    { permissions: ['network:tracker.example', 'run:tracker'] },
  )
  tested.fakes.http.fetch = () => new Promise(() => undefined)
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: 'synced', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  tested.fakes.clock.after = (ms, fn) => {
    if (ms === 30000) void Promise.resolve().then(fn)
    return { cancel: () => undefined }
  }

  expect(await tested.callTool('ticket', {})).toEqual({ deny: 'The ticket tool failed: the ticket tool passed the 30 s deadline of tool' })
  tested.fakes.clock.after = () => ({ cancel: () => undefined })
  expect(await tested.callTool('ticket', { sync: true })).toEqual({ result: 'synced' })
})

test('an inputSchema with a key Claude Code keeps for itself throws in setup', async () => {
  const tested = testMod(
    defineMod({
      name: 'tickets',
      setup(mod) {
        mod.use(tool({ name: 'ticket', description: 'Open a ticket', inputSchema: { type: 'object', properties: { tool: { type: 'string' } } }, execute: () => undefined }))
      },
    }),
  )

  await expect(tested.start()).rejects.toThrow("tickets: the ticket tool's inputSchema has the property tool, which Claude Code keeps for itself. Rename it.")
})
