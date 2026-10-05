import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { preparePackages, readPlugin, sourceOf } from '../plugin.js'
import { run as runCommand, runAttached } from '../process.js'
import { startProgress } from '../progress.js'

export const summary = 'Start one throwaway Claude Code session with a mod loaded.'

export const help = `Usage: cmod try <owner/repo | path> [-- claude arguments]

${summary}

Starts one Claude Code session with the mod loaded through --plugin-dir and
nothing installed. A GitHub mod is cloned into a temporary folder that is
deleted when the session ends. Arguments after -- go to claude, such as
-- -p "hello".`

export async function run(argv: string[]): Promise<number> {
  const split = argv.indexOf('--')
  const own = split === -1 ? argv : argv.slice(0, split)
  const forwarded = split === -1 ? [] : argv.slice(split + 1)
  const { positionals } = parseArgs({ args: own, allowPositionals: true, options: {} })
  if (positionals.length !== 1) throw new Error(`cmod try takes one source.\n\n${help}`)
  const source = sourceOf(positionals[0] as string)
  const progress = startProgress()

  const clone = source.kind === 'github' ? await mkdtemp(join(tmpdir(), 'cmod-try-')) : undefined
  try {
    if (clone !== undefined) {
      progress.step(`Cloning ${source.text}`)
      await runCommand(['git', 'clone', '--depth', '1', `https://github.com/${source.text}.git`, clone])
      progress.succeed(`Cloned ${source.text}`)
    }
    const plugin = await readPlugin(clone ?? source.text)
    progress.step(`Installing packages for ${plugin.name}`)
    if (await preparePackages(plugin)) progress.succeed(`Installed packages for ${plugin.name}`)
    else progress.succeed(`${plugin.name} has no packages to install`)
    return await runAttached(['claude', '--plugin-dir', plugin.root, ...forwarded])
  } finally {
    if (clone !== undefined) await rm(clone, { recursive: true, force: true })
  }
}
