import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { readRecord, storeFolder } from 'cmod-sdk/src/records.js'
import { readText, tilde } from '../files.js'
import { preparePackages, readPlugin, sourceOf } from '../plugin.js'
import { run as runCommand, runAttached } from '../process.js'
import { startProgress } from '../progress.js'
import { installCmodPlugin } from './install.js'
import { holdSignals, setupInTerminal } from './setup.js'
import { teardownInTerminal } from './teardown.js'

export const summary = 'Start one throwaway Claude Code session with a mod set up.'

export const help = `Usage: cmod try <owner/repo | path> [--yes] [-- claude arguments]

${summary}

Installs the CMod plugin into Claude Code when it lacks it and runs the mod's
install step after asking consent for its install and uninstall commands, as
cmod link does, then starts one Claude Code session with the mod loaded through
--plugin-dir. When the session ends, even when its terminal closes, runs the
mod's uninstall step and deletes its record, data folder, approval, and
program, so the mod stays uninstalled. Ctrl+C or Ctrl+D at the consent
question deletes the clone and changes nothing else. Ctrl+C, a closed terminal,
or SIGTERM installs nothing more and skips a session that has not started, and
the uninstall step runs to its end.
The CMod plugin stays installed, as the cmod program does. A GitHub mod is
cloned into a temporary folder that is deleted too. A mod another folder has
set up is refused, so cmod try never replaces an installed copy. A checkout
already set up from the same folder keeps its setup. Arguments after -- go to
claude, such as -- -p "hello".

Options:
  --yes  Approve the mod's install and uninstall commands without asking`

export async function run(argv: string[]): Promise<number> {
  const split = argv.indexOf('--')
  const own = split === -1 ? argv : argv.slice(0, split)
  const forwarded = split === -1 ? [] : argv.slice(split + 1)
  const { values, positionals } = parseArgs({ args: own, allowPositionals: true, options: { yes: { type: 'boolean', default: false } } })
  if (positionals.length !== 1) throw new Error(`cmod try takes one source.\n\n${help}`)
  const source = sourceOf(positionals[0] as string)
  const progress = startProgress()
  using hold = holdSignals()

  const clone = source.kind === 'github' ? await mkdtemp(join(tmpdir(), 'cmod-try-')) : undefined
  try {
    if (clone !== undefined) {
      progress.step(`Cloning ${source.text}`)
      await runCommand(['git', 'clone', '--depth', '1', `https://github.com/${source.text}.git`, clone])
      progress.succeed(`Cloned ${source.text}`)
    }
    const plugin = await readPlugin(clone ?? source.text)
    const record = await readRecord(readText, storeFolder(process.env), plugin.name)
    if (record !== undefined && record.root !== plugin.root) {
      throw new Error(`${plugin.name} is set up from ${tilde(record.root)}, so cmod try would replace its record and saved uninstall step. Run cmod remove ${plugin.name}, or cmod unlink ${tilde(record.root)} for a linked checkout, then run cmod try again.`)
    }
    progress.step(`Installing packages for ${plugin.name}`)
    if (await preparePackages(plugin)) progress.succeed(`Installed packages for ${plugin.name}`)
    else progress.succeed(`${plugin.name} has no packages to install`)
    await installCmodPlugin(progress, hold.abortSignal)
    const code = await setupInTerminal(plugin, { yes: values.yes }, progress)
    if (code !== 0) return code
    try {
      if (hold.signal !== undefined) return code
      const exitCode = await runAttached(['claude', '--plugin-dir', plugin.root, ...forwarded])
      hold.signal = undefined
      return exitCode
    } finally {
      if (record === undefined) await teardownInTerminal(plugin.name, progress)
    }
  } finally {
    if (clone !== undefined) await rm(clone, { recursive: true, force: true })
  }
}
