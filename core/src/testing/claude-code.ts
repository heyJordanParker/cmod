import type { Args, ClassicHookInputs, EventResult } from 'claude-code'
import type { Hook, RoutedEvent } from '../runtime/hooks.js'

type FilledField = 'session_id' | 'transcript_path' | 'cwd' | 'hook_event_name' | 'tool_use_id'

export type HookInputOf<H extends Hook | 'PreToolUse'> = Omit<ClassicHookInputs[H], FilledField> & Partial<Pick<ClassicHookInputs[H], FilledField & keyof ClassicHookInputs[H]>>

export type ClaudeCode = {
  fire<H extends Hook | 'PreToolUse'>(hook: H, input: HookInputOf<H>, below?: EventResult<`classic.${H}`>): Promise<EventResult<`classic.${H}`>>
  fire<N extends RoutedEvent>(event: N, input: Args<N>, below?: EventResult<N>): Promise<EventResult<N>>
}

const drivers = new WeakMap<object, ClaudeCode>()

export function keepClaudeCode(tested: object, driver: ClaudeCode): void {
  drivers.set(tested, driver)
}

export function claudeCodeOf(tested: object): ClaudeCode {
  const driver = drivers.get(tested)
  if (driver === undefined) throw new Error('claudeCodeOf takes a mod testMod returned.')
  return driver
}
