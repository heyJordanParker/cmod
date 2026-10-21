import type { JobContext } from '../mod.js'
import { beforeDeadline, type Deadline } from '../runtime/deadline.js'
import { engineOf } from '../runtime/engine.js'
import { toolInputOf } from '../runtime/tool-calls.js'
import { modNote } from '../session/context/turn/message/note.js'
import { listed } from '../utils/text.js'
import type { Call } from '../utils/call-effects.js'
import { findProjectScope, type Workspace } from './permissions/find-project-scope.js'
import { targetOf, type Target } from './permissions/match-target.js'
import type { FileSystem } from '../utils/paths.js'
import type { Subscription } from '../utils/subscription.js'

type Session = Omit<Workspace, 'projectRoot' | 'cwd'>

export function workspaceReader({ mod }: JobContext): () => Promise<Workspace> {
  const { claude } = engineOf(mod)
  let session: Promise<Session> | undefined
  return async () => {
    session ??= readSession()
    const [{ home, scope, fs }, projectRoot, cwd] = await Promise.all([session, claude.session.root(), claude.session.cwd()])
    return { projectRoot, cwd, home, fs, scope }
  }

  async function readSession(): Promise<Session> {
    const fs: FileSystem = {
      read: (path) => claude.fs.read(path),
      stat: (path) => claude.fs.stat(path, { resolve: true }),
      exists: (path) => claude.fs.exists(path),
    }
    const home = await claude.env.home()
    if (home === undefined) throw new Error('HOME is not set, so ~ in a path has no meaning. Start Claude Code with HOME set.')
    return { home, fs, scope: await findProjectScope(claude.plugin.root, home, fs) }
  }
}

export function afterCall<State extends object>(job: JobContext<State>, contextAfter: (call: Call, workspace: Workspace) => Promise<readonly string[]>, failed: (error: unknown) => readonly string[]): Subscription {
  const { router, toolCalls } = engineOf(job.mod)
  const readWorkspace = workspaceReader(job)
  return router.add('tool.call', async (e, next) => {
    const before = Promise.all([toolCalls.agentOf(e.tool_use_id).then((agent): Call => ({ tool: e.tool, input: toolInputOf(e), ...agent })), readWorkspace()])
    await Promise.allSettled([before])
    const result = await next(e)
    if (result.deny !== undefined || result.isError === true) return result
    const added = await before.then(([use, workspace]) => contextAfter(use, workspace)).catch(failed)
    return added.length === 0 ? result : { ...result, context: [...(result.context ?? []), ...added.map((note) => modNote(job.mod.name, note))] }
  })
}

export async function inFolder(call: Call, folder: string, workspace: Workspace): Promise<Call & { readonly folder: string }> {
  return { ...call, folder: (await workspace.scope?.workTreeOf('path' in call ? call.path : folder)) ?? folder }
}

export function withinDeadline<Value>(mod: object, deadline: Deadline, subject: string, run: () => Value | Promise<Value>): Promise<Value> {
  return beforeDeadline(engineOf(mod).claude, deadline, subject, Promise.resolve().then(run))
}

export function targetWords(target: Target): string {
  const { key, patterns, exclusions } = targetOf(target)
  const named = exclusions.length === 0 ? listed(patterns) : `${listed(patterns)} except ${listed(exclusions)}`
  if (key === 'command') return patterns.includes('*') ? 'every shell command' : named
  if (key === 'write') return `edits to ${named}`
  if (key === 'read') return `reads of ${named}`
  if (key === 'fetch') return `fetches of ${named}`
  if (key === 'subagent') return `the ${named} subagent`
  return `the ${named} tool`
}
