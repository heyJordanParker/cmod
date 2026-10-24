import type { Frozen, RenderComponent, RenderElement, RenderPropsOf } from 'claude-code'
import type { Mod, Surface } from '../mod.js'
import { TurnEnd, Working } from './areas.js'
import type { Block, BlockProps } from './markdown.js'

export const ToolGroup = 'toolGroup'
export const ToolProgress = 'toolProgress'
export const CommandOutput = 'commandOutput'
export const AskUserQuestion = 'askUserQuestion'

const components = {
  prompt: 'UserMessage',
  reply: 'AssistantMessage',
  toolCall: 'ToolUse',
  toolResult: 'ToolResult',
  notice: 'InfoNotice',
  [ToolGroup]: 'ToolGroup',
  [ToolProgress]: 'ToolProgress',
  [CommandOutput]: 'CommandOutput',
  [AskUserQuestion]: 'AskUserQuestion',
  [Working]: 'Spinner',
  [TurnEnd]: 'TurnDuration',
} as const satisfies Readonly<Record<string, Exclude<RenderComponent, 'Pane'>>>

export type Row = keyof typeof components

export type Kind = Row | Block

type RowProps = { readonly [R in Row]: RenderPropsOf[(typeof components)[R]] }

type PropsOf<K extends Kind> = K extends Row ? RowProps[K] : K extends Block<infer Type> ? BlockProps<Type> : never

type DefaultOf<K extends Kind> = K extends Row ? Partial<Omit<RowProps[K], 'onScreen'>> : { readonly source?: string }

export type StyleProps<K extends Kind> = Frozen<PropsOf<K>> & StyledAt & (K extends Row ? { readonly id: string } : { readonly id?: string }) & { readonly Default: (props: Frozen<DefaultOf<K>>) => RenderElement }

export type KindProps<K extends Kind> = Omit<StyleProps<K>, 'Default' | 'surface' | 'columns' | 'id'>

export type StyledAt = { readonly surface: Surface; readonly columns: number }

export type StyleInit<K extends Kind, State extends object = Record<never, never>> = {
  readonly kind: K
  render(mod: Mod<State>, props: StyleProps<K>): RenderElement
}

export type Style = {
  readonly kind: Kind
  remove(): void
}

export function componentOf(kind: Kind): Exclude<RenderComponent, 'Pane'> | undefined {
  return typeof kind === 'string' && Object.hasOwn(components, kind) ? components[kind] : undefined
}

export function nameOf(kind: Kind): string {
  return typeof kind === 'string' ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}` : kind.name
}
