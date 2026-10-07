import type { Frozen, PaneCloseInput, RenderElement, RenderPropsOf, UiScrollInput } from 'claude-code'
import type { Mod } from '../mod.js'

export type Pane<State extends object = Record<never, never>> = {
  readonly id: string
  readonly title: string
  readonly columns?: number | ((state: State) => number | undefined)
  readonly rows?: number | ((state: State) => number | undefined)
  readonly closeOnEscape?: true
  readonly holdToasts?: true
  render(mod: Mod<State>, props: Frozen<RenderPropsOf['Pane']>): RenderElement
  onScroll?(mod: Mod<State>, e: Frozen<UiScrollInput>): void | Promise<void>
  onClose?(mod: Mod<State>, e: Frozen<PaneCloseInput>): void | Promise<void>
}

const paneId = /^[A-Za-z0-9_-]{1,64}$/

const sizeKeys = ['columns', 'rows'] as const

export function definePane<State extends object = Record<never, never>>(pane: Pane<State>): Pane<State> {
  if (!paneId.test(pane.id)) throw new Error(`definePane: "${pane.id}" is not a pane id. Use 1 to 64 letters, digits, "_", or "-".`)
  for (const key of sizeKeys) {
    const size = pane[key]
    if (typeof size !== 'function' && size !== undefined && (!Number.isInteger(size) || size <= 0)) throw new Error(`definePane: the pane "${pane.id}" has ${key} ${size}. Use a whole number above 0, or leave it out.`)
  }
  return pane
}
