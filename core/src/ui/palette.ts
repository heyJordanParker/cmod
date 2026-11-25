import type { Color } from './elements.js'

export type Palette = {
  readonly foreground: Color
  readonly background: Color
  readonly mutedForeground: Color
  readonly border: Color
  readonly input: Color
  readonly primary: Color
  readonly accent: Color
  readonly info: Color
  readonly success: Color
  readonly warning: Color
  readonly destructive: Color
}

export const themePalette: Palette = {
  foreground: 'text',
  background: 'inverseText',
  mutedForeground: 'inactive',
  border: 'subtle',
  input: 'promptBorder',
  primary: 'claude',
  accent: 'userMessageBackground',
  info: 'suggestion',
  success: 'success',
  warning: 'warning',
  destructive: 'error',
}

const ansiPalettes: Readonly<Record<string, Palette>> = {
  'dark-ansi': { ...themePalette, mutedForeground: 'ansi:whiteBright', input: 'ansi:white', border: 'ansi:blackBright' },
  'light-ansi': { ...themePalette, mutedForeground: 'ansi:black', input: 'ansi:blackBright', border: 'ansi:white' },
}

export function paletteOf(theme: string): Palette {
  return ansiPalettes[theme] ?? themePalette
}
