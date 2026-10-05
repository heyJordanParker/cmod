import type { Nodes, RootContent } from 'mdast'
import { fromMarkdown, gfm, gfmFromMarkdown, toString } from '../vendor-markdown.js'
import type { Slot } from './slots.js'

type Block = { readonly text: string; readonly source: string }

type BlockFields = {
  heading: { readonly depth: 1 | 2 | 3 | 4 | 5 | 6 }
  code: { readonly lang: string | undefined; readonly meta: string | undefined; readonly value: string }
  list: { readonly ordered: boolean; readonly start: number | undefined; readonly spread: boolean }
  table: { readonly align: readonly ('left' | 'right' | 'center' | null)[] }
  html: { readonly value: string }
}

type BlockProps<Type extends string> = Type extends keyof BlockFields ? Block & BlockFields[Type] : Block

export type MarkdownPiece<Render> = { readonly text: string } | { readonly render: Render; readonly props: Block }

export type MarkdownReader = <Render>(text: string, renderOf: (type: string) => Render | undefined, replyId?: string) => readonly MarkdownPiece<Render>[]

export type MarkdownKind = {
  readonly name: string
  readonly type: string
  readonly createReader: () => MarkdownReader
}

type Parsed = { readonly type: string; readonly start: number; readonly end: number; readonly props: Block }

type Reply = { readonly id: string; readonly text: string; readonly blocks: readonly Parsed[] }

const keptReplies = 64

const extensions = [gfm()]

const mdastExtensions = [gfmFromMarkdown()]

const lineByLine: ReadonlySet<string> = new Set(['list', 'listItem', 'blockquote', 'table', 'tableRow'])

function createReader(): MarkdownReader {
  const replies: Reply[] = []

  const remember = (reply: Reply) => {
    replies.push(reply)
    if (replies.length > keptReplies) replies.shift()
  }

  const blocksOf = (text: string, replyId: string | undefined) => {
    if (replyId === undefined) return { blocks: parsed(text, 0), isGrowing: false }
    const earlier = replies.filter((reply) => reply.id === replyId && text.startsWith(reply.text)).sort((a, b) => b.text.length - a.text.length)[0]
    if (earlier !== undefined) replies.splice(replies.indexOf(earlier), 1)
    if (earlier?.text === text) {
      replies.push(earlier)
      return { blocks: earlier.blocks, isGrowing: false }
    }
    const from = earlier?.blocks.at(-1)?.start ?? 0
    const blocks = [...(earlier?.blocks.slice(0, -1) ?? []), ...parsed(text.slice(from), from)]
    remember({ id: replyId, text, blocks })
    return { blocks, isGrowing: earlier !== undefined }
  }

  return <Render>(text: string, renderOf: (type: string) => Render | undefined, replyId?: string) => {
    const { blocks, isGrowing } = blocksOf(text, replyId)
    const pieces: MarkdownPiece<Render>[] = []
    let run: { start: number; end: number } | undefined
    const endRun = () => {
      if (run !== undefined) pieces.push({ text: text.slice(run.start, run.end) })
      run = undefined
    }
    blocks.forEach((block, index) => {
      const render = renderOf(block.type)
      const isStreaming = isGrowing && index === blocks.length - 1
      if (render !== undefined && !isStreaming) {
        endRun()
        pieces.push({ render, props: block.props })
        return
      }
      run = { start: run?.start ?? block.start, end: block.end }
    })
    endRun()
    return pieces
  }
}

function parsed(text: string, offset: number): Parsed[] {
  return fromMarkdown(text, { extensions, mdastExtensions }).children.map((node) => {
    const start = node.position?.start.offset ?? 0
    const end = node.position?.end.offset ?? text.length
    return { type: node.type, start: offset + start, end: offset + end, props: propsOf(node, text.slice(start, end)) }
  })
}

function propsOf(node: RootContent, source: string): BlockProps<RootContent['type']> {
  const block = { text: plainText(node), source }
  if (node.type === 'heading') return { ...block, depth: node.depth }
  if (node.type === 'code') return { ...block, lang: node.lang ?? undefined, meta: node.meta ?? undefined, value: node.value }
  if (node.type === 'list') return { ...block, ordered: node.ordered === true, start: node.start ?? undefined, spread: node.spread === true }
  if (node.type === 'table') return { ...block, align: node.align ?? [] }
  if (node.type === 'html') return { ...block, value: node.value }
  return block
}

function plainText(node: Nodes): string {
  if (!('children' in node) || !lineByLine.has(node.type)) return toString(node)
  return node.children.map(plainText).join(node.type === 'tableRow' ? '\t' : '\n')
}

function markdownSlot<Type extends RootContent['type']>(name: string, type: Type): Slot<BlockProps<Type>, { readonly source?: string }, { readonly markdown: MarkdownKind }> {
  return { markdown: { name, type, createReader } } as Slot<BlockProps<Type>, { readonly source?: string }, { readonly markdown: MarkdownKind }>
}

export const markdownSlots = {
  Heading: markdownSlot('Heading', 'heading'),
  Paragraph: markdownSlot('Paragraph', 'paragraph'),
  CodeBlock: markdownSlot('CodeBlock', 'code'),
  BlockQuote: markdownSlot('BlockQuote', 'blockquote'),
  List: markdownSlot('List', 'list'),
  Table: markdownSlot('Table', 'table'),
  ThematicBreak: markdownSlot('ThematicBreak', 'thematicBreak'),
  HtmlBlock: markdownSlot('HtmlBlock', 'html'),
}
