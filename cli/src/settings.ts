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

export function configRoot(): string {
  return process.env['CLAUDE_CONFIG_DIR'] || join(home(), '.claude')
}

function statePath(): string {
  return process.env['CLAUDE_CONFIG_DIR'] ? join(configRoot(), '.claude.json') : join(home(), '.claude.json')
}

const keptKeys = ['env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'otelHeadersHelper', 'proxyAuthHelper', 'forceLoginMethod', 'forceLoginOrgUUID', 'forceLoginGatewayUrl', 'gatewayInternalNetworks', 'sandbox']

const keptState = ['oauthAccount', 'customApiKeyResponses']

export type KeptSettings = { readonly settings: Record<string, unknown>; readonly state: Record<string, unknown> }

export async function keptSettings(): Promise<KeptSettings> {
  const own = settingsObject((await readSettings()).text)
  const settings: Record<string, unknown> = {}
  for (const key of keptKeys) {
    const value = own[key]
    if (value !== undefined) settings[key] = typeof value === 'string' ? expand(value) : value
  }
  const env = settings['env']
  if (isObject(env)) settings['env'] = Object.fromEntries(Object.entries(env).filter(([name]) => name !== pluginFolders))
  const permissions = own['permissions']
  if (isObject(permissions) && Array.isArray(permissions['deny'])) settings['permissions'] = { deny: permissions['deny'] }
  const { path, text } = await readConfig(statePath())
  const ownState = configObject(text, path)
  return { settings, state: Object.fromEntries(keptState.flatMap((key) => (ownState[key] === undefined ? [] : [[key, ownState[key]]]))) }
}

export async function keepSettings(kept: KeptSettings): Promise<void> {
  if (Object.keys(kept.settings).length > 0) await writeValues(settingsPath(), '{}\n', kept.settings)
  await writeValues(statePath(), `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n`, kept.state)
}

async function writeValues(link: string, fresh: string, values: Record<string, unknown>): Promise<void> {
  const { path, text } = await readConfig(link)
  if (text.trim() !== '' && Object.keys(values).length === 0) return
  const base = text.trim() === '' ? fresh : text
  const formattingOptions = indentation(base)
  let next = base
  for (const [key, value] of Object.entries(values)) next = applyEdits(next, modify(next, [key], value, { formattingOptions }))
  await writeAtomically(path, next)
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
