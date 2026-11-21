import type { Database } from 'bun:sqlite'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { followSessions, listSessions, openHistory, readContexts, readGoal, readMessages, readState, readTasks, readTurns, removeSession, searchMessages, type IndexAnswer, type IndexCall } from './history.js'

declare const self: Worker

const methods = { listSessions, searchMessages, readMessages, readTurns, readContexts, readTasks, readGoal, readState, removeSession }

export type IndexMethods = typeof methods

let db: Database | undefined
const following = new Map<number, AbortController>()

const answer = (answered: IndexAnswer) => postMessage(answered)

const follow = (id: number, [sessions, project]: readonly unknown[]) => {
  const stop = new AbortController()
  following.set(id, stop)
  void Promise.resolve()
    .then(() => followSessions((db ??= openHistory()), { sessions: sessions as string[], isEveryRunning: false }, project as string, (session, change, isInProject) => answer({ id, change: { session, change, isInProject } }), stop.signal))
    .then(
      () => answer({ id, value: null }),
      (error: unknown) => answer({ id, error: messageOf(error) }),
    )
    .finally(() => following.delete(id))
}

self.onmessage = ({ data: { id, method, args } }: MessageEvent<IndexCall>) => {
  if (method === 'follow') return follow(id, args)
  if (method === 'unfollow') {
    following.get(args[0] as number)?.abort()
    return answer({ id, value: null })
  }
  if (method === 'close') {
    for (const stop of following.values()) stop.abort()
    db?.close()
    return answer({ id, value: null })
  }
  try {
    if (!Object.hasOwn(methods, method)) throw new Error(`The conversation index has no ${method}.`)
    const run = methods[method as keyof IndexMethods] as (db: Database, ...args: readonly unknown[]) => unknown
    answer({ id, value: run((db ??= openHistory()), ...args) })
  } catch (error) {
    answer({ id, error: messageOf(error) })
  }
}
