import type { Message } from './message/message.js'
import type { Prompt } from './message/prompt.js'

export const TurnStart = 'turnStart'

export const TurnEnd = 'turnEnd'

export type Turn = {
  readonly prompt: Prompt
  readonly context: number
  readonly openedAt: string
  readonly closedAt?: string
  messages(): Promise<Message[]>
}
