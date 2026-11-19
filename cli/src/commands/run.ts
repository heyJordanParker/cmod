import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import * as core from '@cmodjs/core/src/mod.js'
import { storeFolder } from '@cmodjs/core/src/records.js'
import { bind } from '@cmodjs/core/src/runtime/bound.js'
import type { Claude } from '@cmodjs/core/src/runtime/claude.js'
import { serveConversations } from '@cmodjs/core/src/runtime/conversations.js'
import { cmodPluginName } from '@cmodjs/core/src/runtime/dependencies.js'
import { createRouter } from '@cmodjs/core/src/runtime/router.js'
import { conversationMethods, createSessionsClient } from '@cmodjs/core/src/runtime/sessions.js'
import type { BeforeEvent } from '@cmodjs/core/src/session/session.js'
import type { SessionChange } from '@cmodjs/core/src/session/conversation.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'

export const summary = "Run a TypeScript script that reads and drives this computer's sessions."

export const help = `Usage: cmod run <file> [arguments…]

${summary}

The script imports sessions from @cmodjs/core/mod.js, as a mod does, and cmod
connects it to cmod serve: sessions.list, sessions.get, and sessions.search
read every session on this computer and on each machine whose store it serves,
and a session's send, fork, end, and its on and before listeners reach the
session that runs it. The script reads its own arguments from Bun.argv[2] on.

cmod run ends once the script's top level has run and it listens to no
session, and keeps running while it listens, until you stop it with Ctrl-C.

Example:
  import { sessions } from '@cmodjs/core/mod.js'
  const session = await sessions.get(Bun.argv[2])
  session.onTurnEnd((turn) => console.log(turn.answer))`

const coreModule = '@cmodjs/core/mod.js'

export async function run(argv: string[]): Promise<number> {
  const [file, ...args] = argv
  if (file === undefined) throw new Error(`cmod run takes the script to run.\n\n${help}`)
  const path = resolve(file)
  if (!existsSync(path)) throw new Error(`there is no script at ${path}.`)
  const name = basename(path, extname(path)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'script'
  process.argv.splice(0, process.argv.length, process.execPath, path, ...args)
  const report = (_id: string, message: string, error: unknown) => process.stderr.write(`cmod run: ${message}: ${messageOf(error)}\n`)
  const client = createSessionsClient({ name, claude: scriptClaude(name, (call) => answer(call)), report })
  const conversations = serveConversations({ claude: scriptClaude(name, (call) => answer(call)), router: createRouter(), store: storeFolder(process.env), project: () => process.cwd(), report, clear: () => undefined, keepsConnecting: false })
  const signal = new AbortController().signal
  const answer = async ({ to, method, input }: { readonly to: string; readonly method: string; readonly input?: unknown }): Promise<unknown> => {
    if (to === cmodPluginName) {
      const answered = await conversations.answer({ to, method, input, caller: name })
      if (answered === undefined) throw new Error(`cmod run: the script's sessions have no ${method}.`)
      if ('deny' in answered && typeof answered.deny === 'string') throw new Error(answered.deny)
      return 'value' in answered ? answered.value : undefined
    }
    const asked = input as { readonly session: string; readonly change: SessionChange; readonly event: BeforeEvent; readonly isInProject?: boolean }
    if (method === conversationMethods.changed) return client.changed(asked.session, asked.change, asked.isInProject !== false, signal)
    if (method === conversationMethods.before) return (await client.answerBefore(asked.session, asked.event, asked.change, asked.isInProject !== false, signal)) ?? null
    throw new Error(`${to} is not installed. A cmod run script reaches only cmod serve.`)
  }
  bind(scriptImports(client.sessions))
  Bun.plugin({ name: 'cmod run', setup: (build) => void build.module(coreModule, () => ({ exports: core, loader: 'object' })) })
  await import(path)
  await new Promise((done) => setTimeout(done, 0))
  if (conversations.listens()) await stopped()
  await conversations.close()
  return 0
}

function stopped(): Promise<void> {
  return new Promise((done) => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => done())
  })
}

function scriptImports(sessions: core.Imports['sessions']): core.Imports {
  return new Proxy({ sessions } as core.Imports, {
    get: (target, key) => {
      if (key === 'sessions') return target.sessions
      throw new Error(`a cmod run script imports only sessions from ${coreModule}, because ${String(key)} belongs to a Claude Code session.`)
    },
  })
}

function scriptClaude(name: string, call: (input: { readonly to: string; readonly method: string; readonly input?: unknown }) => Promise<unknown>): Claude {
  const claude = {
    plugin: { name, root: process.cwd() },
    http: {
      fetch: async (url: string, init: { readonly method?: string; readonly body?: string; readonly headers?: Record<string, string>; readonly socketPath?: string } = {}) => {
        const answer = await fetch(url, { ...(init.method === undefined ? {} : { method: init.method }), ...(init.body === undefined ? {} : { body: init.body }), ...(init.headers === undefined ? {} : { headers: init.headers }), ...(init.socketPath === undefined ? {} : { unix: init.socketPath }) })
        return { status: answer.status, ok: answer.ok, headers: Object.fromEntries(answer.headers), text: await answer.text() }
      },
    },
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
      warn: (_id: string, text: string) => void process.stderr.write(`${text}\n`),
      log: (text: string) => void process.stderr.write(`${text}\n`),
    },
    session: {
      id: async () => '',
      cwd: async () => process.cwd(),
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
