import type { RecordPart } from '../session.js'
import type { Turn } from './turn/turn.js'

export const ContextStart = 'contextStart'

export const ContextEnd = 'contextEnd'

export type Context = RecordPart & {
  readonly number: number
  readonly openedAt: string
  readonly closedAt?: string
  readonly task?: string
  turns(): Promise<Turn[]>
}
