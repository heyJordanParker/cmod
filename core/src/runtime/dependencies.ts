import type { Args, CmodDependencies, EventResult, Frozen } from 'claude-code'
import { isObject } from '../records.js'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'

export async function callMod(claude: Pick<Claude, 'cmod'>, call: Args<'cmod.call'>): Promise<unknown> {
  const answer = await claude.cmod.call(call)
  if (isObject(answer) && typeof answer['deny'] === 'string') throw new Error(answer['deny'])
  if (isObject(answer) && 'value' in answer) return answer['value']
  throw new Error(`${call.to} answered ${call.method} with neither { value } nor { deny }.`)
}

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
      { get: (_methods, method) => (typeof method === 'string' && method !== 'then' ? (input: unknown) => within(`mod.dependencies.${to}.${method}`, callMod(claude, { to, method, input })) : undefined) },
    )
  return new Proxy({}, { get: (_dependencies, to) => (typeof to === 'string' && to !== 'then' ? methodsOf(to) : undefined) }) as CmodDependencies
}

export function notInstalled(name: string): string {
  return `${name} is not installed. Run cmod install ${name}.`
}
