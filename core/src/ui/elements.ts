import type { ElementName, ElementTable, Elements, MarkdownProps, RenderElement } from 'claude-code'

type Terminal = Elements['terminal'] & Elements['desktop']

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

export function drawKeyed<Drawn>(keyPrefix: string, draw: () => Drawn): Drawn {
  const outer = drawing
  drawing = undefined
  try {
    return keyed(draw(), keyPrefix) as Drawn
  } finally {
    drawing = outer
  }
}

function keyed(value: unknown, keyPrefix: string): unknown {
  if (Array.isArray(value)) return value.map((each: unknown) => keyed(each, keyPrefix))
  if (typeof value !== 'object' || value === null || !(unbuilt in value)) return value
  const { name, props } = (value as Unbuilt)[unbuilt]
  const prefixed = Object.fromEntries(Object.entries(props).map(([field, each]) => [field, field === 'key' && typeof each === 'string' ? `${keyPrefix}${each}` : keyed(each, keyPrefix)]))
  return { [unbuilt]: { name, props: prefixed } } satisfies Unbuilt
}

const elementKey = '$cmodElement'

const handlerKey = '$cmodHandler'

export type Handler = (...args: unknown[]) => unknown

export function elementData(value: unknown, handlers: Handler[]): unknown {
  if (typeof value === 'function') return { [handlerKey]: handlers.push(value as Handler) - 1 }
  if (Array.isArray(value)) return value.map((each: unknown) => elementData(each, handlers))
  if (typeof value !== 'object' || value === null) return value
  if (unbuilt in value) {
    const { name, props } = (value as Unbuilt)[unbuilt]
    if (name === 'Client') throw new Error('Client draws only in panes and styles.')
    return { [elementKey]: name, props: elementData(props, handlers) }
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('a widget draws only the elements of ui/elements.js and ui/components.js, text, numbers, and plain objects.')
  return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, elementData(each, handlers)]))
}

export function elementOf(data: unknown, keyPrefix: string, press: (handler: number, args: readonly unknown[]) => void): unknown {
  if (Array.isArray(data)) return data.map((each: unknown) => elementOf(each, keyPrefix, press))
  if (typeof data !== 'object' || data === null) return data
  const fields = data as Readonly<Record<string, unknown>>
  if (typeof fields[handlerKey] === 'number') {
    const handler = fields[handlerKey]
    return (...args: unknown[]) => press(handler, JSON.parse(JSON.stringify(args)) as unknown[])
  }
  const name = fields[elementKey]
  if (name === undefined) return Object.fromEntries(Object.entries(fields).map(([key, each]) => [key, elementOf(each, keyPrefix, press)]))
  if (typeof name !== 'string' || !Object.hasOwn(constructors, name)) throw new Error(`a widget drew ${String(name)}, which is not an element of ui/elements.js.`)
  const props = elementOf(fields['props'], keyPrefix, press) as Record<string, unknown>
  return constructors[name as keyof typeof constructors]((typeof props['key'] === 'string' ? { ...props, key: `${keyPrefix}${props['key']}` } : props) as never)
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
export const Svg = element('Svg')
export const Raster = element('Raster')
export const Client = element('Client')

const constructors = { Box, Text, Button, Link, Code, Markdown, Input, Select, Image, Svg, Raster }
