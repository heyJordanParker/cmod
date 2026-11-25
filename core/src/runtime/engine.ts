import type { HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import type { Claude } from './claude.js'
import type { Providers, StorePart } from './interfaces.js'
import type { Parts } from './parts.js'
import type { Router } from './router.js'
import type { Failure } from './toaster.js'
import type { ToolCalls } from './tool-calls.js'
import type { Watches } from './watches.js'
import type { Widgets } from './widgets.js'

export type Engine = {
  readonly claude: Claude
  readonly router: Router
  readonly toolCalls: ToolCalls
  readonly report: (failure: Failure) => void
  readonly hasPermissionCheck: () => boolean
  readonly answerInput: <Answer>(run: () => Promise<Answer>, passOn: () => Promise<unknown>) => Promise<Answer>
  readonly spawnCmod: (args: readonly string[], env?: Readonly<Record<string, string>>) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  readonly isInstalledCopy: () => Promise<boolean>
  readonly watches: Watches
  readonly interfaces: Providers
  readonly widgets?: Widgets
  readonly parts?: Parts
  readonly onServeUnreached: (listener: () => void) => void
  readonly onStoreChange: (listener: (part: StorePart | undefined) => void) => void
  readonly storeChanged: (part: StorePart) => void
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
