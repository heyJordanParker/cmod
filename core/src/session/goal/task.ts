import type { Message } from '../context/turn/message/message.js'

export const Task = 'task'

export const TaskStart = 'taskStart'

export const TaskEnd = 'taskEnd'

export type Task = {
  readonly id: string
  readonly title: string
  readonly agentType: string
  readonly model?: string
  readonly openedBy: string
  readonly openedAt: string
  readonly closedAt?: string
  messages(): Promise<Message[]>
  tasks(): Promise<Task[]>
}
