import type { Disposable } from '../mod.js'
import type { HookFields } from './hooks.js'
import { defined, processPayloadOf, recordOf, type HookOn, type RouteOn, type ToolCheck } from './sessions.js'

export type PermissionUse = {
  readonly raise: (method: string, payload: HookFields) => Promise<HookFields | undefined>
  readonly refusalFor: (method: string, payload: HookFields, error: Error) => { readonly refuse: string } | undefined
  readonly hookOn: HookOn
  readonly routeOn: RouteOn
  readonly current: () => { readonly id: string; readonly cwd: string }
}

export type PermissionRoutes = (method: string, use: PermissionUse) => Disposable

type Verdict = { readonly decision: 'allow' | 'ask' | 'deny'; readonly reason?: string; readonly rule?: string }

const verdictName = (decision: Verdict['decision']) => (decision === 'deny' ? 'refuse' : decision)

export const permissionRoutes: PermissionRoutes = (method, { raise, refusalFor, hookOn, routeOn, current }) => {
  const isBefore = method.startsWith('before')
  if (method.endsWith('PermissionCheck')) {
    const payloadOf = (e: ToolCheck, below: Verdict) => {
      const { id, cwd } = current()
      return { session: id, cwd, ...defined({ task: e.agentId, callId: e.tool_use_id, reason: below.reason, rule: below.rule, ceiling: e.ceiling === undefined ? undefined : verdictName(e.ceiling) }), name: e.tool, input: recordOf(e.input), decision: verdictName(below.decision) }
    }
    const failed = async (e: ToolCheck, error: Error, next: (e: ToolCheck) => Promise<unknown>) => {
      const refusal = refusalFor(method, payloadOf(e, (await next(e)) as Verdict), error)
      return refusal === undefined ? undefined : { decision: 'deny' as const, reason: refusal.refuse }
    }
    return routeOn(
      'tool.check',
      async (e: ToolCheck, next) => {
        const below = (await next(e)) as Verdict
        const payload = payloadOf(e, below)
        if (!isBefore) {
          void raise(method, payload)
          return below
        }
        const answer = await raise(method, payload)
        if (answer === undefined || below.decision === 'deny') return below
        if (typeof answer['refuse'] === 'string') return { decision: 'deny', reason: answer['refuse'] }
        if (typeof answer['ask'] === 'string') return { decision: 'ask', reason: answer['ask'] }
        return answer['allow'] === true ? { decision: 'allow' } : below
      },
      isBefore ? failed : undefined,
    )
  }
  const refused = (refuse: string, interrupt?: unknown) => ({ decision: defined({ behavior: 'deny', message: refuse, interrupt }) })
  return hookOn(
    'PermissionRequest',
    async (input) => {
      const payload = processPayloadOf('PermissionRequest', input)
      if (!isBefore) {
        void raise(method, payload)
        return undefined
      }
      const answer = await raise(method, payload)
      if (answer === undefined) return undefined
      if (typeof answer['refuse'] === 'string') return refused(answer['refuse'], answer['interrupt'])
      return answer['allow'] === true ? { decision: defined({ behavior: 'allow', updatedInput: answer['input'], updatedPermissions: answer['updates'] }) } : undefined
    },
    isBefore
      ? (input, error) => {
          const refusal = refusalFor(method, processPayloadOf('PermissionRequest', input), error)
          return refusal === undefined ? undefined : refused(refusal.refuse)
        }
      : undefined,
  )
}
