import { expect, test } from 'bun:test'
import { join } from 'node:path'

type Message = { readonly type: string; readonly [key: string]: unknown }
type Effect = { readonly type: string; readonly method?: string; readonly params?: unknown; readonly ok?: Message | null; readonly failed?: Message | null; readonly [key: string]: unknown }
type Model = { readonly target: string | null; readonly tab: string | null; readonly [key: string]: unknown }
type Screen = { readonly kind: string; readonly isQuiet?: boolean; readonly message?: string; readonly problem?: string | null; readonly parts?: readonly { readonly key: string; readonly drawn: { readonly tree: unknown; readonly error: string | null } | null }[]; readonly views?: readonly object[] }
type Panel = {
  init(given: object): Model
  update(model: Model, message: Message): [Model, Effect[]]
  screen(model: Model): Screen
}

const panel = (await import(join(import.meta.dir, '..', '..', 'herdr', 'cmod', 'panel.js'))) as Panel

const views = [
  { mod: 'cmod', id: 'dashboard', title: 'Dashboard' },
  { mod: 'cmod', id: 'settings', title: 'Settings' },
]

const tree = (text: string) => ({ $cmodElement: 'Text', props: { children: text } })

function driven(given: object = {}) {
  let model = panel.init({ client: 'herdr-test', ...given })
  const sent: Effect[] = []
  const send = (message: Message) => {
    const [next, effects] = panel.update(model, message)
    model = next
    sent.push(...effects)
    return effects
  }
  const calls = (method: string) => sent.filter((effect) => effect.type === 'call' && effect.method === method)
  const answer = (effect: Effect, result: unknown) => send({ ...(effect.ok as Message), result })
  const refuse = (effect: Effect, error: string) => send({ ...(effect.failed as Message), error })
  const pending = (method: string, session: string) => calls(method).filter((effect) => (effect.params as readonly unknown[])[0] === session)
  return { send, sent, calls, answer, refuse, pending, model: () => model, screen: () => panel.screen(model) }
}

function shown(session: string, given: object = {}) {
  const run = driven(given)
  run.send({ type: 'connected' })
  run.send({ type: 'focused', session, now: 0 })
  run.answer(run.pending('cmod/UI.views', session).at(-1) as Effect, views)
  run.answer(run.pending('cmod/UI.pages', session).at(-1) as Effect, [])
  run.answer(run.pending('cmod/UI.draw', session).at(-1) as Effect, tree(`${session} dashboard`))
  return run
}

test("a refusal an older session's request brings back after the panel moved on never shows over the session it shows now", () => {
  const run = shown('valid')
  run.send({ type: 'focused', session: 'older', now: 10 })
  const olderViews = run.pending('cmod/UI.views', 'older').at(-1) as Effect
  run.send({ type: 'focused', session: 'valid', now: 20 })

  run.refuse(olderViews, 'Session older runs here, but no cmod plugin of 7.0.0 or later in it reaches cmod serve.')

  expect(run.screen()).toMatchObject({ kind: 'ready', problem: null, parts: [{ key: 'cmod/dashboard', drawn: { tree: tree('valid dashboard'), error: null } }] })
})

test('a reply to an earlier request for the same session changes nothing once a newer request for it went out', () => {
  const run = shown('valid')
  const first = run.pending('cmod/UI.draw', 'valid').at(-1) as Effect
  run.send({ type: 'heard', event: 'Redraw', payload: { session: 'valid', mod: 'cmod', id: 'dashboard' } })
  const second = run.pending('cmod/UI.draw', 'valid').at(-1) as Effect

  run.answer(second, tree('newer'))
  run.answer(first, tree('older'))

  expect(run.screen().parts?.[0]?.drawn?.tree).toEqual(tree('newer'))
})

test('a session the panel showed before shows its last drawing at once when the panel comes back to it, and draws it again behind it', () => {
  const run = shown('first')
  run.send({ type: 'focused', session: 'second', now: 10 })
  const asked = run.calls('cmod/UI.views').length

  run.send({ type: 'focused', session: 'first', now: 20 })

  expect(run.screen()).toMatchObject({ kind: 'ready', parts: [{ key: 'cmod/dashboard', drawn: { tree: tree('first dashboard') } }] })
  expect(run.calls('cmod/UI.views')).toHaveLength(asked + 1)
})

test("a session refused because its cmod plugin was gone shows its views once the plugin holds it again, as after /reload-plugins, with no press on Try again", () => {
  const run = driven()
  run.send({ type: 'connected' })
  run.send({ type: 'focused', session: 'reloaded', now: 0 })
  run.refuse(run.pending('cmod/UI.views', 'reloaded').at(-1) as Effect, 'Session reloaded runs here, but no cmod plugin of 7.0.0 or later in it reaches cmod serve.')
  expect(run.screen().kind).toBe('refused')

  run.send({ type: 'heard', event: 'Change', payload: { session: 'reloaded', part: 'views' } })
  run.answer(run.pending('cmod/UI.views', 'reloaded').at(-1) as Effect, views)
  run.answer(run.pending('cmod/UI.pages', 'reloaded').at(-1) as Effect, [])
  run.answer(run.pending('cmod/UI.draw', 'reloaded').at(-1) as Effect, tree('back'))

  expect(run.screen()).toMatchObject({ kind: 'ready', problem: null, parts: [{ drawn: { tree: tree('back') } }] })
})

test('a session the panel has never drawn shows nothing for the first 400 ms, then a loading state', () => {
  const run = driven()
  run.send({ type: 'connected' })
  run.send({ type: 'focused', session: 'new', now: 1000 })

  expect(run.screen()).toEqual({ kind: 'loading', isQuiet: true, problem: null })
  run.send({ type: 'tick', now: 1500 })
  expect(run.screen()).toEqual({ kind: 'loading', isQuiet: false, problem: null })
})

test('the selected tab stays selected across sessions that list it', () => {
  const run = shown('first')
  run.send({ type: 'select', key: 'cmod/settings' })
  run.answer(run.pending('cmod/UI.draw', 'first').at(-1) as Effect, tree('first settings'))

  run.send({ type: 'focused', session: 'second', now: 10 })
  run.answer(run.pending('cmod/UI.views', 'second').at(-1) as Effect, views)
  run.answer(run.pending('cmod/UI.pages', 'second').at(-1) as Effect, [])
  const drawn = run.pending('cmod/UI.draw', 'second').at(-1) as Effect

  expect((drawn.params as readonly unknown[])[1]).toEqual({ mod: 'cmod', id: 'settings' })
})

test('the panel tells cmod serve what it shows as the host of the session, and clears the last session when it moves', () => {
  const run = shown('first')
  run.send({ type: 'focused', session: 'second', now: 10 })

  expect(run.calls('cmod/UI.show').map((effect) => effect.params)).toEqual([
    ['first', 'herdr-test', [], { isHost: true }],
    ['first', 'herdr-test', [{ mod: 'cmod', id: 'dashboard' }], { isHost: true }],
    ['first', 'herdr-test', []],
    ['second', 'herdr-test', [], { isHost: true }],
  ])
})

test('a lost connection keeps the drawing with a problem, tries again later each time, and lists the session again once connected', () => {
  const run = shown('valid')
  const retries = [run.send({ type: 'disconnected', error: 'cmod serve stopped' }), run.send({ type: 'disconnected', error: 'cmod serve stopped' })]

  expect(retries).toEqual([[{ type: 'connectAfter', ms: 500 }], [{ type: 'connectAfter', ms: 1000 }]])
  expect(run.screen()).toMatchObject({ kind: 'ready', problem: 'cmod serve stopped' })
  run.send({ type: 'connected' })
  expect(run.pending('cmod/UI.views', 'valid')).toHaveLength(2)
  expect(run.calls('$/listen').map((effect) => (effect.params as { readonly event: string }).event)).toEqual(['Change', 'Redraw', 'Open', 'Close', 'Change', 'Redraw', 'Open', 'Close'])
})

test('a panel that never reached cmod serve says so in place of a loading state', () => {
  const run = driven()
  run.send({ type: 'focused', session: 'valid', now: 0 })
  run.send({ type: 'disconnected', error: 'cmod serve is not running: /home/.local/share/cmod/serve.json does not exist' })

  expect(run.screen()).toEqual({ kind: 'unreached', message: 'cmod serve is not running: /home/.local/share/cmod/serve.json does not exist', problem: null })
})

test('a mod opening its view selects that tab and asks Herdr to show the panel, and closing the shown view goes back to the first one', () => {
  const run = shown('valid')
  const [reveal] = run.send({ type: 'heard', event: 'Open', payload: { session: 'valid', mod: 'cmod', id: 'settings', isAsked: true } })
  expect([reveal, run.model().tab]).toEqual([{ type: 'reveal' }, 'cmod/settings'])

  run.send({ type: 'heard', event: 'Close', payload: { session: 'valid', mod: 'cmod', id: 'settings' } })
  expect(run.model().tab).toBeNull()
})

test('a page tab draws its one page for the session it was opened for, with no lists, and tells cmod serve it shows that page', () => {
  const run = driven({ show: 'page', session: 'worker', page: { mod: 'demo', id: 'log', title: 'Log' } })
  run.send({ type: 'connected' })
  run.answer(run.pending('cmod/UI.draw', 'worker').at(-1) as Effect, tree('the log'))

  expect(run.calls('cmod/UI.views')).toEqual([])
  expect(run.screen()).toMatchObject({ kind: 'ready', parts: [{ key: 'demo/log', drawn: { tree: tree('the log') } }] })
  expect(run.calls('cmod/UI.show').map((effect) => effect.params)).toEqual([['worker', 'herdr-test', [{ mod: 'demo', id: 'log' }]]])
})
