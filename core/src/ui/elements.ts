import type { ElementName, ElementTable, Elements, MarkdownProps, RenderElement } from 'claude-code'

type Terminal = Elements['terminal']

type CompletedTable = Record<ElementName, (props: object) => RenderElement>

type Drawing = { readonly table: CompletedTable; readonly markdown: ((props: MarkdownProps) => RenderElement) | undefined }

const unbuilt = Symbol('an element built outside a render')

type Unbuilt = { readonly [unbuilt]: { readonly name: ElementName; readonly props: object } }

let drawing: Drawing | undefined

export function drawWith<Drawn>(table: ElementTable, draw: () => Drawn, markdown?: (props: MarkdownProps) => RenderElement): Drawn {
  const outer = drawing
  const current = { table: table as CompletedTable, markdown }
  drawing = current
  try {
    return built(current, draw()) as Drawn
  } finally {
    drawing = outer
  }
}

function element<Name extends keyof Terminal & ElementName>(name: Name): Terminal[Name] {
  const construct = (props: object) => (drawing === undefined ? ({ [unbuilt]: { name, props } } satisfies Unbuilt as unknown as RenderElement) : build(drawing, name, props))
  return construct
}

function build(current: Drawing, name: ElementName, props: object): RenderElement {
  const ready = 'children' in props ? { ...props, children: built(current, props.children) } : props
  if (name === 'Markdown' && current.markdown !== undefined) return current.markdown(ready as MarkdownProps)
  return current.table[name](ready)
}

function built(current: Drawing, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((child: unknown) => built(current, child))
  if (typeof value !== 'object' || value === null || !(unbuilt in value)) return value
  const { name, props } = (value as Unbuilt)[unbuilt]
  return build(current, name, props)
}

export const Box = element('Box')
export const Text = element('Text')
export const Button = element('Button')
export const Link = element('Link')
export const Code = element('Code')
export const Markdown = element('Markdown')
export const Input = element('Input')
export const Select = element('Select')
export const Image = element('Image')
