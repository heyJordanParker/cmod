import { existsSync, realpathSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { isObject } from '@cmodjs/core/src/records.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { addMarketplace, changePlugin, configurePlugin, listMarketplaces, listPlugins, optionValues, type InstalledPlugin } from '../claude.js'
import { readJson, tilde } from '../files.js'
import { declaredOptions, readPlugin, sourceOf, usesCmod } from '../plugin.js'
import { startProgress, type Progress } from '../progress.js'
import { noteNextStep, setupInTerminal } from './setup.js'

export const summary = "Install any plugin through Claude Code, and run a mod's install step."

export const help = `Usage: cmod install <owner/repo | path> [name] [--yes]
       cmod install <name | name@marketplace> [--yes]

${summary}

Adds the plugin's marketplace to Claude Code and installs the plugin through
Claude Code. A mod, a plugin whose package.json "cmod" key names an install,
uninstall, or program step, also gets the cmod plugin when Claude Code lacks
it, and its install step runs. Any other plugin installs through Claude Code
alone, and cmod keeps no record of it. When the marketplace lists several
plugins, name the one to install after it. Given name@marketplace of a
marketplace Claude Code has added, installs that plugin. Given the name of a
plugin Claude Code already holds, such as four-step or four-step@market, runs
a mod's install step again, and installs any other plugin through Claude Code
again. A linked plugin that is not a mod is skipped, because saving its files
updates it. A path holds a "/", such as ./my-mod.

Options:
  --yes                 Approve the mod's install and uninstall commands without asking
  --option key=value    Set one of the plugin's options, as /config does. Repeat it for each option`

export type Choices = { readonly yes: boolean; readonly options: readonly string[] }

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { yes: { type: 'boolean', default: false }, option: { type: 'string', multiple: true } } })
  const [argument, chosen] = positionals
  if (argument === undefined || positionals.length > 2) throw new Error(`cmod install takes one source, and a mod name after a marketplace.\n\n${help}`)
  const choices: Choices = { yes: values.yes, options: values.option ?? [] }
  const progress = startProgress()
  if (!argument.includes('/')) {
    if (chosen !== undefined) throw new Error(`${argument} names a plugin, so cmod install takes nothing after it. Run cmod install ${argument}.`)
    return installByName(argument, choices, progress)
  }
  const source = sourceOf(argument)

  progress.step(`Adding the marketplace ${tilde(source.text)}`)
  await addMarketplace(source.text)
  const marketplace = (await listMarketplaces()).find((entry) =>
    source.kind === 'path' ? entry.path !== undefined && existsSync(entry.path) && realpathSync(entry.path) === source.text : entry.repo === source.text,
  )
  if (marketplace?.installLocation === undefined) throw new Error(`Claude Code added ${source.text} but claude plugin marketplace list does not show where it saved it.`)
  progress.succeed(`Added the marketplace ${marketplace.name}`)

  const name = await modIn(`${marketplace.installLocation}/.claude-plugin/marketplace.json`, chosen, argument)
  return installPlugin(`${name}@${marketplace.name}`, choices, progress)
}

async function installByName(argument: string, choices: Choices, progress: Progress): Promise<number> {
  const installed = (await listPlugins()).find((plugin) => plugin.name === argument || plugin.id === argument)
  if (installed !== undefined) {
    if (await usesCmod(installed.installPath, installed.name)) {
      await installCmodPlugin(progress)
      return installMod(installed, choices, progress)
    }
    if (installed.scope !== 'session') return installPlugin(installed.id, choices, progress)
    await setOptions(installed.id, installed.installPath, choices.options, progress)
    progress.skip(`${installed.id} is linked from ${installed.installPath}, so saving its files updates it. Run /reload-plugins in a session that is running.`)
    return 0
  }
  const at = argument.lastIndexOf('@')
  const marketplaceName = at > 0 ? argument.slice(at + 1) : undefined
  if (marketplaceName !== undefined && (await listMarketplaces()).some((marketplace) => marketplace.name === marketplaceName)) return installPlugin(argument, choices, progress)
  const name = at > 0 ? argument.slice(0, at) : argument
  throw new Error(`Claude Code holds no plugin named ${argument}. Install one from <owner/repo>, a path such as ./${name}, or ${name}@<marketplace> of a marketplace Claude Code has added. cmod list shows every plugin.`)
}

async function installPlugin(id: string, choices: Choices, progress: Progress): Promise<number> {
  progress.step(`Installing ${id} into Claude Code`)
  await changePlugin('install', id)
  const installed = (await listPlugins()).find((plugin) => plugin.id === id)
  if (installed === undefined) throw new Error(`Claude Code installed ${id} but claude plugin list does not show it.`)
  progress.succeed(`Installed ${id} into Claude Code`)
  if (!(await usesCmod(installed.installPath, installed.name))) {
    await setOptions(id, installed.installPath, choices.options, progress)
    return 0
  }
  await installCmodPlugin(progress)
  return installMod(installed, choices, progress)
}

export async function installMod(installed: InstalledPlugin, choices: Choices, progress: Progress): Promise<number> {
  const plugin = await readPlugin(installed.installPath)
  await setOptions(installed.id, plugin.root, choices.options, progress)
  const code = await setupInTerminal(plugin, { yes: choices.yes }, progress)
  if (code === 0) noteNextStep(plugin, progress)
  return code
}

export async function setOptions(id: string, root: string, given: readonly string[], progress: Progress): Promise<void> {
  if (given.length === 0) return
  const declared = await declaredOptions(root)
  const values = optionValues(given, declared.kind === 'declared' ? declared.userConfig : await manifestOptions(root), id)
  progress.step(`Setting the options of ${id}`)
  await configurePlugin(id, values)
  progress.succeed(`Set ${Object.keys(values).join(', ')} for ${id}`)
}

export async function manifestOptions(root: string): Promise<Record<string, unknown>> {
  const manifest = await readJson(`${root}/.claude-plugin/plugin.json`)
  return isObject(manifest) && isObject(manifest['userConfig']) ? manifest['userConfig'] : {}
}

export async function installCmodPlugin(progress: Progress): Promise<void> {
  const cmod = (await listPlugins()).find((plugin) => plugin.name === 'cmod')
  if (cmod?.scope === 'session') return
  const id = cmod?.id ?? 'cmod@cmod'
  progress.step('Installing the cmod plugin into Claude Code')
  if (cmod === undefined && !(await listMarketplaces()).some((marketplace) => marketplace.name === 'cmod')) {
    await addMarketplace('heyJordanParker/cmod').catch((error: unknown) => {
      throw new Error(`${messageOf(error)}\nLink the cmod checkout first: cmod link <checkout>`)
    })
  }
  await changePlugin('install', id)
  progress.succeed(`Installed ${id} into Claude Code`)
}

async function modIn(manifestPath: string, chosen: string | undefined, source: string): Promise<string> {
  const manifest = await readJson(manifestPath)
  const plugins = isObject(manifest) && Array.isArray(manifest['plugins']) ? manifest['plugins'].filter(isObject).map((plugin) => String(plugin['name'])) : []
  if (chosen !== undefined) {
    if (!plugins.includes(chosen)) throw new Error(`${source} lists no plugin named ${chosen}. It lists ${plugins.join(', ') || 'none'}.`)
    return chosen
  }
  const mods = plugins.filter((name) => name !== 'cmod')
  const candidates = mods.length > 0 ? mods : plugins
  if (candidates.length === 0) throw new Error(`${manifestPath} lists no plugin, so there is nothing to install.`)
  if (candidates.length > 1) {
    const shown = candidates.length > 10 ? [...candidates.slice(0, 10), `and ${candidates.length - 10} more`] : candidates
    throw new Error(`${source} lists several plugins: ${shown.join(', ')}. Name the one to install after it, such as cmod install ${source} ${candidates[0]}.`)
  }
  return candidates[0] as string
}
