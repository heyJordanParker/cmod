export type FileSystem = {
  read: (path: string) => Promise<string>
  stat: (path: string) => Promise<{ kind: 'file' | 'dir' | 'other'; realPath?: string }>
  exists: (path: string) => Promise<boolean>
}

export function expandHome(path: string, home: string): string {
  const prefix = /^(~|\$HOME)(?=\/|$)/.exec(path)?.[0]
  return prefix === undefined ? path : `${home}${path.slice(prefix.length)}`
}

export function resolvePath(path: string, folder: string): string {
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : `${folder}/${path}`).split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`
}

export function parentOf(path: string): string {
  return resolvePath('..', path)
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function relativePath(base: string, path: string): string | undefined {
  if (path === base) return ''
  const prefix = base === '/' ? '/' : `${base}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined
}

export async function realPathOf(path: string, fs: FileSystem): Promise<string | undefined> {
  const stat = await fs.stat(path).catch(() => undefined)
  if (stat !== undefined || path === '/') return stat?.realPath
  const folder = await realPathOf(parentOf(path), fs)
  return folder === undefined ? undefined : resolvePath(nameOf(path), folder)
}
