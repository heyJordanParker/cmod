import { basename, dirname, resolve } from '../vendor.js'
import { messageOf } from './text.js'

const missingPath = /(?:^|: )(?:ENOENT|ENOTDIR)\b/

export function isMissing(error: unknown): boolean {
  return missingPath.test(messageOf(error))
}

export function ifMissing<Value>(value: Value): (error: unknown) => Value {
  return (error) => {
    if (isMissing(error)) return value
    throw error
  }
}

export type FileSystem = {
  read: (path: string) => Promise<string>
  stat: (path: string) => Promise<{ kind: 'file' | 'dir' | 'other'; realPath?: string }>
  exists: (path: string) => Promise<boolean>
}

export const homePrefix = /^(~|\$HOME|\$CLAUDE_CONFIG_DIR)(?=\/|$)/

export function expandHome(path: string, home: string, configRoot = `${home}/.claude`): string {
  const prefix = homePrefix.exec(path)?.[0]
  if (prefix === undefined) return path
  return `${prefix === '$CLAUDE_CONFIG_DIR' ? configRoot : home}${path.slice(prefix.length)}`
}

export function relativePath(base: string, path: string): string | undefined {
  if (path === base) return ''
  const prefix = base === '/' ? '/' : `${base}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined
}

export async function realPathOf(path: string, fs: FileSystem): Promise<string | undefined> {
  const stat = await fs.stat(path).catch(ifMissing(undefined))
  if (stat !== undefined || path === '/') return stat?.realPath
  const folder = await realPathOf(dirname(path), fs)
  return folder === undefined ? undefined : resolve(folder, basename(path))
}
