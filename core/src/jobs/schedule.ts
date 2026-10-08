import type { Job } from '../mod.js'
import { onStateChange } from '../runtime/state.js'
import { messageOf } from '../utils/text.js'

export type Schedule = { readonly cron: string; readonly prompt: string }

const scheduleCounts = new WeakMap<object, number>()

export function schedule<State extends object = Record<never, never>>(entry: Schedule | ((state: State) => Schedule | undefined)): Job<void, State> {
  if (typeof entry !== 'function') checked(entry)

  return (job) => {
    const { mod, claude } = job
    const order = scheduleCounts.get(mod) ?? 0
    scheduleCounts.set(mod, order + 1)
    const storeKey = `cmod:schedule:${order}`
    const log = (reason: string) => claude.ui.log(`${mod.name}: the schedule ${reason}`)
    let current: { readonly id: string; readonly wanted: string } | undefined
    let isQueued = false

    const remove = async (id: string) => {
      await claude.tool.call({ tool: 'CronDelete', id }).catch(() => undefined)
      await claude.store.delete(storeKey)
    }

    const update = async () => {
      isQueued = false
      let next: Schedule | undefined
      try {
        next = typeof entry === 'function' ? entry(mod.state as State) : entry
        if (next !== undefined) checked(next)
      } catch (error) {
        log(`kept its last cron: ${messageOf(error)}`)
        return
      }
      const wanted = next === undefined ? undefined : JSON.stringify([next.cron, next.prompt])
      if (wanted === current?.wanted) return
      if (current !== undefined) await remove(current.id)
      current = undefined
      if (next === undefined) return
      const answer = await claude.tool.call({ tool: 'CronCreate', cron: next.cron, prompt: next.prompt, recurring: true })
      if (answer.deny !== undefined) return log(`was refused: ${answer.deny}`)
      if (answer.isError === true) return log(`failed: ${answer.text ?? 'CronCreate answered an error'}`)
      current = { id: answer.result.id, wanted: wanted as string }
      await claude.store.set(storeKey, current.id)
    }

    let updates = claude.store
      .get(storeKey)
      .then((left) => (typeof left === 'string' ? remove(left) : undefined))
      .then(update)
      .catch((error: unknown) => log(`failed: ${messageOf(error)}`))
    onStateChange(mod.state, () => {
      if (isQueued) return
      isQueued = true
      updates = updates.then(update).catch((error: unknown) => log(`failed: ${messageOf(error)}`))
    })
    job.announce(typeof entry === 'function' ? 'a schedule from its state' : `a schedule at ${entry.cron}`)
  }
}

function checked(entry: Schedule): void {
  if (entry.cron.trim() === '') throw new Error('schedule: give it a cron, such as "*/10 * * * *" for every 10 minutes.')
  if (entry.prompt.trim() === '') throw new Error('schedule: give it the prompt Claude gets at each fire.')
}
