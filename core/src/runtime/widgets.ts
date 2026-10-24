import type { ElementTable, MarkdownProps, RenderElement } from 'claude-code'
import { isObject, storeChangedPath, widgetsPath } from '../records.js'
import type { TurnData } from '../session/conversation.js'
import { AbovePrompt, areas, BelowPrompt, TurnEnd, Working, type Area } from '../ui/areas.js'
import { Box, drawWith } from '../ui/elements.js'
import type { StyledAt } from '../ui/styles.js'
import { ifMissing } from '../utils/paths.js'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import { cmodPluginName } from './dependencies.js'
import type { DrawnParts } from './parts.js'
import type { Router } from './router.js'
import { partMethods, styledAt, viewportColumns, type PartsUpdate, type WidgetDeclaration } from './ui.js'

export type WidgetRow = { readonly left: readonly string[]; readonly right: readonly string[] }

export type WidgetLayout = { readonly areas: Readonly<Record<Area, readonly WidgetRow[]>>; readonly hidden: readonly string[] }

export type PlacedWidget = { readonly key: string; readonly mod: string; readonly title: string; readonly areas: readonly Area[] } & Pick<WidgetDeclaration, 'place'>

export type Move = 'up' | 'down' | 'left' | 'right'

export const claudeHint = 'claude/hint'

export const claudeModes = 'claude/modes'

export const builtInWidgets: readonly PlacedWidget[] = [
  { key: claudeHint, mod: 'claude', title: "Claude Code's hint", areas: [BelowPrompt] },
  { key: claudeModes, mod: 'claude', title: "Claude Code's mode labels", areas: [BelowPrompt] },
]

const promptIndent = 4

const transcriptIndent = 2

const widgetSizes = { fit: { flexShrink: 0 }, fill: { flexGrow: 1, flexShrink: 1, minWidth: 0 } } as const


const separator = ''

export type Widgets = {
  update(mod: string, update: Pick<PartsUpdate, 'parts' | 'redraw'>): void
  widgets(): readonly PlacedWidget[]
  layout(): WidgetLayout
  change(edit: (layout: WidgetLayout) => WidgetLayout): Promise<void>
  reload(): Promise<void>
  recheck(): Promise<void>
  rows(area: Area, columns: number): RenderElement[]
  draw(area: Area, table: ElementTable, at: StyledAt, turn?: TurnData): Promise<RenderElement[]>
}

export function layoutOf(value: unknown): WidgetLayout {
  const keys = (list: unknown) => (Array.isArray(list) ? list.filter((key): key is string => typeof key === 'string') : [])
  const rowsOf = (list: unknown): WidgetRow[] => (Array.isArray(list) ? list.filter(isObject).map((row) => ({ ...row, left: keys(row['left']), right: keys(row['right']) })) : [])
  const stored = isObject(value) && isObject(value['areas']) ? value['areas'] : {}
  return { areas: Object.fromEntries(areas.map((area) => [area, rowsOf(stored[area])])) as unknown as WidgetLayout['areas'], hidden: isObject(value) ? keys(value['hidden']) : [] }
}

const stringsIn = (value: unknown): string[] => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(stringsIn) : isObject(value) ? Object.values(value).flatMap(stringsIn) : [])

const holds = (row: WidgetRow, key: string) => row.left.includes(key) || row.right.includes(key)

export function placedIn(layout: WidgetLayout, key: string): Area | undefined {
  return areas.find((area) => layout.areas[area].some((row) => holds(row, key)))
}

export function toggled(layout: WidgetLayout, key: string): WidgetLayout {
  return { ...layout, hidden: layout.hidden.includes(key) ? layout.hidden.filter((each) => each !== key) : [...layout.hidden, key] }
}

export function moved(layout: WidgetLayout, widget: PlacedWidget, move: Move): WidgetLayout {
  const area = placedIn(layout, widget.key)
  if (area === undefined) return layout
  const rows = layout.areas[area]
  const at = rows.findIndex((row) => holds(row, widget.key))
  const row = rows[at] as WidgetRow
  const side = row.left.includes(widget.key) ? 'left' : 'right'
  const withAreas = (changed: Partial<Record<Area, readonly WidgetRow[]>>): WidgetLayout => ({ ...layout, areas: { ...layout.areas, ...Object.fromEntries(Object.entries(changed).map(([name, list]) => [name, list.filter((each) => stringsIn(each).length > 0)])) } })
  if (move === 'left' || move === 'right') {
    const sequence = [...row.left, separator, ...row.right]
    const from = sequence.indexOf(widget.key)
    const to = move === 'left' ? from - 1 : from + 1
    if (to < 0 || to >= sequence.length) return layout
    ;[sequence[from], sequence[to]] = [sequence[to] as string, widget.key]
    const split = sequence.indexOf(separator)
    return withAreas({ [area]: rows.map((each, index) => (index === at ? { ...each, left: sequence.slice(0, split), right: sequence.slice(split + 1) } : each)) })
  }
  const without = rows.map((each, index) => (index === at ? { ...each, left: each.left.filter((key) => key !== widget.key), right: each.right.filter((key) => key !== widget.key) } : each))
  const added = (target: WidgetRow | undefined): WidgetRow => ({ ...target, left: target?.left ?? [], right: target?.right ?? [], [side]: [...(target?.[side] ?? []), widget.key] })
  const target = at + (move === 'up' ? -1 : 1)
  if (target >= 0 && target < rows.length) return withAreas({ [area]: without.map((each, index) => (index === target ? added(each) : each)) })
  if (move === 'down' && row.left.length + row.right.length > 1) return withAreas({ [area]: [...without, added(undefined)] })
  const next = (move === 'up' ? areas.slice(0, areas.indexOf(area)).reverse() : areas.slice(areas.indexOf(area) + 1)).find((each) => widget.areas.includes(each))
  if (next === undefined) return layout
  const nextRows = layout.areas[next]
  const landing = move === 'up' ? [...nextRows.slice(0, -1), added(nextRows.at(-1))] : [added(nextRows[0]), ...nextRows.slice(1)]
  return withAreas({ [area]: without, [next]: landing })
}

function declarationsOf(input: unknown): WidgetDeclaration[] {
  const listed = isObject(input) && Array.isArray(input['widgets']) ? (input['widgets'] as unknown[]) : []
  return listed.filter(isObject).flatMap((each) => {
    const known = Array.isArray(each['areas']) ? (each['areas'] as unknown[]).filter((area): area is Area => (areas as readonly unknown[]).includes(area)) : []
    const { side, size }: Record<string, unknown> = isObject(each['place']) ? each['place'] : {}
    const place: NonNullable<WidgetDeclaration['place']> = { ...(side === 'left' || side === 'right' ? { side } : {}), ...(size === 'fit' || size === 'fill' ? { size } : {}) }
    return typeof each['id'] === 'string' && typeof each['title'] === 'string' && known.length > 0 ? [{ id: each['id'], title: each['title'], areas: known, place }] : []
  })
}

export function serveWidgets({
  claude,
  router,
  store,
  report,
  turnClosedBy,
  parts,
  markdownIn,
}: {
  readonly claude: Claude
  readonly router: Router
  readonly store: string
  readonly report: (id: string, message: string, error: unknown) => void
  readonly turnClosedBy: (rowId: string) => TurnData | undefined
  readonly parts: DrawnParts
  readonly markdownIn: (table: ElementTable, at: StyledAt) => ((props: MarkdownProps) => RenderElement) | undefined
}): Widgets {
  const path = widgetsPath(store)
  const declared = new Map<string, readonly WidgetDeclaration[]>()
  let stored = layoutOf({})
  let layout = stored
  let saving: Promise<void> = Promise.resolve()

  let placedKeys: ReadonlySet<string> = new Set()

  const readFile = async () => {
    const file = JSON.parse(await claude.fs.read(path).catch(ifMissing('{}'))) as unknown
    placedKeys = new Set(stringsIn(isObject(file) ? file['areas'] : undefined))
    return file
  }

  const read = async () => layoutOf(await readFile())

  const redraw = () => claude.ui.invalidate('ui.render')

  const placed = (): PlacedWidget[] => [...builtInWidgets, ...[...declared].flatMap(([mod, list]) => list.map(({ id, title, areas: listed, place }) => ({ key: `${mod}/${id}`, mod, title, areas: listed, ...(place === undefined ? {} : { place }) })))]

  const change = (edit: (current: WidgetLayout) => WidgetLayout) => {
    saving = saving
      .then(async () => {
        const file = await readFile()
        stored = layoutOf(file)
        const current = withNewWidgets(stored)
        const next = edit(current)
        if (next !== current) {
          const kept = isObject(file) ? file : {}
          await claude.fs.write(path, `${JSON.stringify({ ...kept, ...next, areas: { ...(isObject(kept['areas']) ? kept['areas'] : {}), ...next.areas } }, null, 2)}\n`)
          await claude.fs.write(storeChangedPath(store), '')
          stored = next
        }
        place()
      })
      .catch((error: unknown) => report('widgets:layout', 'Could not save the widget layout', error))
    return saving
  }

  const place = () => {
    layout = withNewWidgets(stored)
    redraw()
  }

  const withNewWidgets = (current: WidgetLayout) =>
    placed()
      .filter(({ key, mod }) => mod !== 'claude' && placedIn(current, key) === undefined && !placedKeys.has(key))
      .reduce((next, { key, areas: [area = AbovePrompt], place }) => {
        const [first, ...rest] = next.areas[area]
        const row = { ...first, left: first?.left ?? [], right: first?.right ?? [] }
        const side = place?.side ?? 'left'
        return { ...next, areas: { ...next.areas, [area]: [{ ...row, [side]: [...row[side], key] }, ...rest] } }
      }, current)

  const ask = async (mod: string) => {
    try {
      declared.set(mod, declarationsOf(await claude.cmod.call({ to: mod, method: partMethods.list, input: null })))
    } catch (error) {
      declared.delete(mod)
      claude.ui.log(`cmod: ${mod} did not list its widgets: ${messageOf(error)}`, { to: 'debug' })
    }
  }

  const recheck = async () => {
    const mods = [...declared.keys()]
    await Promise.all(mods.map(ask))
    for (const mod of mods) parts.forget(mod)
    redraw()
  }

  const reload = async () => {
    stored = await read()
    if (JSON.stringify(withNewWidgets(stored)) !== JSON.stringify(layout)) place()
  }

  saving = (async () => {
    const recorded = (await claude.fs.list(`${store}/records`).catch(ifMissing([]))).map((entry) => entry.name).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length))
    stored = await read().catch((error: unknown) => {
      report('widgets:layout', 'Could not read the widget layout', error)
      return stored
    })
    const named = areas.flatMap((area) => stored.areas[area].flatMap((row) => [...row.left, ...row.right])).map((key) => key.slice(0, key.indexOf('/')))
    await Promise.all([...new Set([...recorded, ...named])].filter((mod) => mod !== cmodPluginName && mod !== 'claude' && !declared.has(mod)).map(ask))
    place()
  })().catch((error: unknown) => report('widgets:layout', 'Could not list the widgets of the mods', error))

  const widgetOf = (key: string) => placed().find((widget) => widget.key === key)

  const cacheKey = (key: string, area: Area, columns: number, turn: TurnData | undefined) => `${key}\u0000${area}\u0000${columns}\u0000${turn?.prompt.id ?? ''}`

  const nameOf = (widget: PlacedWidget) => `The ${widget.title} widget of ${widget.mod}`

  const fill = (key: string, area: Area, columns: number, turn: TurnData | undefined): Promise<void> | undefined => {
    const widget = widgetOf(key)
    if (widget === undefined || !widget.areas.includes(area)) return undefined
    return parts.fill(widget.mod, cacheKey(key, area, columns, turn), { widget: key.slice(widget.mod.length + 1), area, columns, ...(turn === undefined ? {} : { turn }) }, nameOf(widget))
  }

  const elementFor = (key: string, area: Area, columns: number, turn: TurnData | undefined): RenderElement | undefined => {
    const widget = widgetOf(key)
    if (widget === undefined) return undefined
    const element = parts.element(widget.mod, cacheKey(key, area, columns, turn), `${key}:`, nameOf(widget), `widget:${key}`)
    return element === undefined ? undefined : Box({ ...widgetSizes[widget.place?.size ?? 'fit'], children: element })
  }

  const isHidden = (key: string) => layout.hidden.includes(key)

  const shown = (keys: readonly string[]) => keys.filter((key) => !isHidden(key))

  const rowsNow = (area: Area, columns: number, turn: TurnData | undefined): RenderElement[] =>
    layout.areas[area].flatMap((row) => {
      const side = (keys: readonly string[]) => shown(keys).map((key) => elementFor(key, area, columns, turn)).filter((each) => each !== undefined)
      const left = side(row.left)
      const right = side(row.right)
      const group = (keys: readonly string[], children: readonly RenderElement[]) => Box({ flexShrink: shown(keys).some((key) => widgetOf(key)?.place?.size === 'fill') ? 1 : 0, minWidth: 0, columnGap: 2, children })
      return left.length + right.length === 0 ? [] : [Box({ justifyContent: 'space-between', width: columns, columnGap: 2, children: [group(row.left, left), group(row.right, right)] })]
    })

  const keysIn = (area: Area) => layout.areas[area].flatMap((row) => shown([...row.left, ...row.right]))

  const draw = async (area: Area, table: ElementTable, at: StyledAt, turn?: TurnData): Promise<RenderElement[]> => {
    await Promise.all(keysIn(area).map((key) => fill(key, area, at.columns, turn)))
    return drawWith(table, () => rowsNow(area, at.columns, turn), markdownIn(table, at))
  }

  const rows = (area: Area, columns: number): RenderElement[] => {
    const started = keysIn(area).flatMap((key) => fill(key, area, columns, undefined) ?? [])
    if (started.length > 0) void Promise.all(started).then(redraw)
    return rowsNow(area, columns, undefined)
  }

  const column = (table: ElementTable, children: readonly RenderElement[]) => drawWith(table, () => Box({ flexDirection: 'column', children }))

  const below = (table: ElementTable, above: RenderElement, added: readonly RenderElement[]) => (added.length === 0 ? above : column(table, [above, ...added]))

  router.add('ui.render', async (e, next) => {
    const table = claude.ui.resolve(e)
    const inTranscript = styledAt(e, viewportColumns(e) - transcriptIndent)
    if (e.component === 'AbovePrompt') return e.props.hasSurvey ? next(e) : below(table, await next(e), await draw(AbovePrompt, table, styledAt(e, e.props.bodyColumns)))
    if (e.component === 'PromptHint') {
      const added = await draw(BelowPrompt, table, styledAt(e, viewportColumns(e) - promptIndent))
      return isHidden(claudeHint) ? column(table, added) : below(table, await next(e), added)
    }
    if (e.component === 'SessionMode') return isHidden(claudeModes) ? column(table, []) : next(e)
    if (e.component === 'Spinner') return below(table, await next(e), await draw(Working, table, inTranscript))
    if (e.component === 'TurnDuration') {
      const turn = turnClosedBy(e.requestId)
      return below(table, await next(e), turn === undefined ? [] : await draw(TurnEnd, table, inTranscript, turn))
    }
    return next(e)
  })

  return {
    update(mod, { parts: listing, redraw }) {
      if (listing === undefined && redraw !== true) return
      parts.forget(mod)
      if (listing !== undefined) {
        const listed = declarationsOf(listing)
        const isNewList = JSON.stringify(listed) !== JSON.stringify(declared.get(mod) ?? [])
        declared.set(mod, listed)
        if (isNewList) return place()
      }
      claude.ui.invalidate('ui.render')
    },
    widgets: placed,
    layout: () => layout,
    change,
    reload,
    recheck,
    rows,
    draw,
  }
}
