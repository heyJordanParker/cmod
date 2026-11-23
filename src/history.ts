import { AttachedFile, InstructionFile, Note, Prompt, Reply, Skill, ToolCall, ToolResult, messageOf, sessions, type Message, type Mod, type Session, type Task, type Turn } from '../node_modules/@cmodjs/core/mod.js'
import { engineOf } from '../node_modules/@cmodjs/core/runtime/engine.js'
import { Badge, Banner, List, ListItem } from '../node_modules/@cmodjs/core/ui/components.js'
import { Box, Button, Input, Text } from '../node_modules/@cmodjs/core/ui/elements.js'

type EntryKind = 'prompt' | 'reply' | 'tool' | 'skill' | 'file' | 'note' | 'task'

export type HistoryEntry = {
  readonly key: string
  readonly message: string | null
  readonly kind: EntryKind
  readonly name: string
  readonly text: string
  readonly at: string
  readonly isError: boolean
  readonly isRunning: boolean
  readonly children: readonly HistoryEntry[]
}

export type HistoryState = {
  readonly session: { historyView: { find: string; opened: readonly string[]; shown: number } }
  readonly memory: { history: readonly HistoryEntry[] | null; historyError: string | null }
}

export const pageRows = 50

export const historySession: HistoryState['session'] = { historyView: { find: '', opened: [], shown: pageRows } }

export const historyMemory: HistoryState['memory'] = { history: null, historyError: null }

export type HistoryView = { readonly title: string; draw(): JSX.Element; refresh(): void }

const reloadQuietMs = 1000

const agentTools: ReadonlySet<string> = new Set(['Agent', 'Task'])

const summaryKeys = ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'query', 'skill', 'prompt'] as const

const firstLine = (text: string) => text.trim().split('\n', 1)[0] ?? ''

function summaryOf(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const fields = input as Record<string, unknown>
  const found = summaryKeys.map((key) => fields[key]).find((value): value is string => typeof value === 'string' && value.trim() !== '')
  return found === undefined ? '' : firstLine(found)
}

function timeOf(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function matchesFind(entry: HistoryEntry, find: string): boolean {
  return `${entry.name} ${entry.text}`.toLowerCase().includes(find)
}

const holdsMatch = (entry: HistoryEntry, find: string): boolean => matchesFind(entry, find) || entry.children.some((child) => holdsMatch(child, find))

type Shown = { readonly entry: HistoryEntry; readonly depth: number; readonly isOpen: boolean }

export function history<State extends HistoryState>(mod: Mod<State>, isShown: () => boolean): HistoryView {
  const { claude, report } = engineOf(mod)
  const messages = new Map<string, Message>()
  const closedTasks = new Map<string, readonly Message[]>()
  let read: { readonly session: string; readonly list: Message[] } | undefined
  let loading: Promise<void> | undefined
  let isStale = false

  const entryOf = (message: Message, results: ReadonlyMap<string, Message>, children: readonly HistoryEntry[]): HistoryEntry | undefined => {
    const base = { key: message.id, message: message.id, at: message.at, isRunning: false, children }
    if (message.type === Reply) return { ...base, kind: 'reply', name: 'Claude', text: firstLine(message.text), isError: false }
    if (message.type === Skill) return { ...base, kind: 'skill', name: 'Skill', text: message.name, isError: false }
    if (message.type === AttachedFile || message.type === InstructionFile) return { ...base, kind: 'file', name: 'File', text: message.path, isError: false }
    if (message.type === Note && message.from.type === 'mod') return { ...base, kind: 'note', name: 'Note', text: `${message.from.name ?? 'a mod'}: ${firstLine(message.text)}`, isError: false }
    if (message.type !== ToolCall) return undefined
    const result = results.get(message.callId)
    return { ...base, kind: 'tool', name: message.name, text: summaryOf(message.input), isError: result?.type === ToolResult && result.isError === true }
  }

  const entriesOf = async (list: readonly Message[], tasks: readonly Task[]): Promise<HistoryEntry[]> => {
    const results = new Map(list.flatMap((message) => (message.type === ToolResult ? [[message.callId, message] as const] : [])))
    const entries: HistoryEntry[] = []
    for (const message of list) {
      messages.set(message.id, message)
      const started = message.type === ToolCall && agentTools.has(message.name) ? tasks.filter((task) => task.openedBy === message.callId) : []
      const entry = entryOf(message, results, await Promise.all(started.map(taskEntryOf)))
      if (entry !== undefined) entries.push(entry)
    }
    return entries
  }

  const taskEntryOf = async (task: Task): Promise<HistoryEntry> => {
    const [own, handedOn] = await Promise.all([messagesOfTask(task), task.tasks()])
    const opened = new Set(own.flatMap((message) => (message.type === ToolCall ? [message.callId] : [])))
    const children = await entriesOf(own.filter((message) => message.type !== Prompt), handedOn)
    const loose = await Promise.all(handedOn.filter((each) => !opened.has(each.openedBy)).map(taskEntryOf))
    return { key: `task:${task.id}`, message: null, kind: 'task', name: task.owner.agentType ?? 'Task', text: task.title, at: task.openedAt, isError: false, isRunning: task.closedAt === undefined, children: [...children, ...loose] }
  }

  const promptEntryOf = async (turn: Turn, own: readonly Message[], tasks: readonly Task[]): Promise<HistoryEntry> => {
    messages.set(turn.prompt.id, turn.prompt)
    const children = await entriesOf(
      own.filter((message) => message.turn === turn.prompt.id && message.id !== turn.prompt.id),
      tasks,
    )
    return { key: turn.prompt.id, message: turn.prompt.id, kind: 'prompt', name: timeOf(turn.openedAt), text: firstLine(turn.prompt.text), at: turn.openedAt, isError: false, isRunning: turn.closedAt === undefined, children }
  }

  const messagesOfTask = async (task: Task): Promise<readonly Message[]> => {
    const kept = closedTasks.get(task.id)
    if (kept !== undefined) return kept
    const list = await task.messages()
    if (task.closedAt !== undefined) closedTasks.set(task.id, list)
    return list
  }

  const messagesOf = async (current: Session): Promise<readonly Message[]> => {
    if (read?.session !== current.id) {
      read = { session: current.id, list: [] }
      closedTasks.clear()
    }
    const known = read
    const last = known.list.at(-1)?.id
    known.list.push(...(await current.messages(last === undefined ? {} : { after: last })))
    return known.list
  }

  const load = async () => {
    const current = sessions.current
    const [turns, all, tasks] = await Promise.all([current.turns(), messagesOf(current), current.goal.tasks()])
    const own = all.filter((message) => message.task === undefined)
    messages.clear()
    const prompts = await Promise.all(turns.map((turn) => promptEntryOf(turn, own, tasks)))
    const opened = new Set(own.flatMap((message) => (message.type === ToolCall ? [message.callId] : [])))
    const loose = await Promise.all(tasks.filter((task) => !opened.has(task.openedBy)).map(taskEntryOf))
    mod.state.memory.history = [...prompts, ...loose]
    mod.state.memory.historyError = null
  }

  const refresh = () => {
    if (loading !== undefined) {
      isStale = true
      return
    }
    loading = load()
      .catch((error: unknown) => void (mod.state.memory.historyError = `The conversation did not load: ${messageOf(error)}`))
      .finally(() => {
        if (!isStale) {
          loading = undefined
          return
        }
        isStale = false
        claude.clock.after(reloadQuietMs, () => {
          loading = undefined
          refresh()
        })
      })
  }

  const whileShown = () => {
    if (isShown()) refresh()
  }
  sessions.current.onMessage(whileShown)
  sessions.current.onTurnEnd(whileShown)
  sessions.current.onTaskStart(whileShown)
  sessions.current.onTaskEnd(whileShown)

  const scrollTo = (id: string | null) => {
    const message = id === null ? undefined : messages.get(id)
    if (message === undefined) return
    void sessions.current.scrollTo(message, { block: 'start' }).catch((error: unknown) => report({ id: 'history:scroll', message: 'Could not scroll the conversation to that message', error }))
  }

  const change = (next: Partial<HistoryState['session']['historyView']>) => void (mod.state.session.historyView = { ...mod.state.session.historyView, ...next })

  const toggle = (key: string) => {
    const { opened } = mod.state.session.historyView
    change({ opened: opened.includes(key) ? opened.filter((each) => each !== key) : [...opened, key] })
  }

  const visible = (entries: readonly HistoryEntry[]): { readonly rows: readonly Shown[]; readonly earlier: number } => {
    const { find, opened, shown: page } = mod.state.session.historyView
    const lowered = find.trim().toLowerCase()
    const isFinding = lowered !== ''
    const newestFirst = entries.toReversed().filter((entry) => !isFinding || holdsMatch(entry, lowered))
    const rows: Shown[] = []
    const walk = (list: readonly HistoryEntry[], depth: number) => {
      for (const entry of list) {
        if (isFinding && depth > 0 && !holdsMatch(entry, lowered)) continue
        const isOpen = entry.children.length > 0 && (isFinding ? entry.children.some((child) => holdsMatch(child, lowered)) : opened.includes(entry.key))
        rows.push({ entry, depth, isOpen })
        if (isOpen) walk(entry.children, depth + 1)
      }
    }
    walk(newestFirst.slice(0, page), 0)
    return { rows, earlier: Math.max(newestFirst.length - page, 0) }
  }

  const row = ({ entry, depth, isOpen }: Shown): JSX.Element =>
    ListItem({
      key: `history:${entry.key}`,
      label: entry.text,
      depth,
      ...(depth === 0 ? { description: timeOf(entry.at) } : { leading: entry.name }),
      ...(entry.isError ? { tone: 'critical' as const } : {}),
      ...(entry.isRunning ? { trailing: Badge({ tone: 'info', children: 'Working' }) } : {}),
      ...(entry.children.length > 0 ? { isOpen, onOpenChange: () => toggle(entry.key) } : {}),
      onPress: () => scrollTo(entry.message ?? entry.children[0]?.message ?? null),
    })

  const draw = (): JSX.Element => {
    const { history: entries, historyError } = mod.state.memory
    const { find, shown } = mod.state.session.historyView
    if (entries === null && historyError === null && loading === undefined) refresh()
    const finder = Input({ key: 'history:find', label: 'Find', value: find, placeholder: 'Find a prompt', submitLabel: 'find', onInput: (text: string) => change({ find: text }), onSubmit: (text: string) => change({ find: text }) })
    const body = (): JSX.Element => {
      if (historyError !== null) return Banner({ tone: 'critical', children: historyError })
      if (entries === null) return Text({ dimColor: true, children: 'Reading the conversation…' })
      if (entries.length === 0) return Text({ dimColor: true, wrap: 'wrap', children: 'Each prompt you send shows here, with what Claude did for it.' })
      const { rows, earlier } = visible(entries)
      if (rows.length === 0) return Text({ dimColor: true, children: 'No prompt matches.' })
      const more = earlier === 0 ? [] : [Button({ plain: true, dimColor: true, key: 'history:earlier', label: `Show ${Math.min(earlier, pageRows)} earlier`, onPress: () => change({ shown: shown + pageRows }) })]
      return Box({ flexDirection: 'column', children: [List({ label: 'History', children: rows.map(row) }), ...more] })
    }
    return Box({ flexDirection: 'column', gap: 1, children: [finder, body()] })
  }

  return { title: 'History', draw, refresh }
}
