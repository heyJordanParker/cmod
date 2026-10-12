import type { ToolCall } from './utils/call-effects.js'

export type Session = {
  readonly id: string
  readonly title: string
  readonly project: string
  readonly startedAt: string
  readonly lastAt: string
  readonly forkedFrom?: string
}

export type Sender =
  | { readonly kind: 'person' }
  | { readonly kind: 'claude' }
  | { readonly kind: 'mod'; readonly name: string }
  | { readonly kind: 'agent' }
  | { readonly kind: 'session' }
  | { readonly kind: 'schedule' }
  | { readonly kind: 'channel'; readonly name: string }
  | { readonly kind: 'sdk' }
  | { readonly kind: 'claude-code'; readonly reason: 'skill' | 'instructions' | 'compaction' | 'notification'; readonly name?: string }
  | { readonly kind: 'unknown' }

export type Message = {
  readonly id: string
  readonly session: string
  readonly agent?: string
  readonly at: string
  readonly from: Sender
  readonly text: string
  readonly tools: readonly (ToolCall & { readonly id: string; readonly result?: string; readonly isError?: boolean; readonly subagent?: string })[]
}

export const searchLimit = 50

const toolValueChars = 1024

export function searchText(message: Message): string {
  return [message.text, ...message.tools.flatMap((tool) => stringsIn(tool.input).map((value) => value.slice(0, toolValueChars)))].join('\n')
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  return typeof value === 'object' && value !== null ? Object.values(value).flatMap(stringsIn) : []
}
