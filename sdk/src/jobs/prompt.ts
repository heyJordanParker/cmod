import type { Mod, Part, PartContext } from '../mod.js'
import { longestMs, type Deadline } from '../runtime/deadline.js'
import { listed, messageOf } from '../utils/text.js'
import { callEffects, type ToolCall } from '../utils/call-effects.js'
import { matchTarget, targetOf, type Target } from './permissions/match-target.js'
import { afterCall, modOf, modWithin, targetWords } from './part-context.js'

type PromptInput = { userPrompt?: string; call?: ToolCall }

type PromptOptions<State extends object> = {
  name: string
  prompt: string | ((input: PromptInput, mod: Mod<State>) => string | undefined | Promise<string | undefined>)
  when?: RegExp | ((userPrompt: string) => boolean)
  after?: Target | Target[]
}

const deadline: Deadline = { ms: 5000, longestMs, job: 'prompt' }

export function prompt<State extends object = Record<never, never>>({ name, prompt: text, when, after }: PromptOptions<State>): Part<void, State> {
  if (name.trim() === '') throw new Error('prompt: give the block a name. Claude reads the text under it.')
  if (when !== undefined && after !== undefined) throw new Error(`prompt "${name}": use when or after, not both. Add a second prompt for the other trigger.`)
  const targets = after === undefined ? [] : Array.isArray(after) ? after : [after]
  for (const target of targets) targetOf(target)

  return (part) => {
    part.reserveName('prompt', name, `prompt: ${part.mod.name} adds the name "${name}" two times. Give each prompt its own name.`)

    const log = (reason: string) => part.claude.ui.log(`prompt "${name}" added nothing: ${reason}`, { to: 'debug' })
    const textFor = async (input: PromptInput, mod: Mod<State>) => {
      try {
        const value = typeof text === 'string' ? text : await text(input, mod)
        return value === '' ? undefined : value
      } catch (error) {
        log(messageOf(error))
        return undefined
      }
    }

    const headedText = async (input: PromptInput, mod: Mod<State>) => {
      const value = await textFor(input, mod)
      return value === undefined ? undefined : `# ${name}\n${value}`
    }

    if (when !== undefined) {
      addAfterUserPrompts(part, when, (userPrompt) => headedText({ userPrompt }, modWithin(part, deadline)), log)
      part.announce(`the ${name} prompt after matching user prompts`)
    } else if (targets.length > 0) {
      addAfterCalls(part, targets, headedText, log)
      part.announce(`the ${name} prompt after ${listed(targets.map(targetWords))}`)
    } else {
      addOncePerConversation(part, name, () => textFor({}, modWithin(part, deadline)), log)
      part.announce(`the ${name} prompt`)
    }
  }
}

function addOncePerConversation(part: PartContext, name: string, textFor: () => Promise<string | undefined>, log: (reason: string) => void): void {
  part.on('prompt.context', async (e, next) => {
    const below = await next(e)
    if (below.blocks.some((block) => block.name === name)) {
      log(`a block named "${name}" is already in the context`)
      return below
    }
    const value = await textFor()
    return value === undefined ? below : { ...below, blocks: [...below.blocks, { name, text: value }] }
  })
}

function addAfterUserPrompts(part: PartContext, when: RegExp | ((userPrompt: string) => boolean), textFor: (userPrompt: string) => Promise<string | undefined>, log: (reason: string) => void): void {
  part.on('prompt.submit', async (e, next) => {
    let value: string | undefined
    try {
      if (typeof when === 'function' ? when(e.text) : e.text.search(when) >= 0) value = await textFor(e.text)
    } catch (error) {
      log(`its when check failed: ${messageOf(error)}`)
    }
    return next(value === undefined ? e : { ...e, context: [...(e.context ?? []), value] })
  })
}

function addAfterCalls<State extends object>(
  part: PartContext<State>,
  targets: Target[],
  textFor: (input: PromptInput, mod: Mod<State>) => Promise<string | undefined>,
  log: (reason: string) => void,
): void {
  afterCall(
    part,
    async (use, workspace) => {
      const effects = callEffects(use, workspace)
      for (const target of targets) {
        const [matched] = await matchTarget(target, use, effects, workspace)
        if (matched === undefined) continue
        const value = await textFor({ call: matched.call }, modOf(part, matched.call, matched.folder, workspace, deadline))
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
