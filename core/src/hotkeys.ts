import type { Subscription } from './utils/subscription.js'

type Letter = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm' | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z'

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'

type Named = 'tab' | 'enter' | 'escape' | 'space' | 'backspace' | 'delete' | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown' | 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'f9' | 'f10' | 'f11' | 'f12'

type Mark = '`' | '-' | '=' | '[' | ']' | '\\' | ';' | "'" | ',' | '.' | '/'

export type Key = Letter | Digit | Named | Mark

type Modifiers = 'ctrl' | 'alt' | 'shift' | 'meta' | 'ctrl+alt' | 'ctrl+shift' | 'ctrl+meta' | 'alt+shift' | 'alt+meta' | 'shift+meta'

export type Combo = `${Modifiers}+${Key}`

export type HotkeyInit = { readonly title: string; readonly default?: Combo }

export type Hotkeys = Readonly<Record<string, HotkeyInit>>

export type Hotkey = {
  readonly title: string
  readonly combo: Combo | undefined
  onPress(listener: () => unknown): Subscription
}

const hotkeyName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

const comboShape = /^(?:(?:ctrl|alt|shift|meta)\+){1,2}(?:[a-z0-9]|f(?:[1-9]|1[0-2])|tab|enter|escape|space|backspace|delete|up|down|left|right|home|end|pageup|pagedown|[`\-=[\]\\;',./])$/

const order = ['ctrl', 'alt', 'shift', 'meta']

export function isCombo(value: unknown): value is Combo {
  if (typeof value !== 'string' || !comboShape.test(value)) return false
  const modifiers = value.split('+').slice(0, -1)
  return modifiers.every((each, index) => index === 0 || order.indexOf(each) > order.indexOf(modifiers[index - 1] as string))
}

export function checkHotkeys(name: string, hotkeys: Hotkeys): Hotkeys {
  const combos = new Map<string, string>()
  for (const [key, declared] of Object.entries(hotkeys)) {
    const at = `${name}: hotkeys.${key}`
    if (!hotkeyName.test(key)) throw new Error(`${at} is not a hotkey name. Use letters, digits, and _, starting with a letter.`)
    if (declared.title.trim() === '') throw new Error(`${at} needs a title, the label Settings shows beside its combo.`)
    if (declared.default === undefined) continue
    if (!isCombo(declared.default)) throw new Error(`${at} defaults to "${String(declared.default)}", which is not a combo. Give one or two of ctrl, alt, shift, meta in that order, then a key, such as "ctrl+q" or "ctrl+shift+k".`)
    const taken = combos.get(declared.default)
    if (taken !== undefined) throw new Error(`${at} defaults to ${declared.default}, which hotkeys.${taken} has too. Give each hotkey its own combo.`)
    combos.set(declared.default, key)
  }
  return hotkeys
}
