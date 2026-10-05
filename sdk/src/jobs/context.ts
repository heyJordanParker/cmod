import type { Mod, Part, PartContext } from '../mod.js'
import { listed, messageOf } from '../utils/text.js'
import { callEffects, type ToolCall, type ToolUse } from '../utils/call-effects.js'
import type { Workspace } from './permissions/find-project-scope.js'
import { matchTarget, targetOf, type Target } from './permissions/match-target.js'
import { modOf, modWithin, reserveName, targetWords, useOf, workspaceOf } from './tool-calls.js'

type ContextOptions<State extends object> = {
  name: string
  text: string | ((input: { prompt?: string; call?: ToolCall }, mod: Mod<State>) => string | undefined | Promise<string | undefined>)
  when?: RegExp | ((prompt: string) => boolean)
  after?: Target | Target[]
}

const deadline = { ms: 5000, job: 'context' }

export function context<State extends object = Record<never, never>>({ name, text, when, after }: ContextOptions<State>): Part<void, State> {
  if (name.trim() === '') throw new Error('context: give the block a name. Claude reads the text under it.')
  if (when !== undefined && after !== undefined) throw new Error(`context "${name}": use when or after, not both. Add a second context for the other trigger.`)
  const targets = after === undefined ? [] : Array.isArray(after) ? after : [after]
  for (const target of targets) targetOf(target)

  return (part) => {
    reserveName(part.mod, 'context', name, `context: ${part.mod.name} adds the name "${name}" two times. Give each context its own name.`)

    const log = (reason: string) => part.claude.ui.log(`context "${name}" added nothing: ${reason}`, { to: 'debug' })
    const textFor = async (input: { prompt?: string; call?: ToolCall }, mod: Mod<State>) => {
      try {
        const value = typeof text === 'string' ? text : await text(input, mod)
        return value === '' ? undefined : value
      } catch (error) {
        log(messageOf(error))
        return undefined
      }
    }

    if (when !== undefined) {
      addAfterPrompts(part, when, (prompt) => textFor({ prompt }, modWithin(part, deadline)), log)
      part.adds(`the ${name} context after matching prompts`)
    } else if (targets.length > 0) {
      addAfterCalls(part, targets, textFor, log)
      part.adds(`the ${name} context after ${listed(targets.map(targetWords))}`)
    } else {
      addOncePerConversation(part, name, () => textFor({}, modWithin(part, deadline)), log)
      part.adds(`the ${name} context`)
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

function addAfterPrompts(part: PartContext, when: RegExp | ((prompt: string) => boolean), textFor: (prompt: string) => Promise<string | undefined>, log: (reason: string) => void): void {
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
  textFor: (input: { call: ToolCall }, mod: Mod<State>) => Promise<string | undefined>,
  log: (reason: string) => void,
): void {
  const textAfter = async (before: Promise<[ToolUse, Workspace]>) => {
    try {
      const [use, workspace] = await before
      const effects = callEffects(use, workspace)
      for (const target of targets) {
        const [matched] = await matchTarget(target, use, effects, workspace)
        if (matched !== undefined) return await textFor({ call: matched.call }, modOf(part, matched.call, matched.folder, workspace, deadline))
      }
    } catch (error) {
      log(messageOf(error))
    }
    return undefined
  }
  part.on('tool.call', async (e, next) => {
    const before = Promise.all([useOf(part, e), workspaceOf(part)])
    await Promise.allSettled([before])
    const result = await next(e)
    if (result.deny !== undefined || result.isError === true) return result
    const value = await textAfter(before)
    return value === undefined ? result : { ...result, context: [...(result.context ?? []), value] }
  })
}
