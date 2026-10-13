import type { Claude } from './claude.js'
import type { Router } from './router.js'
import type { ToolCalls } from './tool-calls.js'

export type Engine = {
  readonly claude: Claude
  readonly router: Router
  readonly toolCalls: ToolCalls
  readonly report: (failure: { readonly id: string; readonly message: string; readonly error?: unknown; readonly description?: string }) => void
}

const engines = new WeakMap<object, Engine>()

export function keepEngine(mod: object, engine: Engine): void {
  engines.set(mod, engine)
}

export function engineOf(mod: object): Engine {
  const engine = engines.get(mod)
  if (engine === undefined) throw new Error('This mod has not started, so it reaches no Claude Code calls yet.')
  return engine
}
