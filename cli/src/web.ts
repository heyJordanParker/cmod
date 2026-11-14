import { randomBytes } from 'node:crypto'
import { mkdirSync, watch } from 'node:fs'
import { basename } from 'node:path'
import type { Server } from 'bun'
import { isObject } from '@cmodjs/core/src/records.js'
import { htmlOf, type ClosedPage, type ElementData, type HandlerData, type SessionAbout, type SessionEvents, type SessionWait, type WebAction, type WebDrawing, type WebInput, type WebView } from '@cmodjs/core/src/runtime/web.js'
import { Message, type Message as SessionMessage } from '@cmodjs/core/src/session/context/turn/message/message.js'
import { Prompt } from '@cmodjs/core/src/session/context/turn/message/prompt.js'
import { Reply } from '@cmodjs/core/src/session/context/turn/message/reply.js'
import { ToolCall } from '@cmodjs/core/src/session/context/turn/message/tool-call.js'
import { ToolResult } from '@cmodjs/core/src/session/context/turn/message/tool-result.js'
import { TurnEnd, TurnStart } from '@cmodjs/core/src/session/context/turn/turn.js'
import type { SessionChange, SessionData } from '@cmodjs/core/src/session/conversation.js'
import { firstLine, messageOf } from '@cmodjs/core/src/utils/text.js'
import { readJson, writeAtomically } from './files.js'
import { followSessions, hasTranscript, listSessions, openHistory, readMessages, readState, readTurns, runningEntries, runningFolder, type RunningEntry } from './history.js'
import { storePath } from './store.js'
import { appScreen, conversationTab, groupOrder, listColumns, visibleRows, webPage, type AgentRow, type FeedItem, type Group, type PressInput, type Screen, type ScreenActions } from './web-page.js'

const pollMs = 15_000

const idleSeconds = 30

const liveMs = 20_000

const sweepMs = 5000

const registryQuietMs = 300

const summaryQuietMs = 1000

const redrawMs = 30

const keptStreamMs = 600_000

const keptMessages = 200

const feedMessages = 80

const fewestColumns = 40

const questionTool = 'AskUserQuestion'

const sdkEntrypoint = 'sdk-cli'

const stoppedRunning = 'Stopped, and a command still runs in its terminal'

const inputKinds: ReadonlySet<unknown> = new Set(['press', 'change', 'submit', 'select', 'link'])

const sessionPath = /^\/api\/sessions\/([\w-]{1,128})(\/events)?$/

type Waiter = (events: SessionEvents) => void

type Posted = {
  about: SessionAbout | undefined
  seenAt: number
  waiter: Waiter | undefined
  actions: WebAction[]
  told: string
  readonly drawings: Map<string, { readonly draw: number; readonly tree: unknown }>
}

type Call = { readonly name: string; readonly input: Readonly<Record<string, unknown>> }

type Agent = {
  entry: RunningEntry
  summary: SessionData | undefined
  isTurnOpen: boolean
  closedAt: string | undefined
  readonly openCalls: Map<string, Call>
  messages: SessionMessage[]
  readonly stop: AbortController
}

type PressHandler = (input: PressInput) => void

type Stream = {
  readonly id: string
  send: ((event: string, data: object) => void) | undefined
  columns: number
  cursor: string | undefined
  tab: string
  isIdleOpen: boolean
  focus: Screen['focus']
  sent: number
  notice: string | undefined
  draw: number
  html: string
  seenAt: number
  timer: ReturnType<typeof setTimeout> | undefined
  readonly handlers: Map<number, readonly PressHandler[]>
}

export type WebServer = { readonly port: number; stop(): Promise<void> }

class Refusal extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function serveWeb({ port }: { readonly port: number }): WebServer {
  const db = openHistory()
  const posted = new Map<string, Posted>()
  const agents = new Map<string, Agent>()
  const streams = new Map<string, Stream>()
  const encoder = new TextEncoder()
  const marksPath = storePath('web-read.json')
  let marks = new Map<string, string>()
  let summaryTimer: ReturnType<typeof setTimeout> | undefined
  let registryTimer: ReturnType<typeof setTimeout> | undefined
  const following = new AbortController()

  const report = (doing: string, error: unknown) => process.stderr.write(`cmod web serve: ${doing}: ${messageOf(error)}\n`)

  const { CMOD_TAILNET_NAME: tailnetName = '', CMOD_TAILNET_LOGIN: tailnetLogin = '' } = process.env
  const isOwnTailnet = (request: Request, host: string) => tailnetName !== '' && host.replace(/:\d+$/, '') === tailnetName && request.headers.get('tailscale-user-login') === tailnetLogin

  const postedOf = (id: string): Posted => {
    const known = posted.get(id)
    if (known !== undefined) return known
    const created: Posted = { about: undefined, seenAt: Date.now(), waiter: undefined, actions: [], told: '', drawings: new Map() }
    posted.set(id, created)
    return created
  }
  const isLive = (session: Posted) => session.waiter !== undefined || Date.now() - session.seenAt < liveMs
  const aboutOf = (id: string) => {
    const session = posted.get(id)
    return session !== undefined && isLive(session) ? session.about : undefined
  }

  const lastTurnOf = (agent: Agent) => {
    const told = aboutOf(agent.entry.session)
    if (told?.isWorking !== undefined) return told.isWorking ? undefined : told.lastTurn
    return agent.isTurnOpen || agent.closedAt === undefined ? undefined : { reason: 'answered' as const, at: agent.closedAt }
  }
  const askedOf = (agent: Agent): SessionWait | undefined => {
    const asked = [...agent.openCalls.values()].findLast((call) => call.name === questionTool)
    const question = (asked?.input['questions'] as readonly { readonly question?: unknown }[] | undefined)?.[0]?.question
    return typeof question === 'string' ? { kind: 'question', question } : undefined
  }
  const waitOf = (agent: Agent): string | undefined => {
    const { status, waitingFor } = agent.entry
    const told = aboutOf(agent.entry.session)
    const wait = status === 'waiting' || status === undefined ? (told?.isWorking === undefined ? askedOf(agent) : told.waiting) : undefined
    if (wait !== undefined) return wait.kind === 'question' ? `Asks: ${wait.question}` : `Wants to run ${wait.tool}: ${callSummary(wait.input)}`
    if (status !== 'waiting') return undefined
    return waitingFor === 'permission prompt' ? 'Wants permission to run a tool' : waitingFor === 'input needed' ? 'Asks you a question' : `Waits on ${waitingFor ?? 'you'} in its terminal`
  }
  const isWorking = (agent: Agent) => aboutOf(agent.entry.session)?.isWorking ?? agent.isTurnOpen
  const lastReply = (agent: Agent) => agent.messages.findLast((message) => message.type === Reply)

  const rowOf = (agent: Agent): AgentRow => {
    const { entry, summary } = agent
    const wait = waitOf(agent)
    const ended = lastTurnOf(agent)
    const isUnread = ended !== undefined && marks.get(entry.session) !== ended.at
    const reply = lastReply(agent)
    const replyLine = reply === undefined ? '' : firstLine(reply.text)
    const current = [...agent.openCalls.values()].at(-1)
    const isStillRunning = ended?.reason === 'stopped' && entry.status === 'shell'
    const [group, reason]: readonly [Group, string] =
      wait !== undefined
        ? ['needs', wait]
        : ended !== undefined && ended.reason !== 'answered' && isUnread
          ? ['needs', isStillRunning ? stoppedRunning : ended.reason === 'stopped' ? 'Stopped before it answered' : `Failed: ${ended.failure ?? 'the turn ended on an error'}`]
          : isWorking(agent)
            ? ['working', current === undefined ? 'Thinking' : `${current.name}: ${callSummary(current.input)}`]
            : ended?.reason === 'answered' && isUnread
              ? ['replied', replyLine]
              : ['idle', isStillRunning ? stoppedRunning : replyLine === '' ? 'No reply yet' : replyLine]
    const at = [summary?.lastAt ?? '', agent.messages.at(-1)?.at ?? '', ended?.at ?? ''].reduce((latest, each) => (each > latest ? each : latest), '')
    const project = summary?.project || entry.cwd
    return {
      id: entry.session,
      title: entry.name ?? basename(project),
      ...(summary?.color === undefined ? {} : { color: summary.color }),
      project: basename(project),
      group,
      reason,
      at,
      isUnread: isUnread && (group === 'needs' || group === 'replied'),
    }
  }
  const rows = () =>
    [...agents.values()]
      .map(rowOf)
      .sort((first, second) => groupOrder.indexOf(first.group) - groupOrder.indexOf(second.group) || second.at.localeCompare(first.at))

  const feedOf = (agent: Agent): FeedItem[] =>
    agent.messages.slice(-feedMessages).flatMap((message): FeedItem[] => {
      if (message.type === Prompt) return [{ id: message.id, kind: 'prompt', text: message.text }]
      if (message.type === Reply) return [{ id: message.id, kind: 'reply', text: message.text }]
      if (message.type === ToolCall) return [{ id: message.id, kind: 'tool', text: `${message.name}  ${callSummary(message.input)}` }]
      return []
    })

  const viewOf = (stream: Stream): WebView | undefined => {
    if (stream.cursor === undefined || stream.tab === conversationTab || aboutOf(stream.cursor) === undefined) return undefined
    const columns = Math.max(stream.columns - listColumns - 2, fewestColumns)
    return { id: `${columns}:${stream.tab}`, tab: stream.tab, columns }
  }
  const viewsOf = (id: string): WebView[] => {
    const views = new Map<string, WebView>()
    for (const stream of streams.values()) {
      const view = stream.send === undefined || stream.cursor !== id ? undefined : viewOf(stream)
      if (view !== undefined) views.set(view.id, view)
    }
    return [...views.values()]
  }

  const forwarded = (tree: unknown, session: string, view: string, draw: number, on: (run: PressHandler) => HandlerData): unknown => {
    if (Array.isArray(tree)) return tree.map((each: unknown) => forwarded(each, session, view, draw, on))
    if (!isObject(tree)) return tree
    const handler = tree['$cmodHandler']
    if (typeof handler === 'number') return on((input) => queue(session, { type: 'press', view, draw, handler, key: input.key, kind: input.kind as WebInput['kind'], ...(input.value === undefined ? {} : { value: input.value }), ...(input.href === undefined ? {} : { href: input.href }) }))
    return Object.fromEntries(Object.entries(tree).map(([key, each]) => [key, forwarded(each, session, view, draw, on)]))
  }

  const queue = (id: string, action: WebAction): boolean => {
    const session = posted.get(id)
    if (session === undefined || !isLive(session)) return false
    session.actions.push(action)
    wake(id)
    return true
  }

  let markWrites = Promise.resolve()
  const writeMarks = () => {
    const running = new Set(agents.keys())
    marks = new Map([...marks].filter(([id]) => running.has(id)))
    const text = `${JSON.stringify(Object.fromEntries(marks), null, 2)}\n`
    markWrites = markWrites.then(() => writeAtomically(marksPath, text)).catch((error: unknown) => void report(`kept the read marks only in memory, because ${marksPath} could not be written`, error))
  }

  const actionsOf = (stream: Stream): ScreenActions => {
    const at = () => (stream.cursor === undefined ? undefined : agents.get(stream.cursor))
    const ended = () => {
      const agent = at()
      return agent === undefined ? undefined : lastTurnOf(agent)
    }
    const move = (by: number) => {
      const shown = visibleRows({ rows: rows(), ...(stream.cursor === undefined ? {} : { cursor: stream.cursor }), isIdleOpen: stream.isIdleOpen })
      const index = shown.findIndex((row) => row.id === stream.cursor)
      const next = shown[Math.min(Math.max(index + by, 0), shown.length - 1)]
      if (next !== undefined && next.id !== stream.cursor) {
        stream.cursor = next.id
        stream.tab = conversationTab
      }
      stream.focus = 'row'
      stream.notice = undefined
    }
    return {
      move,
      open(session) {
        stream.cursor = session
        stream.focus = 'prompt'
        stream.notice = undefined
        const agent = agents.get(session)
        const last = agent === undefined ? undefined : lastTurnOf(agent)
        if (last?.reason !== 'answered') return
        marks.set(session, last.at)
        writeMarks()
      },
      done() {
        const last = ended()
        if (stream.cursor === undefined || last === undefined) return
        marks.set(stream.cursor, last.at)
        writeMarks()
        move(1)
      },
      unread() {
        if (stream.cursor === undefined || !marks.delete(stream.cursor)) return
        writeMarks()
      },
      toggleIdle() {
        stream.isIdleOpen = !stream.isIdleOpen
      },
      showTab(tab) {
        stream.tab = tab
      },
      closeTab(tab) {
        if (stream.cursor === undefined) return
        queue(stream.cursor, { type: 'close', tab })
        if (stream.tab === tab) stream.tab = conversationTab
      },
      openPage(page: ClosedPage) {
        if (stream.cursor === undefined) return
        if (queue(stream.cursor, { type: 'open', mod: page.mod, page: page.page })) stream.tab = `${page.mod}/${page.page}`
      },
      prompt(text) {
        const agent = at()
        if (agent === undefined || text.trim() === '') return
        if (!queue(agent.entry.session, { type: 'prompt', text })) {
          stream.notice = "This session's cmod plugin does not answer the browser app, so type the prompt in its terminal."
          return
        }
        stream.sent += 1
        stream.focus = 'prompt'
        stream.notice = undefined
      },
      stop() {
        if (stream.cursor !== undefined && !queue(stream.cursor, { type: 'stop' })) stream.notice = "This session's cmod plugin does not answer the browser app, so press Esc in its terminal."
      },
    }
  }

  const screenOf = (stream: Stream, on: (run: PressHandler) => HandlerData): Screen => {
    const listed = rows()
    if (stream.cursor === undefined || !agents.has(stream.cursor)) stream.cursor = listed[0]?.id
    const agent = stream.cursor === undefined ? undefined : agents.get(stream.cursor)
    if (agent === undefined) return { rows: listed, tab: stream.tab, isIdleOpen: stream.isIdleOpen, focus: stream.focus, sent: stream.sent, ...(stream.notice === undefined ? {} : { notice: stream.notice }) }
    const row = listed.find((each) => each.id === agent.entry.session) ?? rowOf(agent)
    const told = aboutOf(agent.entry.session)
    if (told === undefined || (stream.tab !== conversationTab && !told.tabs.some((tab) => tab.key === stream.tab))) stream.tab = conversationTab
    const view = viewOf(stream)
    const drawn = view === undefined ? undefined : posted.get(agent.entry.session)?.drawings.get(view.id)
    const wait = waitOf(agent)
    return {
      rows: listed,
      cursor: agent.entry.session,
      tab: stream.tab,
      isIdleOpen: stream.isIdleOpen,
      focus: stream.focus,
      sent: stream.sent,
      ...(stream.notice === undefined ? {} : { notice: stream.notice }),
      open: {
        row,
        model: agent.summary?.model ?? '',
        ...(told?.contextPercent === undefined ? {} : { contextPercent: told.contextPercent }),
        isWorking: isWorking(agent),
        ...(wait === undefined || row.group !== 'needs' ? {} : { waiting: row.reason }),
        ...(row.reason === stoppedRunning ? { state: stoppedRunning } : {}),
        feed: feedOf(agent),
        tabs: told?.tabs ?? [],
        pages: told?.pages ?? [],
        ...(view === undefined || drawn === undefined ? {} : { page: forwarded(drawn.tree, agent.entry.session, view.id, drawn.draw, on) as ElementData }),
      },
    }
  }

  const render = (stream: Stream) => {
    stream.timer = undefined
    if (stream.send === undefined) return
    const handlers: PressHandler[] = []
    const on = (run: PressHandler): HandlerData => ({ $cmodHandler: handlers.push(run) - 1 })
    const html = htmlOf(appScreen(screenOf(stream, on), actionsOf(stream), on))
    if (stream.focus === 'prompt') {
      stream.focus = 'row'
      redrawSoon(stream)
    }
    if (html === stream.html) return
    stream.draw += 1
    stream.handlers.set(stream.draw, handlers)
    stream.handlers.delete(stream.draw - 2)
    stream.html = html
    stream.send('screen', { draw: stream.draw, html })
  }
  const redrawSoon = (stream: Stream) => {
    stream.timer ??= setTimeout(() => render(stream), redrawMs)
  }
  const redrawAll = () => {
    for (const stream of streams.values()) redrawSoon(stream)
  }

  const answer = (session: Posted, id: string) => {
    const { waiter, actions } = session
    if (waiter === undefined) return
    const views = viewsOf(id)
    session.waiter = undefined
    session.told = JSON.stringify(views)
    session.actions = []
    waiter({ views, actions })
  }
  const wake = (id: string) => {
    const session = posted.get(id)
    if (session?.waiter !== undefined && (session.actions.length > 0 || JSON.stringify(viewsOf(id)) !== session.told)) answer(session, id)
  }
  const wakeAll = () => {
    for (const id of posted.keys()) wake(id)
  }

  const poll = (id: string, signal: AbortSignal): Promise<SessionEvents> => {
    const session = postedOf(id)
    session.seenAt = Date.now()
    session.waiter?.({ views: viewsOf(id), actions: [] })
    return new Promise((resolve) => {
      const timer = setTimeout(() => answer(session, id), pollMs)
      const waiter: Waiter = (events) => {
        clearTimeout(timer)
        session.seenAt = Date.now()
        resolve(events)
      }
      session.waiter = waiter
      signal.addEventListener('abort', () => {
        if (session.waiter === waiter) session.waiter = undefined
        waiter({ views: [], actions: [] })
      })
      redrawAll()
      wake(id)
    })
  }

  const post = (id: string, body: unknown) => {
    if (!isObject(body)) throw new Refusal(400, 'A session posts { about, drawings }.')
    const session = postedOf(id)
    session.seenAt = Date.now()
    if (isObject(body['about'])) session.about = body['about'] as SessionAbout
    const wanted = new Set(viewsOf(id).map((view) => view.id))
    for (const drawing of Array.isArray(body['drawings']) ? (body['drawings'] as WebDrawing[]) : []) {
      if (typeof drawing.view !== 'string' || typeof drawing.draw !== 'number' || !wanted.has(drawing.view)) continue
      session.drawings.set(drawing.view, { draw: drawing.draw, tree: drawing.tree })
    }
    redrawAll()
  }

  const press = (body: unknown) => {
    if (!isObject(body)) throw new Refusal(400, 'A press is a JSON object.')
    const { stream: id, draw, handler, key, kind, value, href } = body
    const stream = typeof id === 'string' ? streams.get(id) : undefined
    if (stream === undefined) throw new Refusal(410, 'This page lost its place in cmod web. Reload it.')
    if (typeof draw !== 'number' || typeof handler !== 'number' || typeof key !== 'string' || !inputKinds.has(kind)) throw new Refusal(400, 'A press is { stream, draw, handler, key, kind }.')
    const run = stream.handlers.get(draw)?.[handler]
    if (run !== undefined) run({ kind: kind as string, key, ...(typeof value === 'string' ? { value } : {}), ...(typeof href === 'string' ? { href } : {}) })
    redrawSoon(stream)
    wakeAll()
  }

  const hear = (agent: Agent, change: SessionChange) => {
    if (change.type === Message) {
      const { message } = change
      if (message.task !== undefined || agent.messages.some((each) => each.id === message.id)) return
      agent.messages = [...agent.messages, message].slice(-keptMessages)
      if (message.type === ToolCall) agent.openCalls.set(message.callId, { name: message.name, input: message.input })
      if (message.type === ToolResult) agent.openCalls.delete(message.callId)
    } else if ((change.type === TurnStart || change.type === TurnEnd) && change.turn.prompt.task === undefined) {
      agent.isTurnOpen = change.type === TurnStart
      if (change.type === TurnStart) agent.openCalls.clear()
      else agent.closedAt = change.turn.closedAt
      summarizeSoon()
    } else {
      return
    }
    redrawAll()
  }

  const follow = (entry: RunningEntry): Agent => {
    const agent: Agent = { entry, summary: undefined, isTurnOpen: false, closedAt: undefined, openCalls: new Map(), messages: [], stop: new AbortController() }
    const signal = AbortSignal.any([agent.stop.signal, following.signal])
    void followSessions(db, { sessions: [entry.session], isEveryRunning: false }, entry.cwd, (_session, change) => hear(agent, change), signal).catch((error: unknown) => report(`stopped following ${entry.session}`, error))
    if (!hasTranscript(entry.session, entry.cwd)) return agent
    const request = { session: entry.session, project: entry.cwd }
    const state = readState(db, request)
    agent.isTurnOpen = state.turn !== undefined && state.turn.closedAt === undefined
    for (const [callId, call] of Object.entries(state.openCalls ?? {})) agent.openCalls.set(callId, { name: call.name, input: call.input })
    const known = new Set(agent.messages.map((message) => message.id))
    agent.messages = [...readMessages(db, { ...request, last: feedMessages }).filter((message) => !known.has(message.id)), ...agent.messages]
    agent.closedAt = readTurns(db, { ...request, last: 1 })[0]?.closedAt
    return agent
  }

  const guarded = (doing: string, run: () => void) => () => {
    try {
      run()
    } catch (error) {
      report(doing, error)
    }
  }

  const summarize = guarded('kept the models, colors, and projects it read last', () => {
    summaryTimer = undefined
    const listed = new Map(listSessions(db, { project: '', everyProject: true, since: undefined, running: true }).map((summary) => [summary.id, summary]))
    for (const agent of agents.values()) agent.summary = listed.get(agent.entry.session)
    redrawAll()
  })
  const summarizeSoon = () => {
    summaryTimer ??= setTimeout(summarize, summaryQuietMs)
  }

  const readRegistry = guarded('kept the sessions it listed last', () => {
    registryTimer = undefined
    const entries = runningEntries().filter((entry) => entry.entrypoint !== sdkEntrypoint)
    const running = new Set(entries.map((entry) => entry.session))
    let isChanged = false
    for (const [id, agent] of agents) {
      if (running.has(id)) continue
      agent.stop.abort()
      agents.delete(id)
      isChanged = true
    }
    for (const entry of entries) {
      const known = agents.get(entry.session)
      if (known !== undefined) {
        known.entry = entry
        continue
      }
      try {
        agents.set(entry.session, follow(entry))
        isChanged = true
      } catch (error) {
        report(`skipped ${entry.session} until its transcript reads`, error)
      }
    }
    if (isChanged) summarizeSoon()
    redrawAll()
  })
  const readRegistrySoon = () => {
    registryTimer ??= setTimeout(readRegistry, registryQuietMs)
  }

  const stream = (request: Request, url: URL, server: Server<undefined>): Response => {
    const id = url.searchParams.get('stream') ?? ''
    if (!/^[\w-]{1,64}$/.test(id)) throw new Refusal(400, 'A stream names itself with ?stream=<id>.')
    const columns = Math.max(Math.floor(Number(url.searchParams.get('columns'))) || 0, listColumns + fewestColumns)
    const known = streams.get(id)
    const opened: Stream = known ?? { id, send: undefined, columns, cursor: undefined, tab: conversationTab, isIdleOpen: false, focus: 'row', sent: 0, notice: undefined, draw: 0, html: '', seenAt: Date.now(), timer: undefined, handlers: new Map() }
    opened.columns = columns
    opened.html = ''
    streams.set(id, opened)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: object) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        opened.send = send
        render(opened)
        wakeAll()
      },
      cancel() {
        opened.send = undefined
        opened.seenAt = Date.now()
        wakeAll()
      },
    })
    server.timeout(request, 0)
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
  }

  const route = async (request: Request, url: URL, server: Server<undefined>): Promise<Response> => {
    if (request.method === 'GET' && url.pathname === '/') {
      const nonce = randomBytes(16).toString('base64')
      return new Response(webPage(nonce), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          'referrer-policy': 'no-referrer',
        },
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/stream') return stream(request, url, server)
    if (request.method === 'POST' && url.pathname === '/api/press') {
      press(await request.json())
      return Response.json({})
    }
    const [, id, events] = sessionPath.exec(url.pathname) ?? []
    if (id !== undefined && events !== undefined && request.method === 'GET') return Response.json(await poll(id, request.signal))
    if (id !== undefined && events === undefined && request.method === 'POST') {
      post(id, await request.json())
      return Response.json({})
    }
    throw new Refusal(404, `cmod web has no ${request.method} ${url.pathname}.`)
  }

  const listen = (at: number) =>
    Bun.serve({
      hostname: '127.0.0.1',
      port: at,
      reusePort: false,
      idleTimeout: idleSeconds,
      async fetch(request, server) {
        const host = request.headers.get('host') ?? ''
        const origin = request.headers.get('origin')
        const isTailnet = isOwnTailnet(request, host)
        const own = `${isTailnet ? 'https' : 'http'}://${host}`
        if (!isTailnet && host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) return Response.json({ error: 'cmod web answers only 127.0.0.1, localhost, and you on your tailnet.' }, { status: 421 })
        const url = new URL(request.url)
        const isSessionCall = sessionPath.test(url.pathname)
        if (isTailnet && isSessionCall) return Response.json({ error: "cmod web takes a session's calls only from this computer." }, { status: 403 })
        if (origin !== null ? origin !== own : request.method !== 'GET' && !isSessionCall) return Response.json({ error: `cmod web takes a change only from its own page, and this came from ${origin ?? 'no page'}.` }, { status: 403 })
        try {
          return await route(request, url, server)
        } catch (error) {
          if (error instanceof Refusal) return Response.json({ error: error.message }, { status: error.status })
          return Response.json({ error: messageOf(error) }, { status: 500 })
        }
      },
    })
  let server: Server<undefined>
  try {
    server = listen(port)
  } catch (error) {
    if (port === 0 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    server = listen(0)
  }

  void readJson(marksPath).then(
    (saved) => {
      if (isObject(saved)) marks = new Map(Object.entries(saved).flatMap(([id, at]) => (typeof at === 'string' ? [[id, at] as const] : [])))
      redrawAll()
    },
    (error: unknown) => report(`starts with no read marks, because ${marksPath} does not read`, error),
  )
  readRegistry()
  summarize()
  mkdirSync(runningFolder(), { recursive: true })
  const registry = watch(runningFolder(), { signal: following.signal }).on('change', readRegistrySoon).on('error', (error: unknown) => report('lists new sessions only every 5 seconds', error))
  const sweep = setInterval(() => {
    readRegistrySoon()
    for (const [id, session] of posted) if (!isLive(session) && Date.now() - session.seenAt > liveMs) posted.delete(id)
    for (const [id, each] of streams) if (each.send === undefined && Date.now() - each.seenAt > keptStreamMs) streams.delete(id)
  }, sweepMs)
  return {
    port: server.port ?? port,
    async stop() {
      clearInterval(sweep)
      registry.close()
      following.abort()
      await server.stop(true)
      await markWrites
      db.close()
    },
  }
}

function callSummary(input: Readonly<Record<string, unknown>>): string {
  const question = (input['questions'] as readonly { readonly question?: unknown }[] | undefined)?.[0]?.question
  const named = [input['command'], input['file_path'], input['path'], input['pattern'], input['url'], input['query'], question, input['description'], input['prompt']].find((value) => typeof value === 'string')
  const text = typeof named === 'string' ? named : JSON.stringify(input)
  return firstLine(text)
}
