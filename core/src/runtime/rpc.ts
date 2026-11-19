export type RpcId = number | string

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
  readonly connection: RpcConnection
  readonly outbox: RpcMessage[]
  poll: ((messages: RpcMessage[]) => void) | undefined
  seenAt: number
}

export type RpcHttpRequest = { readonly method: string; readonly path: string; readonly signal: AbortSignal; json(): Promise<unknown> }

export type RpcHttpAnswer = { readonly status: number; readonly json?: unknown }

export type RpcRoutes = {
  route(request: RpcHttpRequest): Promise<RpcHttpAnswer> | undefined
  connections(): RpcConnection[]
  close(): void
}

const timers = globalThis as unknown as { setTimeout(run: () => void, ms: number): unknown; clearTimeout(timer: unknown): void }

export function rpcRoutes({
  handle,
  onClose,
  now,
  pollMs = 8000,
  liveMs = 30_000,
}: {
  readonly handle: (connection: RpcConnection) => RpcHandler
  readonly onClose?: (connection: RpcConnection) => void
  readonly now: () => number
  readonly pollMs?: number
  readonly liveMs?: number
}): RpcRoutes {
  const held = new Map<string, Held>()

  const drop = (id: string, reason: string) => {
    const each = held.get(id)
    if (each === undefined) return
    held.delete(id)
    each.poll?.([])
    each.connection.close(new Error(reason))
    onClose?.(each.connection)
  }

  const open = (): Held => {
    const id = crypto.randomUUID()
    const outbox: RpcMessage[] = []
    let entry: Held | undefined
    const peer = createPeer({
      send: (message) => {
        if (entry === undefined) return
        if (entry.poll === undefined) return void outbox.push(message)
        const poll = entry.poll
        entry.poll = undefined
        poll([...outbox.splice(0), message])
      },
      handle: (method, params, signal) => handler(method, params, signal),
    })
    const connection: RpcConnection = Object.assign(peer, { id })
    const handler = handle(connection)
    entry = { connection, outbox, poll: undefined, seenAt: now() }
    held.set(id, entry)
    return entry
  }

  const sweep = () => {
    for (const [id, each] of held) if (each.poll === undefined && now() - each.seenAt > liveMs) drop(id, `no poll for ${liveMs / 1000} s`)
  }

  const known = (id: string) => {
    const each = held.get(id)
    if (each === undefined) throw new GoneError(id)
    each.seenAt = now()
    return each
  }

  const poll = (each: Held, signal: AbortSignal) =>
    new Promise<RpcMessage[]>((resolve) => {
      each.poll?.([])
      if (each.outbox.length > 0) return resolve(each.outbox.splice(0))
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
        each.seenAt = now()
        resolve([])
      })
    })

  const route = async (request: RpcHttpRequest): Promise<RpcHttpAnswer> => {
    sweep()
    const [, id] = /^\/rpc\/([\w-]{1,64})$/.exec(request.path) ?? []
    try {
      if (request.path === `${rpcPath}/connect` && request.method === 'POST') return { status: 200, json: { connection: open().connection.id } }
      if (id === undefined) return { status: 404, json: { error: `cmod has no ${request.method} ${request.path}.` } }
      if (request.method === 'DELETE') {
        drop(id, 'the client closed it')
        return { status: 204 }
      }
      const each = known(id)
      if (request.method === 'GET') return { status: 200, json: await poll(each, request.signal) }
      if (request.method === 'POST') {
        each.connection.receive(await request.json())
        return { status: 204 }
      }
      return { status: 405, json: { error: `cmod has no ${request.method} ${request.path}.` } }
    } catch (error) {
      if (error instanceof GoneError) return { status: 410, json: { error: error.message } }
      throw error
    }
  }

  return {
    route: (request) => (request.path.startsWith(rpcPath) ? route(request) : undefined),
    connections: () => [...held.values()].map((each) => each.connection),
    close() {
      for (const id of held.keys()) drop(id, 'the server stopped')
    },
  }
}

export class RpcUnreached extends Error {}

class GoneError extends Error {
  constructor(id: string) {
    super(`cmod has no connection ${id}: it closed, or the server started again. Connect again.`)
  }
}

export type HttpCall = (path: string, init: { readonly method: 'GET' | 'POST' | 'DELETE'; readonly body?: string }) => Promise<{ readonly status: number; readonly text: string }>

export type HttpFetch = (url: string, init: { readonly method: string; readonly body?: string; readonly headers?: Readonly<Record<string, string>>; readonly socketPath?: string }) => Promise<{ readonly status: number; readonly text: string }>

export function addressCall(fetch: HttpFetch, address: string): HttpCall {
  const socketPath = address.startsWith('unix:') ? address.slice('unix:'.length) : undefined
  const base = socketPath === undefined ? `http://${address}` : 'http://localhost'
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
  wait,
  retryMs = 2000,
  keepsConnecting = false,
}: {
  readonly call: HttpCall
  readonly handle: RpcHandler
  readonly onConnect?: (client: RpcClient) => unknown
  readonly onError?: (error: unknown) => void
  readonly wait: (ms: number) => Promise<void>
  readonly retryMs?: number
  readonly keepsConnecting?: boolean
}): RpcClient {
  let current: { readonly id: string; readonly peer: Peer } | undefined
  let connecting: Promise<{ readonly id: string; readonly peer: Peer }> | undefined
  let isClosed = false
  let queued: RpcMessage[] = []
  let flushing: Promise<void> | undefined

  const flush = (id: string, peer: Peer) => {
    flushing ??= (async () => {
      await Promise.resolve()
      while (queued.length > 0 && current?.id === id) {
        const batch = queued
        queued = []
        const answer = await call(`${rpcPath}/${id}`, { method: 'POST', body: JSON.stringify(batch) }).catch((error: unknown) => ({ status: 0, text: String(error) }))
        if (answer.status !== 204) {
          lose(id, peer, new RpcUnreached(`cmod serve answered ${answer.status}: ${answer.text}`))
          return
        }
      }
    })().finally(() => {
      flushing = undefined
      if (queued.length > 0 && current?.id === id) flush(id, peer)
    })
  }

  const lose = (id: string, peer: Peer, reason: Error) => {
    if (current?.id !== id) return
    current = undefined
    queued = []
    peer.close(reason)
    reconnect()
  }

  const isCurrent = (id: string) => current?.id === id

  const pollLoop = async (id: string, peer: Peer) => {
    while (isCurrent(id) && !isClosed) {
      const answer = await call(`${rpcPath}/${id}`, { method: 'GET' }).catch((error: unknown) => ({ status: 0, text: String(error) }))
      if (!isCurrent(id)) return
      if (answer.status !== 200) return lose(id, peer, new RpcUnreached(`cmod serve answered the poll with ${answer.status}: ${answer.text}`))
      peer.receive(JSON.parse(answer.text))
    }
  }

  let hasConnected = false

  const reconnect = () => {
    if (isClosed || !(keepsConnecting || hasConnected)) return
    void wait(retryMs).then(() => {
      if (!isClosed && current === undefined) void connection().catch(() => undefined)
    })
  }

  const open = async () => {
    if (isClosed) throw new Error('The connection is closed.')
    try {
      const answer = await call(`${rpcPath}/connect`, { method: 'POST' })
      if (answer.status !== 200) throw new Error(`cmod serve answered the connect with ${answer.status}: ${answer.text}`)
      const { connection: id } = JSON.parse(answer.text) as { readonly connection: string }
      const peer: Peer = createPeer({
        send: (message) => {
          queued.push(message)
          flush(id, peer)
        },
        handle,
      })
      current = { id, peer }
      hasConnected = true
      void pollLoop(id, peer)
      void (async () => onConnect?.(client))().catch((error: unknown) => onError?.(error))
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

  const client: RpcClient = {
    get isConnected() {
      return current !== undefined
    },
    async request<Result>(method: string, params?: unknown, signal?: AbortSignal) {
      const { peer } = await connection()
      return peer.request<Result>(method, params, signal)
    },
    notify(method, params) {
      void connection()
        .then(({ peer }) => peer.notify(method, params))
        .catch(() => undefined)
    },
    async close() {
      isClosed = true
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
