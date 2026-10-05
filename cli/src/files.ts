import { mkdir, readdir, rename } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

export async function readText(path: string): Promise<string | undefined> {
  return Bun.file(path)
    .text()
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR') return undefined
      throw error
    })
}

export async function listFiles(folder: string): Promise<string[]> {
  return (await readdir(folder, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
    .sort()
}

export async function readJson(path: string): Promise<unknown> {
  const text = await readText(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`)
  }
}

export function home(): string {
  const value = process.env['HOME']
  if (!value) throw new Error('HOME is not set, so CMod cannot find Claude Code settings or ~/.local/bin. Set HOME.')
  return value
}

export function tilde(path: string): string {
  const value = process.env['HOME']
  return value && (path === value || path.startsWith(`${value}/`)) ? `~${path.slice(value.length)}` : path
}

export async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await Bun.write(temporary, text)
  await rename(temporary, path)
}
