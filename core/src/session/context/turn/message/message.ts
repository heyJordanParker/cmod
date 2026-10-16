import { isObject } from '../../../../records.js'
import { Task } from '../../../goal/task.js'
import { Document } from './document.js'
import { Note } from './note.js'
import { Notice } from './notice.js'
import { Prompt } from './prompt.js'
import { Reply } from './reply.js'
import { senderOf } from './sender.js'
import { Skill } from './skill.js'
import { ToolCall, type CallFiles } from './tool-call.js'
import { ToolResult } from './tool-result.js'

export const Message = 'message'

export type MessageType = typeof Prompt | typeof Note | typeof Reply | typeof ToolCall | typeof ToolResult | typeof Skill | typeof Document | typeof Notice

export type MessageOf<Type extends MessageType> = {
  readonly id: string
  readonly type: Type
  readonly at: string
  readonly session: string
  readonly context: number
  readonly turn?: string
  readonly task?: string
}

export type Message = Prompt | Note | Reply | ToolCall | ToolResult | Skill | Document | Notice

export type Placed = 'session' | 'context' | 'turn' | 'task'

export type Unplaced<M extends Message = Message> = M extends Message ? Omit<M, Placed> : never

export type Row = {
  readonly id: string
  readonly at: string
  readonly type: 'user' | 'assistant' | 'attachment' | 'system'
  readonly name?: string
  readonly isMeta: boolean
  readonly isSummary: boolean
  readonly content: readonly unknown[]
  readonly origin?: unknown
  readonly cwd?: string
  readonly path?: string
  readonly model?: string
}

export const messageTypes: readonly MessageType[] = [Prompt, Note, Reply, ToolCall, ToolResult, Skill, Document, Notice]

export const skillPrefix = 'Base directory for this skill:'

const rowTypes: readonly string[] = ['user', 'assistant', 'attachment', 'system']

const memoryPath = /^Contents of (.+?) \(/

export function rowOfLine(row: Readonly<Record<string, unknown>>): Row | undefined {
  const { uuid, timestamp, type } = row
  if (typeof uuid !== 'string' || typeof timestamp !== 'string' || typeof type !== 'string' || !rowTypes.includes(type)) return undefined
  const message = isObject(row['message']) ? row['message'] : {}
  const attachment = isObject(row['attachment']) ? row['attachment'] : {}
  const content = type === 'attachment' ? attachment['content'] : type === 'system' ? row['content'] : message['content']
  const name = type === 'attachment' ? attachment['type'] : row['subtype']
  return {
    id: uuid,
    at: timestamp,
    type: type as Row['type'],
    ...(typeof name === 'string' ? { name } : {}),
    isMeta: row['isMeta'] === true,
    isSummary: row['isCompactSummary'] === true,
    content: blocksOf(content),
    ...(row['origin'] === undefined ? {} : { origin: row['origin'] }),
    ...(typeof row['cwd'] === 'string' ? { cwd: row['cwd'] } : {}),
    ...(typeof attachment['path'] === 'string' ? { path: attachment['path'] } : {}),
    ...(typeof message['model'] === 'string' ? { model: message['model'] } : {}),
  }
}

export function rowOfAppend(append: { readonly uuid: string; readonly door: string; readonly origin: unknown; readonly message: { readonly type: Row['type']; readonly name?: string; readonly isMeta?: true; readonly content: readonly unknown[] } }, at: string, cwd: string): Row {
  const { message, origin } = append
  const text = textOf(message.content)
  const path = message.type === 'attachment' ? memoryPath.exec(text)?.[1] : undefined
  const model = isObject(origin) && origin['kind'] === 'model' && typeof origin['model'] === 'string' ? origin['model'] : undefined
  return {
    id: append.uuid,
    at,
    type: message.type,
    ...(message.name === undefined ? {} : { name: message.name }),
    isMeta: message.isMeta === true,
    isSummary: append.door === 'compaction',
    content: message.content,
    origin,
    cwd,
    ...(path === undefined ? {} : { path }),
    ...(model === undefined ? {} : { model }),
  }
}

export const noFiles: CallFiles = { read: [], changed: [] }

export function messagesOf(row: Row, isInTask: boolean): Unplaced[] {
  const found = unplacedOf(row, isInTask)
  return found.length === 1 ? found : found.map((message, index) => ({ ...message, id: `${row.id}:${index}` }))
}

function unplacedOf(row: Row, isInTask: boolean): Unplaced[] {
  const base = { id: row.id, at: row.at }
  const text = textOf(row.content).trim()
  if (row.type === 'system') return row.name === 'turn_duration' || row.name === 'compact_boundary' || text === '' ? [] : [{ ...base, type: Notice, text }]
  if (row.type === 'attachment') return row.name === 'nested_memory' ? [{ ...base, type: Document, path: row.path ?? '', text }] : []
  if (row.type === 'assistant') {
    return row.content.filter(isObject).flatMap((block): Unplaced[] => {
      if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim() !== '') return [{ ...base, type: Reply, text: block['text'].trim() }]
      if (block['type'] !== 'tool_use' || typeof block['id'] !== 'string' || typeof block['name'] !== 'string') return []
      return [{ ...base, type: ToolCall, callId: block['id'], name: block['name'], input: isObject(block['input']) ? block['input'] : {}, cwd: row.cwd ?? '', files: noFiles }]
    })
  }
  if (row.isSummary) return []
  const results = row.content.filter(isToolResultBlock)
  if (results.length > 0) return results.map((block) => ({ ...base, type: ToolResult, callId: block['tool_use_id'] as string, name: '', input: {}, cwd: row.cwd ?? '', files: noFiles, output: textOf(block['content']), isError: block['is_error'] === true }))
  if (text === '') return []
  if (text.startsWith(skillPrefix)) return [{ ...base, type: Skill, name: basename(text.slice(skillPrefix.length).split('\n')[0]?.trim() ?? ''), text }]
  if (text.startsWith('<task-notification')) return [{ ...base, type: Note, text: tagOf(text, 'summary') ?? text, from: { type: Task } }]
  if (row.isMeta) return [{ ...base, type: Note, text, from: senderOf(row.origin, isInTask) }]
  const prompt = promptText(text)
  return prompt === undefined ? [] : [{ ...base, type: Prompt, text: prompt, from: senderOf(row.origin, isInTask) }]
}

export function withTexts(row: Row, texts: ReadonlyMap<number, string>): readonly unknown[] {
  if (row.type === 'assistant') {
    let index = -1
    return row.content.map((block) => {
      if (!isObject(block)) return block
      const isText = block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim() !== ''
      const isCall = block['type'] === 'tool_use' && typeof block['id'] === 'string' && typeof block['name'] === 'string'
      if (!isText && !isCall) return block
      index += 1
      const text = texts.get(index)
      return isText && text !== undefined ? { ...block, text } : block
    })
  }
  if (row.type === 'user' && row.content.some(isToolResultBlock)) {
    let index = -1
    return row.content.map((block) => {
      if (!isToolResultBlock(block)) return block
      index += 1
      const text = texts.get(index)
      if (text === undefined) return block
      return { ...block, content: Array.isArray(block['content']) ? keepingMedia(block['content'], text) : text }
    })
  }
  const text = texts.get(0)
  if (text === undefined) return row.content
  const whole = textOf(row.content)
  if (whole.trim().startsWith('<task-notification') && tagOf(whole, 'summary') !== undefined) return keepingMedia(row.content, whole.replace(/<summary>[\s\S]*?<\/summary>/, () => `<summary>${text}</summary>`))
  return keepingMedia(row.content, text)
}

function keepingMedia(content: readonly unknown[], text: string): unknown[] {
  return [{ type: 'text', text }, ...content.filter((block) => !isObject(block) || block['type'] !== 'text')]
}

function isToolResultBlock(block: unknown): block is Readonly<Record<string, unknown>> {
  return isObject(block) && block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string'
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => (isObject(block) && block['type'] === 'text' && typeof block['text'] === 'string' ? [block['text']] : [])).join('\n')
}

export function tagOf(text: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim()
}

const toolValueChars = 1024

export function searchText(message: Unplaced): string {
  if (message.type === ToolCall) return [message.name, ...stringsIn(message.input).map((value) => value.slice(0, toolValueChars))].join('\n')
  if (message.type === ToolResult) return ''
  if (message.type === Document) return `${message.path}\n${message.text}`
  return message.text
}

function blocksOf(content: unknown): readonly unknown[] {
  if (Array.isArray(content)) return content
  return typeof content === 'string' && content !== '' ? [{ type: 'text', text: content }] : []
}

function promptText(text: string): string | undefined {
  if (text.startsWith('<local-command-') || text.startsWith('<bash-stdout') || text.startsWith('<bash-stderr')) return undefined
  const command = tagOf(text, 'command-name')
  if (command === undefined) return text
  const args = tagOf(text, 'command-args') ?? ''
  return args === '' ? command : `${command} ${args}`
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  return isObject(value) ? Object.values(value).flatMap(stringsIn) : []
}
