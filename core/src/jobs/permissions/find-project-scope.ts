import { nameOf, parentOf, resolvePath, type FileSystem } from '../../utils/paths.js'

export type ProjectScope = { workTreeOf: (path: string) => Promise<string | undefined> }

export type Workspace = { projectRoot: string; cwd: string; home: string; fs: FileSystem; scope: ProjectScope | undefined }

export async function findProjectScope(pluginRoot: string, home: string, fs: FileSystem): Promise<ProjectScope | undefined> {
  const skills = parentOf(pluginRoot)
  const claude = parentOf(skills)
  const root = parentOf(claude)
  if (nameOf(skills) !== 'skills' || nameOf(claude) !== '.claude' || root === resolvePath(home, '/')) return undefined
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
      for (let folder = path; ; folder = parentOf(folder)) {
        const repository = await repositoryOf(folder)
        if (repository !== undefined) return repository === project ? folder : undefined
        if (folder === '/') return undefined
      }
    },
  }
}

async function readRepository(workTree: string, fs: FileSystem): Promise<string | undefined> {
  const gitPath = resolvePath('.git', workTree)
  const git = await fs.stat(gitPath).catch(() => undefined)
  if (git === undefined) return undefined
  if (git.kind === 'dir') return git.realPath ?? gitPath
  try {
    const gitDirectory = /^gitdir:\s*(.+)$/m.exec(await fs.read(gitPath))?.[1]?.trim()
    if (gitDirectory === undefined) throw new Error(`${gitPath} has no gitdir line.`)
    const linkedDirectory = resolvePath(gitDirectory, workTree)
    const commonDirectory = await fs.read(resolvePath('commondir', linkedDirectory)).then(
      (text) => resolvePath(text.trim(), linkedDirectory),
      () => linkedDirectory,
    )
    return (await fs.stat(commonDirectory)).realPath ?? commonDirectory
  } catch {
    return workTree
  }
}
