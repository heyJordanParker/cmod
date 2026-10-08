import type { FileMatch, Metadata } from '../mod.js'
import { formatOf, MetadataError, readMetadata, sidecarSuffix, writeMetadata, type MetadataFormat } from '../utils/metadata.js'
import { messageOf } from '../utils/text.js'
import { picomatch, resolve } from '../vendor.js'
import type { Claude } from './claude.js'

export type Places = {
  readonly home: string | undefined
  readonly configRoot: string | undefined
  readonly projectRoot: () => string
}

export type ModFiles = {
  find(glob: string | readonly string[]): Promise<readonly FileMatch[]>
  read(path: string): Promise<Metadata>
  update(path: string, change: (metadata: Record<string, string>) => void): Promise<void>
}

type Read = { readonly metadata: Metadata; readonly name?: string; readonly error?: string }

type Located = { readonly realPath: string; readonly format: MetadataFormat; readonly holder: string; readonly signature: string }

const skippedFolders: readonly string[] = ['.git', 'node_modules']

const ownKey = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

export function resolvedPath(path: string, places: Places): string {
  const configured = /^~\/\.claude(?=\/|$)/.exec(path)
  if (configured !== null && places.configRoot !== undefined) return resolve(`${places.configRoot}${path.slice(configured[0].length)}`)
  if (path === '~' || path.startsWith('~/')) {
    if (places.home === undefined) throw new Error(`${path} starts with ~, and HOME is not set. Start Claude Code with HOME set.`)
    return resolve(`${places.home}${path.slice(1)}`)
  }
  return path.startsWith('/') ? resolve(path) : resolve(places.projectRoot(), path)
}

export function createModFiles({ name, claude, places, checkWrite }: { readonly name: string; readonly claude: Claude; readonly places: Places; readonly checkWrite: (path: string) => Promise<void> }): ModFiles {
  const prefix = `${name}.`
  const cache = new Map<string, { readonly signature: string; readonly read: Read }>()
  const logged = new Set<string>()

  const own = (all: Metadata): Metadata => Object.freeze(Object.fromEntries(Object.entries(all).flatMap(([key, value]) => (key.startsWith(prefix) ? [[key.slice(prefix.length), value]] : []))))

  const locate = async (path: string): Promise<Located> => {
    const stat = await claude.fs.stat(path, { resolve: true })
    if (stat.kind !== 'file') throw new Error(`${path} is not a file, so it holds no metadata.`)
    const realPath = stat.realPath ?? path
    const extensionless = !realPath.slice(realPath.lastIndexOf('/') + 1).includes('.')
    const firstLine = extensionless ? (await claude.fs.read(realPath)).split('\n', 1)[0] : undefined
    const format = formatOf(realPath, firstLine)
    const holder = format.kind === 'sidecar' ? `${realPath}${sidecarSuffix}` : realPath
    const sidecar = format.kind === 'sidecar' ? await claude.fs.stat(holder).catch(() => undefined) : undefined
    return { realPath, format, holder, signature: `${stat.mtimeMs}:${stat.size}:${sidecar?.kind === 'file' ? `${sidecar.mtimeMs}:${sidecar.size}` : ''}` }
  }

  const textOf = async (holder: string): Promise<string> => ((await claude.fs.stat(holder).catch(() => undefined))?.kind === 'file' ? claude.fs.read(holder) : '')

  const readEntry = async (path: string): Promise<Read> => {
    const located = await locate(path)
    const cached = cache.get(path)
    if (cached?.signature === located.signature) return cached.read
    let read: Read
    try {
      const { metadata, name: declared } = readMetadata(await textOf(located.holder), located.format)
      read = { metadata, ...(declared === undefined ? {} : { name: declared }) }
    } catch (error) {
      if (!(error instanceof MetadataError)) throw error
      const failure = `${located.holder} ${error.message}`
      read = { metadata: {}, error: failure }
      if (!logged.has(failure)) claude.ui.log(`${name}: ${failure}`)
      logged.add(failure)
    }
    cache.set(path, { signature: located.signature, read })
    return read
  }

  const matchesOf = async (pattern: string): Promise<string[]> => {
    const absolute = resolvedPath(pattern, places)
    const scanned = picomatch.scan(absolute)
    if (!scanned.isGlob) return (await claude.fs.stat(absolute).catch(() => undefined))?.kind === 'file' ? [absolute] : []
    const isMatch = picomatch(absolute, { dot: true })
    const entersSkipped = skippedFolders.filter((folder) => scanned.glob.split('/').includes(folder))
    const maxDepth = scanned.glob.includes('**') ? Number.POSITIVE_INFINITY : scanned.glob.split('/').length
    const found: string[] = []
    const visited = new Set<string>()
    const walk = async (folder: string, depth: number): Promise<void> => {
      const real = (await claude.fs.stat(folder, { resolve: true }).catch(() => undefined))?.realPath ?? folder
      if (visited.has(real)) return
      visited.add(real)
      const entries = await claude.fs.list(folder).catch(() => [])
      await Promise.all(
        entries.map(async (entry) => {
          const path = `${folder}/${entry.name}`
          const kind = entry.isLink === true ? (await claude.fs.stat(path).catch(() => undefined))?.kind : entry.kind
          if (kind === 'file' && isMatch(path)) found.push(path)
          if (kind !== 'dir' || depth + 1 >= maxDepth) return
          if (skippedFolders.includes(entry.name) && !entersSkipped.includes(entry.name)) return
          await walk(path, depth + 1)
        }),
      )
    }
    const base = scanned.base === '' ? '/' : scanned.base
    if ((await claude.fs.stat(base).catch(() => undefined))?.kind === 'dir') await walk(base, 0)
    return found
  }

  return {
    async find(glob) {
      const patterns = typeof glob === 'string' ? [glob] : glob
      const paths = [...new Set((await Promise.all(patterns.map(matchesOf))).flat())].sort()
      const kept = paths.filter((path) => !(path.endsWith(sidecarSuffix) && paths.includes(path.slice(0, -sidecarSuffix.length))))
      return Promise.all(
        kept.map(async (path): Promise<FileMatch> => {
          const read = await readEntry(path)
          return { path, ...(read.name === undefined ? {} : { name: read.name }), metadata: own(read.metadata), ...(read.error === undefined ? {} : { error: read.error }) }
        }),
      )
    },
    async read(path) {
      const read = await readEntry(resolvedPath(path, places))
      if (read.error !== undefined) throw new Error(`${name}: ${read.error}`)
      return own(read.metadata)
    },
    async update(path, change) {
      const given = resolvedPath(path, places)
      await checkWrite(given)
      const located = await locate(given)
      const text = await textOf(located.holder)
      let all: Metadata
      try {
        all = readMetadata(text, located.format).metadata
      } catch (error) {
        throw new Error(`${name}: ${located.holder} ${messageOf(error)}`, { cause: error })
      }
      const edited: Record<string, string> = { ...own(all) }
      change(edited)
      for (const [key, value] of Object.entries(edited)) {
        if (!ownKey.test(key)) throw new Error(`${name}: the metadata key "${key}" is not a name. Use letters, digits, "_", ".", and "-".`)
        if (typeof value !== 'string') throw new Error(`${name}: the metadata key "${key}" holds ${JSON.stringify(value)}. Each value is text, and a list is one space-separated text.`)
        if (value.includes('\n')) throw new Error(`${name}: the metadata key "${key}" holds a line break. Each value is one line of text.`)
      }
      const next: Record<string, string> = {}
      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(prefix)) next[key] = value
        else if (Object.hasOwn(edited, key.slice(prefix.length))) next[key] = edited[key.slice(prefix.length)] as string
      }
      for (const [key, value] of Object.entries(edited)) next[`${prefix}${key}`] = value
      if (JSON.stringify(next) === JSON.stringify(all)) return
      await claude.fs.write(located.holder, writeMetadata(text, located.format, next))
      cache.delete(given)
    },
  }
}
