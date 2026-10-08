import type { Claude } from '../runtime/claude.js'
import { resolve } from '../vendor.js'

export function fakeFiles(files: Readonly<Record<string, string>>, links: Readonly<Record<string, string>> = {}): Claude['fs'] {
  const contents = new Map(Object.entries(files).map(([path, text]) => [resolve('/', path), text]))
  const realPathOf = (path: string): string => {
    const absolute = resolve('/', path)
    for (const [link, target] of Object.entries(links)) {
      if (absolute === link || absolute.startsWith(`${link}/`)) return realPathOf(`${target}${absolute.slice(link.length)}`)
    }
    return absolute
  }
  const below = (folder: string) => {
    const prefix = folder === '/' ? '/' : `${folder}/`
    return [...contents.keys(), ...Object.keys(links)].filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length))
  }
  const kindOf = (path: string) => {
    if (contents.has(path)) return 'file'
    return below(path).length > 0 ? 'dir' : undefined
  }
  const sizeOf = (path: string) => new TextEncoder().encode(contents.get(path) ?? '').length
  const modified = new Map<string, number>()
  let writes = 0
  const mtimeOf = (path: string) => modified.get(path) ?? 0

  return {
    read: async (path) => {
      const text = contents.get(realPathOf(path))
      if (text === undefined) throw new Error(`ENOENT: no such file, read '${path}'. Give it contents with testMod(mod, { files: { '${path}': '…' } }).`)
      return text
    },
    write: async (path, text) => {
      const realPath = realPathOf(path)
      contents.set(realPath, text)
      writes += 1
      modified.set(realPath, writes)
    },
    list: async (path) => {
      if (path === undefined) throw new Error('fs.list() lists the working folder, which the fake files do not know. Name the folder, such as fs.list(mod.cwd).')
      const folder = realPathOf(path)
      if (kindOf(folder) !== 'dir') throw new Error(`ENOENT: no such directory, list '${path}'`)
      const names = new Set(below(folder).map((file) => file.split('/')[0] as string))
      return [...names].map((name) => {
        const entry = resolve(folder, name)
        if (Object.hasOwn(links, entry)) return { name, kind: 'other', size: 0, mtimeMs: 0, isLink: true }
        return { name, kind: contents.has(entry) ? 'file' : 'dir', size: sizeOf(entry), mtimeMs: mtimeOf(entry), isLink: false }
      })
    },
    exists: async (path) => kindOf(realPathOf(path)) !== undefined,
    stat: async (path, options) => {
      const realPath = realPathOf(path)
      const kind = kindOf(realPath)
      const isLink = Object.hasOwn(links, resolve('/', path))
      if (kind === undefined && isLink) return { kind: 'other', size: 0, mtimeMs: 0, isLink }
      if (kind === undefined) throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
      return { kind, size: sizeOf(realPath), mtimeMs: mtimeOf(realPath), isLink, ...(options?.resolve === true ? { realPath } : {}) }
    },
  }
}
