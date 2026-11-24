import { ContextEnd, ContextStart, type Context } from './context/context.js'
import { deviceOf, type Device } from './context/turn/device.js'
import { Message, messagesOf, tagOf, textOf, type Row, type Unplaced } from './context/turn/message/message.js'
import { Note } from './context/turn/message/note.js'
import { Prompt } from './context/turn/message/prompt.js'
import { ToolCall } from './context/turn/message/tool-call.js'
import { ToolResult } from './context/turn/message/tool-result.js'
import { TurnEnd, TurnStart, type Turn } from './context/turn/turn.js'
import { GoalChange } from './goal/goal.js'
import { Task, TaskEnd, TaskStart, type TaskStatus } from './goal/task.js'
import type { Session, UsageChange, Usage } from './session.js'

export type SessionData = {
  readonly id: string
  readonly title: string
  readonly color?: string
  readonly project: string
  readonly cwd: string
  readonly transcriptPath?: string
  readonly model: string
  readonly startedAt: string
  readonly lastAt: string
  readonly forkedFrom?: string
  readonly isRunning: boolean
  readonly agentType?: string
  readonly visitedAt?: string
  readonly device?: Pick<Device, 'id' | 'name'> | undefined
  readonly status?: Session['status']
  readonly waitingFor?: Session['waitingFor']
  readonly contextPercent?: number
  readonly lastTurn?: Session['lastTurn']
}

export type ContextData = Pick<Context, 'number' | 'openedAt' | 'closedAt' | 'task'>

export type TurnData = Pick<Turn, 'prompt' | 'context' | 'openedAt' | 'closedAt' | 'answer' | 'reason' | 'failure' | 'device'>

export type TurnEnding = Pick<Turn, 'answer' | 'reason' | 'failure'>

export type TaskData = Pick<Task, 'id' | 'title' | 'openedBy' | 'openedAt' | 'closedAt' | 'status' | 'name' | 'spawnedBy' | 'isBackground'> & { readonly agentType?: string; readonly model?: string; readonly parent?: string; readonly forkedFrom?: string }

export const forkAgentType = 'fork'

export function ownerOfSpawn(agentType: string | undefined, session: string): Pick<TaskData, 'agentType' | 'forkedFrom'> {
  return agentType === forkAgentType ? { forkedFrom: session } : { agentType: agentType ?? 'general-purpose' }
}

type Agent = { readonly id: string; readonly status: TaskStatus; readonly name?: string; readonly spawnedBy?: string }

export function tasksWithAgents(tasks: readonly TaskData[], agents: readonly Agent[]): TaskData[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  return tasks.map((task) => {
    const agent = byId.get(task.id)
    return agent === undefined ? task : { ...task, status: agent.status, ...(agent.name === undefined ? {} : { name: agent.name }), ...(agent.spawnedBy === undefined ? {} : { spawnedBy: agent.spawnedBy }) }
  })
}

export type RunningTask = TaskData & { readonly context: number; readonly contextOpenedAt?: string; readonly device?: Device }

export type GoalData = { readonly text: string; readonly task?: string }

export type SessionChange =
  | { readonly type: typeof Message; readonly message: Message }
  | { readonly type: typeof TurnStart | typeof TurnEnd; readonly turn: TurnData }
  | { readonly type: typeof ContextStart | typeof ContextEnd; readonly context: ContextData }
  | { readonly type: typeof TaskStart | typeof TaskEnd; readonly task: RunningTask }
  | { readonly type: typeof GoalChange; readonly goal: GoalData }
  | { readonly type: typeof UsageChange; readonly usage: Usage }

export type ConversationState = {
  readonly session: string
  readonly agentType?: string
  readonly context: number
  readonly contextOpenedAt: string
  readonly turn?: TurnData
  readonly goal?: string
  readonly device?: Device
  readonly agentCalls: readonly string[]
  readonly endedCalls: Readonly<Record<string, string>>
  readonly tasks: Readonly<Record<string, RunningTask>>
  readonly taskTurns: Readonly<Record<string, TurnData>>
  readonly openCalls?: Readonly<Record<string, OpenCall>>
}

type OpenCall = Pick<ToolCall, 'name' | 'input' | 'cwd'>

export type Conversation = {
  add(row: Row, task?: string): SessionChange[]
  startTask(task: TaskData): SessionChange[]
  endTask(task: TaskData, at: string): SessionChange[]
  startContext(at: string): SessionChange[]
  endTurn(at: string, ending: TurnEnding, task?: string): SessionChange[]
  changeGoal(text: string): SessionChange[]
  changeAgentType(agentType: string): void
  readonly state: ConversationState
}

export type MessagePlace = Pick<ConversationState, 'session' | 'agentType' | 'context' | 'turn' | 'tasks' | 'taskTurns' | 'openCalls'>

export function placedMessage(where: MessagePlace, unplaced: Unplaced, task: string | undefined, isInTurn = true, agentType = task === undefined ? where.agentType : where.tasks[task]?.agentType): Message {
  const turn = isInTurn ? (task === undefined ? where.turn : where.taskTurns[task]) : undefined
  const context = task === undefined ? where.context : (where.tasks[task]?.context ?? where.context)
  const call = unplaced.type === ToolResult ? where.openCalls?.[unplaced.callId] : undefined
  return { ...unplaced, ...call, session: where.session, context, ...(turn === undefined ? {} : { turn: turn.prompt.id }), ...(task === undefined ? {} : { task }), ...(agentType === undefined ? {} : { agentType }) }
}

export const searchLimit = 50

const agentTools: readonly string[] = ['Agent', 'Task']

const asyncLaunch = 'Async agent launched'

const stopTool = 'TaskStop'

type EndedStatus = Extract<TaskStatus, 'completed' | 'failed' | 'killed'>

function endedStatusOf(told: string): EndedStatus | undefined {
  if (told === 'completed' || told === 'failed' || told === 'killed') return told
  return told === 'stopped' ? 'killed' : undefined
}

export function emptyConversation(session: string): ConversationState {
  return { session, context: 0, contextOpenedAt: '', agentCalls: [], endedCalls: {}, tasks: {}, taskTurns: {} }
}

export function createConversation(start: ConversationState): Conversation {
  let { agentType, context, contextOpenedAt, turn, goal, device } = start
  const agentCalls = new Set(start.agentCalls)
  const endedCalls = new Map(Object.entries(start.endedCalls))
  const tasks = new Map(Object.entries(start.tasks))
  const taskTurns = new Map(Object.entries(start.taskTurns))
  const openCalls = new Map(Object.entries(start.openCalls ?? {}))

  const endTaskTurn = (task: string, at: string, ending: TurnEnding = {}): SessionChange[] => {
    const open = taskTurns.get(task)
    if (open === undefined) return []
    taskTurns.delete(task)
    return open.closedAt === undefined ? [{ type: TurnEnd, turn: { ...open, ...ending, closedAt: at } }] : []
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

  const endTurn = (at: string, ending: TurnEnding = {}): SessionChange[] => {
    if (turn === undefined) return []
    const ended = { ...turn, ...ending, closedAt: at }
    turn = undefined
    return [{ type: TurnEnd, turn: ended }]
  }

  const close = (task: RunningTask, at: string, status: EndedStatus | undefined): SessionChange[] => {
    if (task.closedAt !== undefined) return []
    const ended = { ...task, closedAt: at, ...(status === undefined ? {} : { status }) }
    tasks.set(task.id, ended)
    return [...endTaskTurn(task.id, at), { type: TaskEnd, task: ended }]
  }

  const endCall = (call: string, at: string, only?: string, status?: EndedStatus): SessionChange[] => {
    const opened = [...tasks.values()].filter((each) => each.openedBy === call && (only === undefined || each.id === only))
    if (opened.length === 0) {
      if (agentCalls.has(call)) endedCalls.set(call, at)
      return []
    }
    if (only === undefined) agentCalls.delete(call)
    return opened.flatMap((task) => close(task, at, status))
  }

  const notified = (text: string, at: string): SessionChange[] => {
    const call = tagOf(text, 'tool-use-id')
    const id = tagOf(text, 'task-id')
    const told = tagOf(text, 'status')
    const status = told === undefined ? undefined : endedStatusOf(told)
    if (told !== undefined && status === undefined) return []
    const byCall = call !== undefined && agentCalls.has(call) ? endCall(call, at, id, status) : []
    if (byCall.length > 0 || id === undefined) return byCall
    const task = tasks.get(id)
    return task === undefined ? [] : close(task, at, status)
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
      const agent = task === undefined ? agentType : owner?.agentType
      const ofAgent = agent === undefined ? {} : { agentType: agent }
      for (const unplaced of messagesOf(row, task !== undefined)) {
        if (task === undefined && unplaced.type === Note) device = deviceOf(unplaced) ?? device
        if (unplaced.type === Prompt) {
          changes.push(...(task === undefined ? endTurn(row.at) : endTaskTurn(task, row.at)))
          const ranOn = task === undefined ? device : owner?.device
          const opened: TurnData = { prompt: { ...unplaced, session: start.session, context: placedIn, turn: unplaced.id, ...(task === undefined ? {} : { task }), ...ofAgent }, context: placedIn, openedAt: row.at, ...(owner?.closedAt === undefined ? {} : { closedAt: owner.closedAt }), ...(ranOn === undefined ? {} : { device: ranOn }) }
          if (task === undefined) turn = opened
          else taskTurns.set(task, opened)
          changes.push({ type: TurnStart, turn: opened })
          if (task === undefined && goal === undefined) changes.push(...changeGoal(unplaced.text))
        }
        const open = task === undefined ? turn : taskTurns.get(task)
        const call = unplaced.type === ToolResult ? openCalls.get(unplaced.callId) : undefined
        if (unplaced.type === ToolCall) openCalls.set(unplaced.callId, { name: unplaced.name, input: unplaced.input, cwd: unplaced.cwd })
        if (unplaced.type === ToolResult) openCalls.delete(unplaced.callId)
        const placed = {
          ...unplaced,
          ...call,
          session: start.session,
          context: placedIn,
          ...(open === undefined ? {} : { turn: open.prompt.id }),
          ...(task === undefined ? {} : { task }),
          ...ofAgent,
        } as Message
        changes.push({ type: Message, message: placed })
        if (placed.type === ToolCall && agentTools.includes(placed.name)) agentCalls.add(placed.callId)
        if (placed.type === ToolResult && agentCalls.has(placed.callId) && !String(placed.output).startsWith(asyncLaunch)) changes.push(...endCall(placed.callId, row.at, undefined, placed.isError ? 'failed' : 'completed'))
        if (placed.type === ToolResult && placed.name === stopTool && !placed.isError && typeof placed.input['task_id'] === 'string') {
          const stopped = tasks.get(placed.input['task_id'])
          if (stopped !== undefined) changes.push(...close(stopped, row.at, 'killed'))
        }
        if (placed.type === Note && placed.from.type === Task) changes.push(...notified(textOf(row.content), row.at))
      }
      return changes
    },
    startTask(data) {
      if (tasks.has(data.id)) return []
      const started = { ...data, context, ...(device === undefined ? {} : { device }) }
      tasks.set(data.id, started)
      agentCalls.add(data.openedBy)
      const changes: SessionChange[] = [{ type: TaskStart, task: started }]
      const endedAt = endedCalls.get(data.openedBy)
      if (endedAt !== undefined) changes.push(...endCall(data.openedBy, endedAt, data.id))
      return changes
    },
    endTask(data, at) {
      const open = tasks.get(data.id) ?? { ...data, context }
      if (open.closedAt !== undefined) return []
      const ended = { ...open, closedAt: at }
      tasks.set(data.id, ended)
      return [...endTaskTurn(data.id, at), { type: TaskEnd, task: ended }]
    },
    startContext,
    endTurn: (at, ending, task) => (task === undefined ? endTurn(at, ending) : endTaskTurn(task, at, ending)),
    changeGoal,
    changeAgentType(next) {
      agentType = next
    },
    get state() {
      return {
        session: start.session,
        ...(agentType === undefined ? {} : { agentType }),
        context,
        contextOpenedAt,
        ...(turn === undefined ? {} : { turn }),
        ...(goal === undefined ? {} : { goal }),
        ...(device === undefined ? {} : { device }),
        agentCalls: [...agentCalls],
        endedCalls: Object.fromEntries(endedCalls),
        tasks: Object.fromEntries(tasks),
        taskTurns: Object.fromEntries(taskTurns),
        openCalls: Object.fromEntries(openCalls),
      }
    },
  }
}
