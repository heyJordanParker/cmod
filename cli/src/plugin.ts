import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isAtLeast, isObject, readRecord, readSteps, storeFolder, type Steps } from '@cmodjs/core/src/records.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { applyEdits, modify, parse } from 'jsonc-parser'
import { readJson, readText, writeAtomically } from './files.js'
import { bunArgv, capture, run } from './process.js'
import { indentation } from './settings.js'

export type Plugin = {
  root: string
  name: string
  version: string
  description: string | undefined
  repository: string | undefined
  steps: Steps
  packageJson: Record<string, unknown> | undefined
}

export async function readPlugin(path: string): Promise<Plugin> {
  if (!existsSync(path)) throw new Error(`${resolve(path)} does not exist.`)
  const root = realpathSync(path)
  const manifestPath = `${root}/.claude-plugin/plugin.json`
  const manifest = await readJson(manifestPath)
  if (manifest === undefined) throw new Error(`${root} is not a plugin: ${manifestPath} is missing.`)
  if (!isObject(manifest) || typeof manifest['name'] !== 'string') throw new Error(`${manifestPath} has no "name".`)
  if (typeof manifest['version'] !== 'string') throw new Error(`${manifestPath} has no "version". Add one, such as "version": "0.1.0".`)

  const packageJson = await readJson(`${root}/package.json`)
  return {
    root,
    name: manifest['name'],
    version: manifest['version'],
    description: typeof manifest['description'] === 'string' ? manifest['description'] : undefined,
    repository: typeof manifest['repository'] === 'string' ? manifest['repository'] : undefined,
    steps: stepsIn(root, packageJson),
    packageJson: packageJson as Record<string, unknown> | undefined,
  }
}

function stepsIn(root: string, packageJson: unknown): Steps {
  try {
    return readSteps(packageJson) ?? {}
  } catch (error) {
    throw new Error(`${root}: ${messageOf(error)}`)
  }
}

export function sourceOf(text: string): { type: 'path' | 'github'; text: string } {
  if (/^[\w.-]+\/[\w.-]+$/.test(text) && !existsSync(text)) return { type: 'github', text }
  if (!existsSync(text)) throw new Error(`${text} is neither a GitHub owner/repo nor a folder.`)
  return { type: 'path', text: realpathSync(text) }
}

export async function usesCmod(root: string, name: string): Promise<boolean> {
  if (name === 'cmod') return false
  const steps = stepsIn(root, await readJson(`${root}/package.json`))
  return Object.keys(steps).length > 0 || (await readRecord(readText, storeFolder(process.env), name)) !== undefined
}

export type Declared = { readonly type: 'declared'; readonly userConfig: Record<string, unknown>; readonly hotkeys: Record<string, unknown> } | { readonly type: 'no-hooks' } | { readonly type: 'no-core' } | { readonly type: 'old-core' }

const declaredScript = `
const root = process.env.CMOD_ROOT
globalThis.h ??= () => ({})
globalThis.Fragment ??= () => ({})
const hooks = await Bun.file(root + '/hooks/hooks.json').json().catch(() => undefined)
const module = Array.isArray(hooks?.modules) ? hooks.modules[0] : undefined
if (typeof module !== 'string') {
  console.log(JSON.stringify({ type: 'no-hooks' }))
} else {
  const core = await import(root + '/node_modules/@cmodjs/core/register.js')
  if (typeof core.registeredMod !== 'function') {
    console.log(JSON.stringify({ type: 'old-core' }))
  } else {
    const { userConfigOf } = await import(root + '/node_modules/@cmodjs/core/options.js')
    const { register } = await import(root + '/hooks/' + module)
    register(() => ({ catch: () => undefined }), {})
    const mod = core.registeredMod()
    console.log(JSON.stringify({ type: 'declared', userConfig: mod?.options === undefined ? {} : userConfigOf(mod.options), hotkeys: mod?.hotkeys ?? {} }))
  }
}
`

export async function readDeclared(root: string): Promise<Declared> {
  if (!existsSync(join(root, 'node_modules/@cmodjs/core/register.js'))) return { type: 'no-core' }
  const bun = bunArgv('-e', declaredScript)
  const { exitCode, stdout, stderr } = await capture(bun.argv, { cwd: root, env: { ...bun.env, CMOD_ROOT: root } })
  if (exitCode !== 0) {
    const reason = stderr.split('\n').find((line) => /^(error|TypeError|SyntaxError|ReferenceError)\b/.test(line.trim())) ?? `bun exited ${exitCode}`
    throw new Error(`Loading hooks/ to read the options and hotkeys defineMod declares failed: ${reason.trim()}`)
  }
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as Declared
}

export async function writeHotkeys(root: string, hotkeys: Record<string, unknown>): Promise<boolean> {
  const path = `${root}/package.json`
  const text = (await readText(path)) ?? '{}\n'
  const current = parse(text) as Record<string, unknown> | undefined
  const steps = isObject(current?.['cmod']) ? current['cmod'] : {}
  if (JSON.stringify(steps['hotkeys'] ?? {}) === JSON.stringify(hotkeys)) return false
  const next = applyEdits(text, modify(text, ['cmod', 'hotkeys'], Object.keys(hotkeys).length === 0 ? undefined : hotkeys, { formattingOptions: indentation(text) }))
  await writeAtomically(path, next)
  return true
}

export async function writeUserConfig(root: string, userConfig: Record<string, unknown>): Promise<boolean> {
  const path = `${root}/.claude-plugin/plugin.json`
  const text = (await readText(path)) ?? '{}\n'
  const current = parse(text) as Record<string, unknown> | undefined
  if (JSON.stringify(current?.['userConfig'] ?? {}) === JSON.stringify(userConfig)) return false
  const next = applyEdits(text, modify(text, ['userConfig'], Object.keys(userConfig).length === 0 ? undefined : userConfig, { formattingOptions: indentation(text) }))
  await writeAtomically(path, next)
  return true
}

export async function cmodFloor({ name, root }: Pick<Plugin, 'name' | 'root'>): Promise<string | undefined> {
  if (name === 'cmod') return undefined
  const core = await readJson(`${root}/node_modules/@cmodjs/core/package.json`)
  return isObject(core) && typeof core['version'] === 'string' && isAtLeast(core['version'], '4.0.0') ? `>=${core['version']}` : undefined
}

export function cmodRangeOf(manifest: unknown): string | undefined {
  const dependencies = isObject(manifest) && Array.isArray(manifest['dependencies']) ? manifest['dependencies'] : []
  const entry = dependencies.find((each: unknown) => each === 'cmod' || (isObject(each) && each['name'] === 'cmod'))
  return isObject(entry) && typeof entry['version'] === 'string' ? entry['version'] : undefined
}

export async function writeCmodFloor(root: string, floor: string): Promise<boolean> {
  const path = `${root}/.claude-plugin/plugin.json`
  const text = (await readText(path)) ?? '{}\n'
  const current = parse(text) as Record<string, unknown> | undefined
  if (cmodRangeOf(current) === floor) return false
  const dependencies = Array.isArray(current?.['dependencies']) ? (current['dependencies'] as unknown[]) : []
  const index = dependencies.findIndex((each) => each === 'cmod' || (isObject(each) && each['name'] === 'cmod'))
  const edit = isObject(dependencies[index]) ? modify(text, ['dependencies', index, 'version'], floor, { formattingOptions: indentation(text) }) : modify(text, ['dependencies', index === -1 ? dependencies.length : index], { name: 'cmod', version: floor }, { formattingOptions: indentation(text), isArrayInsertion: index === -1 })
  const next = applyEdits(text, edit)
  await writeAtomically(path, next)
  return true
}

export async function installPackages(plugin: Plugin): Promise<boolean> {
  if (plugin.packageJson === undefined) return false
  const dependencies = plugin.packageJson['dependencies']
  const hasTarball = Object.values(isObject(dependencies) ? dependencies : {}).some((spec) => typeof spec === 'string' && spec.startsWith('file:') && /\.(tgz|tar\.gz)$/.test(spec))
  const cache = hasTarball ? await mkdtemp(join(tmpdir(), 'cmod-bun-cache-')) : undefined
  try {
    const bun = bunArgv('install', ...(cache === undefined ? [] : ['--cache-dir', cache]))
    await run(bun.argv, { cwd: plugin.root, env: bun.env })
  } finally {
    if (cache !== undefined) await rm(cache, { recursive: true, force: true })
  }
  return true
}
