import type { Args, EventResult, Frozen } from 'claude-code'
import { consentPath, dataFolder, isObject, parseConsent } from '../records.js'
import { Message, rowOfAppend, type Row } from '../session/context/turn/message/message.js'
import { Note } from '../session/context/turn/message/note.js'
import { Prompt } from '../session/context/turn/message/prompt.js'
import { Person } from '../session/context/turn/message/sender.js'
import { createConversation, emptyConversation, type Conversation, type ConversationState, type ContextData, type SessionChange, type SessionData, type TaskData, type TurnData } from '../session/conversation.js'
import { receivedMatcher } from '../utils/matcher.js'
import { ifMissing } from '../utils/paths.js'
import { formatExit, messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import { cmodPluginName } from './dependencies.js'
import { readLines, runCmod } from './programs.js'
import type { Router } from './router.js'
import { conversationMethods, isHeardBy, type Subscription } from './sessions.js'

type Request = Readonly<Record<string, unknown>>

type Heard = { readonly event: Subscription['event']; readonly matcher: unknown }

const delivery = /^<cmod-delivery>([\s\S]*)<\/cmod-delivery>$/

const bufferedTaskRows = 200

export type Conversations = {
  answer(e: Frozen<Args<'cmod.call'>> & { readonly caller?: string }): Promise<EventResult<'cmod.call'> | undefined>
}

export function serveConversations({ claude, router, store, project, report }: { readonly claude: Claude; readonly router: Router; readonly store: string; readonly project: () => string; readonly report: (id: string, message: string, error: unknown) => void }): Conversations {
  const goals = `${dataFolder(store, cmodPluginName)}/goals`
  const heard = new Map<string, Map<string, readonly Heard[]>>()
  let session = ''
  let conversation: Conversation = createConversation(emptyConversation(''))
  let starting: Promise<void> = Promise.resolve()
  let live: Message[] = []
  const liveIds = new Set<string>()
  const waitingRows = new Map<string, Row[]>()
  let follower: { readonly sessions: string; stop(): void } | undefined

  const json = async <Value>(args: readonly string[]): Promise<Value> => JSON.parse(await runCmod(claude, [...args, '--json', '--project', project()], session === '' ? await claude.session.id() : session)) as Value

  const isGranted = async (caller: string | undefined, item: string) => {
    if (caller === cmodPluginName) return true
    if (caller === undefined) return false
    const path = consentPath(store)
    const text = await claude.fs.read(path).catch(ifMissing('{}'))
    return (parseConsent(JSON.parse(text), path)[caller] ?? []).includes(item)
  }

  const dispatch = (to: string, changes: readonly SessionChange[]) => {
    for (const change of changes) {
      if (change.type === Message && !liveIds.has(change.message.id) && to === session) {
        live.push(change.message)
        liveIds.add(change.message.id)
      }
      for (const [mod, sessions] of heard) {
        const subscriptions = sessions.get(to) ?? []
        if (!subscriptions.some(({ event, matcher }) => isHeardBy(event, matcher, change))) continue
        void claude.cmod.call({ to: mod, method: conversationMethods.changed, input: { session: to, change } }).catch((error: unknown) => report(`changed:${mod}`, `Could not tell ${mod} about session ${to}`, error))
      }
    }
  }

  const restartFollower = () => {
    const others = [...new Set([...heard.values()].flatMap((sessions) => [...sessions].filter(([id, list]) => id !== session && list.length > 0).map(([id]) => id)))].sort()
    const wanted = others.join(' ')
    if (follower?.sessions === wanted) return
    follower?.stop()
    follower = undefined
    if (others.length === 0) return
    const stream = claude.process.spawn({ argv: ['cmod', 'history', 'follow', ...others, '--json', '--project', project()], env: { CLAUDE_CODE_SESSION_ID: session } })
    const started = { sessions: wanted, stop: () => void stream.return(undefined as never) }
    follower = started
    void readLines(stream, (line) => {
      if (line.trim() === '') return
      const parsed = JSON.parse(line) as { readonly session: string; readonly change: SessionChange }
      dispatch(parsed.session, [parsed.change])
    })
      .then(({ code, lastError }) => {
        if (follower === started) throw new Error(`cmod history follow ${formatExit(code, lastError)}`)
      })
      .catch((error: unknown) => {
        if (follower !== started) return
        follower = undefined
        report('follow', 'Stopped hearing the other sessions', error)
      })
  }

  const start = (id: string, source: string) => {
    if (id === session && source !== 'compact') return
    if (id === session && source === 'compact') {
      dispatch(session, conversation.startContext(new Date().toISOString()))
      return
    }
    session = id
    live = []
    liveIds.clear()
    waitingRows.clear()
    conversation = createConversation(emptyConversation(id))
    starting =
      source === 'startup' || source === 'clear'
        ? Promise.resolve(dispatch(id, conversation.startContext(new Date().toISOString())))
        : json<ConversationState>(['history', 'state', id]).then(
            (state) => {
              if (session === id) conversation = createConversation(state)
            },
            (error: unknown) => report('state', `Starts session ${id} without its earlier turns`, error),
          )
    restartFollower()
  }

  const take = async (row: Row, task: string | undefined) => {
    await starting
    if (task !== undefined && conversation.state.tasks[task] === undefined) {
      const waiting = waitingRows.get(task) ?? []
      waiting.push(row)
      waitingRows.set(task, waiting)
      if (waiting.length < bufferedTaskRows) return
      waitingRows.delete(task)
      dispatch(session, conversation.startTask({ id: task, title: '', agentType: 'general-purpose', openedBy: '', openedAt: row.at }))
      for (const each of waiting) dispatch(session, conversation.add(each, task))
      return
    }
    dispatch(session, conversation.add(row, task))
  }

  router.add('classic.SessionStart', async (e, next) => {
    start(e.session_id, e.source)
    return next(e)
  })

  router.add('session.append', async (e, next) => {
    const kept = await next(e)
    if (kept.deny !== undefined || session === '') return kept
    const cwd = e.message.type === 'assistant' ? await claude.session.cwd() : ''
    void take(rowOfAppend({ uuid: kept.uuid, door: e.door, origin: e.origin, message: kept.message }, new Date().toISOString(), cwd), e.agentId).catch((error: unknown) => report('append', 'Missed a message', error))
    return kept
  })

  router.add('session.compact', async (e, next) => {
    const compacted = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && compacted.skip === undefined) {
      await starting
      dispatch(session, conversation.endContext(new Date().toISOString()))
    }
    return compacted
  })

  router.add('agent.spawn', async (e, next) => {
    const spawned = await next(e)
    if (spawned.deny !== undefined || spawned.agentId === undefined) return spawned
    const id = spawned.agentId
    const opened: TaskData = { id, title: e.description, agentType: e.subagentType, model: spawned.model, openedBy: e.tool_use_id, openedAt: new Date().toISOString(), ...(e.parentAgentId === undefined ? {} : { parent: e.parentAgentId }) }
    await starting
    dispatch(session, conversation.startTask(opened))
    const waiting = waitingRows.get(id) ?? []
    waitingRows.delete(id)
    for (const row of waiting) dispatch(session, conversation.add(row, id))
    return spawned
  })

  router.add('session.receive', async (e, next) => {
    const isFromCmod = e.origin.kind === 'peer' && !('teammate' in e.origin) && e.origin.plugin === cmodPluginName
    const sent = isFromCmod ? delivery.exec(e.text)?.[1] : undefined
    if (sent === undefined) return next(e)
    const parsed: unknown = JSON.parse(sent)
    if (!isObject(parsed) || typeof parsed['text'] !== 'string') return next(e)
    const { type, text, as } = parsed
    claude.clock.after(0, () => {
      const delivered = type === Note ? claude.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }) : claude.prompt.submit({ text, ...(as === Person ? { asUser: true } : {}) })
      void delivered.catch((error: unknown) => report('delivery', 'Could not deliver a message from another session', error))
    })
    return { consumed: 'cmod delivery' }
  })

  const merged = <Item>(saved: readonly Item[], kept: readonly Item[], key: (item: Item) => string): Item[] => {
    const keptKeys = new Set(kept.map(key))
    return [...saved.filter((item) => !keptKeys.has(key(item))), ...kept]
  }

  const liveTurns = (): TurnData[] => {
    const turn = conversation.state.turn
    return turn === undefined ? [] : [turn]
  }

  const liveTasks = (): TaskData[] => Object.values(conversation.state.tasks).map(({ context: _context, ...task }) => task)

  const liveContext = (): ContextData[] => {
    const { context, contextOpenedAt } = conversation.state
    return context === 0 ? [] : [{ number: context, openedAt: contextOpenedAt }]
  }

  const lastOf = <Item>(items: readonly Item[], last: unknown): Item[] => (typeof last === 'number' ? items.slice(-last) : [...items])

  const methods: Readonly<Record<string, (request: Request, caller: string | undefined) => Promise<unknown>>> = {
    async [conversationMethods.sessions](request) {
      const found = await json<SessionData[]>(['history', 'sessions', ...scopeArgs(request), ...(request['running'] === true ? ['--running'] : [])])
      return found.map((each) => (each.id === session ? { ...each, isRunning: true } : each))
    },
    async [conversationMethods.search](request) {
      const before = isObject(request['before']) ? request['before'] : undefined
      return json(['history', 'search', String(request['text']), ...scopeArgs(request), ...(request['running'] === true ? ['--running'] : []), ...countArg('--limit', request['limit']), ...(before === undefined ? [] : ['--before', `${String(before['session'])}:${String(before['id'])}`])])
    },
    async [conversationMethods.messages](request) {
      const id = String(request['session'])
      const filters = [...textArg('--turn', request['turn']), ...textArg('--task', request['task']), ...textArg('--after', request['after'])]
      const saved = await json<Message[]>(['history', 'messages', id, ...filters, ...countArg('--last', request['last'])])
      if (id !== session) return saved
      await starting
      const fits = (message: Message) => (request['turn'] === undefined || message.turn === request['turn']) && message.task === request['task']
      const after = typeof request['after'] === 'string' ? live.findIndex((message) => message.id === request['after']) : -1
      const kept = live.slice(after + 1).filter(fits)
      return lastOf(merged(saved, kept, (message) => message.id), request['last'])
    },
    async [conversationMethods.turns](request) {
      const id = String(request['session'])
      const saved = await json<TurnData[]>(['history', 'turns', id, ...countArg('--context', request['context']), ...countArg('--last', request['last'])])
      if (id !== session) return saved
      await starting
      const kept = liveTurns().filter((turn) => request['context'] === undefined || turn.context === request['context'])
      return lastOf(merged(saved, kept, (turn) => turn.prompt.id), request['last'])
    },
    async [conversationMethods.contexts](request) {
      const id = String(request['session'])
      const saved = await json<ContextData[]>(['history', 'contexts', id])
      if (id !== session) return saved
      await starting
      return merged(saved, liveContext(), (context) => String(context.number))
    },
    async [conversationMethods.tasks](request) {
      const id = String(request['session'])
      const saved = await json<TaskData[]>(['history', 'tasks', id, ...textArg('--task', request['task'])])
      if (id !== session) return saved
      await starting
      const kept = liveTasks().filter((task) => task.parent === request['task'])
      return merged(saved, kept, (task) => task.id)
    },
    async [conversationMethods.goal](request) {
      const id = String(request['session'])
      if (id === session) {
        await starting
        const text = conversation.state.goal
        if (text !== undefined) return { text }
      }
      return json(['history', 'goal', id])
    },
    async [conversationMethods.updateGoal](request) {
      const id = String(request['session'])
      const text = String(request['text'])
      await claude.fs.write(`${goals}/${id}.txt`, text)
      if (id === session) {
        await starting
        dispatch(session, conversation.changeGoal(text))
      }
      return null
    },
    async [conversationMethods.subscribe](request, caller) {
      if (caller === undefined) throw new Error('cmod hears no caller for this subscription.')
      const id = String(request['session'])
      const list = Array.isArray(request['subscriptions']) ? (request['subscriptions'] as readonly Subscription[]) : []
      const sessions = heard.get(caller) ?? new Map<string, readonly Heard[]>()
      sessions.set(id, list.map(({ event, matcher }) => ({ event, matcher: matcher === undefined ? undefined : receivedMatcher(matcher) })))
      heard.set(caller, sessions)
      restartFollower()
      return null
    },
    async [conversationMethods.send](request, caller) {
      if (!(await isGranted(caller, 'prompt'))) throw new Error(`${caller ?? 'A mod'} sends to another session without your grant to send prompts.`)
      const type = request['type'] === Note ? Note : Prompt
      const sent = await claude.session.send({ to: { sessionId: String(request['session']) }, text: `<cmod-delivery>${JSON.stringify({ type, text: request['text'], as: request['as'] })}</cmod-delivery>` })
      if (sent.isDelivered !== true) throw new Error(`Claude Code could not deliver the message to session ${String(request['session'])}.`)
      return null
    },
  }

  return {
    async answer(e) {
      const method = methods[e.method]
      if (method === undefined) return undefined
      const input = isObject(e.input) ? e.input : {}
      if (e.method !== conversationMethods.send && !(await isGranted(e.caller, 'conversation'))) return { deny: `${e.caller ?? 'A mod'} reads your conversations without your grant. Turn it on in /mods ${e.caller ?? ''}.`.trim() }
      try {
        return { value: await method(input, e.caller) }
      } catch (error) {
        return { deny: messageOf(error) }
      }
    },
  }
}

function scopeArgs(request: Request): string[] {
  return [...(typeof request['since'] === 'string' ? ['--since', request['since']] : []), ...(request['everyProject'] === true ? ['--all'] : [])]
}

function countArg(flag: string, value: unknown): string[] {
  return typeof value === 'number' ? [flag, String(value)] : []
}

function textArg(flag: string, value: unknown): string[] {
  return typeof value === 'string' ? [flag, value] : []
}

