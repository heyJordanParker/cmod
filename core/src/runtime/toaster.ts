import type { ElementTable, RenderElement, RenderPropsOf, Timer } from 'claude-code'
import type { Mod, Toast, ToastId, ToastOptions, ToastType } from '../mod.js'
import { Box, Button, drawWith, Text } from '../ui/elements.js'
import { coreVersion } from '../records.js'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'

export type ShownToast = { readonly type: ToastType; readonly message: string; readonly description?: string }

export type Failure = { readonly id: string; readonly message: string; readonly error?: unknown; readonly description?: string }

export type Toaster = {
  readonly toast: Toast
  copy(text: string): Promise<void>
  readonly shown: readonly ShownToast[]
  draw(drawn: RenderElement, table: ElementTable, band: RenderPropsOf['AbovePrompt']): RenderElement
}

type Entry = {
  readonly id: ToastId
  readonly type: ToastType
  readonly message: string
  readonly options: ToastOptions
  isOpen: boolean
  timer: Timer | undefined
}

const defaultDuration = 4000
const visibleToasts = 3
const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const spinnerMs = 100
const icons: Record<Exclude<ToastType, 'loading'>, { readonly glyph: string; readonly color?: string }> = {
  default: { glyph: ' ' },
  success: { glyph: '✓', color: 'success' },
  info: { glyph: 'ℹ', color: 'suggestion' },
  warning: { glyph: '⚠', color: 'warning' },
  error: { glyph: '✗', color: 'error' },
}

export function createToaster(claude: Claude, name: string): Toaster {
  const entries = new Map<ToastId, Entry>()
  let lastId = 0
  let frame = 0
  let spinning: Timer | undefined
  let isHeld = false
  let showsAll = false

  const changed = () => {
    const isLoading = [...entries.values()].some((entry) => entry.type === 'loading')
    if (isLoading && spinning === undefined) {
      spinning = claude.clock.every(spinnerMs, () => {
        frame += 1
        claude.ui.invalidate('ui.render')
      })
    }
    if (!isLoading && spinning !== undefined) {
      spinning.cancel()
      spinning = undefined
    }
    if (entries.size <= visibleToasts) showsAll = false
    claude.ui.invalidate('ui.render')
  }

  const disarm = (entry: Entry) => {
    entry.timer?.cancel()
    entry.timer = undefined
  }

  const arm = (entry: Entry) => {
    const duration = entry.options.duration ?? defaultDuration
    if (entry.timer !== undefined || entry.type === 'loading' || entry.isOpen || !Number.isFinite(duration)) return
    entry.timer = claude.clock.after(duration, () => {
      entry.timer = undefined
      if (isHeld) arm(entry)
      else dismiss(entry.id)
    })
  }

  const dismiss = (id?: ToastId) => {
    for (const entry of entries.values()) {
      if (id !== undefined && entry.id !== id) continue
      disarm(entry)
      entries.delete(entry.id)
    }
    changed()
  }

  const show =
    (type: ToastType) =>
    (message: string, options: ToastOptions = {}): ToastId => {
      const id = options.id ?? (lastId += 1)
      const previous = entries.get(id)
      if (previous !== undefined) disarm(previous)
      const entry: Entry = { id, type, message, options, isOpen: previous?.isOpen ?? false, timer: undefined }
      if (type === 'error' && previous?.message !== message) claude.ui.log(`${name}: ${message}${typeof options.description === 'string' ? `: ${options.description}` : ''}`, { to: 'debug' })
      entries.set(id, entry)
      changed()
      return id
    }

  const toast: Toast = Object.assign(show('default'), {
    success: show('success'),
    info: show('info'),
    warning: show('warning'),
    error: show('error'),
    loading: show('loading'),
    dismiss,
    promise<T>(task: Promise<T> | (() => Promise<T>), messages: Parameters<Toast['promise']>[1]) {
      const id = show('loading')(messages.loading)
      const settled = Promise.resolve()
        .then(() => (typeof task === 'function' ? task() : task))
        .then(
          (value) => {
            show('success')(typeof messages.success === 'function' ? messages.success(value) : messages.success, { id })
            return value
          },
          (error: unknown) => {
            show('error')(typeof messages.error === 'function' ? messages.error(error) : messages.error, { id })
            throw error
          },
        )
      settled.catch(() => undefined)
      return { unwrap: () => settled }
    },
  })

  const copy = async (text: string) => {
    const copied = await claude.ui.copy({ text })
    if (!copied.isCopied) throw new Error(copied.reason)
  }

  const press = (entry: Entry, run: () => unknown) => () =>
    void Promise.resolve()
      .then(run)
      .catch((error: unknown) => showFailure({ name, claude, ui: { toast, copy } }, { id: `press:${entry.id}`, message: `${entry.message}: the press failed`, error }))

  const toggle = (entry: Entry) => () => {
    entry.isOpen = !entry.isOpen
    disarm(entry)
    changed()
  }

  const row = (entry: Entry): RenderElement => {
    const { description, action } = entry.options
    const isText = typeof description === 'string'
    const icon = entry.type === 'loading' ? { glyph: spinner[frame % spinner.length] as string, color: 'claude' } : icons[entry.type]
    const message = isText ? Button({ plain: true, key: `toast:${entry.id}:open`, label: entry.message, onPress: toggle(entry) }) : Text({ children: entry.message })
    const details = !isText ? description : Text({ dimColor: true, wrap: entry.isOpen ? 'wrap' : 'truncate-end', children: entry.isOpen ? description : firstLine(description) })
    const fixed = (child: RenderElement) => Box({ flexShrink: 0, children: child })
    return Box({
      gap: 2,
      children: [
        fixed(Text({ ...(icon.color === undefined ? {} : { color: icon.color }), children: icon.glyph })),
        fixed(Text({ dimColor: true, children: name })),
        Box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, children: details === undefined ? [message] : [message, details] }),
        ...(action === undefined ? [] : [fixed(Button({ plain: true, key: `toast:${entry.id}:action`, label: action.label, onPress: press(entry, action.onClick) }))]),
        fixed(Button({ plain: true, dimColor: true, key: `toast:${entry.id}:close`, label: '✕', onPress: () => dismiss(entry.id) })),
      ],
    })
  }

  return {
    toast,
    copy,
    get shown() {
      return [...entries.values()].map(({ type, message, options }) => ({ type, message, ...(typeof options.description === 'string' ? { description: options.description } : {}) }))
    },
    draw(drawn, table, band) {
      isHeld = band.hasSurvey === true
      if (isHeld || entries.size === 0) return drawn
      const all = [...entries.values()]
      const hidden = showsAll ? 0 : Math.max(all.length - visibleToasts, 0)
      for (const entry of all.slice(hidden)) arm(entry)
      const more = Button({
        plain: true,
        dimColor: true,
        key: 'toasts:more',
        label: `+${hidden} more`,
        onPress: () => {
          showsAll = true
          changed()
        },
      })
      return drawWith(table, () => Box({ flexDirection: 'column', children: [drawn, ...(hidden > 0 ? [more] : []), ...all.slice(hidden).map(row)] }))
    },
  }
}

export type FailureTarget = {
  readonly name: string
  readonly ui: Pick<Mod['ui'], 'toast' | 'copy'>
  readonly claude: { readonly plugin: Claude['plugin']; readonly fs: Pick<Claude['fs'], 'read'> }
}

export function showFailure({ name, ui, claude }: FailureTarget, { id, message, error, description = describe(error) }: Failure): ToastId {
  const stack = error instanceof Error && error.stack !== undefined ? `\n\n${error.stack}` : ''
  const show = (label: string): ToastId => ui.toast.error(message, { id, description, duration: Infinity, action: { label, onClick: copy } })
  const copy = async (): Promise<ToastId> => {
    const modVersion = await claude.fs
      .read(`${claude.plugin.root}/.claude-plugin/plugin.json`)
      .then((text) => String((JSON.parse(text) as { version?: unknown }).version))
      .catch((failure: unknown) => `unknown (${messageOf(failure)})`)
    return ui.copy(`${name} ${modVersion}, @cmodjs/core ${coreVersion}\n${message}\n${description}${stack}`).then(
      () => show('Copied'),
      (failure: unknown) => show(`Copy failed: ${messageOf(failure)}`),
    )
  }
  return show('Copy')
}

function describe(error: unknown): string {
  const messages: string[] = []
  for (let cause = error; cause !== undefined; cause = cause instanceof Error ? cause.cause : undefined) {
    const text = messageOf(cause)
    if (!messages.some((earlier) => earlier.includes(text) || text.includes(earlier))) messages.push(text)
  }
  return messages.join('\n')
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
}
