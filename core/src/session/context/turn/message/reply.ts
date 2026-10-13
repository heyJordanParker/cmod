import type { MessageOf } from './message.js'

export const Reply = 'reply'

export type Reply = MessageOf<typeof Reply> & {
  readonly text: string
}
