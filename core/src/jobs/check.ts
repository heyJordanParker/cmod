import type { Job } from '../mod.js'
import { longestMs, type Deadline } from '../runtime/deadline.js'
import { callEffects, type ToolUse } from '../utils/call-effects.js'
import { parentOf } from '../utils/paths.js'
import { listed, messageOf } from '../utils/text.js'
import { afterCall, modOf, targetWords } from './context.js'
import type { Workspace } from './permissions/find-project-scope.js'
import { matchTarget, targetOf, type Target } from './permissions/match-target.js'

const defaultMs = 60_000

export function check<State extends object = Record<never, never>>(options: { readonly after: Target | Target[]; readonly run: readonly string[]; readonly timeoutMs?: number }): Job<void, State> {
  const { after, run, timeoutMs = defaultMs } = options
  const targets = Array.isArray(after) ? after : [after]
  if (targets.length === 0) throw new Error("check: give after a target, such as { write: '**/*.ts' }.")
  for (const target of targets) targetOf(target)
  const named = `check after ${listed(targets.map(targetWords))}`
  if (run.length === 0) throw new Error(`check: the ${named} has no command. Give run a command, such as ['bun', 'test'].`)
  if (!(timeoutMs > 0 && timeoutMs <= longestMs)) throw new Error(`check: the ${named} has timeoutMs ${timeoutMs}. Set it above 0 and at most ${longestMs} (${longestMs / 60_000} minutes).`)
  const deadline: Deadline = { ms: timeoutMs, job: 'check' }

  return (job) => {
    afterCall(
      job,
      async (use, workspace) => {
        const triggered = await triggeredRun(targets, run, use, workspace)
        if (triggered === undefined) return []
        try {
          const { command, folder } = triggered
          const { exitCode, stdout, stderr } = await modOf(job, { folder }, workspace, deadline).process.run(command)
          return exitCode === 0 ? [] : [`${command.join(' ')} exited with ${exitCode}:\n${`${stdout}${stderr}`.trim()}`]
        } catch (error) {
          return [`The ${named} failed: ${messageOf(error)}`]
        }
      },
      (error) => [`The check job failed, so the ${named} did not run: ${messageOf(error)}`],
    )
    job.announce(`a ${named}`)
  }
}

async function triggeredRun(after: readonly Target[], run: readonly string[], use: ToolUse, workspace: Workspace): Promise<{ command: string[]; folder: string } | undefined> {
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
