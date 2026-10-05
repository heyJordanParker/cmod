import type { Part } from '../mod.js'
import { longestMs, type Deadline } from '../runtime/deadline.js'
import { triggeredRun } from './check/triggered-checks.js'
import { targetOf, type Target } from './permissions/match-target.js'
import { listed, messageOf } from '../utils/text.js'
import { afterCall, modWithin, targetWords } from './part-context.js'

const defaultMs = 60_000

export function check<State extends object = Record<never, never>>(options: { readonly after: Target | Target[]; readonly run: readonly string[]; readonly timeoutMs?: number }): Part<void, State> {
  const { after, run, timeoutMs = defaultMs } = options
  const targets = Array.isArray(after) ? after : [after]
  if (targets.length === 0) throw new Error("check: give after a target, such as { write: '**/*.ts' }.")
  for (const target of targets) targetOf(target)
  const named = `check after ${listed(targets.map(targetWords))}`
  if (run.length === 0) throw new Error(`check: the ${named} has no command. Give run a command, such as ['bun', 'test'].`)
  if (!(timeoutMs > 0 && timeoutMs <= longestMs)) throw new Error(`check: the ${named} has timeoutMs ${timeoutMs}. Set it above 0 and at most ${longestMs} (${longestMs / 60_000} minutes).`)
  const deadline: Deadline = { ms: timeoutMs, job: 'check' }

  return (context) => {
    afterCall(
      context,
      async (use, workspace) => {
        const triggered = await triggeredRun(targets, run, use, workspace)
        if (triggered === undefined) return []
        try {
          const { command, folder } = triggered
          const { exitCode, stdout, stderr } = await modWithin(context, deadline, async () => workspace.scope?.workTreeOf(folder)).process.run(command)
          return exitCode === 0 ? [] : [`${command.join(' ')} exited with ${exitCode}:\n${`${stdout}${stderr}`.trim()}`]
        } catch (error) {
          return [`The ${named} failed: ${messageOf(error)}`]
        }
      },
      (error) => [`The check job failed, so the ${named} did not run: ${messageOf(error)}`],
    )
    context.announce(`a ${named}`)
  }
}
