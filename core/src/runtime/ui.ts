import type { ElementTable, MarkdownProps, PaneOpenArgs, RenderElement } from 'claude-code'
import type { Disposable, Mod, PaneHandle } from '../mod.js'
import type { Pane } from '../ui/define-pane.js'
import { Box, drawWith, Text } from '../ui/elements.js'
import type { MarkdownReader } from '../ui/markdown.js'
import { componentOf, nameOf, type Place, type PlaceProps } from '../ui/places.js'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import type { Router } from './router.js'
import type { Failure, Toaster } from './toaster.js'

type PaneSize = Pick<PaneOpenArgs, 'columns' | 'rows'>

const bullet = '⏺'
const sizeKeys = ['columns', 'rows'] as const

function paneSize<State extends object>(pane: Pane<State>, state: State): PaneSize {
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

type MarkdownRender = {
  readonly Component: (props: object) => RenderElement
  readonly log: (failure: string) => void
}

export type UiOptions<State extends object> = {
  readonly name: string
  readonly claude: Claude
  readonly router: Router
  readonly toaster: Toaster
  readonly report: (failure: Failure) => void
  readonly announce: (feature: string) => void
  readonly mod: () => Mod<State>
}

export type UiArea<State extends object> = {
  readonly ui: Omit<Mod<State>['ui'], 'notice'>
  changed(): void
  restorePanes(): Promise<void>
}

export function createUi<State extends object>({ name, claude, router, toaster, report, announce, mod }: UiOptions<State>): UiArea<State> {
  const panes = new Map<string, Pane<State>>()
  const paneLogs = new Map<string, (failure: string) => void>()
  const openPanes = new Set<string>()
  const requestedSizes = new Map<string, PaneSize>()
  const renders = new Set<string>()
  const markdownRenders = new Map<string, MarkdownRender>()
  let read: MarkdownReader | undefined
  let isRouted = false
  let isResizeQueued = false

  const logOnce = (what: string) => {
    let hasLogged = false
    return (failure: string) => {
      if (!hasLogged) report({ id: `render:${what}`, message: `The ${what} render failed`, description: failure })
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

  const openAt = (pane: Pane<State>, size: PaneSize, focus?: true) => {
    requestedSizes.set(pane.id, size)
    const { id, title, closeOnEscape, holdToasts } = pane
    return claude.ui.open({ id, title, ...size, ...(closeOnEscape === true ? { closeOnEscape } : {}), ...(holdToasts === true ? { holdToasts } : {}), ...(focus === true ? { focus } : {}) })
  }

  const resize = async (pane: Pane<State>) => {
    try {
      const size = paneSize(pane, mod().state)
      const requested = requestedSizes.get(pane.id)
      if (requested?.columns === size.columns && requested?.rows === size.rows) return
      await openAt(pane, size)
    } catch (error) {
      claude.ui.log(`${name}: the ${pane.title} pane kept its size: ${messageOf(error)}`, { to: 'debug' })
    }
  }

  const route = () => {
    if (isRouted) return
    isRouted = true
    router.add('ui.render', (e, next) => {
      const pane = panes.get(e.requestId)
      if (pane === undefined || e.component !== 'Pane') return next(e)
      openPanes.add(pane.id)
      const table = claude.ui.resolve(e)
      try {
        return drawWith(table, () => pane.render(mod(), e.props), markdownIn(table))
      } catch (error) {
        paneLogs.get(pane.id)?.(`threw: ${messageOf(error)}`)
        return drawWith(table, () => Text({ color: 'error', children: `The ${pane.title} pane could not draw: ${messageOf(error)}` }))
      }
    })
    router.add('ui.scroll', async (e, next) => {
      const pane = panes.get(e.requestId)
      const moved = await next(e)
      if (pane?.onScroll === undefined || e.component !== 'Pane' || moved.deny !== undefined) return moved
      await handle(pane, 'onScroll', () => pane.onScroll?.(mod(), e))
      return moved
    })
    router.add('ui.close', async (e, next) => {
      openPanes.delete(e.id)
      const closed = await next(e)
      const pane = panes.get(e.id)
      if (pane?.onClose !== undefined) await handle(pane, 'onClose', () => pane.onClose?.(mod(), e))
      return closed
    })
  }

  const handle = async (pane: Pane<State>, handler: string, run: () => unknown) => {
    try {
      await run()
    } catch (error) {
      report({ id: `pane:${pane.id}:${handler}`, message: `The ${pane.title} pane's ${handler} threw`, error })
    }
  }

  return {
    ui: {
      pane(pane) {
        if (panes.has(pane.id)) throw new Error(`${name}: the pane "${pane.id}" is already added. Give each pane its own id.`)
        panes.set(pane.id, pane)
        paneLogs.set(pane.id, logOnce(`${pane.title} pane`))
        announce(`the ${pane.title} pane`)
        route()
        const handle: PaneHandle = {
          get isOpen() {
            return openPanes.has(pane.id)
          },
          async open(options) {
            const { isPlaced } = await openAt(pane, paneSize(pane, mod().state), options?.focus)
            if (isPlaced) openPanes.add(pane.id)
          },
          async close() {
            await claude.ui.close({ id: pane.id })
            openPanes.delete(pane.id)
          },
          toggle: (options) => (openPanes.has(pane.id) ? handle.close() : handle.open(options)),
        }
        return handle
      },
      render<P extends Place>(place: P, Component: (props: PlaceProps<P>) => RenderElement): Disposable {
        const target: Place = place
        const markdown = typeof target === 'string' ? undefined : target
        const component = componentOf(place)
        if (markdown === undefined && component === undefined) throw new Error(`${name}: ${String(place)} is not a place render draws, such as ToolCall or CodeBlock.`)
        const feature = `a render of ${nameOf(place)}`
        if (renders.has(feature)) throw new Error(`${name}: ${feature} is already added. Render each place once.`)
        renders.add(feature)
        announce(feature)
        if (markdown !== undefined) {
          const markdownType = markdown.markdown
          markdownRenders.set(markdownType, { Component: Component as unknown as MarkdownRender['Component'], log: logOnce(nameOf(place)) })
          routeMarkdown(markdown.createReader)
          return {
            dispose() {
              markdownRenders.delete(markdownType)
              renders.delete(feature)
              claude.ui.invalidate('ui.render')
            },
          }
        }
        const log = logOnce(nameOf(place))
        const drawing = router.add('ui.render', async (e, next) => {
          if (e.component !== component) return next(e)
          const table = claude.ui.resolve(e)
          const drawn = await drawComponent(
            table,
            (Default) => Component({ ...e.props, Default } as unknown as PlaceProps<P>),
            (given, isClaudesRow) => next({ ...e, props: pieceProps(e.props, given, isClaudesRow) } as typeof e),
          )
          if ('failure' in drawn) {
            log(drawn.failure)
            return next(e)
          }
          if (e.component !== 'AssistantMessage') return drawn.drawing
          return drawWith(table, () => drawPieces([drawn], e.props.isFirstOfReply ? 'opensReply' : 'inReply'))
        })
        return {
          dispose() {
            drawing.dispose()
            renders.delete(feature)
            claude.ui.invalidate('ui.render')
          },
        }
      },
      toast: toaster.toast,
      copy: toaster.copy,
      ask: (question, options) => claude.ui.ask(question, options),
      scroll: (args) => claude.ui.scroll(args),
    },
    changed() {
      if (panes.size === 0 && renders.size === 0) return
      claude.ui.invalidate('ui.render')
      if (isResizeQueued) return
      isResizeQueued = true
      void Promise.resolve().then(() => {
        isResizeQueued = false
        for (const pane of panes.values()) {
          if (openPanes.has(pane.id)) void resize(pane)
        }
      })
    },
    async restorePanes() {
      if (panes.size === 0) return
      for (const open of await claude.ui.panes()) {
        if (open.isPlaced && panes.has(open.id)) openPanes.add(open.id)
      }
    },
  }
}
