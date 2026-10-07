import type { FileSystem } from '../../utils/paths.js'
import { basename, dirname, resolve } from '../../vendor.js'

export type ProjectScope = { workTreeOf: (path: string) => Promise<string | undefined> }

export type Workspace = { projectRoot: string; cwd: string; home: string; fs: FileSystem; scope: ProjectScope | undefined }

export async function findProjectScope(pluginRoot: string, home: string, fs: FileSystem): Promise<ProjectScope | undefined> {
  const skills = dirname(pluginRoot)
  const claude = dirname(skills)
  const root = dirname(claude)
  if (basename(skills) !== 'skills' || basename(claude) !== '.claude' || root === resolve('/', home)) return undefined
  const repositories = new Map<string, string>()
  const repositoryOf = async (workTree: string) => {
    const known = repositories.get(workTree)
    if (known !== undefined) return known
    const repository = await readRepository(workTree, fs)
    if (repository !== undefined) repositories.set(workTree, repository)
    return repository
  }
  const project = await repositoryOf(root)
  if (project === undefined) return undefined
  return {
    async workTreeOf(path) {
      for (let folder = path; ; folder = dirname(folder)) {
        const repository = await repositoryOf(folder)
        if (repository !== undefined) return repository === project ? folder : undefined
        if (folder === '/') return undefined
      }
    },
  }
}

async function readRepository(workTree: string, fs: FileSystem): Promise<string | undefined> {
  const gitPath = resolve(workTree, '.git')
  const git = await fs.stat(gitPath).catch(() => undefined)
  if (git === undefined) return undefined
  if (git.kind === 'dir') return git.realPath ?? gitPath
  try {
    const gitDirectory = /^gitdir:\s*(.+)$/m.exec(await fs.read(gitPath))?.[1]?.trim()
    if (gitDirectory === undefined) throw new Error(`${gitPath} has no gitdir line.`)
    const linkedDirectory = resolve(workTree, gitDirectory)
    const commonDirectory = await fs.read(resolve(linkedDirectory, 'commondir')).then(
      (text) => resolve(linkedDirectory, text.trim()),
      () => linkedDirectory,
    )
    return (await fs.stat(commonDirectory)).realPath ?? commonDirectory
  } catch {
    return workTree
  }
}
