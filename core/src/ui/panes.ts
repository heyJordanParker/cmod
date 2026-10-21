import type { Frozen, PaneCloseInput, RenderElement, RenderPropsOf, UiScrollInput } from 'claude-code'
import type { Mod } from '../mod.js'

export type ScrollTarget = 'start' | 'end' | { readonly key: string }

export type ScrollOptions = { readonly block?: 'start' | 'center' | 'end' | 'nearest' }

export type OpenOptions<Params> = { readonly focus?: true } & (undefined extends Params ? { readonly params?: Params } : { readonly params: Params })

export type PaneProps<Params> = Frozen<RenderPropsOf['Pane']> & { readonly params: Params }

export type PaneInit<State extends object = Record<never, never>, Params = undefined> = {
  readonly id: string
  readonly title: string
  readonly columns?: number | ((state: State) => number | undefined)
  readonly rows?: number | ((state: State) => number | undefined)
  readonly closeOnEscape?: true
  readonly holdToasts?: true
  render(mod: Mod<State>, props: PaneProps<Params>): RenderElement
  onScroll?(mod: Mod<State>, e: Frozen<UiScrollInput>): void | Promise<void>
  onClose?(mod: Mod<State>, e: Frozen<PaneCloseInput>): void | Promise<void>
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
  remove(): void
}

export type PageProps<Params> = { readonly params: Params; readonly isFocused: boolean; readonly columns: number }

export type PageInit<State extends object = Record<never, never>, Params = undefined> = {
  readonly id: string
  readonly title: string
  render(mod: Mod<State>, props: PageProps<Params>): RenderElement
}

export type Page<Params = undefined> = {
  readonly id: string
  readonly isOpen: boolean
  readonly isShown: boolean
  readonly isFocused: boolean
  readonly params: Params | undefined
  open(...options: undefined extends Params ? [options?: OpenOptions<Params>] : [options: OpenOptions<Params>]): Promise<void>
  toggle(options?: { readonly focus?: true }): Promise<void>
  close(): Promise<void>
  scrollTo(target: ScrollTarget, options?: ScrollOptions): Promise<void>
  remove(): void
}

const partId = /^[A-Za-z0-9_-]{1,64}$/

export const sizeKeys = ['columns', 'rows'] as const

export function checkPart(name: string, kind: string, id: string, title: string): void {
  if (!partId.test(id)) throw new Error(`${name}: "${id}" is not a ${kind} id. Use 1 to 64 letters, digits, "_", or "-".`)
  if (title.trim() === '') throw new Error(`${name}: the ${kind} "${id}" needs a title, the label its tab shows.`)
}

export function checkPane<State extends object, Params>(name: string, pane: PaneInit<State, Params>): void {
  checkPart(name, 'pane', pane.id, pane.title)
  for (const key of sizeKeys) {
    const size = pane[key]
    if (typeof size !== 'function' && size !== undefined && (!Number.isInteger(size) || size <= 0)) throw new Error(`${name}: the pane "${pane.id}" has ${key} ${size}. Use a whole number above 0, or leave it out.`)
  }
}
