import type { Args, Frozen } from 'claude-code'
import type { Disposable } from '../mod.js'
import { ContextEnd } from '../session/context/context.js'
import { Document } from '../session/context/turn/message/document.js'
import { Message, messagesOf, rowOfAppend, withTexts, type Unplaced } from '../session/context/turn/message/message.js'
import { Note } from '../session/context/turn/message/note.js'
import { Notice } from '../session/context/turn/message/notice.js'
import { Prompt } from '../session/context/turn/message/prompt.js'
import { Reply } from '../session/context/turn/message/reply.js'
import { senderOf } from '../session/context/turn/message/sender.js'
import { Skill } from '../session/context/turn/message/skill.js'
import { ToolCall } from '../session/context/turn/message/tool-call.js'
import { ToolResult } from '../session/context/turn/message/tool-result.js'
import { TurnEnd } from '../session/context/turn/turn.js'
import type { ConversationState, SessionChange, TaskData } from '../session/conversation.js'
import { TaskEnd, TaskStart } from '../session/goal/task.js'
import type { BeforeEvent } from '../session/session.js'
import type { Claude } from './claude.js'
import { cmodPluginName } from './dependencies.js'
import type { Router } from './router.js'
import { toolInputOf } from './tool-calls.js'

export type Place = Pick<ConversationState, 'session' | 'context' | 'contextOpenedAt' | 'turn' | 'tasks' | 'taskTurns' | 'openCalls'>

export type Decide = (event: BeforeEvent, change: SessionChange) => Promise<Partial<Answers> | undefined>

export type Answers = { readonly text: string; readonly output: string; readonly refuse: string; readonly input: Readonly<Record<string, unknown>>; readonly result: string; readonly owner: { readonly model: string } }

export type BeforeHooks = { readonly place: () => Promise<Place>; readonly wants: (event: BeforeEvent) => Promise<boolean>; readonly decide: Decide }

const appended: readonly BeforeEvent[] = [Note, Reply, ToolResult, Notice]

const relayTag = /^(?:<cross-session-message[^>]*>\s*)?<cmod-relay>([\s\S]*)<\/cmod-relay>(?:\s*<\/cross-session-message>[\s\S]*)?$/

export function relayOf(e: Frozen<Args<'session.receive'>>): string | undefined {
  const isFromCmod = e.origin.kind === 'peer' && !('teammate' in e.origin) && e.origin.plugin === cmodPluginName
  return isFromCmod ? relayTag.exec(e.text)?.[1] : undefined
}

export function installBefore({ claude, router, hooks }: { readonly claude: Claude; readonly router: Router; readonly hooks: BeforeHooks }): Disposable {
  const { place, wants, decide } = hooks
  const now = () => new Date().toISOString()
  const asked = async (event: BeforeEvent, change: SessionChange) => (await decide(event, change)) ?? {}
  const message = (where: Place, unplaced: Unplaced, task: string | undefined, isInTurn = true): SessionChange => {
    const turn = isInTurn ? (task === undefined ? where.turn : where.taskTurns[task]) : undefined
    const context = task === undefined ? where.context : (where.tasks[task]?.context ?? where.context)
    const call = unplaced.type === ToolResult ? where.openCalls?.[unplaced.callId] : undefined
    return { type: Message, message: { ...unplaced, ...call, session: where.session, context, ...(turn === undefined ? {} : { turn: turn.prompt.id }), ...(task === undefined ? {} : { task }) } as Message }
  }
  const added: Disposable[] = [
    router.add('prompt.submit', async (e, next) => {
      if (!(await wants(Prompt)) || e.text.startsWith('/')) return next(e)
      const where = await place()
      const answer = await asked(Prompt, message(where, { id: '', at: now(), type: Prompt, text: e.text, from: senderOf(e.origin, false) }, undefined, false))
      if (answer.refuse !== undefined) return { drop: answer.refuse }
      return next(answer.text === undefined ? e : { ...e, text: answer.text })
    }),
    router.add('command.run', async (e, next) => {
      if (!(await wants(Prompt))) return next(e)
      const typed = e.args === '' ? `/${e.command}` : `/${e.command} ${e.args}`
      const where = await place()
      const answer = await asked(Prompt, message(where, { id: '', at: now(), type: Prompt, text: typed, from: senderOf(e.origin, false) }, undefined, false))
      if (answer.refuse !== undefined) return { text: answer.refuse }
      if (answer.text === undefined || answer.text === typed) return next(e)
      const same = new RegExp(`^/${e.command}(?:\\s+|$)`).exec(answer.text)
      if (same !== null) return next({ ...e, args: answer.text.slice(same[0].length) })
      void claude.prompt.submit({ text: answer.text })
      return {}
    }),
    router.add('session.receive', async (e, next) => {
      if (!(await wants(Prompt)) || relayOf(e) !== undefined) return next(e)
      const where = await place()
      const answer = await asked(Prompt, message(where, { id: '', at: now(), type: Prompt, text: e.text, from: { type: 'session' } }, e.agentId, false))
      if (answer.refuse !== undefined) return { consumed: answer.refuse }
      return next(answer.text === undefined ? e : { ...e, text: answer.text })
    }),
    router.add('skill.prompt', async (e, next) => {
      if (!(await wants(Skill))) return next(e)
      const where = await place()
      const answer = await asked(Skill, message(where, { id: '', at: now(), type: Skill, name: e.skill, text: e.text }, undefined))
      return answer.text === undefined ? next(e) : { text: answer.text }
    }),
    router.add('prompt.attachment', async (e, next) => {
      if (!(await wants(Document)) || e.type !== 'nested_memory') return next(e)
      const where = await place()
      const path = /^Contents of (.+?) \(/.exec(e.text)?.[1] ?? ''
      const answer = await asked(Document, message(where, { id: '', at: now(), type: Document, path, text: e.text }, e.agentId))
      if (answer.refuse !== undefined) return { text: null }
      return answer.text === undefined ? next(e) : { text: answer.text }
    }),
    router.add('session.append', async (e, next) => {
      const wanted = new Set((await Promise.all(appended.map(async (event) => ((await wants(event)) ? [event] : [])))).flat())
      if (wanted.size === 0) return next(e)
      const row = rowOfAppend({ uuid: e.uuid, door: e.door, origin: e.origin, message: e.message }, now(), '')
      const found = messagesOf(row, e.agentId !== undefined)
      if (!found.some((each) => wanted.has(each.type))) return next(e)
      const where = await place()
      const texts = new Map<number, string>()
      for (const [part, unplaced] of found.entries()) {
        if (!wanted.has(unplaced.type)) continue
        const answer = await asked(unplaced.type, message(where, unplaced, e.agentId))
        const text = unplaced.type === ToolResult ? answer.output : answer.text
        if (text !== undefined) texts.set(part, text)
      }
      return next(texts.size === 0 ? e : { ...e, message: { ...e.message, content: withTexts(row, texts) as typeof e.message.content } })
    }),
    router.add('tool.call', async (e, next) => {
      if (!(await wants(ToolCall))) return next(e)
      const where = await place()
      const input = toolInputOf(e)
      const answer = await asked(ToolCall, message(where, { id: e.tool_use_id, at: now(), type: ToolCall, callId: e.tool_use_id, name: e.tool, input, cwd: await claude.session.cwd() }, e.agentId))
      if (answer.refuse !== undefined) return { deny: answer.refuse }
      if (answer.result !== undefined) return { result: answer.result }
      if (answer.input === undefined) return next(e)
      const reserved = Object.fromEntries(Object.entries(e).filter(([key]) => !(key in input)))
      return next({ ...reserved, ...answer.input } as Frozen<Args<'tool.call'>>)
    }),
    router.add('agent.spawn', async (e, next) => {
      if (!(await wants(TaskStart))) return next(e)
      const where = await place()
      const task: TaskData = { id: '', title: e.description, agentType: e.subagentType, model: e.model ?? e.parentModel, openedBy: e.tool_use_id, openedAt: now(), ...(e.parentAgentId === undefined ? {} : { parent: e.parentAgentId }) }
      const answer = await asked(TaskStart, { type: TaskStart, task: { ...task, context: where.context } })
      if (answer.refuse !== undefined) return { deny: answer.refuse }
      return next(answer.owner === undefined ? e : { ...e, model: answer.owner.model })
    }),
    router.add('classic.SubagentStop', async (e, next) => {
      if (!(await wants(TaskEnd)) && !(await wants(TurnEnd))) return next(e)
      const where = await place()
      const task = where.tasks[e.agent_id]
      if (task === undefined) return next(e)
      const turn = where.taskTurns[e.agent_id]
      const ending = (await wants(TaskEnd)) ? await asked(TaskEnd, { type: TaskEnd, task: { ...task, closedAt: now() } }) : {}
      const refuse = ending.refuse ?? ((await wants(TurnEnd)) && turn !== undefined ? (await asked(TurnEnd, { type: TurnEnd, turn: { ...turn, closedAt: now() } })).refuse : undefined)
      const below = await next(e)
      return refuse === undefined ? below : { ...below, block: refuse }
    }),
    router.add('classic.Stop', async (e, next) => {
      if (!(await wants(TurnEnd))) return next(e)
      const where = await place()
      if (where.turn === undefined) return next(e)
      const answer = await asked(TurnEnd, { type: TurnEnd, turn: { ...where.turn, closedAt: now() } })
      const below = await next(e)
      return answer.refuse === undefined ? below : { ...below, block: answer.refuse }
    }),
    router.add('session.compact', async (e, next) => {
      if (!(await wants(ContextEnd)) || e.trigger === 'precompute') return next(e)
      const where = await place()
      const task = e.agentId === undefined ? undefined : where.tasks[e.agentId]
      if (e.agentId !== undefined && task === undefined) return next(e)
      const context = task === undefined ? { number: where.context, openedAt: where.contextOpenedAt } : { number: task.context, openedAt: task.contextOpenedAt ?? task.openedAt, task: task.id }
      const answer = await asked(ContextEnd, { type: ContextEnd, context: { ...context, closedAt: now() } })
      return answer.refuse === undefined ? next(e) : { skip: answer.refuse }
    }),
  ]
  return { dispose: () => added.forEach((each) => each.dispose()) }
}

export function withAnswer(change: SessionChange, answer: Partial<Answers>): SessionChange {
  if (change.type === Message && answer.output !== undefined && change.message.type === ToolResult) return { ...change, message: { ...change.message, output: answer.output } }
  if (change.type === Message && answer.text !== undefined) return { ...change, message: { ...change.message, text: answer.text } as Message }
  if (change.type === Message && answer.input !== undefined && change.message.type === ToolCall) return { ...change, message: { ...change.message, input: answer.input } }
  if (change.type === TaskStart && answer.owner !== undefined) return { ...change, task: { ...change.task, model: answer.owner.model } }
  return change
}

export async function foldAnswers(event: BeforeEvent, change: SessionChange, askers: readonly ((change: SessionChange) => Promise<unknown>)[], report: (error: unknown) => void): Promise<Partial<Answers> | undefined> {
  let latest = change
  let result: Partial<Answers> | undefined
  for (const ask of askers) {
    try {
      const answer = answerOf(event, await ask(latest))
      if (answer === undefined) continue
      result = { ...result, ...answer }
      if (answer.refuse !== undefined || answer.result !== undefined) return result
      latest = withAnswer(latest, answer)
    } catch (error) {
      report(error)
    }
  }
  return result
}

export function answerOf(event: BeforeEvent, answer: unknown): Partial<Answers> | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined
  const given = answer as Partial<Answers>
  const allowed: Readonly<Record<BeforeEvent, readonly (keyof Answers)[]>> = {
    prompt: ['text', 'refuse'],
    note: ['text'],
    skill: ['text'],
    document: ['text', 'refuse'],
    reply: ['text'],
    toolCall: ['input', 'result', 'refuse'],
    toolResult: ['text'],
    notice: ['text'],
    taskStart: ['owner', 'refuse'],
    taskEnd: ['refuse'],
    turnEnd: ['refuse'],
    contextEnd: ['refuse'],
  }
  const unread = Object.keys(given).filter((key) => !allowed[event].includes(key as keyof Answers))
  if (unread.length > 0) throw new Error(`a before(${event}) listener answered ${unread.join(' and ')}, which ${event} does not take. It takes ${allowed[event].map((key) => `{ ${key} }`).join(', ')}.`)
  return given
}
