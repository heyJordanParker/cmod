export type MetadataFormat = { readonly kind: 'frontmatter' } | { readonly kind: 'comment'; readonly prefix: string } | { readonly kind: 'sidecar' }

export type ReadMetadata = {
  readonly metadata: Readonly<Record<string, string>>
  readonly name?: string
}

export class MetadataError extends Error {
  readonly line: number

  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`)
    this.line = line
  }
}

const markdown: readonly string[] = ['md', 'markdown', 'mdx']
const hashComments: readonly string[] = ['sh', 'bash', 'zsh', 'fish', 'py', 'rb', 'pl', 'r', 'yaml', 'yml', 'toml', 'ps1', 'nu', 'tcl', 'mk', 'conf', 'cfg', 'env']
const slashComments: readonly string[] = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'go', 'rs', 'swift', 'kt', 'kts', 'java', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'scala', 'dart', 'zig', 'jsonc', 'json5']
const dashComments: readonly string[] = ['lua', 'sql', 'hs', 'elm']
const hashCommentNames: readonly string[] = ['Makefile', 'Dockerfile', 'Brewfile', 'Gemfile', 'Rakefile', 'Justfile', 'justfile']

export const sidecarSuffix = '.meta'

export function formatOf(path: string, firstLine: string | undefined): MetadataFormat {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const extension = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
  if (markdown.includes(extension)) return { kind: 'frontmatter' }
  if (hashComments.includes(extension) || hashCommentNames.includes(name)) return { kind: 'comment', prefix: '#' }
  if (slashComments.includes(extension)) return { kind: 'comment', prefix: '//' }
  if (dashComments.includes(extension)) return { kind: 'comment', prefix: '--' }
  if (extension === '' && firstLine?.startsWith('#!') === true) return { kind: 'comment', prefix: '#' }
  return { kind: 'sidecar' }
}

type Region = { readonly start: number; readonly end: number; readonly lines: readonly string[] }

type Entry = { readonly key: string; readonly value: string }

type Block = { readonly start: number; readonly end: number; readonly entries: readonly Entry[] }

export function readMetadata(text: string, format: MetadataFormat): ReadMetadata {
  const lines = text.split('\n')
  if (format.kind === 'comment') {
    const region = commentRegion(lines, format.prefix)
    return { metadata: region === undefined ? {} : asRecord(mapEntries(region.lines, region.start + 2, 0)) }
  }
  const region = format.kind === 'frontmatter' ? frontmatterRegion(lines) : { start: -1, end: lines.length, lines }
  if (region === undefined) return { metadata: {} }
  const block = metadataBlock(region)
  const name = format.kind === 'frontmatter' ? topLevelScalar(region, 'name') : undefined
  return { metadata: block === undefined ? {} : asRecord(block.entries), ...(name === undefined ? {} : { name }) }
}

export function writeMetadata(text: string, format: MetadataFormat, metadata: Readonly<Record<string, string>>): string {
  const lines = text.split('\n')
  const entries = Object.entries(metadata)
  if (format.kind === 'comment') {
    const { prefix } = format
    const block = entries.length === 0 ? [] : [`${prefix} /// metadata`, ...entries.map(([key, value]) => `${prefix} ${scalar(key)}: ${scalar(value)}`), `${prefix} ///`]
    const region = commentRegion(lines, prefix)
    if (region !== undefined) return [...lines.slice(0, region.start), ...block, ...lines.slice(region.end + 1)].join('\n')
    if (block.length === 0) return text
    const at = lines[0]?.startsWith('#!') === true ? 1 : 0
    return [...lines.slice(0, at), ...block, ...lines.slice(at)].join('\n')
  }
  const map = entries.length === 0 ? [] : ['metadata:', ...entries.map(([key, value]) => `  ${scalar(key)}: ${scalar(value)}`)]
  if (format.kind === 'sidecar') {
    const block = metadataBlock({ start: -1, end: lines.length, lines })
    const rest = block === undefined ? lines : [...lines.slice(0, block.start), ...lines.slice(block.end)]
    const kept = rest.join('\n').trim()
    return [...(kept === '' ? [] : [kept]), ...map].join('\n') + (map.length === 0 && kept === '' ? '' : '\n')
  }
  const region = frontmatterRegion(lines)
  if (region === undefined) return map.length === 0 ? text : ['---', ...map, '---', ...lines].join('\n')
  const block = metadataBlock(region)
  const inner = block === undefined ? [...region.lines, ...map] : [...lines.slice(region.start + 1, block.start), ...map, ...lines.slice(block.end, region.end)]
  if (inner.every((line) => line.trim() === '')) return lines.slice(region.end + 1).join('\n')
  return [...lines.slice(0, region.start + 1), ...inner, ...lines.slice(region.end)].join('\n')
}

function frontmatterRegion(lines: readonly string[]): Region | undefined {
  if (lines[0]?.replace(/^\uFEFF/, '').trimEnd() !== '---') return undefined
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---')
  if (end === -1) throw new MetadataError(1, 'the frontmatter starts with --- and never ends. Close it with a --- line.')
  return { start: 0, end, lines: lines.slice(1, end) }
}

function commentRegion(lines: readonly string[], prefix: string): Region | undefined {
  const start = lines.findIndex((line) => line.trimEnd() === `${prefix} /// metadata`)
  if (start === -1) return undefined
  const content: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trimEnd()
    if (line === `${prefix} ///`) return { start, end: index, lines: content }
    if (line !== prefix && !line.startsWith(`${prefix} `)) break
    content.push(line.slice(prefix.length + 1))
  }
  throw new MetadataError(start + 1, `the metadata block never ends. Close it with a "${prefix} ///" line.`)
}

function metadataBlock(region: Region): Block | undefined {
  const at = region.lines.findIndex((line) => /^metadata\s*:/.test(line))
  if (at === -1) return undefined
  const lineNumber = region.start + 2 + at
  const rest = withoutComment((region.lines[at] ?? '').replace(/^metadata\s*:/, '')).trim()
  const start = region.start + 1 + at
  if (rest.startsWith('{')) return { start, end: start + 1, entries: flowEntries(rest, lineNumber) }
  if (rest !== '') throw new MetadataError(lineNumber, 'metadata holds a single value. Write a map of names to text, such as metadata: { mymod.key: value }.')
  let index = at + 1
  while (index < region.lines.length && (/^\s/.test(region.lines[index] ?? '') || (region.lines[index] ?? '').trim() === '')) index += 1
  while (index > at + 1 && (region.lines[index - 1] ?? '').trim() === '') index -= 1
  const children = region.lines.slice(at + 1, index)
  return { start, end: region.start + 1 + index, entries: mapEntries(children, lineNumber + 1, indentOf(children)) }
}

function indentOf(lines: readonly string[]): number {
  const first = lines.find((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  return first === undefined ? 0 : (/^\s*/.exec(first)?.[0].length ?? 0)
}

function mapEntries(lines: readonly string[], firstLine: number, indent: number): Entry[] {
  const entries: Entry[] = []
  lines.forEach((raw, index) => {
    const lineNumber = firstLine + index
    const line = withoutComment(raw)
    if (line.trim() === '') return
    const depth = /^\s*/.exec(line)?.[0].length ?? 0
    if (depth !== indent) throw new MetadataError(lineNumber, 'a metadata value holds a list or a map. Each value is one line of text, and a list is one space-separated text.')
    const body = line.trim()
    if (body.startsWith('- ')) throw new MetadataError(lineNumber, 'metadata holds a list. Write a map of names to text, and a list as one space-separated text.')
    entries.push(entryOf(body, lineNumber))
  })
  return entries
}

function flowEntries(text: string, lineNumber: number): Entry[] {
  if (!text.endsWith('}')) throw new MetadataError(lineNumber, 'the metadata map starts with { and does not end on the same line. Close it with }, or write one entry per line.')
  const body = text.slice(1, -1).trim()
  if (body === '') return []
  return splitOutsideQuotes(body, ',', lineNumber)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => entryOf(part, lineNumber))
}

function entryOf(text: string, lineNumber: number): Entry {
  const [keyText, ...rest] = splitOutsideQuotes(text, ':', lineNumber, true)
  if (keyText === undefined || rest.length === 0) throw new MetadataError(lineNumber, `"${text}" has no ":". Write each entry as name: value.`)
  const valueText = rest.join(':').trim()
  if (valueText.startsWith('{') || valueText.startsWith('[') || valueText === '|' || valueText === '>') throw new MetadataError(lineNumber, `${keyText.trim()} holds a list or a map. Each value is one line of text, and a list is one space-separated text.`)
  return { key: unquoted(keyText.trim(), lineNumber), value: unquoted(valueText, lineNumber) }
}

function splitOutsideQuotes(text: string, separator: string, lineNumber: number, needsSpace = false): string[] {
  const parts: string[] = []
  let quote: string | undefined
  let current = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string
    if (quote !== undefined) {
      current += char
      if (char === '\\' && quote === '"') {
        current += text[index + 1] ?? ''
        index += 1
      } else if (char === quote) quote = undefined
      continue
    }
    const before = current.trimEnd().at(-1)
    if ((char === '"' || char === "'") && (before === undefined || before === ':')) quote = char
    const next = text[index + 1]
    if (char === separator && (!needsSpace || next === undefined || next === ' ' || next === '\t')) {
      parts.push(current)
      current = ''
      if (needsSpace) {
        parts.push(text.slice(index + 1))
        return parts
      }
      continue
    }
    current += char
  }
  if (quote !== undefined) throw new MetadataError(lineNumber, `a ${quote === '"' ? 'double' : 'single'} quote never closes.`)
  parts.push(current)
  return parts
}

function withoutComment(line: string): string {
  let quote: string | undefined
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== undefined) {
      if (char === '\\' && quote === '"') index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1] ?? ''))) return line.slice(0, index)
  }
  return line
}

function unquoted(text: string, lineNumber: number): string {
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) throw new MetadataError(lineNumber, `${text} opens a double quote that never closes.`)
    try {
      return JSON.parse(text) as string
    } catch {
      throw new MetadataError(lineNumber, `${text} is not a double-quoted text. Escape a " inside it as \\".`)
    }
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new MetadataError(lineNumber, `${text} opens a single quote that never closes.`)
    return text.slice(1, -1).replaceAll("''", "'")
  }
  return text
}

function topLevelScalar(region: Region, key: string): string | undefined {
  const at = region.lines.findIndex((line) => line.startsWith(`${key}:`))
  if (at === -1) return undefined
  const text = withoutComment((region.lines[at] ?? '').slice(key.length + 1)).trim()
  if (text === '') return undefined
  try {
    return unquoted(text, region.start + 2 + at)
  } catch {
    return undefined
  }
}

function asRecord(entries: readonly Entry[]): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(entries.map(({ key, value }) => [key, value])))
}

const plain = /^[A-Za-z0-9_./+~$%^()=\\][^#]*$/
const special = /^(true|false|yes|no|on|off|null|~|[-+]?(\d[\d_]*)?\.?\d+([eE][-+]?\d+)?|0x[0-9a-fA-F]+|\.inf|\.nan)$/i

function scalar(text: string): string {
  const isPlain = plain.test(text) && text === text.trim() && !text.includes(': ') && !text.endsWith(':') && !text.includes(' #') && !special.test(text) && !/["',{}[\]]/.test(text)
  return isPlain ? text : JSON.stringify(text)
}
