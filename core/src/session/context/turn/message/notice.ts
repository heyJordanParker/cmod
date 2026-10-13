import type { MessageOf } from './message.js'

export const Notice = 'notice'

export type Notice = MessageOf<typeof Notice> & {
  readonly text: string
}
