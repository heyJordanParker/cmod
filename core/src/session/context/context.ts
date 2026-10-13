import type { Turn } from './turn/turn.js'

export const ContextStart = 'contextStart'

export const ContextEnd = 'contextEnd'

export type Context = {
  readonly number: number
  readonly openedAt: string
  readonly closedAt?: string
  turns(): Promise<Turn[]>
}
