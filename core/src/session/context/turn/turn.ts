import type { RecordPart } from '../../session.js'
import type { Message } from './message/message.js'
import type { Prompt } from './message/prompt.js'

export const TurnStart = 'turnStart'

export const TurnEnd = 'turnEnd'

export type Turn = RecordPart & {
  readonly prompt: Prompt
  readonly context: number
  readonly openedAt: string
  readonly closedAt?: string
  messages(): Promise<Message[]>
}
