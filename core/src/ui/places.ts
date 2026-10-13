import type { Frozen, RenderComponent, RenderElement, RenderPropsOf } from 'claude-code'
import type { BlockProps, MarkdownPlace } from './markdown.js'

export const ToolGroup = 'toolGroup'
export const ToolProgress = 'toolProgress'
export const CommandOutput = 'commandOutput'
export const AskUserQuestion = 'askUserQuestion'
export const Spinner = 'spinner'
export const TurnDuration = 'turnDuration'
export const SessionMode = 'sessionMode'
export const PromptHint = 'promptHint'
export const AbovePrompt = 'abovePrompt'

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
  [Spinner]: 'Spinner',
  [TurnDuration]: 'TurnDuration',
  [SessionMode]: 'SessionMode',
  [PromptHint]: 'PromptHint',
  [AbovePrompt]: 'AbovePrompt',
} as const satisfies Readonly<Record<string, Exclude<RenderComponent, 'Pane'>>>

export type ComponentPlace = keyof typeof components

export type Place = ComponentPlace | MarkdownPlace

type ComponentProps = { readonly [P in ComponentPlace]: RenderPropsOf[(typeof components)[P]] }

type PropsOf<P extends Place> = P extends ComponentPlace ? ComponentProps[P] : P extends MarkdownPlace<infer Type> ? BlockProps<Type> : never

type DefaultOf<P extends Place> = P extends ComponentPlace ? Partial<Omit<ComponentProps[P], 'onScreen'>> : { readonly source?: string }

export type PlaceProps<P extends Place> = Frozen<PropsOf<P>> & { readonly Default: (props: Frozen<DefaultOf<P>>) => RenderElement }

export function componentOf(place: Place): Exclude<RenderComponent, 'Pane'> | undefined {
  return typeof place === 'string' && Object.hasOwn(components, place) ? components[place] : undefined
}

export function nameOf(place: Place): string {
  return typeof place === 'string' ? `${place.charAt(0).toUpperCase()}${place.slice(1)}` : place.name
}
