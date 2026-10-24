import type { RenderElement } from 'claude-code'
import { isObject } from '../records.js'
import { Text } from '../ui/elements.js'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import { cmodPluginName } from './dependencies.js'
import type { DrawnParts } from './parts.js'
import type { Router } from './router.js'
import { partMethods, stalePress, type PageDeclaration, type PageRequest, type PartPress, type PartsUpdate, type ShownPages } from './ui.js'
import type { Widgets } from './widgets.js'

const askedWaitMs = 1000

export type ModPages = { readonly mod: string; readonly pages: readonly PageDeclaration[] }

export type PageApply = (mod: string, requests: readonly PageRequest[]) => Promise<void>

export type Pages = {
  declared(): readonly ModPages[]
  stylers(): readonly string[]
  element(mod: string, page: string, params: unknown, columns: number, isFocused: boolean): RenderElement | undefined
  press(mod: string, press: PartPress): void
  update(mod: string, update: PartsUpdate): boolean
  tell(mod: string, shown: ShownPages): void
  apply(listener: PageApply): void
}

export function pagesOf(input: unknown): PageDeclaration[] {
  const listed = isObject(input) && Array.isArray(input['pages']) ? (input['pages'] as unknown[]) : []
  return listed.filter(isObject).flatMap((each) => (typeof each['id'] === 'string' && typeof each['title'] === 'string' && (each['place'] === 'sidebar' || each['place'] === 'settings') ? [{ id: each['id'], title: each['title'], place: each['place'] }] : []))
}

export function servePages({
  claude,
  router,
  report,
  widgets,
  parts,
  tellStylers,
}: {
  readonly claude: Claude
  readonly router: Router
  readonly report: (id: string, message: string, error: unknown) => void
  readonly widgets: Pick<Widgets, 'update'>
  readonly parts: DrawnParts
  readonly tellStylers: (stylers: readonly string[]) => void
}): Pages {
  const declared = new Map<string, readonly PageDeclaration[]>()
  const stylers = new Set<string>()
  const asking = new Map<string, Promise<void>>()
  const pressing = new Set<Promise<void>>()
  let waiting: { readonly mod: string; readonly requests: readonly PageRequest[] }[] = []
  let inputDepth = 0
  let applyTo: PageApply = async () => undefined

  const run = (mod: string, requests: readonly PageRequest[]) =>
    applyTo(mod, requests).catch((error: unknown) => report(`pages:${mod}`, `Could not show the page ${mod} asked for`, error))

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

  const ask = (mod: string) => {
    const pending =
      asking.get(mod) ??
      claude.cmod
        .call({ to: mod, method: partMethods.list, input: null })
        .then(
          (parts) => void declared.set(mod, pagesOf(parts)),
          (error: unknown) => claude.ui.log(`cmod: ${mod} did not list its pages: ${messageOf(error)}`, { to: 'debug' }),
        )
        .finally(() => asking.delete(mod))
    asking.set(mod, pending)
    return pending
  }

  const restyle = (mod: string, isStyler: boolean) => {
    if (!isStyler && !stylers.delete(mod)) return
    if (isStyler) stylers.add(mod)
    parts.forget(mod)
    const listed = [...stylers]
    tellStylers(listed)
    for (const told of declared.keys()) {
      if (told !== cmodPluginName) void claude.cmod.call({ to: told, method: partMethods.stylers, input: listed }).catch((error: unknown) => claude.ui.log(`cmod: ${told} did not hear which mods style markdown: ${messageOf(error)}`, { to: 'debug' }))
    }
  }

  const update = (mod: string, { parts: listing, redraw, requests, isAsked }: PartsUpdate) => {
    if (listing !== undefined) declared.set(mod, pagesOf(listing))
    if (listing !== undefined) restyle(mod, isObject(listing) && listing['stylesMarkdown'] === true)
    const isRedrawn = redraw === true || requests?.some((request) => 'open' in request) === true
    if (listing !== undefined || isRedrawn) widgets.update(mod, { ...(listing === undefined ? {} : { parts: listing }), ...(isRedrawn ? { redraw: true } : {}) })
    if (requests === undefined || requests.length === 0) return false
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
          if (messageOf(error).includes(stalePress)) claude.ui.log(`cmod: ${mod} draws its page again, because the button pressed was from an older drawing:${messageOf(error)}`, { to: 'debug' })
          else report(`press:${mod}`, `${mod} did not take the press`, error)
        },
      )
      .finally(() => pressing.delete(pending))
    pressing.add(pending)
    if (inputDepth === 0) void pending.then(takeWaiting)
  }

  const lastDrawn = new Map<string, { readonly params: string; readonly cached: string }>()

  const plain = <Data,>(data: Data): Data => JSON.parse(JSON.stringify(data)) as Data

  return {
    declared: () => [...declared].map(([mod, pages]) => ({ mod, pages })),
    stylers: () => [...stylers],
    element(mod, page, params, columns, isFocused) {
      if (!declared.has(mod)) void ask(mod)
      const given = JSON.stringify(params ?? null)
      const cached = `${page}\u0000${given}\u0000${columns}\u0000${isFocused}`
      const name = `The ${page} page of ${mod}`
      const keyPrefix = `${mod}/${page}:`
      void parts.fill(mod, cached, { page, params: plain(params ?? null), columns, isFocused }, name)?.then(() => claude.ui.invalidate('ui.render'))
      const failure = parts.failure(mod, cached)
      const drawnAt = (key: string) => parts.element(mod, key, keyPrefix, name, `page:${mod}/${page}`)
      const last = lastDrawn.get(keyPrefix)
      const drawn = drawnAt(cached)
      if (drawn !== undefined) lastDrawn.set(keyPrefix, { params: given, cached })
      return drawn ?? (last?.params === given ? drawnAt(last.cached) : undefined) ?? (failure === undefined ? undefined : Text({ color: 'error', children: `${name} could not draw: ${failure}` }))
    },
    press,
    update,
    tell(mod, shown) {
      void claude.cmod.call({ to: mod, method: partMethods.shown, input: plain(shown) }).catch((error: unknown) => claude.ui.log(`cmod: ${mod} did not hear which of its pages show: ${messageOf(error)}`, { to: 'debug' }))
    },
    apply(listener) {
      applyTo = listener
    },
  }
}
