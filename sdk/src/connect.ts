import type { On } from 'claude-code'
import type { ModDefinition } from './mod.js'
import { keepClaudeCalls } from './runtime/claude.js'
import { registerHooks } from './runtime/hooks.js'
import { createLifecycle, readPlugin } from './runtime/lifecycle.js'

export function connect<State extends object>(on: On, definition: ModDefinition<State>): void {
  const lifecycle = createLifecycle(definition)
  keepClaudeCalls(on)
  registerHooks(on, {
    start: (claude) => lifecycle.start(claude, readPlugin),
    route: (event, e, next) => lifecycle.route(event, e, next),
  })
}
