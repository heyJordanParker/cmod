import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { version as cmodVersion } from '../../package.json'
import { tilde, writeAtomically } from '../files.js'
import { readPlugin } from '../plugin.js'
import { run as runCommand } from '../process.js'
import { buildProgram, readProgram, releaseDownloads } from '../program.js'
import { startProgress } from '../progress.js'

export const summary = 'Build a mod\'s release, tag it, and publish it on GitHub.'

export const help = `Usage: cmod publish [path] [--dry-run]

${summary}

Releases the mod at path (default: the current folder) at the version in its
plugin.json. Builds the release archive from the committed files with git
archive, leaving out cli/, builds the program cli/ declares, writes SHA256SUMS
for every file of the release, and writes .claude-plugin/marketplace.json
listing the archive and the CMod plugin. Then commits that file, tags
v<version>, pushes, and creates the GitHub release.

Options:
  --dry-run  Build and write everything, and push nothing`

const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']

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
  const git = (...args: string[]) => runCommand(['git', '-C', plugin.root, ...args])
  if ((await git('rev-parse', '--show-toplevel').catch(() => '')).trim() !== plugin.root) throw new Error(`${plugin.root} is not the root of a git repository. Run git init there and commit the mod.`)
  const repository = githubRepository(await git('remote', 'get-url', 'origin').catch(() => ''))
  const tag = `v${plugin.version}`
  const isDirty = (await git('status', '--porcelain')).trim() !== ''
  if (!dryRun && isDirty) throw new Error('The working tree has uncommitted changes. Commit them, then run cmod publish again.')
  if (!dryRun && (await git('tag', '--list', tag)).trim() !== '') throw new Error(`The tag ${tag} exists. Raise "version" in .claude-plugin/plugin.json, then run cmod publish again.`)

  const progress = startProgress()
  const output = await mkdtemp(join(tmpdir(), `cmod-publish-${plugin.name}-`))
  const archive = join(output, `${plugin.name}-${plugin.version}.zip`)
  progress.step('Building the release archive')
  await git('archive', '--format=zip', '--output', archive, 'HEAD', '--', '.', ':(exclude)cli')
  const sha256 = await fileSha256(archive)
  progress.succeed(`Built ${archive} from ${isDirty ? 'the last commit, without the uncommitted changes' : 'HEAD'}, without cli/, sha256 ${sha256}`)

  let programs: string[] = []
  if (program !== undefined) {
    programs = await buildProgram(program, progress)
    const names = platforms.map((platform) => `${program.name}-${platform}`)
    const misnamed = programs.map((path) => basename(path)).filter((file) => !names.includes(file))
    if (misnamed.length > 0) throw new Error(`The build of ${program.name} wrote ${misnamed.join(', ')}, which no platform downloads. Name each build <program>-<os>-<arch>: ${names.join(', ')}.`)
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
    progress.step(`Hashing the CMod plugin ${cmodVersion}`)
    plugins.push(await cmodPluginEntry())
    progress.succeed(`Listed the CMod plugin ${cmodVersion}, so the cmod dependency resolves in this marketplace`)
  }
  const marketplacePath = join(plugin.root, '.claude-plugin', 'marketplace.json')
  const marketplace = { name: plugin.name, owner: { name: repository.split('/')[0] }, description: plugin.description ?? `${plugin.name}, a Claude Code mod`, plugins }
  await writeAtomically(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`)
  progress.succeed(`Wrote ${marketplacePath}`)

  const assets = [archive, ...programs, sums]
  if (dryRun) {
    process.stdout.write(`\nDry run: ${tag} would release these files to https://github.com/${repository}, and nothing was pushed:\n${assets.map((asset) => `  ${asset}`).join('\n')}\n`)
    return 0
  }
  progress.step(`Releasing ${tag}`)
  await git('add', marketplacePath)
  await git('commit', '--message', `release ${tag}`)
  await git('tag', tag)
  await git('push', 'origin', 'HEAD', tag)
  await runCommand(['gh', 'release', 'create', tag, ...assets, '--repo', repository, '--title', `${plugin.name} ${plugin.version}`, '--generate-notes'])
  progress.succeed(`Released ${tag}: https://github.com/${repository}/releases/tag/${tag}`)
  return 0
}

function githubRepository(remote: string): string {
  const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim())
  if (!match) throw new Error(`The origin remote ${remote.trim() ? `(${remote.trim()}) is not a GitHub repository` : 'is missing'}. Run git remote add origin https://github.com/<owner>/<repo>.git.`)
  return match[1] as string
}

async function cmodPluginEntry(): Promise<unknown> {
  const url = `${releaseDownloads('https://github.com/heyJordanParker/cmod')}/v${cmodVersion}/cmod-${cmodVersion}.zip`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Downloading the CMod plugin from ${url} returned ${response.status}. Check the network, then run cmod publish again.`)
  const sha256 = new Bun.CryptoHasher('sha256').update(await response.arrayBuffer()).digest('hex')
  return { name: 'cmod', description: 'Claude Mod Manager: runs the uninstall step of each mod Claude Code removes', source: { source: 'archive', url, sha256 } }
}

async function fileSha256(path: string): Promise<string> {
  return new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex')
}
