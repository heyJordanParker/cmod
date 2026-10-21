import type { RenderElement } from 'claude-code'
import { isObject } from '../records.js'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import type { DrawnParts } from './parts.js'
import type { Router } from './router.js'
import { partMethods, type PageDeclaration, type PageRequest, type PartPress, type PartsUpdate, type ShownPages } from './ui.js'
import type { Widgets } from './widgets.js'

const askedWaitMs = 1000

export type ModPages = { readonly mod: string; readonly pages: readonly PageDeclaration[] }

export type PageApply = (mod: string, requests: readonly PageRequest[]) => Promise<void>

export type Pages = {
  declared(): readonly ModPages[]
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

export function servePages({ claude, router, report, widgets, parts }: { readonly claude: Claude; readonly router: Router; readonly report: (id: string, message: string, error: unknown) => void; readonly widgets: Pick<Widgets, 'update'>; readonly parts: DrawnParts }): Pages {
  const declared = new Map<string, readonly PageDeclaration[]>()
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

  const settle = async () => {
    while (pressing.size > 0) await Promise.allSettled(pressing)
    await takeWaiting()
  }

  const wrapped = async <Answer>(next: () => Promise<Answer>): Promise<Answer> => {
    inputDepth += 1
    try {
      const answer = await next()
      await settle()
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

  const update = (mod: string, { parts: listing, redraw, requests, isAsked }: PartsUpdate) => {
    if (listing !== undefined) declared.set(mod, pagesOf(listing))
    if (listing !== undefined || redraw === true) widgets.update(mod, { ...(listing === undefined ? {} : { parts: listing }), ...(redraw === undefined ? {} : { redraw }) })
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
          report(`press:${mod}`, `${mod} did not take the press`, error)
        },
      )
      .finally(() => pressing.delete(pending))
    pressing.add(pending)
    if (inputDepth === 0) void pending.then(takeWaiting)
  }

  const cacheKey = (page: string, params: unknown, columns: number, isFocused: boolean) => `${page}\u0000${JSON.stringify(params ?? null)}\u0000${columns}\u0000${isFocused}`

  return {
    declared: () => [...declared].map(([mod, pages]) => ({ mod, pages })),
    element(mod, page, params, columns, isFocused) {
      if (!declared.has(mod)) void ask(mod)
      const cached = cacheKey(page, params, columns, isFocused)
      const name = `The ${page} page of ${mod}`
      void parts.fill(mod, cached, { page, params: params ?? null, columns, isFocused }, name)?.then(() => claude.ui.invalidate('ui.render'))
      return parts.element(mod, cached, `${mod}/${page}:`, name, `page:${mod}/${page}`)
    },
    press,
    update,
    tell(mod, shown) {
      void claude.cmod.call({ to: mod, method: partMethods.shown, input: shown }).catch((error: unknown) => claude.ui.log(`cmod: ${mod} did not hear which of its pages show: ${messageOf(error)}`, { to: 'debug' }))
    },
    apply(listener) {
      applyTo = listener
    },
  }
}
