import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { changePlugin, listPlugins, type InstalledPlugin } from '../claude.js'
import { usesCmod } from '../plugin.js'
import { startProgress } from '../progress.js'
import { modLock, storePath, takeLock } from '../store.js'
import { followUpdates, installCmodPlugin, installMod } from './install.js'

export const summary = 'Update any plugin through Claude Code, and rerun changed install steps.'

export const help = `Usage: cmod update [name]

${summary}

Updates the named plugin, or every plugin Claude Code has installed, through
Claude Code, then runs the install step of each mod whose version or scripts
changed. A linked plugin is skipped, because saving its files updates it. When
Claude Code fails to update a plugin, cmod update names it, updates the rest,
and exits 1. Every running session loads the new version.`

export async function run(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} })
  if (positionals.length > 1) throw new Error(`cmod update takes at most one name.\n\n${help}`)
  const name = positionals[0]
  const plugins = (await listPlugins()).filter((plugin) => name === undefined || plugin.name === name || plugin.id === name)
  if (plugins.length === 0) throw new Error(name === undefined ? 'Claude Code has no plugins installed.' : `No installed plugin is named ${name}. cmod list shows the installed plugins.`)

  const progress = startProgress()
  let exitCode = 0
  const updated: string[] = []
  for (const { id, name: pluginName, isLinked, installPath } of plugins) {
    if (isLinked) {
      progress.skip(`${id} is linked from ${installPath}, so saving its files updates it.`)
      continue
    }
    progress.step(`Updating ${id}`)
    try {
      const lock = existsSync(storePath()) ? await takeLock(modLock(pluginName)) : undefined
      await changePlugin('update', id).finally(() => lock?.[Symbol.asyncDispose]())
      progress.succeed(`Updated ${id} through Claude Code`)
      updated.push(id)
    } catch (error) {
      progress.fail(messageOf(error))
      exitCode = 1
    }
  }
  if (updated.length === 0) return exitCode
  if (updated.includes('cmod@cmod')) await followUpdates(progress)

  const listed = await listPlugins()
  const mods: InstalledPlugin[] = []
  for (const id of updated) {
    const plugin = listed.find((entry) => entry.id === id)
    if (plugin === undefined) throw new Error(`Claude Code updated ${id} but claude plugin list no longer shows it.`)
    if (await usesCmod(plugin.installPath, plugin.name)) mods.push(plugin)
  }
  const isCmodNew = mods.length > 0 && (await installCmodPlugin(progress))
  for (const plugin of mods) exitCode = Math.max(exitCode, await installMod(plugin, [], progress, isCmodNew))
  return exitCode
}
