import type { MessageOf } from './message.js'
import type { Sender } from './sender.js'

export const Note = 'note'

export type Note = MessageOf<typeof Note> & {
  readonly text: string
  readonly from: Sender
}
