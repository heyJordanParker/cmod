import { Database } from 'bun:sqlite'
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, watch } from 'node:fs'
import { join, sep } from 'node:path'
import { dataFolder, isAtLeast, isObject, storeFolder } from '@cmodjs/core/src/records.js'
import { ContextEnd, ContextStart } from '@cmodjs/core/src/session/context/context.js'
import { Message, messagesOf, rowOfLine, searchText, type Message as SessionMessage } from '@cmodjs/core/src/session/context/turn/message/message.js'
import { Prompt } from '@cmodjs/core/src/session/context/turn/message/prompt.js'
import { Person } from '@cmodjs/core/src/session/context/turn/message/sender.js'
import { ToolCall } from '@cmodjs/core/src/session/context/turn/message/tool-call.js'
import { ToolResult } from '@cmodjs/core/src/session/context/turn/message/tool-result.js'
import { TurnEnd, TurnStart } from '@cmodjs/core/src/session/context/turn/turn.js'
import { TaskEnd, TaskStart } from '@cmodjs/core/src/session/goal/task.js'
import { UsageChange, type Usage } from '@cmodjs/core/src/session/session.js'
import { createConversation, emptyConversation, searchLimit, type ContextData, type Conversation, type ConversationState, type GoalData, type SessionChange, type SessionData, type TaskData, type TurnData } from '@cmodjs/core/src/session/conversation.js'
import { firstLine } from '@cmodjs/core/src/utils/text.js'
import { configRoot } from './settings.js'
import { storePath } from './store.js'

type Raw = Readonly<Record<string, unknown>>

type Transcript = { readonly path: string; readonly folder: string; readonly session: string; readonly task: string | undefined }

type Line = { readonly bytes: Buffer; readonly offset: number; readonly length: number }

type Place = { readonly row: number; readonly id: string; readonly session: string; readonly task: string; readonly context: number; readonly turn: string | null; readonly file: number; readonly offset: number; readonly length: number; readonly part: number }

type Summary = { startedAt: string; lastAt: string; project: string; cwd: string; model: string; title: string; customTitle: string | null; forkedFrom: string | null; isPrompted: number }

type Meta = { readonly task: string; readonly title: string; readonly agentType: string; readonly call: string }

type Step = { readonly transcript: Transcript; readonly line: Line; readonly raw: Raw; readonly changes: readonly SessionChange[] }

export type Scope = { readonly project: string; readonly everyProject: boolean; readonly since: string | undefined; readonly running?: boolean }

const schema = `
create table files (id integer primary key, path text not null unique, session text not null, task text not null, offset integer not null);
create table sessions (id text primary key, folder text not null, project text not null default '', cwd text not null default '', model text not null default '', title text not null default '', custom_title text, started_at text not null default '', last_at text not null default '', forked_from text, is_prompted integer not null default 0, is_fork_checked integer not null default 0, summarized_size integer, state text);
create table folders (id integer primary key, path text not null unique);
create table messages (row integer primary key, id text not null, session text not null, task text not null, type text not null, context integer not null, turn text, folder integer not null, at text not null, file integer not null, offset integer not null, length integer not null, part integer not null, seq integer, unique (file, offset, part));
create index messages_by_id on messages (id);
create index messages_by_task on messages (session, task, seq);
create index messages_by_turn on messages (session, turn, seq);
create index messages_by_time on messages (at);
create index messages_by_folder on messages (folder, at);
create table turns (session text not null, task text not null, prompt text not null, context integer not null, opened_at text not null, closed_at text, primary key (session, prompt));
create table contexts (session text not null, task text not null default '', number integer not null, opened_at text not null, closed_at text, primary key (session, task, number));
create table tasks (session text not null, id text not null, title text not null, agent_type text not null, model text, opened_by text not null, opened_at text not null, closed_at text, parent text, context integer not null, primary key (session, id));
create virtual table message_text using fts5 (text, tokenize = 'trigram', content = '', contentless_delete = 1);
`

const indexFile = 'history-6.sqlite'

const olderIndexes: readonly string[] = ['history.sqlite', 'history-2.sqlite', 'history-3.sqlite', 'history-4.sqlite', 'history-5.sqlite']

const chunkBytes = 65_536

const tailBytes = 65_536

const sortedMatches = 20_000

const wantedRows: readonly string[] = ['"type":"user"', '"type":"assistant"', '"type":"system"', '"type":"custom-title"', '"nested_memory"', '"forkedFrom"']

export function openHistory(): Database {
  mkdirSync(storePath(), { recursive: true })
  for (const older of olderIndexes) for (const suffix of ['', '-wal', '-shm']) rmSync(storePath(`${older}${suffix}`), { force: true })
  const path = storePath(indexFile)
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

function runningFolder(): string {
  return join(configRoot(), 'sessions')
}

function runningEntries(): { readonly session: string; readonly cwd: string }[] {
  const folder = runningFolder()
  if (!existsSync(folder)) return []
  const running: { session: string; cwd: string }[] = []
  for (const name of readdirSync(folder)) {
    if (!name.endsWith('.json')) continue
    const entry = parsedRow(readFileSync(join(folder, name), 'utf8'))
    if (typeof entry?.['pid'] === 'number' && typeof entry['sessionId'] === 'string' && isAlive(entry['pid'])) running.push({ session: entry['sessionId'], cwd: typeof entry['cwd'] === 'string' ? entry['cwd'] : '' })
  }
  return running
}

export function runningSessions(): Set<string> {
  return new Set(runningEntries().map(({ session }) => session))
}

function runningIn(project: string): string[] {
  const folder = folderOf(project)
  return runningEntries()
    .filter(({ session, cwd }) => cwd === project || cwd.startsWith(`${project}${sep}`) || existsSync(join(folder, `${session}.jsonl`)))
    .map(({ session }) => session)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function mainTranscripts(folder: string): Transcript[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => ({ transcript: { path: join(folder, name), folder, session: name.slice(0, -'.jsonl'.length), task: undefined }, born: statSync(join(folder, name)).birthtimeMs }))
    .sort((first, second) => first.born - second.born || first.transcript.path.localeCompare(second.transcript.path))
    .map(({ transcript }) => transcript)
}

function taskTranscripts(main: Transcript): Transcript[] {
  const subagents = join(main.folder, main.session, 'subagents')
  if (!existsSync(subagents)) return []
  return readdirSync(subagents)
    .flatMap((name) => {
      const task = /^agent-(.+)\.jsonl$/.exec(name)?.[1]
      return task === undefined ? [] : [{ transcript: { path: join(subagents, name), folder: main.folder, session: main.session, task }, born: statSync(join(subagents, name)).birthtimeMs }]
    })
    .sort((first, second) => first.born - second.born)
    .map(({ transcript }) => transcript)
}

function sessionFolder(session: string, project: string): string | undefined {
  const preferred = folderOf(project)
  return [preferred, ...foldersIn({ project, everyProject: true }).filter((folder) => folder !== preferred)].find((each) => existsSync(join(each, `${session}.jsonl`)))
}

export function sessionTranscripts(session: string, project: string): Transcript[] {
  const folder = sessionFolder(session, project)
  if (folder === undefined && session === process.env['CLAUDE_CODE_SESSION_ID']) return []
  if (folder === undefined) throw new Error(`No Claude Code transcript is named ${session}.jsonl under ${projectsFolder()}. cmod history sessions --all lists the sessions.`)
  const main = { path: join(folder, `${session}.jsonl`), folder, session, task: undefined }
  return [main, ...taskTranscripts(main)]
}

export function readFolders(db: Database, folders: readonly string[], fully: boolean): void {
  forgetDeleted(db)
  const offsets = offsetsOf(db)
  const mains = folders.flatMap(mainTranscripts).map((main) => ({ main, stat: statSync(main.path) }))
  for (const { main, stat } of mains.sort((first, second) => first.stat.mtimeMs - second.stat.mtimeMs)) {
    if (fully || offsets.has(main.path)) readSession(db, [main, ...taskTranscripts(main)], offsets)
    else summarize(db, main, stat.size)
  }
  if (fully && folders.length > 0) checkForks(db, folders)
}

function offsetsOf(db: Database): Map<string, number> {
  return new Map(db.query<{ path: string; offset: number }, []>('select path, offset from files').all().map((file) => [file.path, file.offset]))
}

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

export function readSession(db: Database, transcripts: readonly Transcript[], known: ReadonlyMap<string, number> = offsetsOf(db)): void {
  const [main] = transcripts
  if (main === undefined || !transcripts.some((transcript) => hasNewLine(transcript.path, known.get(transcript.path) ?? 0))) return
  db.exec('begin immediate')
  try {
    const offsets = offsetsOf(db)
    if (transcripts.some((transcript) => (offsets.get(transcript.path) ?? 0) > sizeOf(transcript.path))) {
      forgetSession(db, main.session)
      for (const transcript of transcripts) offsets.delete(transcript.path)
    }
    db.query('insert into sessions (id, folder) values (?, ?) on conflict (id) do nothing').run(main.session, main.folder)
    const folder = db.query<{ id: number }, [string]>('insert into folders (path) values (?) on conflict (path) do update set path = path returning id').get(main.folder)?.id ?? 0
    const files = new Map(transcripts.map((transcript) => [transcript.path, fileOf(db, transcript)]))
    const conversation = createConversation(stateOf(db, main.session) ?? emptyConversation(main.session))
    const summary = emptySummary()
    const reached = stepThrough(conversation, transcripts, offsets, ({ transcript, line, raw, changes }) => {
      if (transcript.task === undefined) noteRow(summary, main.session, raw)
      saveChanges(db, { session: main.session, folder, file: files.get(transcript.path) ?? 0, line, row: typeof raw['uuid'] === 'string' ? raw['uuid'] : '' }, changes)
    })
    saveSummary(db, main.session, summary)
    db.query('update sessions set state = ? where id = ?').run(JSON.stringify(conversation.state), main.session)
    for (const [path, offset] of reached) db.query('update files set offset = ? where path = ?').run(offset, path)
    assignSeq(db, main.session)
    db.exec('commit')
  } catch (error) {
    if (db.inTransaction) db.exec('rollback')
    throw error
  }
}

function hasNewLine(path: string, from: number): boolean {
  const size = sizeOf(path)
  if (size < from) return true
  let found = false
  readLines(path, from, size, () => {
    found = true
    return false
  })
  return found
}

function fileOf(db: Database, transcript: Transcript): number {
  db.query('insert into files (path, session, task, offset) values (?, ?, ?, 0) on conflict (path) do nothing').run(transcript.path, transcript.session, transcript.task ?? '')
  return db.query<{ id: number }, [string]>('select id from files where path = ?').get(transcript.path)?.id ?? 0
}

function stateOf(db: Database, session: string): ConversationState | undefined {
  const saved = db.query<{ state: string | null }, [string]>('select state from sessions where id = ?').get(session)?.state
  return typeof saved === 'string' ? (JSON.parse(saved) as ConversationState) : undefined
}

function stepThrough(conversation: Conversation, transcripts: readonly Transcript[], offsets: ReadonlyMap<string, number>, onStep: (step: Step) => void): Map<string, number> {
  const metas = metasOf(transcripts.filter((transcript) => transcript.task !== undefined))
  const isStarted = (task: string) => conversation.state.tasks[task] !== undefined
  const reached = new Map<string, number>()
  for (const transcript of transcripts) {
    const { task } = transcript
    reached.set(
      transcript.path,
      readLines(transcript.path, offsets.get(transcript.path) ?? 0, sizeOf(transcript.path), (line) => {
        const raw = wantedRow(line)
        if (raw === undefined) return true
        const row = rowOfLine(raw)
        const changes: SessionChange[] = []
        if (row !== undefined) {
          if (task !== undefined && !isStarted(task)) changes.push(...conversation.startTask(taskData([...metas.values()].find((meta) => meta.task === task) ?? { task, title: '', agentType: 'general-purpose', call: '' }, row.at)))
          const added = conversation.add(row, task)
          changes.push(...added)
          for (const change of added) {
            const meta = change.type === Message && change.message.type === ToolCall ? metas.get(change.message.callId) : undefined
            if (meta !== undefined && !isStarted(meta.task)) changes.push(...conversation.startTask(taskData(meta, row.at, task)))
          }
        }
        onStep({ transcript, line, raw, changes })
        return true
      }),
    )
  }
  return reached
}

function metasOf(tasks: readonly Transcript[]): Map<string, Meta> {
  const metas = new Map<string, Meta>()
  for (const { path, task } of tasks) {
    const metaPath = path.replace(/\.jsonl$/, '.meta.json')
    const meta = task === undefined || !existsSync(metaPath) ? undefined : parsedRow(readFileSync(metaPath, 'utf8'))
    if (task === undefined || typeof meta?.['toolUseId'] !== 'string') continue
    metas.set(meta['toolUseId'], { task, title: typeof meta['description'] === 'string' ? meta['description'] : '', agentType: typeof meta['agentType'] === 'string' ? meta['agentType'] : 'general-purpose', call: meta['toolUseId'] })
  }
  return metas
}

function taskData(meta: Meta, at: string, parent?: string): TaskData {
  return { id: meta.task, title: meta.title, agentType: meta.agentType, openedBy: meta.call, openedAt: at, ...(parent === undefined ? {} : { parent }) }
}

function saveChanges(db: Database, place: { readonly session: string; readonly folder: number; readonly file: number; readonly line: Line; readonly row: string }, changes: readonly SessionChange[]): void {
  const { session, folder, file, line, row } = place
  for (const change of changes) {
    if (change.type === Message) {
      const { message } = change
      const part = message.id === row ? 0 : Number(message.id.slice(row.length + 1))
      const added = db
        .query('insert or ignore into messages (id, session, task, type, context, turn, folder, at, file, offset, length, part) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(message.id, session, message.task ?? '', message.type, message.context, message.turn ?? null, folder, message.at, file, line.offset, line.length, part)
      const text = searchText(message)
      if (added.changes > 0 && text !== '') db.query('insert into message_text (rowid, text) values (?, ?)').run(added.lastInsertRowid, text)
    } else if (change.type === TurnStart) {
      db.query('insert or replace into turns (session, task, prompt, context, opened_at, closed_at) values (?, ?, ?, ?, ?, ?)').run(session, change.turn.prompt.task ?? '', change.turn.prompt.id, change.turn.context, change.turn.openedAt, change.turn.closedAt ?? null)
    } else if (change.type === TurnEnd) {
      db.query('update turns set closed_at = ? where session = ? and prompt = ?').run(change.turn.closedAt ?? null, session, change.turn.prompt.id)
    } else if (change.type === ContextStart) {
      db.query('insert or replace into contexts (session, task, number, opened_at) values (?, ?, ?, ?)').run(session, change.context.task ?? '', change.context.number, change.context.openedAt)
    } else if (change.type === ContextEnd) {
      db.query('insert into contexts (session, task, number, opened_at, closed_at) values (?, ?, ?, ?, ?) on conflict (session, task, number) do update set closed_at = excluded.closed_at').run(session, change.context.task ?? '', change.context.number, change.context.openedAt, change.context.closedAt ?? null)
    } else if (change.type === TaskStart) {
      const { task } = change
      db.query('insert or replace into tasks (session, id, title, agent_type, model, opened_by, opened_at, parent, context) values (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(session, task.id, task.title, task.agentType, task.model ?? null, task.openedBy, task.openedAt, task.parent ?? null, task.context)
    } else if (change.type === TaskEnd) {
      db.query('update tasks set closed_at = ? where session = ? and id = ?').run(change.task.closedAt ?? null, session, change.task.id)
    }
  }
}

function readLines(path: string, from: number, to: number, onLine: (line: Line) => boolean): number {
  if (from >= to) return from
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

function wantedRow(line: Line): Raw | undefined {
  return wantedRows.some((marker) => line.bytes.includes(marker)) ? parsedRow(line.bytes.toString('utf8')) : undefined
}

function assignSeq(db: Database, session: string): void {
  if (db.query<{ found: number }, [string]>('select exists (select 1 from messages where session = ? and seq is null) as found').get(session)?.found !== 1) return
  db.query(
    `update messages set seq = ordered.seq
     from (select row, (select coalesce(max(seq), 0) from messages where session = ?1) + row_number() over (order by at, row) as seq from messages where session = ?1 and seq is null) as ordered
     where messages.row = ordered.row`,
  ).run(session)
}

function emptySummary(): Summary {
  return { startedAt: '', lastAt: '', project: '', cwd: '', model: '', title: '', customTitle: null, forkedFrom: null, isPrompted: 0 }
}

function noteRow(summary: Summary, session: string, raw: Raw): void {
  const at = typeof raw['timestamp'] === 'string' ? raw['timestamp'] : undefined
  if (at !== undefined && (summary.startedAt === '' || at < summary.startedAt)) summary.startedAt = at
  if (at !== undefined && at > summary.lastAt) summary.lastAt = at
  if (typeof raw['cwd'] === 'string') {
    if (summary.project === '') summary.project = raw['cwd']
    summary.cwd = raw['cwd']
  }
  if (raw['type'] === 'custom-title' && typeof raw['customTitle'] === 'string') summary.customTitle = raw['customTitle']
  const forked = isObject(raw['forkedFrom']) ? raw['forkedFrom']['sessionId'] : undefined
  if (typeof forked === 'string' && forked !== session) summary.forkedFrom = forked
  const row = rowOfLine(raw)
  if (row?.model !== undefined && row.type === 'assistant') summary.model = row.model
  if (row?.type !== 'user') return
  for (const message of messagesOf(row, false)) {
    if (message.type !== Prompt) continue
    summary.isPrompted = 1
    if (summary.title === '' && message.from.type === Person) summary.title = firstLine(message.text)
  }
}

function saveSummary(db: Database, session: string, summary: Summary): void {
  db.query(
    `update sessions set
       started_at = case when ?1 = '' then started_at when started_at = '' or started_at > ?1 then ?1 else started_at end,
       last_at = case when ?2 > last_at then ?2 else last_at end,
       project = case when project = '' then ?3 else project end,
       cwd = case when ?4 = '' then cwd else ?4 end,
       model = case when ?5 = '' then model else ?5 end,
       title = case when title = '' then ?6 else title end,
       custom_title = coalesce(?7, custom_title),
       forked_from = coalesce(forked_from, ?8),
       is_prompted = max(is_prompted, ?9)
     where id = ?10`,
  ).run(summary.startedAt, summary.lastAt, summary.project, summary.cwd, summary.model, summary.title, summary.customTitle, summary.forkedFrom, summary.isPrompted, session)
}

function summarize(db: Database, main: Transcript, size: number): void {
  const known = db.query<{ title: string; summarized_size: number | null }, [string]>('select title, summarized_size from sessions where id = ?').get(main.session)
  if (known?.summarized_size === size) return
  const summary = emptySummary()
  const isTitled = known !== null && known.title !== ''
  let reached = known?.summarized_size ?? 0
  if (!isTitled) {
    reached = readLines(main.path, reached, size, (line) => {
      const raw = wantedRow(line)
      if (raw !== undefined) noteRow(summary, main.session, raw)
      return summary.title === ''
    })
  }
  const tail = Math.max(reached, size - tailBytes)
  let isPartial = tail > reached
  readLines(main.path, tail, size, (line) => {
    const raw = isPartial ? undefined : wantedRow(line)
    isPartial = false
    if (raw !== undefined) noteRow(summary, main.session, raw)
    return true
  })
  db.transaction(() => {
    db.query('insert into sessions (id, folder) values (?, ?) on conflict (id) do nothing').run(main.session, main.folder)
    saveSummary(db, main.session, summary)
    db.query('update sessions set summarized_size = ? where id = ?').run(isTitled || summary.title !== '' ? size : reached, main.session)
  }).immediate()
}

function forgetDeleted(db: Database): void {
  const files = db.query<{ id: number; path: string }, []>('select id, path from files').all()
  const sessions = db.query<{ id: string; folder: string }, []>('select id, folder from sessions').all()
  const gone = files.filter((file) => !existsSync(file.path))
  const ended = sessions.filter((session) => !existsSync(join(session.folder, `${session.id}.jsonl`)))
  if (gone.length === 0 && ended.length === 0) return
  db.transaction(() => {
    for (const session of ended) {
      forgetSession(db, session.id)
      db.query('delete from files where session = ?').run(session.id)
      db.query('delete from sessions where id = ?').run(session.id)
    }
    for (const file of gone) {
      db.query('delete from message_text where rowid in (select row from messages where file = ?)').run(file.id)
      db.query('delete from messages where file = ?').run(file.id)
      db.query('delete from files where id = ?').run(file.id)
    }
  }).immediate()
}

function forgetSession(db: Database, session: string): void {
  db.query('delete from message_text where rowid in (select row from messages where session = ?)').run(session)
  db.query('delete from messages where session = ?').run(session)
  for (const table of ['turns', 'contexts', 'tasks']) db.query(`delete from ${table} where session = ?`).run(session)
  db.query('update files set offset = 0 where session = ?').run(session)
  db.query('update sessions set state = null where id = ?').run(session)
}

function checkForks(db: Database, folders: readonly string[]): void {
  const unchecked = db
    .query<{ id: string; started_at: string }, string[]>(`select id, started_at from sessions s where folder in (${foldersMarks(folders.length)}) and is_fork_checked = 0 and exists (select 1 from messages where session = s.id and task = '')`)
    .all(...folders)
  for (const session of unchecked) {
    db.query('update sessions set forked_from = coalesce(forked_from, ?), is_fork_checked = 1 where id = ?').run(parentOf(db, session.id, session.started_at) ?? null, session.id)
  }
}

export function listSessions(db: Database, scope: Scope): SessionData[] {
  const folders = foldersIn(scope)
  readFolders(db, folders, false)
  const running = runningSessions()
  const rows = db
    .query<{ id: string; project: string; cwd: string; model: string; title: string; custom_title: string | null; started_at: string; last_at: string; forked_from: string | null; is_fork_checked: number; is_indexed: number }, string[]>(
      `select id, project, cwd, model, title, custom_title, started_at, last_at, forked_from, is_fork_checked,
         case when forked_from is null and is_fork_checked = 0 then exists (select 1 from messages where session = sessions.id and task = '') else 0 end as is_indexed
       from sessions where folder in (${foldersMarks(folders.length)}) and last_at >= ? and (is_prompted = 1 or custom_title is not null) order by last_at desc`,
    )
    .all(...folders, scope.since ?? '')
  return rows
    .filter((row) => scope.running !== true || running.has(row.id))
    .map((row) => {
      const forkedFrom = row.forked_from ?? (row.is_fork_checked === 0 && row.is_indexed === 1 ? foundParent(db, row.id, row.started_at) : undefined)
      return { id: row.id, title: row.custom_title ?? row.title, project: row.project, cwd: row.cwd || row.project, model: row.model, startedAt: row.started_at, lastAt: row.last_at, ...(forkedFrom === undefined ? {} : { forkedFrom }), isRunning: running.has(row.id) }
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
       join messages other on other.id = own.id and other.session != own.session and other.task = ''
       join sessions parent on parent.id = other.session
       where own.session = ? and own.task = '' and parent.started_at < ?
       order by own.row desc, parent.started_at asc limit 1`,
    )
    .get(session, startedAt)
  return found?.session
}

const placeColumns = 'row, id, session, task, context, turn, file, offset, length, part'

export type MessagesRequest = { readonly session: string; readonly project: string; readonly task?: string; readonly turn?: string; readonly after?: string; readonly last?: number }

export function readMessages(db: Database, request: MessagesRequest): SessionMessage[] {
  return readTwice(`The transcripts of ${request.session} changed while cmod read them. Run the command again.`, () => {
    readSession(db, sessionTranscripts(request.session, request.project))
    const after = request.after === undefined ? 0 : (db.query<{ seq: number }, [string, string]>('select seq from messages where session = ? and id = ? and seq is not null').get(request.session, request.after)?.seq ?? Number.POSITIVE_INFINITY)
    const inTurn = request.turn === undefined ? '' : 'and turn = ?4'
    const fits = `session = ?1 and task = ?2 ${inTurn} and seq > ?3`
    const params = [request.session, request.task ?? '', after, ...(request.turn === undefined ? [] : [request.turn])]
    const places =
      request.last === undefined
        ? db.query<Place, (string | number)[]>(`select ${placeColumns} from messages where ${fits} order by seq`).all(...params)
        : db.query<Place, (string | number)[]>(`select * from (select ${placeColumns}, seq from messages where ${fits} order by seq desc limit ${request.last}) order by seq`).all(...params)
    return messagesAt(db, places)
  })
}

export function readTurns(db: Database, request: { readonly session: string; readonly project: string; readonly task?: string; readonly context?: number; readonly last?: number }): TurnData[] {
  return readTwice(`The transcripts of ${request.session} changed while cmod read them. Run the command again.`, () => {
    readSession(db, sessionTranscripts(request.session, request.project))
    const inContext = request.context === undefined ? '' : 'and context = ?3'
    const rows = db
      .query<{ prompt: string; context: number; opened_at: string; closed_at: string | null }, (string | number)[]>(`select prompt, context, opened_at, closed_at from turns where session = ?1 and task = ?2 ${inContext} order by opened_at`)
      .all(request.session, request.task ?? '', ...(request.context === undefined ? [] : [request.context]))
    const kept = request.last === undefined ? rows : rows.slice(-request.last)
    const placeOf = db.query<Place, [string, string, string]>(`select ${placeColumns} from messages where session = ?1 and task = ?2 and id = ?3`)
    const prompts = messagesAt(
      db,
      kept.flatMap((turn) => {
        const place = placeOf.get(request.session, request.task ?? '', turn.prompt)
        return place === null ? [] : [place]
      }),
    )
    if (prompts === undefined) return undefined
    const byId = new Map(prompts.map((message) => [message.id, message]))
    return kept.flatMap((turn) => {
      const prompt = byId.get(turn.prompt)
      return prompt?.type === Prompt ? [{ prompt, context: turn.context, openedAt: turn.opened_at, ...(turn.closed_at === null ? {} : { closedAt: turn.closed_at }) }] : []
    })
  })
}

export function readContexts(db: Database, request: { readonly session: string; readonly project: string; readonly task?: string }): ContextData[] {
  readSession(db, sessionTranscripts(request.session, request.project))
  const contexts = db
    .query<{ number: number; opened_at: string; closed_at: string | null }, [string, string]>('select number, opened_at, closed_at from contexts where session = ? and task = ? order by number')
    .all(request.session, request.task ?? '')
    .map((row): ContextData => ({ number: row.number, openedAt: row.opened_at, ...(row.closed_at === null ? {} : { closedAt: row.closed_at }), ...(request.task === undefined ? {} : { task: request.task }) }))
  if (request.task === undefined) return contexts
  const task = db.query<{ context: number; opened_at: string; closed_at: string | null }, [string, string]>('select context, opened_at, closed_at from tasks where session = ? and id = ?').get(request.session, request.task)
  if (task === null) throw new Error(`Session ${request.session} has no task ${request.task}.`)
  const first: ContextData = { number: task.context, openedAt: task.opened_at, task: request.task }
  const all = contexts.some((context) => context.number === task.context) ? contexts : [first, ...contexts]
  const last = all.at(-1)
  return task.closed_at === null || last === undefined || last.closedAt !== undefined ? all : [...all.slice(0, -1), { ...last, closedAt: task.closed_at }]
}

export function readTasks(db: Database, request: { readonly session: string; readonly project: string; readonly task?: string; readonly isNested?: boolean }): TaskData[] {
  readSession(db, sessionTranscripts(request.session, request.project))
  const under = request.isNested === true ? '' : 'and parent is ?2'
  return db
    .query<{ id: string; title: string; agent_type: string; model: string | null; opened_by: string; opened_at: string; closed_at: string | null; parent: string | null }, (string | null)[]>(
      `select id, title, agent_type, model, opened_by, opened_at, closed_at, parent from tasks where session = ?1 ${under} order by opened_at`,
    )
    .all(request.session, ...(request.isNested === true ? [] : [request.task ?? null]))
    .map((row) => ({
      id: row.id,
      title: row.title,
      agentType: row.agent_type,
      ...(row.model === null ? {} : { model: row.model }),
      openedBy: row.opened_by,
      openedAt: row.opened_at,
      ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
      ...(row.parent === null ? {} : { parent: row.parent }),
    }))
}

export function readState(db: Database, request: { readonly session: string; readonly project: string }): ConversationState {
  readSession(db, sessionTranscripts(request.session, request.project))
  const state = stateOf(db, request.session) ?? emptyConversation(request.session)
  const goal = savedGoal(request.session)
  return goal === undefined ? state : { ...state, goal }
}

export function readGoal(db: Database, request: { readonly session: string; readonly project: string; readonly task?: string }): GoalData {
  if (request.task === undefined) return { text: readState(db, request).goal ?? '' }
  const saved = savedGoal(request.task)
  if (saved !== undefined) return { text: saved }
  const [first] = readTurns(db, request)
  return { text: first?.prompt.text ?? '' }
}

export function readUsage(request: { readonly session: string; readonly project: string; readonly task?: string }): Usage {
  const transcripts = sessionTranscripts(request.session, request.project)
  const transcript = transcripts.find((each) => each.task === request.task)
  if (transcript === undefined) throw new Error(`Session ${request.session} has no task ${request.task ?? ''}.`)
  const size = sizeOf(transcript.path)
  let usage: Usage | undefined
  let tail = Math.max(0, size - tailBytes)
  while (usage === undefined) {
    let isPartial = tail > 0
    readLines(transcript.path, tail, size, (line) => {
      const raw = isPartial ? undefined : parsedRow(line.bytes.toString('utf8'))
      isPartial = false
      usage = usageOfRow(raw) ?? usage
      return true
    })
    if (tail === 0) break
    tail = Math.max(0, tail - tailBytes)
  }
  return usage ?? { model: '', contextWindow: {} }
}

export function usageOfRow(raw: Raw | undefined): Usage | undefined {
  const message = raw?.['type'] === 'assistant' && isObject(raw['message']) ? raw['message'] : undefined
  const counts = message !== undefined && isObject(message['usage']) ? message['usage'] : undefined
  if (message === undefined || counts === undefined || typeof message['model'] !== 'string' || message['model'] === '<synthetic>') return undefined
  const count = (key: string) => (typeof counts[key] === 'number' ? counts[key] : 0)
  return { model: message['model'], contextWindow: { tokenCount: count('input_tokens') + count('cache_creation_input_tokens') + count('cache_read_input_tokens') + count('output_tokens') } }
}

function savedGoal(session: string): string | undefined {
  const path = join(dataFolder(storeFolder(process.env), 'cmod'), 'goals', `${session}.txt`)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

const searchPaths = { time: 'indexed by messages_by_time', folder: 'indexed by messages_by_folder', matches: 'not indexed' }

export type RecordScope = { readonly session?: string; readonly task?: string; readonly turn?: string; readonly context?: number; readonly isGoal?: boolean }

export function searchQuery(scope: { readonly isScoped: boolean; readonly isRunning: boolean; readonly hasBefore: boolean; readonly path: keyof typeof searchPaths; readonly record?: RecordScope }): string {
  const inFolder = scope.isScoped ? 'and folder = (select id from folders where path = ?)' : ''
  const running = scope.isRunning ? 'and session in (select value from json_each(?))' : ''
  const before = scope.hasBefore ? 'and (at, row) < (?, ?)' : ''
  return `select ${placeColumns} from messages ${searchPaths[scope.path]}
    where row in (select rowid from message_text where message_text match ?) ${inFolder} ${running} ${recordFilter(scope.record ?? {})} and at >= ? ${before}
    order by at desc, row desc limit ?`
}

function recordFilter(record: RecordScope): string {
  const inSession = record.session === undefined ? '' : 'and session = ?'
  const tree = `with recursive tree(id) as (select ? union select tasks.id from tasks join tree on tasks.parent = tree.id where tasks.session = ?) select id from tree`
  const inTask = record.task === undefined ? (record.isGoal === true ? "and task != ''" : '') : `and task in (${tree}${record.isGoal === true ? ' where id != ?' : ''})`
  const inTurn = record.turn === undefined ? '' : 'and turn = ?'
  const inContext = record.context === undefined ? '' : 'and context = ? and task = ?'
  return `${inSession} ${inTask} ${inTurn} ${inContext}`
}

function recordParams(record: RecordScope): (string | number)[] {
  const task = record.task === undefined ? [] : [record.task, record.session ?? '', ...(record.isGoal === true ? [record.task] : [])]
  return [...(record.session === undefined ? [] : [record.session]), ...task, ...(record.turn === undefined ? [] : [record.turn]), ...(record.context === undefined ? [] : [record.context, record.task ?? ''])]
}

type SearchScope = Scope & { readonly limit?: number; readonly before?: { readonly session: string; readonly id: string }; readonly record?: RecordScope }

export function searchMessages(db: Database, text: string, scope: SearchScope): SessionMessage[] {
  if ([...text].length < 3) throw new Error('cmod history search takes at least 3 characters.')
  const session = scope.record?.session
  const folders = session === undefined ? foldersIn(scope) : []
  const phrase = `"${text.replaceAll('"', '""')}"`
  const scoped = scope.everyProject ? [] : folders
  const running = scope.running === true ? [JSON.stringify([...runningSessions()])] : []
  return readTwice('The transcripts changed while cmod searched them. Run the command again.', () => {
    if (session === undefined) readFolders(db, folders, true)
    else readSession(db, sessionTranscripts(session, scope.project))
    const before = scope.before
    const cursor = before === undefined ? undefined : db.query<{ at: string; row: number }, [string, string]>('select at, row from messages where session = ? and id = ? limit 1').get(before.session, before.id)
    if (cursor === null) throw new Error(`No indexed message ${before?.id} is in session ${before?.session}.`)
    const matches = db.query<{ found: number }, [string, number]>('select count(*) as found from (select rowid from message_text where message_text match ? limit ?)').get(phrase, sortedMatches)?.found ?? 0
    const path = matches < sortedMatches ? 'matches' : scoped.length > 0 ? 'folder' : 'time'
    const record = scope.record ?? {}
    const query = searchQuery({ isScoped: scoped.length > 0, isRunning: running.length > 0, hasBefore: cursor !== undefined, path, record })
    const places = db.query<Place, (string | number)[]>(query).all(phrase, ...scoped, ...running, ...recordParams(record), scope.since ?? '', ...(cursor === undefined ? [] : [cursor.at, cursor.row]), scope.limit ?? searchLimit)
    return messagesAt(db, places)
  })
}

export async function followSessions(db: Database, { sessions, isEveryRunning }: { readonly sessions: readonly string[]; readonly isEveryRunning: boolean }, project: string, onChange: (session: string, change: SessionChange, isInProject: boolean) => void, signal: AbortSignal): Promise<void> {
  const own = process.env['CLAUDE_CODE_SESSION_ID']
  const followed = new Set<string>()
  const followers: Promise<void>[] = []
  const add = (session: string) => {
    if (followed.has(session) || session === own) return
    followed.add(session)
    const isInProject = runningIn(project).includes(session) || existsSync(join(folderOf(project), `${session}.jsonl`))
    followers.push(followSession(db, session, project, (change) => onChange(session, change, isInProject), signal))
  }
  for (const session of sessions) add(session)
  if (!isEveryRunning) {
    await Promise.all(followers)
    return
  }
  const look = () => {
    for (const session of runningIn(project)) add(session)
  }
  mkdirSync(runningFolder(), { recursive: true })
  watch(runningFolder(), { signal }).on('change', look).on('error', () => undefined)
  look()
  await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })))
}

async function followSession(db: Database, session: string, project: string, onChange: (change: SessionChange) => void, signal: AbortSignal): Promise<void> {
  const folder = sessionFolder(session, project) ?? folderOf(project)
  mkdirSync(folder, { recursive: true })
  const prefix = `${session}.jsonl`
  const tasksPrefix = join(session, 'subagents')
  const watcher = watch(folder, { recursive: true, signal })
  let conversation: Conversation | undefined
  let offsets = new Map<string, number>()
  const transcripts = () => {
    const main = { path: join(folder, prefix), folder, session, task: undefined }
    return existsSync(main.path) ? [main, ...taskTranscripts(main)] : []
  }
  const step = () => {
    if (conversation === undefined) {
      const found = transcripts()
      readSession(db, found)
      const [state, indexed] = db.transaction(() => [stateOf(db, session), offsetsOf(db)] as const)()
      conversation = createConversation(found.length === 0 ? emptyConversation(session) : (state ?? emptyConversation(session)))
      offsets = indexed
      return
    }
    const reached = stepThrough(conversation, transcripts(), offsets, ({ transcript, raw, changes }) => {
      for (const change of changes) onChange(change)
      const usage = transcript.task === undefined ? usageOfRow(raw) : undefined
      if (usage !== undefined) onChange({ type: UsageChange, usage })
    })
    for (const [path, offset] of reached) offsets.set(path, offset)
  }
  watcher.on('change', (_event, name) => {
    const changed = String(name)
    if (changed === prefix || changed.startsWith(tasksPrefix)) step()
  })
  step()
  await new Promise<void>((resolve) => {
    watcher.on('close', resolve)
    watcher.on('error', () => resolve())
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

function foldersMarks(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function readTwice<Value>(failure: string, read: () => Value | undefined): Value {
  const value = read() ?? read()
  if (value === undefined) throw new Error(failure)
  return value
}

function messagesAt(db: Database, places: readonly Place[]): SessionMessage[] | undefined {
  const lines = lineReader(db)
  try {
    const messages: SessionMessage[] = []
    const stale = new Set<string>()
    for (const place of places) {
      const raw = parsedRow(lines.read(place.file, place.offset, place.length) ?? '')
      const row = raw === undefined ? undefined : rowOfLine(raw)
      const unplaced = row === undefined ? undefined : messagesOf(row, place.task !== '')[place.part]
      if (unplaced === undefined || unplaced.id !== place.id) stale.add(place.session)
      else messages.push({ ...unplaced, ...(unplaced.type === ToolResult ? callOf(db, lines, place, unplaced.callId, messages) : {}), session: place.session, context: place.context, ...(place.turn === null ? {} : { turn: place.turn }), ...(place.task === '' ? {} : { task: place.task }) })
    }
    if (stale.size === 0) return messages
    db.transaction(() => {
      for (const session of stale) forgetSession(db, session)
    }).immediate()
    return undefined
  } finally {
    lines.close()
  }
}

function callOf(db: Database, lines: ReturnType<typeof lineReader>, place: Place, callId: string, read: readonly SessionMessage[]): Pick<ToolCall, 'name' | 'input' | 'cwd'> | undefined {
  const isTheCall = (message: { readonly type: string } | undefined): message is Pick<ToolCall, 'type' | 'callId' | 'name' | 'input' | 'cwd'> => message?.type === ToolCall && (message as ToolCall).callId === callId
  for (const each of read.toReversed()) if (isTheCall(each)) return { name: each.name, input: each.input, cwd: each.cwd }
  const earlier = db.query<Place, [string, string, number]>(`select ${placeColumns} from messages where session = ?1 and task = ?2 and seq < (select seq from messages where row = ?3) order by seq desc limit ${callSearchRows}`).all(place.session, place.task, place.row)
  for (const each of earlier) {
    const raw = parsedRow(lines.read(each.file, each.offset, each.length) ?? '')
    const row = raw === undefined ? undefined : rowOfLine(raw)
    const call = row === undefined ? undefined : messagesOf(row, each.task !== '')[each.part]
    if (isTheCall(call)) return { name: call.name, input: call.input, cwd: call.cwd }
  }
  return undefined
}

const callSearchRows = 64

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

function parsedRow(line: string): Raw | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return isObject(value) ? value : undefined
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}
