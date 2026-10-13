import { isObject } from '../../../../records.js'
import { Task } from '../../../goal/task.js'

export const Person = 'person'

export const Mod = 'mod'

export const Schedule = 'schedule'

export const Channel = 'channel'

export const Sdk = 'sdk'

export type SenderType = typeof Person | typeof Mod | 'session' | typeof Task | typeof Schedule | typeof Channel | typeof Sdk

export type Sender = {
  readonly type: SenderType
  readonly name?: string
  readonly as?: typeof Person
}

const personOrigins: readonly string[] = ['human', 'composer', 'bridge', 'slack-ping', 'auto-continuation']

const sessionOrigins: readonly string[] = ['peer', 'peer-send-message', 'coordinator', 'projects-relay', 'observer', 'observer-activity']

export function senderOf(origin: unknown, isInTask: boolean): Sender {
  const fields: Readonly<Record<string, unknown>> = isObject(origin) ? origin : {}
  const kind = typeof fields['kind'] === 'string' ? fields['kind'] : undefined
  if (kind === undefined) return { type: isInTask ? Task : Person }
  if (personOrigins.includes(kind)) return { type: Person }
  if (sessionOrigins.includes(kind)) return { type: 'session' }
  if (kind === 'plugin' && typeof fields['name'] === 'string') return { type: Mod, name: fields['name'], ...(fields['asUser'] === true ? { as: Person } : {}) }
  if (kind === 'scheduled-trigger') return { type: Schedule }
  if (kind === 'channel' && typeof fields['server'] === 'string') return { type: Channel, name: fields['server'] }
  if (kind === 'sdk') return { type: Sdk }
  if (kind === 'task-notification') return { type: Task }
  return { type: isInTask ? Task : Person }
}
