export type Matcher<Value> = Value extends string
  ? string | RegExp
  : Value extends number | boolean | null | undefined
    ? Value
    : Value extends readonly (infer Item)[]
      ? Matcher<Item>
      : Value extends (...args: never[]) => unknown
        ? never
        : Value extends object
          ? { readonly [Key in keyof Value]?: Matcher<Value[Key]> }
          : Value

export type SentMatcher = string | number | boolean | null | { readonly regexp: string; readonly flags: string } | { readonly [key: string]: SentMatcher } | readonly SentMatcher[]

export function matches(value: unknown, matcher: unknown): boolean {
  if (matcher instanceof RegExp) return value !== undefined && value !== null && matcher.test(String(value))
  if (Array.isArray(matcher)) return matcher.some((each) => matches(value, each))
  if (typeof matcher !== 'object' || matcher === null) return value === matcher
  if (Array.isArray(value)) return value.some((each) => matches(each, matcher))
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(matcher).every(([key, wanted]) => wanted === undefined || matches((value as Record<string, unknown>)[key], wanted))
}

export function sentMatcher(matcher: unknown): SentMatcher {
  if (matcher instanceof RegExp) return { regexp: matcher.source, flags: matcher.flags }
  if (Array.isArray(matcher)) return matcher.map(sentMatcher)
  if (typeof matcher !== 'object' || matcher === null) return matcher as SentMatcher
  return Object.fromEntries(Object.entries(matcher).filter(([, value]) => value !== undefined).map(([key, value]) => [key, sentMatcher(value)]))
}

export function receivedMatcher(sent: SentMatcher): unknown {
  if (Array.isArray(sent)) return sent.map(receivedMatcher)
  if (typeof sent !== 'object' || sent === null) return sent
  const fields = sent as Readonly<Record<string, unknown>>
  if (typeof fields['regexp'] === 'string' && typeof fields['flags'] === 'string' && Object.keys(fields).length === 2) return new RegExp(fields['regexp'], fields['flags'])
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, receivedMatcher(value as SentMatcher)]))
}
