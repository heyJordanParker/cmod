import type { Frozen, PaneCloseInput, RenderPropsOf, UiScrollInput } from 'claude-code'
import type { Mod, Surface } from '../mod.js'

export type PaneScroll = Frozen<UiScrollInput>

export type PaneClose = Frozen<PaneCloseInput>

export type ScrollTarget = 'start' | 'end' | { readonly key: string }

export type ScrollOptions = { readonly block?: 'start' | 'center' | 'end' | 'nearest' }

export type OpenOptions<Params> = { readonly focus?: true } & (undefined extends Params ? { readonly params?: Params } : { readonly params: Params })

export type PaneProps<Params> = Frozen<RenderPropsOf['Pane']> & { readonly surface: Surface; readonly params: Params }

export type PaneInit<State extends object = Record<never, never>, Params = undefined> = {
  readonly id: string
  readonly title: string
  readonly columns?: number | ((state: State) => number | undefined)
  readonly rows?: number | ((state: State) => number | undefined)
  readonly closeOnEscape?: true
  readonly holdToasts?: true
  render(mod: Mod<State>, props: PaneProps<Params>): JSX.Element
  onScroll?(mod: Mod<State>, scroll: PaneScroll): void | Promise<void>
  onClose?(mod: Mod<State>, close: PaneClose): void | Promise<void>
}

export type Pane<Params = undefined> = {
  readonly id: string
  readonly isOpen: boolean
  readonly isShown: boolean
  readonly isFocused: boolean
  readonly params: Params | undefined
  open(...options: undefined extends Params ? [options?: OpenOptions<Params>] : [options: OpenOptions<Params>]): Promise<void>
  toggle(options?: { readonly focus?: true }): Promise<void>
  close(): Promise<void>
  scrollTo(target: ScrollTarget, options?: ScrollOptions): Promise<void>
  focus(key: string): Promise<void>
  remove(): void
}

export type ViewProps<Params> = { readonly params: Params; readonly isFocused: boolean; readonly columns: number; readonly surface: Surface }

export type ViewInit<State extends object = Record<never, never>, Params = undefined> = {
  readonly id: string
  readonly title: string
  render(mod: Mod<State>, props: ViewProps<Params>): JSX.Element
}

export type View<Params = undefined> = {
  readonly id: string
  readonly isOpen: boolean
  readonly isShown: boolean
  readonly isFocused: boolean
  readonly params: Params | undefined
  open(...options: undefined extends Params ? [options?: OpenOptions<Params>] : [options: OpenOptions<Params>]): Promise<void>
  toggle(options?: { readonly focus?: true }): Promise<void>
  close(): Promise<void>
  scrollTo(target: ScrollTarget, options?: ScrollOptions): Promise<void>
  focus(key: string): Promise<void>
  remove(): void
}

export type PageProps<Params> = ViewProps<Params>

export type PageInit<State extends object = Record<never, never>, Params = undefined> = ViewInit<State, Params>

export type Page<Params = undefined> = View<Params>

const partId = /^[A-Za-z0-9_-]{1,64}$/

export const sizeKeys = ['columns', 'rows'] as const

export function checkPart(name: string, kind: string, id: string, title: string, takenBy: string | undefined): void {
  if (!partId.test(id)) throw new Error(`${name}: "${id}" is not a ${kind} id. Use 1 to 64 letters, digits, "_", or "-".`)
  if (title.trim() === '') throw new Error(`${name}: the ${kind} "${id}" needs a title, the label its tab shows.`)
  if (takenBy !== undefined) throw new Error(`${name}: the ${takenBy} "${id}" is already added. Give the ${kind} another id.`)
}

export function checkPane<State extends object, Params>(name: string, pane: PaneInit<State, Params>, takenBy: string | undefined): void {
  checkPart(name, 'pane', pane.id, pane.title, takenBy)
  for (const key of sizeKeys) {
    const size = pane[key]
    if (typeof size !== 'function' && size !== undefined && (!Number.isInteger(size) || size <= 0)) throw new Error(`${name}: the pane "${pane.id}" has ${key} ${size}. Use a whole number above 0, or leave it out.`)
  }
}
