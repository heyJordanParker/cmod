import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Message, searchText, type Message as SessionMessage } from '@cmodjs/core/src/session/context/turn/message/message.js'
import { AttachedFile } from '@cmodjs/core/src/session/context/turn/message/attached-file.js'
import { InstructionFile } from '@cmodjs/core/src/session/context/turn/message/instruction-file.js'
import { Note } from '@cmodjs/core/src/session/context/turn/message/note.js'
import { Prompt } from '@cmodjs/core/src/session/context/turn/message/prompt.js'
import { Person, type Sender } from '@cmodjs/core/src/session/context/turn/message/sender.js'
import { Reply } from '@cmodjs/core/src/session/context/turn/message/reply.js'
import { Skill } from '@cmodjs/core/src/session/context/turn/message/skill.js'
import { ToolCall } from '@cmodjs/core/src/session/context/turn/message/tool-call.js'
import { ToolResult } from '@cmodjs/core/src/session/context/turn/message/tool-result.js'
import type { ContextData, SessionChange, SessionData, TaskData, TurnData } from '@cmodjs/core/src/session/conversation.js'
import type { Usage } from '@cmodjs/core/src/session/session.js'
import { conversationMethods } from '@cmodjs/core/src/runtime/sessions.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { followSessions, foldersIn, openHistory, readContexts, readFolders, readGoal, readMessages, readState, readTasks, readTurns, readUsage, type Scope } from '../history.js'
import { withScript, type Script } from '../script.js'
import { storePath, takeLock } from '../store.js'

export const summary = 'Find, read, and drive Claude Code sessions on every device cmod reaches.'

export const help = `Usage: cmod sessions list [--every-project] [--since 2d] [--running] [--project <folder>] [--json]
       cmod sessions search <text> [--every-project] [--since 2d] [--running] [--project <folder>] [--session <id> [--task <id>] [--turn <id>] [--context <n>] [--agent]] [--limit <n>] [--before <session>:<id>] [--json]
       cmod sessions read messages [<session>] [--task <id>] [--turn <id>] [--after <id>] [--last <n>] [--json]
       cmod sessions read turns [<session>] [--task <id>] [--context <n>] [--last <n>] [--json]
       cmod sessions read contexts [<session>] [--task <id>] [--json]
       cmod sessions read tasks [<session>] [--task <id> | --nested] [--json]
       cmod sessions read goal [<session>] [--task <id>] [--json]
       cmod sessions read usage [<session>] [--task <id>] [--json]
       cmod sessions read state [<session>] [--json]
       cmod sessions read <part> <session> --transcripts <folder> [--json]
       cmod sessions send <session> <text> [--note]
       cmod sessions start <prompt> --title <title> [--agent-type <type>] [--model <model>] [--cwd <folder>] [--device <name>] [--json]
       cmod sessions fork <prompt> --title <title> [--session <id>] [--at <message>] [--json]
       cmod sessions stop <session>
       cmod sessions end <session>
       cmod sessions compact [<session>] [--keep <text>]
       cmod sessions delete <session>
       cmod sessions follow [<session>...] [--running] [--json]
       cmod sessions index

${summary}

list, search, read, and every command that acts on a session go through cmod
serve, so they reach the sessions of this computer and of each device a sessions
provider serves, as a mod's sessions import does. A <session> is the id list
prints. Inside Claude Code, CLAUDE_CODE_SESSION_ID names this session, which a
command takes when it names none.

list lists the conversations of the project, newest first: the current
folder's, or --project's, and with --every-project every project's. Each line
names the device the session runs on, and whether it runs or waits on a dialog.
--since keeps those active in the last 30m, 6h, 2d, or 1w, or since a date such
as 2026-10-01, and --running keeps those open in Claude Code now.

search prints the newest 50 messages whose text or tool input contains the
text, at least 3 characters, each with the words around the match. Each tool
input value is searched in its first 1,024 characters, tool results are not
searched, and earlier cmod sessions searches are left out. --every-project,
--since, and --running scope it the way they scope list, --limit changes the
50, and --before <session>:<id> starts after the last message of the previous
page. --session searches one conversation, and inside it --task searches a task
and the tasks it started, --turn one turn, --context one context, and --agent
keeps the main agent's messages, or with --task that task's own, without the
tasks it started.

read messages prints one conversation's messages in order, each with its id,
which --after, fork --at, and search --before take. --task reads a task's
messages instead, --turn keeps one turn's, --after starts after a message id,
and --last keeps that many from the end. read turns prints the turns, each
opened by a prompt and closed when Claude finishes, --context keeps one
context's, and --last keeps that many from the end. read contexts prints the
contexts, a new one after each compaction. read tasks prints the tasks the
conversation started, with --task the tasks that task started, and with
--nested every task at any depth. read goal prints what the conversation is
for: the goal a mod set, or its first prompt. read usage prints the model and
the context's tokens as of the last reply. --task reads turns, contexts, goal,
and usage of the agent a task runs. read state prints what a running
conversation on this computer resumes from.

read --transcripts reads the conversation from the transcripts in
<folder>/projects, a Claude Code folder such as one copied from another
computer, through an index of its own that lives only while the command runs,
so cmod's own index of this computer's conversations never lists it.

send sends the session a prompt, which it answers as its next turn, or with
--note a note it reads with its next prompt. Inside Claude Code the prompt goes
from this session, so the session it reaches knows who sent it. A session that
ended resumes on the prompt.

start starts a background session on a task, and fork starts one on a copy of
a conversation, this session's or --session's, whole or through the message
--at names. Each prints the task, as one line of JSON with --json. A start
belongs to this session, and a fork to the session it copies, which hears when
the task ends.

stop stops the session's running turn, as Esc does. end ends the session's
Claude Code once its turn ends, and its conversation stays. compact compacts
the conversation once its turn ends, keeping what --keep names, and then
prompts Claude to carry on. delete deletes a session that ended: its
transcripts, goal, tasks, and index rows.

follow prints each message, turn, context, task, and goal change of this
computer's sessions named as Claude Code saves them, until stopped. With
--running it follows every running session of the project too, and each one
that starts later, except the session that runs it.

index indexes every saved conversation on this computer.`

const parts: readonly string[] = ['messages', 'turns', 'contexts', 'tasks', 'goal', 'usage', 'state']

const searchedChars = { before: 60, after: 140 }

type Values = { readonly [key: string]: string | boolean | undefined }

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'every-project': { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      since: { type: 'string' },
      running: { type: 'boolean', default: false },
      project: { type: 'string' },
      session: { type: 'string' },
      task: { type: 'string' },
      agent: { type: 'boolean', default: false },
      'agent-type': { type: 'string' },
      nested: { type: 'boolean', default: false },
      turn: { type: 'string' },
      context: { type: 'string' },
      before: { type: 'string' },
      last: { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean', default: false },
      transcripts: { type: 'string' },
      note: { type: 'boolean', default: false },
      keep: { type: 'string' },
      title: { type: 'string' },
      at: { type: 'string' },
      model: { type: 'string' },
      cwd: { type: 'string' },
      device: { type: 'string' },
    },
  })
  const [given = ''] = positionals
  const [command = '', ...rest] = given === 'sessions' ? ['list', ...positionals.slice(1)] : parts.includes(given) ? ['read', ...positionals] : positionals
  const project = values.project ?? process.cwd()
  const print = (value: unknown, lines: () => string) => process.stdout.write(values.json ? `${JSON.stringify(value)}\n` : lines())
  if (values.transcripts !== undefined) return readTranscripts(command, rest, values, project, print)
  if (command === 'follow' || command === 'index' || (command === 'read' && rest[0] === 'state')) return readHere(command, rest, values, project, print)
  return withScript('sessions', project, (script) => onServe(script, command, rest, values, print))
}

async function onServe(script: Script, command: string, rest: readonly string[], values: Values, print: (value: unknown, lines: () => string) => void): Promise<number> {
  const own = process.env['CLAUDE_CODE_SESSION_ID'] || undefined
  const act = (session: string, action: string, input: unknown, task?: string) => script.answer(conversationMethods.act, { session, action, input, ...(task === undefined ? {} : { task }) })
  const ask = <Value>(method: string, input: object) => script.answer(method, input) as Promise<Value>
  const flags = (keys: readonly string[]): Readonly<Record<string, unknown>> => Object.fromEntries(keys.flatMap((key) => (values[key] === undefined ? [] : [[key, values[key]]])))
  const named = (verb: string) => {
    const session = rest[0] ?? own
    if (rest.length > 1 || session === undefined) throw new Error(`cmod sessions ${verb} takes a session id outside Claude Code. cmod sessions list lists them.`)
    return session
  }
  const ownOrRefuse = (verb: string) => {
    if (own === undefined) throw new Error(`cmod sessions ${verb} runs inside Claude Code, which names the session the task belongs to in CLAUDE_CODE_SESSION_ID.`)
    return own
  }
  const task = typeof values['task'] === 'string' ? { task: values['task'] } : {}
  if (command === 'list' && rest.length === 0) {
    const sessions = await ask<SessionData[]>(conversationMethods.sessions, { ...sinceOf(values['since']), ...(values['every-project'] === true || values['all'] === true ? { everyProject: true } : {}), ...(values['running'] === true ? { running: true } : {}) })
    print(sessions, () => sessions.map(sessionLine).join(''))
    return 0
  }
  if (command === 'search' && rest.length === 1) {
    const text = rest[0] as string
    if (text.trim().length < 3) throw new Error('cmod sessions search takes at least 3 characters.')
    const record: Readonly<Record<string, unknown>> = { ...flags(['session', 'task', 'turn']), ...(values['context'] === undefined ? {} : { context: countOf('--context', String(values['context'])) }), ...(values['agent'] === true ? { isAgent: true } : {}) }
    if (record['session'] === undefined && Object.keys(record).length > 0) throw new Error('cmod sessions search takes --task, --turn, --context, and --agent only with --session.')
    const limit = values['limit'] === undefined ? 50 : countOf('--limit', String(values['limit']))
    const found = (await ask<SessionMessage[]>(conversationMethods.search, { text, ...sinceOf(values['since']), ...(values['every-project'] === true || values['all'] === true ? { everyProject: true } : {}), ...(values['running'] === true ? { running: true } : {}), ...(values['before'] === undefined ? {} : { before: cursorOf(String(values['before'])) }), ...record, limit }))
      .filter((message) => !isSearchCall(message))
      .slice(0, limit)
    print(found, () => found.map((message) => foundLine(message, text)).join(''))
    return 0
  }
  if (command === 'read') {
    const [part, ...ids] = rest
    const session = (() => {
      const id = ids[0] ?? own
      if (ids.length > 1 || id === undefined) throw new Error(`cmod sessions read ${part ?? ''} takes a session id outside Claude Code. cmod sessions list lists them.`)
      return id
    })()
    const lasts = values['last'] === undefined ? {} : { last: countOf('--last', String(values['last'])) }
    if (part === 'messages') {
      const messages = await ask<SessionMessage[]>(conversationMethods.messages, { session, ...task, ...flags(['turn', 'after']), ...lasts })
      print(messages, () => messages.map((message) => messageLine(message, false)).join(''))
      return 0
    }
    if (part === 'turns') {
      const turns = await ask<TurnData[]>(conversationMethods.turns, { session, ...task, ...(values['context'] === undefined ? {} : { context: countOf('--context', String(values['context'])) }), ...lasts })
      print(turns, () => turns.map((turn) => `${localTime(turn.openedAt)}  ${turn.closedAt === undefined ? 'open  ' : localTime(turn.closedAt)}  ${firstLine(turn.prompt.text)}\n`).join(''))
      return 0
    }
    if (part === 'contexts') {
      const contexts = await ask<ContextData[]>(conversationMethods.contexts, { session, ...task })
      print(contexts, () => contexts.map((context) => `${context.number}  ${localTime(context.openedAt, true)}${context.closedAt === undefined ? '' : `  to ${localTime(context.closedAt, true)}`}\n`).join(''))
      return 0
    }
    if (part === 'tasks') {
      const tasks = await ask<TaskData[]>(conversationMethods.tasks, { session, ...(values['nested'] === true ? { all: true } : task) })
      print(tasks, () => tasks.map(taskLine).join(''))
      return 0
    }
    if (part === 'goal') {
      const goal = await ask<{ readonly text: string }>(conversationMethods.goal, { session, ...task })
      print(goal, () => `${goal.text}\n`)
      return 0
    }
    if (part === 'usage') {
      const usage = (await act(session, 'usage', null, task.task)) as Usage
      print(usage, () => `${usage.model}  ${usage.contextWindow.tokenCount ?? 0} tokens\n`)
      return 0
    }
  }
  if (command === 'send' && rest.length === 2) {
    const [session, text] = rest as [string, string]
    if (text.trim() === '') throw new Error('cmod sessions send takes the text to send.')
    const sent = { type: values['note'] === true ? Note : Prompt, text }
    await (own === undefined ? act(session, 'send', sent) : act(own, 'sendTo', { ...sent, to: session }).catch((error: unknown) => {
      if (!/(takes no action named |answers no cmod\/Sessions\.)sendTo\.$/.test(messageOf(error))) throw error
      return act(session, 'send', sent)
    }))
    process.stdout.write(`Sent session ${session} the ${values['note'] === true ? 'note' : 'prompt'}.\n`)
    return 0
  }
  if (command === 'start' && rest.length === 1) {
    const started = (await act(ownOrRefuse('start'), 'startBackgroundTask', { prompt: rest[0], title: titleOf(values, 'start'), isBackground: true, ...(values['agent-type'] === undefined ? {} : { agentType: values['agent-type'] }), ...flags(['model', 'device']), ...(values['cwd'] === undefined ? {} : { cwd: resolve(String(values['cwd'])) }) })) as TaskData
    print(started, () => `${started.id}  ${started.title}\n`)
    return 0
  }
  if (command === 'fork' && rest.length === 1) {
    const source = typeof values['session'] === 'string' ? values['session'] : ownOrRefuse('fork')
    const forked = (await act(source, 'fork', { prompt: rest[0], title: titleOf(values, 'fork'), isBackground: true, ...flags(['at']) })) as TaskData
    print(forked, () => `${forked.id}  ${forked.title}\n`)
    return 0
  }
  if (command === 'stop') {
    const session = named('stop')
    await act(session, 'abort', {})
    process.stdout.write(`Stopped the turn of session ${session}.\n`)
    return 0
  }
  if (command === 'end') {
    const session = named('end')
    await act(session, 'end', null)
    process.stdout.write(`Session ${session} ends once its turn ends.\n`)
    return 0
  }
  if (command === 'compact') {
    const session = named('compact')
    await act(session, 'compact', values['keep'] === undefined ? {} : { keep: values['keep'] })
    process.stdout.write(`Session ${session} compacts once its turn ends, and then carries on.\n`)
    return 0
  }
  if (command === 'delete') {
    const session = named('delete')
    await act(session, 'delete', null)
    process.stdout.write(`Deleted session ${session}.\n`)
    return 0
  }
  throw new Error(`cmod sessions takes list, search <text>, read <messages|turns|contexts|tasks|goal|usage|state> [<session>], send <session> <text>, start <prompt>, fork <prompt>, stop, end, compact, or delete <session>, follow <session>, or index.\n\n${help}`)
}

function readTranscripts(command: string, rest: readonly string[], values: Values, project: string, print: (value: unknown, lines: () => string) => void): number {
  const [part, ...named] = command === 'read' ? rest : []
  const folder = String(values['transcripts'])
  if (command !== 'read' || named.length !== 1) throw new Error('cmod sessions takes --transcripts only with read <part> <session>.')
  if (!existsSync(join(folder, 'projects'))) throw new Error(`${folder} holds no projects folder, so it is not a Claude Code folder.`)
  process.env['CLAUDE_CONFIG_DIR'] = resolve(folder)
  const session = named[0] as string
  const db = openHistory({ isInMemory: true })
  try {
    const task = typeof values['task'] === 'string' ? { task: values['task'] } : {}
    const lasts = values['last'] === undefined ? {} : { last: countOf('--last', String(values['last'])) }
    if (part === 'messages') {
      const messages = readMessages(db, { session, project, ...task, ...(typeof values['turn'] === 'string' ? { turn: values['turn'] } : {}), ...(typeof values['after'] === 'string' ? { after: values['after'] } : {}), ...lasts })
      print(messages, () => messages.map((message) => messageLine(message, false)).join(''))
    } else if (part === 'turns') {
      const turns = readTurns(db, { session, project, ...task, ...(values['context'] === undefined ? {} : { context: countOf('--context', String(values['context'])) }), ...lasts })
      print(turns, () => turns.map((turn) => `${localTime(turn.openedAt)}  ${turn.closedAt === undefined ? 'open  ' : localTime(turn.closedAt)}  ${firstLine(turn.prompt.text)}\n`).join(''))
    } else if (part === 'contexts') {
      const contexts = readContexts(db, { session, project, ...task })
      print(contexts, () => contexts.map((context) => `${context.number}  ${localTime(context.openedAt, true)}${context.closedAt === undefined ? '' : `  to ${localTime(context.closedAt, true)}`}\n`).join(''))
    } else if (part === 'tasks') {
      const tasks = readTasks(db, { session, project, ...task, ...(values['nested'] === true ? { isNested: true } : {}) })
      print(tasks, () => tasks.map(taskLine).join(''))
    } else if (part === 'goal') {
      const goal = readGoal(db, { session, project, ...task })
      print(goal, () => `${goal.text}\n`)
    } else if (part === 'usage') {
      const usage = readUsage({ session, project, ...task })
      print(usage, () => `${usage.model}  ${usage.contextWindow.tokenCount ?? 0} tokens\n`)
    } else if (part === 'state') process.stdout.write(`${JSON.stringify(readState(db, { session, project }))}\n`)
    else throw new Error(`cmod sessions read takes messages, turns, contexts, tasks, goal, usage, or state, not ${part ?? 'nothing'}.`)
    return 0
  } finally {
    db.close()
  }
}

async function readHere(command: string, rest: readonly string[], values: Values, project: string, print: (value: unknown, lines: () => string) => void): Promise<number> {
  const db = openHistory()
  try {
    if (command === 'read') {
      const session = rest[1] ?? process.env['CLAUDE_CODE_SESSION_ID']
      if (rest.length > 2 || session === undefined || session === '') throw new Error('cmod sessions read state takes a session id outside Claude Code. cmod sessions list lists them.')
      print(readState(db, { session, project }), () => `${JSON.stringify(readState(db, { session, project }))}\n`)
      return 0
    }
    if (command === 'follow' && (rest.length > 0 || values['running'] === true)) {
      const stop = new AbortController()
      process.once('SIGINT', () => stop.abort())
      process.once('SIGTERM', () => stop.abort())
      const following = followSessions(db, { sessions: rest, isEveryRunning: values['running'] === true }, project, (session, change, isInProject) => process.stdout.write(values['json'] === true ? `${JSON.stringify({ session, isInProject, change })}\n` : changeLine(session, change)), stop.signal)
      process.stderr.write(`Following ${[...rest, ...(values['running'] === true ? ['every running session of the project'] : [])].join(', ')}. Stop with Ctrl+C.\n`)
      await following
      return 0
    }
    if (command === 'index' && rest.length === 0) {
      const lock = await takeLock(storePath('history-index.lock'), AbortSignal.abort())
      if (lock === undefined) return 0
      try {
        const scope: Pick<Scope, 'project' | 'everyProject'> = { project, everyProject: true }
        readFolders(db, foldersIn(scope), true)
      } finally {
        await lock[Symbol.asyncDispose]()
      }
      return 0
    }
    throw new Error(`cmod sessions follow takes a session or --running.\n\n${help}`)
  } finally {
    db.close()
  }
}

function titleOf(values: Values, verb: string): string {
  const title = typeof values['title'] === 'string' ? values['title'].trim() : ''
  if (title === '') throw new Error(`cmod sessions ${verb} takes --title <title>, a few words that name the task.`)
  return title
}

function isSearchCall(message: SessionMessage): boolean {
  if (message.type !== ToolCall) return false
  if (message.name.endsWith('search_sessions')) return true
  const command = message.input['command']
  return message.name === 'Bash' && typeof command === 'string' && /\bcmod\s+(sessions|history)\s+search\b/.test(command)
}

function sessionLine(session: SessionData): string {
  const forked = session.forkedFrom === undefined ? '' : `  (forked from ${session.forkedFrom})`
  const state = !session.isRunning ? '' : session.waitingFor !== undefined ? `  waiting for ${session.waitingFor.dialog}` : `  ${session.status === 'busy' ? 'working' : 'running'}`
  const device = session.device === undefined ? '' : `  on ${session.device.name}`
  return `${localTime(session.lastAt, true)}  ${session.id}  ${session.title}${forked}${state}${device}\n`
}

function taskLine(task: TaskData): string {
  const owner = [task.agentType, task.isBackground === true ? 'background' : undefined, task.forkedFrom === undefined ? undefined : `forked from ${task.forkedFrom}`].filter((part) => part !== undefined).join(', ')
  return `${localTime(task.openedAt)}  ${task.closedAt === undefined ? 'open  ' : localTime(task.closedAt)}  ${task.id}  ${owner}  ${task.title}\n`
}

function localTime(at: string, withDate = false): string {
  const time = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}`
  return withDate ? `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${clock}` : clock
}

function senderWords(from: Sender): string {
  const name = from.name === undefined ? '' : ` ${from.name}`
  return `${from.type}${name}${from.as === Person ? ' as person' : ''}`
}

function messageLine(message: SessionMessage, withSession: boolean): string {
  const at = withSession ? `${localTime(message.at, true)}  ${message.session}` : localTime(message.at)
  return `${at}  ${message.id}  ${labelOf(message).padEnd(7)}  ${firstLine(lineText(message))}\n`
}

function foundLine(message: SessionMessage, text: string): string {
  return `${localTime(message.at, true)}  ${message.session}  ${message.id}  ${labelOf(message).padEnd(7)}  ${snippetOf(searchText(message), text)}\n`
}

function snippetOf(text: string, find: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const at = flat.toLowerCase().indexOf(find.toLowerCase())
  if (at === -1) return firstLine(flat)
  const start = Math.max(0, at - searchedChars.before)
  const end = Math.min(flat.length, at + find.length + searchedChars.after)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

function labelOf(message: SessionMessage): string {
  if (message.type === Prompt) return senderWords(message.from)
  if (message.type === Note) return `note ${senderWords(message.from)}`
  if (message.type === ToolResult) return message.isError ? '✗' : '→'
  if (message.type === Skill) return `skill ${message.name}`
  if (message.type === Reply || message.type === ToolCall) return 'claude'
  return message.type
}

function lineText(message: SessionMessage): string {
  if (message.type === ToolCall) return `${message.name}  ${JSON.stringify(message.input)}`
  if (message.type === InstructionFile) return message.path
  if (message.type === AttachedFile) return `${message.attachmentType}  ${message.path}`
  if (message.type === ToolResult) return typeof message.output === 'string' ? message.output : JSON.stringify(message.output)
  return message.text
}

function changeLine(session: string, change: SessionChange): string {
  if (change.type === Message) return messageLine(change.message, true)
  return `${session}  ${change.type}\n`
}

function firstLine(text: string): string {
  const line = text.split('\n').find((each) => each.trim() !== '')?.trim() ?? ''
  return line.length > 160 ? `${line.slice(0, 159)}…` : line
}

function countOf(flag: string, value: string): number {
  const count = Number(value)
  if (!Number.isInteger(count) || count < 1) throw new Error(`${flag} takes a whole number above 0, not ${value}.`)
  return count
}

function cursorOf(value: string): { session: string; id: string } {
  const split = value.indexOf(':')
  const session = value.slice(0, split)
  const id = value.slice(split + 1)
  if (split < 0 || session === '' || id === '') throw new Error(`--before takes <session>:<id>, the last message of the previous page, not ${value}.`)
  return { session, id }
}

function sinceOf(value: unknown): { readonly since?: string } {
  if (typeof value !== 'string') return {}
  const span = /^(\d+)([mhdw])$/.exec(value)
  if (span !== null) {
    const minutes = { m: 1, h: 60, d: 1440, w: 10_080 }[span[2] as 'm' | 'h' | 'd' | 'w'] * Number(span[1])
    return { since: new Date(Date.now() - minutes * 60_000).toISOString() }
  }
  if (Number.isNaN(Date.parse(value))) throw new Error(`--since takes 30m, 6h, 2d, 1w, or a date such as 2026-10-01, not ${value}.`)
  return { since: new Date(value).toISOString() }
}

