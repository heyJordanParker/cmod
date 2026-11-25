import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { dataFolder, storeFolder } from '@cmodjs/core/src/records.js'
import { startTask, stopBackground } from '../claude.js'
import { writeAtomically } from '../files.js'
import { runningEntries, sessionTranscripts } from '../history.js'

export const summary = 'Start a task in a new background Claude Code session, or stop one.'

export const help = `Usage: cmod task start <prompt> --title <title> [--clone [--at <message>]] [--agent <type>] [--model <model>] [--cwd <folder>] [--json]
       cmod task stop <session> [--json]

Start a task in a new background Claude Code session, for a mod's startTask with
isBackground and its fork with isBackground.

The task belongs to the session this command runs in, which Claude Code names
in CLAUDE_CODE_SESSION_ID. The new session starts fresh on the prompt, or with
--clone on a fork of that session's conversation, which cmod writes as a new
transcript: the whole conversation, or with --at its first message through the
message with that id, and nothing after it. --agent and --model pick the agent
definition and model of a fresh session, and --cwd the folder it works in.
Claude Code names the new session with the title. It prints the task, as one
line of JSON with --json, and the cmod plugin of the new session tells the
starting session once it answered.

stop stops the session with claude stop when Claude Code records it as a
background session, and leaves any other session running. It prints whether it
stopped the session, as {"isStopped": true or false} with --json, for the cmod
plugin's end, which ends any other session with /exit.`

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      title: { type: 'string' },
      clone: { type: 'boolean', default: false },
      at: { type: 'string' },
      agent: { type: 'string' },
      model: { type: 'string' },
      cwd: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  })
  const [command, prompt, ...rest] = positionals
  if (command === 'stop' && prompt !== undefined && rest.length === 0) return stop(prompt, values.json)
  if (command !== 'start' || prompt === undefined || prompt.trim() === '' || rest.length > 0) throw new Error(`cmod task takes start <prompt> or stop <session>.\n\n${help}`)
  const title = values.title?.trim() ?? ''
  if (title === '') throw new Error('cmod task start takes --title <title>, the title the task shows.')
  if (values.clone && (values.agent !== undefined || values.model !== undefined)) throw new Error('cmod task start --clone takes no --agent or --model, because a clone runs as the session it copies.')
  if (values.at !== undefined && !values.clone) throw new Error('cmod task start --at takes --clone, because it names the last message of the fork.')
  const session = process.env['CLAUDE_CODE_SESSION_ID']
  if (session === undefined || session === '') throw new Error('cmod task start runs inside Claude Code, which names the session the task belongs to in CLAUDE_CODE_SESSION_ID.')
  const cwd = resolve(values.cwd ?? process.cwd())
  const fork = values.clone ? await writeFork(session, cwd, values.at) : undefined
  const started = await startTask(session, { title, prompt, cwd, ...(values.agent === undefined ? {} : { agentType: values.agent }), ...(values.model === undefined ? {} : { model: values.model }), ...(fork === undefined ? {} : { fork }) })
  await writeAtomically(join(dataFolder(storeFolder(process.env), 'cmod'), 'tasks', session, `${started.id}.json`), JSON.stringify(started))
  process.stdout.write(values.json ? `${JSON.stringify(started)}\n` : `${started.id}  ${title}\n`)
  return 0
}

async function stop(session: string, isJson: boolean): Promise<number> {
  const record = runningEntries().find((entry) => entry.session === session)
  const isBackground = record?.kind === 'bg'
  if (isBackground && record.jobId === undefined) throw new Error(`Claude Code's record of background session ${session} names no jobId, so cmod cannot run claude stop for it.`)
  if (isBackground && record.jobId !== undefined) await stopBackground(record.jobId)
  process.stdout.write(isJson ? `${JSON.stringify({ isStopped: isBackground })}\n` : isBackground ? `Stopped background session ${session}.\n` : `Session ${session} is no background session, so cmod task stop left it running.\n`)
  return 0
}

type Row = Readonly<Record<string, unknown>> & { readonly type?: unknown; readonly uuid?: unknown; readonly parentUuid?: unknown; readonly isSidechain?: unknown }

const messageTypes = new Set(['user', 'assistant', 'attachment', 'system', 'progress'])

const carriedTypes = new Set(['content-replacement', 'memory-mode', 'relocated'])

async function writeFork(source: string, project: string, at: string | undefined): Promise<string> {
  const [main] = sessionTranscripts(source, project)
  if (main === undefined) throw new Error(`session ${source} has no transcript yet, so it has nothing to fork.`)
  const rows = (await readFile(main.path, 'utf8')).split('\n').flatMap((line): Row[] => {
    try {
      const row = JSON.parse(line) as unknown
      return typeof row === 'object' && row !== null && !Array.isArray(row) ? [row as Row] : []
    } catch (error) {
      if (error instanceof SyntaxError) return []
      throw error
    }
  })
  const messages = new Map(rows.flatMap((row) => (typeof row.uuid === 'string' && messageTypes.has(String(row.type)) && row.isSidechain !== true ? [[row.uuid, row] as const] : [])))
  const last = at ?? rows.findLast((row) => (row.type === 'user' || row.type === 'assistant') && typeof row.uuid === 'string' && messages.has(row.uuid))?.uuid
  if (typeof last !== 'string' || !messages.has(last)) throw new Error(at === undefined ? `session ${source} holds no message to fork.` : `session ${source} holds no message ${at} to fork from. Its read lists each message's id.`)
  const chain: Row[] = []
  for (let uuid: unknown = last; typeof uuid === 'string' && !chain.some((row) => row.uuid === uuid); uuid = messages.get(uuid)?.parentUuid) {
    const row = messages.get(uuid)
    if (row === undefined) break
    chain.unshift(row)
  }
  const fork = randomUUID()
  let parentUuid: unknown = null
  const lines: unknown[] = []
  for (const row of chain) {
    lines.push({ ...row, sessionId: fork, parentUuid, isSidechain: false, forkedFrom: { sessionId: source, messageUuid: row.uuid } })
    if (row.type !== 'progress') parentUuid = row.uuid
  }
  for (const row of rows) if (carriedTypes.has(String(row.type)) && row['sessionId'] === source) lines.push({ ...row, sessionId: fork })
  await writeFile(join(main.folder, `${fork}.jsonl`), lines.map((line) => `${JSON.stringify(line)}\n`).join(''), { flag: 'wx' })
  return fork
}
