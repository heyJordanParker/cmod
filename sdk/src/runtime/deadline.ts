import type { Claude } from './claude.js'

export type Deadline = { readonly ms: number; readonly job: string; readonly longestMs?: number }

export const longestMs = 600_000

export const toolDeadline: Deadline = { ms: 30000, longestMs, job: 'tool' }

export function beforeDeadline<Value>(claude: Claude, { ms, job }: Deadline, call: string, task: Promise<Value>): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const timer = claude.clock.after(ms, () => reject(new Error(`${call} passed the ${ms / 1000} s deadline of ${job}`)))
    task.then(
      (value) => {
        timer.cancel()
        resolve(value)
      },
      (error: unknown) => {
        timer.cancel()
        reject(error)
      },
    )
  })
}
