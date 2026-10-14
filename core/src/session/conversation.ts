import { ContextEnd, ContextStart, type Context } from './context/context.js'
import { Message, messagesOf, tagOf, textOf, type Row } from './context/turn/message/message.js'
import { Note } from './context/turn/message/note.js'
import { Prompt } from './context/turn/message/prompt.js'
import { ToolCall } from './context/turn/message/tool-call.js'
import { ToolResult } from './context/turn/message/tool-result.js'
import { TurnEnd, TurnStart, type Turn } from './context/turn/turn.js'
import { GoalChange, type Goal } from './goal/goal.js'
import { Task, TaskEnd, TaskStart } from './goal/task.js'
import type { UsageChange, Usage } from './session.js'

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
  readonly agentType?: string
}

export type ContextData = Pick<Context, 'number' | 'openedAt' | 'closedAt' | 'task'>

export type TurnData = Pick<Turn, 'prompt' | 'context' | 'openedAt' | 'closedAt'>

export type TaskData = Pick<Task, 'id' | 'title' | 'openedBy' | 'openedAt' | 'closedAt'> & { readonly agentType: string; readonly model?: string; readonly parent?: string }

export type RunningTask = TaskData & { readonly context: number; readonly contextOpenedAt?: string }

export type GoalData = Pick<Goal, 'text'> & { readonly task?: string }

export type SessionChange =
  | { readonly type: typeof Message; readonly message: Message }
  | { readonly type: typeof TurnStart | typeof TurnEnd; readonly turn: TurnData }
  | { readonly type: typeof ContextStart | typeof ContextEnd; readonly context: ContextData }
  | { readonly type: typeof TaskStart | typeof TaskEnd; readonly task: RunningTask }
  | { readonly type: typeof GoalChange; readonly goal: GoalData }
  | { readonly type: typeof UsageChange; readonly usage: Usage }

export type ConversationState = {
  readonly session: string
  readonly context: number
  readonly contextOpenedAt: string
  readonly turn?: TurnData
  readonly goal?: string
  readonly agentCalls: readonly string[]
  readonly endedCalls: Readonly<Record<string, string>>
  readonly tasks: Readonly<Record<string, RunningTask>>
  readonly taskTurns: Readonly<Record<string, TurnData>>
}

export type Conversation = {
  add(row: Row, task?: string): SessionChange[]
  startTask(task: TaskData): SessionChange[]
  startContext(at: string): SessionChange[]
  changeGoal(text: string): SessionChange[]
  readonly state: ConversationState
}

export const searchLimit = 50

const agentTools: readonly string[] = ['Agent', 'Task']

const asyncLaunch = 'Async agent launched'

export function emptyConversation(session: string): ConversationState {
  return { session, context: 0, contextOpenedAt: '', agentCalls: [], endedCalls: {}, tasks: {}, taskTurns: {} }
}

export function createConversation(start: ConversationState): Conversation {
  let { context, contextOpenedAt, turn, goal } = start
  const agentCalls = new Set(start.agentCalls)
  const endedCalls = new Map(Object.entries(start.endedCalls))
  const tasks = new Map(Object.entries(start.tasks))
  const taskTurns = new Map(Object.entries(start.taskTurns))

  const endTaskTurn = (task: string, at: string): SessionChange[] => {
    const open = taskTurns.get(task)
    if (open === undefined) return []
    taskTurns.delete(task)
    return open.closedAt === undefined ? [{ type: TurnEnd, turn: { ...open, closedAt: at } }] : []
  }

  const startContext = (at: string): SessionChange[] => {
    context += 1
    contextOpenedAt = at
    return [{ type: ContextStart, context: { number: context, openedAt: at } }]
  }

  const endContext = (at: string): SessionChange[] => (context === 0 ? [] : [{ type: ContextEnd, context: { number: context, openedAt: contextOpenedAt, closedAt: at } }])

  const compactTask = (task: string, at: string): SessionChange[] => {
    const owner = tasks.get(task)
    if (owner === undefined) return []
    const next = { ...owner, context: owner.context + 1, contextOpenedAt: at }
    tasks.set(task, next)
    return [
      { type: ContextEnd, context: { number: owner.context, openedAt: owner.contextOpenedAt ?? owner.openedAt, closedAt: at, task } },
      { type: ContextStart, context: { number: next.context, openedAt: at, task } },
    ]
  }

  const endTurn = (at: string): SessionChange[] => {
    if (turn === undefined) return []
    const ended = { ...turn, closedAt: at }
    turn = undefined
    return [{ type: TurnEnd, turn: ended }]
  }

  const endTask = (call: string, at: string, only?: string): SessionChange[] => {
    const opened = [...tasks.values()].filter((each) => each.openedBy === call && (only === undefined || each.id === only))
    if (opened.length === 0) {
      if (agentCalls.has(call)) endedCalls.set(call, at)
      return []
    }
    if (only === undefined) agentCalls.delete(call)
    return opened.flatMap((task) => {
      if (task.closedAt !== undefined) return []
      const ended = { ...task, closedAt: at }
      tasks.set(task.id, ended)
      return [...endTaskTurn(task.id, at), { type: TaskEnd, task: ended }]
    })
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
      if (row.type === 'system' && row.name === 'compact_boundary') return [...changes, ...(task === undefined ? [...endContext(row.at), ...startContext(row.at)] : compactTask(task, row.at))]
      const owner = task === undefined ? undefined : tasks.get(task)
      const placedIn = owner?.context ?? context
      for (const unplaced of messagesOf(row, task !== undefined)) {
        if (unplaced.type === Prompt) {
          changes.push(...(task === undefined ? endTurn(row.at) : endTaskTurn(task, row.at)))
          const opened: TurnData = { prompt: { ...unplaced, session: start.session, context: placedIn, turn: unplaced.id, ...(task === undefined ? {} : { task }) }, context: placedIn, openedAt: row.at, ...(owner?.closedAt === undefined ? {} : { closedAt: owner.closedAt }) }
          if (task === undefined) turn = opened
          else taskTurns.set(task, opened)
          changes.push({ type: TurnStart, turn: opened })
          if (task === undefined && goal === undefined) changes.push(...changeGoal(unplaced.text))
        }
        const open = task === undefined ? turn : taskTurns.get(task)
        const placed = {
          ...unplaced,
          session: start.session,
          context: placedIn,
          ...(open === undefined ? {} : { turn: open.prompt.id }),
          ...(task === undefined ? {} : { task }),
        } as Message
        changes.push({ type: Message, message: placed })
        if (placed.type === ToolCall && agentTools.includes(placed.name)) agentCalls.add(placed.callId)
        if (placed.type === ToolResult && agentCalls.has(placed.callId) && !placed.text.startsWith(asyncLaunch)) changes.push(...endTask(placed.callId, row.at))
        if (placed.type === Note && placed.from.type === Task) {
          const call = tagOf(textOf(row.content), 'tool-use-id')
          if (call !== undefined && agentCalls.has(call)) changes.push(...endTask(call, row.at, tagOf(textOf(row.content), 'task-id')))
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
      if (endedAt !== undefined) changes.push(...endTask(data.openedBy, endedAt, data.id))
      return changes
    },
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
        taskTurns: Object.fromEntries(taskTurns),
      }
    },
  }
}
