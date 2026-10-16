import type { Job, JobContext, Mod } from '../mod.js'
import type { Deadline } from '../runtime/deadline.js'
import { engineOf } from '../runtime/engine.js'
import { onStateChange } from '../runtime/state.js'
import { listed, messageOf } from '../utils/text.js'
import { callEffects, type Call } from '../utils/call-effects.js'
import { matchTarget, targetOf, type Target } from './permissions/match-target.js'
import { afterCall, inFolder, targetWords, withinDeadline } from './context.js'

type PromptInput = { call?: Call & { readonly folder: string } }

type PromptOptions<State extends object> = {
  name: string
  prompt: string | ((input: PromptInput, mod: Mod<State>) => string | undefined | Promise<string | undefined>)
  after?: Target | Target[]
}

const deadline: Deadline = { ms: 5000, job: 'prompt' }

export function prompt<State extends object = Record<never, never>>({ name, prompt: text, after }: PromptOptions<State>): Job<void, State> {
  if (name.trim() === '') throw new Error('prompt: give the block a name. Claude reads the text under it.')
  const targets = after === undefined ? [] : Array.isArray(after) ? after : [after]
  for (const target of targets) targetOf(target)

  return (job) => {
    job.reserveName('prompt', name, `prompt: ${job.mod.name} adds the name "${name}" two times. Give each prompt its own name.`)

    const log = (reason: string) => job.mod.log(`prompt "${name}" added nothing: ${reason}`)
    const textFor = async (input: PromptInput) => {
      try {
        const value = typeof text === 'string' ? text : await withinDeadline(job.mod, deadline, `the ${name} prompt`, () => text(input, job.mod))
        return value === '' ? undefined : value
      } catch (error) {
        log(messageOf(error))
        return undefined
      }
    }

    const headedText = async (input: PromptInput) => {
      const value = await textFor(input)
      return value === undefined ? undefined : `# ${name}\n${value}`
    }

    if (targets.length > 0) {
      addAfterCalls(job, targets, headedText, log)
      job.announce(`the ${name} prompt after ${listed(targets.map(targetWords))}`)
    } else {
      addKeptCurrent(job, name, () => textFor({}), log)
      job.announce(`the ${name} prompt`)
    }
  }
}

function addKeptCurrent<State extends object>(job: JobContext<State>, name: string, textFor: () => Promise<string | undefined>, log: (reason: string) => void): void {
  const { claude, router } = engineOf(job.mod)
  let given: string | undefined
  let hasStarted = false
  let isQueued = false
  let updates = Promise.resolve()

  router.add('classic.SessionStart', (e, next) => {
    hasStarted = e.source === 'resume' || e.source === 'compact'
    if (!hasStarted) given = undefined
    return next(e)
  })
  router.add('prompt.context', async (e, next) => {
    const below = await next(e)
    hasStarted = true
    if (below.blocks.some((block) => block.name === name)) {
      log(`a block named "${name}" is already in the context`)
      return below
    }
    given = await textFor()
    return given === undefined ? below : { ...below, blocks: [...below.blocks, { name, text: given }] }
  })

  const update = async () => {
    isQueued = false
    if (!hasStarted) return
    const value = await textFor()
    if (value === undefined || value === given) return
    given = value
    await claude.session.append({ message: { type: 'user', content: [{ type: 'text', text: `# ${name}\n${value}` }] } }).then((added) => {
      if (added.deny !== undefined) log(`Claude Code refused the new text: ${added.deny}`)
    })
  }
  onStateChange(job.mod.state, () => {
    if (isQueued) return
    isQueued = true
    updates = updates.then(update).catch((error: unknown) => log(messageOf(error)))
  })
}

function addAfterCalls<State extends object>(job: JobContext<State>, targets: Target[], textFor: (input: PromptInput) => Promise<string | undefined>, log: (reason: string) => void): void {
  afterCall(
    job,
    async (use, workspace) => {
      const effects = callEffects(use, workspace)
      for (const target of targets) {
        const [matched] = await matchTarget(target, use, effects, workspace)
        if (matched === undefined) continue
        const value = await textFor({ call: await inFolder(matched.call, matched.folder, workspace) })
        return value === undefined ? [] : [value]
      }
      return []
    },
    (error) => {
      log(messageOf(error))
      return []
    },
  )
}
