import type { MessageOf } from './message.js'

export const Document = 'document'

export type Document = MessageOf<typeof Document> & {
  readonly path: string
  readonly text: string
}
