import type { Args, Frozen } from 'claude-code'
import type { Job, Mod } from '../mod.js'
import type { Deadline } from '../runtime/deadline.js'
import type { ToolUse } from '../utils/call-effects.js'
import { decidePermission, stricterVerdict, type PermissionRules as RulesFor, type Rule as RuleFor, type Verdict } from './permissions/decide-permission.js'
import { targetOf } from './permissions/match-target.js'
import { messageOf } from '../utils/text.js'
import { modOf, workspaceReader } from './context.js'

export type { CommandCall, FetchCall, FileCall, ToolCall } from '../utils/call-effects.js'
export type { Target } from './permissions/match-target.js'
export type Rule<State extends object = Record<never, never>> = RuleFor<Mod<State>>
export type PermissionRules<State extends object = Record<never, never>> = RulesFor<Mod<State>>

const deadline: Deadline = { ms: 2000, job: 'permissions' }

export function permissions<State extends object = Record<never, never>>(rules: PermissionRules<State>): Job<void, State> {
  const count = (rules.deny?.length ?? 0) + (rules.ask?.length ?? 0)
  if (count === 0) throw new Error('permissions: give it a deny or an ask rule, or remove it from setup.')
  for (const rule of [...(rules.deny ?? []), ...(rules.ask ?? [])]) targetOf(rule)

  return (job) => {
    const readWorkspace = workspaceReader(job)

    const verdictOf = async (e: Frozen<Args<'tool.check'>>): Promise<Verdict | undefined> => {
      try {
        const [agent, workspace] = await Promise.all([job.toolCalls.agentOf(e.tool_use_id), readWorkspace()])
        const use: ToolUse = { tool: e.tool, input: e.input, ...agent }
        return await decidePermission(rules, use, workspace, (call, folder) => modOf(job, { call, folder }, workspace, deadline))
      } catch (error) {
        return { decision: 'deny', reason: `The permissions job could not read the session, so it denies the call: ${messageOf(error)}` }
      }
    }

    job.on('tool.check', async (e, next) => {
      const [below, ours] = await Promise.all([next(e), verdictOf(e)])
      return ours === undefined ? below : stricterVerdict<Verdict>(below, ours)
    })
    job.announce(`${count} permission rule${count === 1 ? '' : 's'}`)
  }
}
