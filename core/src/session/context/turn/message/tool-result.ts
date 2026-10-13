import type { MessageOf } from './message.js'

export const ToolResult = 'toolResult'

export type ToolResult = MessageOf<typeof ToolResult> & {
  readonly callId: string
  readonly text: string
  readonly isError: boolean
}
