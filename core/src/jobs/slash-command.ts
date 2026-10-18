import type { CommandRunResult } from 'claude-code'
import type { Disposable, Job, Mod } from '../mod.js'
import { parse } from '../vendor.js'
import type { Deadline } from '../runtime/deadline.js'
import { engineOf } from '../runtime/engine.js'
import { modNote } from '../session/context/turn/message/note.js'
import { messageOf } from '../utils/text.js'
import { withinDeadline } from './context.js'

export type CommandReply = string | { text?: string; note?: string } | undefined

const deadline: Deadline = { ms: 30000, job: 'slashCommand' }

const commandName = /^[A-Za-z0-9_-]{1,64}$/

export function slashCommand<State extends object = Record<never, never>>(options: {
  readonly name: string
  readonly description: string
  readonly argumentHint?: string
  readonly immediate?: true
  readonly reply: (input: { args: string; positionals: string[] }, mod: Mod<State>) => CommandReply | void | Promise<CommandReply | void>
}): Job<Disposable, State> {
  const { name, description, argumentHint, immediate, reply } = options
  return (job) => {
    const { mod, announce, reserveName } = job
    const { claude, router, report } = engineOf(mod)
    if (!commandName.test(name)) throw new Error(`${mod.name}: "${name}" is not a slash command name. Use 1 to 64 letters, digits, "_", or "-", without the slash.`)
    const reserved = reserveName('slashCommand', name, `${mod.name}: the slash command /${name} is already added. Give each slashCommand its own name.`)

    let registered: string | undefined
    claude.command.register({ name, description, ...(argumentHint === undefined ? {} : { argumentHint }), ...(immediate === undefined ? {} : { immediate }) }).then(
      ({ command }) => {
        registered = command
      },
      (error: unknown) => {
        report({ id: `command:${name}`, message: `/${name} is not added`, error })
      },
    )
    announce(`/${name}`)

    const answering = router.add('command.run', async (e, next) => {
      if (e.command !== registered) return next(e)
      try {
        return answerOf(mod.name, await withinDeadline(mod, deadline, `/${name}`, () => reply({ args: e.args, positionals: splitWords(e.args) }, mod)))
      } catch (error) {
        return { text: `/${name} failed: ${oneLine(error)}` }
      }
    })
    return {
      dispose() {
        answering.dispose()
        reserved.dispose()
      },
    }
  }
}

function answerOf(name: string, reply: CommandReply | void): CommandRunResult {
  if (reply === undefined) return {}
  if (typeof reply === 'string') return { text: reply }
  return { ...(reply.text === undefined ? {} : { text: reply.text }), ...(reply.note === undefined ? {} : { context: [modNote(name, reply.note)] }) }
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
