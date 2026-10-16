import { isObject, isSettingCovered, permissionWords, settingPaths } from '../records.js'
import { relativePath } from '../utils/paths.js'
import type { Claude } from './claude.js'
import { cmodPluginName } from './dependencies.js'
import type { RoutedEvent } from './hooks.js'
import { actPermission, conversationMethods, isAct, toolPermission } from './sessions.js'

export type Grants = {
  readonly name: string
  readonly declared: readonly string[]
  readonly granted: () => ReadonlySet<string>
  readonly refresh: () => Promise<void>
  readonly home: string | undefined
  readonly configRoot: string | undefined
  readonly projectRoot: () => string
  readonly freeFolders: () => readonly string[]
  readonly freeAddresses: () => ReadonlySet<string>
}

export class PermissionRefused extends Error {}

const addressesOfPrograms = new WeakMap<object, Set<string>>()

export function programAddresses(mod: object): Set<string> {
  const known = addressesOfPrograms.get(mod) ?? new Set<string>()
  addressesOfPrograms.set(mod, known)
  return known
}

const projectSettingsFiles: readonly string[] = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']

const conversationCalls: Readonly<Record<string, string>> = {
  [conversationMethods.sessions]: 'sessions.list',
  [conversationMethods.search]: 'sessions.search',
  [conversationMethods.messages]: 'messages',
  [conversationMethods.turns]: 'turns',
  [conversationMethods.contexts]: 'contexts',
  [conversationMethods.tasks]: 'tasks',
  [conversationMethods.goal]: 'goal',
  [conversationMethods.updateGoal]: 'goal.update',
  [conversationMethods.subscribe]: 'on',
  [conversationMethods.watchBefore]: 'before',
  [conversationMethods.act]: 'act',
}

export async function checkGrant(grants: Grants, call: string, item: string | undefined): Promise<void> {
  if (item === undefined) return
  await grants.refresh()
  if (!isCovered(grants.granted(), item, grants.home)) throw new PermissionRefused(refusal(grants, call, item))
}

export async function checkWrite(grants: Grants, call: string, path: string): Promise<void> {
  await checkGrant(grants, call, writeItem(grants, path))
}

export async function checkSettings(grants: Grants, source: 'user' | 'project' | 'local', values: Readonly<Record<string, unknown>>): Promise<void> {
  for (const path of settingPaths(values).map((each) => each.join('.'))) await checkGrant(grants, `settings.${source}.update(${path})`, `config:${path}`)
}

export function checkingGrants(claude: Claude, grants: Grants): Claude {
  const gate = (call: string, item: string | undefined) => checkGrant(grants, call, item)
  return {
    ...claude,
    process: {
      async run(argv, init) {
        await gate(`process.run(${argv.join(' ')})`, `run:${programOf(argv)}`)
        return claude.process.run(argv, init)
      },
      spawn(request) {
        const started = gate(`process.spawn(${request.argv.join(' ')})`, `run:${programOf(request.argv)}`).then(() => claude.process.spawn(request))
        return spawned(started)
      },
    },
    fs: {
      ...claude.fs,
      async read(path) {
        await gate(`fs.read(${path})`, readItem(grants, path))
        return claude.fs.read(path)
      },
      async write(path, text) {
        await gate(`fs.write(${path})`, writeItem(grants, path))
        return claude.fs.write(path, text)
      },
    },
    http: {
      async fetch(url, init) {
        if (!grants.freeAddresses().has(init?.socketPath ?? addressOf(url))) await gate(`http.fetch(${url})`, `network:${init?.socketPath ?? hostOf(url)}`)
        return claude.http.fetch(url, init)
      },
    },
    session: {
      ...claude.session,
      append: async (args: Parameters<Claude['session']['append']>[0]) => {
        await gate('send', 'prompt')
        return claude.session.append(args)
      },
      send: async (args: Parameters<Claude['session']['send']>[0]) => {
        await gate('send', 'prompt')
        return claude.session.send(args)
      },
    },
    prompt: {
      submit: async (args: Parameters<Claude['prompt']['submit']>[0]) => {
        await gate('send', 'prompt')
        return claude.prompt.submit(args)
      },
    },
    command: {
      ...claude.command,
      run: async (args: Parameters<Claude['command']['run']>[0]) => {
        await gate(`commands.run(${args.command})`, 'prompt')
        return claude.command.run(args)
      },
    },
    cmod: {
      async call(args) {
        const named = args.to === cmodPluginName ? conversationCalls[args.method] : undefined
        const given = args.method === conversationMethods.act && isObject(args.input) ? String(args.input['action']) : undefined
        const action = given !== undefined && isAct(given) ? given : undefined
        const isThisSession = isObject(args.input) && args.input['session'] === (await claude.session.id())
        const isDropping = (args.method === conversationMethods.subscribe || args.method === conversationMethods.watchBefore) && isObject(args.input) && Array.isArray(args.input['subscriptions']) && args.input['subscriptions'].length === 0
        if (named !== undefined && action !== undefined) await gate(action, actPermission(action, isObject(args.input) ? args.input['input'] : undefined))
        else if (named !== undefined && !isThisSession && !isDropping) await gate(named, 'conversation')
        return claude.cmod.call(args)
      },
    },
    model: {
      complete: async (...args: Parameters<Claude['model']['complete']>) => {
        await gate('model.complete', 'model')
        return claude.model.complete(...args)
      },
    },
    agent: {
      ...claude.agent,
      async spawn(args) {
        await gate('startTask', 'tasks')
        return claude.agent.spawn(args)
      },
    },
    tool: {
      ...claude.tool,
      call: async (input: Parameters<Claude['tool']['call']>[0]) => {
        await gate(`tool.call(${input.tool})`, toolPermission(input.tool))
        return claude.tool.call(input)
      },
    },
  }
}

type Stream = ReturnType<Claude['process']['spawn']>

function spawned(started: Promise<Stream>): Stream {
  const result = started.then((stream) => stream.result)
  result.catch(() => undefined)
  const stream = {
    next: async () => (await started).next(),
    async return(value: never) {
      const [start] = await Promise.allSettled([started])
      return start.status === 'fulfilled' ? start.value.return(value) : { done: true as const, value }
    },
    [Symbol.asyncIterator]: () => stream,
    result,
  }
  return stream as unknown as Stream
}

export function itemOf(name: string, value?: string): string {
  return value === undefined ? name : `${name}:${value}`
}

export function isCovered(granted: ReadonlySet<string>, item: string, home: string | undefined): boolean {
  if (granted.has(item)) return true
  const split = item.indexOf(':')
  if (split === -1) return false
  const name = item.slice(0, split)
  if (name === 'config') return isSettingCovered(granted, item.slice(split + 1))
  const target = expanded(item.slice(split + 1), home)
  const values = [...granted].filter((each) => each.startsWith(`${name}:`)).map((each) => expanded(each.slice(name.length + 1), home))
  if (name === 'run') return values.includes('*') || values.includes(target)
  if (name === 'files') return values.some((each) => relativePath(each, target) !== undefined)
  return values.includes(target)
}

function readItem(grants: Grants, path: string): string | undefined {
  if (grants.configRoot === undefined) return undefined
  return relativePath(`${grants.configRoot}/projects`, path) === undefined ? undefined : 'conversation'
}

function writeItem(grants: Grants, path: string): string | undefined {
  const root = grants.projectRoot()
  const settingsFiles = [...projectSettingsFiles.map((file) => `${root}/${file}`), ...(grants.configRoot === undefined ? [] : [`${grants.configRoot}/settings.json`])]
  if (settingsFiles.includes(path)) {
    throw new PermissionRefused(`${grants.name} writes ${path} by hand. Change Claude Code's settings with settings.user.update, settings.project.update, or settings.local.update, which keep the person's own edits and take the mod's values out when it is removed.`)
  }
  if (grants.freeFolders().some((folder) => relativePath(folder, path) !== undefined)) return undefined
  return `files:${path}`
}

export function refusal(grants: Pick<Grants, 'name' | 'declared' | 'home'>, call: string, item: string): string {
  const { name } = grants
  if (isCovered(new Set(grants.declared), item, grants.home)) return `${name} calls ${call} without your grant to "${permissionWords(item)}". Turn it on in /mods ${name}.`
  return `${name} calls ${call}, which needs ${declaration(item, grants.home)} in package.json "cmod".`
}

function declaration(item: string, home: string | undefined): string {
  const split = item.indexOf(':')
  if (split === -1) return `"permissions": { "${item}": true }`
  const name = item.slice(0, split)
  const target = item.slice(split + 1)
  const fromHome = home === undefined ? undefined : relativePath(home, target)
  const shown = name !== 'run' && fromHome !== undefined ? `~/${fromHome}` : target
  return `"permissions": { "${name}": ["${shown}"] }`
}

type Fields = Record<string, unknown>

const classicParts: Readonly<Record<string, string>> = {
  additionalContext: 'prompt',
  initialUserMessage: 'prompt',
  updatedToolOutput: 'prompt',
  updatedMCPToolOutput: 'prompt',
  retry: 'approve',
}

const blocksKeepWorking: readonly RoutedEvent[] = ['classic.Stop', 'classic.PostToolUse']

const reservedToolKeys: readonly string[] = ['tool', 'tool_use_id']

export type AnswerCheck = {
  readonly plugin: string
  isGranted(item: string): boolean
  dropped(item: string, part: string): void
}

export function checksAnswers(event: RoutedEvent): boolean {
  return event.startsWith('classic.') || event === 'tool.check' || event === 'tool.call' || event === 'prompt.context' || event === 'prompt.submit'
}

export function passedDown(event: RoutedEvent, original: unknown, passed: unknown, check: AnswerCheck): unknown {
  if (passed === original) return passed
  if (event === 'tool.call') {
    if (sameExcept(original, passed, reservedToolKeys) || check.isGranted('tools')) return passed
    check.dropped('tools', 'a changed tool input')
    return original
  }
  if (event === 'prompt.context' || event === 'prompt.submit') {
    if (same(original, passed) || check.isGranted('prompt')) return passed
    check.dropped('prompt', event === 'prompt.submit' ? 'a rewritten prompt' : 'changed context')
    return original
  }
  return passed
}

export async function checkedAnswer(event: RoutedEvent, e: unknown, answer: unknown, below: () => Promise<unknown>, check: AnswerCheck): Promise<unknown> {
  if (!isFields(answer)) return answer
  if (event === 'tool.check') return decided(answer['decision'], answer, below, check)
  if (event === 'classic.PermissionRequest') {
    const decision = isFields(answer['decision']) ? answer['decision']['behavior'] : undefined
    return decided(decision, answer, below, check)
  }
  if (event.startsWith('classic.')) return classicAnswer(event, answer, below, check)
  if (event === 'tool.call') {
    if (answer['deny'] !== undefined || check.isGranted('prompt')) return answer
    const tool = isFields(e) ? e['tool'] : undefined
    if (typeof tool === 'string' && tool.startsWith(`mcp__${check.plugin}__`)) {
      if (answer['context'] === undefined) return answer
      check.dropped('prompt', 'context after a tool call')
      const { context: _context, ...rest } = answer
      return rest
    }
    const theirs = await below()
    if (same(answer, theirs)) return answer
    check.dropped('prompt', same(contextOf(answer), contextOf(theirs)) ? 'a changed tool result' : 'context after a tool call')
    return theirs
  }
  if (event === 'prompt.submit' && answer['drop'] !== undefined) return answer
  if (event === 'prompt.context' || event === 'prompt.submit') {
    if (check.isGranted('prompt')) return answer
    const theirs = await below()
    if (same(answer, theirs)) return answer
    check.dropped('prompt', event === 'prompt.submit' ? 'a rewritten prompt' : 'changed context')
    return theirs
  }
  return answer
}

async function decided(decision: unknown, answer: Fields, below: () => Promise<unknown>, check: AnswerCheck): Promise<unknown> {
  if ((decision !== 'allow' && decision !== 'ask') || check.isGranted('approve')) return answer
  const theirs = await below()
  if (same(answer, theirs)) return answer
  check.dropped('approve', `${decision} on a tool call`)
  return theirs
}

async function classicAnswer(event: RoutedEvent, answer: Fields, below: () => Promise<unknown>, check: AnswerCheck): Promise<unknown> {
  const blocks = blocksKeepWorking.includes(event) ? ([['block', 'prompt']] as const) : []
  const parts = [...Object.entries(classicParts), ...blocks].filter(([part, item]) => answer[part] !== undefined && !check.isGranted(item))
  if (parts.length === 0) return answer
  const theirs = await below()
  const kept: Fields = { ...answer }
  const theirFields = isFields(theirs) ? theirs : {}
  for (const [part, item] of parts) {
    if (same(answer[part], theirFields[part])) continue
    check.dropped(item, part)
    if (theirFields[part] === undefined) delete kept[part]
    else kept[part] = theirFields[part]
  }
  return kept
}

function contextOf(answer: unknown): unknown {
  return isFields(answer) ? answer['context'] : undefined
}

function same(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}

function sameExcept(left: unknown, right: unknown, keys: readonly string[]): boolean {
  if (!isFields(left) || !isFields(right)) return same(left, right)
  const without = (fields: Fields) => Object.fromEntries(Object.entries(fields).filter(([key]) => !keys.includes(key)))
  return same(without(left), without(right))
}

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function programOf(argv: readonly string[]): string {
  const command = argv[0] ?? ''
  return command.slice(command.lastIndexOf('/') + 1)
}

function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).hostname : url
}

function addressOf(url: string): string {
  return URL.canParse(url) ? new URL(url).host : url
}

function expanded(path: string, home: string | undefined): string {
  return path.startsWith('~/') && home !== undefined ? `${home}${path.slice(1)}` : path
}
