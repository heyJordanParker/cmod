import { parseArgs } from 'node:util'
import type { Message, Session } from '@cmodjs/core/src/history.js'
import { foldersIn, listSessions, openHistory, readFolders, readMessages, searchMessages, type Scope } from '../history.js'
import { storePath, takeLock } from '../store.js'

export const summary = 'Read every saved Claude Code conversation as sessions and messages.'

export const help = `Usage: cmod history sessions [--all] [--since 2d] [--project <folder>] [--json]
       cmod history messages [<session>] [--agent <id>] [--last <n>] [--after <id>] [--limit <n>] [--follow] [--json]
       cmod history search <text> [--all] [--since 2d] [--project <folder>] [--json]
       cmod history index

${summary}

sessions lists the conversations of the project, newest first: the current
folder's, or --project's, and with --all every project's. --since keeps those
active in the last 30m, 6h, 2d, or 1w, or since a date such as 2026-10-01.

messages prints one conversation's messages in order: the session named, or the
conversation this command runs in when Claude Code sets CLAUDE_CODE_SESSION_ID.
That conversation has no messages until Claude Code saves its first one.
--agent reads one of its subagents' conversations, --last starts that many
messages from the end, --after starts after a message id, --limit stops after
that many messages, and --follow keeps printing new messages as they are saved.

search prints every message whose text or tool input contains the text, newest
first, after indexing every conversation it covers. --all and --since scope it
the way they scope sessions.

index indexes every saved conversation, and the cmod plugin runs it in the
background at each session's start.`

const followMs = 250

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      all: { type: 'boolean', default: false },
      since: { type: 'string' },
      project: { type: 'string' },
      agent: { type: 'string' },
      last: { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
      follow: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  })
  const [command, ...rest] = positionals
  const scope: Scope = { project: values.project ?? process.cwd(), everyProject: values.all, since: sinceOf(values.since) }
  const db = openHistory()
  try {
    if (command === 'sessions' && rest.length === 0) {
      const sessions = listSessions(db, scope)
      process.stdout.write(values.json ? `${JSON.stringify(sessions)}\n` : sessions.map(sessionLine).join(''))
      return 0
    }
    if (command === 'search' && rest.length === 1) {
      const found = searchMessages(db, rest[0] as string, scope)
      process.stdout.write(values.json ? `${JSON.stringify(found)}\n` : found.map((message) => messageLine(message, true)).join(''))
      return 0
    }
    if (command === 'messages' && rest.length <= 1) {
      const session = rest[0] ?? process.env['CLAUDE_CODE_SESSION_ID']
      if (session === undefined || session === '') throw new Error('cmod history messages takes a session id outside Claude Code. cmod history sessions lists them.')
      const request = { session, project: scope.project, ...(values.agent === undefined ? {} : { agent: values.agent }), ...(values.after === undefined ? {} : { after: values.after }), ...(values.limit === undefined ? {} : { limit: countOf('--limit', values.limit) }) }
      const messages = readMessages(db, { ...request, ...(values.last === undefined ? {} : { last: countOf('--last', values.last) }) })
      process.stdout.write(values.json ? `${JSON.stringify(messages)}\n` : messages.map((message) => messageLine(message, false)).join(''))
      if (values.follow) await follow(db, request, messages.at(-1)?.id ?? values.after, values.json)
      return 0
    }
    if (command === 'index' && rest.length === 0) {
      const lock = await takeLock(storePath('history-index.lock'), AbortSignal.abort())
      if (lock === undefined) return 0
      try {
        readFolders(db, foldersIn({ project: scope.project, everyProject: true }), true)
      } finally {
        await lock[Symbol.asyncDispose]()
      }
      return 0
    }
    throw new Error(`cmod history takes sessions, messages [session], search <text>, or index.\n\n${help}`)
  } finally {
    db.close()
  }
}

async function follow(db: ReturnType<typeof openHistory>, request: Parameters<typeof readMessages>[1], from: string | undefined, asJson: boolean): Promise<void> {
  let after = from
  const stop = new AbortController()
  process.once('SIGINT', () => stop.abort())
  process.once('SIGTERM', () => stop.abort())
  while (!stop.signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, followMs))
    const messages = readMessages(db, { ...request, ...(after === undefined ? {} : { after }) })
    if (messages.length === 0) continue
    after = messages.at(-1)?.id
    process.stdout.write(asJson ? `${JSON.stringify(messages)}\n` : messages.map((message) => messageLine(message, false)).join(''))
  }
}

function sessionLine(session: Session): string {
  const forked = session.forkedFrom === undefined ? '' : `  (forked from ${session.forkedFrom})`
  return `${localTime(session.lastAt, true)}  ${session.id}  ${session.title}${forked}\n`
}

function localTime(at: string, withDate = false): string {
  const time = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}`
  return withDate ? `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${clock}` : clock
}

function messageLine(message: Message, withSession: boolean): string {
  const at = withSession ? `${localTime(message.at, true)}  ${message.session}` : localTime(message.at)
  const from = message.from.kind === 'mod' || message.from.kind === 'channel' ? `${message.from.kind} ${message.from.name}` : message.from.kind === 'claude-code' ? `claude-code ${message.from.reason}` : message.from.kind
  const lines = message.text === '' ? [] : [`${at}  ${from.padEnd(7)}  ${firstLine(message.text)}`]
  for (const tool of message.tools) {
    const outcome = tool.result === undefined ? '' : tool.isError === true ? `  ✗ ${firstLine(tool.result)}` : `  → ${firstLine(tool.result)}`
    lines.push(`${at}  ${from.padEnd(7)}  ${tool.tool}  ${firstLine(JSON.stringify(tool.input))}${outcome}`)
  }
  return lines.map((line) => `${line}\n`).join('')
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
