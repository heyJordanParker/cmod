import { expect, test } from 'bun:test'
import { ContextEnd, ContextStart } from '../../src/session/context/context.js'
import { Document } from '../../src/session/context/turn/message/document.js'
import { Message, rowOfLine, type Row } from '../../src/session/context/turn/message/message.js'
import { Note } from '../../src/session/context/turn/message/note.js'
import { Notice } from '../../src/session/context/turn/message/notice.js'
import { Prompt } from '../../src/session/context/turn/message/prompt.js'
import { Reply } from '../../src/session/context/turn/message/reply.js'
import { Channel, Person, Schedule } from '../../src/session/context/turn/message/sender.js'
import { Skill } from '../../src/session/context/turn/message/skill.js'
import { ToolCall } from '../../src/session/context/turn/message/tool-call.js'
import { ToolResult } from '../../src/session/context/turn/message/tool-result.js'
import { TurnEnd, TurnStart } from '../../src/session/context/turn/turn.js'
import { createConversation, emptyConversation, type SessionChange } from '../../src/session/conversation.js'
import { GoalChange } from '../../src/session/goal/goal.js'
import { TaskEnd, TaskStart } from '../../src/session/goal/task.js'

let seconds = 0

function line(fields: Readonly<Record<string, unknown>>): Row {
  seconds += 1
  const row = rowOfLine({ uuid: `row-${seconds}`, timestamp: `2026-10-13T10:00:${String(seconds).padStart(2, '0')}.000Z`, ...fields })
  if (row === undefined) throw new Error(`not a transcript row: ${JSON.stringify(fields)}`)
  return row
}

const typed = (text: string, origin?: unknown) => line({ type: 'user', message: { role: 'user', content: text }, ...(origin === undefined ? {} : { origin }) })

const said = (...content: readonly unknown[]) => line({ type: 'assistant', message: { role: 'assistant', model: 'claude-test', content } })

const answered = (callId: string, text: string) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: text }] } })

const turnEnded = () => line({ type: 'system', subtype: 'turn_duration', content: '' })

const kinds = (changes: readonly SessionChange[]) => changes.map((change) => (change.type === Message ? change.message.type : change.type))

test('a prompt opens the first context and a turn, sets the goal, and is placed in its own turn', () => {
  const conversation = createConversation(emptyConversation('s1'))

  const changes = conversation.add(typed('Rename the tree pane'))
  const prompt = changes.find((change) => change.type === Message)

  expect(kinds(changes)).toEqual([ContextStart, TurnStart, GoalChange, Prompt])
  expect(prompt?.type === Message && prompt.message).toMatchObject({ type: Prompt, text: 'Rename the tree pane', from: { type: Person }, session: 's1', context: 1, turn: prompt?.type === Message ? prompt.message.id : '' })
})

test("Claude's text and tool calls in one row become a Reply and a ToolCall, each with its own id", () => {
  const conversation = createConversation(emptyConversation('s1'))
  conversation.add(typed('Read the tree'))

  const row = said({ type: 'text', text: 'Reading it.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/work/tree.ts' } })
  const messages = conversation.add(row).flatMap((change) => (change.type === Message ? [change.message] : []))

  expect(messages.map((message) => [message.type, message.id])).toEqual([
    [Reply, `${row.id}:0`],
    [ToolCall, `${row.id}:1`],
  ])
  expect(messages[1]).toMatchObject({ name: 'Read', callId: 'toolu_1', input: { file_path: '/work/tree.ts' } })
})

test('a tool result becomes a ToolResult, and the turn ends at turn_duration with its closing time', () => {
  const conversation = createConversation(emptyConversation('s1'))
  conversation.add(typed('Read the tree'))
  conversation.add(said({ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }))

  const result = conversation.add(answered('toolu_1', 'export function Tree() {}'))
  const end = turnEnded()
  const ended = conversation.add(end)

  expect(result.map((change) => change.type === Message && change.message)).toEqual([expect.objectContaining({ type: ToolResult, callId: 'toolu_1', text: 'export function Tree() {}', isError: false })])
  expect(kinds(ended)).toEqual([TurnEnd])
  expect(ended[0]?.type === TurnEnd && ended[0].turn.closedAt).toBe(end.at)
})

test('a compact boundary ends the context and opens the next, and the summary row adds no message', () => {
  const conversation = createConversation(emptyConversation('s1'))
  conversation.add(typed('Rename the tree pane'))

  const compacted = conversation.add(line({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' }))
  const summary = conversation.add(line({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued.' } }))

  expect(compacted.map((change) => [change.type, 'context' in change ? change.context.number : 0])).toEqual([
    [ContextEnd, 1],
    [ContextStart, 2],
  ])
  expect(summary).toEqual([])
})

test('each origin names its sender', () => {
  const conversation = createConversation(emptyConversation('s1'))
  const senderOf = (row: Row) => conversation.add(row).flatMap((change) => (change.type === Message && 'from' in change.message ? [change.message.from] : []))

  expect(senderOf(typed('from the keyboard', { kind: 'human' }))).toEqual([{ type: Person }])
  expect(senderOf(typed('from a mod', { kind: 'plugin', name: 'modes' }))).toEqual([{ type: 'mod', name: 'modes' }])
  expect(senderOf(typed('from a mod as the person', { kind: 'plugin', name: 'modes', asUser: true }))).toEqual([{ type: 'mod', name: 'modes', as: Person }])
  expect(senderOf(typed('on a schedule', { kind: 'scheduled-trigger' }))).toEqual([{ type: Schedule }])
  expect(senderOf(typed('from Slack', { kind: 'channel', server: 'slack' }))).toEqual([{ type: Channel, name: 'slack' }])
  expect(senderOf(typed('from another session', { kind: 'peer' }))).toEqual([{ type: 'session' }])
})

test('a meta row is a Note, a skill row a Skill, a nested CLAUDE.md a Document, and a system line a Notice', () => {
  const conversation = createConversation(emptyConversation('s1'))
  conversation.add(typed('Start'))
  const messageOf = (row: Row) => conversation.add(row).flatMap((change) => (change.type === Message ? [change.message] : []))[0]

  expect(messageOf(line({ type: 'user', isMeta: true, origin: { kind: 'plugin', name: 'ci-watch' }, message: { role: 'user', content: 'CI failed on main.' } }))).toMatchObject({ type: Note, text: 'CI failed on main.', from: { type: 'mod', name: 'ci-watch' } })
  expect(messageOf(line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: /skills/review\n\nReview the diff.' } }))).toMatchObject({ type: Skill, name: 'review' })
  expect(messageOf(line({ type: 'attachment', attachment: { type: 'nested_memory', path: '/work/src/CLAUDE.md', content: 'Use tabs.' } }))).toMatchObject({ type: Document, path: '/work/src/CLAUDE.md', text: 'Use tabs.' })
  expect(messageOf(line({ type: 'system', subtype: 'informational', content: 'Model switched to haiku.' }))).toMatchObject({ type: Notice, text: 'Model switched to haiku.' })
})

test('a slash command reads as the command a person typed, and its local output adds no message', () => {
  const conversation = createConversation(emptyConversation('s1'))
  const textOf = (row: Row) => conversation.add(row).flatMap((change) => (change.type === Message && change.message.type === Prompt ? [change.message.text] : []))

  expect(textOf(typed('<command-name>/review</command-name>\n<command-args>12</command-args>'))).toEqual(['/review 12'])
  expect(textOf(typed('<local-command-stdout>Reviewed.</local-command-stdout>'))).toEqual([])
})

test('a task opened by an Agent call keeps its own messages and ends at the call result', () => {
  const conversation = createConversation(emptyConversation('s1'))
  conversation.add(typed('Find the pane'))
  conversation.add(said({ type: 'tool_use', id: 'toolu_9', name: 'Agent', input: { prompt: 'find the pane' } }))

  const started = conversation.startTask({ id: 'agent-3', title: 'find the pane', agentType: 'explorer', openedBy: 'toolu_9', openedAt: '2026-10-13T10:01:00.000Z' })
  const inTask = conversation.add(said({ type: 'text', text: 'Found it in tree.ts.' }), 'agent-3')
  const ended = conversation.add(answered('toolu_9', 'found it'))

  expect(kinds(started)).toEqual([TaskStart])
  expect(inTask.map((change) => change.type === Message && [change.message.task, change.message.turn, change.message.context])).toEqual([['agent-3', undefined, 1]])
  expect(kinds(ended)).toEqual([ToolResult, TaskEnd])
})

test('a task launched in the background ends at its task notification, not at the launch result', () => {
  const conversation = createConversation(emptyConversation('s1'))
  conversation.add(typed('Find the pane'))
  conversation.add(said({ type: 'tool_use', id: 'toolu_9', name: 'Agent', input: { prompt: 'find the pane' } }))
  conversation.startTask({ id: 'agent-3', title: 'find the pane', agentType: 'explorer', openedBy: 'toolu_9', openedAt: '2026-10-13T10:01:00.000Z' })

  const launched = conversation.add(answered('toolu_9', 'Async agent launched successfully.'))
  const notified = conversation.add(line({ type: 'user', isMeta: true, message: { role: 'user', content: '<task-notification><tool-use-id>toolu_9</tool-use-id><summary>Found the pane.</summary></task-notification>' } }))

  expect(kinds(launched)).toEqual([ToolResult])
  expect(kinds(notified)).toEqual([Note, TaskEnd])
  expect(notified[0]?.type === Message && notified[0].message).toMatchObject({ text: 'Found the pane.', from: { type: 'task' } })
})

test('a conversation restarted from its saved state keeps its open turn, goal, and tasks', () => {
  const first = createConversation(emptyConversation('s1'))
  first.add(typed('Find the pane'))
  first.add(said({ type: 'tool_use', id: 'toolu_9', name: 'Agent', input: { prompt: 'find the pane' } }))
  first.startTask({ id: 'agent-3', title: 'find the pane', agentType: 'explorer', openedBy: 'toolu_9', openedAt: '2026-10-13T10:01:00.000Z' })

  const restarted = createConversation(first.state)
  const ended = restarted.add(answered('toolu_9', 'found it'))

  expect(restarted.state.goal).toBe('Find the pane')
  expect(kinds(ended)).toEqual([ToolResult, TaskEnd])
  expect(ended[0]?.type === Message && ended[0].message.turn).toBe(first.state.turn?.prompt.id)
})
