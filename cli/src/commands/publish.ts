import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, posix } from 'node:path'
import { parseArgs } from 'node:util'
import { version as coreVersion } from '@cmodjs/core/package.json'
import { isObject, scriptPaths } from '@cmodjs/core/src/records.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { readJson, tilde, writeAtomically } from '../files.js'
import { declaredOptions, readPlugin } from '../plugin.js'
import { run as runCommand } from '../process.js'
import { buildProgram, machines, readProgram } from '../program.js'
import { startProgress } from '../progress.js'

export const summary = 'Build a mod\'s release, tag it, and publish it on GitHub.'

export const help = `Usage: cmod publish [path] [--dry-run]

${summary}

Releases the mod at path (default: the current folder) at the version in its
plugin.json. Builds the release from the committed files, leaving out cli/,
.github/, and .claude/. A "files" list in package.json limits the release to
those paths, plus the folders of the install and uninstall steps,
.claude-plugin/, package.json, tsconfig.json, the README, and the license, the
way npm does. Bundles the hooks module with its packages into one file, writing each
control character as a \\u escape, so Anthropic's plugin directory can read
all of the mod's code. Checks
the release with claude plugin validate --strict and commits it as the release
branch. Builds the release archive from that commit and the program cli/
declares, writes SHA256SUMS for every file of the release, and writes
.claude-plugin/marketplace.json listing the archive and the cmod plugin. Then
commits that file, tags v<version>, pushes the tag and the release branch, and
creates the GitHub release. The release notes open with a Breaking changes
list: each BREAKING CHANGE: footer of a commit since the last v tag, or the
subject of a commit typed with !, such as feat!:. It refuses a package.json
that depends on a file: or link: path, which no user has.

Options:
  --dry-run  Build everything into a temporary folder, marketplace.json
             included, and push nothing`

const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

const leftOut = ['cli', '.github', '.claude']

const alwaysReleased = ['.claude-plugin', 'package.json', 'tsconfig.json', 'README*', 'LICENSE*']

const releaseBranch = 'release'

const cmodPluginEntry = {
  name: 'cmod',
  description: 'Claude Mod Manager: runs the uninstall step of each mod Claude Code removes',
  source: { source: 'github', repo: 'heyJordanParker/cmod', ref: releaseBranch },
}

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { 'dry-run': { type: 'boolean', default: false } } })
  if (positionals.length > 1) throw new Error(`cmod publish takes at most one path.\n\n${help}`)
  const dryRun = values['dry-run']
  const plugin = await readPlugin(positionals[0] ?? '.')
  const program = await readProgram(plugin)
  if (program !== undefined && program.name !== plugin.steps.program) {
    const packagePath = `${tilde(plugin.root)}/package.json`
    throw new Error(`${tilde(program.folder)} declares the program ${program.name}, but ${packagePath} ${plugin.steps.program === undefined ? 'does not name it' : `names "${plugin.steps.program}"`}, so installing the mod would not fetch ${program.name}. Write "program": "${program.name}" in the "cmod" key of ${packagePath}.`)
  }
  const local = dependencyGroups
    .map((group) => plugin.packageJson?.[group])
    .flatMap((dependencies) => Object.entries(isObject(dependencies) ? dependencies : {}))
    .filter(([, spec]) => typeof spec === 'string' && /^(file|link):/.test(spec))
  if (local.length > 0) {
    throw new Error(`${tilde(plugin.root)}/package.json depends on ${local.map(([name, spec]) => `${name} at ${spec}`).join(', ')}, which exist only on this machine, so the published mod would not install. Depend on versions published on npm, such as "@cmodjs/core": "^${coreVersion}", then run cmod publish again.`)
  }
  const git = (...args: string[]) => runCommand(['git', '-C', plugin.root, ...args])
  if ((await git('rev-parse', '--show-toplevel').catch(() => '')).trim() !== plugin.root) throw new Error(`${plugin.root} is not the root of a git repository. Run git init there and commit the mod.`)
  const repository = githubRepository(await git('remote', 'get-url', 'origin').catch(() => ''))
  const tag = `v${plugin.version}`
  const isDirty = (await git('status', '--porcelain')).trim() !== ''
  if (!dryRun && isDirty) throw new Error('The working tree has uncommitted changes. Commit them, then run cmod publish again.')
  if (!dryRun && (await git('tag', '--list', tag)).trim() !== '') throw new Error(`The tag ${tag} exists. Raise "version" in .claude-plugin/plugin.json, then run cmod publish again.`)
  const declared = await declaredOptions(plugin.root)
  const written = (await readJson(`${plugin.root}/.claude-plugin/plugin.json`)) as Record<string, unknown>
  if (declared.kind === 'declared' && JSON.stringify(written['userConfig'] ?? {}) !== JSON.stringify(declared.userConfig)) {
    throw new Error('.claude-plugin/plugin.json userConfig differs from the options defineMod declares, so Claude Code would ask for and store the wrong options. Run cmod check, which writes them, commit .claude-plugin/plugin.json, then run cmod publish again.')
  }

  const listed = plugin.packageJson?.['files']
  if (listed !== undefined && !(Array.isArray(listed) && listed.every((path) => typeof path === 'string'))) {
    throw new Error(`${tilde(plugin.root)}/package.json has a "files" key that is not a list of paths. Write it as "files": ["hooks", "src", "skills"], or remove it to release every committed file.`)
  }
  const stepFolders = [plugin.steps.install, plugin.steps.uninstall].flatMap((command) => (command === undefined ? [] : scriptPaths(command))).map((path) => posix.dirname(posix.normalize(path)))
  const released = listed === undefined ? ['.'] : await releasedPaths(listed, [...alwaysReleased, ...stepFolders], git)

  const progress = startProgress()
  const output = await mkdtemp(join(tmpdir(), `cmod-publish-${plugin.name}-`))
  const tree = join(output, releaseBranch)
  progress.step('Building the release')
  const bundle = await buildReleaseTree(plugin.root, output, tree, released, git)
  const leftOutFolders = leftOut.map((folder) => `${folder}/`).join(', ')
  const contents = listed === undefined ? `without ${leftOutFolders}` : `with only the paths package.json "files" lists, the folders of its install steps, and ${alwaysReleased.join(', ')}`
  progress.succeed(`Built ${tree} from ${isDirty ? 'the last commit, without the uncommitted changes' : 'HEAD'}, ${contents}${bundle === undefined ? '' : `, and the hooks module and its packages bundled into hooks/${bundle}`}`)

  progress.step('Checking the release with claude plugin validate --strict')
  await runCommand(['claude', 'plugin', 'validate', tree, '--strict'])
  progress.succeed('claude plugin validate --strict passed on the release')

  if (!dryRun) await git('fetch', 'origin', releaseBranch).catch(() => '')
  const release = await commitRelease(output, tree, tag, git)
  const archive = join(output, `${plugin.name}-${plugin.version}.zip`)
  await git('archive', '--format=zip', '--output', archive, release)
  const sha256 = await fileSha256(archive)
  progress.succeed(`Built ${archive} from the release, sha256 ${sha256}`)

  let programs: string[] = []
  if (program !== undefined) {
    programs = await buildProgram(program, machines, progress)
  }

  const sums = join(output, 'SHA256SUMS')
  const lines: string[] = []
  for (const asset of [archive, ...programs]) lines.push(`${await fileSha256(asset)}  ${basename(asset)}`)
  await Bun.write(sums, `${lines.join('\n')}\n`)
  progress.succeed(`Wrote ${sums}`)

  const plugins: unknown[] = [
    { name: plugin.name, description: plugin.description ?? `${plugin.name}, a Claude Code mod`, source: { source: 'archive', url: `https://github.com/${repository}/releases/download/${tag}/${plugin.name}-${plugin.version}.zip`, sha256 } },
  ]
  if (plugin.name !== 'cmod') {
    plugins.push(cmodPluginEntry)
    progress.succeed(`Listed the cmod plugin from the ${releaseBranch} branch of heyJordanParker/cmod, so the cmod dependency resolves in this marketplace and follows each cmod release`)
  }
  const marketplacePath = dryRun ? join(output, 'marketplace.json') : join(plugin.root, '.claude-plugin', 'marketplace.json')
  const marketplace = { name: plugin.name, owner: { name: repository.split('/')[0] }, description: plugin.description ?? `${plugin.name}, a Claude Code mod`, plugins }
  await writeAtomically(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`)
  progress.succeed(`Wrote ${marketplacePath}`)

  const assets = [archive, ...programs, sums]
  const directoryLink = `https://github.com/${repository}/tree/${releaseBranch}`
  const breaking = breakingNotes(await commitsSinceLastTag(git))
  if (dryRun) {
    process.stdout.write(`\nDry run: ${tag} would release these files to https://github.com/${repository}, and ${tree} to its ${releaseBranch} branch. Nothing was pushed:\n${assets.map((asset) => `  ${asset}`).join('\n')}\n`)
    if (breaking !== undefined) process.stdout.write(`\nIts release notes would open with:\n\n${breaking}\n`)
    return 0
  }
  progress.step(`Releasing ${tag}`)
  await git('add', marketplacePath)
  await git('commit', '--message', `release ${tag}`)
  await git('tag', tag)
  await git('push', '--atomic', 'origin', 'HEAD', tag, `${release}:refs/heads/${releaseBranch}`)
  await runCommand(['gh', 'release', 'create', tag, ...assets, '--repo', repository, '--title', `${plugin.name} ${plugin.version}`, '--generate-notes', ...(breaking === undefined ? [] : ['--notes', breaking])])
  progress.succeed(`Released ${tag}: https://github.com/${repository}/releases/tag/${tag}`)
  process.stdout.write(`\nTo list ${plugin.name} in Anthropic's plugin directory, open https://claude.ai/directory/manage, select Submit new, and paste this as the Repository:\n  ${directoryLink}\n`)
  return 0
}

async function commitsSinceLastTag(git: (...args: string[]) => Promise<string>): Promise<string[]> {
  const last = (await git('describe', '--tags', '--abbrev=0', '--match', 'v*').catch(() => '')).trim()
  const log = await git('log', '--format=%B%x00', last === '' ? 'HEAD' : `${last}..HEAD`)
  return log.split('\0').map((message) => message.trim()).filter((message) => message !== '')
}

function breakingNotes(messages: readonly string[]): string | undefined {
  const changes = messages.flatMap((message) => {
    const footers = [...message.matchAll(/^BREAKING[ -]CHANGE:[ \t]*((?:.+\n?)+)/gm)].map((footer) => footer[1]?.trim().replace(/\s*\n\s*/g, ' ') ?? '')
    if (footers.length > 0) return footers
    const subject = /^\w+(?:\([^)]*\))?!:\s*(.+)$/.exec(message.split('\n')[0] ?? '')
    return subject === null ? [] : [subject[1] ?? '']
  })
  return changes.length === 0 ? undefined : `## Breaking changes\n\n${changes.map((change) => `- ${change}`).join('\n')}\n`
}

async function releasedPaths(listed: readonly string[], needed: readonly string[], git: (...args: string[]) => Promise<string>): Promise<string[]> {
  const committed = async (path: string) => (await git('ls-files', '--', `:(glob)${path}`)).trim() !== ''
  for (const path of listed) {
    if (!(await committed(path))) throw new Error(`package.json "files" lists ${path}, which matches no committed file. Commit it or remove it from "files", then run cmod publish again.`)
  }
  const always: string[] = []
  for (const path of new Set(needed)) if (!listed.includes(path) && (await committed(path))) always.push(path)
  return [...listed, ...always].map((path) => `:(glob)${path}`)
}

async function buildReleaseTree(root: string, output: string, tree: string, released: readonly string[], git: (...args: string[]) => Promise<string>): Promise<string | undefined> {
  const tar = join(output, `${releaseBranch}.tar`)
  await git('archive', '--format=tar', '--output', tar, 'HEAD', '--', ...released, ...leftOut.map((folder) => `:(exclude)${folder}`))
  await mkdir(tree)
  await runCommand(['tar', '-xf', tar, '-C', tree])
  const borrowed = ['node_modules', '.claude-plugin/types'].filter((path) => existsSync(join(root, path)) && existsSync(join(tree, posix.dirname(path))))
  for (const path of borrowed) await symlink(join(root, path), join(tree, path))
  try {
    return await bundleHooks(root, tree)
  } finally {
    for (const path of borrowed) await unlink(join(tree, path))
  }
}

async function bundleHooks(root: string, tree: string): Promise<string | undefined> {
  const bundled = await bundledHooks(root, tree)
  if (bundled === undefined) return undefined
  const { hooks, module, code } = bundled
  const bundle = posix.join(posix.dirname(module), `${posix.basename(module, posix.extname(module))}.js`)
  await Bun.write(join(tree, 'hooks', bundle), escapeControlCharacters(code))
  await Bun.write(join(tree, 'hooks', 'hooks.json'), `${JSON.stringify({ ...hooks, modules: [`./${bundle}`] }, null, 2)}\n`)
  return bundle
}

export async function bundledHooks(root: string, tree = root): Promise<{ hooks: Record<string, unknown>; module: string; code: string } | undefined> {
  const hooksPath = join(tree, 'hooks', 'hooks.json')
  if (!existsSync(hooksPath)) return undefined
  const hooks = JSON.parse(await readFile(hooksPath, 'utf8')) as Record<string, unknown>
  const [module] = Array.isArray(hooks['modules']) ? hooks['modules'] : []
  if (typeof module !== 'string') return undefined
  const failed = (reason: string) => {
    const install = existsSync(join(root, 'node_modules')) ? '' : ` ${tilde(root)} has no node_modules, so run bun install there, then run the command again.`
    return new Error(`Bundling hooks/${module} failed: ${reason}${install}`)
  }
  const built = await Bun.build({ entrypoints: [join(tree, 'hooks', module)], format: 'esm', target: 'browser', external: ['claude-code'] }).catch((error: unknown) => {
    throw failed(error instanceof AggregateError ? error.errors.map(String).join('\n') : messageOf(error))
  })
  const [bundled] = built.outputs
  if (!built.success || bundled === undefined) throw failed(built.logs.map(String).join('\n'))
  return { hooks, module, code: await bundled.text() }
}

function escapeControlCharacters(code: string): string {
  return Array.from(code, (character) => {
    const point = character.charCodeAt(0)
    const isControl = (point < 0x20 && !'\t\n\r'.includes(character)) || point === 0x7f
    return isControl ? `\\u${point.toString(16).padStart(4, '0')}` : character
  }).join('')
}

async function commitRelease(output: string, tree: string, tag: string, git: (...args: string[]) => Promise<string>): Promise<string> {
  const [name = '', email = ''] = (await git('log', '-1', '--format=%an%n%ae')).trim().split('\n')
  const gitFolder = (await git('rev-parse', '--absolute-git-dir')).trim()
  const releaseGit = (...args: string[]) =>
    runCommand(['git', '--git-dir', gitFolder, '--work-tree', tree, ...args], {
      env: { ...process.env, GIT_INDEX_FILE: join(output, `${releaseBranch}.index`), GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
    })
  await releaseGit('add', '--all', '--force', tree)
  const treeId = (await releaseGit('write-tree')).trim()
  const parent = (await git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${releaseBranch}`).catch(() => '')).trim()
  return (await releaseGit('commit-tree', treeId, ...(parent === '' ? [] : ['-p', parent]), '-m', `release ${tag}`)).trim()
}

function githubRepository(remote: string): string {
  const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim())
  if (!match) throw new Error(`The origin remote ${remote.trim() ? `(${remote.trim()}) is not a GitHub repository` : 'is missing'}. Run git remote add origin https://github.com/<owner>/<repo>.git.`)
  return match[1] as string
}

async function fileSha256(path: string): Promise<string> {
  return new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex')
}
