import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import * as core from '@cmodjs/core/src/mod.js'
import { storeFolder } from '@cmodjs/core/src/records.js'
import { bind, importsOnly } from '@cmodjs/core/src/runtime/bound.js'
import { bunFetch } from '@cmodjs/core/src/runtime/bun.js'
import type { Claude } from '@cmodjs/core/src/runtime/claude.js'
import { serveConversations } from '@cmodjs/core/src/runtime/conversations.js'
import { cmodPluginName } from '@cmodjs/core/src/runtime/dependencies.js'
import { createProviders, interfaceMethods } from '@cmodjs/core/src/runtime/interfaces.js'
import { createRouter } from '@cmodjs/core/src/runtime/router.js'
import { createSessionsClient } from '@cmodjs/core/src/runtime/sessions.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'

export const summary = "Run a TypeScript script that reads and drives this computer's sessions."

export const help = `Usage: cmod run <file> [arguments…]

${summary}

The script imports sessions, provide, and providers from @cmodjs/core/mod.js,
as a mod does, and cmod connects it to cmod serve: sessions.list, sessions.get,
and sessions.search read every session on this computer and on each device a
sessions provider serves, and a session's send, fork, and end reach the session
that runs it. A script hears no session, because a listener lives in the
session it listens to, so its on and before methods throw. providers(name)
answers every program on this computer that provides the interface, and
provide(name, methods) answers it for every session while the script runs. The
script reads its own arguments from Bun.argv[2] on.

cmod run ends once the script's top level has run.

Example:
  import { Prompt, sessions } from '@cmodjs/core/mod.js'
  const session = await sessions.get(Bun.argv[2])
  const [last] = await session.messages({ last: 1 })
  console.log(last?.type === 'reply' ? last.text : session.title)
  await session.send({ type: Prompt, text: 'Run the tests again.' })`

const coreModule = '@cmodjs/core/mod.js'

export async function run(argv: string[]): Promise<number> {
  const [file, ...args] = argv
  if (file === undefined) throw new Error(`cmod run takes the script to run.\n\n${help}`)
  const path = resolve(file)
  if (!existsSync(path)) throw new Error(`there is no script at ${path}.`)
  const name = basename(path, extname(path)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'script'
  process.argv.splice(0, process.argv.length, process.execPath, path, ...args)
  const report = (_id: string, message: string, error: unknown) => process.stderr.write(`cmod run: ${message}: ${messageOf(error)}\n`)
  const claude = scriptClaude(name, (call) => answer(call))
  const client = createSessionsClient({ name, claude, report })
  const conversations = serveConversations({
    claude,
    router: createRouter(),
    store: storeFolder(process.env),
    project: () => process.cwd(),
    report,
    clear: () => undefined,
    keepsConnecting: false,
    provider: { mod: name, program: name },
    tell: async (_caller, heard, signal) => provided.answer(interfaceMethods.heard, heard, cmodPluginName, signal),
  })
  const provided = createProviders({ name, call: (to, method, input) => answer({ to, method, input }), changed: () => undefined, after: (ms, then) => claude.clock.after(ms, then), report: (error) => report('providers', 'A provider listener failed', error) })
  const answer = async ({ to, method, input }: { readonly to: string; readonly method: string; readonly input?: unknown }): Promise<unknown> => {
    if (to !== cmodPluginName) throw new Error(`${to} is not installed. A cmod run script reaches only cmod serve.`)
    const answered = await conversations.answer({ to, method, input, caller: name })
    if (answered === undefined) throw new Error(`cmod run: the script's sessions have no ${method}.`)
    if ('deny' in answered && typeof answered.deny === 'string') throw new Error(answered.deny)
    return 'value' in answered ? answered.value : undefined
  }
  bind(importsOnly({ sessions: client.sessions, provide: (named, methods) => conversations.provide(named, methods), providers: (named) => provided.providers(named) as never }, 'a cmod run script'))
  Bun.plugin({ name: 'cmod run', setup: (build) => void build.module(coreModule, () => ({ exports: core, loader: 'object' })) })
  try {
    await import(path)
    await new Promise((done) => setTimeout(done, 0))
  } finally {
    await conversations.close()
  }
  return 0
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
      warn: (_id: string, text: string) => void process.stderr.write(`${text}\n`),
      log: (text: string) => void process.stderr.write(`${text}\n`),
    },
    session: {
      id: async () => '',
      cwd: async () => process.cwd(),
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
