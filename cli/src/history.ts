import { Database } from 'bun:sqlite'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Message, Sender, Session } from '@cmodjs/core/src/history.js'
import { isObject } from '@cmodjs/core/src/records.js'
import { configRoot } from './settings.js'
import { storePath } from './store.js'

type Row = Readonly<Record<string, unknown>>

type Tool = Message['tools'][number]

type Transcript = { readonly path: string; readonly folder: string; readonly session: string; readonly agent: string | undefined }

type ResultPlace = { readonly id: string; readonly file: string; readonly offset: number; readonly length: number }

export type Scope = { readonly project: string; readonly everyProject: boolean; readonly since: string | undefined }

const schema = `
create table if not exists files (path text primary key, session text not null, agent text, offset integer not null);
create table if not exists sessions (id text primary key, folder text not null, project text not null default '', title text not null default '', custom_title text, started_at text not null default '', last_at text not null default '', branched_from text);
create table if not exists messages (id text not null, session text not null, agent text not null default '', at text not null, message text not null);
create index if not exists messages_by_id on messages (id);
create index if not exists messages_by_session on messages (session, agent);
create table if not exists tool_uses (session text not null, agent text not null, id text not null, message integer not null, file text, offset integer, length integer, primary key (session, agent, id));
create virtual table if not exists message_text using fts5 (text, tokenize = 'trigram');
`

const headBytes = 65_536

const skillPrefix = 'Base directory for this skill:'

const personOrigins: readonly string[] = ['human', 'composer', 'bridge', 'slack-ping', 'auto-continuation']

const sessionOrigins: readonly string[] = ['peer', 'peer-send-message', 'coordinator', 'projects-relay', 'observer', 'observer-activity']

const wantedRows: readonly string[] = ['"type":"user"', '"type":"assistant"', '"type":"custom-title"', '"nested_memory"', '"forkedFrom"']

export function openHistory(): Database {
  mkdirSync(storePath(), { recursive: true })
  const db = new Database(storePath('history.sqlite'), { create: true })
  db.exec('pragma busy_timeout = 120000')
  db.exec('pragma journal_mode = wal')
  db.exec(schema)
  return db
}

export function projectsFolder(): string {
  return join(configRoot(), 'projects')
}

export function folderOf(project: string): string {
  return join(projectsFolder(), project.replace(/[^A-Za-z0-9]/g, '-'))
}

export function foldersIn(scope: Pick<Scope, 'project' | 'everyProject'>): string[] {
  if (!scope.everyProject) return [folderOf(scope.project)]
  return existsSync(projectsFolder()) ? readdirSync(projectsFolder(), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(projectsFolder(), entry.name)) : []
}

function mainTranscripts(folder: string): Transcript[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => ({ path: join(folder, name), folder, session: name.slice(0, -'.jsonl'.length), agent: undefined }))
}

function agentTranscripts(main: Transcript): Transcript[] {
  const subagents = join(main.folder, main.session, 'subagents')
  if (!existsSync(subagents)) return []
  return readdirSync(subagents).flatMap((name) => {
    const agent = /^agent-(.+)\.jsonl$/.exec(name)?.[1]
    return agent === undefined ? [] : [{ path: join(subagents, name), folder: main.folder, session: main.session, agent }]
  })
}

export function sessionTranscripts(session: string, project: string): Transcript[] {
  const preferred = folderOf(project)
  const folders = [preferred, ...foldersIn({ project, everyProject: true }).filter((folder) => folder !== preferred)]
  const folder = folders.find((each) => existsSync(join(each, `${session}.jsonl`)))
  if (folder === undefined && session === process.env['CLAUDE_CODE_SESSION_ID']) return []
  if (folder === undefined) throw new Error(`No Claude Code transcript is named ${session}.jsonl under ${projectsFolder()}. cmod history sessions --all lists the sessions.`)
  const main = { path: join(folder, `${session}.jsonl`), folder, session, agent: undefined }
  return [main, ...agentTranscripts(main)]
}

export function readFolders(db: Database, folders: readonly string[], fully: boolean): void {
  forgetDeleted(db, folders)
  const mains = folders.flatMap(mainTranscripts).map((main) => ({ main, changedAt: statSync(main.path).mtimeMs }))
  for (const { main } of mains.sort((first, second) => first.changedAt - second.changedAt)) {
    const isKnown = db.query('select 1 from files where path = ?').get(main.path) !== null
    if (fully || isKnown) readTranscripts(db, [main, ...agentTranscripts(main)])
    else summarize(db, main)
  }
}

export function readTranscripts(db: Database, transcripts: readonly Transcript[]): void {
  for (const transcript of transcripts) readTranscript(db, transcript)
}

function readTranscript(db: Database, transcript: Transcript): void {
  const size = existsSync(transcript.path) ? statSync(transcript.path).size : 0
  db.transaction(() => {
    const known = db.query<{ offset: number }, [string]>('select offset from files where path = ?').get(transcript.path)
    let offset = known?.offset ?? 0
    if (size < offset) {
      forgetFile(db, transcript)
      offset = 0
    }
    if (size === offset) return
    const bytes = readBytes(transcript.path, offset, size)
    const end = bytes.lastIndexOf(10)
    if (end < 0) return
    if (transcript.agent === undefined) ensureSession(db, transcript)
    let start = 0
    while (start <= end) {
      const stop = bytes.indexOf(10, start)
      if (stop - start > 1) readLine(db, transcript, bytes.subarray(start, stop).toString('utf8'), offset + start, stop - start)
      start = stop + 1
    }
    if (offset === 0 && transcript.agent !== undefined) linkAgent(db, transcript)
    db.query('insert into files (path, session, agent, offset) values (?, ?, ?, ?) on conflict (path) do update set offset = excluded.offset').run(transcript.path, transcript.session, transcript.agent ?? null, offset + end + 1)
  }).immediate()
}

function readLine(db: Database, transcript: Transcript, line: string, offset: number, length: number): void {
  if (line.includes('"type":"tool_result"') && line.includes('"type":"user"')) {
    for (const id of new Set([...line.matchAll(/"tool_use_id":"([^"\\]+)"/g)].map((match) => match[1] as string))) {
      db.query('update tool_uses set file = ?, offset = ?, length = ? where session = ? and agent = ? and id = ?').run(transcript.path, offset, length, transcript.session, transcript.agent ?? '', id)
    }
    return
  }
  if (!wantedRows.some((marker) => line.includes(marker))) return
  const row = parsedRow(line)
  if (row !== undefined) applyRow(db, transcript, row)
}

function summarize(db: Database, main: Transcript): void {
  const size = statSync(main.path).size
  const head = readBytes(main.path, 0, Math.min(size, headBytes)).toString('utf8')
  const tail = size > headBytes ? readBytes(main.path, size - headBytes, size).toString('utf8') : ''
  db.transaction(() => {
    ensureSession(db, main)
    for (const line of [...head.split('\n'), ...tail.split('\n').slice(1)]) {
      const row = line.trim() === '' ? undefined : parsedRow(line)
      if (row !== undefined) summarizeRow(db, main.session, row)
    }
  }).immediate()
}

function summarizeRow(db: Database, session: string, row: Row): void {
  const at = typeof row['timestamp'] === 'string' ? row['timestamp'] : undefined
  if (at !== undefined) db.query("update sessions set started_at = case when started_at = '' or started_at > ?1 then ?1 else started_at end, last_at = case when last_at < ?1 then ?1 else last_at end where id = ?2").run(at, session)
  if (typeof row['cwd'] === 'string') db.query("update sessions set project = ? where id = ? and project = ''").run(row['cwd'], session)
  if (row['type'] === 'custom-title' && typeof row['customTitle'] === 'string') db.query('update sessions set custom_title = ? where id = ?').run(row['customTitle'], session)
  const branched = isObject(row['forkedFrom']) ? row['forkedFrom']['sessionId'] : undefined
  if (typeof branched === 'string' && branched !== session) db.query('update sessions set branched_from = ? where id = ?').run(branched, session)
  if (row['type'] === 'user' && row['isMeta'] !== true && ['person', 'unknown'].includes(senderOf(row['origin'], false).kind)) {
    const text = promptText(contentText(messageOf(row)['content']))
    if (text !== undefined) db.query("update sessions set title = ? where id = ? and title = ''").run(firstLine(text), session)
  }
}

function applyRow(db: Database, transcript: Transcript, row: Row): void {
  if (transcript.agent === undefined) summarizeRow(db, transcript.session, row)
  const id = typeof row['uuid'] === 'string' ? row['uuid'] : undefined
  const at = typeof row['timestamp'] === 'string' ? row['timestamp'] : undefined
  if (id === undefined || at === undefined) return
  const base = { id, session: transcript.session, ...(transcript.agent === undefined ? {} : { agent: transcript.agent }), at }
  if (row['type'] === 'attachment') {
    const attachment = isObject(row['attachment']) ? row['attachment'] : {}
    if (attachment['type'] !== 'nested_memory' || typeof attachment['path'] !== 'string') return
    addMessage(db, { ...base, from: { kind: 'claude-code', reason: 'instructions', name: attachment['path'] }, text: typeof attachment['content'] === 'string' ? attachment['content'] : '', tools: [] })
    return
  }
  const content = messageOf(row)['content']
  if (row['type'] === 'assistant') {
    addReply(db, transcript, base, Array.isArray(content) ? content.filter(isObject) : [])
    return
  }
  if (row['type'] !== 'user') return
  const text = contentText(content).trim()
  if (row['isCompactSummary'] === true) {
    addMessage(db, { ...base, from: { kind: 'claude-code', reason: 'compaction' }, text, tools: [] })
    return
  }
  if (text.startsWith(skillPrefix)) {
    const folder = text.slice(skillPrefix.length).split('\n')[0]?.trim() ?? ''
    addMessage(db, { ...base, from: { kind: 'claude-code', reason: 'skill', name: basename(folder) }, text, tools: [] })
    return
  }
  if (row['isMeta'] === true || text === '') return
  if (text.startsWith('<task-notification')) {
    addMessage(db, { ...base, from: { kind: 'claude-code', reason: 'notification' }, text: tagOf(text, 'summary') ?? text, tools: [] })
    return
  }
  const prompt = promptText(text)
  if (prompt !== undefined) addMessage(db, { ...base, from: senderOf(row['origin'], transcript.agent !== undefined), text: prompt, tools: [] })
}

function addReply(db: Database, transcript: Transcript, base: Pick<Message, 'id' | 'session' | 'agent' | 'at'>, blocks: readonly Row[]): void {
  const text = blocks.flatMap((block) => (block['type'] === 'text' && typeof block['text'] === 'string' ? [block['text']] : [])).join('\n').trim()
  const tools = blocks.flatMap((block): Tool[] =>
    block['type'] === 'tool_use' && typeof block['id'] === 'string' && typeof block['name'] === 'string'
      ? [{ tool: block['name'], input: isObject(block['input']) ? block['input'] : {}, ...(transcript.agent === undefined ? {} : { agentId: transcript.agent }), id: block['id'] }]
      : [],
  )
  if (text === '' && tools.length === 0) return
  const rowid = addMessage(db, { ...base, from: { kind: 'claude' }, text, tools })
  for (const tool of tools) db.query('insert or replace into tool_uses (session, agent, id, message) values (?, ?, ?, ?)').run(transcript.session, transcript.agent ?? '', tool.id, rowid)
}

function linkAgent(db: Database, transcript: Transcript): void {
  const metaPath = transcript.path.replace(/\.jsonl$/, '.meta.json')
  if (!existsSync(metaPath) || transcript.agent === undefined) return
  const meta: unknown = JSON.parse(readFileSync(metaPath, 'utf8'))
  const toolUseId = isObject(meta) ? meta['toolUseId'] : undefined
  if (typeof toolUseId !== 'string') return
  const found = db.query<{ message: number }, [string, string]>("select message from tool_uses where session = ? and agent = '' and id = ?").get(transcript.session, toolUseId)
  const stored = found === null ? null : db.query<{ message: string }, [number]>('select message from messages where rowid = ?').get(found.message)
  if (found === null || stored === null) return
  const message = JSON.parse(stored.message) as Message
  const tools = message.tools.map((tool) => (tool.id === toolUseId ? { ...tool, subagent: transcript.agent } : tool))
  db.query('update messages set message = ? where rowid = ?').run(JSON.stringify({ ...message, tools }), found.message)
}

function addMessage(db: Database, message: Message): number {
  const added = db.query('insert into messages (id, session, agent, at, message) values (?, ?, ?, ?, ?)').run(message.id, message.session, message.agent ?? '', message.at, JSON.stringify(message))
  const rowid = Number(added.lastInsertRowid)
  db.query('insert into message_text (rowid, text) values (?, ?)').run(rowid, [message.text, ...message.tools.map((tool) => JSON.stringify(tool.input))].join('\n'))
  return rowid
}

function ensureSession(db: Database, main: Transcript): void {
  db.query('insert into sessions (id, folder) values (?, ?) on conflict (id) do nothing').run(main.session, main.folder)
}

function forgetDeleted(db: Database, folders: readonly string[]): void {
  for (const folder of folders) {
    const files = db.query<{ path: string; session: string; agent: string | null }, [string]>("select path, session, agent from files where path like ? escape '\\'").all(`${likeText(folder)}/%`)
    for (const file of files) if (!existsSync(file.path)) forgetFile(db, { path: file.path, folder, session: file.session, agent: file.agent ?? undefined })
    const sessions = db.query<{ id: string }, [string]>('select id from sessions where folder = ?').all(folder)
    for (const session of sessions) if (!existsSync(join(folder, `${session.id}.jsonl`))) db.query('delete from sessions where id = ?').run(session.id)
  }
}

function forgetFile(db: Database, transcript: Transcript): void {
  const agent = transcript.agent ?? ''
  db.query('delete from message_text where rowid in (select rowid from messages where session = ? and agent = ?)').run(transcript.session, agent)
  db.query('delete from messages where session = ? and agent = ?').run(transcript.session, agent)
  db.query('delete from tool_uses where session = ? and agent = ?').run(transcript.session, agent)
  db.query('delete from files where path = ?').run(transcript.path)
}

export function listSessions(db: Database, scope: Scope): Session[] {
  const folders = foldersIn(scope)
  readFolders(db, folders, false)
  const rows = db
    .query<{ id: string; project: string; title: string; custom_title: string | null; started_at: string; last_at: string; branched_from: string | null }, string[]>(
      `select id, project, title, custom_title, started_at, last_at, branched_from from sessions where folder in (${folders.map(() => '?').join(', ')}) and last_at >= ? order by last_at desc`,
    )
    .all(...folders, scope.since ?? '')
  return rows.map((row) => {
    const forkedFrom = row.branched_from ?? parentOf(db, row.id, row.started_at)
    return { id: row.id, title: row.custom_title ?? row.title, project: row.project, startedAt: row.started_at, lastAt: row.last_at, ...(forkedFrom === undefined ? {} : { forkedFrom }) }
  })
}

function parentOf(db: Database, session: string, startedAt: string): string | undefined {
  const found = db
    .query<{ session: string }, [string, string]>(
      `select other.session from messages own
       join messages other on other.id = own.id and other.session != own.session and other.agent = ''
       join sessions parent on parent.id = other.session
       where own.session = ? and own.agent = '' and parent.started_at < ?
       order by own.rowid desc, parent.started_at asc limit 1`,
    )
    .get(session, startedAt)
  return found?.session
}

export function readMessages(db: Database, request: { readonly session: string; readonly project: string; readonly agent?: string; readonly after?: string; readonly last?: number; readonly limit?: number }): Message[] {
  readTranscripts(db, sessionTranscripts(request.session, request.project))
  const agent = request.agent ?? ''
  const after = request.after === undefined ? 0 : (db.query<{ rowid: number }, [string, string, string]>('select rowid from messages where session = ? and agent = ? and id = ?').get(request.session, agent, request.after)?.rowid ?? Number.POSITIVE_INFINITY)
  const rows =
    request.last === undefined
      ? db.query<{ message: string }, [string, string, number, number]>('select message from messages where session = ? and agent = ? and rowid > ? order by rowid limit ?').all(request.session, agent, after, request.limit ?? -1)
      : db.query<{ message: string }, [string, string, number, number]>('select message from (select rowid, message from messages where session = ? and agent = ? and rowid > ? order by rowid desc limit ?) order by rowid').all(request.session, agent, after, request.last)
  return withResults(db, rows.map((row) => JSON.parse(row.message) as Message))
}

export function searchMessages(db: Database, text: string, scope: Scope): Message[] {
  const folders = foldersIn(scope)
  readFolders(db, folders, true)
  const rows = db
    .query<{ message: string }, string[]>(
      `select messages.message from message_text
       join messages on messages.rowid = message_text.rowid
       join sessions on sessions.id = messages.session
       where message_text.text like ? escape '\\' and sessions.folder in (${folders.map(() => '?').join(', ')}) and messages.at >= ?
       order by messages.at desc`,
    )
    .all(`%${likeText(text)}%`, ...folders, scope.since ?? '')
  return withResults(db, rows.map((row) => JSON.parse(row.message) as Message))
}

function withResults(db: Database, messages: readonly Message[]): Message[] {
  const placeOf = db.query<ResultPlace, [string, string, string]>('select id, file, offset, length from tool_uses where session = ? and agent = ? and id = ? and file is not null')
  const rows = new Map<string, Row | undefined>()
  return messages.map((message) => {
    if (message.tools.length === 0) return message
    const tools = message.tools.map((tool) => {
      const place = placeOf.get(message.session, message.agent ?? '', tool.id)
      if (place === null) return tool
      const key = `${place.file}:${place.offset}`
      if (!rows.has(key)) rows.set(key, existsSync(place.file) ? parsedRow(readBytes(place.file, place.offset, place.offset + place.length).toString('utf8')) : undefined)
      const content = messageOf(rows.get(key) ?? {})['content']
      const block = Array.isArray(content) ? content.filter(isObject).find((each) => each['type'] === 'tool_result' && each['tool_use_id'] === tool.id) : undefined
      if (block === undefined) return tool
      return { ...tool, result: fullResult(contentText(block['content'])), ...(block['is_error'] === true ? { isError: true } : {}) }
    })
    return { ...message, tools }
  })
}

function senderOf(origin: unknown, isAgentPrompt: boolean): Sender {
  const kind = isObject(origin) && typeof origin['kind'] === 'string' ? origin['kind'] : undefined
  if (kind === undefined) return isAgentPrompt ? { kind: 'agent' } : { kind: 'unknown' }
  if (personOrigins.includes(kind)) return { kind: 'person' }
  if (sessionOrigins.includes(kind)) return { kind: 'session' }
  if (kind === 'plugin' && isObject(origin) && typeof origin['name'] === 'string') return { kind: 'mod', name: origin['name'] }
  if (kind === 'scheduled-trigger') return { kind: 'schedule' }
  if (kind === 'channel' && isObject(origin) && typeof origin['server'] === 'string') return { kind: 'channel', name: origin['server'] }
  if (kind === 'sdk') return { kind: 'sdk' }
  if (kind === 'task-notification') return { kind: 'claude-code', reason: 'notification' }
  return { kind: 'unknown' }
}

function promptText(text: string): string | undefined {
  if (text.startsWith('<local-command-') || text.startsWith('<bash-stdout') || text.startsWith('<bash-stderr')) return undefined
  const command = tagOf(text, 'command-name')
  if (command === undefined) return text
  const args = tagOf(text, 'command-args') ?? ''
  return args === '' ? command : `${command} ${args}`
}

function fullResult(text: string): string {
  const saved = /<persisted-output>[\s\S]*?Full output saved to: (\S+)/.exec(text)?.[1]
  return saved !== undefined && existsSync(saved) ? readFileSync(saved, 'utf8') : text
}

function messageOf(row: Row): Row {
  return isObject(row['message']) ? row['message'] : {}
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => (isObject(block) && block['type'] === 'text' && typeof block['text'] === 'string' ? [block['text']] : [])).join('\n')
}

function tagOf(text: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim()
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
}

function parsedRow(line: string): Row | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return isObject(value) ? value : undefined
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

function readBytes(path: string, from: number, to: number): Buffer {
  const buffer = Buffer.alloc(to - from)
  const descriptor = openSync(path, 'r')
  try {
    readSync(descriptor, buffer, 0, buffer.length, from)
  } finally {
    closeSync(descriptor)
  }
  return buffer
}

function likeText(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`)
}
