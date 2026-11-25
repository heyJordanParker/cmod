import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { serveSocketPath, storeFolder } from '@cmodjs/core/src/records.js'
import { isConnectionGone } from '@cmodjs/core/src/runtime/rpc.js'
import { bunFetch } from '@cmodjs/core/src/runtime/bun.js'
import type { Claude } from '@cmodjs/core/src/runtime/claude.js'
import { serveConversations } from '@cmodjs/core/src/runtime/conversations.js'
import { cmodPluginName } from '@cmodjs/core/src/runtime/dependencies.js'
import { createProviders, interfaceMethods } from '@cmodjs/core/src/runtime/interfaces.js'
import { createRouter } from '@cmodjs/core/src/runtime/router.js'
import { createSessionsClient, type SessionsClient } from '@cmodjs/core/src/runtime/sessions.js'
import type { Imports } from '@cmodjs/core/src/mod.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'

export type Script = {
  readonly sessions: SessionsClient['sessions']
  answer(method: string, input: unknown): Promise<unknown>
  provide: ReturnType<typeof serveConversations>['provide']
  readonly providers: Imports['providers']
  close(): Promise<void>
}

export function connectScript(name: string, project: string = process.cwd()): Script {
  const report = (_id: string, message: string, error: unknown) => process.stderr.write(`cmod ${name}: ${message}: ${messageOf(error)}\n`)
  const claude = scriptClaude(name, (call) => answer(call.method, call.input, call.to))
  const client = createSessionsClient({ name, claude, report })
  const conversations = serveConversations({
    claude,
    router: createRouter(),
    store: storeFolder(process.env),
    project: () => project,
    report,
    clear: () => undefined,
    keepsConnecting: false,
    provider: { mod: name, program: name },
    tell: async (_caller, heard, signal) => provided.answer(interfaceMethods.heard, heard, cmodPluginName, signal),
  })
  const provided = createProviders({ name, call: (to, method, input) => answer(method, input, to), changed: () => undefined, after: (ms, then) => claude.clock.after(ms, then), report: (error) => report('providers', 'A provider listener failed', error) })
  const answer = async (method: string, input: unknown, to: string = cmodPluginName): Promise<unknown> => {
    if (to !== cmodPluginName) throw new Error(`${to} is not installed. A cmod run script reaches only cmod serve.`)
    const answered = await conversations.answer({ to, method, input, caller: name })
    if (answered === undefined) throw new Error(`cmod ${name}: the script's sessions have no ${method}.`)
    if ('deny' in answered && typeof answered.deny === 'string') throw new Error(answered.deny)
    return 'value' in answered ? answered.value : undefined
  }
  return {
    sessions: client.sessions,
    answer: (method, input) => answer(method, input),
    provide: (named, methods) => conversations.provide(named, methods),
    providers: (named) => provided.providers(named) as never,
    close: () => conversations.close(),
  }
}

export async function withScript<Value>(name: string, project: string, run: (script: Script) => Promise<Value>): Promise<Value> {
  const socket = serveSocketPath(storeFolder(process.env))
  const unreached = (reason: string) => new Error(`cmod ${name} reaches no cmod serve at ${socket}: ${reason}. A Claude Code session with the cmod plugin starts it.`)
  if (!existsSync(socket)) throw unreached('there is no socket')
  const script = connectScript(name, project)
  try {
    return await run(script)
  } catch (error) {
    if (isConnectionGone(error)) throw unreached(messageOf(error))
    throw error
  } finally {
    await script.close()
  }
}

function scriptClaude(name: string, call: (input: { readonly to: string; readonly method: string; readonly input?: unknown }) => Promise<unknown>): Claude {
  const claude = {
    plugin: { name, root: process.cwd() },
    http: { fetch: bunFetch },
    clock: {
      now: async () => Date.now(),
      after: (ms: number, fire: () => void) => {
        const timer = setTimeout(fire, ms)
        return { cancel: () => clearTimeout(timer) }
      },
      every: (ms: number, fire: () => void) => {
        const timer = setInterval(fire, ms)
        return { cancel: () => clearInterval(timer) }
      },
    },
    fs: {
      read: (path: string) => readFile(path, 'utf8'),
      write: async (path: string, text: string) => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, text)
      },
      list: async (path: string) =>
        Promise.all(
          (await readdir(path, { withFileTypes: true })).map(async (entry) => {
            const kind = entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other'
            const info = kind === 'file' ? await stat(resolve(path, entry.name)) : undefined
            return { name: entry.name, kind, size: info?.size ?? 0, mtimeMs: info?.mtimeMs ?? 0 }
          }),
        ),
      exists: async (path: string) => existsSync(path),
    },
    ui: {
      warn: (id: string, text: string) => void (id === 'serve:connect' || process.stderr.write(`${text}\n`)),
      log: (text: string) => void process.stderr.write(`${text}\n`),
    },
    session: {
      id: async () => '',
      cwd: async () => process.cwd(),
      send: async () => ({ isDelivered: false }),
    },
    env: {
      home: async () => process.env['HOME'],
      dataHome: async () => process.env['XDG_DATA_HOME'],
      cacheHome: async () => process.env['XDG_CACHE_HOME'],
      configHome: async () => process.env['CLAUDE_CONFIG_DIR'],
    },
    settings: { read: async () => ({}) },
    agent: { list: async () => [] },
    cmod: { call },
  }
  return absentAs(claude, 'claude') as unknown as Claude
}

function absentAs<Value extends object>(value: Value, path: string): Value {
  return new Proxy(value, {
    get: (target, key) => {
      const found = Reflect.get(target, key) as unknown
      if (typeof key === 'symbol' || key === 'then') return found
      if (found === undefined) return absentAs(() => undefined, `${path}.${key}`)
      return typeof found === 'object' && found !== null ? absentAs(found, `${path}.${key}`) : found
    },
    apply: () => {
      throw new Error(`a cmod run script has no ${path}, because it belongs to a Claude Code session.`)
    },
  })
}
