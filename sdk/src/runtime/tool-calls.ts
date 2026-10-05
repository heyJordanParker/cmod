import type { Mod, PartContext } from '../mod.js'

export type Agent = { agentId?: string; agentType?: string }

export type ToolCalls = {
  agentOf(toolUseId: string | undefined): Promise<Agent>
  cwdOf(toolUseId: string): string | undefined
}

export const reservedKeys: readonly string[] = ['tool', 'tool_use_id', 'consent', 'agentId']

type AgentFields = { readonly agent_id?: string; readonly agent_type?: string }

const toolCallsByMod = new WeakMap<Mod, ToolCalls>()

const keptCalls = 100

export function toolCalls(context: PartContext): ToolCalls {
  const known = toolCallsByMod.get(context.mod)
  if (known !== undefined) return known
  const { claude, on } = context
  let mainAgentType: string | undefined
  const agentIds = new Map<string, string>()
  const cwds = new Map<string, string>()
  const noteAgent = (e: AgentFields) => {
    if (e.agent_id === undefined) mainAgentType = e.agent_type
  }
  on('classic.SessionStart', (e, next) => {
    noteAgent(e)
    return next(e)
  })
  on('classic.UserPromptSubmit', (e, next) => {
    noteAgent(e)
    return next(e)
  })
  on('tool.call', async (e, next) => {
    if (e.agentId === undefined) return next(e)
    agentIds.set(e.tool_use_id, e.agentId)
    try {
      return await next(e)
    } finally {
      agentIds.delete(e.tool_use_id)
    }
  })
  on('classic.PreToolUse', async (e, next) => {
    cwds.set(e.tool_use_id, await claude.session.cwd())
    for (const oldest of cwds.keys()) {
      if (cwds.size <= keptCalls) break
      cwds.delete(oldest)
    }
    return next(e)
  })
  for (const event of ['classic.PostToolUse', 'classic.PostToolUseFailure'] as const) {
    on(event, async (e, next) => {
      try {
        return await next(e)
      } finally {
        cwds.delete(e.tool_use_id)
      }
    })
  }
  const calls: ToolCalls = {
    async agentOf(toolUseId) {
      const agentId = toolUseId === undefined ? undefined : agentIds.get(toolUseId)
      const agentType = agentId === undefined ? mainAgentType : (await claude.agent.list()).find((agent) => agent.id === agentId)?.type
      return { ...(agentId === undefined ? {} : { agentId }), ...(agentType === undefined ? {} : { agentType }) }
    },
    cwdOf: (toolUseId) => cwds.get(toolUseId),
  }
  toolCallsByMod.set(context.mod, calls)
  return calls
}
