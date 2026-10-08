import { permissionWords } from '../records.js'
import { relativePath } from '../utils/paths.js'
import type { Claude } from './claude.js'
import type { RoutedEvent } from './hooks.js'

export type Grants = {
  readonly name: string
  readonly declared: readonly string[]
  readonly granted: () => ReadonlySet<string>
  readonly refresh: () => Promise<void>
  readonly home: string | undefined
  readonly configRoot: string | undefined
  readonly projectRoot: () => string
  readonly freeFolders: () => readonly string[]
}

export class PermissionRefused extends Error {}

const configFiles: readonly string[] = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']

const startsTurns: readonly string[] = ['CronCreate']

const ownSchedule: readonly string[] = ['CronDelete', 'CronList']

async function checkGrant(grants: Grants, call: string, item: string | undefined): Promise<void> {
  if (item === undefined) return
  await grants.refresh()
  if (!isCovered(grants.granted(), item, grants.home)) throw new PermissionRefused(refusal(grants, call, item))
}

export function checkWrite(grants: Grants, call: string, path: string): Promise<void> {
  return checkGrant(grants, call, writeItem(grants, path))
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
        await gate(`http.fetch(${url})`, `network:${init?.socketPath ?? hostOf(url)}`)
        return claude.http.fetch(url, init)
      },
    },
    session: {
      ...claude.session,
      messages: (async (...args: Parameters<Claude['session']['messages']>) => {
        await gate('session.messages', 'conversation')
        return claude.session.messages(...args)
      }) as Claude['session']['messages'],
      append: (async (args: Parameters<Claude['session']['append']>[0]) => {
        await gate('session.append', 'prompt')
        return claude.session.append(args)
      }) as Claude['session']['append'],
    },
    prompt: {
      submit: (async (args: Parameters<Claude['prompt']['submit']>[0]) => {
        await gate('session.submit', 'prompt')
        return claude.prompt.submit(args)
      }) as Claude['prompt']['submit'],
    },
    model: {
      complete: (async (...args: Parameters<Claude['model']['complete']>) => {
        await gate('model.complete', 'model')
        return claude.model.complete(...args)
      }) as Claude['model']['complete'],
    },
    agent: {
      ...claude.agent,
      async spawn(args) {
        await gate('agent.spawn', 'agents')
        return claude.agent.spawn(args)
      },
    },
    tool: {
      ...claude.tool,
      call: (async (input: Parameters<Claude['tool']['call']>[0]) => {
        const item = startsTurns.includes(input.tool) ? 'prompt' : ownSchedule.includes(input.tool) ? undefined : 'tools'
        await gate(`tool.call(${input.tool})`, item)
        return claude.tool.call(input)
      }) as Claude['tool']['call'],
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
      const running = await started.catch(() => undefined)
      return (await running?.return?.(value)) ?? { done: true as const, value }
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
  if (configFiles.some((file) => `${root}/${file}` === path)) return 'config'
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
  suppressOriginalPrompt: 'prompt',
  updatedToolOutput: 'prompt',
  updatedMCPToolOutput: 'prompt',
  updatedInput: 'tools',
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
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function expanded(path: string, home: string | undefined): string {
  return path.startsWith('~/') && home !== undefined ? `${home}${path.slice(1)}` : path
}
