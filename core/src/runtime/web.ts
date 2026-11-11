import type { ListItem, PhrasingContent, RootContent, TableCell } from 'mdast'
import { fromMarkdown, gfm, gfmFromMarkdown } from '../vendor-markdown.js'

const elementKey = '$cmodElement'

const handlerKey = '$cmodHandler'

type Props = Readonly<Record<string, unknown>>

type Declarations = readonly (readonly [string, string | undefined])[]

type Drawing = { readonly rules: string[]; readonly groups: Map<string, string>; scopes: number; scope: string | undefined }

const themeKeys: ReadonlySet<string> = new Set(['text', 'inverseText', 'inactive', 'subtle', 'suggestion', 'remember', 'success', 'error', 'warning', 'merged', 'claude', 'permission', 'planMode', 'autoAccept', 'promptBorder', 'bashBorder', 'ide', 'diffAdded', 'diffRemoved', 'diffAddedDimmed', 'diffRemovedDimmed', 'diffAddedWord', 'diffRemovedWord'])

const spaceSteps: Readonly<Record<string, number>> = { xs: 0.25, sm: 0.5, md: 1, lg: 1.5, xl: 2 }

const flexValues: Readonly<Record<string, ReadonlySet<string>>> = {
  flexDirection: new Set(['row', 'column', 'row-reverse', 'column-reverse']),
  flexWrap: new Set(['nowrap', 'wrap', 'wrap-reverse']),
  alignItems: new Set(['flex-start', 'center', 'flex-end', 'stretch']),
  alignSelf: new Set(['flex-start', 'center', 'flex-end', 'auto']),
  justifyContent: new Set(['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']),
}

const cssNames: Readonly<Record<string, string>> = { flexDirection: 'flex-direction', flexWrap: 'flex-wrap', alignItems: 'align-items', alignSelf: 'align-self', justifyContent: 'justify-content' }

const sides = [
  ['Top', 'Y', 'down'],
  ['Right', 'X', 'across'],
  ['Bottom', 'Y', 'down'],
  ['Left', 'X', 'across'],
] as const

const linkSchemes = /^(https?:|mailto:|file:)/i

const hotkeys = /^[0-9a-z]$/

const base64 = /^[A-Za-z0-9+/]*={0,2}$/

const markdownOptions = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }

type Markdown = { readonly link: number | undefined; readonly pressable: readonly string[] | undefined }

export type SidebarTab = { readonly key: string; readonly label: string; readonly isClosable: boolean }

export type ClosedPage = { readonly mod: string; readonly page: string; readonly title: string }

export type SessionWait = { readonly kind: 'permission'; readonly tool: string; readonly input: Readonly<Record<string, unknown>> } | { readonly kind: 'question'; readonly question: string }

export type TurnOutcome = { readonly reason: 'answered' | 'stopped' | 'failed'; readonly at: string; readonly failure?: string }

export type SessionAbout = {
  readonly tabs: readonly SidebarTab[]
  readonly pages: readonly ClosedPage[]
  readonly isWorking?: boolean
  readonly waiting?: SessionWait
  readonly lastTurn?: TurnOutcome
  readonly contextPercent?: number
}

export type WebView = { readonly id: string; readonly tab: string; readonly columns: number }

export type WebInput = { readonly draw: number; readonly handler: number; readonly key: string; readonly kind: 'press' | 'change' | 'submit' | 'select' | 'link'; readonly value?: string; readonly href?: string }

export type WebAction =
  | ({ readonly type: 'press'; readonly view: string } & WebInput)
  | { readonly type: 'open'; readonly mod: string; readonly page: string }
  | { readonly type: 'close'; readonly tab: string }
  | { readonly type: 'prompt'; readonly text: string }
  | { readonly type: 'stop' }

export type ElementData = { readonly $cmodElement: string; readonly props: Readonly<Record<string, unknown>> }

export type HandlerData = { readonly $cmodHandler: number }

export type SessionEvents = { readonly views: readonly WebView[]; readonly actions: readonly WebAction[] }

export type WebDrawing = { readonly view: string; readonly draw: number; readonly tree: unknown }

export type SessionPost = { readonly about?: SessionAbout; readonly drawings?: readonly WebDrawing[] }

export function htmlOf(tree: unknown): string {
  const drawing: Drawing = { rules: [], groups: new Map(), scopes: 0, scope: undefined }
  const body = nodeHtml(tree, drawing)
  return drawing.rules.length === 0 ? body : `<style>${drawing.rules.join('')}</style>${body}`
}

function nodeHtml(tree: unknown, drawing: Drawing): string {
  if (tree === null || tree === undefined || typeof tree === 'boolean') return ''
  if (typeof tree === 'string') return escaped(tree)
  if (typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map((each: unknown) => nodeHtml(each, drawing)).join('')
  if (typeof tree !== 'object') return ''
  const fields = tree as Props
  const name = fields[elementKey]
  if (typeof name !== 'string') return ''
  const props = (typeof fields['props'] === 'object' && fields['props'] !== null ? fields['props'] : {}) as Props
  const draw = elements[name]
  return draw === undefined ? `<span class="gap">${escaped(`The browser draws no ${name}.`)}</span>` : draw(props, drawing)
}

const elements: Readonly<Record<string, (props: Props, drawing: Drawing) => string>> = {
  Box: (props, drawing) => {
    const key = keyOf(props)
    const own = key === undefined ? undefined : `s${drawing.scopes++}`
    const outer = drawing.scope
    const hover = hoverClasses(props['hover'], boxHover(props), drawing, own ?? outer)
    const classes = ['b', ...(typeof props['borderStyle'] === 'string' ? ['bordered'] : []), ...(own === undefined ? [] : [own]), ...hover]
    drawing.scope = own ?? outer
    const children = nodeHtml(props['children'], drawing)
    drawing.scope = outer
    return `<div class="${classes.join(' ')}"${attribute('data-key', key)}${attribute('style', boxStyle(props))}>${children}</div>`
  },
  Text: (props, drawing) => {
    const hover = hoverClasses(props['hover'], textHover(props), drawing, drawing.scope)
    return `<span class="${['t', ...textClasses(props), ...hover].join(' ')}"${attribute('style', textStyle(props))}${attribute('dir', props['dir'] === 'rtl' || props['dir'] === 'ltr' ? props['dir'] : undefined)}>${nodeHtml(props['children'], drawing)}</span>`
  },
  Button: (props, drawing) => {
    const label = typeof props['label'] === 'string' ? props['label'] : undefined
    const drawn = nodeHtml(props['children'], drawing)
    const shown = drawn === '' ? escaped(label ?? '') : drawn
    const hotkey = typeof props['hotkey'] === 'string' && hotkeys.test(props['hotkey']) ? props['hotkey'] : undefined
    const prefix = props['plain'] === true && hotkey !== undefined ? `<span class="hotkey">${hotkey}</span>: ` : ''
    const hover = hoverClasses(props['hover'], textHover({}), drawing, drawing.scope)
    const classes = ['button', ...(props['plain'] === true ? ['plain'] : props['variant'] === 'primary' ? ['primary'] : []), ...(props['dimColor'] === true ? ['dim'] : []), ...hover]
    const key = keyOf(props) ?? label ?? (typeof props['children'] === 'string' ? props['children'] : undefined)
    const href = typeof props['href'] === 'string' && linkSchemes.test(props['href']) ? props['href'] : undefined
    if (href !== undefined) return `<a class="${classes.join(' ')}" href="${escaped(href)}" target="_blank" rel="noopener noreferrer"${attribute('aria-label', drawn === '' ? undefined : label)}${attribute('data-key', key)}>${prefix}${shown}</a>`
    return `<button type="button" class="${classes.join(' ')}"${attribute('aria-label', drawn === '' ? undefined : label)}${attribute('data-key', key)}${handlerAttribute('data-press', props['onPress'])}${attribute('data-hotkey', hotkey)}${props['autoFocus'] === true ? ' autofocus' : ''}>${prefix}${shown}</button>`
  },
  Link: (props, drawing) => {
    const href = typeof props['href'] === 'string' ? props['href'] : ''
    const drawn = nodeHtml(props['children'], drawing)
    const text = drawn === '' ? escaped(typeof props['label'] === 'string' ? props['label'] : href) : drawn
    return linkSchemes.test(href) ? `<a class="link" href="${escaped(href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : `<span class="t">${text}</span>`
  },
  Code: (props) => codeHtml(typeof props['source'] === 'string' ? props['source'] : '', typeof props['startLine'] === 'number' ? props['startLine'] : undefined, props['format'] === 'diff', props['wrap'] === 'truncate-end'),
  Markdown: (props) => {
    const text = typeof props['text'] === 'string' ? props['text'] : ''
    const pressable = Array.isArray(props['pressableLinks']) ? props['pressableLinks'].filter((href): href is string => typeof href === 'string') : undefined
    const blocks = fromMarkdown(text, markdownOptions).children.map((node) => blockHtml(node, { link: handlerOf(props['onLinkPress']), pressable })).join('')
    return `<div class="${props['dimColor'] === true ? 'markdown dim' : 'markdown'}"${attribute('data-key', keyOf(props))}>${blocks}</div>`
  },
  Input: (props) => {
    const value = typeof props['value'] === 'string' ? props['value'] : ''
    const rows = typeof props['rows'] === 'number' && props['rows'] > 1 ? Math.floor(props['rows']) : 1
    const shared = `${attribute('data-key', keyOf(props))}${handlerAttribute('data-input', props['onInput'])}${handlerAttribute('data-submit', props['onSubmit'])}${attribute('data-value', value)}${attribute('placeholder', typeof props['placeholder'] === 'string' ? props['placeholder'] : undefined)}${props['autoFocus'] === true ? ' autofocus' : ''}`
    const field = rows > 1 ? `<textarea class="input" rows="${rows}"${shared}>${escaped(value)}</textarea>` : `<input type="text" class="input"${shared} value="${escaped(value)}">`
    const submitLabel = typeof props['submitLabel'] === 'string' ? props['submitLabel'] : 'submit'
    return `<label class="field">${labelHtml(props['label'])}${field}<span class="hint">enter: ${escaped(submitLabel)}</span></label>`
  },
  Select: (props) => {
    const value = typeof props['value'] === 'string' ? props['value'] : undefined
    const options = (Array.isArray(props['options']) ? props['options'] : []).flatMap((option: unknown) => {
      const each = option as Props
      if (typeof each['value'] !== 'string') return []
      const label = typeof each['label'] === 'string' ? each['label'] : each['value']
      return [`<option value="${escaped(each['value'])}"${each['value'] === value ? ' selected' : ''}>${escaped(label)}</option>`]
    })
    return `<label class="field">${labelHtml(props['label'])}<select class="select"${attribute('data-key', keyOf(props))}${handlerAttribute('data-select', props['onSelect'])}${attribute('data-value', value)}${props['autoFocus'] === true ? ' autofocus' : ''}>${options.join('')}</select></label>`
  },
  Image: (props) => {
    const source = props['source'] as Props | undefined
    const alt = typeof props['alt'] === 'string' ? props['alt'] : ''
    const size = attribute('style', `width:${across(numberOr(props['columns'], 1))};height:${down(numberOr(props['rows'], 1))}`)
    if (typeof source?.['png'] === 'string' && base64.test(source['png'])) return `<img class="image" alt="${escaped(alt)}" src="data:image/png;base64,${source['png']}"${size}>`
    const [width, height] = [source?.['width'], source?.['height']]
    if (typeof source?.['rgba'] === 'string' && base64.test(source['rgba']) && Number.isInteger(width) && Number.isInteger(height)) return `<canvas class="image" width="${width as number}" height="${height as number}" data-rgba="${source['rgba']}"${attribute('aria-label', alt)}${size}></canvas>`
    return `<span class="t dim"${size}>${escaped(alt)}</span>`
  },
  Svg: (props) => {
    const source = typeof props['source'] === 'string' ? props['source'] : ''
    const size = [typeof props['width'] === 'number' ? `width:${props['width']}px` : '', typeof props['height'] === 'number' ? `height:${props['height']}px` : ''].filter((each) => each !== '').join(';')
    return `<img class="svg" alt="${escaped(typeof props['alt'] === 'string' ? props['alt'] : '')}" src="data:image/svg+xml,${encodeURIComponent(source)}"${attribute('style', size === '' ? undefined : size)}>`
  },
  Raster: (props) => rasterHtml(typeof props['cells'] === 'string' ? props['cells'] : '', numberOr(props['columns'], 1)),
}

function escaped(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)
}

function attribute(name: string, value: string | undefined): string {
  return value === undefined || value === '' ? '' : ` ${name}="${escaped(value)}"`
}

function handlerOf(value: unknown): number | undefined {
  const marker = typeof value === 'object' && value !== null ? (value as Props)[handlerKey] : undefined
  return typeof marker === 'number' ? marker : undefined
}

function handlerAttribute(name: string, value: unknown): string {
  const handler = handlerOf(value)
  return handler === undefined ? '' : ` ${name}="${handler}"`
}

function keyOf(props: Props): string | undefined {
  return typeof props['key'] === 'string' ? props['key'] : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function across(cells: number): string {
  return `${cells}ch`
}

function down(cells: number): string {
  return `calc(${cells} * var(--row))`
}

function cellsOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return typeof value === 'string' ? spaceSteps[value] : undefined
}

function sizeOf(value: unknown, axis: 'across' | 'down'): string | undefined {
  if (typeof value === 'string' && /^\d+(\.\d+)?%$/.test(value)) return value
  const cells = typeof value === 'number' && Number.isFinite(value) ? value : undefined
  return cells === undefined ? undefined : axis === 'across' ? across(cells) : down(cells)
}

function colorOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (themeKeys.has(value) || /^[a-z]+[A-Z][A-Za-z]*$/.test(value)) return `var(--${value})`
  return /^#[0-9a-f]{3,8}$/i.test(value) || /^(rgb|hsl)a?\([\d\s.,%]+\)$/i.test(value) || /^[a-z]+$/.test(value) ? value : undefined
}

function dimmed(color: string): string {
  return `color-mix(in srgb, ${color} 55%, transparent)`
}

function css(declarations: Declarations, suffix = ''): string {
  return declarations.flatMap(([name, value]) => (value === undefined ? [] : [`${name}:${value}${suffix}`])).join(';')
}

function hoverClasses(hover: unknown, declarations: (hover: Props) => Declarations, drawing: Drawing, scope: string | undefined): readonly string[] {
  if (typeof hover !== 'object' || hover === null) return []
  const lit = hover as Props
  const rule = css(declarations(lit), ' !important')
  const group = typeof lit['scope'] === 'string' ? (drawing.groups.get(lit['scope']) ?? `g${drawing.groups.size}`) : undefined
  if (rule === '' || (group === undefined && scope === undefined)) return []
  const name = `h${drawing.rules.length}`
  if (group === undefined) {
    drawing.rules.push(`.${scope}:hover .${name},.${scope}.${name}:hover{${rule}}`)
    return [name]
  }
  drawing.groups.set(lit['scope'] as string, group)
  drawing.rules.push(`:root:has(.${group}:hover) .${name}{${rule}}`)
  return [name, group]
}

function boxHover(props: Props): (hover: Props) => Declarations {
  return (hover) => {
    const offset = (side: string, axis: 'across' | 'down') => (props['position'] === 'absolute' ? sizeOf(hover[side], axis) : undefined)
    const color = colorOf(hover['borderColor'] ?? props['borderColor']) ?? 'currentColor'
    const isBorderLit = typeof props['borderStyle'] === 'string' && (hover['borderColor'] !== undefined || hover['borderDimColor'] !== undefined)
    return [
      ['display', hover['display'] === 'flex' ? 'flex' : undefined],
      ['background', colorOf(hover['backgroundColor'])],
      ['--border-color', isBorderLit ? ((hover['borderDimColor'] ?? props['borderDimColor']) === true ? dimmed(color) : color) : undefined],
      ['top', offset('top', 'down')],
      ['left', offset('left', 'across')],
      ['right', offset('right', 'across')],
      ['bottom', offset('bottom', 'down')],
    ]
  }
}

function textHover(props: Props): (hover: Props) => Declarations {
  return (hover) => textDeclarations({ ...props, ...hover })
}

function boxStyle(props: Props): string {
  const style: [string, string | undefined][] = []
  const add = (name: string, value: string | undefined) => void style.push([name, value])
  for (const [prop, allowed] of Object.entries(flexValues)) add(cssNames[prop] ?? prop, typeof props[prop] === 'string' && allowed.has(props[prop]) ? props[prop] : undefined)
  add('flex-grow', typeof props['flexGrow'] === 'number' ? String(props['flexGrow']) : undefined)
  add('flex-shrink', typeof props['flexShrink'] === 'number' ? String(props['flexShrink']) : undefined)
  const columnGap = cellsOf(props['columnGap'] ?? props['gap'])
  const rowGap = cellsOf(props['rowGap'] ?? props['gap'])
  add('column-gap', columnGap === undefined ? undefined : across(columnGap))
  add('row-gap', rowGap === undefined ? undefined : down(rowGap))
  add('width', sizeOf(props['width'], 'across'))
  add('height', sizeOf(props['height'], 'down'))
  add('min-width', sizeOf(props['minWidth'], 'across'))
  add('min-height', sizeOf(props['minHeight'], 'down'))
  const hasBorder = typeof props['borderStyle'] === 'string'
  for (const [side, axis, unit] of sides) {
    const margin = cellsOf(props[`margin${side}`] ?? props[`margin${axis}`] ?? props['margin'])
    const padding = (cellsOf(props[`padding${side}`] ?? props[`padding${axis}`] ?? props['padding']) ?? 0) + (hasBorder ? 1 : 0)
    add(`margin-${side.toLowerCase()}`, margin === undefined ? undefined : unit === 'across' ? across(margin) : down(margin))
    if (padding > 0) add(`padding-${side.toLowerCase()}`, unit === 'across' ? across(padding) : down(padding))
  }
  if (hasBorder) {
    const color = colorOf(props['borderColor']) ?? 'currentColor'
    add('--border-color', props['borderDimColor'] === true ? dimmed(color) : color)
    add('--border-style', props['borderStyle'] === 'double' ? 'double' : props['borderStyle'] === 'classic' || props['borderStyle'] === 'dashed' ? 'dashed' : 'solid')
    add('--border-radius', props['borderStyle'] === 'round' ? '0.5ch' : '0')
    add('--border-width', props['borderStyle'] === 'bold' || props['borderStyle'] === 'double' ? '3px' : '1px')
  }
  add('background', colorOf(props['backgroundColor']))
  add('overflow', props['overflow'] === 'hidden' ? 'hidden' : undefined)
  add('display', props['display'] === 'none' ? 'none' : undefined)
  if (props['position'] === 'absolute') {
    add('position', 'absolute')
    add('top', sizeOf(props['top'], 'down'))
    add('bottom', sizeOf(props['bottom'], 'down'))
    add('left', sizeOf(props['left'], 'across'))
    add('right', sizeOf(props['right'], 'across'))
  }
  return css(style)
}

function textClasses(props: Props): string[] {
  const wrap = props['wrap']
  const isCut = typeof wrap === 'string' && wrap !== 'wrap'
  const size = props['size']
  return [...(isCut ? ['cut'] : []), ...(typeof size === 'string' && ['caption', 'footnote', 'heading', 'title'].includes(size) ? [`size-${size}`] : [])]
}

function textDeclarations(props: Props): Declarations {
  const color = colorOf(props['color'])
  const background = colorOf(props['backgroundColor'])
  const isDim = props['dimColor'] === true
  const foreground = color === undefined && !isDim ? undefined : isDim ? dimmed(color ?? 'var(--text)') : color
  const isInverse = props['inverse'] === true
  const weight = props['weight']
  const weights: Readonly<Record<string, string>> = { regular: '400', medium: '500', semibold: '600', bold: '700' }
  const lines = [props['underline'] === true ? 'underline' : '', props['strikethrough'] === true ? 'line-through' : ''].filter((line) => line !== '')
  return [
    ['color', isInverse ? (background ?? 'var(--background)') : foreground],
    ['background', isInverse ? (foreground ?? 'var(--text)') : background],
    ['font-weight', typeof weight === 'string' && weights[weight] !== undefined ? weights[weight] : props['bold'] === true ? '700' : undefined],
    ['font-style', props['italic'] === true ? 'italic' : undefined],
    ['text-decoration', lines.length === 0 ? undefined : lines.join(' ')],
    ['font-variant-numeric', props['tabular'] === true ? 'tabular-nums' : undefined],
  ]
}

function textStyle(props: Props): string {
  return css(textDeclarations(props))
}

function labelHtml(label: unknown): string {
  return typeof label === 'string' ? `<span class="label">${escaped(label)}</span>` : ''
}

function codeHtml(source: string, startLine: number | undefined, isDiff: boolean, isCut: boolean): string {
  const lines = source.split('\n')
  const width = String((startLine ?? 1) + lines.length - 1).length
  const rows = lines.map((line, index) => {
    const kind = !isDiff ? '' : line.startsWith('+') ? ' added' : line.startsWith('-') ? ' removed' : line.startsWith('@@') ? ' hunk' : ''
    const gutter = startLine === undefined || isDiff ? '' : `<span class="gutter">${String(startLine + index).padStart(width)} </span>`
    return `<span class="line${kind}">${gutter}${escaped(line)}</span>`
  })
  return `<pre class="${isCut ? 'code cut' : 'code'}">${rows.join('\n')}</pre>`
}

function rasterHtml(cells: string, columns: number): string {
  if (cells.length % 4 !== 0 || !base64.test(cells)) return '<span class="gap">The browser draws no Raster whose cells are not base64.</span>'
  const bytes = Uint8Array.from(atob(cells), (character) => character.charCodeAt(0))
  const words = new DataView(bytes.buffer)
  const colorFrom = (word: number) => (word === 0x01000000 ? undefined : `#${(word & 0xffffff).toString(16).padStart(6, '0')}`)
  const rows: string[] = []
  let row = ''
  for (let offset = 0, index = 0; offset + 12 <= bytes.length; offset += 12, index += 1) {
    const glyph = String.fromCodePoint(words.getUint32(offset, true))
    const style = [colorFrom(words.getUint32(offset + 4, true)), colorFrom(words.getUint32(offset + 8, true))]
    const painted = [style[0] === undefined ? '' : `color:${style[0]}`, style[1] === undefined ? '' : `background:${style[1]}`].filter((each) => each !== '').join(';')
    row += painted === '' ? escaped(glyph) : `<span style="${painted}">${escaped(glyph)}</span>`
    if ((index + 1) % Math.max(Math.floor(columns), 1) === 0) {
      rows.push(row)
      row = ''
    }
  }
  if (row !== '') rows.push(row)
  return `<pre class="raster">${rows.join('\n')}</pre>`
}

function linkHtml(href: string, inner: string, markdown: Markdown): string {
  const isPressed = markdown.link !== undefined && (markdown.pressable === undefined || markdown.pressable.includes(href))
  if (isPressed) return `<a class="link" href="${escaped(href)}" data-link="${markdown.link}">${inner}</a>`
  return linkSchemes.test(href) ? `<a class="link" href="${escaped(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner
}

function inlineHtml(node: PhrasingContent, markdown: Markdown): string {
  const inner = () => ('children' in node ? node.children.map((child) => inlineHtml(child, markdown)).join('') : '')
  switch (node.type) {
    case 'text':
      return escaped(node.value)
    case 'emphasis':
      return `<em>${inner()}</em>`
    case 'strong':
      return `<strong>${inner()}</strong>`
    case 'delete':
      return `<del>${inner()}</del>`
    case 'inlineCode':
      return `<code>${escaped(node.value)}</code>`
    case 'break':
      return '<br>'
    case 'link':
      return linkHtml(node.url, inner(), markdown)
    case 'image':
      return linkHtml(node.url, escaped(node.alt ?? node.url), markdown)
    case 'html':
      return escaped(node.value)
    default:
      return inner()
  }
}

function itemHtml(item: ListItem, markdown: Markdown): string {
  const check = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : ''
  return `<li>${check}${item.children.map((child) => blockHtml(child, markdown)).join('')}</li>`
}

function cellHtml(cell: TableCell, tag: 'th' | 'td', align: string | null | undefined, markdown: Markdown): string {
  return `<${tag}${align === null || align === undefined ? '' : ` style="text-align:${align}"`}>${cell.children.map((child) => inlineHtml(child, markdown)).join('')}</${tag}>`
}

function blockHtml(node: RootContent, markdown: Markdown): string {
  switch (node.type) {
    case 'heading':
      return `<h${node.depth}>${node.children.map((child) => inlineHtml(child, markdown)).join('')}</h${node.depth}>`
    case 'paragraph':
      return `<p>${node.children.map((child) => inlineHtml(child, markdown)).join('')}</p>`
    case 'code':
      return codeHtml(node.value, undefined, node.lang === 'diff', false)
    case 'blockquote':
      return `<blockquote>${node.children.map((child) => blockHtml(child, markdown)).join('')}</blockquote>`
    case 'list': {
      const items = node.children.map((item) => itemHtml(item, markdown)).join('')
      return node.ordered === true ? `<ol${node.start === null || node.start === undefined || node.start === 1 ? '' : ` start="${node.start}"`}>${items}</ol>` : `<ul>${items}</ul>`
    }
    case 'table': {
      const [head, ...body] = node.children
      const row = (cells: readonly TableCell[], tag: 'th' | 'td') => `<tr>${cells.map((cell, index) => cellHtml(cell, tag, node.align?.[index], markdown)).join('')}</tr>`
      return `<table>${head === undefined ? '' : `<thead>${row(head.children, 'th')}</thead>`}<tbody>${body.map((each) => row(each.children, 'td')).join('')}</tbody></table>`
    }
    case 'thematicBreak':
      return '<hr>'
    case 'html':
      return `<p>${escaped(node.value)}</p>`
    case 'listItem':
      return itemHtml(node, markdown)
    default:
      return 'children' in node ? node.children.map((child) => blockHtml(child as RootContent, markdown)).join('') : 'value' in node ? `<p>${escaped(String(node.value))}</p>` : ''
  }
}
