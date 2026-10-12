import type { Message, Session } from '../history.js'
import type { Mod } from '../mod.js'
import type { Claude } from './claude.js'
import { cmodPluginName } from './dependencies.js'
import type { Router } from './router.js'

export type HistoryRequest =
  | { readonly command: 'sessions'; readonly project: string; readonly since?: string; readonly everyProject?: boolean }
  | { readonly command: 'messages'; readonly project: string; readonly session: string; readonly agent?: string; readonly subagents?: boolean; readonly after?: string; readonly last?: number; readonly limit: number }
  | { readonly command: 'search'; readonly project: string; readonly text: string; readonly since?: string; readonly everyProject?: boolean; readonly limit?: number; readonly before?: Pick<Message, 'session' | 'id'> }

const pageSize = 100

const otherSessionMs = 1000

const addsMessages = ['classic.UserPromptSubmit', 'classic.PostToolUse', 'classic.PostToolUseFailure', 'classic.PostToolBatch', 'classic.SubagentStop', 'classic.PreCompact', 'classic.Stop', 'classic.StopFailure'] as const

export function createHistory({ claude, router, checkGrant, project }: { readonly claude: Claude; readonly router: Router; readonly checkGrant: () => Promise<void>; readonly project: () => string }): Mod['history'] {
  const waiting = new Set<() => void>()
  let isFollowing = false
  const follow = () => {
    if (isFollowing) return
    isFollowing = true
    for (const event of addsMessages) {
      router.add(event, async (e, next) => {
        const answer = await next(e)
        for (const wake of waiting) wake()
        return answer
      })
    }
  }
  const nextChange = () =>
    new Promise<void>((resolve) => {
      const wake = () => {
        waiting.delete(wake)
        resolve()
      }
      waiting.add(wake)
    })
  const ask = async <Answer>(request: HistoryRequest): Promise<Answer> => {
    await checkGrant()
    return (await claude.cmod.call({ to: cmodPluginName, method: 'history', input: request })) as Answer
  }
  return {
    sessions: (options = {}) => ask<Session[]>({ command: 'sessions', project: project(), ...options }),
    search: (text, { before, ...options } = {}) => ask<Message[]>({ command: 'search', project: project(), text, ...options, ...(before === undefined ? {} : { before: { session: before.session, id: before.id } }) }),
    async *messages(options = {}) {
      const { follow: isFollowed = false, last, session: named, ...rest } = options
      const current = await claude.session.id()
      const session = named ?? current
      const isThisSession = session === current
      if (isFollowed && isThisSession) follow()
      const saved = () => (isThisSession ? nextChange() : new Promise<void>((resolve) => void claude.clock.after(otherSessionMs, resolve)))
      let after = rest.after
      let tail = last
      let changed = isFollowed ? saved() : undefined
      for (;;) {
        const page = await ask<Message[]>({ command: 'messages', project: project(), session, ...rest, ...(after === undefined ? {} : { after }), ...(tail === undefined ? {} : { last: tail }), limit: pageSize })
        yield* page
        after = page.at(-1)?.id ?? after
        const isFull = tail === undefined && page.length === pageSize
        tail = undefined
        if (isFull) continue
        if (changed === undefined) return
        await changed
        changed = saved()
      }
    },
  }
}
