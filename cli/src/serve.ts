import { Database } from 'bun:sqlite'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { dataFolder, devicePath, isObject, storeFolder, type ServeApps } from '@cmodjs/core/src/records.js'
import { bunClock, bunFetch } from '@cmodjs/core/src/runtime/bun.js'
import { measureDevice, MissingMachineId } from '@cmodjs/core/src/runtime/device.js'
import { routeSessions, sessionsInterface, storeInterface, wantsMessages, type HoldingOf, type Mail, type SessionComputer, type SessionContext, type SessionRouting, type StoreChange, type ToldAt, type VisitedAt } from '@cmodjs/core/src/runtime/interfaces.js'
import { RpcError, rpcCodes, type RpcConnection, type RpcRoutes } from '@cmodjs/core/src/runtime/rpc.js'
import type { SessionData, TaskData } from '@cmodjs/core/src/session/conversation.js'
import type { TaskStartArgs } from '@cmodjs/core/src/session/session.js'
import { activeSessions, startBackground, startTask, stopBackground, withBackgroundStatus } from './claude.js'
import { ifMissing, readJson, writeAtomically } from './files.js'
import { herdrTerminals } from './herdr.js'
import { capture } from './process.js'
import { hasExited } from './program.js'
import { backgroundTasks, foldersIn, hasTranscript, readUsage, runningEntries, runningFolder, transcriptPaths, type HistoryIndex, type RunningEntry } from './history.js'
import { observe } from './observer.js'
import { configRoot } from './settings.js'

export type SessionServer = SessionRouting & { visits(): Promise<VisitedAt> }

const olderPluginNames = ['cmod/SessionStore', 'cmod/Session']

const olderPluginPath = /^\/api\/sessions\/[\w-]{1,128}(\/events)?$/

const olderPluginPollMs = 8000

export function serveSessions({ index, report }: { readonly index: HistoryIndex; readonly report: (doing: string, error: unknown) => void }): SessionServer {
  const visitsPath = join(storeFolder(process.env), 'visited.json')
  let visited: Promise<VisitedAt> | undefined
  let writes = Promise.resolve()
  const device = measureDevice({ process: { run: (command) => capture([...command]) }, fs: { read: (path) => readFile(path, 'utf8') } }).then(
    async (read): Promise<Pick<SessionData, 'device'>> => {
      await writeAtomically(devicePath(storeFolder(process.env)), `${JSON.stringify(read)}\n`).catch((error: unknown) => report('reads this computer again in each session, because it did not write device.json', error))
      return { device: { id: read.id, name: read.name } }
    },
    (error: unknown): Pick<SessionData, 'device'> => {
      if (!(error instanceof MissingMachineId)) report('names its sessions and providers with no device', error)
      return {}
    },
  )
  const deviceNamedBy = async (task: unknown) => {
    const { device: here } = await device
    return isObject(task) && here !== undefined && (task['device'] === here.id || task['device'] === here.name) ? here : undefined
  }

  const readVisits = (): Promise<VisitedAt> =>
    (visited ??= readJson(visitsPath).then(
      (saved): VisitedAt => (isObject(saved) ? Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}),
      (error: unknown): VisitedAt => {
        report(`starts with no visits, because ${visitsPath} does not read`, error)
        return {}
      },
    ))

  const writeVisits = async (change: (visits: Record<string, string>) => void) => {
    const visits = { ...(await readVisits()) }
    change(visits)
    visited = Promise.resolve(visits)
    writes = writes.then(() => writeAtomically(visitsPath, `${JSON.stringify(visits, null, 2)}\n`)).catch((error: unknown) => report('kept the visits only in memory', error))
    await writes
  }

  const projectOf = (session: string, context: SessionContext, holding: HoldingOf) => holding(session)?.project ?? (typeof context['project'] === 'string' ? context['project'] : '')

  const mail = openMail(join(storeFolder(process.env), 'mail.sqlite'))

  const resume = async (session: string, project: string, input: unknown) => {
    const { text } = isObject(input) && typeof input['text'] === 'string' ? (input as { readonly text: string }) : { text: '' }
    if (text.trim() === '') throw new Error('send needs text.')
    if ((await activeSessions()).has(session)) throw runsUnreached(session, 'send')
    const cwd = (await index.getSession({ session, project, held: [] }))?.cwd ?? project
    return { session: await startBackground(['--resume', session, '--', text], cwd || process.cwd()) }
  }

  const statusOf = (entry: RunningEntry | undefined, told: ToldAt, session: string) => {
    const toldAt = told.get(session)
    return toldAt !== undefined && toldAt > (entry?.statusAt ?? 0) ? {} : recordedStatus(entry)
  }

  const sessionData = (session: SessionData, here: Pick<SessionData, 'device'>, visits: VisitedAt, records: ReadonlyMap<string, RunningEntry>, told: ToldAt): SessionData => ({
    ...session,
    ...here,
    isRunning: session.isRunning || told.has(session.id),
    ...(visits[session.id] === undefined ? {} : { visitedAt: visits[session.id] }),
    ...statusOf(records.get(session.id), told, session.id),
  })

  const diedAt = async (session: string, project: string, holding: HoldingOf): Promise<string | undefined> => {
    const record = runningEntries().find((entry) => entry.session === session)
    if (record !== undefined) return record.startedAt === undefined ? undefined : new Date(record.startedAt).toISOString()
    if (holding(session) !== undefined) return undefined
    return (await index.getSession({ session, project, held: [] }))?.lastAt
  }

  const withDeadTasks = (tasks: readonly TaskData[], died: string | undefined): TaskData[] =>
    tasks.map((task) => (died === undefined || task.closedAt !== undefined || task.isBackground === true || task.openedAt > died ? task : { ...task, closedAt: died, status: 'killed' }))

  const startTaskOn = async (here: { readonly name: string }, session: string, task: TaskStartArgs, project: string) => {
    const cwd = task.cwd ?? project
    if (!existsSync(cwd)) throw new Error(`${here.name} has no folder ${cwd}, so the task did not start. Give the task a cwd on ${here.name}.`)
    return startTask(session, { title: task.title, prompt: task.prompt, cwd, ...(task.agentType === undefined ? {} : { agentType: task.agentType }), ...(task.model === undefined ? {} : { model: task.model }) })
  }

  const stopped = (session: string) =>
    stopBackground(session).catch((error: unknown) => {
      report(`did not stop background session ${session}`, error)
      throw error
    })

  let lookAtTranscripts = () => undefined as void
  const routing = routeSessions({
    onListen: (listening) => (listening.interface === sessionsInterface && wantsMessages(listening) ? lookAtTranscripts() : undefined),
    device: async () => (await device).device ?? { id: '', name: '' },
    now: () => Date.now(),
    after: (ms, run) => setTimeout(run, ms).unref(),
    report: (error) => report('missed a message between sessions, programs, and devices', error),
    aliases: olderPluginNames,
    terminals: herdrTerminals,
    programs: {
      store: storeFolder(process.env),
      files: {
        list: async (path) => (await readdir(path, { withFileTypes: true }).catch(ifMissing([]))).map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'dir' : 'file' })),
        read: (path) => readFile(path, 'utf8').catch(ifMissing(undefined)),
      },
      fetch: bunFetch,
      clock: bunClock(true),
      hasExited,
    },
    computer: {
      async sessions(scope, _holding, told) {
        const [visits, here] = await Promise.all([readVisits(), device])
        const project = typeof scope['project'] === 'string' ? scope['project'] : undefined
        const records = new Map(runningEntries().map((entry) => [entry.session, entry]))
        const everyProject = scope['everyProject'] === true || project === undefined
        const since = typeof scope['since'] === 'string' ? scope['since'] : ''
        const listed = await index.listSessions({ project: project ?? '', everyProject, since, held: [...told.keys()], ...(typeof scope['running'] === 'boolean' ? { running: scope['running'] } : {}) })
        const isInScope = (session: SessionData) => (everyProject || session.cwd === project || session.cwd.startsWith(`${project}${sep}`)) && session.startedAt >= since
        const unindexed = scope['running'] === false ? [] : [...records.values()].filter((entry) => !listed.some((session) => session.id === entry.session)).map(recordedSession).filter(isInScope)
        return [...unindexed, ...listed].map((session) => sessionData(session, here, visits, records, told))
      },
      async session(session, holding, told) {
        const [visits, here] = await Promise.all([readVisits(), device])
        const held = holding(session)
        const records = new Map(runningEntries().map((entry) => [entry.session, entry]))
        const record = records.get(session)
        const found = (await index.getSession({ session, project: held?.project ?? '', held: [...told.keys()] })) ?? (record === undefined ? undefined : recordedSession(record)) ?? (held === undefined ? undefined : { id: session, title: '', project: held.project, cwd: held.cwd, model: '', startedAt: '', lastAt: '', isRunning: true })
        if (found === undefined) return undefined
        return sessionData(found, here, visits, records, told)
      },
      search(text, options) {
        const project = typeof options['project'] === 'string' ? options['project'] : undefined
        return index.searchMessages(text, {
          project: project ?? '',
          everyProject: options['everyProject'] === true || project === undefined,
          since: typeof options['since'] === 'string' ? options['since'] : undefined,
          ...(typeof options['running'] === 'boolean' ? { running: options['running'] } : {}),
          ...count('limit', options),
          ...(isObject(options['before']) ? { before: options['before'] as { session: string; id: string } } : {}),
          record: isObject(options['record']) ? options['record'] : {},
        })
      },
      async read(session, part, options, holding) {
        const project = typeof options['project'] === 'string' ? options['project'] : (holding(session)?.project ?? '')
        const task = taskOf(options)
        if (!hasTranscript(session, project)) {
          if (holding(session) === undefined && !runningEntries().some((entry) => entry.session === session)) throw new RpcError(rpcCodes.notHeld, `No session ${session} on this computer.`)
          return part === 'tasks' ? withBackgroundStatus(backgroundTasks(session), (error) => report('lists the background tasks with no status', error)) : emptyPart(part)
        }
        if (part === 'messages') return index.readMessages({ session, project, ...task, ...text('turn', options), ...text('after', options), ...count('last', options) })
        if (part === 'turns') return index.readTurns({ session, project, ...task, ...count('context', options), ...count('last', options) })
        if (part === 'contexts') return index.readContexts({ session, project, ...task })
        if (part === 'tasks') return withDeadTasks(await withBackgroundStatus(await index.readTasks({ session, project, ...task, ...(options['all'] === true ? { isNested: true } : {}) }), (error) => report('lists the background tasks with no status', error)), await diedAt(session, project, holding))
        if (part === 'goal') return index.readGoal({ session, project, ...task })
        if (part === 'usage') return readUsage({ session, project, ...task })
        if (part === 'state') return index.readState({ session, project })
        throw new RpcError(rpcCodes.invalidParams, `A session has no part ${part}. Read messages, turns, contexts, tasks, goal, usage, state, or mail.`)
      },
      async unheld(session, action, input, context, holding) {
        const named = action === 'startTask' ? await deviceNamedBy(input) : undefined
        if (named !== undefined) return startTaskOn(named, session, input as TaskStartArgs, projectOf(session, context, holding))
        if (action === 'end' && (await stopped(session))) return { ends: 'now' }
        if (runningEntries().some((entry) => entry.session === session)) throw runsUnreached(session, action)
        const project = projectOf(session, context, holding)
        if (!hasTranscript(session, project)) throw new RpcError(rpcCodes.notHeld, `No session ${session} on this computer.`)
        if (action === 'usage') return readUsage({ session, project, ...taskOf(context) })
        if (action === 'surfaces') return []
        if (action === 'end') return null
        if (action === 'send') return resume(session, project, input)
        throw new Error(`session ${session} has ended, so it takes no ${action}. Message it to resume it.`)
      },
      async visit(session, at, holding) {
        if (holding(session) === undefined && !hasTranscript(session, '')) throw new RpcError(rpcCodes.notHeld, `No session ${session} on this computer.`)
        await writeVisits((visits) => {
          visits[session] = at
        })
      },
      stop: stopped,
      async remove(session, context, holding) {
        if (runningEntries().some((entry) => entry.session === session)) throw new Error(`session ${session} runs, so it stays. End it first.`)
        if (!hasTranscript(session, projectOf(session, context, holding))) throw new RpcError(rpcCodes.notHeld, `No session ${session} on this computer.`)
        const cmod = dataFolder(storeFolder(process.env), 'cmod')
        for (const folder of foldersIn({ project: '', everyProject: true }).filter((each) => existsSync(join(each, `${session}.jsonl`)))) {
          await rm(join(folder, `${session}.jsonl`), { force: true })
          await rm(join(folder, session), { recursive: true, force: true })
        }
        await rm(join(cmod, 'goals', `${session}.txt`), { force: true })
        await rm(join(cmod, 'tasks', session), { recursive: true, force: true })
        await index.removeSession(session)
        await writeVisits((visits) => {
          delete visits[session]
        })
      },
      ...mail.computer,
    },
  })

  const statuses = () => new Map(runningEntries().map((entry) => [entry.session, { status: JSON.stringify(recordedStatus(entry)), name: entry.name }]))
  let told = statuses()
  const tellStatuses = () => {
    const read = statuses()
    for (const session of new Set([...told.keys(), ...read.keys()])) {
      const [before, after] = [told.get(session), read.get(session)]
      if (before === undefined || after === undefined) {
        routing.changed({ session, part: 'running' })
        lookAtTranscripts()
        continue
      }
      if (before.status !== after.status) routing.changed({ session, part: 'status' })
      if (before.name !== after.name) routing.changed({ session, part: 'title' })
    }
    told = read
  }
  const transcripts = new Map<string, string>()
  const listenedTranscripts = () => {
    const listened = routing.interfaces.listeners(sessionsInterface, 'Change').filter(wantsMessages)
    transcripts.clear()
    if (listened.length === 0) return []
    const running = new Map([...runningEntries().map((entry) => [entry.session, entry.cwd] as const), ...routing.heldSessions().map((held) => [held.session, held.project] as const)])
    const named = listened.flatMap(({ args }) => (typeof args?.[0] === 'string' && args[0] !== '*' ? [args[0]] : []))
    const isEvery = named.length < listened.length
    for (const session of new Set([...named, ...(isEvery ? running.keys() : [])])) for (const path of transcriptPaths(session, running.get(session) ?? '')) transcripts.set(path, session)
    return [...transcripts.keys()]
  }
  const pluginsFile = join(configRoot(), 'plugins', 'installed_plugins.json')
  mkdirSync(runningFolder(), { recursive: true })
  const messages = observe({
    folders: () => [...new Set([...transcripts.keys()].map(dirname))],
    isRecursive: false,
    list: async () => listenedTranscripts(),
    onChange: (changed) => {
      for (const session of new Set([...changed.keys()].flatMap((path) => transcripts.get(path) ?? []))) routing.changed({ session, part: 'messages' })
    },
    report: (error) => report("missed a change of a session's messages", error),
  })
  lookAtTranscripts = () => void messages.look()
  const observers = [
    messages,
    observe({
      folders: () => [runningFolder()],
      isRecursive: false,
      list: async () => (await readdir(runningFolder()).catch(ifMissing([]))).filter((name) => name.endsWith('.json')).map((name) => join(runningFolder(), name)),
      onChange: tellStatuses,
      report: (error) => report('kept the statuses of the sessions it read last', error),
    }),
    observe({
      folders: () => [dirname(pluginsFile)],
      isRecursive: false,
      list: async () => [pluginsFile],
      onChange: () => routing.interfaces.emit(storeInterface, 'Change', { part: 'plugins' } satisfies StoreChange),
      report: (error) => report("missed a change of Claude Code's installed plugins", error),
    }),
  ]

  return {
    ...routing,
    visits: readVisits,
    close: () => {
      for (const observer of observers) observer.close()
      routing.close()
      mail.close()
    },
  }
}

type MailRow = { id: number; session: string; from: string | null; fromTitle: string | null; caller: string | null; type: Mail['type']; text: string; replyTo: number | null; asUser: number; sentAt: string; deliveredAt: string | null }

const mailSchema = `create table mail (
  id integer primary key autoincrement,
  session text not null,
  "from" text,
  fromTitle text,
  caller text,
  type text not null,
  text text not null,
  replyTo integer,
  asUser integer not null,
  sentAt text not null,
  deliveredAt text
);
create index mail_by_session on mail (session, deliveredAt, id);
pragma user_version = 1;`

function openMail(path: string): { readonly computer: Pick<SessionComputer, 'queue' | 'queued' | 'delivered' | 'mail'>; close(): void } {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  if (db.query<{ user_version: number }, []>('pragma user_version').get()?.user_version === 0) db.transaction(() => db.exec(mailSchema))()
  const mailOf = (row: MailRow): Mail => ({
    id: row.id,
    session: row.session,
    ...(row.from === null ? {} : { from: row.from }),
    ...(row.fromTitle === null ? {} : { fromTitle: row.fromTitle }),
    ...(row.caller === null ? {} : { caller: row.caller }),
    type: row.type,
    text: row.text,
    ...(row.replyTo === null ? {} : { replyTo: row.replyTo }),
    asUser: row.asUser === 1,
    sentAt: row.sentAt,
    ...(row.deliveredAt === null ? {} : { deliveredAt: row.deliveredAt }),
  })
  return {
    computer: {
      queue: async (sent) =>
        Number(
          db
            .query('insert into mail (session, "from", fromTitle, caller, type, text, replyTo, asUser, sentAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(sent.session, sent.from ?? null, sent.fromTitle ?? null, sent.caller ?? null, sent.type, sent.text, sent.replyTo ?? null, sent.asUser ? 1 : 0, sent.sentAt).lastInsertRowid,
        ),
      queued: async (session) => db.query<MailRow, [string]>('select * from mail where session = ? and deliveredAt is null order by id').all(session).map(mailOf),
      delivered: async (id, at) => void db.query('update mail set deliveredAt = ? where id = ?').run(at, id),
      mail: async (session, { last }) => db.query<MailRow, [string, string, number]>('select * from (select * from mail where session = ? or "from" = ? order by id desc limit ?) order by id').all(session, session, last ?? -1).map(mailOf),
    },
    close: () => db.close(),
  }
}

function runsUnreached(session: string, action: string): Error {
  return new Error(`Session ${session} runs, but no cmod plugin in it reaches cmod serve, so it takes no ${action}, and cmod starts no copy of it. Run /reload-plugins in it.`)
}

function recordedSession(entry: RunningEntry): SessionData {
  const startedAt = entry.startedAt === undefined ? '' : new Date(entry.startedAt).toISOString()
  return { id: entry.session, title: entry.name ?? '', project: entry.cwd, cwd: entry.cwd, model: '', startedAt, lastAt: startedAt, isRunning: true }
}

function recordedStatus(entry: RunningEntry | undefined): Pick<SessionData, 'status' | 'waitingFor'> {
  if (entry?.status === undefined) return {}
  return { status: entry.status, ...(entry.status === 'waiting' && entry.waitingFor !== undefined ? { waitingFor: { dialog: entry.waitingFor } } : {}) }
}

export type AppServer = ServeApps & { stop(): Promise<void> }

const appsPath = '/ui'

const unreadMessage = 1003

export function serveApps(routes: RpcRoutes, report: (doing: string, error: unknown) => void): AppServer {
  const token = randomBytes(32).toString('base64url')
  const isToken = (given: string | null) => given !== null && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token))
  const server = Bun.serve<{ connection?: RpcConnection }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname !== appsPath) return Response.json({ error: `cmod serve has no ${url.pathname}. Apps connect to ${appsPath}.` }, { status: 404 })
      if (!isToken(url.searchParams.get('token'))) return Response.json({ error: 'cmod serve takes the token serve.json in the cmod store gives.' }, { status: 401 })
      return server.upgrade(request, { data: {} }) ? undefined : Response.json({ error: `${appsPath} takes a WebSocket.` }, { status: 426 })
    },
    websocket: {
      open(socket) {
        socket.data.connection = routes.channel((message) => void socket.send(JSON.stringify(message)))
      },
      message(socket, data) {
        let message: unknown
        try {
          message = JSON.parse(String(data))
        } catch (error) {
          report('closed an app that sent a message that is not JSON', error)
          return socket.close(unreadMessage, 'cmod serve reads JSON-RPC messages only.')
        }
        socket.data.connection?.receive(message)
      },
      close(socket) {
        socket.data.connection?.close(new Error('the app closed its connection'))
      },
    },
  })
  return { url: `ws://127.0.0.1:${server.port}${appsPath}`, token, stop: () => server.stop(true) }
}

export function answered(routes: RpcRoutes, request: Request): Promise<Response> | undefined {
  const answer = routes.route({ method: request.method, path: `${new URL(request.url).pathname}${new URL(request.url).search}`, signal: request.signal, json: () => request.json() })
  return answer?.then(({ status, json }) => (json === undefined ? new Response(null, { status }) : Response.json(json, { status })))
}

export function answeredOlderPlugin(request: Request): Promise<Response> | undefined {
  const matched = olderPluginPath.exec(new URL(request.url).pathname)
  if (matched === null) return undefined
  const isPoll = matched[1] !== undefined
  if (request.method !== (isPoll ? 'GET' : 'POST')) return undefined
  if (!isPoll) return Promise.resolve(Response.json({}))
  return new Promise((resolve) => {
    const answer = () => {
      clearTimeout(timer)
      resolve(Response.json({ views: [], actions: [] }))
    }
    const timer = setTimeout(answer, olderPluginPollMs)
    request.signal.addEventListener('abort', answer, { once: true })
  })
}

function taskOf(options: Readonly<Record<string, unknown>>): { readonly task?: string } {
  return typeof options['task'] === 'string' ? { task: options['task'] } : {}
}

function text(key: string, options: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  return typeof options[key] === 'string' ? { [key]: options[key] } : {}
}

function count(key: string, options: Readonly<Record<string, unknown>>): Readonly<Record<string, number>> {
  return typeof options[key] === 'number' ? { [key]: options[key] } : {}
}

function emptyPart(part: string): unknown {
  if (part === 'goal') return { text: '' }
  if (part === 'usage') return { model: '', contextWindow: {} }
  if (part === 'state') return undefined
  return []
}

