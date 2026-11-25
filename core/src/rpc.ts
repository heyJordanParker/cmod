import { serveSocketPath, storeFolder } from './records.js'
import { bind, importsOnly } from './runtime/bound.js'
import { connectServe } from './runtime/bun.js'
import { cmodPluginName } from './runtime/dependencies.js'
import { createProviders, interfaceListeners, interfaceMethods, programConnection, serveProviders, type Connection } from './runtime/interfaces.js'
import { RpcError, rpcCodes } from './runtime/rpc.js'
import { messageOf } from './utils/text.js'

declare const process: { readonly env: Readonly<Record<string, string | undefined>>; readonly stderr: { write(text: string): unknown } }

declare function setTimeout(run: () => void, ms: number): unknown

declare function clearTimeout(timer: unknown): void

export type { Connection }

export class NotHeld extends Error {
  constructor(session: string) {
    super(`This provider holds no session ${session}.`)
  }
}

const modVariable = 'CMOD_MOD'

const programVariable = 'CMOD_PROGRAM'

export async function connect(): Promise<Connection> {
  const mod = process.env[modVariable]
  if (mod === undefined || mod === '') throw new Error(`connect() names its mod by ${modVariable}, which cmod program sets for every program it starts, and ${modVariable} is not set. Start this program from a program job with singleInstance or isService.`)
  const report = (error: unknown) => void process.stderr.write(`${mod}: ${messageOf(error)}\n`)
  const socket = serveSocketPath(storeFolder(process.env))
  const listeners = interfaceListeners({ report })
  let isWaitTold = false
  let connected: () => void = () => undefined
  const isConnected = new Promise<void>((resolve) => {
    connected = resolve
  })
  const client = connectServe({
    handle: async (method, params, signal) => {
      const answered = await listeners.handler(method, params, signal)
      if (answered !== undefined) return answered.result
      const provided = served.handler(method, params, signal)
      if (provided !== undefined) return provided.catch((error: unknown) => Promise.reject(error instanceof NotHeld ? new RpcError(rpcCodes.notHeld, error.message) : error))
      throw new RpcError(rpcCodes.methodNotFound, `${mod} answers no ${method}.`)
    },
    onConnect: async (connection) => {
      await served.replay()
      await listeners.replay(connection)
      connected()
    },
    onError: (error) => {
      if (isWaitTold) return
      isWaitTold = true
      report(new Error(`waits for cmod serve at ${socket}: ${messageOf(error)}`))
    },
    keepsConnecting: true,
  })
  listeners.followProviders(client)
  const after =(ms: number, run: () => void) => {
    const timer = setTimeout(run, ms)
    return { cancel: () => clearTimeout(timer) }
  }
  const served = serveProviders({ serve: client, listeners, provider: { mod, program: process.env[programVariable] || mod }, tell: async (_caller, heard, signal) => provided.answer(interfaceMethods.heard, heard, cmodPluginName, signal), sessionCode: () => [], after, report })
  const provided = createProviders({ name: mod, call: (_to, method, input) => served.answer(method, input, mod) ?? Promise.reject(new Error(`${mod}'s program reaches no ${method}.`)), changed: () => undefined, after, report })
  bind(importsOnly({ provide: (name, methods) => served.provide(name, methods), providers: (name) => provided.providers(name) as never }, `${mod}'s program`))
  await isConnected
  return programConnection({ client, listeners, served, after })
}
