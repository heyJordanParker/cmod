import type { Job, Mod } from '../mod.js'
import type { Deadline } from '../runtime/deadline.js'
import { engineOf } from '../runtime/engine.js'
import { usageOf } from '../runtime/sessions.js'
import { onStateChange } from '../runtime/state.js'
import type { Usage } from '../session/session.js'
import { messageOf } from '../utils/text.js'
import { withinDeadline } from './context.js'

const deadline: Deadline = { ms: 2000, job: 'statusLine' }

export function statusLine<State extends object = Record<never, never>>(options: { readonly text: (usage: Usage, mod: Mod<State>) => string | undefined | Promise<string | undefined> }): Job<void, State> {
  const { text } = options
  return (job) => {
    const { mod, announce, reserveName } = job
    const { claude, router } = engineOf(mod)
    reserveName('statusLine', '', `${mod.name}: a status line is already added. A mod has one status line: join the texts in one statusLine.`)

    let shown: string | undefined
    let queue = Promise.resolve()
    const update = async () => {
      try {
        const usage = await usageOf(claude)
        const next = await withinDeadline(mod, deadline, 'the status line', () => text(usage, mod))
        if (next === shown) return
        shown = next
        claude.ui.status(next)
      } catch (error) {
        mod.log(`the status line kept its last text: ${messageOf(error)}`)
      }
    }
    const refresh = () => {
      queue = queue.then(update)
    }

    announce('a status line')
    router.add('session.measure', (e, next) => {
      refresh()
      return next(e)
    })
    onStateChange(mod.state, refresh)
    refresh()
  }
}
