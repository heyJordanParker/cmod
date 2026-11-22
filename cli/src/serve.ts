import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, watch } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dataFolder, isObject, storeFolder, type ServeApps } from '@cmodjs/core/src/records.js'
import { bunFetch } from '@cmodjs/core/src/runtime/bun.js'
import { MissingMachineId, readDevice } from '@cmodjs/core/src/runtime/device.js'
import { routeSessions, type HoldingOf, type SessionContext, type SessionRouting, type VisitedAt } from '@cmodjs/core/src/runtime/interfaces.js'
import { RpcError, rpcCodes, type RpcConnection, type RpcRoutes } from '@cmodjs/core/src/runtime/rpc.js'
import type { SessionData } from '@cmodjs/core/src/session/conversation.js'
import type { TaskStartArgs } from '@cmodjs/core/src/session/session.js'
import { startBackground, startTask, withBackgroundStatus } from './claude.js'
import { ifMissing, readJson, writeAtomically } from './files.js'
import { herdrTerminals } from './herdr.js'
import { capture } from './process.js'
import { foldersIn, hasTranscript, readUsage, runningEntries, runningFolder, type HistoryIndex, type RunningEntry } from './history.js'

export type SessionServer = SessionRouting & { visits(): Promise<VisitedAt> }

const olderPluginNames = ['cmod/SessionStore', 'cmod/Session']

const olderPluginPath = /^\/api\/sessions\/[\w-]{1,128}(\/events)?$/

const olderPluginPollMs = 8000

const registryQuietMs = 300

export function serveSessions({ index, report }: { readonly index: HistoryIndex; readonly report: (doing: string, error: unknown) => void }): SessionServer {
  const visitsPath = join(storeFolder(process.env), 'visited.json')
  let visited: Promise<VisitedAt> | undefined
  let writes = Promise.resolve()
  const device = readDevice({ process: { run: (command) => capture([...command]) }, fs: { read: (path) => readFile(path, 'utf8') } }).then(
    ({ id, name }): Pick<SessionData, 'device'> => ({ device: { id, name } }),
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

  const resume = async (session: string, project: string, input: unknown) => {
    const { text } = isObject(input) && typeof input['text'] === 'string' ? (input as { readonly text: string }) : { text: '' }
    if (text.trim() === '') throw new Error('send needs text.')
    const cwd = (await index.listSessions({ project, everyProject: true, since: undefined })).find((each) => each.id === session)?.cwd ?? project
    return { session: await startBackground(['--resume', session, '--', text], cwd || process.cwd()) }
  }

  const startTaskOn = async (here: { readonly name: string }, session: string, task: TaskStartArgs, project: string) => {
    const cwd = task.cwd ?? project
    if (!existsSync(cwd)) throw new Error(`${here.name} has no folder ${cwd}, so the task did not start. Give the task a cwd on ${here.name}.`)
    return startTask(session, { title: task.title, prompt: task.prompt, cwd, ...(task.agentType === undefined ? {} : { agentType: task.agentType }), ...(task.model === undefined ? {} : { model: task.model }) })
  }

  const routing = routeSessions({
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
      wait: (ms) => Bun.sleep(ms),
    },
    computer: {
      async sessions(scope, _holding, held) {
        const [visits, here] = await Promise.all([readVisits(), device])
        const project = typeof scope['project'] === 'string' ? scope['project'] : undefined
        const records = new Map(runningEntries().map((entry) => [entry.session, entry]))
        return (await index.listSessions({ project: project ?? '', everyProject: scope['everyProject'] === true || project === undefined, since: typeof scope['since'] === 'string' ? scope['since'] : undefined, ...(typeof scope['running'] === 'boolean' ? { running: scope['running'] } : {}) })).map(
          (session): SessionData => ({ ...session, ...here, isRunning: session.isRunning || held.has(session.id), ...(visits[session.id] === undefined ? {} : { visitedAt: visits[session.id] }), ...recordedStatus(records.get(session.id)) }),
        )
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
          if (holding(session) !== undefined) return emptyPart(part)
          throw new RpcError(rpcCodes.notHeld, `No session ${session} on this computer.`)
        }
        if (part === 'messages') return index.readMessages({ session, project, ...task, ...text('turn', options), ...text('after', options), ...count('last', options) })
        if (part === 'turns') return index.readTurns({ session, project, ...task, ...count('context', options), ...count('last', options) })
        if (part === 'contexts') return index.readContexts({ session, project, ...task })
        if (part === 'tasks') return withBackgroundStatus(await index.readTasks({ session, project, ...task, ...(options['all'] === true ? { isNested: true } : {}) }), (error) => report('lists the background tasks with no status', error))
        if (part === 'goal') return index.readGoal({ session, project, ...task })
        if (part === 'usage') return readUsage({ session, project, ...task })
        if (part === 'state') return index.readState({ session, project })
        throw new RpcError(rpcCodes.invalidParams, `A session has no part ${part}. Read messages, turns, contexts, tasks, goal, usage, or state.`)
      },
      async unheld(session, action, input, context, holding) {
        const named = action === 'startTask' ? await deviceNamedBy(input) : undefined
        if (named !== undefined) return startTaskOn(named, session, input as TaskStartArgs, projectOf(session, context, holding))
        if (runningEntries().some((entry) => entry.session === session)) throw new RpcError(rpcCodes.notHeld, `Session ${session} runs a cmod plugin from before 7.0.0, so it takes no ${action}. Reload it with /reload-plugins.`)
        const project = projectOf(session, context, holding)
        if (!hasTranscript(session, project)) throw new RpcError(rpcCodes.notHeld, `No session ${session} on this computer.`)
        if (action === 'usage') return readUsage({ session, project, ...taskOf(context) })
        if (action === 'surfaces') return []
        if (action === 'end') return null
        if (action === 'send') return resume(session, project, input)
        throw new Error(`session ${session} has ended, so it takes no ${action}. Message it to resume it.`)
      },
      visit: (session, at) =>
        writeVisits((visits) => {
          visits[session] = at
        }),
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
    },
  })

  const following = new AbortController()
  const statuses = () => new Map(runningEntries().map((entry) => [entry.session, JSON.stringify(recordedStatus(entry))]))
  let told = statuses()
  let timer: ReturnType<typeof setTimeout> | undefined
  const tellStatuses = () => {
    timer = undefined
    try {
      const read = statuses()
      for (const session of new Set([...told.keys(), ...read.keys()])) {
        if (told.has(session) !== read.has(session)) routing.changed({ session, part: 'running' })
        else if (told.get(session) !== read.get(session)) routing.changed({ session, part: 'status' })
      }
      told = read
    } catch (error) {
      report('kept the statuses of the sessions it read last', error)
    }
  }
  mkdirSync(runningFolder(), { recursive: true })
  watch(runningFolder(), { signal: following.signal })
    .on('change', () => void (timer ??= setTimeout(tellStatuses, registryQuietMs)))
    .on('error', (error) => {
      if (!following.signal.aborted) report('stopped following the session records', error)
    })

  return {
    ...routing,
    visits: readVisits,
    close: () => {
      following.abort()
      clearTimeout(timer)
      routing.close()
    },
  }
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

