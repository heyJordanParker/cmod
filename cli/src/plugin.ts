import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isObject, readSteps, type Steps } from 'cmod-sdk/src/records.js'
import { messageOf } from 'cmod-sdk/src/utils/text.js'
import { readJson } from './files.js'
import { bunArgv, run } from './process.js'

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
  let steps: Steps
  try {
    steps = readSteps(packageJson) ?? {}
  } catch (error) {
    throw new Error(`${root}: ${messageOf(error)}`)
  }

  return {
    root,
    name: manifest['name'],
    version: manifest['version'],
    description: typeof manifest['description'] === 'string' ? manifest['description'] : undefined,
    repository: typeof manifest['repository'] === 'string' ? manifest['repository'] : undefined,
    steps,
    packageJson: packageJson as Record<string, unknown> | undefined,
  }
}

export function sourceOf(text: string): { kind: 'path' | 'github'; text: string } {
  if (/^[\w.-]+\/[\w.-]+$/.test(text) && !existsSync(text)) return { kind: 'github', text }
  if (!existsSync(text)) throw new Error(`${text} is neither a GitHub owner/repo nor a folder.`)
  return { kind: 'path', text: realpathSync(text) }
}

export async function isModFolder(root: string): Promise<boolean> {
  const packageJson = await readJson(`${root}/package.json`)
  if (!isObject(packageJson)) return false
  const dependencies = packageJson['dependencies']
  return 'cmod' in packageJson || (isObject(dependencies) && 'cmod-sdk' in dependencies)
}

export async function preparePackages(plugin: Plugin): Promise<boolean> {
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
