import type { Args, EventResult, Frozen } from 'claude-code'
import type { Subscription } from '../utils/subscription.js'
import { ContextEnd } from '../session/context/context.js'
import { AttachedFile, attachedPathOf, attachmentTypeOf } from '../session/context/turn/message/attached-file.js'
import { InstructionFile, isRulePath } from '../session/context/turn/message/instruction-file.js'
import { instructionPathOf, Message, messagesOf, noFiles, rowOfAppend, withTexts, type Unplaced } from '../session/context/turn/message/message.js'
import { Note, untagged } from '../session/context/turn/message/note.js'
import { Notice } from '../session/context/turn/message/notice.js'
import { Prompt } from '../session/context/turn/message/prompt.js'
import { Reply } from '../session/context/turn/message/reply.js'
import { senderOf } from '../session/context/turn/message/sender.js'
import { Skill } from '../session/context/turn/message/skill.js'
import { ToolCall } from '../session/context/turn/message/tool-call.js'
import { ToolResult } from '../session/context/turn/message/tool-result.js'
import { TurnEnd } from '../session/context/turn/turn.js'
import { ownerOfSpawn, type ContextData, type ConversationState, type RunningTask, type SessionChange, type TaskData } from '../session/conversation.js'
import { Task, TaskStart } from '../session/goal/task.js'
import { sessionEvents, type BeforeEvent, type SessionEvent } from '../session/session.js'
import type { Claude } from './claude.js'
import { cmodPluginName } from './dependencies.js'
import type { Router } from './router.js'
import { toolInputOf } from './tool-calls.js'
import { resolve } from '../vendor.js'

export type Place = Pick<ConversationState, 'session' | 'context' | 'contextOpenedAt' | 'turn' | 'tasks' | 'taskTurns' | 'openCalls'>

export type Decide = (event: BeforeEvent, change: SessionChange) => Promise<Partial<Answers> | undefined>

export type Answers = {
  readonly text: string
  readonly output: unknown
  readonly isError: true
  readonly note: string
  readonly title: string
  readonly refuse: string
  readonly input: Readonly<Record<string, unknown>>
  readonly result: string
  readonly prompt: string
  readonly owner: { readonly agentType?: string; readonly model?: string; readonly cwd?: string }
  readonly isAsync: boolean
}

export type BeforeHooks = { readonly place: () => Promise<Place>; readonly wants: (event: BeforeEvent) => Promise<boolean>; readonly fold: () => Decide }

const appended: readonly BeforeEvent[] = [Note, Reply, Notice]

type ClassicFields = Readonly<Record<string, unknown>>

const withNote = (below: unknown, note: string | undefined): ClassicFields => {
  const fields = (below ?? {}) as ClassicFields
  return note === undefined ? fields : { ...fields, additionalContext: [...((fields['additionalContext'] as readonly string[] | undefined) ?? []), note] }
}

const withContext = (ran: EventResult<'tool.call'>, note: string | undefined): EventResult<'tool.call'> =>
  note === undefined || ran.deny !== undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }

const relayTag =/^(?:<cross-session-message[^>]*>\s*)?<cmod-relay>([\s\S]*)<\/cmod-relay>(?:\s*<\/cross-session-message>[\s\S]*)?$/

export function relayOf(e: Frozen<Args<'session.receive'>>): string | undefined {
  const isFromCmod = e.origin.kind === 'peer' && !('teammate' in e.origin) && e.origin.plugin === cmodPluginName
  return isFromCmod ? relayTag.exec(e.text)?.[1] : undefined
}

export function installBefore({ claude, router, hooks }: { readonly claude: Claude; readonly router: Router; readonly hooks: BeforeHooks }): Subscription {
  const { place, wants, fold } = hooks
  const now = () => new Date().toISOString()
  const asked = async (event: BeforeEvent, change: SessionChange, decide: Decide = fold()) => (await decide(event, change)) ?? {}
  const message = (where: Place, unplaced: Unplaced, task: string | undefined, isInTurn = true): SessionChange => {
    const turn = isInTurn ? (task === undefined ? where.turn : where.taskTurns[task]) : undefined
    const context = task === undefined ? where.context : (where.tasks[task]?.context ?? where.context)
    const call = unplaced.type === ToolResult ? where.openCalls?.[unplaced.callId] : undefined
    return { type: Message, message: { ...unplaced, ...call, session: where.session, context, ...(turn === undefined ? {} : { turn: turn.prompt.id }), ...(task === undefined ? {} : { task }) } as Message }
  }
  const titles = new Map<string, string>()
  const spawned = new Map<string, { readonly prompt: string; readonly agentType: string }>()
  const startedBy = new Map<string, string>()
  const startingSpawn = (agentId: string, agentType: string) => {
    const known = startedBy.get(agentId)
    if (known !== undefined) return known
    const waiting = [...spawned].filter(([call, spawn]) => spawn.agentType === agentType && ![...startedBy.values()].includes(call))
    return waiting.length === 1 ? waiting[0]?.[0] : undefined
  }
  const agentFolders = new Map<string, string>()
  const toolResultHook = (isFailure: boolean) => async (e: Readonly<Record<string, unknown>>, next: (e: never) => Promise<unknown>) => {
    if (!(await wants(ToolResult))) return next(e as never)
    const where = await place()
    const name = String(e['tool_name'])
    const callId = String(e['tool_use_id'])
    const input = (typeof e['tool_input'] === 'object' && e['tool_input'] !== null ? e['tool_input'] : {}) as Readonly<Record<string, unknown>>
    const task = typeof e['agent_id'] === 'string' ? e['agent_id'] : undefined
    const result = { id: callId, at: now(), type: ToolResult, callId, name, input, cwd: String(e['cwd']), files: noFiles, output: isFailure ? e['error'] : e['tool_response'], isError: isFailure } as const
    const answer = await asked(ToolResult, message(where, result, task))
    const below = await next(e as never)
    const rewritten = answer.output === undefined || isFailure ? {} : name.startsWith('mcp__') ? { updatedMCPToolOutput: answer.output } : { updatedToolOutput: answer.output }
    const failed = answer.isError === true && !isFailure ? { block: answer.note === undefined ? `${name} failed.` : untagged(answer.note) } : {}
    return { ...withNote(below, answer.isError === true ? undefined : answer.note), ...rewritten, ...failed }
  }
  const added: Subscription[] = [
    router.add('prompt.submit', async (e, next) => {
      if (!(await wants(Prompt))) return next(e)
      const where = await place()
      const answer = await asked(Prompt, message(where, { id: '', at: now(), type: Prompt, text: e.text, from: senderOf(e.origin, false) }, undefined, false))
      if (answer.refuse !== undefined) return { drop: answer.refuse }
      const text = answer.text ?? e.text
      if (answer.title !== undefined) titles.set(text, answer.title)
      const context = answer.note === undefined ? e.context : [...(e.context ?? []), answer.note]
      const ran = await next({ ...e, text, ...(context === undefined ? {} : { context }) })
      const passed = titles.get(text)
      if (passed !== undefined && ('drop' in ran || ran.text !== text)) {
        titles.delete(text)
        if (!('drop' in ran) && typeof ran.text === 'string') titles.set(ran.text, passed)
      }
      return ran
    }),
    router.add('classic.UserPromptSubmit', async (e, next) => {
      const named = titles.get(e.prompt)
      titles.delete(e.prompt)
      const below = await next(e)
      return named === undefined ? below : { ...below, sessionTitle: named }
    }),
    router.add('classic.PostToolUse', toolResultHook(false) as never),
    router.add('classic.PostToolUseFailure', toolResultHook(true) as never),
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
      const attachmentType = attachmentTypeOf(e.type)
      const event = e.type === 'nested_memory' ? InstructionFile : attachmentType === undefined ? undefined : AttachedFile
      if (event === undefined || !(await wants(event))) return next(e)
      const where = await place()
      const found: Unplaced =
        attachmentType === undefined
          ? { id: '', at: now(), type: InstructionFile, path: instructionPathOf(e.text), text: e.text, isRule: isRulePath(instructionPathOf(e.text)) }
          : { id: '', at: now(), type: AttachedFile, path: attachedPathOf(e.text), attachmentType, text: e.text }
      const answer = await asked(event, message(where, found, e.agentId))
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
      const decide = fold()
      for (const [part, unplaced] of found.entries()) {
        if (!wanted.has(unplaced.type)) continue
        const answer = await asked(unplaced.type, message(where, unplaced, e.agentId), decide)
        if (answer.text !== undefined) texts.set(part, answer.text)
      }
      return next(texts.size === 0 ? e : { ...e, message: { ...e.message, content: withTexts(row, texts) as typeof e.message.content } })
    }),
    router.add('tool.call', async (e, next) => {
      if (!(await wants(ToolCall))) return next(e)
      const where = await place()
      const input = toolInputOf(e)
      const cwd = (e.agentId === undefined ? undefined : agentFolders.get(e.agentId)) ?? (await claude.session.cwd())
      const answer = await asked(ToolCall, message(where, { id: e.tool_use_id, at: now(), type: ToolCall, callId: e.tool_use_id, name: e.tool, input, cwd, files: noFiles }, e.agentId))
      if (answer.refuse !== undefined) return { deny: answer.refuse }
      if (answer.result !== undefined) return withContext({ result: answer.result }, answer.note)
      if (answer.input === undefined) return withContext(await next(e), answer.note)
      const reserved = Object.fromEntries(Object.entries(e).filter(([key]) => !(key in input)))
      return withContext(await next({ ...reserved, ...answer.input } as Frozen<Args<'tool.call'>>), answer.note)
    }),
    router.add('agent.spawn', async (e, next) => {
      spawned.set(e.tool_use_id, { prompt: e.prompt, agentType: e.subagentType })
      const start = async (args: typeof e) => {
        const started = await next(args)
        if (started.agentId === undefined) spawned.delete(e.tool_use_id)
        else if (spawned.has(e.tool_use_id)) startedBy.set(started.agentId, e.tool_use_id)
        const folder = args.isTeammate === true ? undefined : (args.cwd ?? (args.parentAgentId === undefined ? undefined : agentFolders.get(args.parentAgentId)))
        if (started.agentId !== undefined && folder !== undefined) agentFolders.set(started.agentId, resolve(await claude.session.cwd(), folder))
        return started
      }
      if (!(await wants(TaskStart))) return start(e)
      const where = await place()
      const task: TaskData = { id: '', title: e.description, ...ownerOfSpawn(e.subagentType, where.session), model: e.model ?? e.parentModel, openedBy: e.tool_use_id, openedAt: now(), ...(e.parentAgentId === undefined ? {} : { parent: e.parentAgentId }) }
      const answer = await asked(TaskStart, { type: TaskStart, task: { ...task, context: where.context } })
      if (answer.refuse !== undefined) {
        spawned.delete(e.tool_use_id)
        return { deny: answer.refuse }
      }
      if (e.workflow !== undefined) return start(e)
      const isFork = task.forkedFrom !== undefined
      const { agentType, model, cwd } = (isFork ? undefined : answer.owner) ?? {}
      const isAsync = isFork ? undefined : answer.isAsync
      const answered = {
        ...e,
        ...(answer.prompt === undefined ? {} : { prompt: answer.prompt }),
        ...(answer.title === undefined ? {} : { description: answer.title }),
        ...(agentType === undefined ? {} : { subagentType: agentType }),
        ...(model === undefined ? {} : { model }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(isAsync === undefined ? {} : { background: isAsync }),
      }
      spawned.set(e.tool_use_id, { prompt: answered.prompt, agentType: answered.subagentType })
      return start(answered)
    }),
    router.add('classic.SubagentStart', async (e, next) => {
      const where = await place()
      const openedBy = where.tasks[e.agent_id]?.openedBy ?? startingSpawn(e.agent_id, e.agent_type)
      const prompt = openedBy === undefined ? undefined : spawned.get(openedBy)?.prompt
      if (openedBy !== undefined) spawned.delete(openedBy)
      startedBy.delete(e.agent_id)
      if (!(await wants(Prompt))) return next(e)
      const open = where.taskTurns[e.agent_id]?.prompt
      const text = open?.text ?? prompt
      if (text === undefined) return next(e)
      const answer = await asked(Prompt, message(where, { id: open?.id ?? '', at: now(), type: Prompt, text, from: open?.from ?? { type: Task } }, e.agent_id, false))
      return withNote(await next(e), answer.note)
    }),
    router.add('classic.SubagentStop', async (e, next) => {
      const stopped = <Answer extends { readonly block?: string }>(answer: Answer) => {
        if (answer.block === undefined) agentFolders.delete(e.agent_id)
        return answer
      }
      if (!(await wants(TurnEnd))) return stopped(await next(e))
      const turn = (await place()).taskTurns[e.agent_id]
      if (turn === undefined) return stopped(await next(e))
      const answer = await asked(TurnEnd, { type: TurnEnd, turn: { ...turn, closedAt: now() } })
      const below = await next(e)
      return stopped(answer.refuse === undefined ? withNote(below, answer.note) : { ...below, block: answer.refuse })
    }),
    router.add('classic.Stop', async (e, next) => {
      if (!(await wants(TurnEnd))) return next(e)
      const where = await place()
      if (where.turn === undefined) return next(e)
      const answer = await asked(TurnEnd, { type: TurnEnd, turn: { ...where.turn, closedAt: now() } })
      const below = await next(e)
      return answer.refuse === undefined ? withNote(below, answer.note) : { ...below, block: answer.refuse }
    }),
    router.add('session.compact', async (e, next) => {
      if (!(await wants(ContextEnd)) || e.trigger === 'precompute') return next(e)
      const where = await place()
      const task = e.agentId === undefined ? undefined : where.tasks[e.agentId]
      if (e.agentId !== undefined && task === undefined) return next(e)
      const answer = await asked(ContextEnd, { type: ContextEnd, context: closingContext(where, task, now()) })
      return answer.refuse === undefined ? next(e) : { skip: answer.refuse }
    }),
  ]
  return { remove: () => added.forEach((each) => each.remove()) }
}

export function closingContext(where: Place, task: RunningTask | undefined, closedAt: string): ContextData {
  return task === undefined ? { number: where.context, openedAt: where.contextOpenedAt, closedAt } : { number: task.context, openedAt: task.contextOpenedAt ?? task.openedAt, closedAt, task: task.id }
}

export function withAnswer(change: SessionChange, answer: Partial<Answers>): SessionChange {
  if (change.type === Message && answer.output !== undefined && change.message.type === ToolResult) return { ...change, message: { ...change.message, output: answer.output } }
  if (change.type === Message && answer.text !== undefined) return { ...change, message: { ...change.message, text: answer.text } as Message }
  if (change.type === Message && answer.input !== undefined && change.message.type === ToolCall) return { ...change, message: { ...change.message, input: answer.input } }
  if (change.type === TaskStart) {
    const { agentType, model } = answer.owner ?? {}
    return { ...change, task: { ...change.task, ...(answer.title === undefined ? {} : { title: answer.title }), ...(agentType === undefined ? {} : { agentType }), ...(model === undefined ? {} : { model }) } }
  }
  return change
}

export const methodOf = (prefix: 'on' | 'before', event: SessionEvent): string => `${prefix}${Object.entries(sessionEvents).find(([, each]) => each === event)?.[0] ?? event}`

export const beforeAnswerKeys: Readonly<Record<BeforeEvent, readonly (keyof Answers)[]>> = {
  prompt: ['text', 'note', 'title', 'refuse'],
  note: ['text'],
  skill: ['text'],
  instructionFile: ['text', 'refuse'],
  attachedFile: ['text', 'refuse'],
  reply: ['text'],
  toolCall: ['input', 'result', 'refuse', 'note'],
  toolResult: ['output', 'isError', 'note'],
  notice: ['text'],
  taskStart: ['prompt', 'title', 'owner', 'isAsync', 'refuse'],
  turnEnd: ['refuse', 'note'],
  contextEnd: ['refuse'],
}

export function foldBefore(event: BeforeEvent, change: SessionChange, askers: readonly ((change: SessionChange) => Promise<unknown>)[], report: (error: unknown) => void): Promise<Partial<Answers> | undefined> {
  return foldAnswers(methodOf('before', event), beforeAnswerKeys[event], ['refuse', 'result'], change, askers, report, withAnswer)
}

export function takenAnswer(method: string, takes: readonly string[], answer: unknown): unknown {
  if (answer === undefined || answer === null || answer === false) return undefined
  if (typeof answer !== 'object' || Array.isArray(answer)) throw new Error(`it answered ${JSON.stringify(answer)}, but ${method} takes an object or nothing: ${takes.map((key) => `{ ${key} }`).join(', ') || 'no answer'}.`)
  const unread = Object.keys(answer).filter((key) => !takes.includes(key))
  if (unread.length > 0) throw new Error(`it answered ${unread.join(' and ')}, which ${method} does not take. It takes ${takes.map((key) => `{ ${key} }`).join(', ') || 'no answer'}.`)
  return answer
}

export async function foldAnswers<Change, Answer extends object>(method: string, takes: readonly string[], ends: readonly string[], change: Change, askers: readonly ((change: Change) => Promise<unknown>)[], report: (error: unknown) => void, applied: (change: Change, answer: Answer) => Change = (same) => same): Promise<Answer | undefined> {
  let latest = change
  let result: Record<string, unknown> | undefined
  for (const ask of askers) {
    try {
      const answer = takenAnswer(method, takes, await ask(latest))
      if (typeof answer !== 'object' || answer === null) continue
      const given = answer as Record<string, unknown>
      const notes = [result?.['note'], given['note']].filter((note) => typeof note === 'string')
      result = { ...result, ...given, ...(notes.length === 0 ? {} : { note: notes.join('\n\n') }) }
      if (ends.some((key) => given[key] !== undefined)) return result as Answer
      latest = applied(latest, answer as Answer)
    } catch (error) {
      report(error)
    }
  }
  return result as Answer | undefined
}
