import type { MessageOf } from './message.js'

export const Skill = 'skill'

export type Skill = MessageOf<typeof Skill> & {
  readonly name: string
  readonly text: string
}
