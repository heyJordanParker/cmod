import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { dataFolder, isObject, storeFolder } from '@cmodjs/core/src/records.js'
import { routeSessions, type HoldingOf, type SessionContext, type SessionRouting, type VisitedAt } from '@cmodjs/core/src/runtime/interfaces.js'
import { RpcError, rpcCodes, type RpcRoutes } from '@cmodjs/core/src/runtime/rpc.js'
import type { SessionData } from '@cmodjs/core/src/session/conversation.js'
import { startBackground, withBackgroundStatus } from './claude.js'
import { readJson, writeAtomically } from './files.js'
import { foldersIn, hasTranscript, listSessions, readContexts, readGoal, readMessages, readState, readTasks, readTurns, readUsage, runningEntries, searchMessages } from './history.js'

export type SessionServer = SessionRouting & { visits(): Promise<VisitedAt> }

export function serveSessions({ db, report }: { readonly db: Database; readonly report: (doing: string, error: unknown) => void }): SessionServer {
  const visitsPath = join(storeFolder(process.env), 'visited.json')
  let visited: Promise<VisitedAt> | undefined
  let writes = Promise.resolve()

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
    const cwd = listSessions(db, { project, everyProject: true, since: undefined }).find((each) => each.id === session)?.cwd ?? project
    return { session: await startBackground(['--resume', session, '--', text], cwd || process.cwd()) }
  }

  const routing = routeSessions({
    now: () => Date.now(),
    computer: {
      async sessions(scope, _holding, held) {
        const visits = await readVisits()
        const project = typeof scope['project'] === 'string' ? scope['project'] : undefined
        return listSessions(db, { project: project ?? '', everyProject: scope['everyProject'] === true || project === undefined, since: typeof scope['since'] === 'string' ? scope['since'] : undefined, ...(typeof scope['running'] === 'boolean' ? { running: scope['running'] } : {}) }).map(
          (session): SessionData => ({ ...session, isRunning: session.isRunning || held.has(session.id), ...(visits[session.id] === undefined ? {} : { visitedAt: visits[session.id] }) }),
        )
      },
      search(text, options) {
        const project = typeof options['project'] === 'string' ? options['project'] : undefined
        return searchMessages(db, text, {
          project: project ?? '',
          everyProject: options['everyProject'] === true || project === undefined,
          since: typeof options['since'] === 'string' ? options['since'] : undefined,
          ...(typeof options['running'] === 'boolean' ? { running: options['running'] } : {}),
          ...count('limit', options),
          ...(isObject(options['before']) ? { before: options['before'] as { session: string; id: string } } : {}),
          record: isObject(options['record']) ? options['record'] : {},
        })
      },
      read(session, part, options, holding) {
        const project = typeof options['project'] === 'string' ? options['project'] : (holding(session)?.project ?? '')
        const task = taskOf(options)
        if (!hasTranscript(session, project)) {
          if (holding(session) !== undefined) return emptyPart(part)
          throw new RpcError(rpcCodes.notHeld, `No session ${session} on this computer.`)
        }
        if (part === 'messages') return readMessages(db, { session, project, ...task, ...text('turn', options), ...text('after', options), ...count('last', options) })
        if (part === 'turns') return readTurns(db, { session, project, ...task, ...count('context', options), ...count('last', options) })
        if (part === 'contexts') return readContexts(db, { session, project, ...task })
        if (part === 'tasks') return withBackgroundStatus(readTasks(db, { session, project, ...task, ...(options['all'] === true ? { isNested: true } : {}) }), (error) => report('lists the background tasks with no status', error))
        if (part === 'goal') return readGoal(db, { session, project, ...task })
        if (part === 'usage') return readUsage({ session, project, ...task })
        if (part === 'state') return readState(db, { session, project })
        throw new RpcError(rpcCodes.invalidParams, `A session has no part ${part}. Read messages, turns, contexts, tasks, goal, usage, or state.`)
      },
      async unheld(session, action, input, context, holding) {
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
        db.query('delete from messages where session = ?').run(session)
        db.query('delete from sessions where id = ?').run(session)
        await writeVisits((visits) => {
          delete visits[session]
        })
      },
    },
  })
  return { ...routing, visits: readVisits }
}

export function answered(routes: RpcRoutes, request: Request): Promise<Response> | undefined {
  const answer = routes.route({ method: request.method, path: new URL(request.url).pathname, signal: request.signal, json: () => request.json() })
  return answer?.then(({ status, json }) => (json === undefined ? new Response(null, { status }) : Response.json(json, { status })))
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

