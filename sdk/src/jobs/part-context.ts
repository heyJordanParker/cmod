import type { Args, Frozen, HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import type { Mod, PartContext } from '../mod.js'
import type { Claude } from '../runtime/claude.js'
import { beforeDeadline, type Deadline } from '../runtime/deadline.js'
import { dependencyCalls } from '../runtime/dependencies.js'
import { toolInputOf } from '../runtime/tool-calls.js'
import { listed } from '../utils/text.js'
import type { ToolCall, ToolUse } from '../utils/call-effects.js'
import { findProjectScope, type Workspace } from './permissions/find-project-scope.js'
import { targetOf, type Target } from './permissions/match-target.js'
import type { FileSystem } from '../utils/paths.js'

type Session = Omit<Workspace, 'root' | 'cwd'>

type Stream = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

export function workspaceReader({ claude }: PartContext): () => Promise<Workspace> {
  let session: Promise<Session> | undefined
  return async () => {
    session ??= readSession(claude)
    const [{ home, scope, fs }, root, cwd] = await Promise.all([session, claude.session.root(), claude.session.cwd()])
    return { root, cwd, home, fs, scope }
  }
}

async function readSession(claude: Claude): Promise<Session> {
  const fs: FileSystem = {
    read: (path) => claude.fs.read(path),
    stat: (path) => claude.fs.stat(path, { resolve: true }),
    exists: (path) => claude.fs.exists(path),
  }
  const home = await claude.env.home()
  if (home === undefined) throw new Error('HOME is not set, so ~ in a path has no meaning. Start Claude Code with HOME set.')
  return { home, fs, scope: await findProjectScope(claude.plugin.root, home, fs) }
}

export function afterCall<State extends object>(
  part: PartContext<State>,
  contextAfter: (use: ToolUse, workspace: Workspace) => Promise<readonly string[]>,
  failed: (error: unknown) => readonly string[],
): void {
  const readWorkspace = workspaceReader(part)
  part.on('tool.call', async (e, next) => {
    const before = Promise.all([useOf(part, e), readWorkspace()])
    await before.catch(() => undefined)
    const result = await next(e)
    if (result.deny !== undefined || result.isError === true) return result
    const added = await before.then(([use, workspace]) => contextAfter(use, workspace)).catch(failed)
    return added.length === 0 ? result : { ...result, context: [...(result.context ?? []), ...added] }
  })
}

async function useOf({ toolCalls }: PartContext, e: Frozen<Args<'tool.call'>>): Promise<ToolUse> {
  return { tool: e.tool, input: toolInputOf(e), ...(await toolCalls.agentOf(e.tool_use_id)) }
}

export function modOf<State extends object>(context: PartContext<State>, call: ToolCall, folder: string, workspace: Workspace, deadline: Deadline): Mod<State> {
  return modWithin(context, deadline, async () => workspace.scope?.workTreeOf('path' in call ? call.path : folder))
}

export function modWithin<State extends object>({ mod, claude }: PartContext<State>, deadline: Deadline, workTree: () => Promise<string | undefined> = async () => undefined): Mod<State> {
  const within = <Value>(call: string, task: Promise<Value>) => beforeDeadline(claude, deadline, call, task)
  const folderOf = async (cwd: string | undefined) => {
    const folder = cwd ?? (await workTree())
    return folder === undefined ? {} : { cwd: folder }
  }
  const overrides: Pick<Mod<State>, 'process' | 'fs' | 'http' | 'dependencies'> = {
    process: {
      async run(argv, init) {
        const folder = await folderOf(init?.cwd)
        const timeoutMs = Math.min(init?.timeoutMs ?? deadline.ms, deadline.longestMs ?? deadline.ms)
        return beforeDeadline(claude, { ...deadline, ms: timeoutMs }, 'mod.process.run', mod.process.run(argv, { ...init, ...folder, timeoutMs }))
      },
      spawn: (argv, init) => spawnWithin(claude, deadline, folderOf(init?.cwd).then((folder) => mod.process.spawn(argv, { ...init, ...folder }))),
    },
    fs: {
      read: (path) => within('mod.fs.read', mod.fs.read(path)),
      write: (path, text) => within('mod.fs.write', mod.fs.write(path, text)),
      list: (path) => within('mod.fs.list', mod.fs.list(path)),
    },
    http: { fetch: (url, init) => within('mod.http.fetch', mod.http.fetch(url, init)) },
    dependencies: dependencyCalls(claude, within),
  }
  return Object.assign(Object.create(mod) as Mod<State>, overrides)
}

function spawnWithin(claude: Claude, deadline: Deadline, started: Promise<Stream>): Stream {
  async function* pieces(): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
    const stream: AsyncIterator<ProcessSpawnChunk, ProcessSpawnResult> = await started
    let finish: () => void = () => undefined
    const running = beforeDeadline(claude, deadline, 'mod.process.spawn', new Promise<void>((resolve) => (finish = resolve)))
    const passed = running.then(() => new Promise<never>(() => undefined))
    try {
      for (;;) {
        const piece = await Promise.race([stream.next(), passed])
        if (piece.done === true) return piece.value
        yield piece.value
      }
    } finally {
      finish()
      void stream.return?.()
    }
  }
  const result = started.then((stream) => stream.result)
  result.catch(() => undefined)
  return Object.assign(pieces(), { result })
}

export function targetWords(target: Target): string {
  const { key, patterns } = targetOf(target)
  const named = listed(patterns)
  if (key === 'command') return patterns.includes('*') ? 'every shell command' : named
  if (key === 'write') return `edits to ${named}`
  if (key === 'read') return `reads of ${named}`
  if (key === 'fetch') return `fetches of ${named}`
  if (key === 'subagent') return `the ${named} subagent`
  return `the ${named} tool`
}
