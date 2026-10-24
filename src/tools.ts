import { tool } from '../node_modules/@cmodjs/core/jobs/tool.js'
import { commands, Prompt, sessions, type Mod } from '../node_modules/@cmodjs/core/mod.js'
import { engineOf } from '../node_modules/@cmodjs/core/runtime/engine.js'
import type { CmodPluginState } from './mod.js'

const carryOn = 'The conversation was compacted. Carry on with the work from before the compaction.'

export function addClaudeTools(mod: Mod<CmodPluginState>): void {
  const { report } = engineOf(mod)
  let compaction: { readonly keep?: string } | undefined

  const compact = async ({ keep }: { readonly keep?: string }) => {
    try {
      await commands.run('compact', keep)
      await sessions.current.send({ type: Prompt, text: carryOn })
    } catch (error) {
      report({ id: 'compact', message: 'Could not compact the conversation', error })
    }
  }

  sessions.current.onTurnEnd(() => {
    const asked = compaction
    compaction = undefined
    if (asked !== undefined) mod.after(1, () => void compact(asked))
  })

  mod.use(
    tool({
      name: 'compact',
      description: 'Compact this conversation once your answer ends: a summary replaces the conversation so far, and a prompt then lets you carry on. Use it when the context window is filling up and the work so far fits in a summary.',
      inputSchema: {
        type: 'object',
        properties: { keep: { type: 'string', description: 'What the summary must keep, such as the plan, the decisions, and the files changed.' } },
        additionalProperties: false,
      },
      execute: ({ keep }) => {
        compaction = keep === undefined ? {} : { keep }
        return 'The conversation compacts once this answer ends, and a prompt then lets you carry on. End your answer now.'
      },
    }),
  )
  mod.use(
    tool({
      name: 'start_background_agent',
      description: 'Start an agent in a new background Claude Code session. It works on the task on its own, sees none of this conversation, and keeps running after this session ends.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Everything the agent needs to do the task, because it sees none of this conversation.' },
          title: { type: 'string', description: 'A few words that name the task.' },
          agentType: { type: 'string', description: 'The agent definition the session runs, such as Explore. Leave it out for a plain session.' },
          model: { type: 'string', description: 'The model the session runs on, such as sonnet. Leave it out for the default model.' },
          cwd: { type: 'string', description: 'The folder the session works in. Leave it out for this session’s folder.' },
        },
        required: ['task', 'title'],
        additionalProperties: false,
      },
      execute: async ({ task, title, agentType, model, cwd }) => {
        const started = await sessions.current.startTask({ prompt: task, title, isBackground: true, ...(agentType === undefined ? {} : { agentType }), ...(model === undefined ? {} : { model }), ...(cwd === undefined ? {} : { cwd }) })
        return `Started a background agent in session ${started.id}. It answers there, not in this conversation.`
      },
    }),
  )
}
