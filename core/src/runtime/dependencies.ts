import type { Args, CmodDependencies, EventResult, Frozen } from 'claude-code'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'

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

export function notInstalled(name: string): string {
  return `${name} is not installed. Run cmod install ${name}.`
}
