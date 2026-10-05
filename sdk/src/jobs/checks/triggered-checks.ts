import type { Workspace } from '../permissions/find-project-scope.js'
import { matchTarget, targetOf, type TargetCalls, type TargetKey, type TargetOf } from '../permissions/match-target.js'
import { callEffects, type ToolCall, type ToolUse } from '../../utils/call-effects.js'
import { parentOf } from '../../utils/paths.js'

type Output = string | undefined | Promise<string | undefined>
export type Check<Mod> = {
  [Key in TargetKey]: TargetOf<Key> & {
    run: string[] | ((call: TargetCalls[Key], mod: Mod) => Output)
    timeoutMs?: number
  }
}[TargetKey]
export type CheckRun<Mod> = { check: Check<Mod>; command: string[]; folder: string } | { check: Check<Mod>; callback: (call: ToolCall, mod: Mod) => Output; call: ToolCall; folder: string }
type CallbackOf<Mod> = { callback(call: ToolCall, mod: Mod): Output }

export async function triggeredChecks<Mod>(checks: Check<Mod>[], use: ToolUse, workspace: Workspace): Promise<CheckRun<Mod>[]> {
  const effects = callEffects(use, workspace)
  const runs: CheckRun<Mod>[] = []
  for (const check of checks) {
    const matched = await matchTarget(check, use, effects, workspace)
    const [first] = matched
    if (first === undefined) continue
    const { run } = check
    if (typeof run === 'function') {
      const { callback }: CallbackOf<Mod> = { callback: run }
      for (const { call, folder } of matched) runs.push({ check, callback, call, folder })
      continue
    }
    const { key } = targetOf(check)
    if (key !== 'read' && key !== 'write') {
      runs.push({ check, command: run, folder: first.folder })
      continue
    }
    const paths = [...new Set(matched.flatMap(({ call }) => ('path' in call ? [call.path] : [])))]
    const existing: string[] = []
    for (const path of paths) if (await workspace.fs.exists(path)) existing.push(path)
    const last = existing.at(-1)
    if (last !== undefined) runs.push({ check, command: [...run, ...existing], folder: parentOf(last) })
  }
  return runs
}
