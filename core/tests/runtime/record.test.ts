import { expect, test } from 'bun:test'
import { ContextEnd, defineMod, GoalChange, Message, Note, Prompt, Reply, sessions, SessionStart, SubagentStop, TaskEnd, TaskStart, ToolCall, ToolResult, TurnEnd, TurnStart, type Disposable, type Session, type Turn } from '../../src/mod.js'
import { createSessionsClient } from '../../src/runtime/sessions.js'
import { testMod } from '../../src/testing.js'
import { fakeClaude } from '../../src/testing/fake-claude.js'

test("a task's owner is a session: its agent type, its goal from its first prompt, and its own turns", async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const id = await tested.startTask({ title: 'Find the pane', agentType: 'Explore', model: 'haiku' })
  await tested.add({ type: Prompt, text: 'Find where the tree pane is drawn.' }, { task: id })
  await tested.add({ type: Reply, text: 'In tree.ts.' }, { task: id })

  const [task] = await (await sessions.current.goal()).tasks()
  const owner = task!.owner
  const [turn] = await owner.turns()

  expect([owner.id, owner.agentType, owner.model, owner.isRunning]).toEqual([id, 'Explore', 'haiku', true])
  expect((await owner.goal()).text).toBe('Find where the tree pane is drawn.')
  expect((await turn!.messages()).map((message) => message.type)).toEqual([Prompt, Reply])
  expect((await owner.context()).number).toBe(1)
})

test('sessions.current.turn() is the running turn, and none once Claude stops', async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })

  expect((await sessions.current.turn())?.prompt.text).toBe('Rename the tree pane')
  expect((await sessions.current.context()).number).toBe(1)

  await tested.endTurn()

  expect(await sessions.current.turn()).toBeUndefined()
})

test("a turn hears only its own messages, and a task's messages reach the session's listeners", async () => {
  const inTurn: string[] = []
  const inSession: string[] = []
  const tested = testMod(
    defineMod({
      name: 'history',
      setup() {
        sessions.current.on(TurnStart, { prompt: { text: 'First' } }, (turn: Turn) => void turn.on(Reply, (reply) => void inTurn.push(reply.text)))
        sessions.current.on(Message, { task: /./ }, (message) => void inSession.push(message.type))
      },
    }),
    { permissions: ['conversation'] },
  )
  await tested.start()
  await tested.add({ type: Prompt, text: 'First' })
  await tested.add({ type: Reply, text: 'one' })
  await tested.endTurn()
  await tested.add({ type: Prompt, text: 'Second' })
  await tested.add({ type: Reply, text: 'two' })
  const task = await tested.startTask({ title: 'Look' })
  await tested.add({ type: Reply, text: 'Looked.' }, { task })

  expect(inTurn).toEqual(['one'])
  expect(inSession).toEqual([Reply])
})

test("a task hears its subtask's replies, though it listens only for replies", async () => {
  const heard: string[] = []
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const parent = await tested.startTask({ title: 'Find the pane' })
  const [task] = await (await sessions.current.goal()).tasks()
  task!.on(Reply, (reply) => void heard.push(reply.text))
  await tested.settle()

  const child = await tested.startTask({ title: 'Read tree.ts', parent })
  await tested.add({ type: Reply, text: 'Found it.' }, { task: child })

  expect(heard).toEqual(['Found it.'])
})

test("a task refuses its subtask's start", async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation', 'tasks'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const parent = await tested.startTask({ title: 'Find the pane' })
  const [task] = await (await sessions.current.goal()).tasks()
  task!.before(TaskStart, () => ({ refuse: 'No subtasks' }))
  await tested.settle()

  expect(await tested.fire('agent.spawn', { prompt: 'Read tree.ts', description: 'Read', tool_use_id: 'toolu_9', parentAgentId: parent, parentModel: 'opus' } as never)).toEqual({ deny: 'No subtasks' })
})

test("a goal refuses its session's top-level task starts", async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation', 'tasks'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  ;(await sessions.current.goal()).before(TaskStart, () => ({ refuse: 'No new tasks' }))
  await tested.settle()

  expect(await tested.fire('agent.spawn', { prompt: 'Find the pane', description: 'Find', tool_use_id: 'toolu_9', parentModel: 'opus' } as never)).toEqual({ deny: 'No new tasks' })
})

test("a task's owner keeps its context through a compaction and its turn through a stop, when its listeners refuse", async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation', 'prompt'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const id = await tested.startTask({ title: 'Find the pane' })
  await tested.add({ type: Prompt, text: 'Find where the tree pane is drawn.' }, { task: id })
  const [task] = await (await sessions.current.goal()).tasks()
  task!.owner.before(ContextEnd, () => ({ refuse: 'Keep the findings' }))
  task!.owner.before(TurnEnd, () => ({ refuse: 'Name the file first' }))
  await tested.settle()

  expect(await tested.fire('session.compact', { trigger: 'auto', agentId: id } as never)).toEqual({ skip: 'Keep the findings' })
  expect(await tested.fire(SubagentStop, { agent_id: id, agent_type: 'general-purpose' } as never)).toMatchObject({ block: 'Name the file first' })
})

test("a message sent to a task meets that task's prompt guard, and never the session's own", async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation', 'prompt'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const id = await tested.startTask({ title: 'Find the pane' })
  const [task] = await (await sessions.current.goal()).tasks()
  task!.owner.before(Prompt, () => ({ refuse: 'Task guard' }))
  ;(await sessions.current.context()).before(Prompt, () => ({ refuse: 'Main context only' }))
  await tested.settle()

  expect(await tested.fire('session.receive', { origin: { kind: 'peer', plugin: 'other' }, text: 'Deploy production', agentId: id } as never, { text: 'Deploy production' } as never)).toEqual({ consumed: 'Task guard' })
})

test('a subtask closes when its result reaches the parent task', async () => {
  const ended: string[] = []
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const parent = await tested.startTask({ title: 'Find the pane' })
  const child = await tested.startTask({ title: 'Read tree.ts', parent, openedBy: 'toolu_child' })
  sessions.current.on(TaskEnd, (task) => void ended.push(task.id))
  await tested.settle()

  await tested.add({ type: ToolResult, callId: 'toolu_child', text: 'Read it.', isError: false }, { task: parent })

  expect(ended).toEqual([child])
})

test("a session's context hears only the session's own messages, not a task's in a context with the same number", async () => {
  const heard: string[] = []
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Main loop prompt' })
  ;(await sessions.current.context()).on(Reply, (reply) => void heard.push(reply.text))
  await tested.settle()

  const task = await tested.startTask({ title: 'Look' })
  await tested.add({ type: Reply, text: 'Task reply' }, { task })
  await tested.add({ type: Reply, text: 'Main reply' })

  expect(heard).toEqual(['Main reply'])
})

test("a task's TurnStart payload reads that task's messages", async () => {
  const read: string[][] = []
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const id = await tested.startTask({ title: 'Find the pane' })
  sessions.current.on(TurnStart, { prompt: { task: id } }, (turn: Turn) => void turn.messages().then((messages) => read.push(messages.map((message) => message.type))))
  await tested.settle()

  await tested.add({ type: Prompt, text: 'Find where the tree pane is drawn.' }, { task: id })
  await tested.settle()

  expect(read).toEqual([[Prompt]])
})

test('a turn searches only its own messages', async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  await tested.endTurn()
  await tested.add({ type: Prompt, text: 'Rename the log pane' })

  const turn = await sessions.current.turn()

  expect((await turn!.search('rename')).map((message) => message.type === Prompt && message.text)).toEqual(['Rename the log pane'])
  expect(await sessions.current.search('rename')).toHaveLength(2)
})

test('before(Prompt) rewrites a typed prompt and refuses another', async () => {
  const tested = testMod(
    defineMod({
      name: 'guard',
      setup() {
        sessions.current.before(Prompt, (prompt) => (prompt.text.includes('prod') ? { refuse: 'No deploys to prod from here.' } : { text: `${prompt.text}, with tests` }))
      },
    }),
    { permissions: ['conversation', 'prompt'] },
  )
  await tested.start()

  const typed = { origin: { kind: 'composer' }, wait: false } as const

  expect(await tested.fire('prompt.submit', { ...typed, text: 'Fix the login bug' })).toEqual({ text: 'Fix the login bug, with tests', origin: { kind: 'composer' } })
  expect(await tested.fire('prompt.submit', { ...typed, text: 'Deploy to prod' })).toEqual({ drop: 'No deploys to prod from here.' })
})

test('before(ToolCall) refuses a call, and changes nothing without the tools permission', async () => {
  const guard = (permissions: string[]) =>
    testMod(
      defineMod({
        name: 'guard',
        setup() {
          sessions.current.before(ToolCall, { name: 'Bash' }, () => ({ refuse: 'Bash is off in this project.' }))
        },
      }),
      { permissions },
    )
  const call = { tool: 'Bash', tool_use_id: 'toolu_9', command: 'rm -rf build' } as never

  const allowed = guard(['conversation', 'tools'])
  await allowed.start()
  expect(await allowed.fire('tool.call', call)).toEqual({ deny: 'Bash is off in this project.' })

  const unallowed = guard(['conversation'])
  await unallowed.start()
  expect(await unallowed.fire('tool.call', call)).toEqual({} as never)
  await unallowed.settle()
  expect(unallowed.shown.toasts.filter(({ type }) => type === 'error').map(({ message }) => message)).toEqual(['The before(toolCall) listener failed'])
})

test('before(TaskStart) picks the model a task runs on', async () => {
  const tested = testMod(
    defineMod({
      name: 'thrift',
      setup() {
        sessions.current.before(TaskStart, { owner: { agentType: 'Explore' } }, () => ({ owner: { model: 'haiku' } }))
      },
    }),
    { permissions: ['conversation', 'tasks'] },
  )
  await tested.start()

  const spawn = { tool_use_id: 'toolu_1', prompt: 'Find it.', description: 'Find it', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus' }

  expect(await tested.fire('agent.spawn', { ...spawn, subagentType: 'Explore' } as never)).toEqual({ agentId: 'agent-1', model: 'haiku' } as never)
  expect(await tested.fire('agent.spawn', { ...spawn, subagentType: 'Plan' } as never)).toEqual({ agentId: 'agent-1', model: 'opus' } as never)
})

test('a disposed before listener stops answering', async () => {
  let listening: Disposable | undefined
  const tested = testMod(
    defineMod({
      name: 'guard',
      setup() {
        listening = sessions.current.before(Prompt, () => ({ refuse: 'Not now.' }))
      },
    }),
    { permissions: ['conversation', 'prompt'] },
  )
  await tested.start()
  listening?.dispose()

  expect(await tested.fire('prompt.submit', { text: 'Go', origin: { kind: 'composer' }, wait: false })).toEqual({ text: 'Go', origin: { kind: 'composer' } })
})

test('a before listener disposed after /clear stops answering in the new session', async () => {
  let listening: Disposable | undefined
  const tested = testMod(
    defineMod({
      name: 'guard',
      setup() {
        listening = sessions.current.before(Prompt, () => ({ refuse: 'Stopped by listener' }))
      },
    }),
    { permissions: ['conversation', 'prompt'] },
  )
  await tested.start()
  await tested.fire(SessionStart, { source: 'clear', session_id: 'after-clear' })
  await tested.settle()

  listening?.dispose()
  await tested.settle()

  expect(await tested.fire('prompt.submit', { text: 'Continue', origin: { kind: 'composer' }, wait: false })).toEqual({ text: 'Continue', origin: { kind: 'composer' } })
})

test('a task heard starting in another running session is running, and a send reaches it', async () => {
  const called: unknown[] = []
  const fake = fakeClaude({ name: 'watcher', root: '/plugins/watcher' })
  fake.fakes.cmod.call = async (input) => {
    called.push(input)
    return { value: null }
  }
  const client = createSessionsClient({ name: 'watcher', claude: fake.claude, report: () => {}, isGranted: () => true })
  const owners: Session[] = []
  client.sessions.on(TaskStart, (task) => void owners.push(task.owner))
  await fake.settle()

  client.changed('other', { type: TaskStart, task: { id: 'task-1', title: 'Look', agentType: 'Explore', openedBy: 'toolu_1', openedAt: '2026-10-14T10:00:00.000Z', context: 1 } }, true)
  await fake.settle()
  await owners[0]?.send({ type: Note, text: 'Check tree.ts too.' })

  expect(owners.map((owner) => owner.isRunning)).toEqual([true])
  expect(called.at(-1)).toMatchObject({ method: 'cmod:act', input: { session: 'other', task: 'task-1', action: 'send' } })
})

test("a session of another project reaches a mod's listener on that session, never its listener on every session", async () => {
  const fake = fakeClaude({ name: 'watcher', root: '/plugins/watcher' })
  fake.fakes.cmod.call = async () => ({ value: [] })
  const client = createSessionsClient({ name: 'watcher', claude: fake.claude, report: () => {}, isGranted: () => true })
  const heard: string[] = []
  client.sessions.on(Prompt, (prompt) => void heard.push(`every: ${prompt.text}`))
  await fake.settle()

  client.changed('b', { type: Message, message: { id: 'b1', type: Prompt, at: '2026-10-14T10:00:00.000Z', session: 'b', context: 1, text: 'Private B', from: { type: 'person' } } }, false)
  await fake.settle()

  expect(heard).toEqual([])
})

test("a task owner's goal hears its own update", async () => {
  const heard: string[] = []
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  await tested.startTask({ title: 'Find the pane' })
  const [task] = await (await sessions.current.goal()).tasks()
  const goal = await task!.owner.goal()
  goal.on(GoalChange, (changed) => void heard.push(changed.text))
  await tested.settle()

  await goal.update({ text: 'Find where tree.ts draws the pane' })
  await tested.settle()

  expect(heard).toEqual(['Find where tree.ts draws the pane'])
  expect((await task!.owner.goal()).text).toBe('Find where tree.ts draws the pane')
})

test("a task goal's event payload updates that task's goal, never the session's", async () => {
  const payloads: { update(goal: { text: string }): Promise<void> }[] = []
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Main goal' })
  await tested.startTask({ title: 'Find the pane' })
  const [task] = await (await sessions.current.goal()).tasks()
  const goal = await task!.owner.goal()
  goal.on(GoalChange, (changed) => void payloads.push(changed))
  await tested.settle()
  await goal.update({ text: 'Child goal' })
  await tested.settle()

  await payloads[0]?.update({ text: 'Updated through event' })

  expect([(await sessions.current.goal()).text, (await task!.owner.goal()).text]).toEqual(['Main goal', 'Updated through event'])
})

test('callTool with CronList or CronDelete needs the tools permission', async () => {
  const tested = testMod(defineMod({ name: 'runner', setup() {} }), { permissions: [] })
  await tested.start()

  await expect(sessions.current.callTool({ name: 'CronList', input: {} })).rejects.toThrow('runner calls callTool, which needs "permissions": { "tools": true } in package.json "cmod".')
  expect(tested.calls.filter((call) => call.call === 'tool.call')).toEqual([])
})

test("a mod's before listener on every session answers only for sessions of its project", async () => {
  const fake = fakeClaude({ name: 'guard', root: '/plugins/guard' })
  fake.fakes.cmod.call = async () => ({ value: [] })
  const client = createSessionsClient({ name: 'guard', claude: fake.claude, report: () => {}, isGranted: () => true })
  client.sessions.before(Prompt, () => ({ refuse: 'Only in /work/app' }))
  await fake.settle()
  const change = { type: Message, message: { id: '', type: Prompt, at: '2026-10-14T10:00:00.000Z', session: 'other', context: 1, text: 'Deploy', from: { type: 'person' } } } as const

  expect(await client.answerBefore('other', Prompt, change, false)).toBeUndefined()
  expect(await client.answerBefore('other', Prompt, change, true)).toEqual({ refuse: 'Only in /work/app' })
})

test("a task owner's goal hears the tasks it started, never the owner's own messages", async () => {
  const heard: string[] = []
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const owner = await tested.startTask({ title: 'Find the pane' })
  const child = await tested.startTask({ title: 'Read tree.ts', parent: owner })
  const [task] = (await (await sessions.current.goal()).tasks()).filter((each) => each.id === owner)
  ;(await task!.owner.goal()).on(Reply, (reply) => void heard.push(reply.text))
  await tested.settle()

  await tested.add({ type: Reply, text: 'Owner reply' }, { task: owner })
  await tested.add({ type: Reply, text: 'Child reply' }, { task: child })
  await tested.settle()

  expect(heard).toEqual(['Child reply'])
})

test('callTool runs a tool in this session and answers its result, with the tools permission alone', async () => {
  const tested = testMod(
    defineMod({
      name: 'runner',
      setup() {},
    }),
    { permissions: ['tools'] },
  )
  tested.fakes.tool.call = async () => ({ result: { stdout: 'ok' }, text: 'ok' })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Check the build' })

  const result = await sessions.current.callTool({ name: 'Bash', input: { command: 'bun run build' } })

  expect([result.type, result.text, result.isError, result.session]).toEqual(['toolResult', 'ok', false, 'test-session'])
  expect(tested.calls.filter((call) => call.call === 'tool.call').map((call) => call.args[0])).toEqual([{ command: 'bun run build', tool: 'Bash' }])
})

test('callTool with CronCreate needs the prompt permission, because a schedule starts turns', async () => {
  const tested = testMod(defineMod({ name: 'runner', setup() {} }), { permissions: ['tools'] })
  await tested.start()

  await expect(sessions.current.callTool({ name: 'CronCreate', input: { cron: '0 9 * * *', prompt: 'Standup' } })).rejects.toThrow('runner calls callTool, which needs "permissions": { "prompt": true } in package.json "cmod".')
  expect(tested.calls.filter((call) => call.call === 'tool.call')).toEqual([])
})

test('clients() names the Claude apps showing the session, and an ended session shows in none', async () => {
  const tested = testMod(defineMod({ name: 'compact', setup() {} }), { permissions: ['conversation'], sessions: [{ id: 'older', lastAt: '2026-10-10T09:00:00.000Z', messages: [{ type: Prompt, text: 'Older work' }] }] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Now' })
  const older = (await sessions.list()).find((session) => session.id === 'older')

  expect(await sessions.current.clients()).toEqual(['terminal'])
  expect(await older!.clients()).toEqual([])
  expect((await older!.usage()).model).toBe('test-model')
})
