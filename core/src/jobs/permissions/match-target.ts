import { matchesGlob } from '../../utils/matches-glob.js'
import { parseShell } from '../../utils/parse-shell.js'
import { callBaseOf, type CallBase, type CallEffects, type CommandCall, type FetchCall, type FileAccess, type FileCall, type ToolCall } from '../../utils/call-effects.js'
import type { Workspace } from './find-project-scope.js'
import { realPathOf, relativePath } from '../../utils/paths.js'
import { basename } from '../../vendor.js'

export type TargetCalls = { command: CommandCall; read: FileCall; write: FileCall; fetch: FetchCall; subagent: CallBase; tool: CallBase }
export type TargetKey = keyof TargetCalls
export type TargetOf<Key extends TargetKey> = Record<Key, string | string[]> & Partial<Record<Exclude<TargetKey, Key>, never>>
export type Target = { [Key in TargetKey]: TargetOf<Key> }[TargetKey]
export type MatchedCall = { call: ToolCall; access: FileAccess | undefined; folder: string }

const targetKeys: readonly TargetKey[] = ['command', 'read', 'write', 'fetch', 'subagent', 'tool']

export function targetOf(target: Target): { key: TargetKey; patterns: string[]; exclusions: string[] } {
  const keys = targetKeys.filter((key) => key in target)
  const key = keys[0]
  const value: unknown = key === undefined ? undefined : (target as Partial<Record<TargetKey, unknown>>)[key]
  if (key === undefined || keys.length > 1 || !(typeof value === 'string' || (Array.isArray(value) && value.every((pattern) => typeof pattern === 'string')))) {
    throw new Error(`A rule names exactly one of ${targetKeys.join(', ')} with a pattern or a list of patterns; this one names ${keys.join(' and ') || 'none'}.`)
  }
  const all = typeof value === 'string' ? [value] : value
  const patterns = all.filter((pattern) => !pattern.startsWith('!'))
  if (patterns.length === 0) throw new Error(`A ${key} target needs a pattern without "!" for its "!" patterns to leave calls out of, such as ['**', ${all.map((pattern) => `'${pattern}'`).join(', ')}].`)
  return { key, patterns, exclusions: all.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1)) }
}

export async function matchTarget(target: Target, call: CallBase, effects: CallEffects, workspace: Workspace): Promise<MatchedCall[]> {
  const { key, patterns, exclusions } = targetOf(target)
  const base = callBaseOf(call)
  const only = (matched: ToolCall, folder = workspace.cwd): MatchedCall[] => [{ call: matched, access: undefined, folder }]
  const isNamed = (value: string) => matchesAny(value, patterns) && !matchesAny(value, exclusions)
  if (key === 'read' || key === 'write') {
    const matched: MatchedCall[] = []
    for (const access of key === 'read' ? effects.reads : effects.writes) {
      const path = await matchedPath(patterns, access.path, workspace)
      const isExcluded = path !== undefined && exclusions.length > 0 && (await matchedPath(exclusions, access.path, workspace)) !== undefined
      if (path !== undefined && !isExcluded) matched.push({ call: { ...base, path }, access, folder: workspace.cwd })
    }
    return matched
  }
  if (key === 'command') {
    const shell = effects.shell
    if (shell === undefined) return []
    const commandCall = { ...base, commands: shell.commands.map((command) => command.argv), isFullyParsed: shell.isFullyParsed }
    const isEvery = patterns.includes('*')
    if (isEvery && exclusions.length === 0) {
      const folder = await folderInScope(shell, workspace)
      return folder === undefined ? [] : only(commandCall, folder)
    }
    const wanted = patterns.filter((pattern) => pattern !== '*').map(commandPattern)
    const unwanted = exclusions.map(commandPattern)
    for (const command of shell.commands) {
      const isWanted = isEvery || wanted.some((pattern) => commandMatches(pattern, command.argv))
      if (isWanted && !unwanted.some((pattern) => commandMatches(pattern, command.argv)) && (await isInScope(command.folder, workspace))) return only(commandCall, command.folder)
    }
    return []
  }
  if (key === 'fetch') return effects.urls.filter(isNamed).map((url) => ({ call: { ...base, url }, access: undefined, folder: workspace.cwd }))
  if (key === 'subagent') return effects.subagent !== undefined && isNamed(effects.subagent) ? only(base) : []
  return isNamed(call.tool) ? only(base) : []
}

function commandPattern(pattern: string): [string, ...string[]] {
  const command = parseShell(pattern).commands[0]
  if (command === undefined) throw new Error(`The command pattern '${pattern}' names no program.`)
  return command.argv
}

function commandMatches(pattern: [string, ...string[]], argv: [string, ...string[]]): boolean {
  if (basename(argv[0]) !== basename(pattern[0])) return false
  const wanted = splitArguments(pattern.slice(1))
  const actual = splitArguments(argv.slice(1))
  let next = 0
  for (const word of actual.words) if (word === wanted.words[next]) next += 1
  return next === wanted.words.length && wanted.flags.every((flag) => actual.flags.includes(flag))
}

function splitArguments(args: string[]): { flags: string[]; words: string[] } {
  const end = args.indexOf('--')
  const flags: string[] = []
  const words: string[] = []
  args.forEach((arg, index) => {
    if ((end < 0 || index < end) && arg.startsWith('-') && arg !== '-') flags.push(arg, arg.replace(/=.*$/s, ''))
    else if (index !== end) words.push(arg)
  })
  return { flags, words }
}

export async function folderInScope(shell: NonNullable<CallEffects['shell']>, workspace: Workspace): Promise<string | undefined> {
  const folders = shell.commands.length === 0 ? [workspace.cwd] : shell.commands.map((command) => command.folder)
  for (const folder of folders) if (await isInScope(folder, workspace)) return folder
  return undefined
}

async function isInScope(folder: string, workspace: Workspace): Promise<boolean> {
  return workspace.scope === undefined || (await workspace.scope.workTreeOf(folder)) !== undefined
}

async function matchedPath(patterns: string[], path: string, workspace: Workspace): Promise<string | undefined> {
  if (await pathMatches(patterns, path, workspace)) return path
  const realPath = await realPathOf(path, workspace.fs)
  return realPath !== undefined && realPath !== path && (await pathMatches(patterns, realPath, workspace)) ? realPath : undefined
}

async function pathMatches(patterns: string[], path: string, workspace: Workspace): Promise<boolean> {
  const base = workspace.scope === undefined ? workspace.projectRoot : await workspace.scope.workTreeOf(path)
  if (base === undefined) return false
  const target = path.toLowerCase()
  return patterns.some((pattern) => {
    const folded = pattern.toLowerCase()
    if (folded.startsWith('/')) return matchesGlob(target, folded)
    const isHomePattern = folded.startsWith('~/')
    const relative = relativePath((isHomePattern ? workspace.home : base).toLowerCase(), target)
    if (isHomePattern) return relative !== undefined && matchesGlob(relative, folded.slice(2))
    return (relative !== undefined && matchesGlob(relative, folded)) || (folded.startsWith('**') && matchesGlob(target, folded))
  })
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(value.toLowerCase(), pattern.toLowerCase()))
}
