import { basename, dirname, resolve } from '../vendor.js'

export type FileSystem = {
  read: (path: string) => Promise<string>
  stat: (path: string) => Promise<{ kind: 'file' | 'dir' | 'other'; realPath?: string }>
  exists: (path: string) => Promise<boolean>
}

export function expandHome(path: string, home: string): string {
  const prefix = /^(~|\$HOME)(?=\/|$)/.exec(path)?.[0]
  return prefix === undefined ? path : `${home}${path.slice(prefix.length)}`
}

export function relativePath(base: string, path: string): string | undefined {
  if (path === base) return ''
  const prefix = base === '/' ? '/' : `${base}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined
}

export async function realPathOf(path: string, fs: FileSystem): Promise<string | undefined> {
  const stat = await fs.stat(path).catch(() => undefined)
  if (stat !== undefined || path === '/') return stat?.realPath
  const folder = await realPathOf(dirname(path), fs)
  return folder === undefined ? undefined : resolve(folder, basename(path))
}
