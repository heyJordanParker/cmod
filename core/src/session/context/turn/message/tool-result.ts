import type { MessageOf } from './message.js'
import type { CallFiles } from './tool-call.js'

export const ToolResult = 'toolResult'

export type ToolResult = MessageOf<typeof ToolResult> & {
  readonly callId: string
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  readonly cwd: string
  readonly files: CallFiles
  readonly output: unknown
  readonly isError: boolean
}
