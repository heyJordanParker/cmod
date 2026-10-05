import type { Workspace } from '../permissions/find-project-scope.js'
import { matchTarget, targetOf, type Target } from '../permissions/match-target.js'
import { callEffects, type ToolUse } from '../../utils/call-effects.js'
import { parentOf } from '../../utils/paths.js'

export type CheckRun = { command: string[]; folder: string }

export async function triggeredRun(after: readonly Target[], run: readonly string[], use: ToolUse, workspace: Workspace): Promise<CheckRun | undefined> {
  const effects = callEffects(use, workspace)
  const paths = new Set<string>()
  let commandFolder: string | undefined
  for (const target of after) {
    const matched = await matchTarget(target, use, effects, workspace)
    const { key } = targetOf(target)
    if (key !== 'read' && key !== 'write') commandFolder ??= matched[0]?.folder
    else for (const { call } of matched) if ('path' in call) paths.add(call.path)
  }
  const existing: string[] = []
  for (const path of paths) if (await workspace.fs.exists(path)) existing.push(path)
  const last = existing.at(-1)
  if (last !== undefined) return { command: [...run, ...existing], folder: parentOf(last) }
  return commandFolder === undefined ? undefined : { command: [...run], folder: commandFolder }
}
