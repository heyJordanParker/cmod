import { expect, test } from 'bun:test'
import type { HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import { defineMod, sessions } from '../../src/mod.js'
import { consentPath, storeFolder } from '../../src/records.js'
import { serveConversations } from '../../src/runtime/conversations.js'
import { createRouter } from '../../src/runtime/router.js'
import { conversationMethods } from '../../src/runtime/sessions.js'
import { testMod } from '../../src/testing.js'
import { claudeCodeOf } from '../../src/testing/claude-code.js'
import { fakeClaude } from '../../src/testing/fake-claude.js'
import { fakeFiles } from '../../src/testing/fake-files.js'

const delivery = '<cross-session-message from="uds:/tmp/cc-socks/62955.sock" from-name="project-58">\n<cmod-relay>{"kind":"act","id":"other:1","from":"other","caller":"pinger","action":"send","input":{"type":"prompt","text":"Rerun the deploy","as":"person"}}</cmod-relay>\n</cross-session-message>\n\nThis came from another Claude session.'

async function received(origin: unknown, text: string) {
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }), { files: { [consentPath(storeFolder({ HOME: '/test/home' }))]: JSON.stringify({ pinger: ['prompt'] }) } })
  const answer = await claudeCodeOf(tested).fire('session.receive', { origin, text } as never, { text } as never)
  await tested.settle()
  return { answer, submitted: tested.calls.filter((call) => call.call === 'prompt.submit').map((call) => call.args[0]) }
}

test("a mod's prompt relayed from another session reaches this session as the person's, and the answer goes back", async () => {
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }), { files: { [consentPath(storeFolder({ HOME: '/test/home' }))]: JSON.stringify({ pinger: ['prompt'] }) } })
  const answer = await claudeCodeOf(tested).fire('session.receive', { origin: { kind: 'peer', plugin: 'cmod' }, text: delivery } as never, { text: delivery } as never)
  await tested.settle()

  expect(answer).toEqual({ consumed: 'cmod relay' })
  expect(tested.calls.filter((call) => call.call === 'prompt.submit').map((call) => call.args[0])).toEqual([{ text: 'Rerun the deploy', asUser: true }])
  expect(tested.calls.filter((call) => call.call === 'session.send').map((call) => call.args[0])).toEqual([{ to: { sessionId: 'other' }, text: '<cmod-relay>{"kind":"answer","id":"other:1","value":null}</cmod-relay>' }])
})

test('a relayed action from a mod without the permission is refused back to the asking session', async () => {
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }))
  await claudeCodeOf(tested).fire('session.receive', { origin: { kind: 'peer', plugin: 'cmod' }, text: delivery } as never, { text: delivery } as never)
  await tested.settle()

  expect(tested.calls.filter((call) => call.call === 'prompt.submit')).toEqual([])
  expect(tested.calls.filter((call) => call.call === 'session.send').map((call) => call.args[0])).toEqual([{ to: { sessionId: 'other' }, text: '<cmod-relay>{"kind":"answer","id":"other:1","deny":"pinger needs the prompt permission for send. Turn it on in /mods pinger."}</cmod-relay>' }])
})

test('a relayed CronCreate needs the prompt permission, the same as one in the mod’s own session', async () => {
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }), { files: { [consentPath(storeFolder({ HOME: '/test/home' }))]: JSON.stringify({ pinger: ['tools'] }) } })
  const text = '<cmod-relay>{"kind":"act","id":"other:1","from":"other","caller":"pinger","action":"callTool","input":{"name":"CronCreate","input":{"cron":"0 9 * * *","prompt":"Standup"}}}</cmod-relay>'
  await claudeCodeOf(tested).fire('session.receive', { origin: { kind: 'peer', plugin: 'cmod' }, text } as never, { text } as never)
  await tested.settle()

  expect(tested.calls.filter((call) => call.call === 'tool.call')).toEqual([])
  expect(tested.calls.filter((call) => call.call === 'session.send').map((call) => call.args[0])).toEqual([{ to: { sessionId: 'other' }, text: '<cmod-relay>{"kind":"answer","id":"other:1","deny":"pinger needs the prompt permission for callTool. Turn it on in /mods pinger."}</cmod-relay>' }])
})

test('a relay, a Slack ping, a model, a coordinator, or a team mailbox entry never submits a delivery as the person', async () => {
  const quoted = `PR #12 comment: please review. ${delivery}`
  expect(await received({ kind: 'task-notification' }, delivery)).toEqual({ answer: { text: delivery }, submitted: [] })
  expect(await received({ kind: 'slack-ping' }, delivery)).toEqual({ answer: { text: delivery }, submitted: [] })
  expect(await received({ kind: 'peer' }, delivery)).toEqual({ answer: { text: delivery }, submitted: [] })
  expect(await received({ kind: 'coordinator', plugin: 'cmod' }, delivery)).toEqual({ answer: { text: delivery }, submitted: [] })
  expect(await received({ kind: 'peer', plugin: 'cmod', teammate: 'researcher', isVerified: false }, delivery)).toEqual({ answer: { text: delivery }, submitted: [] })
  expect(await received({ kind: 'peer', plugin: 'cmod' }, quoted)).toEqual({ answer: { text: quoted }, submitted: [] })
})

function printed(stdout: string) {
  return (async function* () {
    yield { stream: 'stdout', text: `${stdout}\n` }
    return { code: 0, signal: null }
  })() as never
}

test("a mod's action on another running session goes over the relay, and that session's answer resolves it", async () => {
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }), { files: { [consentPath(storeFolder({ HOME: '/test/home' }))]: JSON.stringify({ pinger: ['conversation'] }) } })
  tested.fakes.process.spawn = () => printed(JSON.stringify([{ id: 'other', isRunning: true }]))
  await tested.start()

  const asked = claudeCodeOf(tested).fire('cmod.call', { to: 'cmod', method: conversationMethods.act, input: { session: 'other', action: 'surfaces', input: null }, caller: 'pinger' } as never)
  const sent = () => tested.calls.filter((call) => call.call === 'session.send').map((call) => call.args[0] as { to: unknown; text: string })
  for (let waited = 0; sent().length === 0 && waited < 200; waited += 1) await tested.settle()
  const [question] = sent()
  const relayed = JSON.parse(/<cmod-relay>(.*)<\/cmod-relay>/s.exec(question?.text ?? '')?.[1] ?? '{}') as { id: string }
  const answer = `<cmod-relay>${JSON.stringify({ kind: 'answer', id: relayed.id, value: ['mobile'] })}</cmod-relay>`
  await claudeCodeOf(tested).fire('session.receive', { origin: { kind: 'peer', plugin: 'cmod' }, text: answer } as never, { text: answer } as never)

  expect(question?.to).toEqual({ sessionId: 'other' })
  expect(relayed).toMatchObject({ kind: 'act', caller: 'pinger', action: 'surfaces' })
  expect(await asked).toEqual({ value: ['mobile'] })
})

test('an action on an ended session answers from its transcript, or is refused', async () => {
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }), { files: { [consentPath(storeFolder({ HOME: '/test/home' }))]: JSON.stringify({ pinger: ['conversation', 'prompt'] }) } })
  tested.fakes.process.spawn = (request) => printed(request.argv.includes('usage') ? JSON.stringify({ model: 'claude-opus-5-5', context: { tokens: 1200 } }) : '[]')
  await tested.start()
  const act = (action: string, input: unknown) => claudeCodeOf(tested).fire('cmod.call', { to: 'cmod', method: conversationMethods.act, input: { session: 'older', action, input }, caller: 'pinger' } as never)

  expect(await act('usage', null)).toEqual({ value: { model: 'claude-opus-5-5', context: { tokens: 1200 } } })
  expect(await act('surfaces', null)).toEqual({ value: [] })
  expect(await act('send', { type: 'prompt', text: 'Hi' })).toEqual({ deny: 'session older has ended' })
})

test("the cmod plugin asks a mod in this session before a prompt enters, and the mod's refusal drops it", async () => {
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }), { files: { [consentPath(storeFolder({ HOME: '/test/home' }))]: JSON.stringify({ guard: ['conversation', 'prompt'] }) } })
  const asked: unknown[] = []
  tested.fakes.cmod.call = async (input) => {
    asked.push(input)
    return { refuse: 'No deploys from here.' }
  }
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })

  await claudeCodeOf(tested).fire('cmod.call', { to: 'cmod', method: conversationMethods.watchBefore, input: { session: 'test-session', subscriptions: [{ event: 'prompt' }] }, caller: 'guard' } as never)
  const answer = await claudeCodeOf(tested).fire('prompt.submit', { text: 'Deploy to prod', origin: { kind: 'composer' }, wait: false })

  expect(answer).toEqual({ drop: 'No deploys from here.' })
  expect(asked).toMatchObject([{ to: 'guard', method: conversationMethods.before, input: { session: 'test-session', event: 'prompt', change: { type: 'message', message: { type: 'prompt', text: 'Deploy to prod' } } } }])
})

test('the cmod plugin aborts the engine turn that is running, for a mod with the prompt permission', async () => {
  const consent = consentPath(storeFolder({ HOME: '/test/home' }))
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }), { files: { [consent]: JSON.stringify({ guard: ['prompt'], reader: [] }) } })
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  const abort = (caller: string) => claudeCodeOf(tested).fire('cmod.call', { to: 'cmod', method: conversationMethods.act, input: { session: 'test-session', action: 'abort', input: {} }, caller } as never)

  expect(await abort('guard')).toEqual({ deny: 'no turn is running in session test-session.' })
  await claudeCodeOf(tested).fire('turn.start', { text: 'Deploy', turnId: 'turn-7' } as never)
  expect(await abort('reader')).toEqual({ deny: 'reader needs the prompt permission for abort. Turn it on in /mods reader.' })
  expect(await abort('guard')).toEqual({ value: null })
  expect(tested.calls.filter((call) => call.call === 'turn.abort').map((call) => call.args[0])).toEqual([{ turnId: 'turn-7' }])
})

test("the cmod plugin's own listener on its session, added in setup, starts no follower", async () => {
  const spawned: (readonly string[])[] = []
  const tested = testMod(defineMod({ name: 'cmod', setup: () => void sessions.current.onPrompt(() => {}) }))
  tested.fakes.process.spawn = (request) => {
    spawned.push(request.argv)
    return printed('[]')
  }
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tested.settle()

  expect(spawned.filter((argv) => argv.includes('follow'))).toEqual([])
  expect(tested.shown.toasts.filter((toast) => toast.type === 'error')).toEqual([])
})

test("a turn ends at Stop with Claude's answer, stays open while a mod refuses the stop, and ends with its failure at StopFailure", async () => {
  const ended: unknown[] = []
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }), { files: { [consentPath(storeFolder({ HOME: '/test/home' }))]: JSON.stringify({ watcher: [], guard: [] }) } })
  let refuses = true
  tested.fakes.cmod.call = async (input) => {
    const { change } = (input.input ?? {}) as { readonly change?: { readonly type: string; readonly turn?: unknown } }
    if (input.method === conversationMethods.changed && change?.type === 'turnEnd') ended.push(change.turn)
    return input.method === conversationMethods.before && refuses ? { refuse: 'Run the tests first.' } : undefined
  }
  const prompt = (uuid: string, text: string) => {
    const appended = { uuid, door: 'user', origin: { kind: 'composer' }, message: { type: 'user', content: [{ type: 'text', text }] } }
    return claudeCodeOf(tested).fire('session.append', appended as never, appended as never)
  }
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await claudeCodeOf(tested).fire('cmod.call', { to: 'cmod', method: conversationMethods.subscribe, input: { session: 'test-session', subscriptions: [{ event: 'turnEnd' }] }, caller: 'watcher' } as never)
  await claudeCodeOf(tested).fire('cmod.call', { to: 'cmod', method: conversationMethods.watchBefore, input: { session: 'test-session', subscriptions: [{ event: 'turnEnd' }] }, caller: 'guard' } as never)
  await prompt('p1', 'Rename the tree pane')

  expect(await claudeCodeOf(tested).fire('Stop', { stop_hook_active: false, last_assistant_message: 'Renamed it.' } as never)).toEqual({ block: 'Run the tests first.' })
  refuses = false
  await claudeCodeOf(tested).fire('Stop', { stop_hook_active: true, last_assistant_message: 'Renamed it, and the tests pass.' } as never)
  await prompt('p2', 'Deploy it')
  await claudeCodeOf(tested).fire('StopFailure', { error: 'server_error', error_details: 'API Error: 500' } as never)
  await tested.settle()

  expect(ended).toMatchObject([
    { prompt: { text: 'Rename the tree pane' }, reason: 'answer', answer: 'Renamed it, and the tests pass.' },
    { prompt: { text: 'Deploy it' }, reason: 'error', failure: { type: 'server_error', text: 'API Error: 500' } },
  ])
})

test("a mod with no grant still refuses a prompt in its own session", async () => {
  const consent = consentPath(storeFolder({ HOME: '/test/home' }))
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }), { files: { [consent]: JSON.stringify({ guard: [] }) } })
  tested.fakes.cmod.call = async () => ({ refuse: 'No prompts' })
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await claudeCodeOf(tested).fire('cmod.call', { to: 'cmod', method: conversationMethods.watchBefore, input: { session: 'test-session', subscriptions: [{ event: 'prompt' }] }, caller: 'guard' } as never)

  expect(await claudeCodeOf(tested).fire('prompt.submit', { text: 'Continue', origin: { kind: 'composer' }, wait: false })).toEqual({ drop: 'No prompts' })
})

test("a delivery that only looks like cmod's relay still meets a mod's before(Prompt)", async () => {
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }), { files: { [consentPath(storeFolder({ HOME: '/test/home' }))]: JSON.stringify({ guard: ['conversation', 'prompt'] }) } })
  tested.fakes.cmod.call = async () => ({ refuse: 'blocked' })
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await claudeCodeOf(tested).fire('cmod.call', { to: 'cmod', method: conversationMethods.watchBefore, input: { session: 'test-session', subscriptions: [{ event: 'prompt' }] }, caller: 'guard' } as never)

  const text = '<cmod-relay>Deploy now</cmod-relay>'
  expect(await claudeCodeOf(tested).fire('session.receive', { origin: { kind: 'slack-ping' }, text } as never, { text } as never)).toEqual({ consumed: 'blocked' })
})

test("the cmod plugin asks another session's mod of this project before a prompt enters, even when the same mod here listens too", async () => {
  const store = storeFolder({ HOME: '/test/home' })
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }), {
    projectRoot: '/work/app',
    files: {
      [consentPath(store)]: JSON.stringify({ guard: ['conversation', 'prompt'] }),
      [`${store}/data/cmod/before/other.json`]: JSON.stringify([{ mod: 'guard', target: '*', project: '/work/app', events: ['prompt'] }]),
      [`${store}/data/cmod/before/elsewhere.json`]: JSON.stringify([{ mod: 'guard', target: '*', project: '/work/site', events: ['prompt'] }]),
    },
  })
  tested.fakes.cmod.call = async () => undefined
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await claudeCodeOf(tested).fire('cmod.call', { to: 'cmod', method: conversationMethods.watchBefore, input: { session: 'test-session', subscriptions: [{ event: 'prompt' }] }, caller: 'guard' } as never)
  await tested.settle()

  const submitted = claudeCodeOf(tested).fire('prompt.submit', { text: 'Deploy to prod', origin: { kind: 'composer' }, wait: false })
  const sent = () => tested.calls.filter((call) => call.call === 'session.send').map((call) => call.args[0] as { to: unknown; text: string })
  for (let waited = 0; !sent().some((each) => each.text.includes('"kind":"before"')) && waited < 200; waited += 1) await tested.settle()
  const question = JSON.parse(/<cmod-relay>(.*)<\/cmod-relay>/s.exec(sent().find((each) => each.text.includes('"kind":"before"'))?.text ?? '')?.[1] ?? '{}') as { id: string }
  const refusal = `<cmod-relay>${JSON.stringify({ kind: 'answer', id: question.id, value: { refuse: 'blocked by session other' } })}</cmod-relay>`
  await claudeCodeOf(tested).fire('session.receive', { origin: { kind: 'peer', plugin: 'cmod' }, text: refusal } as never, { text: refusal } as never)

  expect(question).toMatchObject({ kind: 'before', mod: 'guard', event: 'prompt' })
  expect(await submitted).toEqual({ drop: 'blocked by session other' })
  expect(sent().filter((each) => each.text.includes('"kind":"before"')).map((each) => each.to)).toEqual([{ sessionId: 'other' }])
})

test('a mod listening on this session and on every session is asked once before a prompt', async () => {
  const asked: unknown[] = []
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }), { files: { [consentPath(storeFolder({ HOME: '/test/home' }))]: JSON.stringify({ guard: ['conversation', 'prompt'] }) } })
  tested.fakes.cmod.call = async (input) => {
    asked.push(input)
    return undefined
  }
  tested.fakes.process.spawn = () => printed('[]')
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  for (const session of ['test-session', '*']) await claudeCodeOf(tested).fire('cmod.call', { to: 'cmod', method: conversationMethods.watchBefore, input: { session, subscriptions: [{ event: 'prompt' }] }, caller: 'guard' } as never)

  await claudeCodeOf(tested).fire('prompt.submit', { text: 'go', origin: { kind: 'composer' }, wait: false })

  expect(asked.filter((each) => (each as { method: string }).method === conversationMethods.before)).toHaveLength(1)
})

test("another project's session reaches only the mod that named it, never a mod listening on every session", async () => {
  const told: string[] = []
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }), { files: { [consentPath(storeFolder({ HOME: '/test/home' }))]: JSON.stringify({ global: ['conversation'], explicit: ['conversation'] }) } })
  tested.fakes.cmod.call = async (input) => {
    if (input.method === conversationMethods.changed) told.push(input.to)
    return undefined
  }
  const change = { type: 'message', message: { id: 'b1', type: 'prompt', at: '2026-10-14T10:00:00.000Z', session: 'other-b', context: 1, text: 'Private B', from: { type: 'person' } } }
  tested.fakes.process.spawn = () => printed(JSON.stringify({ session: 'other-b', isInProject: false, change }))
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await claudeCodeOf(tested).fire('cmod.call', { to: 'cmod', method: conversationMethods.subscribe, input: { session: '*', subscriptions: [{ event: 'message' }] }, caller: 'global' } as never)
  await claudeCodeOf(tested).fire('cmod.call', { to: 'cmod', method: conversationMethods.subscribe, input: { session: 'other-b', subscriptions: [{ event: 'message' }] }, caller: 'explicit' } as never)
  for (let waited = 0; told.length === 0 && waited < 200; waited += 1) await tested.settle()

  expect(told).toEqual(['explicit'])
})

test('the follower moves with the session to a new project and to a new session', async () => {
  const spawned: { argv: readonly string[]; env?: Readonly<Record<string, string>> }[] = []
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }), { projectRoot: '/work/old', files: { [consentPath(storeFolder({ HOME: '/test/home' }))]: JSON.stringify({ watcher: ['conversation'] }) } })
  tested.fakes.process.spawn = (request) => {
    spawned.push(request)
    return followerChild().stream
  }
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await claudeCodeOf(tested).fire('cmod.call', { to: 'cmod', method: conversationMethods.subscribe, input: { session: '*', subscriptions: [{ event: 'message' }] }, caller: 'watcher' } as never)
  await tested.settle()

  await tested.moveTo('/work/new')
  await tested.settle()
  await claudeCodeOf(tested).fire('SessionStart', { source: 'clear', session_id: 'new-session' })
  await tested.settle()

  expect(spawned.map(({ argv, env }) => [argv.at(-1), env?.['CLAUDE_CODE_SESSION_ID']])).toEqual([
    ['/work/old', 'test-session'],
    ['/work/new', 'test-session'],
    ['/work/new', 'new-session'],
  ])
})

test("after /cd, a session no longer asks the old project's guards, and asks the new project's", async () => {
  const store = storeFolder({ HOME: '/test/home' })
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }), {
    projectRoot: '/work/old',
    files: {
      [consentPath(store)]: JSON.stringify({ guard: ['conversation', 'prompt'] }),
      [`${store}/data/cmod/before/old-session.json`]: JSON.stringify([{ mod: 'guard', target: '*', project: '/work/old', events: ['prompt'] }]),
      [`${store}/data/cmod/before/new-session.json`]: JSON.stringify([{ mod: 'guard', target: '*', project: '/work/new', events: ['prompt'] }]),
    },
  })
  const asked: { to: unknown; text: string }[] = []
  tested.fakes.process.spawn = () => printed('[]')
  tested.fakes.session.send = async ({ to, text }) => {
    const relay = JSON.parse(/<cmod-relay>(.*)<\/cmod-relay>/s.exec(text)?.[1] ?? '{}') as { kind?: string; id?: string; change?: { message?: { text: string } } }
    if (relay.kind !== 'before') return { isDelivered: true }
    asked.push({ to, text: relay.change?.message?.text ?? '' })
    const answer = `<cmod-relay>${JSON.stringify({ kind: 'answer', id: relay.id, value: null })}</cmod-relay>`
    void Promise.resolve().then(() => claudeCodeOf(tested).fire('session.receive', { origin: { kind: 'peer', plugin: 'cmod' }, text: answer } as never, { text: answer } as never))
    return { isDelivered: true }
  }
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })
  await tested.settle()

  await tested.moveTo('/work/new')
  await claudeCodeOf(tested).fire('prompt.submit', { text: 'Work in the new project', origin: { kind: 'composer' }, wait: false })

  expect(asked).toEqual([{ to: { sessionId: 'new-session' }, text: 'Work in the new project' }])
})

test("a new session's first prompt waits for the project's guards to load, and asks them", async () => {
  const fake = fakeClaude({ name: 'cmod', root: '/plugins/cmod' })
  const router = createRouter()
  const disk = fakeFiles({ '/store/data/cmod/before/guarding.json': JSON.stringify([{ mod: 'guard', target: '*', project: '/work/app', events: ['prompt'] }]) })
  let release = () => {}
  const loaded = new Promise<void>((resolve) => (release = resolve))
  fake.fakes.fs.read = disk.read
  fake.fakes.fs.list = async (path) => {
    if (path?.endsWith('/before') === true) await loaded
    return disk.list(path)
  }
  fake.fakes.process.spawn = () => printed('[]')
  fake.fakes.session.send = async ({ text }) => {
    const relay = JSON.parse(/<cmod-relay>(.*)<\/cmod-relay>/s.exec(text)?.[1] ?? '{}') as { kind?: string; id?: string }
    const answer = `<cmod-relay>${JSON.stringify({ kind: 'answer', id: relay.id, value: { refuse: 'Guarded' } })}</cmod-relay>`
    if (relay.kind === 'before') void Promise.resolve().then(() => router.dispatch('session.receive', { origin: { kind: 'peer', plugin: 'cmod' }, text: answer } as never, async () => ({}) as never))
    return { isDelivered: true }
  }
  serveConversations({ claude: fake.claude, router, store: '/store', project: () => '/work/app', report: () => {} })
  await router.dispatch('classic.SessionStart', { session_id: 'new-session', source: 'startup' } as never, async () => ({}))

  const submitted = router.dispatch('prompt.submit', { text: 'First prompt', origin: { kind: 'composer' }, wait: false } as never, async () => ({}) as never)
  await fake.settle()
  release()

  expect(await submitted).toEqual({ drop: 'Guarded' })
})

test("a guard of a session that ended without saying so lets the prompt in quietly, and is cleared for every later session", async () => {
  const fake = fakeClaude({ name: 'cmod', root: '/plugins/cmod' })
  const router = createRouter()
  const disk = fakeFiles({ '/store/data/cmod/before/crashed.json': JSON.stringify([{ mod: 'guard', target: '*', project: '/work/app', events: ['prompt'] }]) })
  const reported: string[] = []
  fake.fakes.fs.read = disk.read
  fake.fakes.fs.list = disk.list
  fake.fakes.fs.write = disk.write
  fake.fakes.process.spawn = () => printed('[]')
  fake.fakes.session.send = async () => ({ isDelivered: false, reason: 'no such session' }) as never
  serveConversations({ claude: fake.claude, router, store: '/store', project: () => '/work/app', report: (_id, message) => void reported.push(message) })
  await router.dispatch('classic.SessionStart', { session_id: 'new-session', source: 'startup' } as never, async () => ({}))

  const submitted = await router.dispatch('prompt.submit', { text: 'First prompt', origin: { kind: 'composer' }, wait: false } as never, async () => ({ passed: true }) as never)

  expect(submitted).toEqual({ passed: true } as never)
  expect(reported).toEqual([])
  expect(JSON.parse(await disk.read('/store/data/cmod/before/crashed.json'))).toEqual([])
})

test("a goal updated from another session becomes that running session's goal", async () => {
  const disk = fakeFiles({ [consentPath('/store')]: JSON.stringify({ history: ['conversation'] }) })
  const plugin = async (id: string) => {
    const fake = fakeClaude({ name: 'cmod', root: '/plugins/cmod' })
    const router = createRouter()
    fake.fakes.fs = disk
    fake.fakes.process.spawn = () => printed('[]')
    const served = serveConversations({ claude: fake.claude, router, store: '/store', project: () => '/work/app', report: () => {} })
    await router.dispatch('classic.SessionStart', { session_id: id, source: 'startup' } as never, async () => ({}))
    return { fake, router, served }
  }
  const target = await plugin('target')
  const other = await plugin('other')
  other.fake.fakes.session.send = async ({ to, text }) => {
    if (JSON.stringify(to) === '{"sessionId":"target"}') await target.router.dispatch('session.receive', { origin: { kind: 'peer', plugin: 'cmod' }, text } as never, async () => ({}) as never)
    return { isDelivered: true }
  }
  await target.router.dispatch('prompt.submit', { text: 'Original goal', origin: { kind: 'composer' }, wait: false } as never, async () => ({}) as never)
  await target.served.answer({ to: 'cmod', method: conversationMethods.updateGoal, input: { session: 'target', text: 'Original goal' }, caller: 'history' })

  await other.served.answer({ to: 'cmod', method: conversationMethods.updateGoal, input: { session: 'target', text: 'Updated remotely' }, caller: 'history' })
  await target.fake.settle()

  expect(await target.served.answer({ to: 'cmod', method: conversationMethods.goal, input: { session: 'target' }, caller: 'history' })).toEqual({ value: { text: 'Updated remotely' } })
})

test('another session hears when a before listener on it goes away, and when the listening session ends', async () => {
  const fake = fakeClaude({ name: 'cmod', root: '/plugins/cmod' })
  const router = createRouter()
  const told: string[] = []
  fake.fakes.fs = fakeFiles({ [consentPath('/store')]: JSON.stringify({ guard: ['conversation', 'prompt'] }) })
  fake.fakes.process.spawn = () => printed('[]')
  fake.fakes.session.send = async ({ to, text }) => {
    if (text.includes('"kind":"watch"')) told.push(JSON.stringify(to))
    return { isDelivered: true }
  }
  const served = serveConversations({ claude: fake.claude, router, store: '/store', project: () => '/work/app', report: () => {} })
  await router.dispatch('classic.SessionStart', { session_id: 'mine', source: 'startup' } as never, async () => ({}))
  const watch = (subscriptions: readonly unknown[]) => served.answer({ to: 'cmod', method: conversationMethods.watchBefore, input: { session: 'other', subscriptions }, caller: 'guard' })

  await watch([{ event: 'prompt' }])
  await watch([])
  await watch([{ event: 'prompt' }])
  await router.dispatch('classic.SessionEnd', { session_id: 'mine', reason: 'other' } as never, async () => ({}))

  expect(told).toEqual(Array(4).fill('{"sessionId":"other"}'))
})

test("two before listeners registered at once both stay registered", async () => {
  const fake = fakeClaude({ name: 'cmod', root: '/plugins/cmod' })
  const router = createRouter()
  const disk = fakeFiles({ [consentPath('/store')]: JSON.stringify({ guard: ['conversation', 'prompt'] }) })
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  let writes = 0
  fake.fakes.fs = { ...disk, write: async (path, text) => {
    writes += 1
    if (writes === 1) await held
    return disk.write(path, text)
  } }
  fake.fakes.process.spawn = () => printed('[]')
  const served = serveConversations({ claude: fake.claude, router, store: '/store', project: () => '/work/app', report: () => {} })
  await router.dispatch('classic.SessionStart', { session_id: 'mine', source: 'startup' } as never, async () => ({}))
  const watch = (target: string) => served.answer({ to: 'cmod', method: conversationMethods.watchBefore, input: { session: target, subscriptions: [{ event: 'prompt' }] }, caller: 'guard' })

  const first = watch('remote-a')
  const second = watch('remote-b')
  release()
  await Promise.all([first, second])

  expect((JSON.parse(await disk.read('/store/data/cmod/before/mine.json')) as { target: string }[]).map((each) => each.target)).toEqual(['remote-a', 'remote-b'])
})

test("one compaction of a task moves its context once, and one of the session moves the session's once", async () => {
  const fake = fakeClaude({ name: 'cmod', root: '/plugins/cmod' })
  const router = createRouter()
  fake.fakes.fs = fakeFiles({ [consentPath('/store')]: JSON.stringify({ history: ['conversation'] }) })
  fake.fakes.process.spawn = () => printed('[]')
  const served = serveConversations({ claude: fake.claude, router, store: '/store', project: () => '/work/app', report: () => {} })
  const passed = async () => ({})
  await router.dispatch('classic.SessionStart', { session_id: 'mine', source: 'startup' } as never, passed)
  await router.dispatch('agent.spawn', { description: 'Find the pane', subagentType: 'Explore', tool_use_id: 'toolu_1' } as never, async () => ({ agentId: 'task-1', model: 'claude-haiku' }))

  await router.dispatch('session.compact', { trigger: 'auto', agentId: 'task-1' } as never, async () => ({}) as never)
  await router.dispatch('session.compact', { trigger: 'auto' } as never, async () => ({}) as never)
  await router.dispatch('session.compact', { trigger: 'manual' } as never, async () => ({ skip: 'A hook kept the conversation' }))
  await router.dispatch('session.compact', { trigger: 'precompute' } as never, async () => ({}) as never)
  await router.dispatch('classic.SessionStart', { session_id: 'mine', source: 'compact' } as never, passed)
  await fake.settle()
  const contexts = async (task?: string) => (await served.answer({ to: 'cmod', method: conversationMethods.contexts, input: { session: 'mine', ...(task === undefined ? {} : { task }) }, caller: 'history' }))?.value as { number: number }[]

  expect([(await contexts('task-1')).map((each) => each.number), (await contexts()).map((each) => each.number)]).toEqual([[2], [2]])
})

function followerChild() {
  let finish: (result: ProcessSpawnResult | undefined) => void = () => {}
  const ended = new Promise<ProcessSpawnResult | undefined>((resolve) => (finish = resolve))
  const stream = {
    next: async () => ({ done: true, value: await ended }),
    return: async () => {
      finish(undefined)
      return { done: true, value: undefined }
    },
    [Symbol.asyncIterator]() {
      return this
    },
    result: ended,
  }
  return { stream: stream as unknown as HookStream<ProcessSpawnChunk, ProcessSpawnResult>, exit: (code: number) => finish({ code } as ProcessSpawnResult) }
}

test('the cmod plugin restarts its follower quietly, and says so when a follower exits on its own', async () => {
  const tested = testMod(defineMod({ name: 'cmod', setup() {} }), { files: { [consentPath(storeFolder({ HOME: '/test/home' }))]: JSON.stringify({ watcher: ['conversation'] }) } })
  const children: ReturnType<typeof followerChild>[] = []
  tested.fakes.process.spawn = () => {
    const child = followerChild()
    children.push(child)
    return child.stream
  }
  const listen = (session: string) => claudeCodeOf(tested).fire('cmod.call', { to: 'cmod', method: conversationMethods.subscribe, input: { session, subscriptions: [{ event: 'message' }] }, caller: 'watcher' } as never)
  await claudeCodeOf(tested).fire('SessionStart', { source: 'startup' })

  await listen('other-1')
  await listen('other-2')
  await tested.settle()

  expect(children).toHaveLength(2)
  expect(tested.shown.toasts.filter(({ type }) => type === 'error')).toEqual([])

  children[1]?.exit(1)
  await tested.settle()

  expect(tested.shown.toasts.filter(({ type }) => type === 'error').map(({ message }) => message)).toEqual(['Stopped hearing the other sessions'])
})
