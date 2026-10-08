export type OptionKind = 'text' | 'secret' | 'number' | 'toggle' | 'choice' | 'folder' | 'file' | 'list'

export type OptionValue = string | number | boolean | readonly string[]

type Described = { readonly title: string; readonly description: string }

export type Option<Value extends OptionValue = OptionValue> = Described & {
  readonly kind: OptionKind
  readonly default?: Value
  readonly min?: number
  readonly max?: number
  readonly choices?: readonly string[]
}

export type Options = Readonly<Record<string, Option>>

export type OptionValues<Declared extends Options> = { readonly [Key in keyof Declared]: Declared[Key] extends Option<infer Value> ? Value : never }

export type UserConfigField = Described & {
  readonly type: 'string' | 'number' | 'boolean' | 'directory' | 'file'
  readonly sensitive?: true
  readonly multiple?: true
  readonly default?: OptionValue
  readonly min?: number
  readonly max?: number
  readonly options?: readonly string[]
}

export const option = {
  text: (field: Described & { readonly default?: string }): Option<string> => ({ ...field, kind: 'text' }),
  secret: (field: Described): Option<string> => ({ ...field, kind: 'secret' }),
  number: (field: Described & { readonly default?: number; readonly min?: number; readonly max?: number }): Option<number> => ({ ...field, kind: 'number' }),
  toggle: (field: Described & { readonly default?: boolean }): Option<boolean> => ({ ...field, kind: 'toggle', default: field.default ?? false }),
  choice: <const Choice extends string>(choices: readonly Choice[], field: Described & { readonly default?: Choice }): Option<Choice> => ({ ...field, kind: 'choice', choices }),
  folder: (field: Described & { readonly default?: string }): Option<string> => ({ ...field, kind: 'folder' }),
  file: (field: Described & { readonly default?: string }): Option<string> => ({ ...field, kind: 'file' }),
  list: (field: Described & { readonly default?: readonly string[] }): Option<readonly string[]> => ({ ...field, kind: 'list' }),
}

const types: Readonly<Record<OptionKind, UserConfigField['type']>> = { text: 'string', secret: 'string', number: 'number', toggle: 'boolean', choice: 'string', folder: 'directory', file: 'file', list: 'string' }

const optionKey = /^[A-Za-z_]\w*$/

export function checkOptions(name: string, options: Options): Options {
  for (const [key, declared] of Object.entries(options)) {
    const at = `${name}: options.${key}`
    if (!optionKey.test(key)) throw new Error(`${at} is not an option name. Use letters, digits, and _, starting with a letter, as Claude Code passes each option on as CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}.`)
    if (declared.title.trim() === '') throw new Error(`${at} needs a title, the label /config shows.`)
    if (declared.kind === 'choice' && (declared.choices ?? []).length === 0) throw new Error(`${at} is a choice with no choices. Give option.choice(['a', 'b'], { ... }).`)
    if (declared.kind === 'choice' && declared.default !== undefined && !(declared.choices ?? []).includes(declared.default as string)) throw new Error(`${at} defaults to ${String(declared.default)}, which is not one of its choices: ${(declared.choices ?? []).join(', ')}.`)
  }
  return options
}

export function userConfigOf(options: Options): Record<string, UserConfigField> {
  return Object.fromEntries(
    Object.entries(options).map(([key, declared]) => [
      key,
      {
        type: types[declared.kind],
        title: declared.title,
        description: declared.description,
        ...(declared.kind === 'secret' ? { sensitive: true } : {}),
        ...(declared.kind === 'list' ? { multiple: true } : {}),
        ...(declared.kind === 'choice' ? { options: declared.choices } : {}),
        ...(declared.default === undefined ? {} : { default: declared.default }),
        ...(declared.min === undefined ? {} : { min: declared.min }),
        ...(declared.max === undefined ? {} : { max: declared.max }),
      } satisfies UserConfigField,
    ]),
  )
}

export function isUnset(value: unknown): boolean {
  return value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
}

export function fitsOption(declared: Option, value: unknown): string | undefined {
  const kind = declared.kind
  if (kind === 'toggle') return typeof value === 'boolean' ? undefined : 'takes true or false'
  if (kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'takes a number'
    if (declared.min !== undefined && value < declared.min) return `takes ${declared.min} or more`
    if (declared.max !== undefined && value > declared.max) return `takes ${declared.max} or less`
    return undefined
  }
  if (kind === 'list') return Array.isArray(value) && value.every((item) => typeof item === 'string') ? undefined : 'takes a list of text'
  if (typeof value !== 'string') return 'takes text'
  if (kind === 'choice' && !(declared.choices ?? []).includes(value)) return `takes one of: ${(declared.choices ?? []).join(', ')}`
  return undefined
}
