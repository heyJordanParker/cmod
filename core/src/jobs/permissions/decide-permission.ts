import { strictness } from '../../runtime/hooks.js'
import { messageOf } from '../../utils/text.js'
import { callBaseOf, callEffects, type CallEffects, type ToolCall, type ToolUse } from '../../utils/call-effects.js'
import type { Workspace } from './find-project-scope.js'
import { folderInScope, matchTarget, targetOf, type MatchedCall, type Target, type TargetCalls, type TargetKey, type TargetOf } from './match-target.js'
import { resolvePath } from '../../utils/paths.js'

export type Rule<Mod> = {
  [Key in TargetKey]: TargetOf<Key> & {
    when?: (call: TargetCalls[Key], mod: Mod) => boolean | Promise<boolean>
    reason?: string
  }
}[TargetKey]
type WhenOf<Mod> = { when?(call: ToolCall, mod: Mod): boolean | Promise<boolean> }
export type PermissionRules<Mod> = { deny?: Rule<Mod>[]; ask?: Rule<Mod>[] }
export type Decision = 'allow' | 'ask' | 'deny'
export type Verdict = { decision: Decision; reason?: string }

const wordBoundary = '\\s;&|()<>\'"`='

export function stricterVerdict<Result extends Verdict>(first: Result, second: Result): Result {
  return strictness.indexOf(second.decision) > strictness.indexOf(first.decision) ? second : first
}

export async function decidePermission<Mod>(rules: PermissionRules<Mod>, use: ToolUse, workspace: Workspace, modOf: (call: ToolCall, folder: string) => Mod): Promise<Verdict | undefined> {
  try {
    const effects = callEffects(use, workspace)
    for (const decision of ['deny', 'ask'] as const) {
      for (const rule of rules[decision] ?? []) {
        const outcome = await ruleOutcome(rule, use, effects, workspace, modOf)
        if (outcome === undefined) continue
        const reason = [rule.reason, outcome.failure === undefined ? undefined : `Its when check failed: ${outcome.failure}`].filter((part) => part !== undefined).join(' ')
        return reason === '' ? { decision } : { decision, reason }
      }
    }
    return undefined
  } catch (error) {
    return { decision: 'deny', reason: `The permissions job failed, so it denies the call: ${messageOf(error)}` }
  }
}

async function ruleOutcome<Mod>(rule: Rule<Mod>, use: ToolUse, effects: CallEffects, workspace: Workspace, modOf: (call: ToolCall, folder: string) => Mod): Promise<{ failure: string | undefined } | undefined> {
  const matched = await matchTarget(rule, use, effects, workspace)
  const calls = matched.length > 0 ? matched : await unparsedMatches(rule, use, effects, workspace)
  if (calls.length === 0) return undefined
  const { when }: WhenOf<Mod> = rule
  if (when === undefined) return { failure: undefined }
  for (const { call, access, folder } of calls) {
    const fullCall = access?.contents === undefined ? call : { ...call, ...(await access.contents()) }
    try {
      if (await when(fullCall, modOf(fullCall, folder))) return { failure: undefined }
    } catch (error) {
      return { failure: messageOf(error) }
    }
  }
  return undefined
}

async function unparsedMatches(target: Target, use: ToolUse, effects: CallEffects, workspace: Workspace): Promise<MatchedCall[]> {
  const shell = effects.shell
  if (shell === undefined || shell.isFullyParsed) return []
  const { key, patterns } = targetOf(target)
  const base = callBaseOf(use)
  if (key === 'command') {
    const isMatched = patterns.some((pattern) => pattern.split(/\s+/).filter((word) => word !== '').every((word) => containsWord(shell.line, word)))
    const folder = isMatched ? await folderInScope(shell, workspace) : undefined
    return folder === undefined ? [] : [{ call: { ...base, commands: shell.commands.map((command) => command.argv), isFullyParsed: false }, access: undefined, folder }]
  }
  if (key !== 'read' && key !== 'write') return []
  const line = shell.line.toLowerCase()
  const named = patterns.map((pattern) => pattern.slice(pattern.lastIndexOf('/') + 1)).filter((segment) => segment !== '' && !/[*?[\]{}]/.test(segment) && line.includes(segment.toLowerCase()))
  const folder = named.length === 0 ? undefined : await folderInScope(shell, workspace)
  if (folder === undefined) return []
  return named.map((segment) => ({ call: { ...base, path: resolvePath(segment, folder) }, access: undefined, folder }))
}

function containsWord(line: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[${wordBoundary}/])${escaped}(?=$|[${wordBoundary}])`).test(line)
}
