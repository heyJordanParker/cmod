import { program, type Program } from '../node_modules/@cmodjs/core/jobs/program.js'
import { Person, Prompt, sessions, type Mod } from '../node_modules/@cmodjs/core/mod.js'
import { engineOf } from '../node_modules/@cmodjs/core/runtime/engine.js'
import { cmodError } from '../node_modules/@cmodjs/core/runtime/programs.js'
import { toolInputOf } from '../node_modules/@cmodjs/core/runtime/tool-calls.js'
import type { ClosedPage, SessionAbout, SessionEvents, SessionPost, SessionWait, TurnOutcome, WebAction, WebDrawing, WebView } from '../node_modules/@cmodjs/core/runtime/web.js'
import { Button, elementData, Text, type Handler } from '../node_modules/@cmodjs/core/ui/elements.js'
import { formatExit, messageOf } from '../node_modules/@cmodjs/core/utils/text.js'
import { refreshPreferences, writePreference, type SettingsState } from './settings.js'
import type { sidebar, SidebarState } from './sidebar.js'

const retryMs = 2000

const keptDraws = 2

const questionTool = 'AskUserQuestion'

// Claude Code's RenderSurface has no browser. A desktop is the closest surface that draws with a pointer.
const browserSurface = 'desktop'

type Sidebar = Pick<ReturnType<typeof sidebar>, 'tabs' | 'draw' | 'closeTab' | 'addTab' | 'showInBrowser'>

type Call = { readonly callId: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> }

export function webUi<State extends SidebarState & SettingsState>(mod: Mod<State>, shown: Sidebar) {
  const { claude, router, pages, report, onRedraw } = engineOf(mod)
  if (pages === undefined) throw new Error('cmod draws no web UI, because the cmod plugin started without its pages.')
  let server: Program | undefined
  let address: string | undefined
  let views: readonly WebView[] = []
  let aboutPosted = ''
  let isFollowing = false
  let isRedrawing = false
  let isRedrawnAgain = false
  let nextDraw = 0
  let runningTurn: string | undefined
  let waiting: SessionWait | undefined
  let waitingOn: string | undefined
  let lastTurn: TurnOutcome | undefined
  let failure: string | undefined
  let contextPercent: number | undefined
  const openCalls = new Map<string, Call>()
  const posted = new Map<string, string>()
  const handlers = new Map<number, Handler[]>()
  const viewDraws = new Map<string, number[]>()

  const wait = (ms: number) => new Promise<void>((resolve) => void claude.clock.after(ms, resolve))
  const isOn = () => mod.state.memory.preferences.servesWebUi

  const call = async (path: string, body?: object) => {
    if (address === undefined) throw new Error('cmod web serve has not answered yet.')
    const answer = await claude.http.fetch(`${address}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!answer.ok) throw new Error(`cmod web serve answered ${path} with ${answer.status}: ${answer.text}`)
    return JSON.parse(answer.text) as unknown
  }

  const closedPages = (): ClosedPage[] => {
    const open = new Set(mod.state.session.pages.map((each) => `${each.mod}/${each.page}`))
    return pages.declared().flatMap(({ mod: name, pages: declared }) => declared.filter((page) => page.place === 'sidebar' && !open.has(`${name}/${page.id}`)).map((page) => ({ mod: name, page: page.id, title: page.title })))
  }
  const about = (): SessionAbout => ({
    tabs: shown.tabs(),
    pages: closedPages(),
    isWorking: runningTurn !== undefined,
    ...(waiting === undefined ? {} : { waiting }),
    ...(lastTurn === undefined ? {} : { lastTurn }),
    ...(contextPercent === undefined ? {} : { contextPercent }),
  })

  const drawView = (view: WebView): WebDrawing | undefined => {
    const collected: Handler[] = []
    let tree: unknown
    try {
      tree = elementData(shown.draw(view.tab, view.columns), collected)
    } catch (error) {
      tree = elementData(Text({ color: 'error', wrap: 'wrap', children: `cmod could not draw this tab in the browser: ${messageOf(error)}` }), collected)
    }
    const text = JSON.stringify(tree)
    const draws = viewDraws.get(view.id) ?? []
    const latest = draws.at(-1)
    if (posted.get(view.id) === text && latest !== undefined) return void handlers.set(latest, collected)
    nextDraw += 1
    const kept = [...draws, nextDraw].slice(-keptDraws)
    for (const draw of draws) if (!kept.includes(draw)) handlers.delete(draw)
    handlers.set(nextDraw, collected)
    viewDraws.set(view.id, kept)
    posted.set(view.id, text)
    return { view: view.id, draw: nextDraw, tree }
  }
  const redraw = async (): Promise<void> => {
    if (address === undefined) return
    if (isRedrawing) return void (isRedrawnAgain = true)
    isRedrawing = true
    try {
      const drawings = views.flatMap((view) => drawView(view) ?? [])
      const told = about()
      const aboutText = JSON.stringify([sessions.current.id, told])
      const body: SessionPost = { ...(aboutText === aboutPosted ? {} : { about: told }), ...(drawings.length === 0 ? {} : { drawings }) }
      aboutPosted = aboutText
      if (Object.keys(body).length > 0) await call(`/api/sessions/${sessions.current.id}`, body)
    } catch (error) {
      posted.clear()
      aboutPosted = ''
      claude.ui.warn('web:post', `cmod: the web UI missed a drawing of this session, and draws it again on its next redraw: ${messageOf(error)}`)
    } finally {
      isRedrawing = false
    }
    if (!isRedrawnAgain) return
    isRedrawnAgain = false
    return redraw()
  }
  const redrawSoon = () => void claude.clock.after(0, () => void redraw())

  const measure = async () => {
    contextPercent = (await sessions.current.usage()).contextWindow.percent
    redrawSoon()
  }
  const measureSoon = () => void measure().catch((error: unknown) => claude.ui.warn('web:usage', `cmod: the web UI shows no context fill for this session: ${messageOf(error)}`))
  const waitFor = (open: Call) => {
    const question = open.name === questionTool ? (open.input['questions'] as readonly { readonly question?: unknown }[] | undefined)?.[0]?.question : undefined
    waiting = typeof question === 'string' ? { kind: 'question', question } : { kind: 'permission', tool: open.name, input: open.input }
    waitingOn = open.callId
    redrawSoon()
  }

  router.add('turn.start', async (e, next) => {
    if (e.agentId === undefined) {
      runningTurn = e.turnId
      waiting = undefined
      waitingOn = undefined
      lastTurn = undefined
      failure = undefined
      openCalls.clear()
      redrawSoon()
    }
    return next(e)
  })
  router.add('turn.complete', async (e, next) => {
    const completed = await next(e)
    if (e.agentId !== undefined) return completed
    const refusal = e.reason === 'refusal' ? (e.refusal.explanation ?? e.refusal.category ?? 'Claude refused to answer.') : undefined
    const reason = e.reason === 'answer' ? 'answered' : e.reason === 'aborted' ? 'stopped' : 'failed'
    const text = refusal ?? failure
    runningTurn = undefined
    waiting = undefined
    waitingOn = undefined
    lastTurn = { reason, at: new Date().toISOString(), ...(reason === 'failed' && text !== undefined ? { failure: text } : {}) }
    openCalls.clear()
    measureSoon()
    return completed
  })
  sessions.current.onTurnEnd((turn) => {
    failure = turn.failure?.text
    if (lastTurn?.reason === 'failed' && failure !== undefined) lastTurn = { ...lastTurn, failure }
    redrawSoon()
  })
  router.add('tool.call', async (e, next) => {
    if (e.agentId !== undefined) return next(e)
    const open: Call = { callId: e.tool_use_id, name: e.tool, input: toolInputOf(e) }
    openCalls.set(open.callId, open)
    if (open.name === questionTool) waitFor(open)
    try {
      return await next(e)
    } finally {
      openCalls.delete(open.callId)
      if (waitingOn === open.callId) {
        waiting = undefined
        waitingOn = undefined
        redrawSoon()
      }
    }
  })
  sessions.current.onNotification(({ type }) => {
    const open = [...openCalls.values()].at(-1)
    if (type === 'permission_prompt' && open !== undefined) waitFor(open)
  })

  const pressArgs = (action: Extract<WebAction, { readonly type: 'press' }>): unknown[] => {
    const at = { plugin: mod.name, element: action.key, component: 'Pane', requestId: 'sidebar', surface: browserSurface }
    const value = action.value ?? ''
    if (action.kind === 'change' || action.kind === 'submit') return [value, { ...at, kind: action.kind, value }]
    if (action.kind === 'select') return [value, { ...at, value }]
    if (action.kind === 'link') return [{ href: action.href ?? '' }, { ...at, link: { href: action.href ?? '' } }]
    return [at]
  }
  const act = async (action: WebAction) => {
    if (action.type === 'prompt') return sessions.current.send({ type: Prompt, text: action.text, as: Person })
    if (action.type === 'stop') return runningTurn === undefined ? undefined : claude.turn.abort({ turnId: runningTurn })
    if (action.type === 'close') return shown.closeTab(action.tab)
    if (action.type === 'open') {
      const isDeclared = pages.declared().some((each) => each.mod === action.mod && each.pages.some((page) => page.id === action.page && page.place === 'sidebar'))
      return isDeclared ? shown.addTab({ mod: action.mod, page: action.page, params: undefined }) : undefined
    }
    const run = handlers.get(action.draw)?.[action.handler]
    if (run === undefined) {
      posted.delete(action.view)
      return redrawSoon()
    }
    await run(...pressArgs(action))
  }
  const hear = ({ views: wanted, actions }: SessionEvents) => {
    views = wanted
    for (const [view, draws] of viewDraws) {
      if (wanted.some((each) => each.id === view)) continue
      for (const draw of draws) handlers.delete(draw)
      viewDraws.delete(view)
      posted.delete(view)
    }
    shown.showInBrowser(new Set(wanted.map((view) => view.tab)))
    for (const action of actions) void act(action).catch((error: unknown) => report({ id: `web:${action.type}`, message: action.type === 'prompt' ? 'Could not send the prompt from the browser' : action.type === 'stop' ? 'Could not stop the turn from the browser' : 'Its button in the browser failed', error, isCritical: true }))
    redrawSoon()
  }

  const follow = async (ready: Program) => {
    if (isFollowing) return
    isFollowing = true
    try {
      while (isOn()) {
        try {
          address = (await ready.ready()).url
          aboutPosted = ''
          posted.clear()
          measureSoon()
          await call(`/api/sessions/${sessions.current.id}`, { about: about() })
          while (isOn()) hear((await call(`/api/sessions/${sessions.current.id}/events`)) as SessionEvents)
        } catch (error) {
          address = undefined
          if (isOn()) claude.ui.warn('web:follow', `cmod: the web UI lost this session, and asks again in ${retryMs} ms: ${messageOf(error)}`)
          await wait(retryMs)
        }
      }
    } finally {
      address = undefined
      views = []
      shown.showInBrowser(new Set())
      isFollowing = false
    }
  }

  const serve = (): Program | undefined => {
    if (!isOn()) return undefined
    server ??= mod.use(program({ command: ['cmod', 'web', 'serve'], singleInstance: true, isWebApp: true }))
    void follow(server)
    return server
  }

  const openInBrowser = async () => {
    try {
      if (!isOn()) {
        await writePreference(mod, 'servesWebUi', true)
        await refreshPreferences(mod)
      }
      await serve()?.ready()
      const { exitCode, stdout, stderr } = await claude.process.run(['cmod', 'web'])
      const home = stdout.trim().split('\n')[0] ?? ''
      const address = Button({ plain: true, key: 'web:address', href: home, label: home })
      if (exitCode === 0) mod.toast.success('The browser app is open', { description: address })
      else if (home !== '') mod.toast.info('Open this address in your browser', { description: address, duration: Number.POSITIVE_INFINITY })
      else report({ id: 'web:open', message: 'Could not open the browser app', description: `cmod web ${formatExit(exitCode, cmodError(stderr, 'web'))}`, isCritical: true })
    } catch (error) {
      report({ id: 'web:open', message: 'Could not open the browser app', error, isCritical: true })
    }
  }

  onRedraw(() => {
    if (address !== undefined) redrawSoon()
  })
  claude.clock.after(0, () => void refreshPreferences(mod).then(serve, (error: unknown) => report({ id: 'web', message: 'Could not read whether the web UI is on', error })))

  return {
    serve,
    openInBrowser: () => new Promise<void>((resolve) => void claude.clock.after(0, () => void openInBrowser().then(resolve))),
  }
}
