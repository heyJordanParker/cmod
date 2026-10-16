import type { Claude } from './claude.js'

export type Deadline = { readonly ms: number; readonly job?: string }

export const longestMs = 600_000

export const toolDeadline: Deadline = { ms: 30000, job: 'tool' }

export type ListenOptions = { readonly timeoutMs?: number; readonly onFailure?: 'pass' | 'refuse' }

export type ListenTime = { readonly deadline: number; readonly signal: AbortSignal }

export const listenerMs = 10_000

export class PassedTimeout extends Error {}

const timers = globalThis as unknown as { setTimeout(run: () => void, ms: number): unknown; clearTimeout(timer: unknown): void }

export function listenerOf(name: string, method: string, args: readonly unknown[]): { readonly matcher: unknown; readonly listener: (payload: never, time: ListenTime) => unknown; readonly options: ListenOptions } {
  const hasMatcher = typeof args[1] === 'function'
  const listener = (hasMatcher ? args[1] : args[0]) as (payload: never, time: ListenTime) => unknown
  const options = ((hasMatcher ? args[2] : args[1]) ?? {}) as ListenOptions
  if (typeof listener !== 'function') throw new Error(`${name}: ${method} takes a listener, or a matcher and then a listener.`)
  const { timeoutMs, onFailure } = options as { readonly timeoutMs?: unknown; readonly onFailure?: unknown }
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > longestMs)) throw new Error(`${name}: ${method}'s timeoutMs is ${String(timeoutMs)}. Give a whole number of milliseconds above 0 and at most ${longestMs}.`)
  if (onFailure !== undefined && onFailure !== 'pass' && onFailure !== 'refuse') throw new Error(`${name}: ${method}'s onFailure is ${String(onFailure)}. Give 'pass' or 'refuse'.`)
  return { matcher: hasMatcher ? args[0] : undefined, listener, options }
}

export async function withinTime<Value>(clock: Pick<Claude['clock'], 'now'>, method: string, { timeoutMs = listenerMs }: ListenOptions, run: (time: ListenTime) => Value | Promise<Value>): Promise<Value> {
  const controller = new AbortController()
  const deadline = (await clock.now()) + timeoutMs
  let timer: unknown
  const passed = new Promise<never>((_resolve, reject) => {
    timer = timers.setTimeout(() => {
      controller.abort()
      reject(new PassedTimeout(`${method} passed its ${timeoutMs / 1000} s timeout`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve().then(() => run({ deadline, signal: controller.signal })), passed])
  } finally {
    timers.clearTimeout(timer)
  }
}

export function beforeDeadline<Value>(claude: Claude, { ms, job }: Deadline, call: string, task: Promise<Value>): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const passed = job === undefined ? `its ${ms / 1000} s deadline` : `the ${ms / 1000} s deadline of ${job}`
    const timer = claude.clock.after(ms, () => reject(new Error(`${call} passed ${passed}`)))
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
