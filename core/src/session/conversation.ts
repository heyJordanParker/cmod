import { ContextEnd, ContextStart, type Context } from './context/context.js'
import { Message, messagesOf, tagOf, textOf, type Row } from './context/turn/message/message.js'
import { Note } from './context/turn/message/note.js'
import { Prompt } from './context/turn/message/prompt.js'
import { ToolCall } from './context/turn/message/tool-call.js'
import { ToolResult } from './context/turn/message/tool-result.js'
import { TurnEnd, TurnStart, type Turn } from './context/turn/turn.js'
import { GoalChange, type Goal } from './goal/goal.js'
import { Task, TaskEnd, TaskStart } from './goal/task.js'

export type SessionData = {
  readonly id: string
  readonly title: string
  readonly project: string
  readonly cwd: string
  readonly model: string
  readonly startedAt: string
  readonly lastAt: string
  readonly forkedFrom?: string
  readonly isRunning: boolean
}

export type ContextData = Omit<Context, 'turns'>

export type TurnData = Omit<Turn, 'messages'>

export type TaskData = Omit<Task, 'messages' | 'tasks'> & { readonly parent?: string }

export type GoalData = Omit<Goal, 'update' | 'tasks'>

export type SessionChange =
  | { readonly type: typeof Message; readonly message: Message }
  | { readonly type: typeof TurnStart | typeof TurnEnd; readonly turn: TurnData }
  | { readonly type: typeof ContextStart | typeof ContextEnd; readonly context: ContextData }
  | { readonly type: typeof TaskStart | typeof TaskEnd; readonly task: TaskData & { readonly context: number } }
  | { readonly type: typeof GoalChange; readonly goal: GoalData }

export type ConversationState = {
  readonly session: string
  readonly context: number
  readonly contextOpenedAt: string
  readonly turn?: TurnData
  readonly goal?: string
  readonly agentCalls: readonly string[]
  readonly endedCalls: Readonly<Record<string, string>>
  readonly tasks: Readonly<Record<string, TaskData & { readonly context: number }>>
}

export type Conversation = {
  add(row: Row, task?: string): SessionChange[]
  startTask(task: TaskData): SessionChange[]
  endContext(at: string): SessionChange[]
  startContext(at: string): SessionChange[]
  changeGoal(text: string): SessionChange[]
  readonly state: ConversationState
}

export const searchLimit = 50

const agentTools: readonly string[] = ['Agent', 'Task']

const asyncLaunch = 'Async agent launched'

export function emptyConversation(session: string): ConversationState {
  return { session, context: 0, contextOpenedAt: '', agentCalls: [], endedCalls: {}, tasks: {} }
}

export function createConversation(start: ConversationState): Conversation {
  let { context, contextOpenedAt, turn, goal } = start
  const agentCalls = new Set(start.agentCalls)
  const endedCalls = new Map(Object.entries(start.endedCalls))
  const tasks = new Map(Object.entries(start.tasks))

  const startContext = (at: string): SessionChange[] => {
    context += 1
    contextOpenedAt = at
    return [{ type: ContextStart, context: { number: context, openedAt: at } }]
  }

  const endContext = (at: string): SessionChange[] => (context === 0 ? [] : [{ type: ContextEnd, context: { number: context, openedAt: contextOpenedAt, closedAt: at } }])

  const endTurn = (at: string): SessionChange[] => {
    if (turn === undefined) return []
    const ended = { ...turn, closedAt: at }
    turn = undefined
    return [{ type: TurnEnd, turn: ended }]
  }

  const endTask = (call: string, at: string): SessionChange[] => {
    const task = [...tasks.values()].find((each) => each.openedBy === call)
    if (task === undefined) {
      if (agentCalls.has(call)) endedCalls.set(call, at)
      return []
    }
    if (task.closedAt !== undefined) return []
    const ended = { ...task, closedAt: at }
    tasks.set(task.id, ended)
    agentCalls.delete(call)
    return [{ type: TaskEnd, task: ended }]
  }

  const changeGoal = (text: string): SessionChange[] => {
    goal = text
    return [{ type: GoalChange, goal: { text } }]
  }

  return {
    add(row, task) {
      const changes: SessionChange[] = []
      if (task === undefined && context === 0) changes.push(...startContext(row.at))
      if (task === undefined && row.type === 'system' && row.name === 'turn_duration') return [...changes, ...endTurn(row.at)]
      if (task === undefined && row.type === 'system' && row.name === 'compact_boundary') return [...changes, ...endContext(row.at), ...startContext(row.at)]
      const owner = task === undefined ? undefined : tasks.get(task)
      for (const unplaced of messagesOf(row, task !== undefined)) {
        if (task === undefined && unplaced.type === Prompt) {
          changes.push(...endTurn(row.at))
          const opened: TurnData = { prompt: { ...unplaced, session: start.session, context, turn: unplaced.id }, context, openedAt: row.at }
          turn = opened
          changes.push({ type: TurnStart, turn: opened })
          if (goal === undefined) changes.push(...changeGoal(unplaced.text))
        }
        const placed = {
          ...unplaced,
          session: start.session,
          context: owner?.context ?? context,
          ...(task === undefined && turn !== undefined ? { turn: turn.prompt.id } : {}),
          ...(task === undefined ? {} : { task }),
        } as Message
        changes.push({ type: Message, message: placed })
        if (task !== undefined) continue
        if (placed.type === ToolCall && agentTools.includes(placed.name)) agentCalls.add(placed.callId)
        if (placed.type === ToolResult && agentCalls.has(placed.callId) && !placed.text.startsWith(asyncLaunch)) changes.push(...endTask(placed.callId, row.at))
        if (placed.type === Note && placed.from.type === Task) {
          const call = tagOf(textOf(row.content), 'tool-use-id')
          if (call !== undefined && agentCalls.has(call)) changes.push(...endTask(call, row.at))
        }
      }
      return changes
    },
    startTask(data) {
      if (tasks.has(data.id)) return []
      const started = { ...data, context }
      tasks.set(data.id, started)
      agentCalls.add(data.openedBy)
      const changes: SessionChange[] = [{ type: TaskStart, task: started }]
      const endedAt = endedCalls.get(data.openedBy)
      if (endedAt !== undefined) {
        endedCalls.delete(data.openedBy)
        changes.push(...endTask(data.openedBy, endedAt))
      }
      return changes
    },
    endContext,
    startContext,
    changeGoal,
    get state() {
      return {
        session: start.session,
        context,
        contextOpenedAt,
        ...(turn === undefined ? {} : { turn }),
        ...(goal === undefined ? {} : { goal }),
        agentCalls: [...agentCalls],
        endedCalls: Object.fromEntries(endedCalls),
        tasks: Object.fromEntries(tasks),
      }
    },
  }
}
