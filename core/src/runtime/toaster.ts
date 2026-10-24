import type { ElementTable, RenderElement, RenderPropsOf, Timer } from 'claude-code'
import type { Toast, ToastId, ToastOptions, ToastType } from '../mod.js'
import { Box, Button, drawWith, Link, Text } from '../ui/elements.js'
import { coreVersion, grantFix, installFix, isObject, secretFix } from '../records.js'
import { firstLine, messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'

export type ShownToast = { readonly type: ToastType; readonly message: string; readonly description?: string }

export type Failure = { readonly id: string; readonly message: string; readonly error?: unknown; readonly description?: string; readonly retry?: () => unknown }

export type Toaster = {
  readonly toast: Toast
  copy(text: string): Promise<void>
  fail(failure: Failure): ToastId
  readonly shown: readonly ShownToast[]
  draw(drawn: RenderElement, table: ElementTable, band: RenderPropsOf['AbovePrompt'], bandId: string): RenderElement
}

type Action = { readonly label: string; readonly onClick: () => unknown }

type Contact = { readonly kind: 'github'; readonly repository: string } | { readonly kind: 'email'; readonly address: string }

type Reporting = { readonly contact: Contact | undefined; readonly details: string; readonly status?: string }

type Entry = {
  readonly id: ToastId
  readonly type: ToastType
  readonly message: string
  readonly options: ToastOptions
  readonly actions: readonly Action[]
  readonly hides?: string
  at: Date
  isOpen: boolean
  reporting?: Reporting | undefined
  trying?: string | RenderElement | undefined
  spinsFrom?: number | undefined
  timer: Timer | undefined
}

const githubRepository = /^https:\/\/github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?(?:\/issues)?\/?$/

const linkLimit = 2048

const hiddenKey = 'cmod:hidden-failures'

const defaultDuration = 4000
const visibleToasts = 3
const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const spinnerMs = 100
const spinFrames = 10_000 / spinnerMs
const still = '…'
const icons: Record<Exclude<ToastType, 'loading'>, { readonly glyph: string; readonly color?: string }> = {
  default: { glyph: ' ' },
  success: { glyph: '✓', color: 'success' },
  info: { glyph: 'ℹ', color: 'suggestion' },
  warning: { glyph: '⚠', color: 'warning' },
  error: { glyph: '✗', color: 'error' },
}

export function createToaster(claude: Claude, name: string, version: () => string | undefined, openPermissions: () => unknown): Toaster {
  const entries = new Map<ToastId, Entry>()
  const hidden = new Map<string, string>()
  void claude.store.get(hiddenKey).then(
    (saved) => {
      if (typeof saved !== 'object' || saved === null) return
      for (const [id, hides] of Object.entries(saved)) if (typeof hides === 'string' && !hidden.has(id)) hidden.set(id, hides)
    },
    (error: unknown) => claude.ui.log(`${name}: could not read the failures you hid: ${messageOf(error)}`, { to: 'debug' }),
  )
  let lastId = 0
  let frame = 0
  let spinning: Timer | undefined
  let isHeld = false
  let showsAll = false
  let bandId: string | undefined

  const isLoading = (entry: Entry) => entry.type === 'loading' || entry.trying !== undefined

  const isSpinning = (entry: Entry) => entry.spinsFrom !== undefined && frame - entry.spinsFrom < spinFrames

  const changed = () => {
    for (const entry of entries.values()) entry.spinsFrom = isLoading(entry) ? (entry.spinsFrom ?? frame) : undefined
    const spins = [...entries.values()].some(isSpinning)
    if (spins && spinning === undefined) {
      spinning = claude.clock.every(spinnerMs, () => {
        frame += 1
        changed()
      })
    }
    if (!spins && spinning !== undefined) {
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

  const put = (type: ToastType, message: string, options: ToastOptions, actions: readonly Action[], hides?: string): ToastId => {
    const id = options.id ?? (lastId += 1)
    const previous = entries.get(id)
    if (previous?.trying !== undefined && type === 'loading') {
      previous.trying = options.description ?? message
      changed()
      return id
    }
    if (previous !== undefined) disarm(previous)
    const reporting = hides !== undefined && previous?.hides === hides ? previous.reporting : undefined
    const entry: Entry = { id, type, message, options, actions, ...(hides === undefined ? {} : { hides }), at: new Date(), isOpen: previous?.isOpen ?? false, reporting, timer: undefined }
    if (type === 'error' && previous?.message !== message) claude.ui.log(`${name}: ${message}${typeof options.description === 'string' ? `: ${options.description}` : ''}`, { to: 'debug' })
    entries.set(id, entry)
    changed()
    return id
  }

  const show =
    (type: ToastType) =>
    (message: string, options: ToastOptions = {}): ToastId =>
      put(type, message, options, options.action === undefined ? [] : [options.action])

  const hide = (entry: Entry) => {
    dismiss(entry.id)
    if (entry.hides === undefined) return
    hidden.set(String(entry.id), entry.hides)
    void claude.store.set(hiddenKey, Object.fromEntries(hidden)).catch((error: unknown) => claude.ui.log(`${name}: could not remember the failure you hid: ${messageOf(error)}`, { to: 'debug' }))
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
      .catch((error: unknown) => fail({ id: `press:${entry.id}`, message: `${entry.message}: the press failed`, error }))

  const fail = ({ id, message, error, description = error === undefined || describe(error) === message ? undefined : describe(error), retry }: Failure): ToastId => {
    const hides = `${version() ?? ''}\n${message}\n${error === undefined ? '' : describe(error)}`
    if (hidden.get(id) === hides) return id
    hidden.delete(id)
    const shown = entries.get(id)
    if (shown?.hides === hides && shown.trying === undefined && shown.options.description === description) {
      const previous = clockTime(shown.at)
      shown.at = new Date()
      if (clockTime(shown.at) !== previous) changed()
      return id
    }
    const stack = error instanceof Error && error.stack !== undefined ? `\n\n${error.stack}` : ''
    const details = async () => {
      const modVersion = await claude.fs
        .read(`${claude.plugin.root}/.claude-plugin/plugin.json`)
        .then((text) => String((JSON.parse(text) as { version?: unknown }).version))
        .catch((failure: unknown) => `unknown (${messageOf(failure)})`)
      return `${name} ${modVersion}, @cmodjs/core ${coreVersion}, at ${(entries.get(id)?.at ?? new Date()).toISOString()}\n${message}${description === undefined ? '' : `\n${description}`}${stack}`
    }
    const startReporting = async () => {
      const shown = entries.get(id)
      if (shown === undefined) return
      shown.reporting = { contact: await contactOf(claude), details: await details() }
      disarm(shown)
      changed()
      if (bandId === undefined) return
      const focused = await claude.ui.focus({ requestId: bandId, key: `toast:${id}:ask-claude` })
      if ('deny' in focused) claude.ui.log(`${name}: the Report choices did not take the keys: ${String(focused.deny)}`, { to: 'debug' })
    }
    const tryAgain = async () => {
      const shown = entries.get(id)
      if (shown === undefined || retry === undefined || shown.trying !== undefined) return
      shown.trying = 'Starting'
      changed()
      try {
        await retry()
      } finally {
        if (entries.get(id) === shown) {
          shown.trying = undefined
          changed()
        }
      }
    }
    const text = `${message}\n${description ?? ''}`
    const fixes = [
      { sentence: grantFix, label: 'Settings', onClick: openPermissions },
      { sentence: installFix, label: 'Plugins', onClick: () => claude.command.run({ command: 'plugin' }) },
      { sentence: secretFix, label: 'Open /config', onClick: () => claude.command.run({ command: 'config' }) },
    ].filter(({ sentence }) => text.includes(sentence))
    const actions = [...fixes, ...(retry === undefined ? [] : [{ label: 'Retry', onClick: tryAgain }]), { label: 'Report', onClick: startReporting }]
    return put('error', message, { id, ...(description === undefined ? {} : { description }), duration: Infinity }, actions, hides)
  }

  const toggle = (entry: Entry) => () => {
    entry.isOpen = !entry.isOpen
    disarm(entry)
    changed()
  }

  const row = (entry: Entry): RenderElement => {
    const { description } = entry.options
    const isText = typeof description === 'string'
    const icon = entry.type === 'loading' || entry.trying !== undefined ? { glyph: isSpinning(entry) ? (spinner[frame % spinner.length] as string) : still, color: 'claude' } : icons[entry.type]
    const message = isText ? Button({ plain: true, key: `toast:${entry.id}:open`, label: entry.message, onPress: toggle(entry) }) : Text({ children: entry.message })
    const details = !isText ? description : Text({ dimColor: true, wrap: entry.isOpen ? 'wrap' : 'truncate-end', children: entry.isOpen ? description : firstLine(description) })
    const fixed = (child: RenderElement) => Box({ flexShrink: 0, children: child })
    const close = Button({ plain: true, dimColor: true, key: `toast:${entry.id}:close`, label: entry.hides === undefined ? '✕' : 'Hide', onPress: () => hide(entry) })
    const actions = entry.actions.map((action, index) => Button({ plain: true, key: `toast:${entry.id}:${index === 0 ? 'action' : `action-${index}`}`, label: action.label, onPress: press(entry, action.onClick) }))
    const buttons = Box({ gap: 2, flexWrap: 'wrap', children: [...actions, close, Text({ dimColor: true, children: clockTime(entry.at) })].map(fixed) })
    const trying = entry.trying === undefined ? undefined : Box({ gap: 1, children: [Text({ dimColor: true, children: 'Trying again:' }), typeof entry.trying === 'string' ? Text({ dimColor: true, wrap: 'truncate-end', children: entry.trying }) : entry.trying] })
    const text = details === undefined ? [message] : [message, trying ?? details]
    const under = trying !== undefined && details === undefined ? [trying] : entry.reporting === undefined ? [buttons] : reportChoices(entry, entry.reporting)
    return Box({
      gap: 2,
      children: [
        fixed(Text({ ...(icon.color === undefined ? {} : { color: icon.color }), children: icon.glyph })),
        fixed(Text({ dimColor: true, children: name })),
        Box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, children: entry.hides === undefined ? text : [...text, ...under] }),
        ...(entry.hides === undefined ? [...actions.map(fixed), fixed(close)] : []),
      ],
    })
  }

  const reportChoices = (entry: Entry, { contact, details, status }: Reporting): RenderElement[] => {
    const say = (said: string) => {
      entry.reporting = { contact, details, status: said }
      changed()
    }
    const back = () => {
      entry.reporting = undefined
      changed()
    }
    const askClaude = async () => {
      await claude.prompt.submit({ text: reportPrompt(name, contact, details), asUser: true })
      back()
    }
    const copyError = async () => {
      const copied = await claude.ui.copy({ text: details })
      say(copied.isCopied ? 'Copied the error.' : `Could not copy it: ${copied.reason}`)
    }
    const report = contact === undefined ? [] : [Link({ href: reportLink(contact, name, entry.message, details), label: contact.kind === 'github' ? 'Report it on GitHub (opens your browser)' : 'Email the author (opens your mail app)' })]
    return [
      Text({ dimColor: true, children: 'Claude writes up the problem and files it with your tools. You approve each step before anything is posted.' }),
      Box({
        gap: 2,
        flexWrap: 'wrap',
        children: [
          Button({ plain: true, key: `toast:${entry.id}:ask-claude`, label: 'Ask Claude to report it', onPress: press(entry, askClaude) }),
          ...report,
          Button({ plain: true, key: `toast:${entry.id}:copy`, label: 'Copy the error', onPress: press(entry, copyError) }),
          Button({ plain: true, dimColor: true, key: `toast:${entry.id}:back`, label: 'Back', onPress: back }),
        ],
      }),
      ...(status === undefined ? [] : [Text({ dimColor: true, children: status })]),
    ]
  }

  return {
    toast,
    copy,
    fail,
    get shown() {
      return [...entries.values()].map(({ type, message, options }) => ({ type, message, ...(typeof options.description === 'string' ? { description: options.description } : {}) }))
    },
    draw(drawn, table, band, drawnIn) {
      bandId = drawnIn
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

function describe(error: unknown): string {
  const messages: string[] = []
  for (let cause = error; cause !== undefined; cause = cause instanceof Error ? cause.cause : undefined) {
    const text = messageOf(cause)
    if (!messages.some((earlier) => earlier.includes(text) || text.includes(earlier))) messages.push(text)
  }
  return messages.join('\n')
}

async function contactOf(claude: Claude): Promise<Contact | undefined> {
  const manifest: Record<string, unknown> = await claude.fs
    .read(`${claude.plugin.root}/.claude-plugin/plugin.json`)
    .then((text) => JSON.parse(text) as Record<string, unknown>)
    .catch((error: unknown) => {
      claude.ui.log(`${claude.plugin.name}: could not read whom to report to: ${messageOf(error)}`, { to: 'debug' })
      return {}
    })
  const repositoryUrl = isObject(manifest['repository']) ? manifest['repository']['url'] : manifest['repository']
  const repository = [manifest['supportUrl'], repositoryUrl].map((url) => (typeof url === 'string' ? githubRepository.exec(url)?.[1] : undefined)).find((found) => found !== undefined)
  if (repository !== undefined) return { kind: 'github', repository }
  const author = manifest['author']
  const address = isObject(author) ? author['email'] : undefined
  return typeof address === 'string' && address !== '' ? { kind: 'email', address } : undefined
}

function reportLink(contact: Contact, name: string, message: string, details: string): string {
  const title = `${name}: ${message}`.slice(0, 120)
  const linkOf = (body: string) =>
    contact.kind === 'github'
      ? `https://github.com/${contact.repository}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
      : `mailto:${contact.address}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
  let body = details
  while (linkOf(body).length > linkLimit && body.length > 0) body = `${body.slice(0, Math.floor(body.length * 0.8))}…`
  return linkOf(body)
}

function reportPrompt(name: string, contact: Contact | undefined, details: string): string {
  const where =
    contact === undefined
      ? `${name} names no place to report it, so find its author from its plugin.json or its marketplace.`
      : contact.kind === 'github'
        ? `Report it as an issue on https://github.com/${contact.repository}.`
        : `Email it to ${contact.address}.`
  return `The ${name} mod failed. Report it to its author. ${where} First check whether it is reported already, and add to that report instead of filing a new one. Show me the report before you post it.\n\n${details}`
}

function clockTime(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
