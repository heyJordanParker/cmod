import type { ElementTable, MarkdownProps, PaneOpenArgs, RenderElement } from 'claude-code'
import type { Mod, Turn } from '../mod.js'
import { isObject } from '../records.js'
import { TurnEnd, type Area, type Widget, type WidgetContext, type WidgetInit } from '../ui/areas.js'
import { Box, drawWith, elementData, Text, type Handler } from '../ui/elements.js'
import type { Block, MarkdownReader } from '../ui/markdown.js'
import { checkPane, checkPart, sizeKeys, type OpenOptions, type Page, type PageInit, type Pane, type PaneInit, type ScrollOptions, type ScrollTarget } from '../ui/panes.js'
import { componentOf, nameOf, type Kind, type Style, type StyleInit } from '../ui/styles.js'
import type { Subscription } from '../utils/subscription.js'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import { cmodPluginName } from './dependencies.js'
import type { Router } from './router.js'
import type { Failure } from './toaster.js'

export const partMethods = {
  list: 'cmod:parts',
  draw: 'cmod:draw',
  press: 'cmod:press',
  shown: 'cmod:shown',
  changed: 'cmod:partsChanged',
} as const

export type PagePlace = 'sidebar' | 'settings'

export type WidgetDeclaration = { readonly id: string; readonly title: string; readonly areas: readonly Area[] }

export type PageDeclaration = { readonly id: string; readonly title: string; readonly place: PagePlace }

export type PartList = { readonly widgets: readonly WidgetDeclaration[]; readonly pages: readonly PageDeclaration[] }

export type PartDraw =
  | { readonly widget: string; readonly area: Area; readonly columns: number; readonly turn?: Turn }
  | { readonly page: string; readonly params: unknown; readonly columns: number; readonly isFocused: boolean }

export type PartPress = { readonly draw: number; readonly handler: number; readonly args: readonly unknown[] }

export type DrawnPart = { readonly draw: number; readonly tree: unknown }

export type PageRequest =
  | { readonly open: string; readonly params?: unknown; readonly focus?: true }
  | { readonly close: string }
  | { readonly scroll: string; readonly to: ScrollTarget; readonly block?: ScrollOptions['block'] }
  | { readonly settings: true; readonly tab?: SettingsTab }

export type SettingsTab = 'changelog' | 'permissions'

export type PartsUpdate = { readonly parts?: PartList; readonly redraw?: true; readonly requests?: readonly PageRequest[]; readonly isAsked?: true }

export type ShownPages = { readonly open: readonly { readonly id: string; readonly params: unknown }[]; readonly shown: string | null; readonly isFocused: boolean }


type PaneSize = Pick<PaneOpenArgs, 'columns' | 'rows'>

const bullet = '⏺'

function paneSize<State extends object>(pane: PaneInit<State, never>, state: State): PaneSize {
  const size: { columns?: number; rows?: number } = {}
  for (const key of sizeKeys) {
    const wanted = pane[key]
    const value = typeof wanted === 'function' ? wanted(state) : wanted
    if (value === undefined) continue
    if (!Number.isInteger(value) || value <= 0) throw new Error(`the pane "${pane.id}" gets ${key} ${value} from its state. Return a whole number above 0, or undefined for Claude Code's default.`)
    size[key] = value
  }
  return size
}

function times(count: number): string {
  return count === 1 ? '1 time' : `${count} times`
}

function pieceProps(props: object, given: object, isFirst: boolean): object {
  const merged = { ...props, ...given }
  return isFirst || !('isFirstOfReply' in merged) ? merged : { ...merged, isFirstOfReply: false }
}

function threw(error: unknown): string {
  return `threw, so Claude Code draws its own: ${messageOf(error)}`
}

type DrawnPiece = { readonly drawing: RenderElement; readonly isClaudesRow: boolean }

async function drawComponent<Given extends object>(
  table: ElementTable,
  draw: (Default: (props: Given & { readonly children?: unknown }) => RenderElement) => RenderElement,
  drawDefault: (given: Given, isClaudesRow: boolean) => Promise<RenderElement>,
): Promise<DrawnPiece | { readonly failure: string }> {
  const calls: { readonly given: Given; readonly drawing: RenderElement }[] = []
  let first: RenderElement
  try {
    first = drawWith(table, () =>
      draw(({ children, ...props }) => {
        const drawing = Box({})
        calls.push({ given: props as Given, drawing })
        return drawing
      }),
    )
  } catch (error) {
    return { failure: threw(error) }
  }
  if (calls.length === 0) return { drawing: first, isClaudesRow: false }
  const whole = calls.findIndex((call) => call.drawing === first)
  const pieces = await Promise.all(calls.map(({ given }, index) => drawDefault(given, index === whole)))
  let used = 0
  let second: RenderElement
  try {
    second = drawWith(table, () => draw(() => pieces[used++] ?? Box({})))
  } catch (error) {
    return { failure: threw(error) }
  }
  if (used !== pieces.length) return { failure: `used Default ${times(pieces.length)}, then ${times(used)}, so Claude Code draws its own. A render must draw the same for the same props.` }
  return { drawing: second, isClaudesRow: whole >= 0 }
}

function drawPieces(pieces: readonly DrawnPiece[], place: 'pane' | 'opensReply' | 'inReply'): RenderElement {
  const spaced = pieces.map(({ drawing, isClaudesRow }, index) => ((index > 0 || place === 'inReply') && !isClaudesRow ? Box({ marginTop: 1, children: drawing }) : drawing))
  const column = (drawings: readonly RenderElement[]) => Box({ flexDirection: 'column', children: drawings })
  const [opening, ...rest] = spaced
  if (place !== 'opensReply' || opening === undefined) return column(spaced)
  if (pieces[0]?.isClaudesRow !== true) return Box({ children: [Box({ minWidth: 2, children: Text({ color: 'text', children: bullet }) }), column(spaced)] })
  return column([opening, Box({ paddingLeft: 2, children: column(rest) })])
}

function merged(updates: readonly PartsUpdate[]): PartsUpdate {
  const parts = updates.findLast((update) => update.parts !== undefined)?.parts
  const requests = updates.flatMap((update) => update.requests ?? [])
  const isRedrawn = updates.some((update) => update.redraw === true)
  return { ...(parts === undefined ? {} : { parts }), ...(isRedrawn ? { redraw: true } : {}), ...(requests.length === 0 ? {} : { requests }) }
}

type MarkdownRender = {
  readonly Component: (props: object) => RenderElement
  readonly log: (failure: string) => void
}

type AddedPane<State extends object> = { readonly init: PaneInit<State, unknown>; params: unknown }

type AddedPage<State extends object> = { readonly init: PageInit<State, unknown>; readonly place: PagePlace; params: unknown }

export type UiOptions<State extends object> = {
  readonly name: string
  readonly claude: Claude
  readonly router: Router
  readonly report: (failure: Failure) => void
  readonly announce: (feature: string) => void
  readonly mod: () => Mod<State>
}

export type UiArea<State extends object> = {
  readonly panes: Mod<State>['panes']
  readonly sidebar: Mod<State>['sidebar']
  readonly settings: Mod<State>['settings']
  readonly widgets: Mod<State>['widgets']
  readonly styles: Mod<State>['styles']
  asked<Value>(run: () => Value | Promise<Value>): Promise<Value>
  answerInput<Answer>(run: () => Promise<Answer>, passOn: () => Promise<unknown>): Promise<Answer>
  answer(method: string, input: unknown): Promise<{ readonly value: unknown }> | undefined
  started(): void
  changed(): void
  restorePanes(): Promise<void>
}

const keptDrawInputs = 200

export function createUi<State extends object>({ name, claude, router, report, announce, mod }: UiOptions<State>): UiArea<State> {
  const panes = new Map<string, AddedPane<State>>()
  const paneLogs = new Map<string, (failure: string) => void>()
  const openPanes = new Set<string>()
  const paneStates = new Map<string, { readonly isShown: boolean; readonly isFocused: boolean }>()
  const syncPanes = async () => {
    for (const open of await claude.ui.panes()) {
      if (!panes.has(open.id)) continue
      if (open.isPlaced) openPanes.add(open.id)
      paneStates.set(open.id, { isShown: open.isShown, isFocused: open.isFocused })
    }
  }
  const readPanes = () => void syncPanes().catch((error: unknown) => claude.ui.log(`${name} keeps its panes' shown and focused state from before: ${messageOf(error)}`, { to: 'debug' }))
  const requestedSizes = new Map<string, PaneSize>()
  const styles = new Set<string>()
  const markdownRenders = new Map<string, MarkdownRender>()
  let read: MarkdownReader | undefined
  let isRouted = false
  let isResizeQueued = false
  const widgets = new Map<string, WidgetInit<State>>()
  const widgetAreas = new Map<string, Area>()
  const pages = new Map<string, AddedPage<State>>()
  let shownPages: ShownPages = { open: [], shown: null, isFocused: false }
  const draws = new Map<number, { readonly id: string; readonly handlers: readonly Handler[] }>()
  const latestDraws = new Map<string, Map<string, readonly number[]>>()
  const failedDraws = new Set<string>()
  let drawCount = 0
  let beforeStart: PartsUpdate[] | undefined = []
  let askedDepth = 0
  let unheldRequests = 0
  let collected: PartsUpdate[] | undefined
  let collecting = 0
  let queued: PartsUpdate[] | undefined

  const partList = (): PartList => ({
    widgets: [...widgets.values()].map(({ id, title, areas: listed }) => ({ id, title, areas: listed })),
    pages: [...pages.values()].map(({ init: { id, title }, place }) => ({ id, title, place })),
  })

  const send = (update: PartsUpdate) => {
    if (collected !== undefined) return void collected.push(update)
    if (beforeStart !== undefined) return void beforeStart.push(update)
    const isAsked = askedDepth > 0
    if (queued !== undefined && !isAsked) return void queued.push(update)
    const batch: PartsUpdate[] = [update]
    if (!isAsked) queued = batch
    const tell = () => {
      if (queued === batch) queued = undefined
      const input = { ...merged(batch), ...(isAsked ? { isAsked: true as const } : {}) }
      return claude.cmod.call({ to: cmodPluginName, method: partMethods.changed, input }).then(
        (answer) => {
          if (isAsked && input.requests !== undefined && !(isObject(answer) && answer['isHeld'] === true)) unheldRequests += 1
        },
        (error: unknown) => claude.ui.log(`${name}: the cmod plugin did not hear about its pages and widgets: ${messageOf(error)}`, { to: 'debug' }),
      )
    }
    return isAsked ? tell() : Promise.resolve().then(tell)
  }

  const asked = async <Value>(run: () => Value | Promise<Value>): Promise<Value> => {
    askedDepth += 1
    try {
      return await run()
    } finally {
      askedDepth -= 1
    }
  }

  const collect = async (run: () => unknown): Promise<PartsUpdate> => {
    collecting += 1
    collected ??= []
    try {
      await run()
    } finally {
      collecting -= 1
    }
    const mine = collected
    collected = collecting === 0 ? undefined : []
    return merged(mine)
  }

  const logOnce = (what: string) => {
    let hasLogged = false
    return (failure: string) => {
      if (!hasLogged) report({ id: `draw:${what}`, message: `The ${what} failed`, description: failure })
      hasLogged = true
    }
  }

  const renderOf = (type: string) => markdownRenders.get(type)

  const markdownIn = (table: ElementTable) => {
    const reader = read
    if (reader === undefined) return undefined
    return (props: MarkdownProps) => {
      const pieces = reader(props.text, renderOf)
      if (pieces.every((piece) => 'text' in piece)) return table.Markdown(props)
      const drawClaudes = (text: string) => table.Markdown({ ...props, text })
      const drawings = pieces.map((piece) => {
        if ('text' in piece) return drawClaudes(piece.text)
        const { render, props: block } = piece
        try {
          return drawWith(table, () => render.Component({ ...block, Default: ({ source = block.source }: { readonly source?: string }) => drawClaudes(source) }))
        } catch (error) {
          render.log(threw(error))
          return drawClaudes(block.source)
        }
      })
      return drawPieces(drawings.map((drawing) => ({ drawing, isClaudesRow: false })), 'pane')
    }
  }

  const routeMarkdown = (createReader: () => MarkdownReader) => {
    if (read !== undefined) return
    const reader = createReader()
    read = reader
    router.add('ui.render', async (e, next) => {
      if (e.component !== 'AssistantMessage') return next(e)
      const pieces = reader(e.props.text, renderOf, e.requestId)
      if (pieces.every((piece) => 'text' in piece)) return next(e)
      const table = claude.ui.resolve(e)
      const drawClaudes = (text: string, isFirst: boolean) => next({ ...e, props: pieceProps(e.props, { text }, isFirst) } as typeof e)
      const drawn = await Promise.all(
        pieces.map(async (piece, index): Promise<DrawnPiece> => {
          if ('text' in piece) return { drawing: await drawClaudes(piece.text, index === 0), isClaudesRow: true }
          const { render, props: block } = piece
          const component = await drawComponent<{ readonly source?: string }>(
            table,
            (Default) => render.Component({ ...block, Default }),
            ({ source = block.source }, isClaudesRow) => drawClaudes(source, index === 0 && isClaudesRow),
          )
          if (!('failure' in component)) return component
          render.log(component.failure)
          return { drawing: await drawClaudes(block.source, index === 0), isClaudesRow: true }
        }),
      )
      return drawWith(table, () => drawPieces(drawn, e.props.isFirstOfReply ? 'opensReply' : 'inReply'))
    })
  }

  const openAt = (pane: PaneInit<State, never>, size: PaneSize, focus?: true) => {
    requestedSizes.set(pane.id, size)
    const { id, title, closeOnEscape, holdToasts } = pane
    return claude.ui.open({ id, title, ...size, ...(closeOnEscape === true ? { closeOnEscape } : {}), ...(holdToasts === true ? { holdToasts } : {}), ...(focus === true ? { focus } : {}) })
  }

  const resize = async (pane: PaneInit<State, never>) => {
    try {
      const size = paneSize(pane, mod().state)
      const requested = requestedSizes.get(pane.id)
      if (requested?.columns === size.columns && requested?.rows === size.rows) return
      await openAt(pane, size)
    } catch (error) {
      claude.ui.log(`${name}: the ${pane.title} pane kept its size: ${messageOf(error)}`, { to: 'debug' })
    }
  }

  const handle = async (pane: PaneInit<State, never>, handler: string, run: () => unknown) => {
    try {
      await run()
    } catch (error) {
      report({ id: `pane:${pane.id}:${handler}`, message: `The ${pane.title} pane's ${handler} threw`, error })
    }
  }

  const routePanes = () => {
    if (isRouted) return
    isRouted = true
    router.add('ui.render', (e, next) => {
      const added = panes.get(e.requestId)
      if (added === undefined || e.component !== 'Pane') return next(e)
      const { init } = added
      openPanes.add(init.id)
      paneStates.set(init.id, { isShown: true, isFocused: e.props.isFocused })
      readPanes()
      const table = claude.ui.resolve(e)
      try {
        return drawWith(table, () => init.render(mod(), { ...e.props, params: added.params }), markdownIn(table))
      } catch (error) {
        paneLogs.get(init.id)?.(`threw: ${messageOf(error)}`)
        return drawWith(table, () => Text({ color: 'error', children: `The ${init.title} pane could not draw: ${messageOf(error)}` }))
      }
    })
    router.add('ui.scroll', async (e, next) => {
      const init = panes.get(e.requestId)?.init
      const moved = await next(e)
      if (init?.onScroll === undefined || e.component !== 'Pane' || moved.deny !== undefined) return moved
      await handle(init, 'onScroll', () => init.onScroll?.(mod(), e))
      return moved
    })
    router.add('ui.close', async (e, next) => {
      openPanes.delete(e.id)
      paneStates.delete(e.id)
      readPanes()
      const closed = await next(e)
      const init = panes.get(e.id)?.init
      if (init?.onClose !== undefined) await handle(init, 'onClose', () => init.onClose?.(mod(), e))
      return closed
    })
  }

  const scrollIn = (id: string, target: ScrollTarget, options?: ScrollOptions) =>
    claude.ui.scroll({ to: target, in: id, ...(options?.block === undefined ? {} : { block: options.block }) }).then(({ deny }) => {
      if (deny !== undefined) throw new Error(`${name}: Claude Code did not scroll ${id}: ${deny}`)
    })

  const addPane = <Params>(init: PaneInit<State, Params>): Pane<Params> => {
    checkPane(name, init)
    if (panes.has(init.id)) throw new Error(`${name}: the pane "${init.id}" is already added. Give each pane its own id.`)
    const added: AddedPane<State> = { init, params: undefined }
    panes.set(init.id, added)
    paneLogs.set(init.id, logOnce(`${init.title} pane`))
    announce(`the ${init.title} pane`)
    routePanes()
    const sized = init as unknown as PaneInit<State, never>
    const pane: Pane<Params> = {
      id: init.id,
      get isOpen() {
        return openPanes.has(init.id)
      },
      get isShown() {
        return paneStates.get(init.id)?.isShown ?? false
      },
      get isFocused() {
        return paneStates.get(init.id)?.isFocused ?? false
      },
      get params() {
        return added.params as Params | undefined
      },
      async open(...[options]: [OpenOptions<Params>?]) {
        if (options !== undefined && 'params' in options) added.params = options.params
        const { isPlaced } = await openAt(sized, paneSize(sized, mod().state), options?.focus)
        if (isPlaced) openPanes.add(init.id)
        await syncPanes()
        claude.ui.invalidate('ui.render')
      },
      async close() {
        await claude.ui.close({ id: init.id })
        openPanes.delete(init.id)
        paneStates.delete(init.id)
        await syncPanes()
      },
      toggle: (options) => (openPanes.has(init.id) ? pane.close() : (pane.open as (options?: OpenOptions<Params>) => Promise<void>)(options as OpenOptions<Params>)),
      scrollTo: (target, options) => scrollIn(init.id, target, options),
      remove() {
        if (panes.get(init.id) !== added) return
        panes.delete(init.id)
        paneLogs.delete(init.id)
        if (openPanes.has(init.id)) void claude.ui.close({ id: init.id }).catch((error: unknown) => claude.ui.log(`${name}: the ${init.title} pane stayed open: ${messageOf(error)}`, { to: 'debug' }))
        openPanes.delete(init.id)
        paneStates.delete(init.id)
      },
    }
    return pane
  }

  const pageEntry = (id: string) => shownPages.open.find((each) => each.id === id)

  const addPage = <Params>(place: PagePlace, init: PageInit<State, Params>): Page<Params> => {
    checkPart(name, 'page', init.id, init.title)
    if (pages.has(init.id)) throw new Error(`${name}: the page "${init.id}" is already added. Give each page its own id.`)
    const added: AddedPage<State> = { init, place, params: undefined }
    pages.set(init.id, added)
    announce(place === 'settings' ? `the ${init.title} page in Settings` : `the ${init.title} page in the Sidebar`)
    void send({ parts: partList() })
    const page: Page<Params> = {
      id: init.id,
      get isOpen() {
        return place === 'settings' ? shownPages.shown === init.id : pageEntry(init.id) !== undefined
      },
      get isShown() {
        return shownPages.shown === init.id
      },
      get isFocused() {
        return shownPages.shown === init.id && shownPages.isFocused
      },
      get params() {
        return (pageEntry(init.id)?.params ?? added.params) as Params | undefined
      },
      async open(...[options]: [OpenOptions<Params>?]) {
        if (options !== undefined && 'params' in options) added.params = options.params
        await send({ requests: [{ open: init.id, ...(added.params === undefined ? {} : { params: added.params }), ...(options?.focus === true ? { focus: true } : {}) }] })
      },
      toggle: (options) => (page.isOpen ? page.close() : (page.open as (options?: OpenOptions<Params>) => Promise<void>)(options as OpenOptions<Params>)),
      close: async () => {
        await send({ requests: [{ close: init.id }] })
      },
      scrollTo: async (target, options) => {
        await send({ requests: [{ scroll: init.id, to: target, ...(options?.block === undefined ? {} : { block: options.block }) }] })
      },
      remove() {
        if (pages.get(init.id) !== added) return
        pages.delete(init.id)
        forgetDraws(`page:${init.id}`)
        void send({ parts: partList(), requests: [{ close: init.id }] })
      },
    }
    return page
  }

  const addWidget = (init: WidgetInit<State>): Widget => {
    checkPart(name, 'widget', init.id, init.title)
    if (widgets.has(init.id)) throw new Error(`${name}: the widget "${init.id}" is already added. Give each widget its own id.`)
    widgets.set(init.id, init)
    announce(`the ${init.title} widget`)
    void send({ parts: partList() })
    return {
      id: init.id,
      get area() {
        return widgetAreas.get(init.id)
      },
      remove() {
        if (widgets.get(init.id) !== init) return
        widgets.delete(init.id)
        widgetAreas.delete(init.id)
        forgetDraws(`widget:${init.id}`)
        void send({ parts: partList() })
      },
    }
  }

  const addStyle = <K extends Kind>({ kind, render }: StyleInit<K, State>): Style => {
    const markdown: Block | undefined = typeof kind === 'string' ? undefined : kind
    const component = componentOf(kind)
    if (markdown === undefined && component === undefined) throw new Error(`${name}: ${String(kind)} is not a kind styles.add draws, such as ToolCall or CodeBlock.`)
    const feature = `the style of ${nameOf(kind)}`
    if (styles.has(feature)) throw new Error(`${name}: ${feature} is already added. Add one style per kind.`)
    styles.add(feature)
    announce(feature)
    const Component = (props: object) => render(mod(), props as never)
    const stop = (subscription?: Subscription) => () => {
      subscription?.remove()
      if (markdown !== undefined) markdownRenders.delete(markdown.markdown)
      styles.delete(feature)
      claude.ui.invalidate('ui.render')
    }
    if (markdown !== undefined) {
      markdownRenders.set(markdown.markdown, { Component, log: logOnce(`${nameOf(kind)} style`) })
      routeMarkdown(markdown.createReader)
      return { kind, remove: stop() }
    }
    const log = logOnce(`${nameOf(kind)} style`)
    const drawing = router.add('ui.render', async (e, next) => {
      if (e.component !== component) return next(e)
      const table = claude.ui.resolve(e)
      const drawn = await drawComponent(
        table,
        (Default) => Component({ ...e.props, Default }),
        (given, isClaudesRow) => next({ ...e, props: pieceProps(e.props, given, isClaudesRow) } as typeof e),
      )
      if ('failure' in drawn) {
        log(drawn.failure)
        return next(e)
      }
      if (e.component !== 'AssistantMessage') return drawn.drawing
      return drawWith(table, () => drawPieces([drawn], e.props.isFirstOfReply ? 'opensReply' : 'inReply'))
    })
    return { kind, remove: stop(drawing) }
  }

  const forgetDraws = (key: string) => {
    for (const kept of latestDraws.get(key)?.values() ?? []) for (const draw of kept) draws.delete(draw)
    latestDraws.delete(key)
  }

  const drawPart = (key: string, title: string, input: PartDraw, render: () => RenderElement | undefined): DrawnPart | null => {
    try {
      const pressed: Handler[] = []
      const drawn = render()
      const tree = drawn === undefined ? null : elementData(drawn, pressed)
      failedDraws.delete(key)
      drawCount += 1
      const inputs = latestDraws.get(key) ?? new Map<string, readonly number[]>()
      latestDraws.set(key, inputs)
      const drawnFor = JSON.stringify('turn' in input ? { ...input, turn: input.turn.prompt.id } : input)
      const earlier = inputs.get(drawnFor) ?? []
      const kept = [...earlier, drawCount].slice(-2)
      for (const draw of earlier) if (!kept.includes(draw)) draws.delete(draw)
      inputs.delete(drawnFor)
      inputs.set(drawnFor, kept)
      const [oldest] = inputs
      if (inputs.size > keptDrawInputs && oldest !== undefined) {
        for (const draw of oldest[1]) draws.delete(draw)
        inputs.delete(oldest[0])
      }
      draws.set(drawCount, { id: key, handlers: pressed })
      return { draw: drawCount, tree }
    } catch (error) {
      if (!failedDraws.has(key)) report({ id: key, message: `The ${title} could not draw`, error })
      failedDraws.add(key)
      return null
    }
  }

  const draw = (input: PartDraw): DrawnPart | null => {
    if ('page' in input) {
      const added = pages.get(input.page)
      if (added === undefined) return null
      return drawPart(`page:${input.page}`, `${added.init.title} page`, input, () => added.init.render(mod(), { params: input.params, isFocused: input.isFocused, columns: input.columns }))
    }
    const widget = widgets.get(input.widget)
    if (widget === undefined || !widget.areas.includes(input.area)) return null
    widgetAreas.set(widget.id, input.area)
    const context = (input.area === TurnEnd && input.turn !== undefined ? { area: input.area, columns: input.columns, turn: input.turn } : { area: input.area, columns: input.columns }) as WidgetContext
    return drawPart(`widget:${widget.id}`, `${widget.title} widget`, input, () => widget.render(mod(), context))
  }

  const press = async ({ draw: drawn, handler, args }: PartPress): Promise<PartsUpdate> => {
    const known = draws.get(drawn)
    const run = known?.handlers[handler]
    if (known === undefined || run === undefined) throw new Error(`${name}: that button drew before the last redraw. Press the one it shows now.`)
    return collect(async () => {
      try {
        await run(...args)
      } catch (error) {
        report({ id: known.id, message: 'Its button failed', error })
      }
    })
  }

  return {
    panes: { add: addPane },
    sidebar: { add: (init) => addPage('sidebar', init) },
    settings: {
      add: (init) => addPage('settings', init),
      open: async () => {
        await send({ requests: [{ settings: true }] })
      },
    },
    widgets: { add: addWidget },
    styles: { add: addStyle },
    asked,
    async answerInput(run, passOn) {
      const before = unheldRequests
      const answer = await asked(run)
      if (unheldRequests > before) await passOn()
      return answer
    },
    answer(method, input) {
      if (method === partMethods.list) return Promise.resolve({ value: partList() })
      if (method === partMethods.draw) return Promise.resolve({ value: draw(input as PartDraw) })
      if (method === partMethods.press) return press(input as PartPress).then((value) => ({ value }))
      if (method === partMethods.shown) {
        shownPages = input as ShownPages
        return Promise.resolve({ value: null })
      }
      return undefined
    },
    started() {
      const held = merged(beforeStart ?? [])
      beforeStart = undefined
      void send({ ...held, parts: partList() })
    },
    changed() {
      if (widgets.size > 0 || pages.size > 0) void send({ redraw: true })
      if (panes.size === 0 && styles.size === 0) return
      claude.ui.invalidate('ui.render')
      if (isResizeQueued) return
      isResizeQueued = true
      void Promise.resolve().then(() => {
        isResizeQueued = false
        for (const { init } of panes.values()) {
          if (openPanes.has(init.id)) void resize(init)
        }
      })
    },
    async restorePanes() {
      if (panes.size > 0) await syncPanes()
    },
  }
}
