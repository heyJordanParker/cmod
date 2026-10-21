import type { Claude } from './claude.js'
import type { Pages } from './pages.js'
import type { Router } from './router.js'
import type { Failure } from './toaster.js'
import type { ToolCalls } from './tool-calls.js'
import type { Widgets } from './widgets.js'

export type Engine = {
  readonly claude: Claude
  readonly router: Router
  readonly toolCalls: ToolCalls
  readonly report: (failure: Failure) => void
  readonly hasPermissionCheck: () => boolean
  readonly answerInput: <Answer>(run: () => Promise<Answer>, passOn: () => Promise<unknown>) => Promise<Answer>
  readonly widgets?: Widgets
  readonly pages?: Pages
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
