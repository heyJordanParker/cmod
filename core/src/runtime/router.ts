import type { Args, EventResult, Frozen } from 'claude-code'
import type { Subscription } from '../utils/subscription.js'
import type { RoutedEvent } from './hooks.js'

export type RouterNext<N extends RoutedEvent> = (e: Frozen<Args<N>>) => Promise<EventResult<N>>

export type RoutedNext<N extends RoutedEvent> = RouterNext<N> & { readonly signal: AbortSignal }

export type RoutedHook<N extends RoutedEvent> = (e: Frozen<Args<N>>, next: RoutedNext<N>) => EventResult<N> | Promise<EventResult<N>>

export type RoutedFailure<N extends RoutedEvent> = (e: Frozen<Args<N>>, error: Error, next: RoutedNext<N>) => EventResult<N> | undefined | Promise<EventResult<N> | undefined>

export type Router = {
  add<N extends RoutedEvent>(event: N, hook: RoutedHook<N>, failed?: RoutedFailure<N>): Subscription
  dispatch<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, next: RouterNext<N>, signal?: AbortSignal): Promise<EventResult<N>>
  dispatchFailure<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, error: Error, next: RouterNext<N>): Promise<EventResult<N>>
}

type Next = ((e: unknown) => Promise<unknown>) & { readonly signal: AbortSignal }

type Route = { readonly hook: (e: unknown, next: Next) => unknown; readonly failed?: (e: unknown, error: Error, next: Next) => unknown }

export const unaborted = new AbortController().signal

export function createRouter(): Router {
  const routes = new Map<RoutedEvent, Route[]>()

  return {
    add(event, hook, failed) {
      const route = { hook, ...(failed === undefined ? {} : { failed }) } as Route
      routes.set(event, [...(routes.get(event) ?? []), route])
      return {
        remove() {
          const chain = (routes.get(event) ?? []).filter((each) => each !== route)
          if (chain.length === 0) routes.delete(event)
          else routes.set(event, chain)
        },
      }
    },
    dispatch<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, next: RouterNext<N>, signal = unaborted): Promise<EventResult<N>> {
      const chain = routes.get(event)
      const call = async (index: number, current: unknown): Promise<unknown> => {
        const route = chain?.[index]
        if (route === undefined) return next(current as Frozen<Args<N>>)
        return route.hook(current, Object.assign((passed: unknown) => call(index + 1, passed), { signal }))
      }
      return call(0, e) as Promise<EventResult<N>>
    },
    async dispatchFailure<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, error: Error, next: RouterNext<N>): Promise<EventResult<N>> {
      const signalled = Object.assign((passed: unknown) => next(passed as Frozen<Args<N>>), { signal: unaborted })
      for (const route of routes.get(event) ?? []) {
        const answer = await route.failed?.(e, error, signalled)
        if (answer !== undefined) return answer as EventResult<N>
      }
      return next(e)
    },
  }
}
