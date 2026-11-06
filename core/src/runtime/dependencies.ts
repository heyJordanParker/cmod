import type { Args, CmodDependencies, EventResult, Frozen } from 'claude-code'
import { installFix } from '../records.js'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import { hookMs } from './deadline.js'
import type { Router } from './router.js'

export const cmodPluginName = 'cmod'

export const loadedMethod = 'cmod:isLoaded'

export async function answerCall(name: string, api: { readonly [method: string]: (input: never) => unknown }, e: Frozen<Args<'cmod.call'>>): Promise<EventResult<'cmod.call'>> {
  const method = Object.hasOwn(api, e.method) ? api[e.method] : undefined
  if (method === undefined) return { deny: `${name} has no method ${e.method}.` }
  try {
    return { value: await method(e.input as never) }
  } catch (error) {
    return { deny: `${name}: ${messageOf(error)}` }
  }
}

export function dependencyCalls(claude: Claude, within: (call: string, task: Promise<unknown>) => Promise<unknown>): CmodDependencies {
  const methodsOf = (to: string) =>
    new Proxy(
      {},
      { get: (_methods, method) => (typeof method === 'string' && method !== 'then' ? (input: unknown) => within(`mod.dependencies.${to}.${method}`, claude.cmod.call({ to, method, input })) : undefined) },
    )
  return new Proxy({}, { get: (_dependencies, to) => (typeof to === 'string' && to !== 'then' ? methodsOf(to) : undefined) }) as CmodDependencies
}

export function withBareRefusals(claude: Claude): Claude {
  const prefix = `${claude.plugin.name}: $.cmod.call: `
  const call: Claude['cmod']['call'] = (input) =>
    claude.cmod.call(input).catch((error: unknown) => {
      const message = messageOf(error)
      throw message.startsWith(prefix) ? new Error(message.slice(prefix.length), { cause: error }) : error
    })
  return { ...claude, cmod: { call } }
}

export function answeringOwnCalls(claude: Claude, router: Router): Claude {
  const name = claude.plugin.name
  const call: Claude['cmod']['call'] = async (input) => {
    if (input.to !== name) return claude.cmod.call(input)
    const answer = await router.dispatch('cmod.call', { ...input, caller: name } as Frozen<Args<'cmod.call'>>, async () => ({ deny: `${name} has no method ${input.method}.` }))
    if (answer.deny !== undefined) throw new Error(answer.deny)
    return answer.value
  }
  return { ...claude, cmod: { call } }
}

export function notInstalled(name: string): string {
  return `${name} is not installed. ${installFix}`
}

export function isNotInstalled(name: string, error: unknown): boolean {
  return messageOf(error).endsWith(notInstalled(name))
}

export function stillInstalling(name: string): string {
  return `${name} is installing. Try again when it's ready.`
}

export function isStillInstalling(name: string, error: unknown): boolean {
  return messageOf(error).endsWith(stillInstalling(name))
}

export function didNotAnswer(name: string): string {
  return `${name} did not answer in time, so Claude Code went on without it.`
}

export const overranHook = `it ran past the ${hookMs / 1000} s Claude Code gives a hook`

export function isUnanswered(error: unknown): boolean {
  const refusals = [stillInstalling(''), didNotAnswer(''), `: ${overranHook}`]
  for (let cause = error; cause !== undefined; cause = cause instanceof Error ? cause.cause : undefined) {
    const message = messageOf(cause)
    if (refusals.some((refusal) => message.endsWith(refusal))) return true
  }
  return false
}
