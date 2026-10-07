import type { ElementTable, MarkdownProps, PaneOpenArgs, RenderElement, Timer } from 'claude-code'
import type { Mod, PaneHandle, ProgressStep } from '../mod.js'
import type { Pane } from '../ui/define-pane.js'
import { Box, drawWith, Text } from '../ui/elements.js'
import type { MarkdownKind, MarkdownReader } from '../ui/markdown.js'
import type { Slot, SlotProps } from '../ui/slots.js'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import type { Router } from './router.js'

export type ProgressLine = {
  report(step: ProgressStep): void
  wait(text: string): void
  fail(reason: string, fix: string): void
  end(): void
}

export type Progress = {
  readonly isShown: boolean
  start(title: string): ProgressLine
  draw(drawn: RenderElement, table: ElementTable, columns: number | undefined): RenderElement
}

type Line = {
  readonly title: string
  step: ProgressStep | undefined
  waiting: string | undefined
  failure: { readonly reason: string; readonly fix: string } | undefined
}

type PaneSize = Pick<PaneOpenArgs, 'columns' | 'rows'>

const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const spinnerMs = 100
const bullet = '⏺'
const widestBar = 30
const narrowestBar = 10
const sizeKeys = ['columns', 'rows'] as const

export function createProgress(claude: Claude): Progress {
  const lines: Line[] = []
  let frame = 0
  let timer: Timer | undefined

  const changed = () => {
    const isSpinning = lines.some((line) => line.failure === undefined && line.waiting === undefined)
    if (isSpinning && timer === undefined) {
      timer = claude.clock.every(spinnerMs, () => {
        frame += 1
        claude.ui.invalidate('ui.render')
      })
    }
    if (!isSpinning && timer !== undefined) {
      timer.cancel()
      timer = undefined
    }
    claude.ui.invalidate('ui.render')
  }

  return {
    get isShown() {
      return lines.length > 0
    },
    start(title) {
      const line: Line = { title, step: undefined, waiting: undefined, failure: undefined }
      lines.push(line)
      changed()
      return {
        report(step) {
          line.step = step
          line.waiting = undefined
          changed()
        },
        wait(text) {
          line.waiting = text
          changed()
        },
        fail(reason, fix) {
          line.failure = { reason, fix }
          changed()
        },
        end() {
          const index = lines.indexOf(line)
          if (index >= 0) lines.splice(index, 1)
          changed()
        },
      }
    },
    draw(drawn, table, columns) {
      return drawWith(table, () => Box({ flexDirection: 'column', children: [drawn, ...lines.map((line) => drawLine(line, frame, columns))] }))
    },
  }
}

function drawLine(line: Line, frame: number, columns: number | undefined): RenderElement {
  const title = Text({ bold: true, children: line.title })
  if (line.failure !== undefined) {
    return Box({
      flexDirection: 'column',
      children: [
        Box({ children: [Box({ minWidth: 2, children: Text({ color: 'error', children: '✗' }) }), Text({ children: [title, '  ', Text({ color: 'error', children: line.failure.reason })] })] }),
        Box({ paddingLeft: 2, children: Text({ dimColor: true, children: line.failure.fix }) }),
      ],
    })
  }
  if (line.waiting !== undefined) {
    return Text({ wrap: 'truncate-end', children: [Text({ color: 'warning', children: '◌' }), ' ', title, '  ', Text({ dimColor: true, children: line.waiting })] })
  }
  const glyph = Text({ color: 'claude', children: spinner[frame % spinner.length] })
  if (line.step === undefined) return Text({ wrap: 'truncate-end', children: [glyph, ' ', title, Text({ dimColor: true, children: '…' })] })
  const { done, total, label = '' } = line.step
  const count = `${done}/${total}`
  const width = barWidth(columns, `${line.title}${count}${label}`.length)
  const filled = total > 0 ? Math.round(Math.min(done / total, 1) * width) : 0
  return Text({
    wrap: 'truncate-end',
    children: [
      glyph,
      ' ',
      title,
      '  ',
      Text({ color: 'claude', children: '█'.repeat(filled) }),
      Text({ color: 'subtle', children: '░'.repeat(width - filled) }),
      '  ',
      Text({ dimColor: true, children: count }),
      ...(label === '' ? [] : ['  ', label]),
    ],
  })
}

function barWidth(columns: number | undefined, textLength: number): number {
  if (columns === undefined) return widestBar
  const spacing = 2 + 2 + 2 + 2
  return Math.max(narrowestBar, Math.min(widestBar, columns - textLength - spacing))
}

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
  readonly progress: Progress
  readonly announce: (feature: string) => void
  readonly mod: () => Mod<State>
}

export type UiArea<State extends object> = {
  readonly ui: Mod<State>['ui']
  changed(): void
  restorePanes(): Promise<void>
}

export function createUi<State extends object>({ name, claude, router, progress, announce, mod }: UiOptions<State>): UiArea<State> {
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
      if (!hasLogged) claude.ui.log(`${name}: the ${what} render ${failure}`)
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

  const routeMarkdown = (kind: MarkdownKind) => {
    if (read !== undefined) return
    const reader = kind.createReader()
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
      claude.ui.log(`${name}: the ${pane.title} pane's ${handler} threw: ${messageOf(error)}`)
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
      render<S extends Slot>(slot: S, Component: (props: SlotProps<S>) => RenderElement) {
        const place: Slot = slot
        const feature = 'markdown' in place ? `a render of markdown ${place.markdown.name}` : `a render of ${place.component}`
        if (renders.has(feature)) throw new Error(`${name}: ${feature} is already added. Render each slot once.`)
        renders.add(feature)
        announce(feature)
        if ('markdown' in place) {
          const kind = place.markdown
          markdownRenders.set(kind.type, { Component: Component as unknown as MarkdownRender['Component'], log: logOnce(`markdown ${kind.name}`) })
          routeMarkdown(kind)
          return
        }
        const { component } = place
        const log = logOnce(component)
        router.add('ui.render', async (e, next) => {
          if (e.component !== component) return next(e)
          const table = claude.ui.resolve(e)
          const drawn = await drawComponent(
            table,
            (Default) => Component({ ...e.props, Default } as unknown as SlotProps<S>),
            (given, isClaudesRow) => next({ ...e, props: pieceProps(e.props, given, isClaudesRow) } as typeof e),
          )
          if ('failure' in drawn) {
            log(drawn.failure)
            return next(e)
          }
          if (e.component !== 'AssistantMessage') return drawn.drawing
          return drawWith(table, () => drawPieces([drawn], e.props.isFirstOfReply ? 'opensReply' : 'inReply'))
        })
      },
      toast: (text) => claude.ui.toast(text),
      async progress(title, task) {
        const line = progress.start(title)
        try {
          return await task((step) => line.report(step))
        } finally {
          line.end()
        }
      },
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
