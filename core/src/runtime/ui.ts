import type { Args, ElementTable, Frozen, MarkdownProps, PaneOpenArgs, RenderElement, RenderSurface } from 'claude-code'
import type { Mod, Surface, Turn } from '../mod.js'
import { browserCommand, isObject } from '../records.js'
import { TurnEnd, type Area, type Widget, type WidgetContext, type WidgetInit } from '../ui/areas.js'
import { Box, drawKeyed, drawsFocusable, drawWith, elementData, Markdown, Text, type Handler } from '../ui/elements.js'
import type { Block, MarkdownPiece, MarkdownReader } from '../ui/markdown.js'
import { checkPane, checkPart, sizeKeys, type OpenOptions, type Pane, type PaneInit, type ScrollOptions, type ScrollTarget, type View, type ViewInit } from '../ui/panes.js'
import { componentOf, nameOf, type Kind, type Style, type StyledAt, type StyleInit } from '../ui/styles.js'
import type { Subscription } from '../utils/subscription.js'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import { styleInterface } from './interfaces.js'
import { cmodPluginName } from './dependencies.js'
import type { Router } from './router.js'
import type { Failure } from './toaster.js'

export const partMethods = {
  list: 'cmod:parts',
  draw: 'cmod:draw',
  press: 'cmod:press',
  shown: 'cmod:shown',
  changed: 'cmod:partsChanged',
  stylers: 'cmod:markdownStylers',
} as const

export const stalePress = 'that button drew before the last redraw. Press the one it shows now.'

export type ViewPlace = 'sidebar' | 'settings'

export type WidgetDeclaration = { readonly id: string; readonly title: string; readonly areas: readonly Area[]; readonly place?: NonNullable<WidgetInit['place']> }

export type ViewDeclaration = { readonly id: string; readonly title: string; readonly place: ViewPlace }

export type PageDeclaration = { readonly id: string; readonly title: string }

export type PartDeclaration = PageDeclaration & { readonly place?: ViewPlace }

export type PartList = { readonly widgets: readonly WidgetDeclaration[]; readonly pages: readonly PartDeclaration[]; readonly provides?: readonly string[] }

export type PartDraw =
  | { readonly widget: string; readonly area: Area; readonly columns: number; readonly surface: Surface; readonly turn?: Turn }
  | { readonly page: string; readonly params: unknown; readonly columns: number; readonly isFocused: boolean; readonly surface: Surface }
  | ({ readonly markdown: string } & StyledAt)

export type BorrowedMarkdown = (mod: string, cached: string, input: { readonly markdown: string } & StyledAt, scope: string) => RenderElement | undefined

const unmeasuredColumns = 80

export function viewportColumns(e: Frozen<Args<'ui.render'>>): number {
  return e.viewport?.columns ?? unmeasuredColumns
}

export function styledAt(e: Frozen<Args<'ui.render'>>, columns = viewportColumns(e)): StyledAt {
  return { surface: e.surface, columns: Math.max(columns, 0) }
}

export async function openLink(claude: Claude, href: string, surface: RenderSurface): Promise<'opened' | 'copied'> {
  if (surface === 'terminal') {
    const [browser, sshConnection, display, waylandDisplay] = await Promise.all([claude.env.browser(), claude.env.sshConnection(), claude.env.display(), claude.env.waylandDisplay()])
    const os = browser || sshConnection ? '' : (await claude.process.run(['uname', '-s'])).stdout.trim().toLowerCase()
    const command = browserCommand({ os, browser, sshConnection, display, waylandDisplay }, href)
    if (command !== undefined && (await claude.process.run(command)).exitCode === 0) return 'opened'
  }
  const copied = await claude.ui.copy({ text: href, surface })
  if (!copied.isCopied) throw new Error(`cmod could not open ${href} or copy it: ${copied.reason}`)
  return 'copied'
}

export type PartPress = { readonly draw: number; readonly handler: number; readonly args: readonly unknown[] }

export type DrawnPart = { readonly draw: number; readonly tree: unknown }

export type PartRequest =
  | { readonly open: string; readonly params?: unknown; readonly focus?: true }
  | { readonly close: string }
  | { readonly scroll: string; readonly to: ScrollTarget; readonly block?: ScrollOptions['block'] }
  | { readonly focus: string; readonly key: string }
  | { readonly settings: true; readonly tab?: SettingsTab }

export type SettingsTab = 'changelog' | 'permissions'

export type PartsUpdate = { readonly parts?: PartList; readonly redraw?: true; readonly changed?: readonly string[]; readonly requests?: readonly PartRequest[]; readonly isAsked?: true; readonly isStart?: true }

export type ShownParts = { readonly open: readonly { readonly id: string; readonly params: unknown }[]; readonly shown: string | null; readonly isFocused: boolean; readonly inApps?: readonly string[] }


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

function laterKeys(key: string | undefined): () => string | undefined {
  let used = 0
  return () => (key === undefined ? undefined : `${key}:${(used += 1)}`)
}

export function inheriting(props: MarkdownProps, draw: (drawn: MarkdownProps) => RenderElement, laterKey = laterKeys(props.key)): (left: MarkdownProps) => RenderElement {
  const { dimColor, onLinkPress, pressableLinks } = props
  const inherited = { ...(dimColor === undefined ? {} : { dimColor }), ...(onLinkPress === undefined ? {} : { onLinkPress }), ...(pressableLinks === undefined ? {} : { pressableLinks }) }
  let isKeyTaken = false
  const keyOf = (left: MarkdownProps) => {
    if (left.key !== undefined) return left.key
    if (isKeyTaken) return laterKey()
    isKeyTaken = true
    return props.key
  }
  return (left) => {
    const key = keyOf(left)
    return draw({ ...inherited, ...(key === undefined ? {} : { key }), ...left })
  }
}

function threw(error: unknown): string {
  return `threw, so Claude Code draws its own: ${messageOf(error)}`
}

type DrawnPiece = { readonly drawing: RenderElement; readonly isClaudesRow: boolean }

type SentDrawing = { readonly draws: readonly number[]; readonly tree: string; readonly render: () => RenderElement | undefined }

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
        const drawing = table.Box({})
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

export function merged(updates: readonly PartsUpdate[]): PartsUpdate {
  const parts = updates.findLast((update) => update.parts !== undefined)?.parts
  const requests = updates.flatMap((update) => update.requests ?? [])
  const isRedrawn = updates.some((update) => update.redraw === true)
  const changed = [...new Set(updates.flatMap((update) => update.changed ?? []))]
  const isStart = updates.some((update) => update.isStart === true)
  return { ...(parts === undefined ? {} : { parts }), ...(isRedrawn ? { redraw: true } : {}), ...(changed.length === 0 ? {} : { changed }), ...(requests.length === 0 ? {} : { requests }), ...(isStart ? { isStart } : {}) }
}

type MarkdownRender = {
  readonly Component: (props: object) => RenderElement
  readonly log: (failure: string) => void
}

type AddedPane<State extends object> = { readonly init: PaneInit<State, unknown>; params: unknown }

type AddedPart<State extends object> = { readonly init: ViewInit<State, unknown>; readonly kind: 'view' | 'page'; readonly place: ViewPlace | undefined; params: unknown }

export type UiOptions<State extends object> = {
  readonly name: string
  readonly claude: Claude
  readonly router: Router
  readonly report: (failure: Failure) => void
  readonly announce: (feature: string) => void
  readonly mod: () => Mod<State>
  readonly borrowed: BorrowedMarkdown
  readonly nextDraw: () => number
  readonly provided: () => readonly string[]
}

export type UiArea<State extends object> = {
  readonly panes: Mod<State>['panes']
  readonly views: Mod<State>['views']
  readonly pages: Mod<State>['pages']
  readonly settings: Mod<State>['settings']
  readonly widgets: Mod<State>['widgets']
  readonly styles: Mod<State>['styles']
  asked<Value>(run: () => Value | Promise<Value>): Promise<Value>
  answerInput<Answer>(run: () => Promise<Answer>, passInput: () => Promise<unknown>): Promise<Answer>
  answer(method: string, input: unknown, caller: string): Promise<{ readonly value: unknown }> | undefined
  markdownIn(table: ElementTable, at: StyledAt): ((props: MarkdownProps) => RenderElement) | undefined
  restyled(stylers: readonly string[]): void
  relisted(): void
  started(): void
  changed(): void
  restorePanes(): Promise<void>
}

export const keptDrawInputs = 200

const tellGapMs = 100

export function createUi<State extends object>({ name, claude, router, report, announce, mod, borrowed, nextDraw, provided }: UiOptions<State>): UiArea<State> {
  const panes = new Map<string, AddedPane<State>>()
  const paneLogs = new Map<string, (failure: string) => void>()
  const openPanes = new Set<string>()
  const paneStates = new Map<string, { readonly isShown: boolean; readonly isFocused: boolean }>()
  const syncPanes = async () => {
    const listed = new Map((await claude.ui.panes()).map((open) => [open.id, open]))
    for (const id of panes.keys()) {
      const open = listed.get(id)
      if (open?.isPlaced === true) openPanes.add(id)
      else openPanes.delete(id)
      if (open === undefined) paneStates.delete(id)
      else paneStates.set(id, { isShown: open.isShown, isFocused: open.isFocused })
    }
  }
  const readPanes = () => syncPanes().catch((error: unknown) => claude.ui.warn('panes:read', `${name} keeps its panes' open, shown, and focused state from before: ${messageOf(error)}`))
  const requestedSizes = new Map<string, PaneSize>()
  const styles = new Set<string>()
  const markdownRenders = new Map<string, MarkdownRender>()
  let read: MarkdownReader | undefined
  let stylers: readonly string[] = []
  let stylersSeen = 0
  let isRouted = false
  let isResizeQueued = false
  const widgets = new Map<string, WidgetInit<State>>()
  const widgetAreas = new Map<string, Area>()
  const parts = new Map<string, AddedPart<State>>()
  let shownParts: ShownParts = { open: [], shown: null, isFocused: false }
  const draws = new Map<number, { readonly id: string; readonly handlers: readonly Handler[] }>()
  const latestDraws = new Map<string, Map<string, SentDrawing>>()
  const failedDraws = new Set<string>()
  let beforeStart: PartsUpdate[] | undefined = []
  let askedDepth = 0
  const askedCalls = new Set<Promise<void>>()
  let unheldRequests = 0
  let collected: PartsUpdate[] | undefined
  let collecting = 0
  let queued: PartsUpdate[] | undefined
  let isCooling = false

  const partList = (): PartList => {
    const provides = [...provided(), ...(markdownRenders.size > 0 ? [styleInterface] : [])]
    return {
      widgets: [...widgets.values()].map(({ id, title, areas: listed, place }) => ({ id, title, areas: listed, ...(place === undefined ? {} : { place }) })),
      pages: [...parts.values()].map(({ init: { id, title }, place }) => ({ id, title, ...(place === undefined ? {} : { place }) })),
      ...(provides.length === 0 ? {} : { provides }),
    }
  }

  const hear = (listed: unknown, isRestyled: boolean) => {
    if (!Array.isArray(listed)) return
    const heard = listed.filter((styler): styler is string => typeof styler === 'string' && styler !== name)
    if (!isRestyled && heard.join('\0') === stylers.join('\0')) return
    stylers = heard
    stylersSeen += 1
    if (name === cmodPluginName || panes.size > 0) claude.ui.invalidate('ui.render')
  }

  const treeOf = (render: () => RenderElement | undefined, handlers: Handler[]) => {
    const drawn = render()
    return drawn === undefined ? null : elementData(drawn, (run) => handlers.push(run) - 1)
  }

  const isDrawingChanged = (key: string, inputs: ReadonlyMap<string, SentDrawing>) => {
    const unchanged: (readonly [SentDrawing, Handler[]])[] = []
    for (const sent of inputs.values()) {
      const handlers: Handler[] = []
      try {
        if (JSON.stringify(treeOf(sent.render, handlers)) !== sent.tree) return true
      } catch (error) {
        claude.ui.warn(`drawing:${key}`, `${name}: the ${key} drawing threw, so the cmod plugin asks for it again: ${messageOf(error)}`)
        return true
      }
      unchanged.push([sent, handlers])
    }
    for (const [sent, handlers] of unchanged) {
      const latest = sent.draws.at(-1)
      if (latest !== undefined && draws.has(latest)) draws.set(latest, { id: key, handlers })
    }
    return false
  }

  const changedParts = () => [...latestDraws].filter(([key, inputs]) => key !== 'markdown' && isDrawingChanged(key, inputs)).map(([key]) => key.slice(key.indexOf(':') + 1))

  const withChangedParts = ({ redraw, ...update }: PartsUpdate): PartsUpdate => {
    if (redraw !== true) return update
    const changed = changedParts()
    return changed.length === 0 ? update : { ...update, redraw, changed }
  }

  const tell = async (needed: PartsUpdate, isAsked: boolean) => {
    if (Object.keys(needed).length === 0) return
    const input = { ...needed, ...(isAsked ? { isAsked: true as const } : {}) }
    return claude.cmod.call({ to: cmodPluginName, method: partMethods.changed, input }).then(
      (answer) => {
        if (isAsked && input.requests !== undefined && !(isObject(answer) && answer['isHeld'] === true)) unheldRequests += 1
        if (isObject(answer) && name !== cmodPluginName) hear(answer['stylers'], false)
      },
      (error: unknown) => {
        claude.ui.warn('parts:tell', `${name}: the cmod plugin did not hear about its widgets, views, and pages: ${messageOf(error)}`)
      },
    )
  }

  const tellQueued = async () => {
    const needed = withChangedParts(merged(queued ?? []))
    queued = undefined
    if (needed.changed !== undefined) {
      isCooling = true
      claude.clock.after(tellGapMs, () => {
        isCooling = false
        if (queued !== undefined) void tellQueued()
      })
    }
    await tell(needed, false)
  }

  const send = (update: PartsUpdate) => {
    if (collected !== undefined) return void collected.push(update)
    if (beforeStart !== undefined) return void beforeStart.push(update)
    if (askedDepth === 0) {
      if (queued !== undefined) return void queued.push(update)
      queued = [update]
      return isCooling ? undefined : Promise.resolve().then(tellQueued)
    }
    const told = tell(withChangedParts(update), true).finally(() => askedCalls.delete(told))
    askedCalls.add(told)
    return told
  }

  const asked = async <Value>(run: () => Value | Promise<Value>): Promise<Value> => {
    askedDepth += 1
    try {
      const value = await run()
      while (askedCalls.size > 0) await Promise.allSettled(askedCalls)
      return value
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
    return withChangedParts(merged(mine))
  }

  const logOnce = (what: string) => {
    let hasLogged = false
    return (failure: string) => {
      if (!hasLogged) report({ id: `draw:${what}`, message: `The ${what} failed`, description: failure })
      hasLogged = true
    }
  }

  const renderOf = (type: string) => markdownRenders.get(type)

  const drawnBlock = (piece: MarkdownPiece<MarkdownRender>, at: StyledAt, drawClaudes: (part: MarkdownProps) => RenderElement, keyPrefix: string, table?: ElementTable): RenderElement => {
    if ('text' in piece) return drawClaudes({ text: piece.text })
    const { render, props: block } = piece
    const draw = () => drawKeyed(keyPrefix, () => render.Component({ ...block, ...at, Default: ({ source = block.source }: { readonly source?: string }) => drawClaudes({ text: source }) }))
    try {
      return table === undefined ? draw() : drawWith(table, draw, drawClaudes)
    } catch (error) {
      render.log(threw(error))
      return drawClaudes({ text: block.source })
    }
  }

  const othersFrom =
    (table: ElementTable, at: StyledAt, from: number, unkeyedScope: () => string) =>
    (props: MarkdownProps, laterKey = laterKeys(props.key)): RenderElement => {
      if (from >= stylers.length) return table.Markdown(props)
      const scope = props.key ?? unkeyedScope()
      for (const [index, styler] of stylers.entries()) {
        if (index < from) continue
        const cached = `${stylersSeen}\u0000${at.surface}\u0000${at.columns}\u0000${props.text}`
        const next = othersFrom(table, at, index + 1, unkeyedScope)
        const drawn = drawWith(table, () => borrowed(styler, cached, { markdown: props.text, ...at }, scope), inheriting(props, (part) => next(part, laterKey), laterKey))
        if (drawn !== undefined) return drawn
      }
      return table.Markdown(props)
    }

  const markdownIn = (table: ElementTable, at: StyledAt) => {
    const reader = read
    let unkeyed = 0
    const unkeyedScope = () => String(unkeyed++)
    const others = othersFrom(table, at, 0, unkeyedScope)
    if (reader === undefined) return stylers.length === 0 ? undefined : others
    return (props: MarkdownProps) => {
      const pieces = reader(props.text, renderOf)
      if (pieces.every((piece) => 'text' in piece)) return others(props)
      const scope = props.key ?? unkeyedScope()
      const laterKey = laterKeys(props.key)
      const drawClaudes = inheriting(props, (part) => others(part, laterKey), laterKey)
      const drawings = pieces.map((piece, index) => drawnBlock(piece, at, drawClaudes, `${scope}:${index}:`, table))
      return drawPieces(drawings.map((drawing) => ({ drawing, isClaudesRow: false })), 'pane')
    }
  }

  const markdownDrawing = (text: string, at: StyledAt): RenderElement => {
    const pieces = read === undefined ? [] : read(text, renderOf)
    if (pieces.every((piece) => 'text' in piece)) return Markdown({ text })
    return drawPieces(pieces.map((piece, index) => ({ drawing: drawnBlock(piece, at, Markdown, `${index}:`), isClaudesRow: false })), 'pane')
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
            (Default) => drawKeyed(`${index}:`, () => render.Component({ ...block, ...styledAt(e), id: e.requestId, Default })),
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
      claude.ui.warn(`pane:resize:${pane.id}`, `${name}: the ${pane.title} pane kept its size: ${messageOf(error)}`)
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
      void readPanes()
      const table = claude.ui.resolve(e)
      try {
        return drawWith(table, () => init.render(mod(), { ...e.props, surface: e.surface, params: added.params }), markdownIn(table, styledAt(e, e.props.bodyColumns)))
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
      const closed = await next(e)
      await readPanes()
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
    checkPane(name, init, panes.has(init.id) ? 'pane' : undefined)
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
      async focus(key) {
        const { deny } = await claude.ui.focus({ requestId: init.id, key })
        if (deny !== undefined) throw new Error(`${name}: Claude Code did not focus "${key}" in the ${init.title} pane: ${deny}`)
      },
      remove() {
        if (panes.get(init.id) !== added) return
        panes.delete(init.id)
        paneLogs.delete(init.id)
        if (openPanes.has(init.id)) void claude.ui.close({ id: init.id }).catch((error: unknown) => claude.ui.warn(`pane:close:${init.id}`, `${name}: the ${init.title} pane stayed open: ${messageOf(error)}`))
        openPanes.delete(init.id)
        paneStates.delete(init.id)
      },
    }
    return pane
  }

  const openEntry = (id: string) => shownParts.open.find((each) => each.id === id)

  const takenBy = (id: string) => (widgets.has(id) ? 'widget' : parts.get(id)?.kind)

  const addPart = <Params>(kind: AddedPart<State>['kind'], init: ViewInit<State, Params>, place?: ViewPlace): View<Params> => {
    checkPart(name, kind, init.id, init.title, takenBy(init.id))
    const added: AddedPart<State> = { init, kind, place, params: undefined }
    const key = `${kind}:${init.id}`
    let requested: readonly [since: ShownParts, isOpen: boolean] | undefined
    parts.set(init.id, added)
    announce(place === 'settings' ? `the ${init.title} view in Settings` : `the ${init.title} ${kind}`)
    void send({ parts: partList() })
    const part: View<Params> = {
      id: init.id,
      get isOpen() {
        if (requested?.[0] === shownParts) return requested[1]
        return place === 'settings' ? shownParts.shown === init.id : openEntry(init.id) !== undefined
      },
      get isShown() {
        return [shownParts.shown, ...(shownParts.inApps ?? [])].includes(init.id)
      },
      get isFocused() {
        return shownParts.shown === init.id && shownParts.isFocused
      },
      get params() {
        return (openEntry(init.id)?.params ?? added.params) as Params | undefined
      },
      async open(...[options]: [OpenOptions<Params>?]) {
        if (options !== undefined && 'params' in options) added.params = options.params
        requested = [shownParts, true]
        await send({ requests: [{ open: init.id, ...(added.params === undefined ? {} : { params: added.params }), ...(options?.focus === true ? { focus: true } : {}) }] })
      },
      toggle: (options) => (part.isOpen ? part.close() : (part.open as (options?: OpenOptions<Params>) => Promise<void>)(options as OpenOptions<Params>)),
      close: async () => {
        requested = [shownParts, false]
        await send({ requests: [{ close: init.id }] })
      },
      scrollTo: async (target, options) => {
        await send({ requests: [{ scroll: init.id, to: target, ...(options?.block === undefined ? {} : { block: options.block }) }] })
      },
      focus: async (focused) => {
        const latest = [...(latestDraws.get(key)?.values() ?? [])].at(-1)
        if (latest === undefined || !drawsFocusable(treeOf(latest.render, []), focused)) throw new Error(`${name}: the ${init.title} ${kind} draws no Button, Input, or Select with the key "${focused}".`)
        await send({ requests: [{ focus: init.id, key: focused }] })
      },
      remove() {
        if (parts.get(init.id) !== added) return
        parts.delete(init.id)
        forgetDraws(key)
        void send({ parts: partList(), requests: [{ close: init.id }] })
      },
    }
    return part
  }

  const addWidget = (init: WidgetInit<State>): Widget => {
    checkPart(name, 'widget', init.id, init.title, takenBy(init.id))
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
      if (markdown !== undefined && markdownRenders.delete(markdown.markdown)) void send({ parts: partList() })
      styles.delete(feature)
      claude.ui.invalidate('ui.render')
    }
    if (markdown !== undefined) {
      markdownRenders.set(markdown.markdown, { Component, log: logOnce(`${nameOf(kind)} style`) })
      routeMarkdown(markdown.createReader)
      void send({ parts: partList() })
      return { kind, remove: stop() }
    }
    const log = logOnce(`${nameOf(kind)} style`)
    const drawing = router.add('ui.render', async (e, next) => {
      if (e.component !== component) return next(e)
      const table = claude.ui.resolve(e)
      const drawn = await drawComponent(
        table,
        (Default) => Component({ ...e.props, ...styledAt(e), id: e.requestId, Default }),
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
    for (const kept of latestDraws.get(key)?.values() ?? []) for (const draw of kept.draws) draws.delete(draw)
    latestDraws.delete(key)
  }

  const drawPart = (key: string, title: string, input: PartDraw, render: () => RenderElement | undefined, drawFailure: (error: unknown) => RenderElement | undefined = () => undefined): DrawnPart => {
    let handlers: Handler[] = []
    let tree: unknown
    try {
      tree = treeOf(render, handlers)
      failedDraws.delete(key)
    } catch (error) {
      if (!failedDraws.has(key)) report({ id: key, message: `The ${title} could not draw`, error })
      failedDraws.add(key)
      handlers = []
      tree = treeOf(() => drawFailure(error), handlers)
    }
    const number = nextDraw()
    const inputs = latestDraws.get(key) ?? new Map<string, SentDrawing>()
    latestDraws.set(key, inputs)
    const drawnFor = JSON.stringify('turn' in input ? { ...input, turn: input.turn.prompt.id } : input)
    const earlier = inputs.get(drawnFor)?.draws ?? []
    const kept = [...earlier, number].slice(-2)
    for (const draw of earlier) if (!kept.includes(draw)) draws.delete(draw)
    inputs.delete(drawnFor)
    inputs.set(drawnFor, { draws: kept, tree: JSON.stringify(tree), render })
    const [oldest] = inputs
    if (inputs.size > keptDrawInputs && oldest !== undefined) {
      for (const draw of oldest[1].draws) draws.delete(draw)
      inputs.delete(oldest[0])
    }
    draws.set(number, { id: key, handlers })
    return { draw: number, tree }
  }

  const draw = (input: PartDraw): DrawnPart | null => {
    if ('markdown' in input) return drawPart('markdown', 'markdown style', input, () => markdownDrawing(input.markdown, { surface: input.surface, columns: input.columns }))
    if ('page' in input) {
      const { page, ...props } = input
      const added = parts.get(page)
      if (added === undefined) throw new Error(`${name} has no view or page ${page}.`)
      const title = `${added.init.title} ${added.kind}`
      return drawPart(`${added.kind}:${page}`, title, input, () => added.init.render(mod(), props), (error) => Text({ color: 'error', children: `The ${title} could not draw: ${messageOf(error)}` }))
    }
    const { widget: id, turn, ...given } = input
    const widget = widgets.get(id)
    if (widget === undefined || !widget.areas.includes(given.area)) return null
    widgetAreas.set(id, given.area)
    const context = (given.area === TurnEnd && turn !== undefined ? { ...given, turn } : given) as WidgetContext
    return drawPart(`widget:${id}`, `${widget.title} widget`, input, () => widget.render(mod(), context))
  }

  const press = async ({ draw: drawn, handler, args }: PartPress, caller: string): Promise<PartsUpdate | null> => {
    const known = draws.get(drawn)
    const run = known?.handlers[handler]
    if (known === undefined || run === undefined) throw new Error(`${name}: ${stalePress}`)
    if (caller !== cmodPluginName && known.id !== 'markdown') throw new Error(`${name}: ${caller} pressed a button only the cmod plugin draws.`)
    const pressed = async () => {
      try {
        await run(...args)
      } catch (error) {
        report({ id: known.id, message: 'Its button failed', error, isCritical: true })
      }
    }
    if (caller === cmodPluginName) return collect(pressed)
    await pressed()
    return null
  }

  return {
    panes: { add: addPane },
    views: { add: (init) => addPart('view', init, 'sidebar') },
    pages: { add: (init) => addPart('page', init) },
    settings: {
      add: (init) => addPart('view', init, 'settings'),
      open: async () => {
        await send({ requests: [{ settings: true }] })
      },
    },
    widgets: { add: addWidget },
    styles: { add: addStyle },
    asked,
    async answerInput(run, passInput) {
      const before = unheldRequests
      const answer = await asked(run)
      if (unheldRequests > before) await passInput()
      return answer
    },
    answer(method, input, caller) {
      const isMarkdown = method === partMethods.draw && isObject(input) && typeof input['markdown'] === 'string'
      if (caller !== cmodPluginName && !isMarkdown && method !== partMethods.press) return undefined
      if (method === partMethods.list) return Promise.resolve({ value: partList() })
      if (method === partMethods.draw) return Promise.resolve().then(() => ({ value: draw(input as PartDraw) }))
      if (method === partMethods.press) return press(input as PartPress, caller).then((value) => ({ value }))
      if (method === partMethods.shown) {
        shownParts = input as ShownParts
        return Promise.resolve({ value: null })
      }
      if (method === partMethods.stylers) {
        hear(input, true)
        return Promise.resolve({ value: null })
      }
      return undefined
    },
    markdownIn,
    restyled: (stylers) => hear(stylers, true),
    relisted() {
    void send({ parts: partList() })
  },
  started() {
      const held = merged(beforeStart ?? [])
      beforeStart = undefined
      void send({ ...held, parts: partList(), isStart: true })
    },
    changed() {
      if (widgets.size > 0 || parts.size > 0) void send({ redraw: true })
      if (openPanes.size === 0 && styles.size === 0) return
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
