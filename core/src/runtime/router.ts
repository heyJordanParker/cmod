import type { Args, EventResult, Frozen } from 'claude-code'
import type { Disposable } from '../mod.js'
import type { RoutedEvent } from './hooks.js'

export type RouterNext<N extends RoutedEvent> = (e: Frozen<Args<N>>) => Promise<EventResult<N>>

export type RoutedHook<N extends RoutedEvent> = (e: Frozen<Args<N>>, next: RouterNext<N>) => EventResult<N> | Promise<EventResult<N>>

export type Router = {
  add<N extends RoutedEvent>(event: N, hook: RoutedHook<N>): Disposable
  has(event: RoutedEvent): boolean
  dispatch<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, next: RouterNext<N>): Promise<EventResult<N>>
}

type ErasedHook = (e: unknown, next: (e: unknown) => Promise<unknown>) => unknown

export function createRouter(): Router {
  const hooks = new Map<RoutedEvent, ErasedHook[]>()

  return {
    add(event, hook) {
      const erased = hook as unknown as ErasedHook
      hooks.set(event, [...(hooks.get(event) ?? []), erased])
      return {
        dispose() {
          const chain = (hooks.get(event) ?? []).filter((each) => each !== erased)
          if (chain.length === 0) hooks.delete(event)
          else hooks.set(event, chain)
        },
      }
    },
    has: (event) => hooks.has(event),
    dispatch<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, next: RouterNext<N>): Promise<EventResult<N>> {
      const chain = hooks.get(event)
      const call = async (index: number, current: unknown): Promise<unknown> => {
        const hook = chain?.[index]
        if (hook === undefined) return next(current as Frozen<Args<N>>)
        return hook(current, (passed) => call(index + 1, passed))
      }
      return call(0, e) as Promise<EventResult<N>>
    },
  }
}
