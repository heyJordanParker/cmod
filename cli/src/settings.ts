import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isObject } from '@cmodjs/core/src/records.js'
import { applyEdits, modify, parse } from 'jsonc-parser'
import { home, readText, tilde, writeAtomically } from './files.js'

const pluginFolders = 'CLAUDE_CODE_PLUGIN_DIRS'

export function settingsPath(): string {
  const configRoot = process.env['CLAUDE_CONFIG_DIR'] || join(home(), '.claude')
  return join(configRoot, 'settings.json')
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
  const link = settingsPath()
  const path = existsSync(link) ? realpathSync(link) : link
  return { path, text: (await readText(path)) ?? '' }
}

function entriesOf(text: string): string[] {
  const env = settingsObject(text)['env']
  const value = isObject(env) ? env[pluginFolders] : undefined
  return typeof value === 'string' ? value.split(':').filter((entry) => entry !== '') : []
}

function settingsObject(text: string): Record<string, unknown> {
  const value: unknown = text.trim() === '' ? {} : parse(text)
  if (!isObject(value)) throw new Error(`${settingsPath()} is not a JSON object. Fix it, then run the command again.`)
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
