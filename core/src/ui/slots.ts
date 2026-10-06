import type { Frozen, RenderComponent, RenderElement, RenderPropsOf } from 'claude-code'
import type { MarkdownKind } from './markdown.js'

declare const props: unique symbol

declare const defaultProps: unique symbol

type Place = { readonly component: RenderComponent } | { readonly markdown: MarkdownKind }

export type Slot<Props extends object = object, DefaultProps extends object = object, Where extends Place = Place> = Where & {
  readonly [props]: Props
  readonly [defaultProps]: DefaultProps
}

export type SlotProps<S extends Slot> = Frozen<S[typeof props]> & { readonly Default: (props: Frozen<S[typeof defaultProps]>) => RenderElement }

function slot<Component extends Exclude<RenderComponent, 'Pane'>>(component: Component): Slot<RenderPropsOf[Component], Partial<Omit<RenderPropsOf[Component], 'onScreen'>>, { readonly component: Component }> {
  return { component } as Slot<RenderPropsOf[Component], Partial<Omit<RenderPropsOf[Component], 'onScreen'>>, { readonly component: Component }>
}

export const slots = {
  AssistantMessage: slot('AssistantMessage'),
  UserMessage: slot('UserMessage'),
  ToolUse: slot('ToolUse'),
  ToolResult: slot('ToolResult'),
  ToolGroup: slot('ToolGroup'),
  ToolProgress: slot('ToolProgress'),
  CommandOutput: slot('CommandOutput'),
  AskUserQuestion: slot('AskUserQuestion'),
  InfoNotice: slot('InfoNotice'),
  Spinner: slot('Spinner'),
  TurnDuration: slot('TurnDuration'),
  SessionMode: slot('SessionMode'),
  PromptHint: slot('PromptHint'),
  AbovePrompt: slot('AbovePrompt'),
}
