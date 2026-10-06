import type { ElementTable, RenderElement, RenderNode } from 'claude-code'

type Drawn = { readonly type: string; readonly props: Record<string, unknown>; readonly children?: readonly RenderNode[] }

type Button = { readonly type: 'Button'; readonly props: { readonly key: string; readonly label: string; readonly onPress: () => unknown } }

const boxInsides = new WeakMap<object, Drawn>()

function element(type: string) {
  return (props: Record<string, unknown>): RenderElement => {
    const { children, ...rest } = props
    const flat = flatten(children)
    const keyed = type === 'Button' ? { key: rest['label'] ?? flat.map(textOf).join(''), ...rest } : rest
    const drawn: Drawn = { type, props: keyed, ...(flat.length === 0 ? {} : { children: flat }) }
    if (type !== 'Box') return drawn as unknown as RenderElement
    const box = Object.freeze({})
    boxInsides.set(box, drawn)
    return box as unknown as RenderElement
  }
}

export const elements = {
  Box: element('Box'),
  Text: element('Text'),
  Button: element('Button'),
  Link: element('Link'),
  Code: element('Code'),
  Markdown: element('Markdown'),
  Input: element('Input'),
  Select: element('Select'),
  Image: element('Image'),
} as unknown as ElementTable

export function findButton(node: RenderNode, key: string): Button | undefined {
  if (typeof node === 'string') return undefined
  const { type, props, children = [] } = insideOf(node)
  if (type === 'Button' && (props['key'] === key || props['label'] === key)) return node as unknown as Button
  for (const child of children) {
    const found = findButton(child, key)
    if (found !== undefined) return found
  }
  return undefined
}

export function rowsOf(node: RenderNode, width: number): string[] {
  if (typeof node !== 'string' && insideOf(node).type === 'Box') return boxRows(insideOf(node), width)
  const wrap = typeof node === 'string' ? undefined : insideOf(node).props['wrap']
  return textOf(node)
    .split('\n')
    .flatMap((line) => fitted(line, width, wrap))
}

export function textOf(node: RenderNode): string {
  if (typeof node === 'string') return node
  const { type, props, children = [] } = insideOf(node)
  const inner = children.map(textOf).join('')
  if (type === 'Box') return rowsOf(node, Number.POSITIVE_INFINITY).join('\n')
  if (type === 'Button') return String(props['label'] ?? inner)
  if (type === 'Link') return inner === '' ? String(props['label'] ?? props['href']) : inner
  if (type === 'Code') return String(props['source'])
  if (type === 'Markdown') return String(props['text'])
  if (type === 'Image') return String(props['alt'])
  if (type === 'Input') return [props['label'], props['value'] ?? props['placeholder']].filter((part) => part !== undefined).join(' ')
  if (type === 'Select') {
    const options = props['options'] as readonly { readonly value: string; readonly label?: string }[]
    const selected = options.find((option) => option.value === props['value']) ?? options[0]
    return [props['label'], selected?.label ?? selected?.value].filter((part) => part !== undefined).join(' ')
  }
  return inner
}

function insideOf(node: RenderElement): Drawn {
  const drawn = boxInsides.get(node) ?? (node as unknown as Partial<Drawn>)
  return { type: String(drawn.type), props: drawn.props ?? {}, ...(drawn.children === undefined ? {} : { children: drawn.children }) }
}

function flatten(children: unknown): RenderNode[] {
  if (children === undefined || children === null || children === false || children === true) return []
  if (Array.isArray(children)) return children.flatMap(flatten)
  if (typeof children === 'number') return [String(children)]
  return [children as RenderNode]
}

function boxRows({ props, children = [] }: Drawn, width: number): string[] {
  if (props['display'] === 'none') return []
  const size = (key: string) => (typeof props[key] === 'number' ? props[key] : undefined)
  const space = (side: string, axis: string) => (size(`padding${side}`) ?? size(`padding${axis}`) ?? size('padding') ?? 0) + (size(`margin${side}`) ?? size(`margin${axis}`) ?? size('margin') ?? 0)
  const left = space('Left', 'X')
  const direction = String(props['flexDirection'] ?? 'row')
  const ordered = direction.endsWith('-reverse') ? [...children].reverse() : children
  const inner = width - left - space('Right', 'X')
  const rows = direction.startsWith('column') ? stacked(ordered, inner, size('rowGap') ?? size('gap') ?? 0) : sideBySide(ordered, inner, size('columnGap') ?? size('gap') ?? 0)
  return [...blankRows(space('Top', 'Y')), ...rows.map((row) => paddedTo(`${' '.repeat(left)}${row}`, size('minWidth') ?? 0)), ...blankRows(space('Bottom', 'Y'))]
}

function stacked(children: readonly RenderNode[], width: number, gap: number): string[] {
  const blocks = children.map((child) => rowsOf(child, width)).filter((block) => block.length > 0)
  return blocks.flatMap((block, index) => [...blankRows(index === 0 ? 0 : gap), ...block])
}

function sideBySide(children: readonly RenderNode[], width: number, gap: number): string[] {
  const laid = children
    .map((child) => ({ child, natural: rowsOf(child, Number.POSITIVE_INFINITY) }))
    .filter(({ natural }) => natural.length > 0)
    .map(({ child, natural }) => ({ child, natural, canShrink: widthOf(natural) > minWidthOf(child) }))
  const overflow = laid.reduce((sum, { natural }) => sum + widthOf(natural), 0) + gap * Math.max(laid.length - 1, 0) - width
  const total = laid.reduce((sum, { natural, canShrink }) => (canShrink ? sum + widthOf(natural) : sum), 0)
  const blocks = laid.map(({ child, natural, canShrink }) => (overflow <= 0 || !canShrink || total === 0 ? natural : rowsOf(child, widthOf(natural) - Math.ceil((overflow * widthOf(natural)) / total))))
  const height = Math.max(0, ...blocks.map((block) => block.length))
  const columns = blocks.map(widthOf)
  return Array.from({ length: height }, (_, row) => blocks.map((block, index) => paddedTo(block[row] ?? '', index === blocks.length - 1 ? 0 : (columns[index] ?? 0))).join(' '.repeat(gap)))
}

function minWidthOf(node: RenderNode): number {
  if (typeof node === 'string') return 0
  const minWidth = insideOf(node).props['minWidth']
  return typeof minWidth === 'number' ? minWidth : 0
}

function blankRows(count: number): string[] {
  return Array.from({ length: count }, () => '')
}

function fitted(line: string, width: number, wrap: unknown): string[] {
  const cells = [...line]
  if (cells.length <= width) return [line]
  const room = Math.max(width, 1)
  if (wrap === 'truncate' || wrap === 'truncate-end' || wrap === 'end') return [`${cells.slice(0, room - 1).join('')}…`]
  if (wrap === 'truncate-start') return [`…${cells.slice(cells.length - room + 1).join('')}`]
  if (wrap === 'truncate-middle' || wrap === 'middle') {
    const head = Math.ceil((room - 1) / 2)
    return [`${cells.slice(0, head).join('')}…${cells.slice(cells.length - (room - 1 - head)).join('')}`]
  }
  return wrapped(line, room)
}

function wrapped(line: string, width: number): string[] {
  const rows: string[] = []
  let row: string | undefined
  for (const word of line.split(' ')) {
    const joined = row === undefined ? word : `${row} ${word}`
    if ([...joined].length <= width) {
      row = joined
      continue
    }
    if (row !== undefined) rows.push(row)
    let rest = [...word]
    while (rest.length > width) {
      rows.push(rest.slice(0, width).join(''))
      rest = rest.slice(width)
    }
    row = rest.join('')
  }
  return row === undefined ? rows : [...rows, row]
}

function widthOf(rows: readonly string[]): number {
  return Math.max(0, ...rows.map((row) => [...row].length))
}

function paddedTo(text: string, columns: number): string {
  return `${text}${' '.repeat(Math.max(columns - [...text].length, 0))}`
}
