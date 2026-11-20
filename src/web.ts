import type { Program } from '../node_modules/@cmodjs/core/jobs/program.js'
import type { Mod } from '../node_modules/@cmodjs/core/mod.js'
import { engineOf } from '../node_modules/@cmodjs/core/runtime/engine.js'
import { cmodError } from '../node_modules/@cmodjs/core/runtime/programs.js'
import { Button } from '../node_modules/@cmodjs/core/ui/elements.js'
import { formatExit } from '../node_modules/@cmodjs/core/utils/text.js'
import { refreshPreferences, writePreference, type SettingsState } from './settings.js'

export function webUi<State extends SettingsState>(mod: Mod<State>, server: Program) {
  const { claude, report } = engineOf(mod)

  const openInBrowser = async () => {
    try {
      await refreshPreferences(mod)
      if (!mod.state.memory.preferences.servesWebUi) {
        await writePreference(mod, 'servesWebUi', true)
        await refreshPreferences(mod)
      }
      await server.ready()
      const { exitCode, stdout, stderr } = await claude.process.run(['cmod', 'web'])
      const home = stdout.trim().split('\n')[0] ?? ''
      const address = Button({ plain: true, key: 'web:address', href: home, label: home })
      if (exitCode === 0) mod.toast.success('The browser app is open', { description: address })
      else if (home !== '') mod.toast.info('Open this address in your browser', { description: address, duration: Number.POSITIVE_INFINITY })
      else report({ id: 'web:open', message: 'Could not open the browser app', description: `cmod web ${formatExit(exitCode, cmodError(stderr, 'web'))}`, isCritical: true })
    } catch (error) {
      report({ id: 'web:open', message: 'Could not open the browser app', error, isCritical: true })
    }
  }

  return {
    openInBrowser: () => new Promise<void>((resolve) => void claude.clock.after(0, () => void openInBrowser().then(resolve))),
  }
}
