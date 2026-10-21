import { parseArgs } from 'node:util'
import { parse } from 'jsonc-parser'
import { isCombo } from '@cmodjs/core/src/hotkeys.js'
import { boundCombos, hotkeyCommand, readRecord, storeFolder, writeRecord } from '@cmodjs/core/src/records.js'
import { listPlugins } from '../claude.js'
import { readText, tilde, writeAtomically } from '../files.js'
import { readPlugin } from '../plugin.js'
import { bindKeys, keybindingsPath, unbindKeys } from '../settings.js'
import { modLock, takeLock } from '../store.js'

export const summary = "Bind one of a mod's hotkeys to another combo, as Settings does."

export const help = `Usage: cmod hotkey <name> <hotkey> <combo>

${summary}

Binds the hotkey <hotkey> of an installed mod to <combo> in Claude Code's
keybindings.json, such as cmod hotkey file-tree toggle ctrl+e, and takes its
old combo off. A combo is one or two of ctrl, alt, shift, and meta in that
order, then a key. A combo that already runs something else stays as it is,
and the command fails. The new combo works at once, and an update of the mod
keeps it.`

export async function run(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} })
  if (positionals.length !== 3) throw new Error(`cmod hotkey takes a mod, one of its hotkeys, and a combo.\n\n${help}`)
  const [name, hotkey, combo] = positionals as [string, string, string]
  if (!isCombo(combo)) throw new Error(`${combo} is not a combo. Give one or two of ctrl, alt, shift, meta in that order, then a key, such as ctrl+q or ctrl+shift+k.`)
  const lock = await takeLock(modLock(name))
  try {
    await rebind(name, hotkey, combo)
  } finally {
    await lock[Symbol.asyncDispose]()
  }
  return 0
}

async function rebind(name: string, hotkey: string, combo: string): Promise<void> {
  const store = storeFolder(process.env)
  const record = await readRecord(readText, store, name)
  const root = record?.root ?? (await listPlugins()).find((plugin) => plugin.name === name)?.installPath
  if (root === undefined) throw new Error(`No installed mod is named ${name}. cmod list shows the mods.`)
  const declared = (await readPlugin(root)).steps.hotkeys ?? {}
  const title = declared[hotkey]?.title
  if (title === undefined) throw new Error(`${name} has no hotkey ${hotkey}. Its hotkeys are: ${Object.keys(declared).join(', ') || 'none'}.`)
  const command = hotkeyCommand(name, hotkey)
  const current = boundCombos(parse((await readText(keybindingsPath())) ?? '{}')).get(command)
  const old: Record<string, string> = current === undefined ? {} : { [current]: command }
  await unbindKeys(old)
  const { bound, kept } = await bindKeys({ [combo]: command })
  if (kept.length > 0) {
    await bindKeys(old)
    throw new Error(`${combo} already runs something else in ${tilde(keybindingsPath())}. Pick another combo.`)
  }
  if (record !== undefined) {
    const others = Object.fromEntries(Object.entries(record.keys).filter(([, each]) => each !== command))
    await writeRecord(writeAtomically, store, { ...record, keys: { ...others, ...bound } })
  }
  process.stdout.write(`Bound ${combo} to ${title} for ${name}.\n`)
}
