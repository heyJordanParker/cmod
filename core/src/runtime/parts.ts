import type { RenderComponent, RenderElement } from 'claude-code'
import type { Surface } from '../mod.js'
import { isObject } from '../records.js'
import type { TurnData } from '../session/conversation.js'
import { Dashboard, TurnEnd, type Area } from '../ui/areas.js'
import { elementData, elementOf, Text, type Handler } from '../ui/elements.js'
import { listed, messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import { cmodPluginName, isNotInstalled, isStillInstalling } from './dependencies.js'
import { styleInterface, uiParts, type Implementation } from './interfaces.js'
import type { Router } from './router.js'
import { partMethods, stalePress, type DrawnPart, type PageDeclaration, type PartPress, type PartRequest, type PartsUpdate, type ShownParts, type ViewDeclaration, type WidgetDeclaration } from './ui.js'
import { areaComponents, widgetsOf, type Widgets } from './widgets.js'

export type DrawnParts = {
  fill(mod: string, cached: string, input: Readonly<Record<string, unknown>>, name: string): Promise<void> | undefined
  element(mod: string, cached: string, keyPrefix: string, name: string, reportId: string): RenderElement | undefined
  failure(mod: string, cached: string): string | undefined
  forget(mod: string): void
}

type Drawn = { readonly data: DrawnPart | null; readonly failure?: string; readonly generation: number }

const keptDrawings = 200

export function drawnParts({ claude, report, press }: { readonly claude: Claude; readonly report: (id: string, message: string, error: unknown) => void; readonly press: (mod: string, press: PartPress) => void }): DrawnParts {
  const drawn = new Map<string, Drawn>()
  const drawing = new Map<string, Promise<void>>()
  const generations = new Map<string, number>()
  const keyOf = (mod: string, cached: string) => `${mod}\u0000${cached}`
  const generationOf = (mod: string) => generations.get(mod) ?? 0

  return {
    fill(mod, cached, input, name) {
      const key = keyOf(mod, cached)
      const generation = generationOf(mod)
      if (drawn.get(key)?.generation === generation) return undefined
      const keep = (data: DrawnPart | null, failure?: string) => {
        drawn.delete(key)
        drawn.set(key, { data, ...(failure === undefined ? {} : { failure }), generation })
        const [oldest] = drawn.keys()
        if (drawn.size > keptDrawings && oldest !== undefined) drawn.delete(oldest)
        if (generationOf(mod) !== generation) claude.ui.invalidate('ui.render')
      }
      const pending =
        drawing.get(key) ??
        claude.cmod
          .call({ to: mod, method: partMethods.draw, input })
          .then(
            (data) => keep((data ?? null) as DrawnPart | null),
            (error: unknown) => {
              if (isStillInstalling(mod, error)) return keep(drawn.get(key)?.data ?? null)
              report(`draw:${mod}`, `${name} drew nothing`, error)
              keep(drawn.get(key)?.data ?? null, messageOf(error))
            },
          )
          .finally(() => drawing.delete(key))
      drawing.set(key, pending)
      return pending
    },
    element(mod, cached, keyPrefix, name, reportId) {
      const key = keyOf(mod, cached)
      const entry = drawn.get(key)
      if (entry === undefined) return undefined
      drawn.delete(key)
      drawn.set(key, entry)
      const { data } = entry
      if (data === null || data.tree === null) return undefined
      try {
        return elementOf(data.tree, keyPrefix, (handler, args) => press(mod, { draw: data.draw, handler, args })) as RenderElement
      } catch (error) {
        report(reportId, `${name} could not draw`, error)
        return undefined
      }
    },
    failure(mod, cached) {
      return drawn.get(keyOf(mod, cached))?.failure
    },
    forget(mod) {
      generations.set(mod, generationOf(mod) + 1)
    },
  }
}

const askedWaitMs = 1000

const keptUiDraws = 2

export type ModParts = { readonly mod: string; readonly widgets: readonly WidgetDeclaration[]; readonly views: readonly ViewDeclaration[]; readonly pages: readonly PageDeclaration[] }

export type PartApply = (mod: string, requests: readonly PartRequest[]) => Promise<void>

export type PartOpen = (mod: string, id: string, isOpen: boolean) => Promise<void>

type UiPart = { readonly mod: string; readonly id: string }

type UiHandler = UiPart & { readonly component: RenderComponent; readonly run: Handler }

export type UiEvent = { readonly Change: { readonly part: 'widgets' | 'views' | 'pages' }; readonly Redraw: UiPart; readonly Open: UiPart & { readonly isAsked?: true }; readonly Close: UiPart }

const settingsView = 'settings'

export type UiTell = <Event extends keyof UiEvent>(event: Event, payload: UiEvent[Event]) => void

export type UiPress = { readonly surface: Surface; readonly key?: string; readonly value?: string; readonly kind?: 'change' | 'submit'; readonly link?: { readonly href: string } }

export type Parts = {
  declared(): readonly ModParts[]
  providers(name: string): readonly string[]
  stylers(): readonly string[]
  element(mod: string, id: string, params: unknown, columns: number, isFocused: boolean, surface: Surface): RenderElement | undefined
  press(mod: string, press: PartPress): Promise<void>
  update(mod: string, update: PartsUpdate): boolean
  isHosted(): boolean
  revealed(mod: string, id: string): boolean
  tell(mod: string, shown: ShownParts): void
  apply(listener: PartApply): void
  onOpen(listener: PartOpen): void
  onStart(listener: (mod: string) => void): void
  onDeclare(listener: (mod: string) => void): void
  turnClosed(turn: TurnData): void
  readonly ui: Implementation
}

export function providedBy(listing: unknown): readonly string[] {
  if (!isObject(listing)) return []
  const named = Array.isArray(listing['provides']) ? listing['provides'].filter((each): each is string => typeof each === 'string') : []
  return listing['stylesMarkdown'] === true && !named.includes(styleInterface) ? [...named, styleInterface] : named
}

const listedIn = (input: unknown, field: string) => (isObject(input) && Array.isArray(input[field]) ? (input[field] as unknown[]).filter(isObject) : [])

const isNamed = (each: Readonly<Record<string, unknown>>): each is Readonly<Record<string, unknown>> & { readonly id: string; readonly title: string } => typeof each['id'] === 'string' && typeof each['title'] === 'string'

export function viewsOf(input: unknown): ViewDeclaration[] {
  return listedIn(input, 'pages').flatMap((each) => (isNamed(each) && (each['place'] === 'sidebar' || each['place'] === 'settings') ? [{ id: each.id, title: each.title, place: each['place'] }] : []))
}

export function pagesOf(input: unknown): PageDeclaration[] {
  return listedIn(input, 'pages').flatMap((each) => (isNamed(each) && each['place'] === undefined ? [{ id: each.id, title: each.title }] : []))
}

function partsOf(mod: string, listing: unknown): ModParts {
  return { mod, widgets: widgetsOf(listing), views: viewsOf(listing), pages: pagesOf(listing) }
}

export function serveParts({
  claude,
  router,
  report,
  tellRefusedPress,
  widgets,
  parts,
  tellStylers,
  tellUi,
  tellProviders = () => undefined,
}: {
  readonly claude: Claude
  readonly router: Router
  readonly report: (id: string, message: string, error: unknown) => void
  readonly tellRefusedPress: (mod: string, error: unknown) => void
  readonly widgets: Pick<Widgets, 'update'>
  readonly parts: DrawnParts
  readonly tellStylers: (stylers: readonly string[]) => void
  readonly tellUi: UiTell
  readonly tellProviders?: (names: readonly string[]) => void
}): Parts {
  const declared = new Map<string, ModParts>()
  const provided = new Map<string, Set<string>>()
  const providersOf = (name: string) => [...(provided.get(name) ?? [])]
  const shownBy = new Map<string, ShownParts>()
  let inApps = new Map<string, readonly string[]>()
  let isHosted = false
  const tellShown = (mod: string) => {
    const shown: ShownParts = { ...(shownBy.get(mod) ?? { open: [], shown: null, isFocused: false }), inApps: inApps.get(mod) ?? [] }
    void claude.cmod.call({ to: mod, method: partMethods.shown, input: plain(shown) }).catch((error: unknown) => claude.ui.warn(`pages:shown:${mod}`, `cmod: ${mod} did not hear which of its views and pages show: ${messageOf(error)}`))
  }
  const asking = new Map<string, Promise<void>>()
  const pressing = new Set<Promise<void>>()
  let waiting: { readonly mod: string; readonly requests: readonly PartRequest[] }[] = []
  let inputDepth = 0
  let applyTo: PartApply = async () => undefined
  let openIn: PartOpen = async () => undefined
  let started: (mod: string) => void = () => undefined
  let declaredChanged: (mod: string) => void = () => undefined

  const run = (mod: string, requests: readonly PartRequest[]) =>
    applyTo(mod, requests).catch((error: unknown) => report(`pages:${mod}`, `Could not show the view or page ${mod} asked for`, error))

  const takeWaiting = async () => {
    const taken = waiting
    waiting = []
    for (const { mod, requests } of taken) await run(mod, requests)
  }

  const settle = async (earlier: ReadonlySet<Promise<void>>) => {
    const own = () => [...pressing].filter((pending) => !earlier.has(pending))
    for (let pending = own(); pending.length > 0; pending = own()) await Promise.allSettled(pending)
    await takeWaiting()
  }

  const wrapped = async <Answer>(next: () => Promise<Answer>): Promise<Answer> => {
    inputDepth += 1
    const earlier = new Set(pressing)
    try {
      const answer = await next()
      await settle(earlier)
      return answer
    } finally {
      inputDepth -= 1
    }
  }

  router.add('command.run', (e, next) => wrapped(async () => (waiting.length > 0 ? {} : next(e))))
  router.add('ui.press', (e, next) => wrapped(() => next(e)))

  const declare = (mod: string, listing: unknown) => {
    const before = declared.get(mod)
    const after = partsOf(mod, listing)
    declared.set(mod, after)
    const changedParts = uiParts.filter((part) => JSON.stringify(before?.[part] ?? []) !== JSON.stringify(after[part]))
    for (const part of changedParts) tellUi('Change', { part })
    if (before === undefined || changedParts.length > 0) declaredChanged(mod)
  }

  const ask = (mod: string) => {
    const pending =
      asking.get(mod) ??
      claude.cmod
        .call({ to: mod, method: partMethods.list, input: null })
        .then(
          (listing) => declare(mod, listing),
          (error: unknown) => {
            if (!isNotInstalled(mod, error) && !isStillInstalling(mod, error)) claude.ui.warn(`pages:list:${mod}`, `cmod: ${mod} did not list its views and pages: ${messageOf(error)}`)
          },
        )
        .finally(() => asking.delete(mod))
    asking.set(mod, pending)
    return pending
  }

  const provide = (mod: string, names: readonly string[]) => {
    const wasStyler = provided.get(styleInterface)?.has(mod) === true
    const left = [...provided].filter(([name, mods]) => !names.includes(name) && mods.delete(mod)).map(([name]) => name)
    const arrived = names.filter((name) => provided.get(name)?.has(mod) !== true)
    for (const name of names) provided.set(name, (provided.get(name) ?? new Set<string>()).add(mod))
    if (left.length + arrived.length > 0) tellProviders([...left, ...arrived])
    if (wasStyler || names.includes(styleInterface)) restyle(mod)
  }

  const restyle = (mod: string) => {
    parts.forget(mod)
    const listed = providersOf(styleInterface)
    tellStylers(listed)
    for (const told of declared.keys()) {
      if (told === cmodPluginName) continue
      void claude.cmod.call({ to: told, method: partMethods.stylers, input: listed }).catch((error: unknown) => {
        if (!isStillInstalling(told, error)) claude.ui.warn(`pages:stylers:${told}`, `cmod: ${told} did not hear which mods style markdown: ${messageOf(error)}`)
      })
    }
  }

  const idsOf = (mod: string) => {
    const known = declared.get(mod)
    return [...(known?.widgets ?? []), ...(known?.views ?? []), ...(known?.pages ?? [])].map(({ id }) => id)
  }

  const isShownByApps = (mod: string, id: string) => {
    const known = declared.get(mod)
    return known?.views.some((each) => each.id === id && each.place === 'sidebar') === true || known?.pages.some((each) => each.id === id) === true
  }

  const tellRequested = (mod: string, requests: readonly PartRequest[], isAsked: boolean) => {
    const asked = isAsked ? { isAsked: true as const } : {}
    for (const request of requests) {
      const isInSettings = 'settings' in request || ('open' in request && declared.get(mod)?.views.some((each) => each.id === request.open && each.place === 'settings') === true)
      if ('open' in request && isShownByApps(mod, request.open)) tellUi('Open', { mod, id: request.open, ...asked })
      if (isInSettings && isShownByApps(cmodPluginName, settingsView)) tellUi('Open', { mod: cmodPluginName, id: settingsView, ...asked })
      if ('close' in request && isShownByApps(mod, request.close)) tellUi('Close', { mod, id: request.close })
    }
  }

  const revealed = (mod: string, id: string) => {
    if (!isHosted || !isShownByApps(mod, id)) return false
    tellUi('Open', { mod, id, isAsked: true })
    return true
  }

  const update = (mod: string, { parts: listing, redraw, requests, isAsked, isStart }: PartsUpdate) => {
    if (isStart === true) started(mod)
    if (listing !== undefined) declare(mod, listing)
    if (listing !== undefined) provide(mod, providedBy(listing))
    const isRedrawn = redraw === true || requests?.some((request) => 'open' in request) === true
    if (listing !== undefined || isRedrawn) widgets.update(mod, { ...(listing === undefined ? {} : { parts: listing }), ...(isRedrawn ? { redraw: true } : {}) })
    if (redraw === true) for (const id of idsOf(mod)) tellUi('Redraw', { mod, id })
    if (requests === undefined || requests.length === 0) return false
    tellRequested(mod, requests, isAsked === true)
    if (isAsked !== true) return (void run(mod, requests), false)
    waiting.push({ mod, requests })
    if (inputDepth > 0) return true
    claude.clock.after(askedWaitMs, () => void takeWaiting())
    return false
  }

  const press = (mod: string, input: PartPress) => {
    const pending = claude.cmod
      .call({ to: mod, method: partMethods.press, input })
      .then(
        (answer) => void update(mod, (isObject(answer) ? answer : {}) as PartsUpdate),
        (error: unknown) => {
          parts.forget(mod)
          claude.ui.invalidate('ui.render')
          tellRefusedPress(mod, error)
        },
      )
      .finally(() => pressing.delete(pending))
    pressing.add(pending)
    if (inputDepth === 0) void pending.then(takeWaiting)
    return pending
  }

  const lastDrawn = new Map<string, { readonly params: string; readonly cached: string }>()

  const plain = <Data,>(data: Data): Data => JSON.parse(JSON.stringify(data)) as Data

  const nameOf = (mod: string, id: string) => `The ${id} ${declared.get(mod)?.pages.some((each) => each.id === id) === true ? 'page' : 'view'} of ${mod}`

  const element = (mod: string, id: string, params: unknown, columns: number, isFocused: boolean, surface: Surface) => {
    if (!declared.has(mod)) void ask(mod)
    const given = JSON.stringify(params ?? null)
    const cached = `${id}\u0000${given}\u0000${columns}\u0000${isFocused}\u0000${surface}`
    const name = nameOf(mod, id)
    const keyPrefix = `${mod}/${id}:`
    void parts.fill(mod, cached, { page: id, params: plain(params ?? null), columns, isFocused, surface }, name)?.then(() => claude.ui.invalidate('ui.render'))
    const failure = parts.failure(mod, cached)
    const drawnAt = (key: string) => parts.element(mod, key, keyPrefix, name, `page:${mod}/${id}`)
    const last = lastDrawn.get(keyPrefix)
    const drawn = drawnAt(cached)
    if (drawn !== undefined) lastDrawn.set(keyPrefix, { params: given, cached })
    return drawn ?? (last?.params === given ? drawnAt(last.cached) : undefined) ?? (failure === undefined ? undefined : Text({ color: 'error', children: `${name} could not draw: ${failure}` }))
  }

  const pressable = new Map<number, UiHandler>()
  const uiDraws = new Map<string, readonly (readonly number[])[]>()
  let lastHandler = 0

  const numbered = (part: UiPart, component: RenderComponent, drawn: RenderElement) => {
    const numbers: number[] = []
    const tree = elementData(drawn, (run) => {
      lastHandler += 1
      pressable.set(lastHandler, { ...part, component, run })
      numbers.push(lastHandler)
      return lastHandler
    })
    const key = `${part.mod}/${part.id}`
    const earlier = uiDraws.get(key) ?? []
    const kept = [...earlier, numbers].slice(-keptUiDraws)
    for (const draw of earlier) if (!kept.includes(draw)) for (const handler of draw) pressable.delete(handler)
    uiDraws.set(key, kept)
    return tree
  }

  const viewOrPage = ({ mod, id }: UiPart) => {
    const known = declared.get(mod)
    return known?.views.find((each) => each.id === id) ?? known?.pages.find((each) => each.id === id)
  }

  let closedTurn: TurnData | undefined

  const drawnPart = async (part: UiPart, columns: number, surface: Surface, shownIn: Area | undefined): Promise<{ readonly cached: string; readonly name: string; readonly keyPrefix: string; readonly component: RenderComponent } | undefined> => {
    const { mod, id } = part
    if (viewOrPage(part) !== undefined) {
      const params = shownBy.get(mod)?.open.find((each) => each.id === id)?.params ?? null
      const cached = `${id}\u0000${JSON.stringify(params)}\u0000${columns}\u0000true\u0000${surface}`
      const name = nameOf(mod, id)
      await parts.fill(mod, cached, { page: id, params: plain(params), columns, isFocused: true, surface }, name)
      return { cached, name, keyPrefix: `${mod}/${id}:`, component: 'Pane' }
    }
    const widget = declared.get(mod)?.widgets.find((each) => each.id === id)
    if (widget === undefined) throw new Error(`${mod} has no widget, view, or page ${id} in this session.`)
    const name = `The ${widget.title} widget of ${mod}`
    if (shownIn !== undefined && !widget.areas.includes(shownIn)) throw new Error(`${name} draws in ${listed(widget.areas)}, not ${shownIn}.`)
    const area = shownIn ?? (widget.areas.includes(Dashboard) ? Dashboard : (widget.areas[0] ?? Dashboard))
    const turn = area === TurnEnd ? closedTurn : undefined
    if (area === TurnEnd && turn === undefined) return undefined
    const key = `${mod}/${id}`
    const cached = `${key}\u0000${area}\u0000${columns}\u0000${surface}\u0000${turn?.prompt.id ?? ''}`
    await parts.fill(mod, cached, { widget: id, area, columns, surface, ...(turn === undefined ? {} : { turn }) }, name)
    return { cached, name, keyPrefix: `${key}:`, component: areaComponents[area] }
  }

  const ui: Implementation = {
    widgets: () => [...declared.values()].flatMap(({ mod, widgets: listed }) => listed.map(({ id, areas }) => ({ mod, id, areas }))),
    views: () => [...declared.values()].flatMap(({ mod, views }) => views.flatMap(({ id, title, place }) => (place === 'sidebar' ? [{ mod, id, title }] : []))),
    pages: () => [...declared.values()].flatMap(({ mod, pages }) => pages.map(({ id, title }) => ({ mod, id, title }))),
    async draw(_session: string, part: UiPart, { columns, surface, area }: { readonly columns: number; readonly surface: Surface; readonly area?: Area }) {
      const drawing = await drawnPart(part, columns, surface, area)
      if (drawing === undefined) return null
      const { cached, name, keyPrefix, component } = drawing
      const failure = parts.failure(part.mod, cached)
      if (failure !== undefined) throw new Error(`${name} could not draw: ${failure}`)
      const drawn = parts.element(part.mod, cached, keyPrefix, name, `ui:${part.mod}/${part.id}`)
      return drawn === undefined ? null : numbered(part, component, drawn)
    },
    async press(_session: string, handler: number, { surface, key, value, kind, link }: UiPress) {
      const known = pressable.get(handler)
      if (known === undefined) throw new Error(`cmod: ${stalePress}`)
      const pressed = { plugin: known.mod, element: key ?? '', component: known.component, requestId: known.id, surface, ...(kind === undefined ? {} : { kind }), ...(value === undefined ? {} : { value }), ...(link === undefined ? {} : { link }) }
      await known.run(...(link !== undefined ? [link, pressed] : value !== undefined ? [value, pressed] : [pressed]))
      return null
    },
    async open(_session: string, part: UiPart) {
      if (viewOrPage(part) === undefined) throw new Error(`${part.mod} has no view or page ${part.id} in this session.`)
      await openIn(part.mod, part.id, true)
      return null
    },
    async close(_session: string, part: UiPart) {
      await openIn(part.mod, part.id, false)
      return null
    },
    shown(_session: string, listed: readonly UiPart[], hosted?: boolean) {
      isHosted = hosted === true
      const next = new Map<string, string[]>()
      for (const { mod, id } of listed) next.set(mod, [...(next.get(mod) ?? []), id])
      const changed = [...new Set([...inApps.keys(), ...next.keys()])].filter((mod) => JSON.stringify(inApps.get(mod) ?? []) !== JSON.stringify(next.get(mod) ?? []))
      inApps = next
      for (const mod of changed) tellShown(mod)
      return null
    },
  }

  return {
    declared: () => [...declared.values()],
    providers: providersOf,
    stylers: () => providersOf(styleInterface),
    element,
    press,
    update,
    isHosted: () => isHosted,
    revealed,
    tell(mod, shown) {
      shownBy.set(mod, shown)
      tellShown(mod)
    },
    apply(listener) {
      applyTo = listener
    },
    onOpen(listener) {
      openIn = listener
    },
    onStart(listener) {
      started = listener
    },
    onDeclare(listener) {
      declaredChanged = listener
    },
    turnClosed(turn) {
      closedTurn = turn
      for (const { mod, widgets: listed } of declared.values()) for (const { id, areas } of listed) if (areas.includes(TurnEnd)) tellUi('Redraw', { mod, id })
    },
    ui,
  }
}
