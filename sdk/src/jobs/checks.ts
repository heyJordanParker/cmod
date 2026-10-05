import type { Mod, Part } from '../mod.js'
import { triggeredChecks, type Check, type CheckRun } from './checks/triggered-checks.js'
import type { Workspace } from './permissions/find-project-scope.js'
import { targetOf } from './permissions/match-target.js'
import type { ToolUse } from '../utils/call-effects.js'
import { messageOf } from '../utils/text.js'
import { beforeDeadline, longestMs, modOf, targetWords, useOf, workspaceOf, type Deadline } from './tool-calls.js'

const defaultMs = 60_000

export function checks<State extends object = Record<never, never>>({ after }: { after: Check<Mod<State>>[] }): Part<void, State> {
  if (after.length === 0) throw new Error('checks: give it a check in after, or remove it from setup.')
  for (const check of after) {
    targetOf(check)
    const { timeoutMs } = check
    if (timeoutMs !== undefined && !(timeoutMs > 0 && timeoutMs <= longestMs)) {
      throw new Error(`checks: the check after ${targetWords(check)} has timeoutMs ${timeoutMs}. Set it above 0 and at most ${longestMs} (10 minutes).`)
    }
  }

  return (context) => {
    const { claude } = context

    const outputOf = async (run: CheckRun<Mod<State>>, workspace: Workspace): Promise<string | undefined> => {
      const deadline: Deadline = { ms: run.check.timeoutMs ?? defaultMs, job: 'checks' }
      try {
        if ('call' in run) return await run.callback(run.call, modOf(context, run.call, run.folder, workspace, deadline))
        const cwd = await workspace.scope?.workTreeOf(run.folder)
        const line = run.command.join(' ')
        const result = await beforeDeadline(claude, deadline, line, claude.process.run(run.command, { ...(cwd === undefined ? {} : { cwd }), timeoutMs: deadline.ms }))
        return result.exitCode === 0 ? undefined : `${line} exited with ${result.exitCode}:\n${`${result.stdout}${result.stderr}`.trim()}`
      } catch (error) {
        return `The check after ${targetWords(run.check)} failed: ${messageOf(error)}`
      }
    }

    const outputsAfter = async (before: Promise<[ToolUse, Workspace]>): Promise<string[]> => {
      try {
        const [use, workspace] = await before
        const runs = await triggeredChecks(after, use, workspace)
        const outputs = await Promise.all(runs.map((run) => outputOf(run, workspace)))
        return outputs.filter((output): output is string => output !== undefined && output !== '')
      } catch (error) {
        return [`The checks job failed, so no check ran: ${messageOf(error)}`]
      }
    }

    context.on('tool.call', async (e, next) => {
      const before = Promise.all([useOf(context, e), workspaceOf(context)])
      await Promise.allSettled([before])
      const result = await next(e)
      if (result.deny !== undefined || result.isError === true) return result
      const outputs = await outputsAfter(before)
      return outputs.length === 0 ? result : { ...result, context: [...(result.context ?? []), ...outputs] }
    })
    for (const check of after) context.adds(`a check after ${targetWords(check)}`)
  }
}
