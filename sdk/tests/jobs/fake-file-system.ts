import type { FileSystem } from '../../src/utils/paths.js'

export function fakeFileSystem(files: Record<string, string>, links: Record<string, string> = {}): FileSystem {
  const contents = new Map(Object.entries(files))
  const folders = new Set([...contents.keys()].flatMap(ancestorsOf))
  const realPathOf = (path: string): string => {
    for (const [link, target] of Object.entries(links)) {
      if (path === link || path.startsWith(`${link}/`)) return realPathOf(`${target}${path.slice(link.length)}`)
    }
    return path
  }
  return {
    async read(path) {
      const content = contents.get(realPathOf(path))
      if (content === undefined) throw new Error(`ENOENT: no such file, read '${path}'`)
      return content
    },
    async stat(path) {
      const realPath = realPathOf(path)
      if (contents.has(realPath)) return { kind: 'file', realPath }
      if (folders.has(realPath)) return { kind: 'dir', realPath }
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
    },
    async exists(path) {
      const realPath = realPathOf(path)
      return contents.has(realPath) || folders.has(realPath)
    },
  }
}

function ancestorsOf(path: string): string[] {
  const parts = path.split('/').slice(1, -1)
  return ['/', ...parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)]
}
