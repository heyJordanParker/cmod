import type { Message } from '../context/turn/message/message.js'
import type { RecordPart, TaskOwner } from '../session.js'

export const Task = 'task'

export const TaskStart = 'taskStart'

export const TaskEnd = 'taskEnd'

export type TaskStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

export type Task = RecordPart & {
  readonly id: string
  readonly title: string
  readonly owner: TaskOwner
  readonly openedBy: string
  readonly openedAt: string
  readonly closedAt?: string
  readonly status?: TaskStatus
  readonly name?: string
  readonly spawnedBy?: string
  readonly isBackground?: true
  tasks(): Promise<Task[]>
  messages(): Promise<Message[]>
}
