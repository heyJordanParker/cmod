import type { ClassicHookEvent, ClassicHookInputs } from 'claude-code'
import { configFolders } from '../records.js'
import type { Claude } from './claude.js'
import type { RoutedHook } from './router.js'
import type { Failure } from './toaster.js'
import { callEffects, type CallBase, type FileAccess } from '../utils/call-effects.js'
import { dynamicPattern } from '../utils/parse-shell.js'
import { isMissing } from '../utils/paths.js'
import { messageOf } from '../utils/text.js'

export type Hook = Exclude<ClassicHookEvent, 'PreToolUse'>

export type HookFields = Readonly<Record<string, unknown>>

export type HookListener<H extends Hook> = (input: ClassicHookInputs[H]) => HookFields | undefined | Promise<HookFields | undefined>

export type RoutedEvent =
  | `classic.${Hook}`
  | 'tool.check'
  | 'tool.call'
  | 'prompt.submit'
  | 'prompt.context'
  | 'prompt.attachment'
  | 'command.run'
  | 'session.measure'
  | 'skill.prompt'
  | 'ui.render'
  | 'ui.press'
  | 'ui.scroll'
  | 'ui.close'
  | 'cmod.call'
  | 'session.append'
  | 'session.compact'
  | 'session.receive'
  | 'agent.spawn'
  | 'turn.start'

export const permissionEvents: readonly RoutedEvent[] = ['tool.check', 'classic.PermissionRequest']

type CallFiles = { readonly read: string[]; readonly changed: string[] }

export function classicHook<H extends Hook>(event: H, hook: HookListener<H>, report: (failure: Failure) => void): RoutedHook<RoutedEvent> {
  const routed = async (e: unknown, next: (e: unknown) => Promise<unknown>) => {
    const ours = await Promise.resolve()
      .then(() => hook(e as ClassicHookInputs[H]))
      .catch((error: unknown) => {
        report({ id: `hook:${event}`, message: `The ${event} listener failed`, error })
        return undefined
      })
    if (ours === undefined) return next(e)
    return mergeClassic((await next(e)) as HookFields, ours)
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

export type HomeFolders = { readonly home: string | undefined; readonly configRoot: string | undefined }

export async function callFiles(name: string, claude: Claude, folders: Promise<HomeFolders>, use: CallBase, cwd: string): Promise<CallFiles> {
  try {
    const { home, configRoot } = await folders
    if (home === undefined) throw new Error('HOME is not set, so ~ in a path has no meaning.')
    const { shell, reads, writes } = callEffects(use, { cwd, home, ...(configRoot === undefined ? {} : { configRoot }), fs: claude.fs })
    const known = (accesses: FileAccess[]) => accesses.map(({ path }) => path).filter((path) => shell === undefined || !dynamicPattern.test(path))
    const unchecked = (path: string) => (error: unknown) => {
      if (!isMissing(error)) claude.ui.log(`${name}: the ${use.tool} call reads ${path}, which could not be checked: ${messageOf(error)}`, { to: 'debug' })
      return undefined
    }
    const read = await Promise.all(known(reads).map(async (path) => ((await claude.fs.stat(path).catch(unchecked(path)))?.kind === 'file' ? [path] : [])))
    return { read: read.flat(), changed: known(writes) }
  } catch (error) {
    claude.ui.log(`${name}: the ${use.tool} call lists no files: ${messageOf(error)}`, { to: 'debug' })
    return { read: [], changed: [] }
  }
}

function mergeClassic(below: HookFields, ours: HookFields): HookFields {
  const merged: Record<string, unknown> = { ...below, ...ours }
  const context = [...((below['additionalContext'] as string[] | undefined) ?? []), ...((ours['additionalContext'] as string[] | undefined) ?? [])]
  if (context.length > 0) merged['additionalContext'] = context
  return merged
}
