import type { Database } from 'bun:sqlite'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { getSession, listSessions, openHistory, readContexts, readGoal, readMessages, readState, readTasks, readTurns, removeSession, searchMessages, type IndexAnswer, type IndexCall } from './history.js'

declare const self: Worker

const methods = { listSessions, getSession, searchMessages, readMessages, readTurns, readContexts, readTasks, readGoal, readState, removeSession }

export type IndexMethods = typeof methods

let db: Database | undefined

const answer = (answered: IndexAnswer) => postMessage(answered)

self.onmessage = ({ data: { id, method, args } }: MessageEvent<IndexCall>) => {
  if (method === 'close') {
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
