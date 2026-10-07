import type { Args, Frozen } from 'claude-code'
import type { Job, Mod } from '../mod.js'
import type { Deadline } from '../runtime/deadline.js'
import { inputOf } from '../utils/call-effects.js'
import { decidePermission, stricterVerdict, type PermissionRules as RulesFor, type Rule as RuleFor, type Verdict } from './permissions/decide-permission.js'
import { targetOf } from './permissions/match-target.js'
import { messageOf } from '../utils/text.js'
import { modOf, workspaceReader } from './context.js'

export type { CommandCall, FetchCall, FileCall, ToolCall } from '../utils/call-effects.js'
export type { Target } from './permissions/match-target.js'
export type Rule<State extends object = Record<never, never>> = RuleFor<Mod<State>>
export type PermissionRules<State extends object = Record<never, never>> = RulesFor<Mod<State>>

const deadline: Deadline = { ms: 2000, job: 'permissions' }

export function permissions<State extends object = Record<never, never>>(rules: PermissionRules<State> | ((state: State) => PermissionRules<State>)): Job<void, State> {
  const count = typeof rules === 'function' ? undefined : checkedCount(rules)
  if (count === 0) throw new Error('permissions: give it a deny or an ask rule, or remove it from setup.')

  return (job) => {
    const readWorkspace = workspaceReader(job)

    const verdictOf = async (e: Frozen<Args<'tool.check'>>): Promise<Verdict | undefined> => {
      let current: PermissionRules<State>
      try {
        current = typeof rules === 'function' ? rules(job.mod.state as State) : rules
        checkedCount(current)
      } catch (error) {
        return { decision: 'deny', reason: `The permission rules of ${job.mod.name} failed, so it denies the call: ${messageOf(error)}` }
      }
      try {
        const [agent, workspace] = await Promise.all([job.toolCalls.agentOf(e.tool_use_id), readWorkspace()])
        return await decidePermission(current, { tool: e.tool, input: inputOf(e.input), ...agent }, workspace, (call, folder) => modOf(job, { call, folder }, workspace, deadline))
      } catch (error) {
        return { decision: 'deny', reason: `The permissions job could not read the session, so it denies the call: ${messageOf(error)}` }
      }
    }

    job.on('tool.check', async (e, next) => {
      const [below, ours] = await Promise.all([next(e), verdictOf(e)])
      return ours === undefined ? below : stricterVerdict<Verdict>(below, ours)
    })
    job.announce(count === undefined ? 'permission rules from its state' : `${count} permission rule${count === 1 ? '' : 's'}`)
  }
}

function checkedCount<Mod>(rules: RulesFor<Mod>): number {
  const all = [...(rules.deny ?? []), ...(rules.ask ?? [])]
  for (const rule of all) targetOf(rule)
  return all.length
}
