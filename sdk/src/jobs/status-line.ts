import type { Mod, Part } from '../mod.js'
import type { Deadline } from '../runtime/deadline.js'
import { messageOf } from '../utils/text.js'
import { modWithin } from './part-context.js'

export type Usage = {
  model: string
  context: { tokens?: number; window: number; percent?: number }
  cost?: { usd: number }
}

const deadline: Deadline = { ms: 2000, job: 'statusLine' }

export function statusLine<State extends object = Record<never, never>>(options: {
  readonly text: (usage: Usage, mod: Mod<State>) => string | undefined | Promise<string | undefined>
  readonly interval?: number
}): Part<void, State> {
  const { text, interval = 10000 } = options
  return (part) => {
    const { mod, claude, on, announce, reserveName } = part
    if (!(interval >= 1)) throw new Error(`${mod.name}: the status line interval is ${interval}. Give it in milliseconds, 1 or more.`)
    reserveName('statusLine', '', `${mod.name}: a status line is already added. A mod has one status line: join the texts in one statusLine.`)

    const textMod = modWithin(part, deadline)
    let shown: string | undefined
    let queue = Promise.resolve()
    const update = async () => {
      try {
        const [model, usage] = await Promise.all([claude.session.model(), claude.session.usage()])
        const { tokens, window, percent } = usage.context
        const next = await text(
          {
            model,
            context: { window, ...(tokens === undefined ? {} : { tokens }), ...(percent === undefined ? {} : { percent }) },
            ...(usage.cost === undefined ? {} : { cost: { usd: usage.cost.usd } }),
          },
          textMod,
        )
        if (next === shown) return
        shown = next
        claude.ui.status(next)
      } catch (error) {
        claude.ui.log(`${mod.name}: the status line kept its last text: ${messageOf(error)}`, { to: 'debug' })
      }
    }
    const refresh = () => {
      queue = queue.then(update)
    }

    announce('a status line')
    on('session.measure', (e, next) => {
      refresh()
      return next(e)
    })
    claude.clock.every(interval, refresh)
    refresh()
  }
}
