import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isObject } from '@cmodjs/core/src/records.js'
import { applyEdits, modify, parse } from 'jsonc-parser'
import { home, readText, tilde, writeAtomically } from './files.js'

const pluginFolders = 'CLAUDE_CODE_PLUGIN_DIRS'

const chat = 'Chat'

type KeyBlock = { readonly index: number; readonly bindings: Readonly<Record<string, unknown>> }

export function settingsPath(): string {
  return join(configRoot(), 'settings.json')
}

export function keybindingsPath(): string {
  return join(configRoot(), 'keybindings.json')
}

function configRoot(): string {
  return process.env['CLAUDE_CONFIG_DIR'] || join(home(), '.claude')
}

export async function bindKeys(keys: Readonly<Record<string, string>>): Promise<{ bound: Record<string, string>; kept: string[] }> {
  const bound: Record<string, string> = {}
  const kept: string[] = []
  if (Object.keys(keys).length === 0) return { bound, kept }
  const { path, text } = await readConfig(keybindingsPath())
  const blocks = chatBlocks(text, path)
  const added: Record<string, string> = {}
  for (const [key, command] of Object.entries(keys)) {
    const action = `command:${command}`
    const current = blocks.map((block) => block.bindings[key]).find((value) => value !== undefined)
    if (current !== undefined && current !== action) {
      kept.push(`${tilde(path)} binds ${key} to ${JSON.stringify(current)}, so it stays. To use /${command} on ${key}, put "${key}": "${action}" in its Chat bindings.`)
      continue
    }
    bound[key] = command
    if (current === undefined) added[key] = action
  }
  if (Object.keys(added).length === 0) return { bound, kept }
  const base = text.trim() === '' ? '{}\n' : text
  const formattingOptions = indentation(base)
  const [first] = blocks
  let next = base
  if (first !== undefined) {
    for (const [key, action] of Object.entries(added)) next = applyEdits(next, modify(next, ['bindings', first.index, 'bindings', key], action, { formattingOptions }))
  } else {
    const existing = configObject(base, path)['bindings']
    const block = { context: chat, bindings: added }
    next = applyEdits(next, Array.isArray(existing) ? modify(next, ['bindings', existing.length], block, { formattingOptions, isArrayInsertion: true }) : modify(next, ['bindings'], [block], { formattingOptions }))
  }
  await writeAtomically(path, next)
  return { bound, kept }
}

export async function unbindKeys(keys: Readonly<Record<string, string>>): Promise<void> {
  if (Object.keys(keys).length === 0) return
  const { path, text } = await readConfig(keybindingsPath())
  if (text.trim() === '') return
  const formattingOptions = indentation(text)
  let next = text
  for (const block of chatBlocks(text, path).reverse()) {
    const ours = Object.entries(keys).filter(([key, command]) => block.bindings[key] === `command:${command}`).map(([key]) => key)
    if (ours.length === 0) continue
    if (ours.length === Object.keys(block.bindings).length) {
      next = applyEdits(next, modify(next, ['bindings', block.index], undefined, { formattingOptions }))
      continue
    }
    for (const key of ours) next = applyEdits(next, modify(next, ['bindings', block.index, 'bindings', key], undefined, { formattingOptions }))
  }
  if (next !== text) await writeAtomically(path, next)
}

function chatBlocks(text: string, path: string): KeyBlock[] {
  if (text.trim() === '') return []
  const blocks = configObject(text, path)['bindings']
  if (blocks === undefined) return []
  if (!Array.isArray(blocks)) throw new Error(`${path} has "bindings" that are not a list. Fix it, then run the command again.`)
  return blocks.flatMap((block: unknown, index) => (isObject(block) && block['context'] === chat && isObject(block['bindings']) ? [{ index, bindings: block['bindings'] }] : []))
}

export async function linkedFolders(): Promise<string[]> {
  const { text } = await readSettings()
  return entriesOf(text).map(expand)
}

export async function addPluginFolder(folder: string): Promise<boolean> {
  const { path, text } = await readSettings()
  const entries = entriesOf(text)
  if (entries.some((entry) => sameFolder(expand(entry), folder))) return false
  await writeEntries(path, text, [...entries, tilde(folder)])
  return true
}

export async function removePluginFolder(folder: string): Promise<boolean> {
  const { path, text } = await readSettings()
  const entries = entriesOf(text)
  const kept = entries.filter((entry) => !sameFolder(expand(entry), folder))
  if (kept.length === entries.length) return false
  await writeEntries(path, text, kept)
  return true
}

async function readSettings(): Promise<{ path: string; text: string }> {
  return readConfig(settingsPath())
}

async function readConfig(link: string): Promise<{ path: string; text: string }> {
  const path = existsSync(link) ? realpathSync(link) : link
  return { path, text: (await readText(path)) ?? '' }
}

function entriesOf(text: string): string[] {
  const env = settingsObject(text)['env']
  const value = isObject(env) ? env[pluginFolders] : undefined
  return typeof value === 'string' ? value.split(':').filter((entry) => entry !== '') : []
}

function settingsObject(text: string): Record<string, unknown> {
  return configObject(text, settingsPath())
}

function configObject(text: string, path: string): Record<string, unknown> {
  const value: unknown = text.trim() === '' ? {} : parse(text)
  if (!isObject(value)) throw new Error(`${path} is not a JSON object. Fix it, then run the command again.`)
  return value
}

async function writeEntries(path: string, text: string, entries: string[]): Promise<void> {
  const base = text.trim() === '' ? '{}\n' : text
  const formattingOptions = indentation(base)
  let next = applyEdits(base, modify(base, ['env', pluginFolders], entries.length > 0 ? entries.join(':') : undefined, { formattingOptions }))
  const env = settingsObject(next)['env']
  if (isObject(env) && Object.keys(env).length === 0) next = applyEdits(next, modify(next, ['env'], undefined, { formattingOptions }))
  await writeAtomically(path, next)
}

function indentation(text: string): { insertSpaces: boolean; tabSize: number; eol: string } {
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  '
  return { insertSpaces: !indent.startsWith('\t'), tabSize: indent.startsWith('\t') ? 1 : indent.length, eol: text.includes('\r\n') ? '\r\n' : '\n' }
}

function expand(entry: string): string {
  return entry === '~' || entry.startsWith('~/') ? join(home(), entry.slice(1)) : entry
}

function sameFolder(left: string, right: string): boolean {
  const real = (folder: string) => (existsSync(folder) ? realpathSync(folder) : resolve(folder))
  return real(left) === real(right)
}
