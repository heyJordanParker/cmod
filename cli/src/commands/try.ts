import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { readRecord, storeFolder, type InstallRecord } from '@cmodjs/core/src/records.js'
import { home, readText, tilde } from '../files.js'
import { preparePackages, readPlugin, sourceOf, type Plugin } from '../plugin.js'
import { run as runCommand, runAttached } from '../process.js'
import { startProgress } from '../progress.js'
import { configRoot, keepSettings, keptSettings } from '../settings.js'
import { installCmodPlugin } from './install.js'
import { holdSignals, setupInTerminal } from './setup.js'
import { teardownInTerminal } from './teardown.js'

export const summary = 'Start one throwaway Claude Code session with mods set up.'

export const help = `Usage: cmod try <owner/repo | path>... [--yes] [--home <folder>] [-- claude arguments]

${summary}

Runs Claude Code with a new, empty home folder, so the session sees only the
mods named here and changes none of your Claude Code settings, mods, key
bindings, or history. The folder is deleted when the session ends. The
session stays logged in as you, and keeps how Claude Code reaches the model
and what it must never do: env, the credential helpers and login pins,
sandbox, and permissions.deny from your settings.json. Hooks, plugins, allow
rules, and preferences stay behind. --home <folder> runs in that folder and
keeps it for the next try, and --home ~ runs in your own home.

Installs the cmod plugin into Claude Code when it lacks it and runs each mod's
install step after asking consent for its install and uninstall commands and
its key bindings, then starts one Claude Code session with every mod loaded
through --plugin-dir. Unlike cmod link, it builds no program from cli/, so a
program comes from the mod's GitHub release. When the session ends, even when
its terminal closes, runs each mod's uninstall step and deletes its record, data
folder, approval, key bindings, and program, so the mod stays uninstalled.
Ctrl+C or Ctrl+D at a consent question deletes the clones and changes nothing
else. Ctrl+C, a closed terminal, or SIGTERM installs nothing more and skips a
session that has not started, and the uninstall steps run to their end.
The cmod plugin stays installed in the home, as the cmod program does. A GitHub
mod is cloned into a temporary folder that is deleted too. A mod another folder
has set up in the home is refused, so cmod try never replaces an installed copy.
A checkout already set up from the same folder keeps its setup. Arguments after
-- go to claude, such as -- -p "hello".

Options:
  --yes            Approve each mod's install and uninstall commands and key
                   bindings without asking
  --home <folder>  Run in this home folder and keep it, such as --home ~`

type Tried = { readonly plugin: Plugin; readonly record: InstallRecord | undefined }

export async function run(argv: string[]): Promise<number> {
  const split = argv.indexOf('--')
  const own = split === -1 ? argv : argv.slice(0, split)
  const forwarded = split === -1 ? [] : argv.slice(split + 1)
  const { values, positionals } = parseArgs({ args: own, allowPositionals: true, options: { yes: { type: 'boolean', default: false }, home: { type: 'string' } } })
  if (positionals.length === 0) throw new Error(`cmod try takes at least one source.\n\n${help}`)
  const sources = positionals.map(sourceOf)
  const kept = values.home === undefined ? undefined : homeFolder(values.home)
  const progress = startProgress()
  using hold = holdSignals()

  const temporary = kept === undefined ? await mkdtemp(join(tmpdir(), 'cmod-try-home-')) : undefined
  const clones: string[] = []
  try {
    await useHome(temporary ?? (kept as string))
    const tried: Tried[] = []
    for (const source of sources) {
      const clone = source.kind === 'github' ? await mkdtemp(join(tmpdir(), 'cmod-try-')) : undefined
      if (clone !== undefined) {
        clones.push(clone)
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
      tried.push({ plugin, record })
    }
    if (hold.signal === undefined) await installCmodPlugin(progress)
    const setUp: string[] = []
    try {
      for (const { plugin, record } of tried) {
        const code = await setupInTerminal(plugin, { yes: values.yes }, progress)
        if (code !== 0) return code
        if (record === undefined) setUp.push(plugin.name)
        if (hold.signal !== undefined) return code
      }
      const exitCode = await runAttached(['claude', ...tried.flatMap(({ plugin }) => ['--plugin-dir', plugin.root]), ...forwarded])
      hold.signal = undefined
      return exitCode
    } finally {
      for (const name of setUp.reverse()) await teardownInTerminal(name, progress)
    }
  } finally {
    for (const clone of clones) await rm(clone, { recursive: true, force: true })
    if (temporary !== undefined) await rm(temporary, { recursive: true, force: true })
  }
}

function homeFolder(path: string): string {
  return resolve(path === '~' || path.startsWith('~/') ? join(home(), path.slice(1)) : path)
}

async function useHome(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true })
  const real = realpathSync(folder)
  const own = home()
  if (real === realpathSync(own)) return
  const kept = await keptSettings()
  const keychains = join(own, 'Library/Keychains')
  if (existsSync(keychains) && !existsSync(join(real, 'Library/Keychains'))) {
    await mkdir(join(real, 'Library'), { recursive: true })
    await symlink(keychains, join(real, 'Library/Keychains'))
  }
  if (process.env['CLAUDE_SECURESTORAGE_CONFIG_DIR'] === undefined && (process.env['CLAUDE_CONFIG_DIR'] || process.platform !== 'darwin')) {
    process.env['CLAUDE_SECURESTORAGE_CONFIG_DIR'] = configRoot()
  }
  const profiles = join(process.env['XDG_CONFIG_HOME'] || join(own, '.config'), 'anthropic')
  if (process.env['ANTHROPIC_CONFIG_DIR'] === undefined && existsSync(profiles)) process.env['ANTHROPIC_CONFIG_DIR'] = profiles
  for (const name of ['CLAUDE_CONFIG_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) delete process.env[name]
  process.env['HOME'] = real
  process.env['PATH'] = [join(real, '.local/bin'), process.env['PATH']].filter(Boolean).join(':')
  await keepSettings(kept)
}
