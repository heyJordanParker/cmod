import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, posix } from 'node:path'
import { parseArgs } from 'node:util'
import { version as coreVersion } from '@cmodjs/core/package.json'
import { bundleDefines, isObject, scriptPaths } from '@cmodjs/core/src/records.js'
import { changelogSections } from '@cmodjs/core/src/utils/changelog.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { cmodPluginEntry, listPlugins, validatePlugin } from '../claude.js'
import { readJson, tilde, writeAtomically } from '../files.js'
import { cmodFloor, cmodRangeOf, readDeclared, readPlugin, type Plugin } from '../plugin.js'
import { capture, run as runCommand } from '../process.js'
import { buildProgram, declaredMachines, readProgram } from '../program.js'
import { startProgress } from '../progress.js'

export const summary = 'Build a mod\'s release, tag it, and publish it on GitHub.'

export const help = `Usage: cmod publish [path] [--dry-run]

${summary}

Releases the mod at path (default: the current folder) at the version in its
plugin.json. Builds the release from the files git does not ignore, leaving
out cli/, .github/, and .claude/. A "files" list in package.json limits the release to
those paths, plus the folders of the install and uninstall steps,
.claude-plugin/, package.json, tsconfig.json, the README, and the license, the
way npm does. Bundles the hooks module with its packages into one file, writing each
control character as a \\u escape, so Anthropic's plugin directory can read
all of the mod's code. Checks
the release with claude plugin validate --strict and commits it as the release
branch. Builds the release archive from that commit and the program cli/
declares, writes SHA256SUMS for every file of the release, and writes
.claude-plugin/marketplace.json listing the archive, the cmod plugin, and
each other mod plugin.json depends on, from the release branch of the GitHub
repository its installed or linked copy names in plugin.json "repository", so
each dependency resolves in the mod's marketplace. It refuses a dependency
installed nowhere here, or whose plugin.json names no GitHub repository. Then
commits that file, tags v<version>, tags the release commit
<name>--v<version>, which Claude Code installs a version range from when a
marketplace lists the mod from git, pushes both tags and the release branch,
creates the GitHub release with every file, then pushes the branch with
marketplace.json, so no update reaches a release without its files. Its notes
are the "## [<version>]" section of the committed CHANGELOG.md, which every
release ships, and it refuses a version with no section. It refuses a package.json that depends on a file: or link:
path, which no user has.

Options:
  --dry-run  Build everything into a temporary folder, marketplace.json
             included, from the working tree with its uncommitted changes,
             and push nothing`

const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

const leftOut = ['cli', '.github', '.claude']

const alwaysReleased = ['.claude-plugin', 'package.json', 'tsconfig.json', 'README*', 'LICENSE*', 'CHANGELOG.md']

const releaseBranch = 'release'

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
  const answer = (...args: string[]) => gitAnswer(plugin.root, args)
  if ((await answer('rev-parse', '--show-toplevel')).trim() !== plugin.root) throw new Error(`${plugin.root} is not the root of a git repository. Run git init there and commit the mod.`)
  const repository = githubRepository(await answer('remote', 'get-url', 'origin'))
  const tag = `v${plugin.version}`
  const isDirty = (await git('status', '--porcelain')).trim() !== ''
  if (!dryRun && isDirty) throw new Error('The working tree has uncommitted changes. Commit them, then run cmod publish again.')
  for (const existing of [tag, `${plugin.name}--v${plugin.version}`]) {
    if (!dryRun && (await git('tag', '--list', existing)).trim() !== '') throw new Error(`The tag ${existing} exists. Raise "version" in .claude-plugin/plugin.json, then run cmod publish again.`)
  }
  const notes = changelogSections(await answer('show', 'HEAD:CHANGELOG.md')).find((section) => section.version === plugin.version)?.text
  if (notes === undefined || notes === '') throw new Error(`The committed CHANGELOG.md has no "## [${plugin.version}]" section with notes. Write what changed for the people who use ${plugin.name} under it, commit it, then run cmod publish again.`)
  const declared = await readDeclared(plugin.root)
  const written = (await readJson(`${plugin.root}/.claude-plugin/plugin.json`)) as Record<string, unknown>
  if (declared.type === 'declared' && JSON.stringify(written['userConfig'] ?? {}) !== JSON.stringify(declared.userConfig)) {
    throw new Error('.claude-plugin/plugin.json userConfig differs from the options defineMod declares, so Claude Code would ask for and store the wrong options. Run cmod check, which writes them, commit .claude-plugin/plugin.json, then run cmod publish again.')
  }
  if (declared.type === 'declared' && JSON.stringify(plugin.steps.hotkeys ?? {}) !== JSON.stringify(declared.hotkeys)) {
    throw new Error('package.json "cmod.hotkeys" differs from the hotkeys defineMod declares, so cmod would bind the wrong combos. Run cmod check, which writes them, commit package.json, then run cmod publish again.')
  }
  const floor = await cmodFloor(plugin)
  const range = cmodRangeOf(written)
  if (floor !== undefined && range !== `>=${floor.cmod}`) {
    throw new Error(`.claude-plugin/plugin.json ${range === undefined ? 'names no cmod version' : `depends on cmod "${range}"`}, and this mod bundles @cmodjs/core ${floor.core}, which runs on cmod ${floor.cmod} or later, so it needs ">=${floor.cmod}", which every newer cmod satisfies. Run cmod check, which writes it, commit .claude-plugin/plugin.json, then run cmod publish again.`)
  }
  const dependedOn = (Array.isArray(written['dependencies']) ? written['dependencies'] : [])
    .map((dependency: unknown) => (isObject(dependency) ? dependency['name'] : dependency))
    .filter((name): name is string => typeof name === 'string' && name !== cmodPluginEntry.name)
  const installed = dependedOn.length === 0 ? [] : await listPlugins()
  const dependencies: { name: string; repo: string; description: string | undefined }[] = []
  const unlisted: string[] = []
  for (const name of dependedOn) {
    const copy = installed.find((each) => each.name === name)
    const dependency = copy === undefined ? undefined : await readPlugin(copy.installPath)
    const repo = dependency?.repository === undefined ? undefined : githubRepositoryOf(dependency.repository)
    if (repo === undefined) unlisted.push(name)
    else dependencies.push({ name, repo, description: dependency?.description })
  }
  if (unlisted.length > 0) {
    throw new Error(`.claude-plugin/plugin.json depends on ${unlisted.join(', ')}, and no copy installed here names its GitHub repository in .claude-plugin/plugin.json "repository", so ${plugin.name}'s marketplace cannot list ${unlisted.length === 1 ? 'it' : 'them'} and Claude Code would leave ${plugin.name} off. Install or link ${unlisted.join(' and ')}, with "repository": "https://github.com/<owner>/<repo>" in its plugin.json, then run cmod publish again.`)
  }

  const progress = startProgress()
  const output = await mkdtemp(join(tmpdir(), `cmod-publish-${plugin.name}-`))
  progress.step('Building the release')
  const { tree, bundle } = await buildRelease(plugin, output)
  const leftOutFolders = leftOut.map((folder) => `${folder}/`).join(', ')
  const contents = plugin.packageJson?.['files'] === undefined ? `without ${leftOutFolders}` : `with only the paths package.json "files" lists, the folders of its install steps, and ${alwaysReleased.join(', ')}`
  progress.succeed(`Built ${tree} from ${isDirty ? 'the working tree, with its uncommitted changes' : 'HEAD'}, ${contents}${bundle === undefined ? '' : `, and the hooks module and its packages bundled into hooks/${bundle}`}`)

  progress.step('Checking the release with claude plugin validate --strict')
  const failure = await validatePlugin(tree)
  if (failure !== undefined) throw new Error(failure)
  progress.succeed('claude plugin validate --strict passed on the release')

  if (!dryRun) await answer('fetch', 'origin', releaseBranch)
  const parent = (await answer('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${releaseBranch}`)).trim()
  const release = await commitRelease(output, tree, tag, parent, git)
  const archive = join(output, `${plugin.name}-${plugin.version}.zip`)
  await git('archive', '--format=zip', '--output', archive, release)
  const sha256 = await fileSha256(archive)
  progress.succeed(`Built ${archive} from the release, sha256 ${sha256}`)

  let programs: string[] = []
  if (program !== undefined) {
    programs = await buildProgram(program, declaredMachines(plugin.packageJson), progress)
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
  for (const { name, repo, description } of dependencies) {
    plugins.push({ name, description: description ?? `${name}, a Claude Code mod`, source: { source: 'github', repo, ref: releaseBranch } })
    progress.succeed(`Listed ${name} from the ${releaseBranch} branch of ${repo}, so the ${name} dependency resolves in this marketplace and follows each ${name} release`)
  }
  const marketplacePath = dryRun ? join(output, 'marketplace.json') : join(plugin.root, '.claude-plugin', 'marketplace.json')
  const marketplace = { name: plugin.name, owner: { name: repository.split('/')[0] }, description: plugin.description ?? `${plugin.name}, a Claude Code mod`, plugins }
  await writeAtomically(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`)
  progress.succeed(`Wrote ${marketplacePath}`)

  const assets = [archive, ...programs, sums]
  const directoryLink = `https://github.com/${repository}/tree/${releaseBranch}`
  if (dryRun) {
    process.stdout.write(`\nDry run: ${tag} would release these files to https://github.com/${repository}, and ${tree} to its ${releaseBranch} branch. Nothing was pushed:\n${assets.map((asset) => `  ${asset}`).join('\n')}\n\nIts release notes would read:\n\n${notes}\n`)
    return 0
  }
  progress.step(`Releasing ${tag}`)
  await git('add', marketplacePath)
  await git('commit', '--message', `release ${tag}`)
  const dependencyTag = `${plugin.name}--v${plugin.version}`
  await git('tag', tag)
  await git('tag', dependencyTag, release)
  await git('push', '--atomic', 'origin', tag, dependencyTag, `${release}:refs/heads/${releaseBranch}`)
  await runCommand(['gh', 'release', 'create', tag, ...assets, '--repo', repository, '--title', `${plugin.name} ${plugin.version}`, '--generate-notes', '--notes', notes])
  await git('push', 'origin', 'HEAD')
  progress.succeed(`Released ${tag}: https://github.com/${repository}/releases/tag/${tag}`)
  process.stdout.write(`\nTo list ${plugin.name} in Anthropic's plugin directory, open https://claude.ai/directory/manage, select Submit new, and paste this as the Repository:\n  ${directoryLink}\n`)
  return 0
}

async function gitAnswer(root: string, args: readonly string[]): Promise<string> {
  const { exitCode, stdout } = await capture(['git', '-C', root, ...args])
  return exitCode === 0 ? stdout : ''
}

export async function buildRelease(plugin: Plugin, output: string): Promise<{ tree: string; bundle: string | undefined }> {
  const listed = plugin.packageJson?.['files']
  if (listed !== undefined && !(Array.isArray(listed) && listed.every((path) => typeof path === 'string'))) {
    throw new Error(`${tilde(plugin.root)}/package.json has a "files" key that is not a list of paths. Write it as "files": ["hooks", "src", "skills"], or remove it to release every file of the mod.`)
  }
  const files = await filesOf(plugin.root)
  for (const path of listed ?? []) {
    if (!files.some((file) => isUnder(file, [path]))) throw new Error(`package.json "files" lists ${path}, which matches no file in the mod. Add the file or remove it from "files", then run the command again.`)
  }
  const stepFolders = [plugin.steps.install, plugin.steps.uninstall].flatMap((command) => (command === undefined ? [] : scriptPaths(command))).map((path) => posix.dirname(posix.normalize(path)))
  const released = files.filter((file) => (listed === undefined || isUnder(file, [...listed, ...alwaysReleased, ...stepFolders])) && !isUnder(file, leftOut))
  const tree = join(output, releaseBranch)
  await mkdir(tree)
  for (const file of released) await cp(join(plugin.root, file), join(tree, file), { verbatimSymlinks: true })
  const borrowed = ['node_modules', '.claude-plugin/types'].filter((path) => existsSync(join(plugin.root, path)) && existsSync(join(tree, posix.dirname(path))) && !existsSync(join(tree, path)))
  for (const path of borrowed) await symlink(join(plugin.root, path), join(tree, path))
  try {
    return { tree, bundle: await bundleHooks(plugin.root, tree) }
  } finally {
    for (const path of borrowed) await unlink(join(tree, path))
  }
}

async function filesOf(root: string): Promise<string[]> {
  if ((await gitAnswer(root, ['rev-parse', '--show-toplevel'])).trim() !== root) return filesUnder(root)
  const listed = await runCommand(['git', '-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  return listed.split('\0').filter((path) => path !== '' && existsSync(join(root, path)))
}

async function filesUnder(root: string, folder = '.'): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
    const path = posix.join(folder, entry.name)
    if (!entry.isDirectory()) files.push(path)
    else if (entry.name !== '.git' && entry.name !== 'node_modules') files.push(...(await filesUnder(root, path)))
  }
  return files
}

function isUnder(path: string, globs: readonly string[]): boolean {
  const patterns = globs.map((glob) => new Bun.Glob(posix.normalize(glob).replace(/\/$/, '')))
  for (let folder = path; ; folder = posix.dirname(folder)) {
    if (patterns.some((pattern) => pattern.match(folder))) return true
    if (folder === '.') return false
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
  const { steps } = await readPlugin(root)
  const built = await Bun.build({ entrypoints: [join(tree, 'hooks', module)], format: 'esm', target: 'browser', external: ['claude-code'], define: bundleDefines(steps) }).catch((error: unknown) => {
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

async function commitRelease(output: string, tree: string, tag: string, parent: string, git: (...args: string[]) => Promise<string>): Promise<string> {
  const [name = '', email = ''] = (await git('log', '-1', '--format=%an%n%ae')).trim().split('\n')
  const gitFolder = (await git('rev-parse', '--absolute-git-dir')).trim()
  const releaseGit = (...args: string[]) =>
    runCommand(['git', '--git-dir', gitFolder, '--work-tree', tree, ...args], {
      env: { ...process.env, GIT_INDEX_FILE: join(output, `${releaseBranch}.index`), GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
    })
  await releaseGit('add', '--all', '--force', tree)
  const treeId = (await releaseGit('write-tree')).trim()
  return (await releaseGit('commit-tree', treeId, ...(parent === '' ? [] : ['-p', parent]), '-m', `release ${tag}`)).trim()
}

function githubRepository(remote: string): string {
  const repository = githubRepositoryOf(remote)
  if (repository === undefined) throw new Error(`The origin remote ${remote.trim() ? `(${remote.trim()}) is not a GitHub repository` : 'is missing'}. Run git remote add origin https://github.com/<owner>/<repo>.git.`)
  return repository
}

function githubRepositoryOf(url: string): string | undefined {
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1]
}

async function fileSha256(path: string): Promise<string> {
  return new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex')
}
