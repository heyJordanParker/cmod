import { sessions, type Mod } from '../node_modules/@cmodjs/core/mod.js'
import { readPreferences } from './settings.js'

const forkType = 'fork'

const builtInType = 'general-purpose'

export function routeAgents(mod: Mod<object>): void {
  sessions.current.beforeToolCall({ name: 'Agent' }, async (call) => {
    const { input } = call
    if (input['run_in_background'] === false || input['name'] !== undefined || input['isolation'] !== undefined) return undefined
    if (!(await readPreferences(mod)).runsAgentsAsSessions) return undefined
    const title = typeof input['description'] === 'string' && input['description'].trim() !== '' ? input['description'].trim() : 'Agent'
    const prompt = typeof input['prompt'] === 'string' ? input['prompt'] : ''
    const type = typeof input['subagent_type'] === 'string' ? input['subagent_type'] : undefined
    const model = typeof input['model'] === 'string' ? { model: input['model'] } : {}
    const task = type === forkType ? await sessions.current.fork({ title, prompt, isBackground: true }) : await sessions.current.startTask({ title, prompt, isBackground: true, ...(type === undefined || type === builtInType ? {} : { agentType: type }), ...model })
    const short = task.id.slice(0, 8)
    return {
      result: [
        `"${title}" runs as the background Claude Code session ${task.id}, which keeps running after this session ends. Its answer arrives as a message from that session, so go on with other work until it does.`,
        `Message it with \`cmod sessions send ${short} <text>\`, read it with \`cmod sessions read messages ${short}\`, and stop it with \`cmod sessions end ${short}\`.`,
      ].join('\n\n'),
    }
  })
}
