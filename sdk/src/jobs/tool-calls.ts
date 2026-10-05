import type { Args, Frozen } from 'claude-code'
import type { Mod, PartContext } from '../mod.js'
import type { Claude } from '../runtime/claude.js'
import { beforeDeadline, type Deadline } from '../runtime/deadline.js'
import { dependencyCalls } from '../runtime/hooks.js'
import { reservedKeys, toolCalls } from '../runtime/tool-calls.js'
import { listed } from '../utils/text.js'
import type { ToolCall, ToolUse } from '../utils/call-effects.js'
import { findProjectScope, type ProjectScope, type Workspace } from './permissions/find-project-scope.js'
import { targetOf, type Target } from './permissions/match-target.js'
import type { FileSystem } from '../utils/paths.js'

type Session = { readonly home: string; readonly scope: ProjectScope | undefined; readonly fs: FileSystem }

const sessionsByMod = new WeakMap<Mod, Promise<Session>>()

const namesByMod = new WeakMap<Mod, Set<string>>()

export function reserveName(mod: Mod, kind: string, name: string, taken: string): void {
  const names = namesByMod.get(mod) ?? new Set<string>()
  const key = `${kind}:${name}`
  if (names.has(key)) throw new Error(taken)
  namesByMod.set(mod, names.add(key))
}

export async function workspaceOf({ mod, claude }: PartContext): Promise<Workspace> {
  let session = sessionsByMod.get(mod)
  if (session === undefined) {
    session = readSession(claude)
    sessionsByMod.set(mod, session)
  }
  const [{ home, scope, fs }, cwd] = await Promise.all([session, claude.session.cwd()])
  return { cwd, home, fs, scope }
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

export async function useOf(context: PartContext, e: Frozen<Args<'tool.call'>>): Promise<ToolUse> {
  const input = Object.fromEntries(Object.entries(e).filter(([key]) => !reservedKeys.includes(key)))
  return { tool: e.tool, input, ...(await toolCalls(context).agentOf(e.tool_use_id)) }
}

export function modOf<State extends object>(context: PartContext<State>, call: ToolCall, folder: string, workspace: Workspace, deadline: Deadline): Mod<State> {
  return modWithin(context, deadline, async () => workspace.scope?.workTreeOf('path' in call ? call.path : folder))
}

export function modWithin<State extends object>({ mod, claude }: PartContext<State>, deadline: Deadline, workTree: () => Promise<string | undefined> = async () => undefined): Mod<State> {
  const within = <Value>(call: string, task: Promise<Value>) => beforeDeadline(claude, deadline, call, task)
  return {
    ...mod,
    process: {
      async run(argv, init) {
        const cwd = init?.cwd ?? (await workTree())
        const timeoutMs = Math.min(init?.timeoutMs ?? deadline.ms, deadline.longestMs ?? deadline.ms)
        return beforeDeadline(claude, { ...deadline, ms: timeoutMs }, 'mod.process.run', mod.process.run(argv, { ...init, ...(cwd === undefined ? {} : { cwd }), timeoutMs }))
      },
      spawn: mod.process.spawn,
    },
    fs: {
      read: (path) => within('mod.fs.read', mod.fs.read(path)),
      write: (path, text) => within('mod.fs.write', mod.fs.write(path, text)),
      list: (path) => within('mod.fs.list', mod.fs.list(path)),
    },
    http: { fetch: (url, init) => within('mod.http.fetch', mod.http.fetch(url, init)) },
    dependencies: dependencyCalls(claude, within),
  }
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
