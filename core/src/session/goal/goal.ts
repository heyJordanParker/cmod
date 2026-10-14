import type { RecordPart } from '../session.js'
import type { Task } from './task.js'

export const GoalChange = 'goalChange'

export type Goal = RecordPart & {
  readonly text: string
  tasks(): Promise<Task[]>
  update(change: { readonly text: string }): Promise<void>
}
