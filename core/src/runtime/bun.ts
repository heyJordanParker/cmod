import { serveSocketPath, storeFolder } from '../records.js'
import { interfaceListeners, onMethod, type Listening } from './interfaces.js'
import { addressCall, connectRpc, isConnectionGone, RpcError, rpcCodes, type RpcClient, type RpcClock, type RpcHandler } from './rpc.js'

declare const process: { readonly env: Readonly<Record<string, string | undefined>> }

declare function fetch(url: string, init: { readonly method?: string; readonly body?: string; readonly headers?: Readonly<Record<string, string>>; readonly unix?: string }): Promise<{ readonly status: number; readonly ok: boolean; readonly headers: Iterable<[string, string]>; text(): Promise<string> }>

declare function setTimeout(run: () => void, ms: number): { unref(): unknown }

declare function clearTimeout(timer: unknown): void

export function bunClock(keepsAlive: boolean): RpcClock {
  return {
    after: (ms, run) => {
      const timer = setTimeout(run, ms)
      if (!keepsAlive) timer.unref()
      return { cancel: () => clearTimeout(timer) }
    },
  }
}

export type BunInit = { readonly method?: string; readonly body?: string; readonly headers?: Readonly<Record<string, string>>; readonly socketPath?: string }

export async function bunFetch(url: string, init: BunInit = {}): Promise<{ readonly status: number; readonly ok: boolean; readonly headers: Readonly<Record<string, string>>; readonly text: string }> {
  const answer = await fetch(url, { ...(init.method === undefined ? {} : { method: init.method }), ...(init.body === undefined ? {} : { body: init.body }), ...(init.headers === undefined ? {} : { headers: init.headers }), ...(init.socketPath === undefined ? {} : { unix: init.socketPath }) })
  return { status: answer.status, ok: answer.ok, headers: Object.fromEntries(answer.headers), text: await answer.text() }
}

export function connectServe({
  handle,
  onConnect,
  onError,
  onLost,
  keepsConnecting = false,
}: {
  readonly handle: RpcHandler
  readonly onConnect?: (client: RpcClient) => unknown
  readonly onError?: (error: unknown) => void
  readonly onLost?: () => void
  readonly keepsConnecting?: boolean
}): RpcClient {
  return connectRpc({
    call: addressCall(bunFetch, `unix:${serveSocketPath(storeFolder(process.env))}`),
    handle,
    ...(onConnect === undefined ? {} : { onConnect }),
    ...(onError === undefined ? {} : { onError }),
    ...(onLost === undefined ? {} : { onLost }),
    clock: bunClock(keepsConnecting),
    keepsConnecting,
  })
}

export async function tellServe(method: string, args: readonly unknown[]): Promise<void> {
  const serve = connectServe({ handle: (asked) => Promise.reject(new RpcError(rpcCodes.methodNotFound, `This connection only tells cmod serve, so it answers no ${asked}.`)) })
  try {
    await serve.request(method, args)
  } catch (error) {
    if (!isConnectionGone(error) && !(error instanceof RpcError && error.code === rpcCodes.methodNotFound)) throw error
  } finally {
    await serve.close()
  }
}

export function hearServe<Payload>(listened: readonly Omit<Listening, 'id'>[], heard: (payload: Payload | undefined) => void, report: (error: unknown) => void): RpcClient {
  const listeners = interfaceListeners({ report })
  let isListening = false
  let hasRead = false
  const read = () => {
    hasRead = true
    heard(undefined)
  }
  return connectServe({
    handle: async (method, params, signal) => {
      const answered = await listeners.handler(method, params, signal)
      if (answered !== undefined) return answered.result
      if (method === onMethod) return null
      throw new RpcError(rpcCodes.methodNotFound, `This connection only hears cmod serve, so it answers no ${method}.`)
    },
    onConnect: async (client) => {
      if (!isListening) for (const listening of listened) listeners.listen(client, listening, (payload: Payload) => heard(payload))
      isListening = true
      await listeners.replay(client)
      read()
    },
    onError: () => {
      if (!hasRead) read()
    },
    onLost: read,
    keepsConnecting: true,
  })
}
