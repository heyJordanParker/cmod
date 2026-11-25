export type DrawnNode = { readonly type: string; readonly key: unknown; readonly hover: unknown; readonly children: readonly unknown[] }

const oncePerKey: ReadonlySet<string> = new Set(['Input', 'Select', 'Markdown', 'Client', 'Raster', 'Image'])

export function refusal(tree: unknown, inside: (node: unknown) => DrawnNode | undefined): string | undefined {
  const seen = new Set<string>()
  for (const { type, key } of nodesIn(tree, inside)) {
    if (!oncePerKey.has(type) || typeof key !== 'string') continue
    if (seen.has(`${type}\u0000${key}`)) return `${type} "${key}" is drawn twice; each takes its own key`
    seen.add(`${type}\u0000${key}`)
  }
  const [hovering] = hoversOutsideKeys(tree, inside, false)
  if (hovering === undefined) return undefined
  return `${hovering.type}${typeof hovering.key === 'string' ? ` "${hovering.key}"` : ''} hover has no Box with a key around it; the nearest keyed Box is what the pointer hovers, or a scope names its group`
}

export function insideData(node: unknown): DrawnNode | undefined {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined
  const { $cmodElement: type, props } = node as Readonly<Record<string, unknown>>
  if (typeof type !== 'string') return undefined
  const fields = typeof props === 'object' && props !== null ? (props as Readonly<Record<string, unknown>>) : {}
  return { type, key: fields['key'], hover: fields['hover'], children: [fields['children']].flat(Number.POSITIVE_INFINITY) }
}

function* nodesIn(node: unknown, inside: (node: unknown) => DrawnNode | undefined): Generator<DrawnNode> {
  for (const each of [node].flat(Number.POSITIVE_INFINITY)) {
    const drawn = inside(each)
    if (drawn === undefined) continue
    yield drawn
    for (const child of drawn.children) yield* nodesIn(child, inside)
  }
}

function* hoversOutsideKeys(node: unknown, inside: (node: unknown) => DrawnNode | undefined, isInKeyedBox: boolean): Generator<DrawnNode> {
  for (const each of [node].flat(Number.POSITIVE_INFINITY)) {
    const drawn = inside(each)
    if (drawn === undefined) continue
    const isKeyed = isInKeyedBox || (drawn.type === 'Box' && typeof drawn.key === 'string')
    if (typeof drawn.hover === 'object' && drawn.hover !== null && !('scope' in drawn.hover) && !isKeyed) yield drawn
    for (const child of drawn.children) yield* hoversOutsideKeys(child, inside, isKeyed)
  }
}
