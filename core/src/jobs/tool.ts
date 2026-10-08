import type { FromSchema, JSONSchema } from 'json-schema-to-ts'
import type { Job, Mod } from '../mod.js'
import { Validator } from '../vendor.js'
import { toolDeadline } from '../runtime/deadline.js'
import { reservedKeys, toolInputOf } from '../runtime/tool-calls.js'
import { messageOf } from '../utils/text.js'
import { modWithin } from './context.js'

const toolName = /^[A-Za-z0-9_-]{1,64}$/

export function tool<const Schema extends object = { type: 'object' }, State extends object = Record<never, never>>(options: {
  readonly name: string
  readonly description: string
  readonly inputSchema?: Schema
  readonly execute: (input: Schema extends JSONSchema ? FromSchema<Schema> : never, mod: Mod<State>) => unknown
}): Job<{ readonly name: string }, State> {
  const { name, description, inputSchema, execute } = options
  return (job) => {
    const { mod, announce, reserveName } = job
    const { claude } = mod
    if (!toolName.test(name)) throw new Error(`${mod.name}: "${name}" is not a tool name. Use 1 to 64 letters, digits, "_", or "-".`)
    const properties = (inputSchema as { properties?: object } | undefined)?.properties ?? {}
    const reserved = reservedKeys.filter((key) => Object.hasOwn(properties, key))
    if (reserved.length > 0) throw new Error(`${mod.name}: the ${name} tool's inputSchema has the property ${reserved.join(', ')}, which Claude Code keeps for itself. Rename it.`)
    reserveName('tool', name, `${mod.name}: the tool ${name} is already added. Give each tool its own name.`)

    const validator = new Validator((inputSchema ?? { type: 'object' }) as ConstructorParameters<typeof Validator>[0], '2020-12', false)
    let registered: string | undefined
    claude.tool.register({ name, description, ...(inputSchema === undefined ? {} : { inputSchema: inputSchema as Record<string, unknown> }) }).then(
      (answer) => {
        registered = answer.tool
      },
      (error: unknown) => {
        claude.ui.log(`${mod.name}: the ${name} tool is not added: ${messageOf(error)}`)
      },
    )
    announce(`the ${name} tool`)

    const executeMod = modWithin(job, toolDeadline)
    claude.on('tool.call', async (e, next) => {
      if (e.tool !== registered) return next(e)
      const input = toolInputOf(e)
      const { valid, errors } = validator.validate(input)
      if (!valid) return { deny: `The ${name} tool input is not valid:\n${errors.map((error) => `- ${error.instanceLocation}: ${error.error}`).join('\n')}` }
      try {
        return { result: resultOf(await execute(input as Parameters<typeof execute>[0], executeMod)) }
      } catch (error) {
        return { deny: `The ${name} tool failed: ${messageOf(error)}` }
      }
    })
    return { name: `mcp__${claude.plugin.name}__${name}` }
  }
}

function resultOf(value: unknown): unknown {
  if (value === undefined || typeof value === 'string') return value
  if (Array.isArray(value) && value.every((block) => typeof block === 'object' && block !== null && 'type' in block)) return value
  return JSON.stringify(value)
}
