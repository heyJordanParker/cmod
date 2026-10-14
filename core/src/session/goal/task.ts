import type { Message } from '../context/turn/message/message.js'
import type { RecordPart, Session } from '../session.js'

export const Task = 'task'

export const TaskStart = 'taskStart'

export const TaskEnd = 'taskEnd'

export type Task = RecordPart & {
  readonly id: string
  readonly title: string
  readonly owner: Session
  readonly openedBy: string
  readonly openedAt: string
  readonly closedAt?: string
  tasks(): Promise<Task[]>
  messages(): Promise<Message[]>
}
