import type { MessageOf } from './message.js'

export const ToolResult = 'toolResult'

export type ToolResult = MessageOf<typeof ToolResult> & {
  readonly callId: string
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  readonly output: unknown
  readonly isError: boolean
}
