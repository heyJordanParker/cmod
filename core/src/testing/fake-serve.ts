import type { HttpInit, HttpResponse } from 'claude-code'
import { routeSessions, type SessionComputer, type SessionRouting } from '../runtime/interfaces.js'
import { RpcError, rpcCodes } from '../runtime/rpc.js'

export type FakeServe = {
  readonly routing: SessionRouting
  fetch(url: string, init?: HttpInit): Promise<HttpResponse>
  close(): void
}

const notHere = (session: string) => new RpcError(rpcCodes.notHeld, `No session ${session} on this computer.`)

const unfaked: SessionComputer = {
  sessions: () => [],
  search: () => [],
  read: (_session, part) => (part === 'goal' ? { text: '' } : part === 'state' ? null : []),
  unheld: (session) => Promise.reject(notHere(session)),
  visit: async () => undefined,
  remove: async () => undefined,
}

export function fakeServe(fakes: () => Partial<SessionComputer>): FakeServe {
  const answer = <Key extends keyof SessionComputer>(key: Key): SessionComputer[Key] => (fakes()[key] ?? unfaked[key])
  const routing = routeSessions({
    now: () => new Date().getTime(),
    computer: {
      sessions: (...args) => answer('sessions')(...args),
      search: (...args) => answer('search')(...args),
      read: (...args) => answer('read')(...args),
      unheld: (...args) => answer('unheld')(...args),
      visit: (...args) => answer('visit')(...args),
      remove: (...args) => answer('remove')(...args),
    },
  })
  return {
    routing,
    async fetch(url, init = {}) {
      const answered = await routing.routes.route({ method: init.method ?? 'GET', path: new URL(url).pathname, signal: new AbortController().signal, json: async () => JSON.parse(String(init.body)) as unknown })
      if (answered === undefined) return { status: 404, ok: false, headers: {}, text: '' }
      return { status: answered.status, ok: answered.status >= 200 && answered.status < 300, headers: {}, text: answered.json === undefined ? '' : JSON.stringify(answered.json) }
    },
    close: () => routing.close(),
  }
}
