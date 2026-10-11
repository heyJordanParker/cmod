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
