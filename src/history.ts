import { AttachedFile, InstructionFile, Note, Prompt, Reply, Skill, ToolCall, ToolResult, messageOf, sessions, type Message, type Mod, type Session, type Task, type Turn } from '../node_modules/@cmodjs/core/mod.js'
import { engineOf } from '../node_modules/@cmodjs/core/runtime/engine.js'
import { Box, Button, Input, Select, Text } from '../node_modules/@cmodjs/core/ui/elements.js'

export type HistoryFilter = 'all' | 'prompts' | 'tools' | 'errors'

export type HistoryLayout = 'tasks' | 'timeline'

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
  readonly session: { history: { find: string; filter: HistoryFilter; layout: HistoryLayout; toggled: readonly string[] } }
  readonly memory: { history: readonly HistoryEntry[] | null; historyError: string | null }
}

export const historySession: HistoryState['session'] = { history: { find: '', filter: 'all', layout: 'tasks', toggled: [] } }

export const historyMemory: HistoryState['memory'] = { history: null, historyError: null }

export type HistoryView = { readonly title: string; draw(columns: number): JSX.Element; refresh(): void }

const filters: readonly HistoryFilter[] = ['all', 'prompts', 'tools', 'errors']

const filterLabels: Readonly<Record<HistoryFilter, string>> = { all: 'All', prompts: 'Prompts', tools: 'Tools', errors: 'Errors' }

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

function counted(entry: HistoryEntry): { readonly tools: number; readonly failures: number } {
  let tools = 0
  let failures = 0
  const visit = (each: HistoryEntry) => {
    if (each.kind === 'tool') tools += 1
    if (each.kind === 'tool' && each.isError) failures += 1
    each.children.forEach(visit)
  }
  entry.children.forEach(visit)
  return { tools, failures }
}

function matchesFilter(entry: HistoryEntry, filter: HistoryFilter): boolean {
  if (filter === 'prompts') return entry.kind === 'prompt'
  if (filter === 'tools') return entry.kind === 'tool'
  if (filter === 'errors') return entry.isError
  return true
}

function matchesFind(entry: HistoryEntry, find: string): boolean {
  return find === '' || `${entry.name} ${entry.text}`.toLowerCase().includes(find)
}

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

  const toggle = (key: string) => {
    const { toggled } = mod.state.session.history
    mod.state.session.history = { ...mod.state.session.history, toggled: toggled.includes(key) ? toggled.filter((each) => each !== key) : [...toggled, key] }
  }

  const visible = (entries: readonly HistoryEntry[]): Shown[] => {
    const { find, filter, toggled } = mod.state.session.history
    const lowered = find.trim().toLowerCase()
    const isNarrowed = lowered !== '' || filter === 'tools' || filter === 'errors'
    const newest = entries.findLast((entry) => entry.kind === 'prompt')?.key
    const isLive = (entry: HistoryEntry): boolean => entry.isRunning || entry.children.some(isLive)
    const holdsMatch = (entry: HistoryEntry): boolean => (matchesFilter(entry, filter) && matchesFind(entry, lowered)) || entry.children.some(holdsMatch)
    const shown: Shown[] = []
    const walk = (list: readonly HistoryEntry[], depth: number) => {
      for (const entry of list) {
        if (filter === 'prompts') {
          if (entry.kind === 'prompt' && matchesFind(entry, lowered)) shown.push({ entry, depth, isOpen: false })
          continue
        }
        if (isNarrowed && !holdsMatch(entry)) continue
        const isOpenByDefault = entry.key === newest || isLive(entry)
        const isOpen = entry.children.length > 0 && (isNarrowed || isOpenByDefault !== toggled.includes(entry.key))
        shown.push({ entry, depth, isOpen })
        if (isOpen) walk(entry.children, depth + 1)
      }
    }
    walk(entries, 0)
    return shown
  }

  const timeline = (entries: readonly HistoryEntry[]): Shown[] => {
    const { find, filter } = mod.state.session.history
    const lowered = find.trim().toLowerCase()
    const all: HistoryEntry[] = []
    const walk = (list: readonly HistoryEntry[]) => {
      for (const entry of list) {
        all.push(entry)
        walk(entry.children)
      }
    }
    walk(entries)
    return all
      .filter((entry) => matchesFilter(entry, filter) && matchesFind(entry, lowered))
      .toSorted((one, other) => one.at.localeCompare(other.at))
      .map((entry) => ({ entry, depth: 0, isOpen: false }))
  }

  const row = ({ entry, depth, isOpen }: Shown, columns: number): JSX.Element => {
    const { tools, failures } = counted(entry)
    const counts = entry.kind === 'prompt' || entry.kind === 'task' ? [tools > 0 ? `${tools} ${tools === 1 ? 'tool' : 'tools'}` : '', failures > 0 ? `${failures} failed` : ''].filter((part) => part !== '').join(' · ') : ''
    const status = entry.isRunning && entry.kind === 'task' ? 'running' : entry.isError ? 'failed' : counts
    const hasChildren = entry.children.length > 0 && mod.state.session.history.layout === 'tasks' && mod.state.session.history.filter !== 'prompts'
    const opener = hasChildren
      ? Button({ plain: true, key: `history:toggle:${entry.key}`, onPress: () => toggle(entry.key), children: Text({ dimColor: true, children: isOpen ? '▾' : '▸' }) })
      : Text({ children: ' ' })
    return Box({
      key: `history:row:${entry.key}`,
      paddingLeft: depth * 2,
      columnGap: 1,
      width: columns,
      children: [
        opener,
        Button({
          plain: true,
          key: `history:${entry.key}`,
          onPress: () => scrollTo(entry.message ?? entry.children[0]?.message ?? null),
          children: Text({ wrap: 'truncate-end', ...(entry.kind === 'prompt' ? { bold: true } : {}), children: [Text({ dimColor: entry.kind !== 'prompt', children: entry.name }), ` ${entry.text}`] }),
        }),
        ...(status === '' ? [] : [Box({ flexGrow: 1 }), Text({ ...(entry.isError || failures > 0 ? { color: 'error' } : { dimColor: true }), children: status })]),
      ],
    })
  }

  const draw = (columns: number): JSX.Element => {
    const { history: entries, historyError } = mod.state.memory
    const { find, filter, layout } = mod.state.session.history
    if (entries === null && historyError === null && loading === undefined) refresh()
    const controls = Box({
      columnGap: 2,
      flexWrap: 'wrap',
      children: [
        Input({ key: 'history:find', label: 'Find', value: find, placeholder: 'text in a row', submitLabel: 'find', onInput: (text: string) => void (mod.state.session.history = { ...mod.state.session.history, find: text }), onSubmit: (text: string) => void (mod.state.session.history = { ...mod.state.session.history, find: text }) }),
        Select({ key: 'history:filter', label: 'Show', value: filter, options: filters.map((each) => ({ value: each, label: filterLabels[each] })), onSelect: (picked: string) => void (mod.state.session.history = { ...mod.state.session.history, filter: picked as HistoryFilter }) }),
        Select({ key: 'history:layout', label: 'As', value: layout, options: [{ value: 'tasks', label: 'Tasks' }, { value: 'timeline', label: 'Timeline' }], onSelect: (picked: string) => void (mod.state.session.history = { ...mod.state.session.history, layout: picked === 'timeline' ? 'timeline' : 'tasks' }) }),
      ],
    })
    const body = (): JSX.Element => {
      if (historyError !== null) return Text({ color: 'error', wrap: 'wrap', children: historyError })
      if (entries === null) return Text({ dimColor: true, children: 'Reading the conversation…' })
      if (entries.length === 0) return Text({ dimColor: true, wrap: 'wrap', children: 'Nothing here yet. Each prompt you send shows here, with what Claude did for it.' })
      const rows = layout === 'tasks' ? visible(entries) : timeline(entries)
      if (rows.length === 0) return Text({ dimColor: true, children: 'No row matches.' })
      return Box({ flexDirection: 'column', children: rows.map((shown) => row(shown, columns)) })
    }
    return Box({ flexDirection: 'column', gap: 1, children: [controls, body()] })
  }

  return { title: 'History', draw, refresh }
}
