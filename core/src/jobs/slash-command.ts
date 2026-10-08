import type { CommandRunResult } from 'claude-code'
import type { Job, Mod } from '../mod.js'
import { parse } from '../vendor.js'
import { longestMs, type Deadline } from '../runtime/deadline.js'
import { messageOf } from '../utils/text.js'
import { modWithin } from './context.js'

export type Reply = string | { text?: string; context?: string } | undefined

const deadline: Deadline = { ms: 30000, longestMs, job: 'slashCommand' }

const commandName = /^[A-Za-z0-9_-]{1,64}$/

export function slashCommand<State extends object = Record<never, never>>(options: {
  readonly name: string
  readonly description: string
  readonly argumentHint?: string
  readonly immediate?: true
  readonly reply: (input: { args: string; positionals: string[] }, mod: Mod<State>) => Reply | void | Promise<Reply | void>
}): Job<void, State> {
  const { name, description, argumentHint, immediate, reply } = options
  return (job) => {
    const { mod, announce, reserveName } = job
    const { claude } = mod
    if (!commandName.test(name)) throw new Error(`${mod.name}: "${name}" is not a slash command name. Use 1 to 64 letters, digits, "_", or "-", without the slash.`)
    reserveName('slashCommand', name, `${mod.name}: the slash command /${name} is already added. Give each slashCommand its own name.`)

    let registered: string | undefined
    claude.command.register({ name, description, ...(argumentHint === undefined ? {} : { argumentHint }), ...(immediate === undefined ? {} : { immediate }) }).then(
      ({ command }) => {
        registered = command
      },
      (error: unknown) => {
        claude.ui.log(`${mod.name}: /${name} is not added: ${oneLine(error)}`)
      },
    )
    announce(`/${name}`)

    const replyMod = modWithin(job, deadline)
    claude.on('command.run', async (e, next) => {
      if (e.command !== registered) return next(e)
      try {
        return answerOf(await reply({ args: e.args, positionals: splitWords(e.args) }, replyMod))
      } catch (error) {
        return { text: `/${name} failed: ${oneLine(error)}` }
      }
    })
  }
}

function answerOf(reply: Reply | void): CommandRunResult {
  if (reply === undefined) return {}
  if (typeof reply === 'string') return { text: reply }
  return { ...(reply.text === undefined ? {} : { text: reply.text }), ...(reply.context === undefined ? {} : { context: [reply.context] }) }
}

function splitWords(args: string): string[] {
  return parse(args, (key) => `$${key}`).flatMap((entry) => {
    if (typeof entry === 'string') return [entry]
    if ('comment' in entry) return []
    if (entry.op === 'glob') return [entry.pattern]
    return [entry.op]
  })
}

function oneLine(error: unknown): string {
  return messageOf(error).replace(/\s*\n\s*/g, ' ')
}
