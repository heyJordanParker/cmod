import { parseArgs } from 'node:util'
import { Message, type Message as SessionMessage } from '@cmodjs/core/src/session/context/turn/message/message.js'
import { Document } from '@cmodjs/core/src/session/context/turn/message/document.js'
import { Note } from '@cmodjs/core/src/session/context/turn/message/note.js'
import { Prompt } from '@cmodjs/core/src/session/context/turn/message/prompt.js'
import { Person, type Sender } from '@cmodjs/core/src/session/context/turn/message/sender.js'
import { Reply } from '@cmodjs/core/src/session/context/turn/message/reply.js'
import { Skill } from '@cmodjs/core/src/session/context/turn/message/skill.js'
import { ToolCall } from '@cmodjs/core/src/session/context/turn/message/tool-call.js'
import { ToolResult } from '@cmodjs/core/src/session/context/turn/message/tool-result.js'
import type { SessionChange, SessionData } from '@cmodjs/core/src/session/conversation.js'
import { followSessions, foldersIn, listSessions, openHistory, readContexts, readFolders, readGoal, readMessages, readState, readTasks, readTurns, readUsage, searchMessages, type RecordScope, type Scope } from '../history.js'
import { storePath, takeLock } from '../store.js'

export const summary = 'Read every saved Claude Code conversation as sessions, turns, tasks, and messages.'

export const help = `Usage: cmod history sessions [--all] [--since 2d] [--running] [--project <folder>] [--json]
       cmod history search <text> [--all] [--since 2d] [--running] [--project <folder>] [--session <id> [--task <id>] [--turn <id>] [--context <n>] [--goal]] [--limit <n>] [--before <session>:<id>] [--json]
       cmod history messages [<session>] [--task <id>] [--turn <id>] [--after <id>] [--last <n>] [--json]
       cmod history turns [<session>] [--task <id>] [--context <n>] [--last <n>] [--json]
       cmod history contexts [<session>] [--task <id>] [--json]
       cmod history tasks [<session>] [--task <id> | --nested] [--json]
       cmod history goal [<session>] [--task <id>] [--json]
       cmod history usage [<session>] [--task <id>] [--json]
       cmod history state [<session>] [--json]
       cmod history follow [<session>...] [--running] [--json]
       cmod history index

${summary}

sessions lists the conversations of the project, newest first: the current
folder's, or --project's, and with --all every project's. --since keeps those
active in the last 30m, 6h, 2d, or 1w, or since a date such as 2026-10-01, and
--running keeps those open in Claude Code now.

search prints the newest 50 messages whose text or tool input contains the
text, at least 3 characters, after indexing every conversation it covers. Each
tool input value is searched in its first 1,024 characters, and tool results
are not searched. --all, --since, and --running scope it the way they scope
sessions, --limit changes the 50, and --before <session>:<id> starts after the
last message of the previous page. --session searches one conversation, and
inside it --task searches a task and the tasks it started, --turn one turn,
--context one context, and --goal the tasks of the conversation or of --task.

messages prints one conversation's messages in order: the session named, or the
conversation this command runs in when Claude Code sets CLAUDE_CODE_SESSION_ID.
That conversation has no messages until Claude Code saves its first one. --task
reads a task's messages instead, --turn keeps one turn's, --after starts after a
message id, and --last keeps that many from the end.

turns prints the conversation's turns, each opened by a prompt and closed when
Claude finishes. --context keeps one context's, and --last keeps that many from
the end. contexts prints the conversation's contexts, a new one after each
compaction. tasks prints the tasks the conversation started, with --task the
tasks that task started, and with --nested every task at any depth. goal prints
what the conversation is for: the goal a mod set, or its first prompt. usage
prints the model and the context's tokens as of the last reply. --task reads
turns, contexts, goal, and usage of the agent a task runs. state prints what a
running conversation resumes from.

follow prints each message, turn, context, task, and goal change of the
sessions named as Claude Code saves it, until stopped. With --running it
follows every running session of the project too, and each one that starts
later, except the session that runs it.

index indexes every saved conversation.`

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      all: { type: 'boolean', default: false },
      since: { type: 'string' },
      running: { type: 'boolean', default: false },
      project: { type: 'string' },
      session: { type: 'string' },
      task: { type: 'string' },
      goal: { type: 'boolean', default: false },
      nested: { type: 'boolean', default: false },
      turn: { type: 'string' },
      context: { type: 'string' },
      before: { type: 'string' },
      last: { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  })
  const [command, ...rest] = positionals
  const project = values.project ?? process.cwd()
  const scope: Scope = { project, everyProject: values.all, since: sinceOf(values.since), running: values.running }
  const sessionOf = () => {
    const session = rest[0] ?? process.env['CLAUDE_CODE_SESSION_ID']
    if (rest.length > 1 || session === undefined || session === '') throw new Error(`cmod history ${command} takes a session id outside Claude Code. cmod history sessions lists them.`)
    return session
  }
  const print = (value: unknown, lines: () => string) => process.stdout.write(values.json ? `${JSON.stringify(value)}\n` : lines())
  const db = openHistory()
  try {
    if (command === 'sessions' && rest.length === 0) {
      const sessions = listSessions(db, scope)
      print(sessions, () => sessions.map(sessionLine).join(''))
      return 0
    }
    if (command === 'search' && rest.length === 1) {
      const record: RecordScope = {
        ...(values.session === undefined ? {} : { session: values.session }),
        ...(values.task === undefined ? {} : { task: values.task }),
        ...(values.turn === undefined ? {} : { turn: values.turn }),
        ...(values.context === undefined ? {} : { context: countOf('--context', values.context) }),
        ...(values.goal ? { isGoal: true } : {}),
      }
      if (record.session === undefined && Object.keys(record).length > 0) throw new Error('cmod history search takes --task, --turn, --context, and --goal only with --session.')
      const found = searchMessages(db, rest[0] as string, {
        ...scope,
        ...(values.limit === undefined ? {} : { limit: countOf('--limit', values.limit) }),
        ...(values.before === undefined ? {} : { before: cursorOf(values.before) }),
        record,
      })
      print(found, () => found.map((message) => messageLine(message, true)).join(''))
      return 0
    }
    if (command === 'messages') {
      const messages = readMessages(db, {
        session: sessionOf(),
        project,
        ...(values.task === undefined ? {} : { task: values.task }),
        ...(values.turn === undefined ? {} : { turn: values.turn }),
        ...(values.after === undefined ? {} : { after: values.after }),
        ...(values.last === undefined ? {} : { last: countOf('--last', values.last) }),
      })
      print(messages, () => messages.map((message) => messageLine(message, false)).join(''))
      return 0
    }
    const task = values.task === undefined ? {} : { task: values.task }
    if (command === 'turns') {
      const turns = readTurns(db, { session: sessionOf(), project, ...task, ...(values.context === undefined ? {} : { context: countOf('--context', values.context) }), ...(values.last === undefined ? {} : { last: countOf('--last', values.last) }) })
      print(turns, () => turns.map((turn) => `${localTime(turn.openedAt)}  ${turn.closedAt === undefined ? 'open  ' : localTime(turn.closedAt)}  ${firstLine(turn.prompt.text)}\n`).join(''))
      return 0
    }
    if (command === 'contexts') {
      const contexts = readContexts(db, { session: sessionOf(), project, ...task })
      print(contexts, () => contexts.map((context) => `${context.number}  ${localTime(context.openedAt, true)}${context.closedAt === undefined ? '' : `  to ${localTime(context.closedAt, true)}`}\n`).join(''))
      return 0
    }
    if (command === 'tasks') {
      const tasks = readTasks(db, { session: sessionOf(), project, ...task, ...(values.nested ? { isNested: true } : {}) })
      print(tasks, () => tasks.map((task) => `${localTime(task.openedAt)}  ${task.closedAt === undefined ? 'open  ' : localTime(task.closedAt)}  ${task.id}  ${task.agentType}  ${task.title}\n`).join(''))
      return 0
    }
    if (command === 'goal') {
      const goal = readGoal(db, { session: sessionOf(), project, ...task })
      print(goal, () => `${goal.text}\n`)
      return 0
    }
    if (command === 'usage') {
      const usage = readUsage({ session: sessionOf(), project, ...task })
      print(usage, () => `${usage.model}  ${usage.context.tokens ?? 0} tokens\n`)
      return 0
    }
    if (command === 'state') {
      const state = readState(db, { session: sessionOf(), project })
      process.stdout.write(`${JSON.stringify(state)}\n`)
      return 0
    }
    if (command === 'follow' && (rest.length > 0 || values.running)) {
      const stop = new AbortController()
      process.once('SIGINT', () => stop.abort())
      process.once('SIGTERM', () => stop.abort())
      const following = followSessions(db, { sessions: rest, isEveryRunning: values.running }, project, (session, change, isInProject) => process.stdout.write(values.json ? `${JSON.stringify({ session, isInProject, change })}\n` : changeLine(session, change)), stop.signal)
      process.stderr.write(`Following ${[...rest, ...(values.running ? ['every running session of the project'] : [])].join(', ')}. Stop with Ctrl+C.\n`)
      await following
      return 0
    }
    if (command === 'index' && rest.length === 0) {
      const lock = await takeLock(storePath('history-index.lock'), AbortSignal.abort())
      if (lock === undefined) return 0
      try {
        readFolders(db, foldersIn({ project, everyProject: true }), true)
      } finally {
        await lock[Symbol.asyncDispose]()
      }
      return 0
    }
    throw new Error(`cmod history takes sessions, search <text>, messages, turns, contexts, tasks, goal, usage, state, follow <session>, or index.\n\n${help}`)
  } finally {
    db.close()
  }
}

function sessionLine(session: SessionData): string {
  const forked = session.forkedFrom === undefined ? '' : `  (forked from ${session.forkedFrom})`
  const running = session.isRunning ? '  running' : ''
  return `${localTime(session.lastAt, true)}  ${session.id}  ${session.title}${forked}${running}\n`
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
  return `${at}  ${labelOf(message).padEnd(7)}  ${firstLine(lineText(message))}\n`
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
  if (message.type === Document) return message.path
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

function sinceOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const span = /^(\d+)([mhdw])$/.exec(value)
  if (span !== null) {
    const minutes = { m: 1, h: 60, d: 1440, w: 10_080 }[span[2] as 'm' | 'h' | 'd' | 'w'] * Number(span[1])
    return new Date(Date.now() - minutes * 60_000).toISOString()
  }
  if (Number.isNaN(Date.parse(value))) throw new Error(`--since takes 30m, 6h, 2d, 1w, or a date such as 2026-10-01, not ${value}.`)
  return new Date(value).toISOString()
}
