import type { RenderElement } from 'claude-code'
import { Button, Text } from '../ui/elements.js'

export type FilledButton = {
  readonly key: string
  readonly label: string
  readonly hotkey?: string
  readonly variant?: 'primary' | 'secondary'
  readonly onPress: () => void
}

export function filledButton({ key, label, hotkey, variant = 'secondary', onPress }: FilledButton): RenderElement {
  const isPrimary = variant === 'primary'
  return Button({
    plain: true,
    key,
    label,
    ...(hotkey === undefined ? {} : { hotkey }),
    onPress,
    children: Text({ backgroundColor: isPrimary ? 'claude' : 'userMessageBackground', color: isPrimary ? 'inverseText' : 'text', bold: isPrimary, children: ` ${label} ` }),
  })
}
