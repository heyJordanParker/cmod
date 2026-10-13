import type { MessageOf } from './message.js'
import type { Sender } from './sender.js'

export const Prompt = 'prompt'

export type Prompt = MessageOf<typeof Prompt> & {
  readonly text: string
  readonly from: Sender
}
