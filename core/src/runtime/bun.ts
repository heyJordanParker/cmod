import { serveSocketPath, storeFolder } from '../records.js'
import { addressCall, connectRpc, type RpcClient, type RpcHandler } from './rpc.js'

declare const process: { readonly env: Readonly<Record<string, string | undefined>> }

declare function fetch(url: string, init: { readonly method?: string; readonly body?: string; readonly headers?: Readonly<Record<string, string>>; readonly unix?: string }): Promise<{ readonly status: number; readonly ok: boolean; readonly headers: Iterable<[string, string]>; text(): Promise<string> }>

declare function setTimeout(run: () => void, ms: number): { unref(): unknown }

export type BunInit = { readonly method?: string; readonly body?: string; readonly headers?: Readonly<Record<string, string>>; readonly socketPath?: string }

export async function bunFetch(url: string, init: BunInit = {}): Promise<{ readonly status: number; readonly ok: boolean; readonly headers: Readonly<Record<string, string>>; readonly text: string }> {
  const answer = await fetch(url, { ...(init.method === undefined ? {} : { method: init.method }), ...(init.body === undefined ? {} : { body: init.body }), ...(init.headers === undefined ? {} : { headers: init.headers }), ...(init.socketPath === undefined ? {} : { unix: init.socketPath }) })
  return { status: answer.status, ok: answer.ok, headers: Object.fromEntries(answer.headers), text: await answer.text() }
}

export function connectServe({
  handle,
  onConnect,
  onError,
  keepsConnecting = false,
}: {
  readonly handle: RpcHandler
  readonly onConnect?: (client: RpcClient) => unknown
  readonly onError?: (error: unknown) => void
  readonly keepsConnecting?: boolean
}): RpcClient {
  return connectRpc({
    call: addressCall(bunFetch, `unix:${serveSocketPath(storeFolder(process.env))}`),
    handle,
    ...(onConnect === undefined ? {} : { onConnect }),
    ...(onError === undefined ? {} : { onError }),
    wait: (ms) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        if (!keepsConnecting) timer.unref()
      }),
    keepsConnecting,
  })
}
