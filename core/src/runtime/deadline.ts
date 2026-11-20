import type { HookBudget } from 'claude-code'
import type { Claude } from './claude.js'

export type Deadline = { readonly ms: number; readonly job?: string }

export const longestMs = 600_000

export const toolDeadline: Deadline = { ms: 30000, job: 'tool' }

export const callDeadline: Deadline = { ms: 30_000 }

export type ListenOptions = { readonly timeoutMs?: number; readonly onFailure?: 'pass' | 'refuse' }

export type ListenTime = { readonly deadline: number; readonly signal: AbortSignal }

export const listenerMs = 10_000

export const hookMs = 10_000 satisfies HookBudget['ms']

export class PassedTimeout extends Error {}

const timers = globalThis as unknown as { setTimeout(run: () => void, ms: number): unknown; clearTimeout(timer: unknown): void }

export function listenerOf<Listener = (payload: never, time: ListenTime) => unknown>(name: string, method: string, args: readonly unknown[]): { readonly matcher: unknown; readonly listener: Listener; readonly options: ListenOptions } {
  const hasMatcher = typeof args[1] === 'function'
  const listener = (hasMatcher ? args[1] : args[0]) as Listener
  const options = ((hasMatcher ? args[2] : args[1]) ?? {}) as ListenOptions
  if (typeof listener !== 'function') throw new Error(`${name}: ${method} takes a listener, or a matcher and then a listener.`)
  const { timeoutMs, onFailure } = options as { readonly timeoutMs?: unknown; readonly onFailure?: unknown }
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > longestMs)) throw new Error(`${name}: ${method}'s timeoutMs is ${String(timeoutMs)}. Give a whole number of milliseconds above 0 and at most ${longestMs}.`)
  if (onFailure !== undefined && onFailure !== 'pass' && onFailure !== 'refuse') throw new Error(`${name}: ${method}'s onFailure is ${String(onFailure)}. Give 'pass' or 'refuse'.`)
  return { matcher: hasMatcher ? args[0] : undefined, listener, options }
}

export async function withinTime<Value>(clock: Pick<Claude['clock'], 'now'>, method: string, { timeoutMs = listenerMs }: ListenOptions, cancel: AbortSignal, run: (time: ListenTime) => Value | Promise<Value>): Promise<Value> {
  const controller = new AbortController()
  const deadline = (await clock.now()) + timeoutMs
  cancel.throwIfAborted()
  let timer: unknown
  let cancelled: () => void = () => undefined
  const passed = new Promise<never>((_resolve, reject) => {
    timer = timers.setTimeout(() => {
      controller.abort()
      reject(new PassedTimeout(`${method} passed its ${timeoutMs / 1000} s timeout`))
    }, timeoutMs)
    cancelled = () => reject(cancel.reason)
    cancel.addEventListener('abort', cancelled, { once: true })
  })
  try {
    return await Promise.race([Promise.resolve().then(() => run({ deadline, signal: AbortSignal.any([controller.signal, cancel]) })), passed])
  } finally {
    timers.clearTimeout(timer)
    cancel.removeEventListener('abort', cancelled)
  }
}

export const abortGraceMs = 1000

export function settledAfterAbort<Value>(work: Promise<Value>, signal: AbortSignal | undefined): Promise<Value> {
  if (signal === undefined) return work
  return new Promise<Value>((resolve, reject) => {
    let timer: unknown
    const giveUp = () => void (timer = timers.setTimeout(() => reject(signal.reason), abortGraceMs))
    if (signal.aborted) giveUp()
    else signal.addEventListener('abort', giveUp, { once: true })
    work.then(resolve, reject).finally(() => {
      timers.clearTimeout(timer)
      signal.removeEventListener('abort', giveUp)
    })
  })
}

export function beforeDeadline<Value>(clock: Pick<Claude['clock'], 'after'>, { ms, job }: Deadline, call: string, run: (signal: AbortSignal) => Promise<Value>): Promise<Value> {
  const passed = new AbortController()
  return new Promise<Value>((resolve, reject) => {
    const deadline = job === undefined ? `its ${ms / 1000} s deadline` : `the ${ms / 1000} s deadline of ${job}`
    const timer = clock.after(ms, () => {
      const error = new Error(`${call} passed ${deadline}`)
      reject(error)
      passed.abort(error)
    })
    run(passed.signal).then(
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
