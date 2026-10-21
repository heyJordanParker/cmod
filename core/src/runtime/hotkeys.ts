import type { Hotkey, Hotkeys } from '../hotkeys.js'
import { boundCombos, hotkeyCommand } from '../records.js'
import { ifMissing } from '../utils/paths.js'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import type { Router } from './router.js'
import type { Failure } from './toaster.js'

export async function readCombos(claude: Claude, configRoot: string | undefined): Promise<Map<string, string>> {
  if (configRoot === undefined) return new Map()
  const text = await claude.fs.read(`${configRoot}/keybindings.json`).catch(ifMissing('{}'))
  try {
    return boundCombos(JSON.parse(text))
  } catch (error) {
    claude.ui.log(`${configRoot}/keybindings.json is not JSON, so cmod reads no combos from it: ${messageOf(error)}`, { to: 'debug' })
    return new Map()
  }
}

export async function createHotkeys({
  name,
  declared,
  configRoot,
  claude,
  router,
  answerInput,
  report,
}: {
  readonly name: string
  readonly declared: Hotkeys
  readonly configRoot: string | undefined
  readonly claude: Claude
  readonly router: Router
  readonly answerInput: <Answer>(run: () => Promise<Answer>, passOn: () => Promise<unknown>) => Promise<Answer>
  readonly report: (failure: Failure) => void
}): Promise<Readonly<Record<string, Hotkey>>> {
  const entries = Object.entries(declared)
  if (entries.length === 0) return {}
  const combos = await readCombos(claude, configRoot)
  const listeners = new Map<string, Set<() => unknown>>()
  const commands = new Map<string, string>()
  for (const [hotkey, { title }] of entries) {
    listeners.set(hotkey, new Set())
    claude.command.register({ name: hotkeyCommand(name, hotkey), description: title, immediate: true }).then(
      ({ command }) => void commands.set(command, hotkey),
      (error: unknown) => report({ id: `hotkey:${hotkey}`, message: `The ${title} hotkey is not added`, error }),
    )
  }
  router.add('command.describe', async (e, next) => {
    const described = await next(e)
    return commands.has(e.command) ? { ...described, isHidden: true } : described
  })
  router.add('command.run', async (e, next) => {
    const hotkey = commands.get(e.command)
    if (hotkey === undefined) return next(e)
    return answerInput(async () => {
      for (const listener of listeners.get(hotkey) ?? []) {
        try {
          await listener()
        } catch (error) {
          report({ id: `hotkey:${hotkey}`, message: `The ${declared[hotkey]?.title ?? hotkey} hotkey failed`, error })
        }
      }
      return {}
    }, () => next(e))
  })
  return Object.fromEntries(
    entries.map(([hotkey, { title }]): [string, Hotkey] => [
      hotkey,
      {
        title,
        combo: combos.get(hotkeyCommand(name, hotkey)) as Hotkey['combo'],
        onPress(listener) {
          listeners.get(hotkey)?.add(listener)
          return { remove: () => void listeners.get(hotkey)?.delete(listener) }
        },
      },
    ]),
  )
}
