import type { Task } from './task.js'

export const GoalChange = 'goalChange'

export type Goal = {
  readonly text: string
  update(change: { readonly text: string }): Promise<void>
  tasks(): Promise<Task[]>
}
