import type { RenderElement } from 'claude-code'
import type { Mod, Turn } from '../mod.js'

export const AbovePrompt = 'abovePrompt'
export const BelowPrompt = 'belowPrompt'
export const Working = 'working'
export const TurnEnd = 'turnEnd'
export const Dashboard = 'dashboard'

export const areas = [AbovePrompt, BelowPrompt, Working, TurnEnd, Dashboard] as const

export type Area = (typeof areas)[number]

export type WidgetContext = { readonly area: typeof TurnEnd; readonly columns: number; readonly turn: Turn } | { readonly area: Exclude<Area, typeof TurnEnd>; readonly columns: number }

export type WidgetInit<State extends object = Record<never, never>> = {
  readonly id: string
  readonly title: string
  readonly areas: readonly [Area, ...Area[]]
  readonly place?: { readonly side?: 'left' | 'right'; readonly size?: 'fit' | 'fill' }
  render(mod: Mod<State>, context: WidgetContext): RenderElement | undefined
}

export type Widget = {
  readonly id: string
  readonly area: Area | undefined
  remove(): void
}
