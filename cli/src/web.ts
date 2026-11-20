import { randomBytes } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { basename } from 'node:path'
import type { Server } from 'bun'
import { isObject } from '@cmodjs/core/src/records.js'
import { listenMethod, methodName, onMethod, sessionsInterface, uiInterface, type Heard, type Listening, type ProviderIdentity, type StoreChange } from '@cmodjs/core/src/runtime/interfaces.js'
import type { Peer } from '@cmodjs/core/src/runtime/rpc.js'
import { htmlOf, type ElementData, type HandlerData } from '@cmodjs/core/src/runtime/web.js'
import { Message, type Message as SessionMessage } from '@cmodjs/core/src/session/context/turn/message/message.js'
import { Prompt } from '@cmodjs/core/src/session/context/turn/message/prompt.js'
import { Person } from '@cmodjs/core/src/session/context/turn/message/sender.js'
import { Reply } from '@cmodjs/core/src/session/context/turn/message/reply.js'
import { ToolCall } from '@cmodjs/core/src/session/context/turn/message/tool-call.js'
import { ToolResult } from '@cmodjs/core/src/session/context/turn/message/tool-result.js'
import { TurnEnd, TurnStart } from '@cmodjs/core/src/session/context/turn/turn.js'
import type { ConversationState, SessionChange, SessionData } from '@cmodjs/core/src/session/conversation.js'
import { firstLine, messageOf } from '@cmodjs/core/src/utils/text.js'
import { followSessions, hasTranscript, readMessages, readState, readTurns, runningEntries, type RunningEntry } from './history.js'
import type { SessionServer } from './serve.js'
import { appScreen, conversationTab, groupOrder, listColumns, visibleRows, webPage, type AgentRow, type FeedItem, type Group, type On, type PressInput, type Screen, type ScreenActions, type UiUnit, type UnitTab } from './web-page.js'

const idleSeconds = 30

const sweepMs = 5000

const summaryQuietMs = 1000

const redrawMs = 30

const keptStreamMs = 600_000

const keptMessages = 200

const feedMessages = 80

const fewestColumns = 40

const questionTool = 'AskUserQuestion'

const sdkEntrypoint = 'sdk-cli'

const browserSurface = 'browser'

const stoppedRunning = 'Stopped, and a command still runs in its terminal'

const inputKinds: ReadonlySet<unknown> = new Set(['press', 'change', 'submit', 'select', 'link'])

type Call = { readonly name: string; readonly input: Readonly<Record<string, unknown>> }

type Units = { readonly views: readonly UiUnit[]; readonly pages: readonly UiUnit[] }

type Agent = {
  entry: RunningEntry
  summary: SessionData | undefined
  isTurnOpen: boolean
  closedAt: string | undefined
  readonly openCalls: Map<string, Call>
  messages: SessionMessage[]
  readonly openPages: Set<string>
  readonly stop: AbortController
  readonly store?: ProviderIdentity
  readAt?: string
}

type PressHandler = (input: PressInput) => void

type ShownUnit = { readonly session: string; readonly unit: UiUnit }

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
  controls: ReadonlyMap<number, PressHandler>
  readonly numbers: Map<string, number>
  shown: ShownUnit | undefined
}

type Fetched = { value: unknown; failure: string | undefined; heldFor: number; wanted: number; isFetching: boolean }

export type WebApp = {
  listen(port: number): number
  close(): Promise<void>
  stop(): Promise<void>
}

class Refusal extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const unitKey = ({ mod, id }: Pick<UiUnit, 'mod' | 'id'>) => `${mod}/${id}`

export function webApp({ db, sessions }: { readonly db: Database; readonly sessions: SessionServer }): WebApp {
  const agents = new Map<string, Agent>()
  const streams = new Map<string, Stream>()
  const fetched = new Map<string, Fetched>()
  const heardBy = new Map<string, (payload: unknown) => void>()
  const encoder = new TextEncoder()
  let visits = new Map<string, string>()
  let summaryTimer: ReturnType<typeof setTimeout> | undefined
  let registryTimer: ReturnType<typeof setTimeout> | undefined
  let lastNumber = 0
  const following = new AbortController()
  let isReadingStores = false

  const report = (doing: string, error: unknown) => process.stderr.write(`cmod web serve: ${doing}: ${messageOf(error)}\n`)

  const isOwnTailnet = (request: Request, host: string) => {
    const { CMOD_TAILNET_NAME: tailnetName = '', CMOD_TAILNET_LOGIN: tailnetLogin = '' } = process.env
    return tailnetName !== '' && host.replace(/:\d+$/, '') === tailnetName && request.headers.get('tailscale-user-login') === tailnetLogin
  }

  const app: Pick<Peer, 'request' | 'notify'> = {
    request: () => Promise.reject(new Error('cmod web asks no listener of cmod serve.')),
    notify(method, params) {
      if (method !== onMethod) return
      const { id, payload } = params as Heard
      heardBy.get(id)?.(payload)
    },
  }
  const serve = sessions.interfaces.handler(app)
  const callOwn = async <Result>(name: string, method: string, args: readonly unknown[]): Promise<Result> => (await serve(methodName(name, method), args, following.signal)) as Result
  const callUi = <Result>(method: string, args: readonly unknown[]) => callOwn<Result>(uiInterface, method, args)
  const listen = <Payload>(name: string, event: string, heard: (payload: Payload) => void) => {
    const id = `${name} ${event}`
    heardBy.set(id, (payload) => heard(payload as Payload))
    void Promise.resolve(serve(listenMethod, { id, interface: name, event, kind: 'on' } satisfies Listening, following.signal)).catch((error: unknown) => report(`hears no ${event} of ${name}`, error))
  }

  const fetchedOf = (key: string, read: () => Promise<unknown>): Fetched => {
    const known = fetched.get(key) ?? { value: undefined, failure: undefined, heldFor: -1, wanted: 0, isFetching: false }
    fetched.set(key, known)
    if (known.isFetching || known.heldFor === known.wanted) return known
    known.isFetching = true
    const asked = known.wanted
    void read()
      .then(
        (value) => {
          known.value = value
          known.failure = undefined
        },
        (error: unknown) => void (known.failure = messageOf(error)),
      )
      .finally(() => {
        known.isFetching = false
        known.heldFor = asked
        redrawAll()
      })
    return known
  }
  const refetch = (prefix: string) => {
    for (const [key, known] of fetched) if (key.startsWith(prefix)) known.wanted += 1
    redrawAll()
  }
  const forget = (session: string) => {
    for (const key of fetched.keys()) if (key.startsWith(`${session}\n`)) fetched.delete(key)
  }

  const unitsOf = (agent: Agent): Units | undefined => {
    if (agent.store !== undefined) return undefined
    const { session } = agent.entry
    const listed = async (): Promise<Units> => {
      const [views, pages] = await Promise.all([callUi<UiUnit[]>('views', [session]), callUi<UiUnit[]>('pages', [session])])
      return { views, pages }
    }
    return fetchedOf(`${session}\nunits`, listed).value as Units | undefined
  }
  const drawnOf = (session: string, unit: UiUnit, columns: number) => fetchedOf(`${session}\ndraw\n${unitKey(unit)}\n${columns}`, () => callUi('draw', [session, { mod: unit.mod, id: unit.id }, { columns, surface: browserSurface }]))

  const statusOf = (agent: Agent) => agent.entry.status ?? agent.summary?.status
  const isWorking = (agent: Agent) => {
    const status = statusOf(agent)
    return status === undefined ? agent.isTurnOpen : status === 'busy' || (status === 'waiting' && agent.isTurnOpen)
  }
  const lastTurnOf = (agent: Agent): SessionData['lastTurn'] => {
    if (isWorking(agent)) return undefined
    return agent.summary?.lastTurn ?? (agent.isTurnOpen || agent.closedAt === undefined ? undefined : { reason: 'answered', at: agent.closedAt })
  }
  const askedOf = (agent: Agent): string | undefined => {
    const asked = [...agent.openCalls.values()].findLast((call) => call.name === questionTool)
    const question = (asked?.input['questions'] as readonly { readonly question?: unknown }[] | undefined)?.[0]?.question
    return typeof question === 'string' ? question : undefined
  }
  const waitOf = (agent: Agent): string | undefined => {
    const status = statusOf(agent)
    if (status !== undefined && status !== 'waiting') return undefined
    const waiting = agent.summary?.waitingFor
    if (waiting?.question !== undefined) return `Asks: ${waiting.question}`
    if (waiting?.tool !== undefined) return `Wants to run ${waiting.tool}: ${callSummary(waiting.input ?? {})}`
    if (status === undefined) {
      const question = askedOf(agent)
      return question === undefined ? undefined : `Asks: ${question}`
    }
    const dialog = agent.entry.waitingFor ?? waiting?.dialog
    return dialog === 'permission prompt' ? 'Wants permission to run a tool' : dialog === 'input needed' ? 'Asks you a question' : `Waits on ${dialog ?? 'you'} in its terminal`
  }
  const lastReply = (agent: Agent) => agent.messages.findLast((message) => message.type === Reply)

  const rowOf = (agent: Agent): AgentRow => {
    const { entry, summary } = agent
    const wait = waitOf(agent)
    const ended = lastTurnOf(agent)
    const visitedAt = visits.get(entry.session)
    const isUnread = ended !== undefined && (visitedAt === undefined || visitedAt < ended.at)
    const reply = lastReply(agent)
    const replyLine = reply === undefined ? '' : firstLine(reply.text)
    const current = [...agent.openCalls.values()].at(-1)
    const isStillRunning = ended?.reason === 'stopped' && statusOf(agent) === 'shell'
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

  const tabsOf = (agent: Agent, units: Units | undefined): (UnitTab & { readonly unit: UiUnit })[] => {
    if (units === undefined) return []
    const pages = units.pages.filter((page) => agent.openPages.has(unitKey(page)))
    return [...units.views.map((unit) => ({ key: unitKey(unit), label: unit.title, isClosable: false, unit })), ...pages.map((unit) => ({ key: unitKey(unit), label: unit.title, isClosable: true, unit }))]
  }
  const columnsOf = (stream: Stream) => Math.max(stream.columns - listColumns - 2, fewestColumns)

  const tellShown = (stream: Stream, session: string, units: readonly UiUnit[]) =>
    void callUi('show', [session, `browser:${stream.id}`, units.map(({ mod, id }) => ({ mod, id }))]).catch((error: unknown) => report(`kept what ${session} shows in the browser`, error))
  const shownKey = (shown: ShownUnit | undefined) => (shown === undefined ? '' : `${shown.session}\n${unitKey(shown.unit)}`)
  const showIn = (stream: Stream, next: ShownUnit | undefined) => {
    const was = stream.shown
    if (shownKey(was) === shownKey(next)) return
    stream.shown = next
    if (was !== undefined && was.session !== next?.session) tellShown(stream, was.session, [])
    if (next !== undefined) tellShown(stream, next.session, [next.unit])
  }

  const forwarded = (stream: Stream, tree: unknown, session: string, on: On): unknown => {
    if (Array.isArray(tree)) return tree.map((each: unknown) => forwarded(stream, each, session, on))
    if (!isObject(tree)) return tree
    const handler = tree['$cmodHandler']
    if (typeof handler === 'number') return on(`unit:${session}:${handler}`, (input) => pressUnit(stream, session, handler, input))
    return Object.fromEntries(Object.entries(tree).map(([key, each]) => [key, forwarded(stream, each, session, on)]))
  }
  const pressUnit = (stream: Stream, session: string, handler: number, input: PressInput) =>
    void callUi('press', [session, handler, pressOf(input)]).catch((error: unknown) => {
      stream.notice = `That control did not run: ${messageOf(error)}`
      redrawSoon(stream)
    })

  let visitWrites = Promise.resolve()
  const visit = (session: string, at: string) => {
    visits.set(session, at)
    visitWrites = visitWrites.then(async () => void (await sessions.call(session, 'visit', at))).catch((error: unknown) => void report(`kept the visit of ${session} only in memory`, error))
  }

  const act = (stream: Stream, agent: Agent, action: 'send' | 'abort', input: object) =>
    void (agent.store === undefined ? sessions.call(agent.entry.session, action, input, { project: agent.entry.cwd }) : callStore(agent.store, action, [agent.entry.session, input, { project: agent.entry.cwd }])).then(
      () => (agent.store === undefined ? undefined : readStoresSoon()),
      (error: unknown) => {
        stream.notice = `${action === 'send' ? 'The prompt did not reach' : 'Stop did not reach'} ${agent.entry.name ?? agent.entry.session}: ${messageOf(error)}`
        redrawSoon(stream)
      },
    )

  const actionsOf = (stream: Stream): ScreenActions => {
    const at = () => (stream.cursor === undefined ? undefined : agents.get(stream.cursor))
    const ended = () => {
      const agent = at()
      return agent === undefined ? undefined : lastTurnOf(agent)
    }
    const showUnit = (agent: Agent, key: string, isOpen: boolean) => {
      const [mod = '', id = ''] = key.split('/')
      void callUi(isOpen ? 'open' : 'close', [agent.entry.session, { mod, id }]).catch((error: unknown) => {
        stream.notice = `${isOpen ? 'That page did not open' : 'That page did not close'} in ${agent.entry.name ?? agent.entry.session}: ${messageOf(error)}`
        redrawSoon(stream)
      })
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
        visit(session, new Date().toISOString())
      },
      done() {
        const last = ended()
        if (stream.cursor === undefined || last === undefined) return
        visit(stream.cursor, new Date().toISOString())
        move(1)
      },
      unread() {
        const last = ended()
        if (stream.cursor === undefined || last === undefined) return
        visit(stream.cursor, new Date(Date.parse(last.at) - 1).toISOString())
      },
      toggleIdle() {
        stream.isIdleOpen = !stream.isIdleOpen
      },
      showTab(tab) {
        stream.tab = tab
      },
      closeTab(tab) {
        const agent = at()
        if (agent === undefined || !agent.openPages.delete(tab)) return
        if (stream.tab === tab) stream.tab = conversationTab
        showUnit(agent, tab, false)
      },
      openPage(page) {
        const agent = at()
        if (agent === undefined) return
        agent.openPages.add(unitKey(page))
        stream.tab = unitKey(page)
        showUnit(agent, unitKey(page), true)
      },
      prompt(text) {
        const agent = at()
        if (agent === undefined || text.trim() === '') return
        act(stream, agent, 'send', { type: Prompt, text, as: Person })
        stream.sent += 1
        stream.focus = 'prompt'
        stream.notice = undefined
      },
      stop() {
        const agent = at()
        if (agent !== undefined) act(stream, agent, 'abort', {})
      },
    }
  }

  const screenOf = (stream: Stream, on: On): Screen => {
    const listed = rows()
    if (stream.cursor === undefined || !agents.has(stream.cursor)) stream.cursor = listed[0]?.id
    const agent = stream.cursor === undefined ? undefined : agents.get(stream.cursor)
    if (agent === undefined) {
      showIn(stream, undefined)
      return { rows: listed, tab: stream.tab, isIdleOpen: stream.isIdleOpen, focus: stream.focus, sent: stream.sent, ...(stream.notice === undefined ? {} : { notice: stream.notice }) }
    }
    const row = listed.find((each) => each.id === agent.entry.session) ?? rowOf(agent)
    const units = unitsOf(agent)
    const tabs = tabsOf(agent, units)
    const shown = tabs.find((tab) => tab.key === stream.tab)
    if (shown === undefined) stream.tab = conversationTab
    showIn(stream, shown === undefined ? undefined : { session: agent.entry.session, unit: shown.unit })
    const drawn =shown === undefined ? undefined : drawnOf(agent.entry.session, shown.unit, columnsOf(stream))
    const drawing = drawn === undefined ? undefined : drawn.failure !== undefined ? ({ $cmodElement: 'Text', props: { color: 'error', children: `${shown?.label ?? 'It'} could not draw: ${drawn.failure}` } } satisfies ElementData) : drawn.value === undefined || drawn.value === null ? undefined : (forwarded(stream, drawn.value, agent.entry.session, on) as ElementData)
    const wait = waitOf(agent)
    const contextPercent = agent.summary?.contextPercent
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
        ...(contextPercent === undefined ? {} : { contextPercent }),
        isWorking: isWorking(agent),
        ...(wait === undefined || row.group !== 'needs' ? {} : { waiting: row.reason }),
        ...(row.reason === stoppedRunning ? { state: stoppedRunning } : {}),
        feed: feedOf(agent),
        tabs: tabs.map(({ key, label, isClosable }) => ({ key, label, isClosable })),
        pages: units?.pages.filter((each) => !agent.openPages.has(unitKey(each))) ?? [],
        ...(drawing === undefined ? {} : { page: drawing }),
      },
    }
  }

  const render = (stream: Stream) => {
    stream.timer = undefined
    if (stream.send === undefined) return
    const controls = new Map<number, PressHandler>()
    const used = new Set<string>()
    const on: On = (token, run): HandlerData => {
      const number = stream.numbers.get(token) ?? (lastNumber += 1)
      stream.numbers.set(token, number)
      used.add(token)
      controls.set(number, run)
      return { $cmodHandler: number }
    }
    const html = htmlOf(appScreen(screenOf(stream, on), actionsOf(stream), on))
    stream.controls = controls
    for (const token of stream.numbers.keys()) if (!used.has(token)) stream.numbers.delete(token)
    if (stream.focus === 'prompt') {
      stream.focus = 'row'
      redrawSoon(stream)
    }
    if (html === stream.html) return
    stream.draw += 1
    stream.html = html
    stream.send('screen', { draw: stream.draw, html })
  }
  const redrawSoon = (stream: Stream) => {
    stream.timer ??= setTimeout(() => render(stream), redrawMs)
  }
  const redrawAll = () => {
    for (const stream of streams.values()) redrawSoon(stream)
  }

  const press = (body: unknown) => {
    if (!isObject(body)) throw new Refusal(400, 'A press is a JSON object.')
    const { stream: id, handler, key, kind, value, href } = body
    const stream = typeof id === 'string' ? streams.get(id) : undefined
    if (stream === undefined) throw new Refusal(410, 'This page lost its place in cmod web. Reload it.')
    if (typeof handler !== 'number' || typeof key !== 'string' || !inputKinds.has(kind)) throw new Refusal(400, 'A press is { stream, handler, key, kind }.')
    const run = stream.controls.get(handler)
    if (run === undefined) throw new Refusal(409, `${key === '' ? 'That control' : key} is no longer on the screen, so nothing ran.`)
    run({ kind: kind as string, key, ...(typeof value === 'string' ? { value } : {}), ...(typeof href === 'string' ? { href } : {}) })
    redrawSoon(stream)
  }

  const shownIn = (session: string, key: string, isOpen: boolean) => {
    const agent = agents.get(session)
    if (agent === undefined) return
    if (isOpen) agent.openPages.add(key)
    else agent.openPages.delete(key)
    for (const stream of streams.values()) if (stream.cursor === session && (isOpen || stream.tab === key)) stream.tab = isOpen ? key : conversationTab
    redrawAll()
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
      summarizeSoon(summaryQuietMs)
    } else {
      return
    }
    redrawAll()
  }

  const follow = (entry: RunningEntry): Agent => {
    const agent: Agent = { entry, summary: undefined, isTurnOpen: false, closedAt: undefined, openCalls: new Map(), messages: [], openPages: new Set(), stop: new AbortController() }
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

  const summarize = async () => {
    summaryTimer = undefined
    const listed = new Map((await callOwn<SessionData[]>(sessionsInterface, 'sessions', [{ everyProject: true, running: true }])).map((summary) => [summary.id, summary]))
    for (const agent of agents.values()) if (agent.store === undefined) agent.summary = listed.get(agent.entry.session)
    redrawAll()
  }
  const summarizeSoon = (ms: number) => {
    if (summaryTimer !== undefined && ms >= summaryQuietMs) return
    clearTimeout(summaryTimer)
    summaryTimer = setTimeout(() => void summarize().catch((error: unknown) => report('kept the models, colors, projects, and statuses it read last', error)), ms)
  }

  const readRegistry = guarded('kept the sessions it listed last', () => {
    registryTimer = undefined
    const entries = runningEntries().filter((entry) => entry.entrypoint !== sdkEntrypoint)
    const running = new Set(entries.map((entry) => entry.session))
    let isChanged = false
    for (const [id, agent] of agents) {
      if (running.has(id) || agent.store !== undefined) continue
      agent.stop.abort()
      agents.delete(id)
      forget(id)
      isChanged = true
    }
    for (const entry of entries) {
      const known = agents.get(entry.session)
      if (known?.store !== undefined) {
        agents.delete(entry.session)
      } else if (known !== undefined) {
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
    if (isChanged) summarizeSoon(summaryQuietMs)
    redrawAll()
  })
  const readRegistrySoon = () => {
    registryTimer ??= setTimeout(readRegistry, 0)
  }

  const storesOf = () => sessions.providers.list(sessionsInterface)
  const callStore = async <Result>(store: ProviderIdentity, method: string, args: readonly unknown[]) => (await sessions.providers.call({ interface: sessionsInterface, method, args, ...store })) as Result
  const readStore = async (store: ProviderIdentity, seen: Set<string>) => {
    const listed = await callStore<SessionData[]>(store, 'sessions', [{ everyProject: true, running: true }])
    for (const summary of listed) {
      const known = agents.get(summary.id)
      if (seen.has(summary.id) || (known !== undefined && known.store === undefined)) continue
      seen.add(summary.id)
      const agent: Agent = known ?? { entry: { session: summary.id, cwd: summary.cwd, pid: 0, entrypoint: sessionsInterface, name: summary.title }, summary, isTurnOpen: false, closedAt: undefined, openCalls: new Map(), messages: [], openPages: new Set(), stop: new AbortController(), store }
      agent.summary = summary
      agents.set(summary.id, agent)
      if (agent.readAt === summary.lastAt) continue
      const [messages, state] = await Promise.all([
        callStore<SessionMessage[]>(store, 'read', [summary.id, 'messages', { project: summary.cwd, last: feedMessages }]),
        callStore<ConversationState | null>(store, 'read', [summary.id, 'state', { project: summary.cwd }]),
      ])
      agent.messages = messages.filter((message) => message.task === undefined)
      agent.isTurnOpen = state?.turn !== undefined && state.turn.closedAt === undefined
      agent.closedAt = state?.turn?.closedAt
      agent.openCalls.clear()
      for (const [callId, call] of Object.entries(state?.openCalls ?? {})) agent.openCalls.set(callId, { name: call.name, input: call.input })
      agent.readAt = summary.lastAt
    }
  }
  const readStores = async () => {
    if (isReadingStores) return
    isReadingStores = true
    try {
      const seen = new Set<string>()
      for (const store of await storesOf()) await readStore(store, seen).catch((error: unknown) => report('kept the sessions a store listed last', error))
      for (const [id, agent] of agents) if (agent.store !== undefined && !seen.has(id)) agents.delete(id)
      redrawAll()
    } finally {
      isReadingStores = false
    }
  }
  const readStoresSoon = () => void readStores().catch((error: unknown) => report('kept the sessions it listed last', error))

  const stream = (request: Request, url: URL, server: Server<undefined>): Response => {
    const id = url.searchParams.get('stream') ?? ''
    if (!/^[\w-]{1,64}$/.test(id)) throw new Refusal(400, 'A stream names itself with ?stream=<id>.')
    const columns = Math.max(Math.floor(Number(url.searchParams.get('columns'))) || 0, listColumns + fewestColumns)
    const known = streams.get(id)
    const opened: Stream = known ?? { id, send: undefined, columns, cursor: undefined, tab: conversationTab, isIdleOpen: false, focus: 'row', sent: 0, notice: undefined, draw: 0, html: '', seenAt: Date.now(), timer: undefined, controls: new Map(), numbers: new Map(), shown: undefined }
    opened.columns = columns
    opened.html = ''
    streams.set(id, opened)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        opened.send = (event: string, data: object) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        render(opened)
      },
      cancel() {
        opened.send = undefined
        opened.seenAt = Date.now()
        showIn(opened, undefined)
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
    throw new Refusal(404, `cmod web has no ${request.method} ${url.pathname}.`)
  }

  const page = (at: number) =>
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
        if (url.pathname.startsWith('/rpc')) return Response.json({ error: "cmod web takes a session's calls only on cmod serve's socket." }, { status: 403 })
        if (origin !== null ? origin !== own : request.method !== 'GET') return Response.json({ error: `cmod web takes a change only from its own page, and this came from ${origin ?? 'no page'}.` }, { status: 403 })
        try {
          return await route(request, url, server)
        } catch (error) {
          if (error instanceof Refusal) return Response.json({ error: error.message }, { status: error.status })
          return Response.json({ error: messageOf(error) }, { status: 500 })
        }
      },
    })
  let server: Server<undefined> | undefined

  void sessions.visits().then(
    (saved) => {
      visits = new Map(Object.entries(saved))
      redrawAll()
    },
    (error: unknown) => report('starts with no visits', error),
  )
  let sweep: ReturnType<typeof setInterval> | undefined
  const viewedDrawings = () =>
    new Set(
      [...streams.values()].flatMap((each) => {
        const [mod = '', id = ''] = each.tab.split('/')
        return each.cursor === undefined || each.tab === conversationTab ? [] : [`${each.cursor}\ndraw\n${mod}/${id}\n${columnsOf(each)}`]
      }),
    )
  const start = () => {
    if (sweep !== undefined) return
    listen(sessionsInterface, 'Change', ({ part }: StoreChange) => {
      if (part !== 'status' && part !== 'running') return
      readRegistrySoon()
      summarizeSoon(0)
    })
    listen(uiInterface, 'Change', ({ session }: { readonly session: string }) => refetch(`${session}\nunits`))
    listen(uiInterface, 'Redraw', ({ session, mod, id }: { readonly session: string; readonly mod: string; readonly id: string }) => refetch(`${session}\ndraw\n${mod}/${id}\n`))
    listen(uiInterface, 'Open', ({ session, mod, id }: { readonly session: string; readonly mod: string; readonly id: string }) => shownIn(session, `${mod}/${id}`, true))
    listen(uiInterface, 'Close', ({ session, mod, id }: { readonly session: string; readonly mod: string; readonly id: string }) => shownIn(session, `${mod}/${id}`, false))
    readRegistry()
    summarizeSoon(0)
    readStoresSoon()
    sweep = setInterval(() => {
      readRegistrySoon()
      readStoresSoon()
      for (const [id, each] of streams) if (each.send === undefined && Date.now() - each.seenAt > keptStreamMs) streams.delete(id)
      for (const each of streams.values()) if (each.shown !== undefined) tellShown(each, each.shown.session, [each.shown.unit])
      const viewed = viewedDrawings()
      for (const key of fetched.keys()) if (key.includes('\ndraw\n') && !viewed.has(key)) fetched.delete(key)
    }, sweepMs)
  }
  const close = async () => {
    const was = server
    server = undefined
    await was?.stop(true)
  }
  return {
    listen(port) {
      start()
      if (server !== undefined) return server.port ?? port
      try {
        server = page(port)
      } catch (error) {
        if (port === 0 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
        server = page(0)
      }
      return server.port ?? port
    },
    close,
    async stop() {
      clearInterval(sweep)
      clearTimeout(summaryTimer)
      clearTimeout(registryTimer)
      following.abort()
      sessions.interfaces.closed(app)
      await close()
      await visitWrites
    },
  }
}

function pressOf({ kind, key, value, href }: PressInput): object {
  const at = { surface: browserSurface, key }
  if (kind === 'change' || kind === 'submit') return { ...at, kind, value: value ?? '' }
  if (kind === 'select') return { ...at, value: value ?? '' }
  if (kind === 'link') return { ...at, link: { href: href ?? '' } }
  return at
}

function callSummary(input: Readonly<Record<string, unknown>>): string {
  const question = (input['questions'] as readonly { readonly question?: unknown }[] | undefined)?.[0]?.question
  const named = [input['command'], input['file_path'], input['path'], input['pattern'], input['url'], input['query'], question, input['description'], input['prompt']].find((value) => typeof value === 'string')
  const text = typeof named === 'string' ? named : JSON.stringify(input)
  return firstLine(text)
}
