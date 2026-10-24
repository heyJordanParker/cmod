import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { dataFolder, storeFolder } from '@cmodjs/core/src/records.js'
import type { TaskData } from '@cmodjs/core/src/session/conversation.js'
import { startBackground } from '../claude.js'
import { writeAtomically } from '../files.js'

export const summary = 'Start a task in a new background Claude Code session.'

export const help = `Usage: cmod task start <prompt> --title <title> [--clone] [--agent <type>] [--model <model>] [--cwd <folder>] [--json]

Start a task in a new background Claude Code session, for a mod's startTask with
isBackground and its clone.

The task belongs to the session this command runs in, which Claude Code names
in CLAUDE_CODE_SESSION_ID. The new session starts fresh on the prompt, or with
--clone on a copy of that session's conversation. --agent and --model pick the
agent definition and model of a fresh session, and --cwd the folder it works
in. It prints the task, as one line of JSON with --json, and the cmod plugin of
the new session tells the starting session once it answered.`

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      title: { type: 'string' },
      clone: { type: 'boolean', default: false },
      agent: { type: 'string' },
      model: { type: 'string' },
      cwd: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  })
  const [command, prompt, ...rest] = positionals
  if (command !== 'start' || prompt === undefined || prompt.trim() === '' || rest.length > 0) throw new Error(`cmod task takes start <prompt>.\n\n${help}`)
  const title = values.title?.trim() ?? ''
  if (title === '') throw new Error('cmod task start takes --title <title>, the title the task shows.')
  if (values.clone && (values.agent !== undefined || values.model !== undefined)) throw new Error('cmod task start --clone takes no --agent or --model, because a clone runs as the session it copies.')
  const session = process.env['CLAUDE_CODE_SESSION_ID']
  if (session === undefined || session === '') throw new Error('cmod task start runs inside Claude Code, which names the session the task belongs to in CLAUDE_CODE_SESSION_ID.')
  const task = {
    title,
    ...(values.clone ? { forkedFrom: session } : {}),
    ...(values.agent === undefined ? {} : { agentType: values.agent }),
    ...(values.model === undefined ? {} : { model: values.model }),
    openedBy: '',
    openedAt: new Date().toISOString(),
    isBackground: true as const,
  }
  const settings = JSON.stringify({ env: { CMOD_TASK: JSON.stringify({ session, ...task }) } })
  const id = await startBackground(
    [...(values.clone ? ['--resume', session, '--fork-session'] : []), ...(values.agent === undefined ? [] : ['--agent', values.agent]), ...(values.model === undefined ? [] : ['--model', values.model]), '--settings', settings, '--', prompt],
    resolve(values.cwd ?? process.cwd()),
  )
  const started: TaskData = { id, ...task }
  await writeAtomically(join(dataFolder(storeFolder(process.env), 'cmod'), 'tasks', session, `${id}.json`), JSON.stringify(started))
  process.stdout.write(values.json ? `${JSON.stringify(started)}\n` : `${id}  ${title}\n`)
  return 0
}
