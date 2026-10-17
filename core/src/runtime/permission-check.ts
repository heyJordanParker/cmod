import type { Disposable } from '../mod.js'
import type { HookFields } from './hooks.js'
import { defined, processPayloadOf, recordOf, type HookOn, type RouteOn, type ToolCheck } from './sessions.js'

export type PermissionUse = {
  readonly raise: (method: string, payload: HookFields) => Promise<HookFields | undefined>
  readonly hookOn: HookOn
  readonly routeOn: RouteOn
  readonly current: () => { readonly id: string; readonly cwd: string }
}

export type PermissionRoutes = (method: string, use: PermissionUse) => Disposable

type Verdict = { readonly decision: 'allow' | 'ask' | 'deny'; readonly reason?: string; readonly rule?: string }

const verdictName = (decision: Verdict['decision']) => (decision === 'deny' ? 'refuse' : decision)

export const permissionRoutes: PermissionRoutes = (method, { raise, hookOn, routeOn, current }) => {
  const isBefore = method.startsWith('before')
  if (method.endsWith('PermissionCheck')) {
    return routeOn('tool.check', async (e: ToolCheck, next) => {
      const below = (await next(e)) as Verdict
      const { id, cwd } = current()
      const payload = { session: id, cwd, ...defined({ task: e.agentId, callId: e.tool_use_id, reason: below.reason, rule: below.rule, ceiling: e.ceiling === undefined ? undefined : verdictName(e.ceiling) }), name: e.tool, input: recordOf(e.input), decision: verdictName(below.decision) }
      if (!isBefore) {
        void raise(method, payload)
        return below
      }
      const answer = await raise(method, payload)
      if (answer === undefined || below.decision === 'deny') return below
      if (typeof answer['refuse'] === 'string') return { decision: 'deny', reason: answer['refuse'] }
      if (typeof answer['ask'] === 'string') return { decision: 'ask', reason: answer['ask'] }
      return answer['allow'] === true ? { decision: 'allow' } : below
    })
  }
  return hookOn('PermissionRequest', async (input) => {
    const payload = processPayloadOf('PermissionRequest', input)
    if (!isBefore) {
      void raise(method, payload)
      return undefined
    }
    const answer = await raise(method, payload)
    if (answer === undefined) return undefined
    if (typeof answer['refuse'] === 'string') return { decision: defined({ behavior: 'deny', message: answer['refuse'], interrupt: answer['interrupt'] }) }
    return answer['allow'] === true ? { decision: defined({ behavior: 'allow', updatedInput: answer['input'], updatedPermissions: answer['updates'] }) } : undefined
  })
}
