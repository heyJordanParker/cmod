import type { Args, EventResult, Frozen } from 'claude-code'
import type { Disposable } from '../mod.js'
import type { RoutedEvent } from './hooks.js'

export type RouterNext<N extends RoutedEvent> = (e: Frozen<Args<N>>) => Promise<EventResult<N>>

export type RoutedHook<N extends RoutedEvent> = (e: Frozen<Args<N>>, next: RouterNext<N>) => EventResult<N> | Promise<EventResult<N>>

export type RoutedFailure<N extends RoutedEvent> = (e: Frozen<Args<N>>, error: Error, next: RouterNext<N>) => EventResult<N> | undefined | Promise<EventResult<N> | undefined>

export type Router = {
  add<N extends RoutedEvent>(event: N, hook: RoutedHook<N>, failed?: RoutedFailure<N>): Disposable
  dispatch<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, next: RouterNext<N>): Promise<EventResult<N>>
  dispatchFailure<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, error: Error, next: RouterNext<N>): Promise<EventResult<N>>
}

type Route = { readonly hook: (e: unknown, next: (e: unknown) => Promise<unknown>) => unknown; readonly failed?: (e: unknown, error: Error, next: (e: unknown) => Promise<unknown>) => unknown }

export function createRouter(): Router {
  const routes = new Map<RoutedEvent, Route[]>()

  return {
    add(event, hook, failed) {
      const route = { hook, ...(failed === undefined ? {} : { failed }) } as Route
      routes.set(event, [...(routes.get(event) ?? []), route])
      return {
        dispose() {
          const chain = (routes.get(event) ?? []).filter((each) => each !== route)
          if (chain.length === 0) routes.delete(event)
          else routes.set(event, chain)
        },
      }
    },
    dispatch<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, next: RouterNext<N>): Promise<EventResult<N>> {
      const chain = routes.get(event)
      const call = async (index: number, current: unknown): Promise<unknown> => {
        const route = chain?.[index]
        if (route === undefined) return next(current as Frozen<Args<N>>)
        return route.hook(current, (passed) => call(index + 1, passed))
      }
      return call(0, e) as Promise<EventResult<N>>
    },
    async dispatchFailure<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, error: Error, next: RouterNext<N>): Promise<EventResult<N>> {
      for (const route of routes.get(event) ?? []) {
        const answer = await route.failed?.(e, error, next as (e: unknown) => Promise<unknown>)
        if (answer !== undefined) return answer as EventResult<N>
      }
      return next(e)
    },
  }
}
