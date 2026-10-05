import type { ElementTable, MarkdownProps, RenderElement, Timer } from 'claude-code'
import type { Mod } from '../mod.js'
import type { Claude } from '../runtime/claude.js'
import type { Router } from '../runtime/router.js'
import { type Pane, type PaneSize, paneSize } from '../ui/define-pane.js'
import { Box, drawWith, Text } from '../ui/elements.js'
import type { MarkdownKind, MarkdownReader } from '../ui/markdown.js'
import type { Slot, SlotProps } from '../ui/slots.js'
import { messageOf } from '../utils/text.js'

export type ProgressStep = {
  readonly done: number
  readonly total: number
  readonly label?: string
}

export type PaneHandle = {
  open(): Promise<void>
  close(): Promise<void>
  toggle(): Promise<void>
  readonly isOpen: boolean
}

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

const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const spinnerMs = 100
const widestBar = 30
const narrowestBar = 10

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
        Text({ wrap: 'truncate-end', children: [Text({ color: 'error', children: '✗' }), ' ', title, '  ', Text({ color: 'error', children: line.failure.reason })] }),
        Text({ dimColor: true, wrap: 'truncate-end', children: `  ${line.failure.fix}` }),
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

async function drawComponent<Given extends object>(
  table: ElementTable,
  draw: (Default: (props: Given & { readonly children?: unknown }) => RenderElement) => RenderElement,
  drawDefault: (given: Given, index: number) => Promise<RenderElement>,
): Promise<{ readonly drawing: RenderElement } | { readonly failure: string }> {
  const given: Given[] = []
  let first: RenderElement
  try {
    first = drawWith(table, () =>
      draw(({ children, ...props }) => {
        given.push(props as Given)
        return Box({})
      }),
    )
  } catch (error) {
    return { failure: threw(error) }
  }
  if (given.length === 0) return { drawing: first }
  const pieces = await Promise.all(given.map((props, index) => drawDefault(props, index)))
  let used = 0
  let second: RenderElement
  try {
    second = drawWith(table, () => draw(() => pieces[used++] ?? Box({})))
  } catch (error) {
    return { failure: threw(error) }
  }
  if (used !== pieces.length) return { failure: `used Default ${times(pieces.length)}, then ${times(used)}, so Claude Code draws its own. A render must draw the same for the same props.` }
  return { drawing: second }
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
  readonly adds: (feature: string) => void
  readonly mod: () => Mod<State>
}

export type UiArea<State extends object> = {
  readonly ui: Mod<State>['ui']
  changed(): void
  restorePanes(): Promise<void>
}

export function createUi<State extends object>({ name, claude, router, progress, adds, mod }: UiOptions<State>): UiArea<State> {
  const panes = new Map<string, Pane<State>>()
  const openPanes = new Set<string>()
  const requestedSizes = new Map<string, PaneSize>()
  const markdownRenders = new Map<string, MarkdownRender>()
  let read: MarkdownReader | undefined
  let hasRenders = false
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
      return Box({
        flexDirection: 'column',
        children: pieces.map((piece) => {
          if ('text' in piece) return drawClaudes(piece.text)
          const { render, props: block } = piece
          try {
            return drawWith(table, () => render.Component({ ...block, Default: ({ source = block.source }: { readonly source?: string }) => drawClaudes(source) }))
          } catch (error) {
            render.log(threw(error))
            return drawClaudes(block.source)
          }
        }),
      })
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
      const drawings = await Promise.all(
        pieces.map(async (piece, index) => {
          if ('text' in piece) return drawClaudes(piece.text, index === 0)
          const { render, props: block } = piece
          const drawn = await drawComponent<{ readonly source?: string }>(
            table,
            (Default) => render.Component({ ...block, Default }),
            ({ source = block.source }, use) => drawClaudes(source, index === 0 && use === 0),
          )
          if ('drawing' in drawn) return drawn.drawing
          render.log(drawn.failure)
          return drawClaudes(block.source, index === 0)
        }),
      )
      return drawWith(table, () => Box({ flexDirection: 'column', children: drawings }))
    })
  }

  const openAt = (pane: Pane<State>, size: PaneSize) => {
    requestedSizes.set(pane.id, size)
    return claude.ui.open({ id: pane.id, title: pane.title, ...size })
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
      return drawWith(table, () => pane.render(mod(), e.props), markdownIn(table))
    })
    router.add('ui.close', (e, next) => {
      openPanes.delete(e.id)
      return next(e)
    })
  }

  return {
    ui: {
      pane(pane) {
        if (panes.has(pane.id)) throw new Error(`${name}: the pane "${pane.id}" is already added. Give each pane its own id.`)
        panes.set(pane.id, pane)
        adds(`the ${pane.title} pane`)
        route()
        const handle: PaneHandle = {
          get isOpen() {
            return openPanes.has(pane.id)
          },
          async open() {
            const { isPlaced } = await openAt(pane, paneSize(pane, mod().state))
            if (isPlaced) openPanes.add(pane.id)
          },
          async close() {
            await claude.ui.close({ id: pane.id })
            openPanes.delete(pane.id)
          },
          toggle: () => (openPanes.has(pane.id) ? handle.close() : handle.open()),
        }
        return handle
      },
      render<S extends Slot>(slot: S, Component: (props: SlotProps<S>) => RenderElement) {
        hasRenders = true
        const place: Slot = slot
        if ('markdown' in place) {
          const kind = place.markdown
          if (markdownRenders.has(kind.type)) throw new Error(`${name}: a render of markdown ${kind.name} is already added. Render each markdown slot once.`)
          markdownRenders.set(kind.type, { Component: Component as unknown as MarkdownRender['Component'], log: logOnce(`markdown ${kind.name}`) })
          adds(`a render of markdown ${kind.name}`)
          routeMarkdown(kind)
          return
        }
        const { component } = place
        adds(`a render of ${component}`)
        const log = logOnce(component)
        router.add('ui.render', async (e, next) => {
          if (e.component !== component) return next(e)
          const drawn = await drawComponent(
            claude.ui.resolve(e),
            (Default) => Component({ ...e.props, Default } as unknown as SlotProps<S>),
            (given, index) => next({ ...e, props: pieceProps(e.props, given, index === 0) } as typeof e),
          )
          if ('drawing' in drawn) return drawn.drawing
          log(drawn.failure)
          return next(e)
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
    },
    changed() {
      if (panes.size === 0 && !hasRenders) return
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
        if (panes.has(open.id)) openPanes.add(open.id)
      }
    },
  }
}
