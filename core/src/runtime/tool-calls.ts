import type { Claude } from './claude.js'
import type { Router } from './router.js'

export type Agent = { agentId?: string; agentType?: string }

export type ToolCalls = {
  agentOf(toolUseId: string | undefined): Promise<Agent>
  cwdOf(toolUseId: string): string | undefined
}

export const reservedKeys: readonly string[] = ['tool', 'tool_use_id', 'consent', 'agentId']

export function toolInputOf(envelope: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(envelope).filter(([key]) => !reservedKeys.includes(key)))
}

type AgentFields = { readonly agent_id?: string; readonly agent_type?: string }

const keptCalls = 100

export function toolCalls(claude: Claude, router: Router): ToolCalls {
  let mainAgentType: string | undefined
  const agentIds = new Map<string, string>()
  const cwds = new Map<string, string>()
  const noteAgent = (e: AgentFields) => {
    if (e.agent_id === undefined) mainAgentType = e.agent_type
  }
  router.add('classic.SessionStart', (e, next) => {
    noteAgent(e)
    return next(e)
  })
  router.add('classic.UserPromptSubmit', (e, next) => {
    noteAgent(e)
    return next(e)
  })
  router.add('tool.call', async (e, next) => {
    if (e.agentId === undefined) return next(e)
    agentIds.set(e.tool_use_id, e.agentId)
    try {
      return await next(e)
    } finally {
      agentIds.delete(e.tool_use_id)
    }
  })
  router.add('classic.PreToolUse', async (e, next) => {
    cwds.set(e.tool_use_id, await claude.session.cwd())
    for (const oldest of cwds.keys()) {
      if (cwds.size <= keptCalls) break
      cwds.delete(oldest)
    }
    return next(e)
  })
  for (const event of ['classic.PostToolUse', 'classic.PostToolUseFailure'] as const) {
    router.add(event, async (e, next) => {
      try {
        return await next(e)
      } finally {
        cwds.delete(e.tool_use_id)
      }
    })
  }
  return {
    async agentOf(toolUseId) {
      const agentId = toolUseId === undefined ? undefined : agentIds.get(toolUseId)
      const agentType = agentId === undefined ? mainAgentType : (await claude.agent.list()).find((agent) => agent.id === agentId)?.type
      return { ...(agentId === undefined ? {} : { agentId }), ...(agentType === undefined ? {} : { agentType }) }
    },
    cwdOf: (toolUseId) => cwds.get(toolUseId),
  }
}
