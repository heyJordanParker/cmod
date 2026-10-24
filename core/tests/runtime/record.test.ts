import { expect, test } from 'bun:test'
import { AttachedFile, defineMod, Note, Prompt, Reply, sessions, ToolCall, ToolResult, type AttachmentType, type Subscription, type TaskOwner, type Turn } from '../../src/mod.js'
import { createSessionsClient } from '../../src/runtime/sessions.js'
import { Message } from '../../src/session/context/turn/message/message.js'
import { TaskStart } from '../../src/session/goal/task.js'
import { testMod } from '../../src/testing.js'
import { claudeCodeOf } from '../../src/testing/claude-code.js'
import { fakeClaude } from '../../src/testing/fake-claude.js'

test("a task's owner is a session: its agent type, its goal from its first prompt, and its own turns", async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const id = await tested.startTask({ title: 'Find the pane', agentType: 'Explore', model: 'haiku' })
  await tested.add({ type: Prompt, text: 'Find where the tree pane is drawn.' }, { task: id })
  await tested.add({ type: Reply, text: 'In tree.ts.' }, { task: id })

  const [task] = await sessions.current.goal.tasks()
  const owner = task!.owner
  const [turn] = await owner.turns()

  expect([owner.id, owner.agentType, owner.model, owner.isRunning]).toEqual([id, 'Explore', 'haiku', true])
  expect(await owner.goal.text()).toBe('Find where the tree pane is drawn.')
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

test("a turn hears only its own messages, a session only its own agent's, and the goal every agent's", async () => {
  const inTurn: string[] = []
  const inMain: string[] = []
  const inSession: string[] = []
  const tested = testMod(
    defineMod({
      name: 'history',
      async setup() {
        sessions.current.onTurnStart({ prompt: { text: 'First' } }, (turn: Turn) => void turn.onReply((reply) => void inTurn.push(reply.text)))
        sessions.current.onMessage((message) => void inMain.push(message.type))
        ;sessions.current.goal.onMessage({ task: /./ }, (message) => void inSession.push(message.type))
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
  expect(inMain).toEqual([Prompt, Reply, Prompt, Reply])
  expect(inSession).toEqual([Reply])
})

test("a task hears its subtask's replies, though it listens only for replies", async () => {
  const heard: string[] = []
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const parent = await tested.startTask({ title: 'Find the pane' })
  const [task] = await sessions.current.goal.tasks()
  task!.onReply((reply) => void heard.push(reply.text))
  await tested.settle()

  const child = await tested.startTask({ title: 'Read tree.ts', parent })
  await tested.add({ type: Reply, text: 'Found it.' }, { task: child })

  expect(heard).toEqual(['Found it.'])
})

test("a running task of this session holds its status, its teammate name, and the plugin that spawned it, as Claude Code lists them", async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation', 'tasks'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const id = await tested.startTask({ title: 'Find the pane' })
  tested.fakes.agent.list = async () => [{ id, description: 'Find the pane', type: 'Explore', status: 'waiting', name: 'scout', spawnedBy: 'scoper' } as never]

  const [task] = await sessions.current.goal.tasks()

  expect([task?.status, task?.name, task?.spawnedBy]).toEqual(['waiting', 'scout', 'scoper'])
})

test("a task refuses its subtask's start", async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation', 'tasks'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const parent = await tested.startTask({ title: 'Find the pane' })
  const [task] = await sessions.current.goal.tasks()
  task!.beforeTaskStart(() => ({ refuse: 'No subtasks' }))
  await tested.settle()

  expect(await claudeCodeOf(tested).fire('agent.spawn', { prompt: 'Read tree.ts', description: 'Read', tool_use_id: 'toolu_9', parentAgentId: parent, parentModel: 'opus' } as never)).toEqual({ deny: 'No subtasks' })
})

test("beforePrompt in a task hears the spawn's prompt when Claude Code starts the subagent inside the spawn, before cmod knows its task, and its note reaches the subagent", async () => {
  const prompts: { text: string; task: string | undefined }[] = []
  const tested = testMod(defineMod({ name: 'modes', setup() {} }), { permissions: ['prompt'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  ;sessions.current.goal.beforePrompt({ task: /./ }, (prompt) => {
    prompts.push({ text: prompt.text, task: prompt.task })
    return { note: 'You are in read-only mode.' }
  })
  await tested.settle()

  await claudeCodeOf(tested).fire('agent.spawn', { prompt: 'Find the pane', description: 'Find', subagentType: 'Explore', tool_use_id: 'toolu_9', parentModel: 'opus' } as never)

  expect(prompts).toEqual([{ text: 'Find the pane', task: 'agent-1' }])
  expect(tested.shown.notes).toEqual(['You are in read-only mode.'])
})

test("a goal refuses its session's top-level task starts", async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation', 'tasks'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  ;sessions.current.goal.beforeTaskStart(() => ({ refuse: 'No new tasks' }))
  await tested.settle()

  expect(await claudeCodeOf(tested).fire('agent.spawn', { prompt: 'Find the pane', description: 'Find', tool_use_id: 'toolu_9', parentModel: 'opus' } as never)).toEqual({ deny: 'No new tasks' })
})

test("a task's owner keeps its context through a compaction and its turn through a stop, when its listeners refuse", async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation', 'prompt'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const id = await tested.startTask({ title: 'Find the pane' })
  await tested.add({ type: Prompt, text: 'Find where the tree pane is drawn.' }, { task: id })
  const [task] = await sessions.current.goal.tasks()
  task!.owner.beforeContextEnd(() => ({ refuse: 'Keep the findings' }))
  task!.owner.beforeTurnEnd(() => ({ refuse: 'Name the file first' }))
  await tested.settle()

  expect(await claudeCodeOf(tested).fire('session.compact', { trigger: 'auto', agentId: id } as never)).toEqual({ skip: 'Keep the findings' })
  expect(await claudeCodeOf(tested).fire('SubagentStop', { agent_id: id, agent_type: 'general-purpose' } as never)).toMatchObject({ block: 'Name the file first' })
})

test("a note at the session's turn end, at a task owner's turn end, and on a tool call reaches Claude in the mod's tag", async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation', 'prompt'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const id = await tested.startTask({ title: 'Find the pane' })
  await tested.add({ type: Prompt, text: 'Find where the tree pane is drawn.' }, { task: id })
  const [task] = await sessions.current.goal.tasks()
  sessions.current.beforeTurnEnd(() => ({ note: 'Run the tests before you stop.' }))
  task!.owner.beforeTurnEnd(() => ({ note: 'Name the file.' }))
  sessions.current.beforeToolCall({ name: 'Edit' }, () => ({ note: 'src/gen is generated. Edit src/schema instead.' }))
  await tested.settle()
  const code = claudeCodeOf(tested)

  expect(await code.fire('Stop', {} as never)).toMatchObject({ additionalContext: ['<history_mod>\nRun the tests before you stop.\n</history_mod>'] })
  expect(await code.fire('SubagentStop', { agent_id: id, agent_type: 'general-purpose' } as never)).toMatchObject({ additionalContext: ['<history_mod>\nName the file.\n</history_mod>'] })
  expect(await code.fire('tool.call', { tool: 'Edit', tool_use_id: 'toolu_3', file_path: '/work/src/gen/a.ts', old_string: 'a', new_string: 'b' } as never, { result: 'edited' } as never)).toEqual({
    result: 'edited',
    context: ['<history_mod>\nsrc/gen is generated. Edit src/schema instead.\n</history_mod>'],
  })
})

test('a note needs the prompt permission, even where the rest of the answer needs another', async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation', 'tools'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  sessions.current.beforeToolCall({ name: 'Edit' }, () => ({ note: 'src/gen is generated.' }))
  await tested.settle()

  expect(await claudeCodeOf(tested).fire('tool.call', { tool: 'Edit', tool_use_id: 'toolu_3', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' } as never, { result: 'edited' } as never)).toEqual({ result: 'edited' })
  expect(tested.shown.toasts.map(({ message }) => message)).toContain('The beforeToolCall listener failed')
})

test('beforeAttachedFile keeps a file out of what Claude reads, or rewrites it, and beforeInstructionFile still answers for a CLAUDE.md', async () => {
  const heard: unknown[] = []
  const tested = testMod(defineMod({ name: 'secrets', setup() {} }), { permissions: ['prompt'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Read the config' })
  sessions.current.beforeAttachedFile({ path: /\.env$/ }, () => ({ refuse: '.env holds secrets' }))
  sessions.current.beforeAttachedFile({ path: /notes\.txt$/ }, (file) => (heard.push({ path: file.path, attachmentType: file.attachmentType }), { text: 'The notes are private.' }))
  sessions.current.beforeInstructionFile(() => ({ text: 'Use tabs.' }))
  await tested.settle()
  const attached = (type: string, text: string) => claudeCodeOf(tested).fire('prompt.attachment', { type, text, origin: { kind: 'engine' } } as never, { text } as never)

  expect(await attached('file', 'Called the Read tool with the following input: {"file_path":"/work/.env"}\nResult of calling the Read tool: KEY=1')).toEqual({ text: null })
  expect(await attached('file', 'Called the Read tool with the following input: {"file_path":"/work/notes.txt"}\nResult of calling the Read tool: launch code')).toEqual({ text: 'The notes are private.' })
  expect(await attached('compact_file_reference', 'Note: /work/big.log was read before the last conversation was summarized, but the contents are too large to include.')).toEqual({ text: 'Note: /work/big.log was read before the last conversation was summarized, but the contents are too large to include.' })
  expect(await attached('nested_memory', 'Contents of /work/src/CLAUDE.md:\n\nUse spaces.')).toEqual({ text: 'Use tabs.' })
  expect(heard).toEqual([{ path: '/work/notes.txt', attachmentType: 'contents' }])
})

test('an attached file a test adds reaches the mod as the attachment type it was given', async () => {
  const tested = testMod(defineMod({ name: 'secrets', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Read the config' })
  const types: AttachmentType[] = ['contents', 'reference', 'change']

  const added = await Promise.all(types.map((attachmentType) => tested.add({ type: AttachedFile, path: '/work/config.ts', attachmentType, text: 'export const port = 1' })))

  expect(added.flat().map((message) => (message.type === AttachedFile ? message.attachmentType : message.type))).toEqual(types)
})

test("a message sent to a task meets that task's prompt guard, and never the session's own", async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation', 'prompt'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const id = await tested.startTask({ title: 'Find the pane' })
  const [task] = await sessions.current.goal.tasks()
  task!.owner.beforePrompt(() => ({ refuse: 'Task guard' }))
  ;(await sessions.current.context()).beforePrompt(() => ({ refuse: 'Main context only' }))
  await tested.settle()

  expect(await claudeCodeOf(tested).fire('session.receive', { origin: { kind: 'peer', plugin: 'other' }, text: 'Deploy production', agentId: id } as never, { text: 'Deploy production' } as never)).toEqual({ consumed: 'Task guard' })
})

test('a subtask closes when its result reaches the parent task', async () => {
  const ended: string[] = []
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const parent = await tested.startTask({ title: 'Find the pane' })
  const child = await tested.startTask({ title: 'Read tree.ts', parent, openedBy: 'toolu_child' })
  ;sessions.current.goal.onTaskEnd((task) => void ended.push(task.id))
  await tested.settle()

  await tested.add({ type: ToolResult, callId: 'toolu_child', output: 'Read it.', isError: false }, { task: parent })

  expect(ended).toEqual([child])
})

test("a session's context hears only the session's own messages, not a task's in a context with the same number", async () => {
  const heard: string[] = []
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Main loop prompt' })
  ;(await sessions.current.context()).onReply((reply) => void heard.push(reply.text))
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
  ;sessions.current.goal.onTurnStart({ prompt: { task: id } }, (turn: Turn) => void turn.messages().then((messages) => read.push(messages.map((message) => message.type))))
  await tested.settle()

  await tested.add({ type: Prompt, text: 'Find where the tree pane is drawn.' }, { task: id })
  await tested.settle()

  expect(read).toEqual([[Prompt]])
})

test('a listener on a turn that has ended throws, naming the turn', async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  await tested.endTurn()

  const [ended] = await sessions.current.turns()

  expect(() => ended!.onReply(() => {})).toThrow(/^history: turn .+ has ended, so its onReply never fires\. Listen on its Session\.$/)
})

test("beforeSessionStart's note, title, and first prompt reach Claude Code, and a matcher keeps one source", async () => {
  const tested = testMod(
    defineMod({
      name: 'tracer',
      setup() {
        sessions.current.beforeSessionStart({ source: 'resume' }, () => ({ note: 'Docs held: none.', title: 'Tree pane', firstPrompt: 'Go on' }))
      },
    }),
    { permissions: ['prompt'] },
  )
  await tested.start()

  expect(await claudeCodeOf(tested).fire('SessionStart', { source: 'startup', session_id: 's1' })).toEqual({})
  expect(await claudeCodeOf(tested).fire('SessionStart', { source: 'resume', session_id: 's1' })).toEqual({ additionalContext: ['<tracer_mod>\nDocs held: none.\n</tracer_mod>'], sessionTitle: 'Tree pane', initialUserMessage: 'Go on' })
})

test("a compaction's note reaches the window of the agent that compacted, hidden from the person, and only the goal's listeners hear a subagent's", async () => {
  const tested = testMod(
    defineMod({
      name: 'tracer',
      setup() {
        sessions.current.beforeSessionStart({ source: 'compact' }, () => ({ note: 'Main agent docs.' }))
        sessions.current.goal.beforeSessionStart({ source: 'compact' }, ({ task }) => ({ note: `Docs of ${task ?? 'the main agent'}.` }))
      },
    }),
    { permissions: ['prompt'] },
  )
  await tested.start()
  const kept = { role: 'user' as const, text: 'The summary.', toolUses: [] }
  const compact = (agentId?: string) => claudeCodeOf(tested).fire('session.compact', { trigger: 'auto', messages: [], ...(agentId === undefined ? {} : { agentId }) } as never, { messages: [kept] } as never)

  expect(await compact()).toEqual({ messages: [kept] })
  expect(tested.shown.notes).toEqual(['Main agent docs.\n\nDocs of the main agent.'])
  expect(await compact('a1')).toEqual({ messages: [kept] })
  expect(tested.shown.notes).toEqual(['Main agent docs.\n\nDocs of the main agent.', 'Docs of a1.'])
})

test("a compaction's title, Skill reload, and first prompt answer the SessionStart Claude Code raises inside it, and its payload carries the model and the tokens left", async () => {
  const heard: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'tracer',
      setup: () =>
        void sessions.current.beforeSessionStart({ source: 'compact' }, (started) => {
          heard.push(started)
          return { title: 'Compacted', reloadSkills: true, firstPrompt: 'Go on.' }
        }),
    }),
    { permissions: ['prompt'] },
  )
  await tested.start()

  expect(await claudeCodeOf(tested).fire('SessionStart', { source: 'compact', session_id: 's1', context_tokens: 1200 } as never)).toEqual({ sessionTitle: 'Compacted', reloadSkills: true, initialUserMessage: 'Go on.' })
  expect(heard).toMatchObject([{ source: 'compact', model: expect.any(String), contextTokenCount: 1200 }])
})

test("a compaction's note needs the prompt permission, as every note does", async () => {
  const tested = testMod(defineMod({ name: 'tracer', setup: () => void sessions.current.beforeSessionStart(() => ({ note: 'Docs held: none.' })) }))
  const kept = { role: 'user' as const, text: 'The summary.', toolUses: [] }

  expect(await claudeCodeOf(tested).fire('session.compact', { trigger: 'auto', messages: [] } as never, { messages: [kept] } as never)).toEqual({ messages: [kept] })
  expect(tested.shown.notes).toEqual([])
  expect(tested.shown.toasts.map(({ message }) => message)).toContain('Answered additionalContext without your grant to "Add text Claude reads and start turns", so cmod dropped it')
})

test('beforeModelChange refuses a switch, and onCwdChange hears the new folder without answering', async () => {
  const moved: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'modes',
      setup() {
        sessions.current.beforeModelChange({ model: /haiku/ }, () => ({ refuse: 'This mode keeps opus.' }))
        sessions.current.onCwdChange((change) => void moved.push({ cwd: change.cwd, previous: change.previous }))
      },
    }),
    { permissions: ['model'] },
  )
  await tested.start()
  const switched = { session_id: 's1', cwd: '/work/a', from_model: 'opus', requested_model: 'haiku', source: 'command', context_tokens: 0, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 0 } as const

  expect(await claudeCodeOf(tested).fire('PreModelSwitch', { ...switched, to_model: 'sonnet' } as never)).toEqual({})
  expect(await claudeCodeOf(tested).fire('PreModelSwitch', { ...switched, to_model: 'haiku' } as never)).toEqual({ permissionDecision: 'deny', permissionDecisionReason: 'This mode keeps opus.' })
  expect(await claudeCodeOf(tested).fire('CwdChanged', { session_id: 's1', cwd: '/work/b', old_cwd: '/work/a', new_cwd: '/work/b' })).toEqual({})
  expect(await claudeCodeOf(tested).fire('CwdChanged', { session_id: 's1', cwd: '/work/c', old_cwd: '/work/b', new_cwd: '/work/c', agent_id: 'a1' } as never)).toEqual({})
  await tested.settle()
  expect(moved).toEqual([{ cwd: '/work/b', previous: '/work/a' }])
})

test("beforeModelChange's note reaches Claude after the switch, and beforeProjectSetup's in the session claude --init-only sets up", async () => {
  const tested = testMod(
    defineMod({
      name: 'modes',
      setup() {
        sessions.current.beforeModelChange({ model: /haiku/ }, () => ({ note: 'Keep answers short on haiku.' }))
        sessions.current.beforeProjectSetup(() => ({ note: 'Run bun install first.' }))
      },
    }),
    { permissions: ['prompt'] },
  )
  await tested.start()
  const switched = { session_id: 's1', cwd: '/work/a', from_model: 'opus', to_model: 'haiku', requested_model: 'haiku', source: 'command', context_tokens: 0, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 0 } as const
  const code = claudeCodeOf(tested)

  expect(await code.fire('PreModelSwitch', switched as never)).toEqual({})
  expect(await code.fire('PostModelSwitch', switched as never)).toEqual({ additionalContext: ['<modes_mod>\nKeep answers short on haiku.\n</modes_mod>'] })
  expect(await code.fire('PostModelSwitch', switched as never)).toEqual({})
  expect(await code.fire('Setup', { session_id: 's1', cwd: '/work/a', trigger: 'init' } as never)).toEqual({ additionalContext: ['<modes_mod>\nRun bun install first.\n</modes_mod>'] })
})

test("a model change's note reaches only the switch it answered, so a switch refused later leaves none for the next", async () => {
  const tested = testMod(defineMod({ name: 'modes', setup: () => void sessions.current.beforeModelChange({ model: /haiku/ }, () => ({ note: 'Keep answers short on haiku.' })) }), { permissions: ['prompt'] })
  await tested.start()
  const switched = { session_id: 's1', cwd: '/work/a', from_model: 'opus', to_model: 'haiku', requested_model: 'haiku', source: 'command', context_tokens: 0, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 0 } as const
  const code = claudeCodeOf(tested)

  await code.fire('PreModelSwitch', switched as never)
  await code.fire('PreModelSwitch', { ...switched, to_model: 'sonnet', requested_model: 'sonnet' } as never)

  expect(await code.fire('PostModelSwitch', { ...switched, to_model: 'sonnet', requested_model: 'sonnet' } as never)).toEqual({})
})

test('a model change or project setup note needs the prompt permission, as every note does', async () => {
  const tested = testMod(
    defineMod({
      name: 'modes',
      setup() {
        sessions.current.beforeModelChange(() => ({ note: 'Keep answers short.' }))
        sessions.current.beforeProjectSetup(() => ({ note: 'Run bun install first.' }))
      },
    }),
  )
  await tested.start()
  const switched = { session_id: 's1', cwd: '/work/a', from_model: 'opus', to_model: 'haiku', requested_model: 'haiku', source: 'command', context_tokens: 0, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 0 } as const
  const code = claudeCodeOf(tested)

  await code.fire('PreModelSwitch', switched as never)

  expect(await code.fire('PostModelSwitch', switched as never)).toEqual({})
  expect(await code.fire('Setup', { session_id: 's1', cwd: '/work/a', trigger: 'init' } as never)).toEqual({})
  expect(tested.shown.toasts.filter(({ type }) => type === 'warning').map(({ message }) => message)).toEqual([expect.stringContaining('without your grant to "Add text Claude reads and start turns"')])
})

test("beforePrompt's note reaches Claude beside the prompt, and its title names the session", async () => {
  const tested = testMod(
    defineMod({
      name: 'classify',
      setup() {
        sessions.current.beforePrompt({ text: /^\/?commit/ }, () => ({ note: 'The person asked for a commit.', title: 'Commit' }))
      },
    }),
    { permissions: ['prompt'] },
  )
  await tested.start()

  expect(await claudeCodeOf(tested).fire('prompt.submit', { text: 'commit this', origin: { kind: 'composer' }, wait: false })).toEqual({ text: 'commit this', context: ['<classify_mod>\nThe person asked for a commit.\n</classify_mod>'], origin: { kind: 'composer' } })
  await claudeCodeOf(tested).fire('prompt.submit', { text: 'next', origin: { kind: 'composer' }, wait: false })
  expect(await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'next' })).toEqual({})
  expect(await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'commit this' })).toEqual({ sessionTitle: 'Commit' })
  expect(await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'commit this' })).toEqual({})
  await claudeCodeOf(tested).fire('prompt.submit', { text: 'commit it', origin: { kind: 'composer' }, wait: false }, { text: 'commit it now', origin: { kind: 'composer' } } as never)
  expect(await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'commit it now' })).toEqual({ sessionTitle: 'Commit' })
  await claudeCodeOf(tested).fire('prompt.submit', { text: 'commit that', origin: { kind: 'composer' }, wait: false }, { drop: 'Not now.' } as never)
  expect(await claudeCodeOf(tested).fire('UserPromptSubmit', { prompt: 'commit that' })).toEqual({})
})

test("beforeToolResult adds a note, rewrites the output, or marks the result failed", async () => {
  const tested = testMod(
    defineMod({
      name: 'docs',
      setup() {
        sessions.current.beforeToolResult({ name: 'Read' }, () => ({ note: 'src/CLAUDE.md says: no default exports.' }))
        sessions.current.beforeToolResult({ name: 'Bash' }, ({ output }) => ({ output: String(output).replace('sk-secret', '[hidden]') }))
        sessions.current.beforeToolResult({ name: 'Write' }, () => ({ isError: true, note: 'Write only under src/.' }))
      },
    }),
    { permissions: ['prompt'] },
  )
  await tested.start()
  const used = (tool_name: string, tool_response: unknown) => ({ session_id: 's1', cwd: '/work', tool_name, tool_input: {}, tool_use_id: 'toolu_1', tool_response }) as never

  expect(await claudeCodeOf(tested).fire('PostToolUse', used('Read', 'export const a = 1'))).toEqual({ additionalContext: ['<docs_mod>\nsrc/CLAUDE.md says: no default exports.\n</docs_mod>'] })
  expect(await claudeCodeOf(tested).fire('PostToolUse', used('Bash', 'key=sk-secret'))).toEqual({ updatedToolOutput: 'key=[hidden]' })
  expect(await claudeCodeOf(tested).fire('PostToolUse', used('Write', {}))).toEqual({ block: 'Write only under src/.' })
})

test('beforePermissionCheck approves a call with approve, and asks or refuses one with no permission', async () => {
  const guard = (permissions: string[]) =>
    testMod(
      defineMod({
        name: 'auto-approve',
        setup() {
          sessions.current.beforePermissionCheck({ name: 'Read' }, () => ({ allow: true }))
          sessions.current.beforePermissionCheck({ name: 'Bash', input: { command: /^git push/ } }, () => ({ ask: 'Pushing leaves this computer.' }))
          sessions.current.beforePermissionCheck({ name: 'Bash', input: { command: /^rm / } }, () => ({ refuse: 'Use trash instead of rm.' }))
        },
      }),
      { permissions },
    )
  const check = (tool: string, input: object) => ({ tool, input, tool_use_id: 'toolu_1' }) as never

  const allowed = guard(['approve'])
  await allowed.start()
  expect(await claudeCodeOf(allowed).fire('tool.check', check('Read', { file_path: '/work/a.ts' }))).toEqual({ decision: 'allow' })
  expect(await claudeCodeOf(allowed).fire('tool.check', check('Bash', { command: 'git push' }))).toEqual({ decision: 'ask', reason: 'Pushing leaves this computer.' })

  const unallowed = guard([])
  await unallowed.start()
  expect(await claudeCodeOf(unallowed).fire('tool.check', check('Bash', { command: 'rm -rf build' }))).toEqual({ decision: 'deny', reason: 'Use trash instead of rm.' })
})

test('abort stops a running turn with the prompt permission, and throws on an ended one', async () => {
  const tested = testMod(defineMod({ name: 'guard', setup() {} }), { permissions: ['prompt'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Deploy to prod' })

  const running = await sessions.current.turn()
  await running!.abort()
  await tested.endTurn()
  const [ended] = await sessions.current.turns()

  expect(tested.calls.filter((call) => call.call === 'cmod.call').map((call) => call.args[0]).filter((args) => (args as { method: string }).method === 'cmod:act')).toMatchObject([{ input: { action: 'abort', input: { turn: running!.prompt.id } } }])
  await expect(ended!.abort()).rejects.toThrow(/has ended, so there is nothing to abort/)
  await tested.add({ type: Prompt, text: 'Deploy to staging' })
  await expect(running!.abort()).rejects.toThrow(/has ended, so there is nothing to abort/)
})

test('onToolResult hears the files a call changed and read, with the tool and its input', async () => {
  const heard: unknown[] = []
  const tested = testMod(
    defineMod({
      name: 'tree',
      setup() {
        sessions.current.onToolResult(({ name, files }) => void heard.push({ name, files }))
      },
    }),
    { projectRoot: '/test/project', files: { '/test/project/notes.md': 'notes' } },
  )
  await tested.start()
  await tested.add({ type: Prompt, text: 'Tidy the notes' })
  await tested.add({ type: ToolCall, name: 'Bash', input: { command: 'cat notes.md > summary.md' }, callId: 'toolu_1' })
  await tested.add({ type: ToolResult, callId: 'toolu_1', output: '' })
  await tested.settle()

  expect(heard).toEqual([{ name: 'Bash', files: { read: ['/test/project/notes.md'], changed: ['/test/project/summary.md'] } }])
})

test('a turn searches only its own messages', async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  await tested.endTurn()
  await tested.add({ type: Prompt, text: 'Rename the log pane' })

  const turn = await sessions.current.turn()

  expect((await Array.fromAsync(turn!.search('rename'))).map((message) => message.type === Prompt && message.text)).toEqual(['Rename the log pane'])
  expect(await Array.fromAsync(sessions.current.search('rename'))).toHaveLength(2)
})

test("a session searches its own agent's messages, its goal every agent's, and a task's owner only its own", async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const task = await tested.startTask({ title: 'Find the pane' })
  await tested.add({ type: Prompt, text: 'Rename the pane file' }, { task })
  const sub = await tested.startTask({ title: 'Read the pane', parent: task })
  await tested.add({ type: Prompt, text: 'Rename nothing yet' }, { task: sub })
  const [found] = await sessions.current.goal.tasks()
  const texts = async (messages: AsyncIterable<Message>) => (await Array.fromAsync(messages)).map((message) => message.type === Prompt && message.text)

  expect(await texts(sessions.current.search('rename'))).toEqual(['Rename the tree pane'])
  expect(await texts(sessions.current.goal.search('rename'))).toEqual(['Rename nothing yet', 'Rename the pane file', 'Rename the tree pane'])
  expect(await texts(found!.owner.search('rename'))).toEqual(['Rename the pane file'])
  expect(await texts(found!.search('rename'))).toEqual(['Rename nothing yet', 'Rename the pane file'])
})

test('a search reads page after page until the loop breaks', async () => {
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  for (let index = 0; index < 120; index += 1) await tested.add({ type: Prompt, text: `Rename pane ${index}` })

  const every = await Array.fromAsync(sessions.current.search('rename'))
  const firstThree: string[] = []
  for await (const message of sessions.current.search('rename')) {
    if (message.type === Prompt) firstThree.push(message.text)
    if (firstThree.length === 3) break
  }

  expect(every).toHaveLength(120)
  expect(firstThree).toEqual(['Rename pane 119', 'Rename pane 118', 'Rename pane 117'])
})

test('beforePrompt rewrites a typed prompt and refuses another', async () => {
  const tested = testMod(
    defineMod({
      name: 'guard',
      setup() {
        sessions.current.beforePrompt((prompt) => (prompt.text.includes('prod') ? { refuse: 'No deploys to prod from here.' } : { text: `${prompt.text}, with tests` }))
      },
    }),
    { permissions: ['conversation', 'prompt'] },
  )
  await tested.start()

  const typed = { origin: { kind: 'composer' }, wait: false } as const

  expect(await claudeCodeOf(tested).fire('prompt.submit', { ...typed, text: 'Fix the login bug' })).toEqual({ text: 'Fix the login bug, with tests', origin: { kind: 'composer' } })
  expect(await claudeCodeOf(tested).fire('prompt.submit', { ...typed, text: 'Deploy to prod' })).toEqual({ drop: 'No deploys to prod from here.' })
})

test('beforeToolCall refuses a call with no permission, and rewrites one only with the tools permission', async () => {
  const guard = (permissions: string[]) =>
    testMod(
      defineMod({
        name: 'guard',
        setup() {
          sessions.current.beforeToolCall({ name: 'Bash', input: { command: /^rm / } }, () => ({ refuse: 'Use trash instead of rm.' }))
          sessions.current.beforeToolCall({ name: 'Bash', input: { command: /^ls$/ } }, () => ({ input: { command: 'ls -la' } }))
        },
      }),
      { permissions },
    )
  const call = (command: string) => ({ tool: 'Bash', tool_use_id: 'toolu_9', command }) as never

  const unallowed = guard([])
  await unallowed.start()
  expect(await claudeCodeOf(unallowed).fire('tool.call', call('rm -rf build'))).toEqual({ deny: 'Use trash instead of rm.' })
  expect(await claudeCodeOf(unallowed).fire('tool.call', call('ls'))).toEqual({} as never)
  await unallowed.settle()
  expect(unallowed.shown.toasts.filter(({ type }) => type === 'error').map(({ message }) => message)).toEqual(['The beforeToolCall listener failed'])

  const allowed = guard(['tools'])
  await allowed.start()
  await claudeCodeOf(allowed).fire('tool.call', call('ls'))
  await allowed.settle()
  expect(allowed.shown.toasts.filter(({ type }) => type === 'error')).toEqual([])
})

test("beforeToolCall's cwd is the folder a subagent runs in, which a task given its own cwd changes", async () => {
  const folders: string[] = []
  const tested = testMod(
    defineMod({
      name: 'gate',
      setup() {
        sessions.current.goal.beforeToolCall((call) => void folders.push(call.cwd))
      },
    }),
    { permissions: ['tools', 'tasks', 'conversation'] },
  )
  await tested.start()
  const call = (agentId?: string) => ({ tool: 'Read', tool_use_id: 'toolu_9', file_path: 'a.ts', ...(agentId === undefined ? {} : { agentId }) }) as never

  await claudeCodeOf(tested).fire('tool.call', call())
  await claudeCodeOf(tested).fire('agent.spawn', { tool_use_id: 'toolu_1', prompt: 'Fix the api.', description: 'Fix the api', subagentType: 'general-purpose', parentModel: 'opus', cwd: 'packages/api' } as never)
  await claudeCodeOf(tested).fire('tool.call', call('agent-1'))
  await claudeCodeOf(tested).fire('classic.SubagentStop', { agent_id: 'agent-1', agent_type: 'general-purpose', stop_hook_active: false } as never)
  await claudeCodeOf(tested).fire('tool.call', call('agent-1'))
  await claudeCodeOf(tested).fire('agent.spawn', { tool_use_id: 'toolu_2', prompt: 'Review.', description: 'Review', subagentType: 'general-purpose', parentModel: 'opus', cwd: 'packages/web', isTeammate: true } as never)
  await claudeCodeOf(tested).fire('tool.call', call('agent-1'))

  const session = folders[0] ?? ''
  expect(session).not.toBe('')
  expect(folders).toEqual([session, `${session}/packages/api`, session, session])
})

test('beforeTaskStart picks the model a task runs on', async () => {
  const tested = testMod(
    defineMod({
      name: 'thrift',
      setup() {
        sessions.current.beforeTaskStart({ owner: { agentType: 'Explore' } }, () => ({ owner: { model: 'haiku' } }))
      },
    }),
    { permissions: ['conversation', 'tasks'] },
  )
  await tested.start()

  const spawn = { tool_use_id: 'toolu_1', prompt: 'Find it.', description: 'Find it', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus' }

  expect(await claudeCodeOf(tested).fire('agent.spawn', { ...spawn, subagentType: 'Explore' } as never)).toEqual({ agentId: 'agent-1', model: 'haiku' } as never)
  expect(await claudeCodeOf(tested).fire('agent.spawn', { ...spawn, subagentType: 'Plan' } as never)).toEqual({ agentId: 'agent-1', model: 'opus' } as never)
})

test("beforeTaskStart rewrites a task's prompt and owner, and the task's agent starts on the answered prompt", async () => {
  const prompts: string[] = []
  const tested = testMod(
    defineMod({
      name: 'scoper',
      setup() {
        sessions.current.beforeTaskStart(() => ({ prompt: 'Find it in src only.', title: 'Find it in src', owner: { agentType: 'Explore', model: 'haiku', cwd: '/work/src' }, isAsync: true }))
        sessions.current.goal.beforePrompt({ task: /./ }, (prompt) => void prompts.push(prompt.text))
      },
    }),
    { permissions: ['conversation', 'tasks', 'prompt'] },
  )
  await tested.start()
  await tested.add({ type: Prompt, text: 'Find the config' })

  const spawn = { tool_use_id: 'toolu_1', prompt: 'Find it.', description: 'Find it', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', background: false, fork: false }

  expect(await claudeCodeOf(tested).fire('agent.spawn', spawn as never)).toEqual({ agentId: 'agent-1', model: 'haiku' } as never)
  expect(prompts).toEqual(['Find it in src only.'])
})

test('a removed before listener stops answering', async () => {
  let listening: Subscription | undefined
  const tested = testMod(
    defineMod({
      name: 'guard',
      setup() {
        listening = sessions.current.beforePrompt(() => ({ refuse: 'Not now.' }))
      },
    }),
    { permissions: ['conversation', 'prompt'] },
  )
  await tested.start()
  listening?.remove()

  expect(await claudeCodeOf(tested).fire('prompt.submit', { text: 'Go', origin: { kind: 'composer' }, wait: false })).toEqual({ text: 'Go', origin: { kind: 'composer' } })
})

test('a before listener removed after /clear stops answering in the new session', async () => {
  let listening: Subscription | undefined
  const tested = testMod(
    defineMod({
      name: 'guard',
      setup() {
        listening = sessions.current.beforePrompt(() => ({ refuse: 'Stopped by listener' }))
      },
    }),
    { permissions: ['conversation', 'prompt'] },
  )
  await tested.start()
  await claudeCodeOf(tested).fire('SessionStart', { source: 'clear', session_id: 'after-clear' })
  await tested.settle()

  listening?.remove()
  await tested.settle()

  expect(await claudeCodeOf(tested).fire('prompt.submit', { text: 'Continue', origin: { kind: 'composer' }, wait: false })).toEqual({ text: 'Continue', origin: { kind: 'composer' } })
})

test('a task heard starting in another running session is running, and a send reaches it', async () => {
  const called: unknown[] = []
  const fake = fakeClaude({ name: 'watcher', root: '/plugins/watcher' })
  fake.fakes.cmod.call = async (input) => {
    called.push(input)
    return { value: null }
  }
  const client = createSessionsClient({ name: 'watcher', claude: fake.claude, report: () => {}, isGranted: () => true })
  const owners: TaskOwner[] = []
  client.sessions.onTaskStart((task) => void owners.push(task.owner))
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
  client.sessions.onPrompt((prompt) => void heard.push(`every: ${prompt.text}`))
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
  const [task] = await sessions.current.goal.tasks()
  const goal = task!.owner.goal
  goal.onGoalChange(async (changed) => void heard.push(await changed.text()))
  await tested.settle()

  await goal.update({ text: 'Find where tree.ts draws the pane' })
  await tested.settle()

  expect(heard).toEqual(['Find where tree.ts draws the pane'])
  expect(await task!.owner.goal.text()).toBe('Find where tree.ts draws the pane')
})

test("a task goal's event payload updates that task's goal, never the session's", async () => {
  const payloads: { update(goal: { text: string }): Promise<void> }[] = []
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Main goal' })
  await tested.startTask({ title: 'Find the pane' })
  const [task] = await sessions.current.goal.tasks()
  const goal = task!.owner.goal
  goal.onGoalChange((changed) => void payloads.push(changed))
  await tested.settle()
  await goal.update({ text: 'Child goal' })
  await tested.settle()

  await payloads[0]?.update({ text: 'Updated through event' })

  expect([await sessions.current.goal.text(), await task!.owner.goal.text()]).toEqual(['Main goal', 'Updated through event'])
})

test('callTool with CronList or CronDelete needs the tools permission', async () => {
  const tested = testMod(defineMod({ name: 'runner', setup() {} }), { permissions: [] })
  await tested.start()

  await expect(sessions.current.callTool({ name: 'CronList', input: {} })).rejects.toThrow('runner calls callTool, which needs "permissions": { "tools": true } in package.json "cmod".')
  expect(tested.calls.filter((call) => call.call === 'tool.call')).toEqual([])
})

test("a task owner's goal hears the owner and the tasks it started", async () => {
  const heard: string[] = []
  const tested = testMod(defineMod({ name: 'history', setup() {} }), { permissions: ['conversation'] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })
  const owner = await tested.startTask({ title: 'Find the pane' })
  const child = await tested.startTask({ title: 'Read tree.ts', parent: owner })
  const [task] = (await sessions.current.goal.tasks()).filter((each) => each.id === owner)
  ;task!.owner.goal.onReply((reply) => void heard.push(reply.text))
  await tested.settle()

  await tested.add({ type: Reply, text: 'Owner reply' }, { task: owner })
  await tested.add({ type: Reply, text: 'Child reply' }, { task: child })
  await tested.settle()

  expect(heard).toEqual(['Owner reply', 'Child reply'])
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

  expect([result.type, result.name, result.input, result.output, result.isError, result.session]).toEqual(['toolResult', 'Bash', { command: 'bun run build' }, { stdout: 'ok' }, false, 'test-session'])
  expect(tested.calls.filter((call) => call.call === 'tool.call').map((call) => call.args[0])).toEqual([{ command: 'bun run build', tool: 'Bash' }])
})

test('callTool with CronCreate needs the prompt permission, because a schedule starts turns', async () => {
  const tested = testMod(defineMod({ name: 'runner', setup() {} }), { permissions: ['tools'] })
  await tested.start()

  await expect(sessions.current.callTool({ name: 'CronCreate', input: { cron: '0 9 * * *', prompt: 'Standup' } })).rejects.toThrow('runner calls callTool, which needs "permissions": { "prompt": true } in package.json "cmod".')
  expect(tested.calls.filter((call) => call.call === 'tool.call')).toEqual([])
})

test('surfaces() names the Claude apps showing the session, and an ended session shows in none', async () => {
  const tested = testMod(defineMod({ name: 'compact', setup() {} }), { permissions: ['conversation'], sessions: [{ id: 'older', lastAt: '2026-10-10T09:00:00.000Z', messages: [{ type: Prompt, text: 'Older work' }] }] })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Now' })
  const older = (await sessions.list()).find((session) => session.id === 'older')

  expect(await sessions.current.surfaces()).toEqual(['terminal'])
  expect(await older!.surfaces()).toEqual([])
  expect((await older!.usage()).model).toBe('test-model')
})

test("usage() names each rate limit of the account's plan, how much of it is used, and when it resets", async () => {
  const tested = testMod(defineMod({ name: 'limits', setup() {} }))
  tested.fakes.session.usage = async () => ({ startedAt: 0, context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-22T20:00:00.000Z' }, { kind: 'seven_day', percentUsed: 7 }] })
  await tested.start()

  expect((await sessions.current.usage()).rateLimits).toEqual([
    { type: 'five_hour', percent: 23.5, resetsAt: '2026-10-22T20:00:00.000Z' },
    { type: 'seven_day', percent: 7 },
  ])
})

type SeenTask = { readonly id: string; readonly isBackground?: true; readonly owner: { readonly id: string; readonly agentType?: string; readonly model?: string; readonly forkedFrom?: string } }

const seenOf = ({ id, isBackground, owner }: SeenTask) => ({ id, isBackground, owner: { id: owner.id, agentType: owner.agentType, model: owner.model, forkedFrom: owner.forkedFrom } })

test("a subagent's task has no isBackground and no forkedFrom, takes every beforeTaskStart answer, and ends at its result", async () => {
  const started: SeenTask[] = []
  const ended: string[] = []
  const tested = testMod(
    defineMod({
      name: 'tasks',
      setup() {
        sessions.current.beforeTaskStart((task) => void started.push(task))
        sessions.current.beforeTaskStart(() => ({ prompt: 'Look in src.', title: 'Look in src', owner: { model: 'haiku' }, isAsync: true }))
        sessions.current.goal.onTaskEnd((task) => void ended.push(task.id))
      },
    }),
    { permissions: ['conversation', 'tasks'] },
  )
  await tested.start()
  await tested.add({ type: Prompt, text: 'Rename the tree pane' })

  expect(await claudeCodeOf(tested).fire('agent.spawn', { tool_use_id: 'toolu_1', prompt: 'Look.', description: 'Look', subagentType: 'Explore', parentModel: 'opus' } as never)).toEqual({ agentId: 'agent-1', model: 'haiku' } as never)
  const id = await tested.startTask({ title: 'Look in src', agentType: 'Explore', openedBy: 'toolu_1' })
  await tested.add({ type: ToolResult, callId: 'toolu_1', output: 'Found it.', isError: false })

  expect(started.map(seenOf)).toEqual([{ id: '', isBackground: undefined, owner: { id: '', agentType: 'Explore', model: 'opus', forkedFrom: undefined } }])
  expect(ended).toEqual([id])
})

test("a fork's owner is a subagent forked from this session, without an agent type, whose beforeTaskStart takes only prompt, title, and refuse", async () => {
  const started: SeenTask[] = []
  const ended: string[] = []
  const tested = testMod(
    defineMod({
      name: 'tasks',
      setup() {
        sessions.current.beforeTaskStart((task) => void started.push(task))
        sessions.current.beforeTaskStart(() => ({ title: 'Write the tests now', owner: { model: 'haiku' }, isAsync: true }))
        sessions.current.goal.onTaskEnd((task) => void ended.push(task.id))
      },
    }),
    { permissions: ['conversation', 'tasks'] },
  )
  const spawned: unknown[] = []
  tested.fakes.agent.spawn = async (args) => (spawned.push(args), { agentId: 'agent-7', model: 'opus' })
  await tested.start()
  await tested.add({ type: Prompt, text: 'Build the parser' })

  const fork = await sessions.current.fork({ title: 'Write the tests', prompt: 'Write tests for what we just built.' })
  expect(await claudeCodeOf(tested).fire('agent.spawn', { tool_use_id: 'toolu_1', prompt: 'Write tests.', description: 'Write the tests', subagentType: 'fork', parentModel: 'opus' } as never)).toEqual({ agentId: 'agent-1', model: 'opus' } as never)
  const id = await tested.startTask({ title: 'Write the tests', forkedFrom: 'test-session', openedBy: 'toolu_1' })
  await tested.add({ type: ToolResult, callId: 'toolu_1', output: 'Wrote them.', isError: false })

  expect(seenOf(fork)).toEqual({ id: 'agent-7', isBackground: undefined, owner: { id: 'agent-7', agentType: undefined, model: 'opus', forkedFrom: 'test-session' } })
  expect(spawned).toEqual([{ prompt: 'Write tests for what we just built.', description: 'Write the tests', subagentType: 'fork' }])
  expect(started.map(seenOf)).toEqual([{ id: '', isBackground: undefined, owner: { id: '', agentType: undefined, model: 'opus', forkedFrom: 'test-session' } }])
  expect(ended).toEqual([id])
})

test("a background task's owner is a new session whose id is the task's, its beforeTaskStart takes prompt, title, owner, and refuse, and it ends at that session's first answer", async () => {
  const ended: string[] = []
  const tested = testMod(
    defineMod({
      name: 'tasks',
      setup() {
        sessions.current.beforeTaskStart({ isBackground: true }, () => ({ title: 'Upgrade the dependencies', owner: { model: 'haiku' } }))
        sessions.current.goal.onTaskEnd((task) => void ended.push(task.id))
      },
    }),
    { permissions: ['conversation', 'tasks'] },
  )
  await tested.start()
  await tested.add({ type: Prompt, text: 'Ship the release' })
  await tested.settle()

  const task = await sessions.current.startTask({ title: 'Upgrade', prompt: 'Upgrade every dependency.', isBackground: true })
  await tested.add({ type: Prompt, text: 'Upgrade every dependency.' }, { task: task.id })
  await tested.add({ type: Reply, text: 'Upgraded.' }, { task: task.id })
  await tested.endTurn({ answer: 'Upgraded.' }, { task: task.id })
  await tested.add({ type: Prompt, text: 'And the lockfile?' }, { task: task.id })
  await tested.endTurn({ answer: 'Done.' }, { task: task.id })

  expect(seenOf(task)).toEqual({ id: task.id, isBackground: true, owner: { id: task.id, agentType: undefined, model: 'haiku', forkedFrom: undefined } })
  expect(task.title).toBe('Upgrade the dependencies')
  expect((await task.owner.messages()).map((message) => message.type)).toEqual([Prompt, Reply, Prompt])
  expect(await task.owner.goal.text()).toBe('Upgrade every dependency.')
  expect(ended).toEqual([task.id])
  await expect(sessions.current.startTask({ title: 'Upgrade', prompt: 'Upgrade.', isBackground: true, name: 'upgrader' })).rejects.toThrow('tasks: a background task takes no name.')
})

test("a clone is a background task whose owner is forked from this session, and its beforeTaskStart refuses it", async () => {
  const ended: string[] = []
  const tested = testMod(
    defineMod({
      name: 'tasks',
      setup() {
        sessions.current.beforeTaskStart({ isBackground: true, owner: { forkedFrom: 'test-session' }, title: 'Try SQL' }, () => ({ refuse: 'SQL is out.' }))
        sessions.current.goal.onTaskEnd((task) => void ended.push(task.id))
      },
    }),
    { permissions: ['conversation', 'tasks'] },
  )
  await tested.start()
  await tested.add({ type: Prompt, text: 'Store the notes' })
  await tested.settle()

  await expect(sessions.current.clone({ title: 'Try SQL', prompt: 'Rebuild this on SQL.' })).rejects.toThrow('tasks: a beforeTaskStart listener refused the task: SQL is out.')
  const clone = await sessions.current.clone({ title: 'Try files', prompt: 'Rebuild this on plain files.' })
  await tested.endTurn({ answer: 'Rebuilt.' }, { task: clone.id })

  expect(seenOf(clone)).toEqual({ id: clone.id, isBackground: true, owner: { id: clone.id, agentType: undefined, model: '', forkedFrom: 'test-session' } })
  expect((await sessions.current.goal.tasks()).map((task) => task.title)).toEqual(['Try files'])
  expect(ended).toEqual([clone.id])
})
