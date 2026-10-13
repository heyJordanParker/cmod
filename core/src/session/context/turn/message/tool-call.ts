import type { MessageOf } from './message.js'

export const ToolCall = 'toolCall'

export type ToolCall = MessageOf<typeof ToolCall> & {
  readonly callId: string
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  readonly cwd: string
}
