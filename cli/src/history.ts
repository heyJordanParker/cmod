import { Database } from 'bun:sqlite'
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { searchLimit, searchText, type Message, type Sender, type Session } from '@cmodjs/core/src/history.js'
import { isAtLeast, isObject } from '@cmodjs/core/src/records.js'
import { configRoot } from './settings.js'
import { storePath } from './store.js'

type Row = Readonly<Record<string, unknown>>

type Tool = Message['tools'][number]

type Transcript = { readonly path: string; readonly folder: string; readonly session: string; readonly agent: string | undefined }

type Line = { readonly bytes: Buffer; readonly offset: number; readonly length: number }

type Place = { readonly row: number; readonly id: string; readonly session: string; readonly agent: string; readonly file: number; readonly offset: number; readonly length: number }

type Summary = { startedAt: string; lastAt: string; project: string; title: string; customTitle: string | null; forkedFrom: string | null; isPrompted: number }

export type Scope = { readonly project: string; readonly everyProject: boolean; readonly since: string | undefined }

const schema = `
create table files (id integer primary key, path text not null unique, session text not null, agent text not null, offset integer not null);
create table sessions (id text primary key, folder text not null, project text not null default '', title text not null default '', custom_title text, started_at text not null default '', last_at text not null default '', forked_from text, is_prompted integer not null default 0, is_fork_checked integer not null default 0, summarized_size integer);
create table folders (id integer primary key, path text not null unique);
create table messages (row integer primary key, id text not null, session text not null, agent text not null, folder integer not null, at text not null, file integer not null, offset integer not null, length integer not null, seq integer, unique (file, offset));
create index messages_by_id on messages (id);
create index messages_by_agent on messages (session, agent, seq);
create index messages_by_session on messages (session, seq);
create index messages_by_time on messages (at);
create index messages_by_folder on messages (folder, at);
create table tool_uses (session text not null, agent text not null, id text not null, file integer, offset integer, length integer, subagent text, primary key (session, agent, id));
create virtual table message_text using fts5 (text, tokenize = 'trigram', content = '', contentless_delete = 1);
`

const chunkBytes = 65_536

const tailBytes = 65_536

const batchRows = 2000

const sortedMatches = 20_000

const skillPrefix = 'Base directory for this skill:'

const personOrigins: readonly string[] = ['human', 'composer', 'bridge', 'slack-ping', 'auto-continuation']

const sessionOrigins: readonly string[] = ['peer', 'peer-send-message', 'coordinator', 'projects-relay', 'observer', 'observer-activity']

const wantedRows: readonly string[] = ['"type":"user"', '"type":"assistant"', '"type":"custom-title"', '"nested_memory"', '"forkedFrom"']

export function openHistory(): Database {
  mkdirSync(storePath(), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) rmSync(storePath(`history.sqlite${suffix}`), { force: true })
  const path = storePath('history-2.sqlite')
  if (!existsSync(path)) createIndex(path)
  const db = new Database(path)
  db.exec('pragma busy_timeout = 120000')
  db.exec('pragma synchronous = normal')
  return db
}

function createIndex(path: string): void {
  const made = `${path}.${process.pid}.tmp`
  const fresh = new Database(made, { create: true })
  try {
    const asked = fresh.prepare<{ version: string }, []>('select sqlite_version() as version')
    const version = asked.get()?.version ?? ''
    asked.finalize()
    if (!isAtLeast(version, '3.43.0')) throw new Error(`cmod history needs SQLite 3.43 or later, and this system has ${version}.`)
    fresh.exec('pragma journal_mode = wal')
    fresh.exec(schema)
  } finally {
    fresh.close(true)
  }
  try {
    linkSync(made, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${made}${suffix}`, { force: true })
  }
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
  forgetDeleted(db)
  const offsets = offsetsOf(db)
  const mains = folders.flatMap(mainTranscripts).map((main) => ({ main, stat: statSync(main.path) }))
  for (const { main, stat } of mains.sort((first, second) => first.stat.mtimeMs - second.stat.mtimeMs)) {
    if (fully || offsets.has(main.path)) readSession(db, [main, ...agentTranscripts(main)], offsets)
    else summarize(db, main, stat.size)
  }
  if (fully && folders.length > 0) checkForks(db, folders)
}

function offsetsOf(db: Database): Map<string, number> {
  return new Map(db.query<{ path: string; offset: number }, []>('select path, offset from files').all().map((file) => [file.path, file.offset]))
}

export function readSession(db: Database, transcripts: readonly Transcript[], offsets: ReadonlyMap<string, number> = offsetsOf(db)): void {
  for (const transcript of transcripts) {
    const size = existsSync(transcript.path) ? statSync(transcript.path).size : 0
    if (offsets.get(transcript.path) !== size) readFile(db, transcript, size)
  }
  const session = transcripts[0]?.session
  if (session !== undefined) assignSeq(db, session)
}

function readFile(db: Database, transcript: Transcript, size: number): void {
  const fileOf = db.query<{ id: number; offset: number }, [string]>('select id, offset from files where path = ?')
  const known = fileOf.get(transcript.path)
  if (known === null) db.query('insert into files (path, session, agent, offset) values (?, ?, ?, 0) on conflict (path) do nothing').run(transcript.path, transcript.session, transcript.agent ?? '')
  const file = known ?? fileOf.get(transcript.path)
  if (file === null) throw new Error(`cmod history lost the index row of ${transcript.path}. Run the command again.`)
  let folder = 0
  let offset = file.offset
  if (size < offset) {
    db.transaction(() => forgetFile(db, file.id)).immediate()
    offset = 0
  }
  const summary = emptySummary()
  let rows = 0
  let reached = offset
  const save = () => {
    if (transcript.agent === undefined) saveSummary(db, transcript.session, summary)
    db.query('update files set offset = max(offset, ?) where id = ?').run(reached, file.id)
    db.exec('commit')
  }
  try {
    reached = readLines(transcript.path, offset, size, (line) => {
      if (!db.inTransaction) {
        db.exec('begin immediate')
        if (transcript.agent === undefined) ensureSession(db, transcript)
        folder = db.query<{ id: number }, [string]>('insert into folders (path) values (?) on conflict (path) do update set path = path returning id').get(transcript.folder)?.id ?? 0
      }
      rows += readLine(db, transcript, { file: file.id, folder }, line, summary)
      if (rows < batchRows) return true
      reached = line.offset + line.length + 1
      save()
      rows = 0
      return true
    })
    if (db.inTransaction) {
      if (transcript.agent !== undefined) linkAgent(db, transcript, transcript.agent)
      save()
    }
  } catch (error) {
    if (db.inTransaction) db.exec('rollback')
    throw error
  }
}

function readLines(path: string, from: number, to: number, onLine: (line: Line) => boolean): number {
  const descriptor = openSync(path, 'r')
  const chunk = Buffer.alloc(chunkBytes)
  let carry = Buffer.alloc(0)
  let carried = 0
  const keep = (piece: Buffer) => {
    if (carried + piece.length > carry.length) {
      const grown = Buffer.alloc(Math.max(carry.length * 2, carried + piece.length))
      carry.copy(grown, 0, 0, carried)
      carry = grown
    }
    carried += piece.copy(carry, carried)
  }
  let lineStart = from
  let read = from
  try {
    while (read < to) {
      const count = readSync(descriptor, chunk, 0, Math.min(chunkBytes, to - read), read)
      if (count === 0) break
      read += count
      const bytes = chunk.subarray(0, count)
      let start = 0
      for (let stop = bytes.indexOf(10); stop >= 0; stop = bytes.indexOf(10, start)) {
        if (carried > 0) keep(bytes.subarray(start, stop))
        const line = carried > 0 ? carry.subarray(0, carried) : bytes.subarray(start, stop)
        carried = 0
        const offset = lineStart
        lineStart += line.length + 1
        start = stop + 1
        if (line.length > 1 && !onLine({ bytes: line, offset, length: line.length })) return lineStart
      }
      if (start < count) keep(bytes.subarray(start))
    }
  } finally {
    closeSync(descriptor)
  }
  return lineStart
}

function readLine(db: Database, transcript: Transcript, { file, folder }: { readonly file: number; readonly folder: number }, line: Line, summary: Summary): number {
  if (line.bytes.includes('"type":"tool_result"') && line.bytes.includes('"type":"user"')) {
    for (const id of toolUseIds(line.bytes)) {
      db.query('update tool_uses set file = ?, offset = ?, length = ? where session = ? and agent = ? and id = ?').run(file, line.offset, line.length, transcript.session, transcript.agent ?? '', id)
    }
    return 1
  }
  const row = wantedRow(line)
  if (row === undefined) return 0
  if (transcript.agent === undefined) noteRow(summary, transcript.session, row)
  const message = messageIn(row, transcript.session, transcript.agent)
  if (message === undefined) return 0
  const added = db.query('insert or ignore into messages (id, session, agent, folder, at, file, offset, length) values (?, ?, ?, ?, ?, ?, ?, ?)').run(message.id, message.session, message.agent ?? '', folder, message.at, file, line.offset, line.length)
  if (added.changes === 0) return 0
  db.query('insert into message_text (rowid, text) values (?, ?)').run(added.lastInsertRowid, searchText(message))
  for (const tool of message.tools) db.query('insert or ignore into tool_uses (session, agent, id) values (?, ?, ?)').run(message.session, message.agent ?? '', tool.id)
  return 1
}

function wantedRow(line: Line): Row | undefined {
  return wantedRows.some((marker) => line.bytes.includes(marker)) ? parsedRow(line.bytes.toString('utf8')) : undefined
}

function toolUseIds(bytes: Buffer): Set<string> {
  const ids = new Set<string>()
  const key = '"tool_use_id":"'
  for (let found = bytes.indexOf(key); found >= 0; found = bytes.indexOf(key, found + key.length)) {
    const start = found + key.length
    const end = bytes.indexOf(34, start)
    if (end > start) ids.add(bytes.toString('utf8', start, end))
  }
  return ids
}

function assignSeq(db: Database, session: string): void {
  if (db.query<{ found: number }, [string]>('select exists (select 1 from messages where session = ? and seq is null) as found').get(session)?.found !== 1) return
  db.transaction(() => {
    db.query(
      `update messages set seq = ordered.seq
       from (select row, (select coalesce(max(seq), 0) from messages where session = ?1) + row_number() over (order by at, row) as seq from messages where session = ?1 and seq is null) as ordered
       where messages.row = ordered.row`,
    ).run(session)
  }).immediate()
}

function emptySummary(): Summary {
  return { startedAt: '', lastAt: '', project: '', title: '', customTitle: null, forkedFrom: null, isPrompted: 0 }
}

function noteRow(summary: Summary, session: string, row: Row): void {
  const at = typeof row['timestamp'] === 'string' ? row['timestamp'] : undefined
  if (at !== undefined && (summary.startedAt === '' || at < summary.startedAt)) summary.startedAt = at
  if (at !== undefined && at > summary.lastAt) summary.lastAt = at
  if (summary.project === '' && typeof row['cwd'] === 'string') summary.project = row['cwd']
  if (row['type'] === 'custom-title' && typeof row['customTitle'] === 'string') summary.customTitle = row['customTitle']
  const forked = isObject(row['forkedFrom']) ? row['forkedFrom']['sessionId'] : undefined
  if (typeof forked === 'string' && forked !== session) summary.forkedFrom = forked
  if (row['type'] !== 'user' || row['isMeta'] === true || row['isCompactSummary'] === true) return
  const text = contentText(messageOf(row)['content']).trim()
  const prompt = text.startsWith(skillPrefix) ? undefined : promptText(text)
  const sender = senderOf(row['origin'], false)
  if (prompt === undefined || prompt === '' || sender.kind === 'claude-code') return
  summary.isPrompted = 1
  if (summary.title === '' && (sender.kind === 'person' || sender.kind === 'unknown')) summary.title = firstLine(prompt)
}

function saveSummary(db: Database, session: string, summary: Summary): void {
  db.query(
    `update sessions set
       started_at = case when ?1 = '' then started_at when started_at = '' or started_at > ?1 then ?1 else started_at end,
       last_at = case when ?2 > last_at then ?2 else last_at end,
       project = case when project = '' then ?3 else project end,
       title = case when title = '' then ?4 else title end,
       custom_title = coalesce(?5, custom_title),
       forked_from = coalesce(forked_from, ?6),
       is_prompted = max(is_prompted, ?7)
     where id = ?8`,
  ).run(summary.startedAt, summary.lastAt, summary.project, summary.title, summary.customTitle, summary.forkedFrom, summary.isPrompted, session)
}

function summarize(db: Database, main: Transcript, size: number): void {
  const known = db.query<{ title: string; summarized_size: number | null }, [string]>('select title, summarized_size from sessions where id = ?').get(main.session)
  if (known?.summarized_size === size) return
  const summary = emptySummary()
  const isTitled = known !== null && known.title !== ''
  let reached = known?.summarized_size ?? 0
  if (!isTitled) {
    reached = readLines(main.path, reached, size, (line) => {
      const row = wantedRow(line)
      if (row !== undefined) noteRow(summary, main.session, row)
      return summary.title === ''
    })
  }
  const tail = Math.max(reached, size - tailBytes)
  let isPartial = tail > reached
  readLines(main.path, tail, size, (line) => {
    const row = isPartial ? undefined : wantedRow(line)
    isPartial = false
    if (row !== undefined) noteRow(summary, main.session, row)
    return true
  })
  db.transaction(() => {
    ensureSession(db, main)
    saveSummary(db, main.session, summary)
    db.query('update sessions set summarized_size = ? where id = ?').run(isTitled || summary.title !== '' ? size : reached, main.session)
  }).immediate()
}

function messageIn(row: Row, session: string, agent: string | undefined): Message | undefined {
  const id = typeof row['uuid'] === 'string' ? row['uuid'] : undefined
  const at = typeof row['timestamp'] === 'string' ? row['timestamp'] : undefined
  if (id === undefined || at === undefined) return undefined
  const base = { id, session, ...(agent === undefined ? {} : { agent }), at }
  if (row['type'] === 'attachment') {
    const attachment = isObject(row['attachment']) ? row['attachment'] : {}
    if (attachment['type'] !== 'nested_memory' || typeof attachment['path'] !== 'string') return undefined
    return { ...base, from: { kind: 'claude-code', reason: 'instructions', name: attachment['path'] }, text: typeof attachment['content'] === 'string' ? attachment['content'] : '', tools: [] }
  }
  const content = messageOf(row)['content']
  if (row['type'] === 'assistant') {
    const blocks = Array.isArray(content) ? content.filter(isObject) : []
    const text = blocks.flatMap((block) => (block['type'] === 'text' && typeof block['text'] === 'string' ? [block['text']] : [])).join('\n').trim()
    const tools = blocks.flatMap((block): Tool[] =>
      block['type'] === 'tool_use' && typeof block['id'] === 'string' && typeof block['name'] === 'string'
        ? [{ tool: block['name'], input: isObject(block['input']) ? block['input'] : {}, ...(agent === undefined ? {} : { agentId: agent }), id: block['id'] }]
        : [],
    )
    return text === '' && tools.length === 0 ? undefined : { ...base, from: { kind: 'claude' }, text, tools }
  }
  if (row['type'] !== 'user') return undefined
  const text = contentText(content).trim()
  if (row['isCompactSummary'] === true) return { ...base, from: { kind: 'claude-code', reason: 'compaction' }, text, tools: [] }
  if (text.startsWith(skillPrefix)) {
    const folder = text.slice(skillPrefix.length).split('\n')[0]?.trim() ?? ''
    return { ...base, from: { kind: 'claude-code', reason: 'skill', name: basename(folder) }, text, tools: [] }
  }
  if (row['isMeta'] === true || text === '') return undefined
  if (text.startsWith('<task-notification')) return { ...base, from: { kind: 'claude-code', reason: 'notification' }, text: tagOf(text, 'summary') ?? text, tools: [] }
  const prompt = promptText(text)
  return prompt === undefined ? undefined : { ...base, from: senderOf(row['origin'], agent !== undefined), text: prompt, tools: [] }
}

function linkAgent(db: Database, transcript: Transcript, agent: string): void {
  const metaPath = transcript.path.replace(/\.jsonl$/, '.meta.json')
  if (!existsSync(metaPath)) return
  const toolUseId = parsedRow(readFileSync(metaPath, 'utf8'))?.['toolUseId']
  if (typeof toolUseId === 'string') db.query("update tool_uses set subagent = ? where session = ? and agent = '' and id = ?").run(agent, transcript.session, toolUseId)
}

function ensureSession(db: Database, main: Transcript): void {
  db.query('insert into sessions (id, folder) values (?, ?) on conflict (id) do nothing').run(main.session, main.folder)
}

function forgetDeleted(db: Database): void {
  const files = db.query<{ id: number; path: string }, []>('select id, path from files').all()
  const sessions = db.query<{ id: string; folder: string }, []>('select id, folder from sessions').all()
  const gone = files.filter((file) => !existsSync(file.path))
  const ended = sessions.filter((session) => !existsSync(join(session.folder, `${session.id}.jsonl`)))
  if (gone.length === 0 && ended.length === 0) return
  db.transaction(() => {
    for (const file of gone) {
      forgetFile(db, file.id)
      db.query('delete from files where id = ?').run(file.id)
    }
    for (const session of ended) {
      db.query('delete from tool_uses where session = ?').run(session.id)
      db.query('delete from sessions where id = ?').run(session.id)
    }
  }).immediate()
}

function forgetFile(db: Database, file: number): void {
  db.query('delete from message_text where rowid in (select row from messages where file = ?)').run(file)
  db.query('delete from messages where file = ?').run(file)
  db.query('update tool_uses set file = null, offset = null, length = null where file = ?').run(file)
  db.query('update files set offset = 0 where id = ?').run(file)
}

function checkForks(db: Database, folders: readonly string[]): void {
  const unchecked = db
    .query<{ id: string; started_at: string }, string[]>(`select id, started_at from sessions s where folder in (${foldersMarks(folders.length)}) and is_fork_checked = 0 and exists (select 1 from messages where session = s.id and agent = '')`)
    .all(...folders)
  for (const session of unchecked) {
    db.query('update sessions set forked_from = coalesce(forked_from, ?), is_fork_checked = 1 where id = ?').run(parentOf(db, session.id, session.started_at) ?? null, session.id)
  }
}

export function listSessions(db: Database, scope: Scope): Session[] {
  const folders = foldersIn(scope)
  readFolders(db, folders, false)
  const rows = db
    .query<{ id: string; project: string; title: string; custom_title: string | null; started_at: string; last_at: string; forked_from: string | null; is_fork_checked: number; is_indexed: number }, string[]>(
      `select id, project, title, custom_title, started_at, last_at, forked_from, is_fork_checked,
         case when forked_from is null and is_fork_checked = 0 then exists (select 1 from messages where session = sessions.id and agent = '') else 0 end as is_indexed
       from sessions where folder in (${foldersMarks(folders.length)}) and last_at >= ? and (is_prompted = 1 or custom_title is not null) order by last_at desc`,
    )
    .all(...folders, scope.since ?? '')
  return rows.map((row) => {
    const forkedFrom = row.forked_from ?? (row.is_fork_checked === 0 && row.is_indexed === 1 ? foundParent(db, row.id, row.started_at) : undefined)
    return { id: row.id, title: row.custom_title ?? row.title, project: row.project, startedAt: row.started_at, lastAt: row.last_at, ...(forkedFrom === undefined ? {} : { forkedFrom }) }
  })
}

function foundParent(db: Database, session: string, startedAt: string): string | undefined {
  const parent = parentOf(db, session, startedAt)
  if (parent !== undefined) db.query('update sessions set forked_from = ?, is_fork_checked = 1 where id = ?').run(parent, session)
  return parent
}

function parentOf(db: Database, session: string, startedAt: string): string | undefined {
  const found = db
    .query<{ session: string }, [string, string]>(
      `select other.session from messages own
       join messages other on other.id = own.id and other.session != own.session and other.agent = ''
       join sessions parent on parent.id = other.session
       where own.session = ? and own.agent = '' and parent.started_at < ?
       order by own.row desc, parent.started_at asc limit 1`,
    )
    .get(session, startedAt)
  return found?.session
}

const placeColumns = 'row, id, session, agent, file, offset, length'

export function readMessages(db: Database, request: { readonly session: string; readonly project: string; readonly agent?: string; readonly subagents?: boolean; readonly after?: string; readonly last?: number; readonly limit?: number }): Message[] {
  const scope = request.subagents === true ? 'session = ?1' : 'session = ?1 and agent = ?2'
  return readTwice(`The transcripts of ${request.session} changed while cmod read them. Run the command again.`, () => {
    readSession(db, sessionTranscripts(request.session, request.project))
    const after = request.after === undefined ? 0 : (db.query<{ seq: number }, [string, string]>('select seq from messages where session = ? and id = ? and seq is not null').get(request.session, request.after)?.seq ?? Number.POSITIVE_INFINITY)
    const places =
      request.last === undefined
        ? db.query<Place, [string, string, number, number]>(`select ${placeColumns} from messages where ${scope} and seq > ?3 order by seq limit ?4`).all(request.session, request.agent ?? '', after, request.limit ?? -1)
        : db.query<Place, [string, string, number, number]>(`select * from (select ${placeColumns}, seq from messages where ${scope} and seq > ?3 order by seq desc limit ?4) order by seq`).all(request.session, request.agent ?? '', after, request.last)
    return messagesAt(db, places)
  })
}

const searchPaths = { time: 'indexed by messages_by_time', folder: 'indexed by messages_by_folder', matches: 'not indexed' }

export function searchQuery(scope: { readonly isScoped: boolean; readonly hasBefore: boolean; readonly path: keyof typeof searchPaths }): string {
  const inFolder = scope.isScoped ? 'and folder = (select id from folders where path = ?)' : ''
  const before = scope.hasBefore ? 'and (at, row) < (?, ?)' : ''
  return `select ${placeColumns} from messages ${searchPaths[scope.path]}
    where row in (select rowid from message_text where message_text match ?) ${inFolder} and at >= ? ${before}
    order by at desc, row desc limit ?`
}

type SearchScope = Scope & { readonly limit?: number; readonly before?: { readonly session: string; readonly id: string } }

export function searchMessages(db: Database, text: string, scope: SearchScope): Message[] {
  if ([...text].length < 3) throw new Error('cmod history search takes at least 3 characters.')
  const folders = foldersIn(scope)
  const phrase = `"${text.replaceAll('"', '""')}"`
  const scoped = scope.everyProject ? [] : folders
  return readTwice('The transcripts changed while cmod searched them. Run the command again.', () => {
    readFolders(db, folders, true)
    const before = scope.before
    const cursor = before === undefined ? undefined : db.query<{ at: string; row: number }, [string, string]>('select at, row from messages where session = ? and id = ? limit 1').get(before.session, before.id)
    if (cursor === null) throw new Error(`No indexed message ${before?.id} is in session ${before?.session}.`)
    const matches = db.query<{ found: number }, [string, number]>('select count(*) as found from (select rowid from message_text where message_text match ? limit ?)').get(phrase, sortedMatches)?.found ?? 0
    const path = matches < sortedMatches ? 'matches' : scoped.length > 0 ? 'folder' : 'time'
    const query = searchQuery({ isScoped: scoped.length > 0, hasBefore: cursor !== undefined, path })
    const places = db.query<Place, (string | number)[]>(query).all(phrase, ...scoped, scope.since ?? '', ...(cursor === undefined ? [] : [cursor.at, cursor.row]), scope.limit ?? searchLimit)
    return messagesAt(db, places)
  })
}

function foldersMarks(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function readTwice(failure: string, read: () => Message[] | undefined): Message[] {
  const messages = read() ?? read()
  if (messages === undefined) throw new Error(failure)
  return messages
}

function messagesAt(db: Database, places: readonly Place[]): Message[] | undefined {
  const lines = lineReader(db)
  try {
    const messages: Message[] = []
    const stale = new Set<number>()
    for (const place of places) {
      const row = parsedRow(lines.read(place.file, place.offset, place.length) ?? '')
      const message = row === undefined ? undefined : messageIn(row, place.session, place.agent === '' ? undefined : place.agent)
      if (message === undefined || message.id !== place.id) stale.add(place.file)
      else messages.push(withResults(db, lines, message))
    }
    if (stale.size === 0) return messages
    db.transaction(() => {
      for (const file of stale) forgetFile(db, file)
    }).immediate()
    return undefined
  } finally {
    lines.close()
  }
}

function lineReader(db: Database): { read(file: number, offset: number, length: number): string | undefined; close(): void } {
  const descriptors = new Map<number, number | undefined>()
  const pathOf = db.query<{ path: string }, [number]>('select path from files where id = ?')
  return {
    read(file, offset, length) {
      if (!descriptors.has(file)) {
        const path = pathOf.get(file)?.path
        descriptors.set(file, path !== undefined && existsSync(path) ? openSync(path, 'r') : undefined)
      }
      const descriptor = descriptors.get(file)
      if (descriptor === undefined) return undefined
      const buffer = Buffer.alloc(length)
      const count = readSync(descriptor, buffer, 0, length, offset)
      return buffer.toString('utf8', 0, count)
    },
    close() {
      for (const descriptor of descriptors.values()) if (descriptor !== undefined) closeSync(descriptor)
    },
  }
}

function withResults(db: Database, lines: ReturnType<typeof lineReader>, message: Message): Message {
  if (message.tools.length === 0) return message
  const placeOf = db.query<{ file: number | null; offset: number | null; length: number | null; subagent: string | null }, [string, string, string]>('select file, offset, length, subagent from tool_uses where session = ? and agent = ? and id = ?')
  const tools = message.tools.map((tool) => {
    const place = placeOf.get(message.session, message.agent ?? '', tool.id)
    const linked = place?.subagent == null ? tool : { ...tool, subagent: place.subagent }
    if (place?.file == null || place.offset === null || place.length === null) return linked
    const content = messageOf(parsedRow(lines.read(place.file, place.offset, place.length) ?? '') ?? {})['content']
    const block = Array.isArray(content) ? content.filter(isObject).find((each) => each['type'] === 'tool_result' && each['tool_use_id'] === tool.id) : undefined
    if (block === undefined) return linked
    return { ...linked, result: fullResult(contentText(block['content'])), ...(block['is_error'] === true ? { isError: true } : {}) }
  })
  return { ...message, tools }
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
