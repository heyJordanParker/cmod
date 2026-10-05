import type { Args, ClassicHookInputs, Frozen } from 'claude-code'
import type { HookAnswer, ModEvent, ModHook } from '../mod.js'
import { configFolders } from '../records.js'
import type { Claude } from './claude.js'
import type { RoutedHook } from './router.js'
import { toolInputOf, type ToolCalls } from './tool-calls.js'
import { callEffects, type FileAccess, type ToolUse } from '../utils/call-effects.js'
import { dynamicPattern } from '../utils/parse-shell.js'
import { messageOf } from '../utils/text.js'

export type RoutedEvent =
  | `classic.${ModEvent}`
  | 'tool.check'
  | 'tool.call'
  | 'prompt.submit'
  | 'prompt.context'
  | 'command.run'
  | 'session.measure'
  | 'skill.prompt'
  | 'ui.render'
  | 'ui.press'
  | 'ui.close'
  | 'cmod.call'

type ClassicFields = Record<string, unknown>

type PreToolUseInput = Parameters<ModHook<'PreToolUse'>>[0]

type CallFiles = PreToolUseInput['files']

const flags: readonly string[] = ['suppressOriginalPrompt', 'reloadSkills', 'retry']

const readFields: Record<ModEvent, readonly string[]> = {
  SessionStart: ['additionalContext', 'initialUserMessage', 'sessionTitle', 'watchPaths', 'reloadSkills'],
  SessionEnd: [],
  UserPromptSubmit: ['additionalContext', 'sessionTitle', 'suppressOriginalPrompt'],
  InstructionsLoaded: [],
  PreToolUse: ['additionalContext', 'permissionDecision', 'permissionDecisionReason', 'updatedInput'],
  PermissionRequest: ['decision'],
  PermissionDenied: ['retry'],
  PostToolUse: ['additionalContext', 'updatedToolOutput', 'updatedMCPToolOutput'],
  PostToolUseFailure: ['additionalContext'],
  PostToolBatch: ['additionalContext'],
  SubagentStart: ['additionalContext'],
  SubagentStop: ['additionalContext'],
  Notification: [],
  PreCompact: [],
  Stop: ['additionalContext'],
  StopFailure: [],
  CwdChanged: [],
}

export function classicHook<E extends ModEvent>(name: string, event: E, hook: ModHook<E>, claude: Claude, calls: ToolCalls): RoutedHook<RoutedEvent> {
  const inputOf = async (e: unknown): Promise<unknown> => {
    if (event === 'PreToolUse') return preToolUseInput(name, e as Frozen<Args<'classic.PreToolUse'>>, claude, calls.agentOf)
    if (event !== 'PostToolUse' && event !== 'PostToolUseFailure') return e
    const input = e as ClassicHookInputs['PostToolUse' | 'PostToolUseFailure']
    const cwd = calls.cwdOf(input.tool_use_id) ?? input.cwd
    return { ...input, files: await callFiles(name, claude, { tool: input.tool_name, input: input.tool_input }, cwd) }
  }
  const resultOf = async (e: unknown): Promise<ClassicFields | undefined> => {
    const answer = await hook((await inputOf(e)) as Parameters<ModHook<E>>[0])
    if (answer === undefined) return undefined
    if (answer.systemMessage !== undefined) claude.ui.log(answer.systemMessage)
    return classicResult(event, answer)
  }
  const routed = async (e: unknown, next: (e: unknown) => Promise<unknown>) => {
    const ours = await resultOf(e).catch((error: unknown): ClassicFields | undefined => {
      const reason = `${name}: the ${event} hook failed: ${messageOf(error)}`
      if (event === 'PreToolUse') return { deny: reason }
      if (event === 'PermissionRequest') return { decision: { behavior: 'deny', message: reason } }
      claude.ui.log(reason)
      return undefined
    })
    if (ours === undefined) return next(e)
    return mergeClassic(event, (await next(e)) as ClassicFields, ours)
  }
  return routed as unknown as RoutedHook<RoutedEvent>
}

const frontmatter = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/

const baseDirectoryLine = /^Base directory for this skill: [^\n]*\n\n/

export function userSkillHook(claude: Claude): RoutedHook<'skill.prompt'> {
  return async (e, next) => {
    const { name, root } = claude.plugin
    if (!e.skill.startsWith(`${name}:`)) return next(e)
    const skill = e.skill.slice(name.length + 1)
    const skills = `${root}/skills`
    if (!(await claude.fs.exists(skills)) || !(await claude.fs.list(skills)).some((entry) => entry.name === skill)) return next(e)
    if ((await claude.fs.stat(`${skills}/${skill}`)).kind !== 'dir') return next(e)
    const env = { HOME: await claude.env.home(), CLAUDE_CONFIG_DIR: await claude.env.configHome() }
    for (const { folder } of configFolders(env, name, await claude.session.root()).toReversed()) {
      const path = `${folder}/skills/${skill}/SKILL.md`
      if (await claude.fs.exists(path)) return { text: `${baseDirectoryLine.exec(e.text)?.[0] ?? ''}${(await claude.fs.read(path)).replace(frontmatter, '')}` }
    }
    return next(e)
  }
}

async function preToolUseInput(name: string, envelope: Frozen<Args<'classic.PreToolUse'>>, claude: Claude, agentOf: ToolCalls['agentOf']): Promise<PreToolUseInput> {
  const { tool, tool_use_id } = envelope
  const [session_id, cwd, { agentId, agentType }] = await Promise.all([claude.session.id(), claude.session.cwd(), agentOf(tool_use_id)])
  const tool_input = toolInputOf(envelope)
  return {
    session_id,
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input,
    tool_use_id,
    ...(agentId === undefined ? {} : { agent_id: agentId }),
    ...(agentType === undefined ? {} : { agent_type: agentType }),
    files: await callFiles(name, claude, { tool, input: tool_input }, cwd),
  }
}

async function callFiles(name: string, claude: Claude, use: ToolUse, cwd: string): Promise<CallFiles> {
  try {
    const home = await claude.env.home()
    if (home === undefined) throw new Error('HOME is not set, so ~ in a path has no meaning.')
    const { shell, reads, writes, searchFolder } = callEffects(use, { cwd, home, fs: claude.fs })
    const known = (accesses: FileAccess[]) => accesses.map(({ path }) => path).filter((path) => shell === undefined || !dynamicPattern.test(path))
    return { read: searchFolder === undefined ? known(reads) : [], changed: known(writes) }
  } catch (error) {
    claude.ui.log(`${name}: the ${use.tool} call lists no files: ${messageOf(error)}`, { to: 'debug' })
    return { read: [], changed: [] }
  }
}

function classicResult(event: ModEvent, answer: HookAnswer): ClassicFields {
  const result: ClassicFields = {}
  const unread = (field: string) => new Error(`it answered ${field}, which ${event} does not read. Remove it from the answer.`)
  if (event === 'PreToolUse') {
    if (answer.continue === false || answer.stopReason !== undefined) throw unread('continue or stopReason')
    if (answer.decision === 'block') result['deny'] = answer.reason ?? ''
  } else {
    if (answer.continue === false) result['preventContinuation'] = true
    if (answer.stopReason !== undefined) result['stopReason'] = answer.stopReason
    if (answer.decision === 'block') result['block'] = answer.reason ?? ''
  }
  const specific = answer.hookSpecificOutput ?? {}
  if (specific.hookEventName !== undefined && specific.hookEventName !== event) {
    throw new Error(`it answered hookSpecificOutput.hookEventName "${specific.hookEventName}". Set it to "${event}" or leave it out.`)
  }
  for (const [field, value] of Object.entries(specific)) {
    if (field === 'hookEventName' || value === undefined || (value === false && flags.includes(field))) continue
    if (!readFields[event].includes(field)) throw unread(`hookSpecificOutput.${field}`)
    if (field === 'additionalContext') result['additionalContext'] = [value]
    else if (field === 'permissionDecision') {
      const reason = specific.permissionDecisionReason ?? ''
      result[value as string] = value === 'allow' ? true : reason
    } else if (field !== 'permissionDecisionReason') result[field] = value
  }
  return result
}

const strictness = ['allow', 'ask', 'deny'] as const

function strictnessOf(result: ClassicFields): number {
  return strictness.findLastIndex((decision) => result[decision] !== undefined)
}

function mergeClassic(event: ModEvent, below: ClassicFields, ours: ClassicFields): ClassicFields {
  const merged: ClassicFields = { ...below, ...ours }
  const context = [...((below['additionalContext'] as string[] | undefined) ?? []), ...((ours['additionalContext'] as string[] | undefined) ?? [])]
  if (context.length > 0) merged['additionalContext'] = context
  if (event !== 'PreToolUse') return merged
  const strictest = strictness[Math.max(strictnessOf(below), strictnessOf(ours))]
  for (const decision of strictness) delete merged[decision]
  if (strictest !== undefined) merged[strictest] = ours[strictest] ?? below[strictest]
  return merged
}
