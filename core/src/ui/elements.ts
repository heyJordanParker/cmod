import type { ElementName, ElementTable, Elements, MarkdownProps, RenderElement } from 'claude-code'

type Terminal = Elements['terminal']

type CompletedTable = Record<ElementName, (props: object) => RenderElement>

type Drawing = { readonly table: CompletedTable; readonly markdown: ((props: MarkdownProps) => RenderElement) | undefined }

let drawing: Drawing | undefined

export function drawWith<Drawn>(table: ElementTable, draw: () => Drawn, markdown?: (props: MarkdownProps) => RenderElement): Drawn {
  const outer = drawing
  drawing = { table: table as CompletedTable, markdown }
  try {
    return draw()
  } finally {
    drawing = outer
  }
}

function element<Name extends keyof Terminal & ElementName>(name: Name): Terminal[Name] {
  const construct = (props: object) => {
    if (drawing === undefined) throw new Error(`${name} was called outside a render. Use it inside a pane's render or a slot's component.`)
    if (name === 'Markdown' && drawing.markdown !== undefined) return drawing.markdown(props as MarkdownProps)
    return drawing.table[name](props)
  }
  return construct as Terminal[Name]
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
