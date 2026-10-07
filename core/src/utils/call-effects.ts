import { parseShell, type ShellCommand } from './parse-shell.js'
import { expandHome, type FileSystem } from './paths.js'
import { resolve } from '../vendor.js'

export type CallBase = { tool: string; input: Readonly<Record<string, unknown>>; agentId?: string; agentType?: string }
export type CommandCall = CallBase & { commands: [string, ...string[]][]; isFullyParsed: boolean }
export type FileCall = CallBase & { path: string; content?: string; previousContent?: string }
export type FetchCall = CallBase & { url: string }
export type ToolCall = CommandCall | FileCall | FetchCall | CallBase

export type Contents = { content?: string; previousContent?: string }
export type FileAccess = { path: string; contents: (() => Promise<Contents>) | undefined }
export type CallEffects = {
  shell: { line: string; commands: ShellCommand[]; isFullyParsed: boolean } | undefined
  reads: FileAccess[]
  writes: FileAccess[]
  urls: string[]
  subagent: string | undefined
}

export function callEffects(use: CallBase, workspace: { cwd: string; home: string; fs: FileSystem }): CallEffects {
  const { fs } = workspace
  const absolute = (path: string, folder = workspace.cwd) => resolve(folder, expandHome(path, workspace.home))
  const access = (path: string): FileAccess => ({ path: absolute(path), contents: undefined })
  const effects: CallEffects = { shell: undefined, reads: [], writes: [], urls: [], subagent: undefined }
  if (use.tool === 'Bash') {
    const line = textField(use, 'command')
    const parsed = parseShell(line)
    const commands = parsed.commands.map(({ argv, folder }) => ({ argv, folder: absolute(folder) }))
    effects.shell = { line, commands, isFullyParsed: parsed.isFullyParsed }
    effects.reads = parsed.reads.map(access)
    effects.writes = parsed.writes.map(access)
    effects.urls = parsed.fetches
  } else if (use.tool === 'PowerShell') {
    effects.shell = { line: textField(use, 'command'), commands: [], isFullyParsed: false }
  } else if (use.tool === 'Edit') {
    const path = absolute(textField(use, 'file_path'))
    effects.writes = [{ path, contents: once(() => editedContents(use, path, fs)) }]
  } else if (use.tool === 'Write') {
    const path = absolute(textField(use, 'file_path'))
    const content = textField(use, 'content')
    effects.writes = [{ path, contents: once(async () => contentsOf(content, await previousContentOf(path, fs))) }]
  } else if (use.tool === 'NotebookEdit') {
    const path = absolute(textField(use, 'notebook_path'))
    effects.writes = [{ path, contents: once(async () => contentsOf(undefined, await previousContentOf(path, fs))) }]
  } else if (use.tool === 'Read') {
    effects.reads = [access(textField(use, 'file_path'))]
  } else if (use.tool === 'Grep') {
    effects.reads = [access(optionalTextField(use, 'path') ?? '')]
  } else if (use.tool === 'Glob') {
    const folder = absolute(optionalTextField(use, 'path') ?? '')
    effects.reads = [{ path: absolute(textField(use, 'pattern'), folder), contents: undefined }]
  } else if (use.tool === 'WebFetch') {
    effects.urls = [textField(use, 'url')]
  } else if (use.tool === 'Agent') {
    effects.subagent = optionalTextField(use, 'subagent_type') ?? 'general-purpose'
  }
  return effects
}

export function inputOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function callBaseOf({ tool, input, agentId, agentType }: CallBase): CallBase {
  return { tool, input, ...(agentId === undefined ? {} : { agentId }), ...(agentType === undefined ? {} : { agentType }) }
}

async function editedContents(use: CallBase, path: string, fs: FileSystem): Promise<Contents> {
  const previousContent = await previousContentOf(path, fs)
  const oldString = textField(use, 'old_string')
  const newString = textField(use, 'new_string')
  if (oldString === '') return contentsOf(previousContent === undefined || previousContent === '' ? newString : undefined, previousContent)
  if (previousContent === undefined || !previousContent.includes(oldString)) return contentsOf(undefined, previousContent)
  const content = fieldOf(use, 'replace_all') === true
    ? previousContent.split(oldString).join(newString)
    : previousContent.replace(oldString, () => newString)
  return contentsOf(content, previousContent)
}

async function previousContentOf(path: string, fs: FileSystem): Promise<string | undefined> {
  const stat = await fs.stat(path).catch(() => undefined)
  return stat?.kind === 'file' ? fs.read(path) : undefined
}

function contentsOf(content: string | undefined, previousContent: string | undefined): Contents {
  return { ...(content === undefined ? {} : { content }), ...(previousContent === undefined ? {} : { previousContent }) }
}

function once<Value>(load: () => Promise<Value>): () => Promise<Value> {
  let loaded: Promise<Value> | undefined
  return () => (loaded ??= load())
}

function fieldOf(use: CallBase, name: string): unknown {
  return use.input[name]
}

function textField(use: CallBase, name: string): string {
  const value = fieldOf(use, name)
  if (typeof value !== 'string') throw new Error(`The ${use.tool} call has no text field ${name}.`)
  return value
}

function optionalTextField(use: CallBase, name: string): string | undefined {
  return fieldOf(use, name) === undefined ? undefined : textField(use, name)
}
