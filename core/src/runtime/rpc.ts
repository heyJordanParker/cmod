import { beforeDeadline, callDeadline } from './deadline.js'

export type RpcId = number | string

export type RpcClock = { after(ms: number, run: () => void): { cancel(): void } }

export type RpcErrorData = { readonly code: number; readonly message: string; readonly data?: unknown }

export type RpcMessage =
  | { readonly jsonrpc: '2.0'; readonly id: RpcId; readonly method: string; readonly params?: unknown }
  | { readonly jsonrpc: '2.0'; readonly method: string; readonly params?: unknown }
  | { readonly jsonrpc: '2.0'; readonly id: RpcId; readonly result: unknown }
  | { readonly jsonrpc: '2.0'; readonly id: RpcId; readonly error: RpcErrorData }

export const rpcCodes = {
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  closed: -32099,
  notHeld: -32098,
  notProvided: -32097,
  cancelled: -32800,
} as const

export class RpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

export type RpcHandler = (method: string, params: unknown, signal: AbortSignal) => unknown

export type Peer = {
  request<Result>(method: string, params?: unknown, signal?: AbortSignal): Promise<Result>
  notify(method: string, params?: unknown): void
  receive(message: unknown): void
  close(reason: Error): void
  readonly signal: AbortSignal
}

const cancelMethod = '$/cancelRequest'

const partMethod = '$/part'

export const pollChars = 1_000_000

function partsOf(message: RpcMessage, chars: number): RpcMessage[] {
  const text = JSON.stringify(message)
  const size = Math.max(1, Math.floor(chars / 4))
  const count = Math.ceil(text.length / size)
  return Array.from({ length: count }, (_, index) => ({ jsonrpc: '2.0', method: partMethod, params: { text: text.slice(index * size, (index + 1) * size), isLast: index === count - 1 } }))
}

function partOf(message: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const fields = message as Readonly<Record<string, unknown>>
  const params = fields['params']
  return fields['method'] === partMethod && typeof params === 'object' && params !== null ? (params as Readonly<Record<string, unknown>>) : undefined
}

function takenWithin(outbox: RpcMessage[], chars: number | undefined): RpcMessage[] {
  if (chars === undefined) return outbox.splice(0)
  const taken: RpcMessage[] = []
  let size = 0
  while (outbox.length > 0) {
    const next = outbox[0] as RpcMessage
    const length = JSON.stringify(next).length
    if (length > chars && !('method' in next && next.method === partMethod)) {
      outbox.splice(0, 1, ...partsOf(next, chars))
      continue
    }
    if (taken.length > 0 && size + length > chars) break
    taken.push(outbox.shift() as RpcMessage)
    size += length
  }
  return taken
}

type Waiting = { resolve(value: unknown): void; reject(error: Error): void }

export function createPeer({ send, handle }: { readonly send: (message: RpcMessage) => void; readonly handle: RpcHandler }): Peer {
  const closing = new AbortController()
  const waiting = new Map<RpcId, Waiting>()
  const running = new Map<RpcId, AbortController>()
  let nextId = 0

  const reply = (id: RpcId, run: (signal: AbortSignal) => unknown) => {
    const cancel = new AbortController()
    running.set(id, cancel)
    void (async () => run(cancel.signal))()
      .then(
        (result) => ({ jsonrpc: '2.0' as const, id, result: result ?? null }),
        (error: unknown) => ({ jsonrpc: '2.0' as const, id, error: errorDataOf(cancel.signal.aborted ? new RpcError(rpcCodes.cancelled, 'The caller cancelled the request.') : error) }),
      )
      .then((answer) => {
        running.delete(id)
        if (!closing.signal.aborted) send(answer)
      })
  }

  const receiveOne = (message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    const fields = message as Record<string, unknown>
    const id = fields['id']
    const isId = typeof id === 'number' || typeof id === 'string'
    if (typeof fields['method'] === 'string') {
      const method = fields['method']
      if (method === cancelMethod) {
        const cancelled = (fields['params'] as { readonly id?: RpcId } | undefined)?.id
        if (cancelled !== undefined) running.get(cancelled)?.abort()
        return
      }
      if (!isId) {
        void (async () => handle(method, fields['params'], closing.signal))().catch(() => undefined)
        return
      }
      reply(id, (signal) => handle(method, fields['params'], signal))
      return
    }
    if (!isId) return
    const waiter = waiting.get(id)
    if (waiter === undefined) return
    waiting.delete(id)
    const error = fields['error'] as RpcErrorData | undefined
    if (error !== undefined) waiter.reject(new RpcError(error.code, error.message, error.data))
    else waiter.resolve(fields['result'])
  }

  return {
    signal: closing.signal,
    request<Result>(method: string, params?: unknown, signal?: AbortSignal) {
      if (closing.signal.aborted) return Promise.reject(closedError(closing.signal.reason))
      const id = (nextId += 1)
      return new Promise<Result>((resolve, reject) => {
        const cancel = () => {
          if (!waiting.delete(id)) return
          send({ jsonrpc: '2.0', method: cancelMethod, params: { id } })
          reject(new RpcError(rpcCodes.cancelled, `${method} was cancelled.`))
        }
        waiting.set(id, {
          resolve: (value) => {
            signal?.removeEventListener('abort', cancel)
            resolve(value as Result)
          },
          reject: (error) => {
            signal?.removeEventListener('abort', cancel)
            reject(error)
          },
        })
        if (signal?.aborted === true) return cancel()
        signal?.addEventListener('abort', cancel, { once: true })
        send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
      })
    },
    notify(method, params) {
      if (!closing.signal.aborted) send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
    },
    receive(message) {
      if (Array.isArray(message)) for (const each of message) receiveOne(each)
      else receiveOne(message)
    },
    close(reason) {
      if (closing.signal.aborted) return
      closing.abort(reason)
      for (const cancel of running.values()) cancel.abort()
      running.clear()
      for (const waiter of waiting.values()) waiter.reject(closedError(reason))
      waiting.clear()
    },
  }
}

export function closedError(reason: unknown): RpcError {
  return new RpcError(rpcCodes.closed, `The connection closed: ${reason instanceof Error ? reason.message : String(reason)}`)
}

function errorDataOf(error: unknown): RpcErrorData {
  if (error instanceof RpcError) return { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
  return { code: rpcCodes.internal, message: error instanceof Error ? error.message : String(error) }
}

export const rpcPath = '/rpc'

export type RpcConnection = Peer & { readonly id: string }

type Held = {
  readonly peer: Peer
  readonly connection: RpcConnection
  readonly outbox: RpcMessage[]
  poll: ((messages: RpcMessage[]) => void) | undefined
  chars: number | undefined
  seenAt: number
  isUnpolled: boolean
}

export type RpcHttpRequest = { readonly method: string; readonly path: string; readonly signal: AbortSignal; json(): Promise<unknown> }

export type RpcHttpAnswer = { readonly status: number; readonly json?: unknown }

export type RpcRoutes = {
  route(request: RpcHttpRequest): Promise<RpcHttpAnswer> | undefined
  channel(send: (message: RpcMessage) => void): RpcConnection
  connections(): RpcConnection[]
  close(): void
}

const timers = globalThis as unknown as { setTimeout(run: () => void, ms: number): unknown; clearTimeout(timer: unknown): void }

export function rpcRoutes({
  handle,
  onClose,
  onUnpolled,
  now,
  pollMs = 8000,
  liveMs = 30_000,
}: {
  readonly handle: (connection: RpcConnection) => RpcHandler
  readonly onClose?: (connection: RpcConnection) => void
  readonly onUnpolled?: (connection: RpcConnection) => void
  readonly now: () => number
  readonly pollMs?: number
  readonly liveMs?: number
}): RpcRoutes {
  const held = new Map<string, Held>()

  const drop = (id: string, reason: Error) => {
    const each = held.get(id)
    if (each === undefined) return
    held.delete(id)
    each.poll?.([])
    each.peer.close(reason)
    onClose?.(each.connection)
  }

  const open = (): Held => {
    const id = crypto.randomUUID()
    const outbox: RpcMessage[] = []
    let entry: Held | undefined
    const peer = createPeer({
      send: (message) => {
        if (entry === undefined) return
        outbox.push(message)
        if (entry.poll === undefined) {
          if (!entry.isUnpolled) onUnpolled?.(entry.connection)
          entry.isUnpolled = true
          return
        }
        const poll = entry.poll
        entry.poll = undefined
        poll(takenWithin(outbox, entry.chars))
      },
      handle: (method, params, signal) => handler(method, params, signal),
    })
    const connection: RpcConnection = { ...peer, id, close: (reason) => drop(id, reason) }
    const handler = handle(connection)
    entry = { peer, connection, outbox, poll: undefined, chars: undefined, seenAt: now(), isUnpolled: false }
    held.set(id, entry)
    return entry
  }

  const sweep = () => {
    for (const [id, each] of held) if (each.poll === undefined && now() - each.seenAt > liveMs) drop(id, new Error(`no poll for ${liveMs / 1000} s`))
  }

  const known = (id: string) => {
    const each = held.get(id)
    if (each === undefined) throw new GoneError(id)
    each.seenAt = now()
    return each
  }

  const poll = (each: Held, signal: AbortSignal, chars: number | undefined) =>
    new Promise<RpcMessage[]>((resolve) => {
      each.poll?.([])
      each.isUnpolled = false
      each.chars = chars
      if (each.outbox.length > 0) return resolve(takenWithin(each.outbox, chars))
      const timer = timers.setTimeout(() => answer([]), pollMs)
      const answer = (messages: RpcMessage[]) => {
        timers.clearTimeout(timer)
        if (each.poll === answer) each.poll = undefined
        each.seenAt = now()
        resolve(messages)
      }
      each.poll = answer
      signal.addEventListener('abort', () => {
        if (each.poll !== answer) return
        each.poll = undefined
        timers.clearTimeout(timer)
        resolve([])
        drop(each.connection.id, new Error('the client left its poll'))
      })
    })

  const route = async (request: RpcHttpRequest): Promise<RpcHttpAnswer> => {
    sweep()
    const url = new URL(request.path, 'http://cmod')
    const [, id] = /^\/rpc\/([\w-]{1,64})$/.exec(url.pathname) ?? []
    const chars = Number(url.searchParams.get('chars'))
    try {
      if (url.pathname === `${rpcPath}/connect` && request.method === 'POST') return { status: 200, json: { connection: open().connection.id } }
      if (id === undefined) return { status: 404, json: { error: `cmod has no ${request.method} ${url.pathname}.` } }
      if (request.method === 'DELETE') {
        drop(id, new Error('the client closed it'))
        return { status: 204 }
      }
      const each = known(id)
      if (request.method === 'GET') return { status: 200, json: await poll(each, request.signal, Number.isInteger(chars) && chars > 0 ? chars : undefined) }
      if (request.method === 'POST') {
        each.connection.receive(await request.json())
        return { status: 204 }
      }
      return { status: 405, json: { error: `cmod has no ${request.method} ${url.pathname}.` } }
    } catch (error) {
      if (error instanceof GoneError) return { status: goneStatus, json: { error: error.message } }
      throw error
    }
  }

  const channels = new Map<string, RpcConnection>()

  const channel = (send: (message: RpcMessage) => void): RpcConnection => {
    const id = crypto.randomUUID()
    const peer = createPeer({ send, handle: (method, params, signal) => handler(method, params, signal) })
    const connection: RpcConnection = {
      ...peer,
      id,
      close(reason) {
        if (!channels.delete(id)) return
        peer.close(reason)
        onClose?.(connection)
      },
    }
    const handler = handle(connection)
    channels.set(id, connection)
    return connection
  }

  return {
    route: (request) => (request.path.startsWith(rpcPath) ? route(request) : undefined),
    channel,
    connections: () => [...[...held.values()].map((each) => each.connection), ...channels.values()],
    close() {
      for (const id of held.keys()) drop(id, new Error('the server stopped'))
      for (const each of channels.values()) each.close(new Error('the server stopped'))
    },
  }
}

export class RpcUnreached extends Error {}

const goneStatus = 410

export function isConnectionGone(error: unknown): boolean {
  return error instanceof RpcUnreached || (error instanceof RpcError && error.code === rpcCodes.closed)
}

class GoneError extends Error {
  constructor(id: string) {
    super(`cmod has no connection ${id}: it closed, or the server started again. Connect again.`)
  }
}

export type HttpCall = (path: string, init: { readonly method: 'GET' | 'POST' | 'DELETE'; readonly body?: string }) => Promise<{ readonly status: number; readonly text: string }>

export type HttpFetch = (url: string, init: { readonly method: string; readonly body?: string; readonly headers?: Readonly<Record<string, string>>; readonly socketPath?: string }) => Promise<{ readonly status: number; readonly text: string }>

export function addressCall(fetch: HttpFetch, address: string): HttpCall {
  const socketPath = address.startsWith('unix:') ? address.slice('unix:'.length) : address.startsWith('/') ? address : undefined
  const base = socketPath !== undefined ? 'http://localhost' : /^https?:\/\//.test(address) ? address.replace(/\/+$/, '') : `http://${address}`
  return async (path, init) => {
    const answer = await fetch(`${base}${path}`, { method: init.method, ...(init.body === undefined ? {} : { body: init.body, headers: { 'content-type': 'application/json' } }), ...(socketPath === undefined ? {} : { socketPath }) })
    return { status: answer.status, text: answer.text }
  }
}

export type RpcClient = Pick<Peer, 'request' | 'notify'> & {
  readonly isConnected: boolean
  close(): Promise<void>
}

export function connectRpc({
  call,
  handle,
  onConnect,
  onError,
  onLost,
  clock,
  retryMs = 2000,
  keepsConnecting = false,
}: {
  readonly call: HttpCall
  readonly handle: RpcHandler
  readonly onConnect?: (client: RpcClient) => unknown
  readonly onError?: (error: unknown) => void
  readonly onLost?: () => void
  readonly clock: RpcClock
  readonly retryMs?: number
  readonly keepsConnecting?: boolean
}): RpcClient {
  type Link = { readonly id: string; readonly peer: Peer; lastAsked: RpcId | undefined; readonly undelivered: Set<RpcId>; part: string }
  let current: Link | undefined
  let connecting: Promise<Link> | undefined
  let isClosed = false
  let queued: RpcMessage[] = []
  let flushing: Promise<void> | undefined

  const asked = (messages: readonly RpcMessage[]) => messages.flatMap((message) => ('method' in message && 'id' in message ? [message.id] : []))

  const flush = (link: Link) => {
    flushing ??= (async () => {
      await Promise.resolve()
      while (queued.length > 0 && current === link) {
        const batch = queued
        queued = []
        const answer = await call(`${rpcPath}/${link.id}`, { method: 'POST', body: JSON.stringify(batch) }).catch((error: unknown) => ({ status: 0, text: String(error) }))
        if (answer.status !== 204) {
          if (answer.status === goneStatus) for (const id of asked(batch)) link.undelivered.add(id)
          lose(link, new RpcUnreached(`cmod serve answered ${answer.status}: ${answer.text}`))
          return
        }
      }
    })().finally(() => {
      flushing = undefined
      if (queued.length > 0 && current === link) flush(link)
    })
  }

  const lose = (link: Link, reason: Error) => {
    if (current !== link) return
    current = undefined
    for (const id of asked(queued)) link.undelivered.add(id)
    queued = []
    link.peer.close(reason)
    reconnect()
    onLost?.()
  }

  const pollLoop = async (link: Link) => {
    while (current === link && !isClosed) {
      const answer = await call(`${rpcPath}/${link.id}?chars=${pollChars}`, { method: 'GET' }).catch((error: unknown) => ({ status: 0, text: String(error) }))
      if (current !== link) return
      if (answer.status !== 200) return lose(link, new RpcUnreached(`cmod serve answered the poll with ${answer.status}: ${answer.text}`))
      for (const message of [JSON.parse(answer.text) as unknown].flat()) {
        const part = partOf(message)
        if (part === undefined) {
          link.peer.receive(message)
          continue
        }
        link.part += String(part['text'])
        if (part['isLast'] !== true) continue
        const whole = link.part
        link.part = ''
        link.peer.receive(JSON.parse(whole))
      }
    }
  }

  let hasConnected = false
  let isRetrying = false
  const waiting = new Set<{ resolve(link: Link): void; reject(error: Error): void }>()

  const reconnect = () => {
    if (isClosed || isRetrying || !(keepsConnecting || hasConnected)) return
    isRetrying = true
    clock.after(retryMs, () => {
      isRetrying = false
      void Promise.allSettled([connecting]).then(() => {
        if (!isClosed && current === undefined) void connection().catch(() => undefined)
      })
    })
  }

  const open = async () => {
    if (isClosed) throw new Error('The connection is closed.')
    try {
      const answer = await call(`${rpcPath}/connect`, { method: 'POST' })
      if (answer.status !== 200) throw new Error(`cmod serve answered the connect with ${answer.status}: ${answer.text}`)
      const { connection: id } = JSON.parse(answer.text) as { readonly connection: string }
      const link: Link = {
        id,
        peer: createPeer({
          send: (message) => {
            link.lastAsked = asked([message])[0] ?? link.lastAsked
            queued.push(message)
            flush(link)
          },
          handle,
        }),
        lastAsked: undefined,
        undelivered: new Set(),
        part: '',
      }
      current = link
      hasConnected = true
      void pollLoop(link)
      void (async () => onConnect?.(client))().catch((error: unknown) => onError?.(error))
      for (const each of waiting) each.resolve(link)
      return current
    } catch (error) {
      onError?.(error)
      reconnect()
      throw new RpcUnreached(error instanceof Error ? error.message : String(error), { cause: error })
    }
  }

  const connection = () => {
    if (current !== undefined) return Promise.resolve(current)
    connecting ??= open().finally(() => {
      connecting = undefined
    })
    return connecting
  }

  const nextLink = (method: string, signal: AbortSignal | undefined): Promise<Link> => {
    if (current !== undefined) return Promise.resolve(current)
    if (isClosed || !(keepsConnecting || hasConnected)) return connection()
    if (!isRetrying) void connection().catch(() => undefined)
    return beforeDeadline(
      clock,
      callDeadline,
      method,
      (passed) =>
        new Promise<Link>((resolve, reject) => {
          const settled = () => {
            waiting.delete(waiter)
            signal?.removeEventListener('abort', stop)
            passed.removeEventListener('abort', stop)
          }
          const waiter = {
            resolve: (link: Link) => (settled(), resolve(link)),
            reject: (error: Error) => (settled(), reject(error)),
          }
          const stop = () => waiter.reject(passed.aborted ? (passed.reason as Error) : new RpcError(rpcCodes.cancelled, `${method} was cancelled.`))
          if (signal?.aborted === true) return stop()
          signal?.addEventListener('abort', stop, { once: true })
          passed.addEventListener('abort', stop, { once: true })
          waiting.add(waiter)
        }),
    )
  }

  const client: RpcClient = {
    get isConnected() {
      return current !== undefined
    },
    async request<Result>(method: string, params?: unknown, signal?: AbortSignal): Promise<Result> {
      const link = await nextLink(method, signal)
      const answer = link.peer.request<Result>(method, params, signal)
      const sent = link.lastAsked
      try {
        return await answer
      } catch (error) {
        if (sent === undefined || !link.undelivered.has(sent) || !isConnectionGone(error)) throw error
        return client.request<Result>(method, params, signal)
      }
    },
    notify(method, params) {
      void connection()
        .then(({ peer }) => peer.notify(method, params))
        .catch(() => undefined)
    },
    async close() {
      isClosed = true
      for (const each of waiting) each.reject(closedError(new Error('the client closed it')))
      const was = current
      current = undefined
      if (was === undefined) return
      was.peer.close(new Error('the client closed it'))
      void call(`${rpcPath}/${was.id}`, { method: 'DELETE' }).catch(() => undefined)
    },
  }
  if (keepsConnecting) void connection().catch(() => undefined)
  return client
}
