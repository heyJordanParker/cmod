import type { MessageOf } from './message.js'

export const InstructionFile = 'instructionFile'

export type InstructionFile = MessageOf<typeof InstructionFile> & {
  readonly path: string
  readonly text: string
  readonly isRule: boolean
}

export function isRulePath(path: string): boolean {
  return /(^|\/)\.claude[^/]*\/rules\//.test(path)
}
