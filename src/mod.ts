import { defineMod, longestMs, messageOf } from '../node_modules/cmod-sdk/mod.js'
import { parseEvent } from '../node_modules/cmod-sdk/records.js'

export type CmodPluginState = { installedPlugins: readonly string[] | null }

export const cmodPlugin = defineMod({
  name: 'cmod',
  state: { global: { installedPlugins: null } as CmodPluginState },

  setup(mod) {
    const triedRemovals = new Set<string>()

    const tearDown = async (name: string) => {
      const { exitCode, stdout, stderr } = await mod.process.run(['cmod', 'teardown', name, '--events'], { timeoutMs: longestMs })
      const outcome = parseEvent(stdout.trim().split('\n').at(-1) ?? '')
      const isAnswered = outcome.kind === 'done' || outcome.kind === 'missing' || outcome.kind === 'failed'
      if (isAnswered) mod.state.global.installedPlugins = (mod.state.global.installedPlugins ?? []).filter((installed) => installed !== name)
      if (outcome.kind === 'done') mod.ui.toast(`${name} is uninstalled. A session that still runs it stops after /reload-plugins.`)
      else if (outcome.kind === 'failed') mod.ui.toast(outcome.message)
      else if (exitCode !== 0) mod.ui.toast(`cmod teardown ${name} exited ${exitCode}: ${stderr.trim().split('\n').at(-1)}`)
    }

    const watchRemovals = async () => {
      const enabledPlugins = (await mod.settings.read({ source: 'user' }))['enabledPlugins'] as Record<string, unknown> | undefined
      const current = [...new Set(Object.keys(enabledPlugins ?? {}).map((key) => key.replace(/@[^@]*$/, '')))]
      const previous = mod.state.global.installedPlugins
      const removed = (previous ?? []).filter((name) => !current.includes(name))
      const installed = [...current, ...removed]
      if (previous === null || previous.length !== installed.length || !installed.every((name) => previous.includes(name))) mod.state.global.installedPlugins = installed
      for (const name of removed) {
        if (triedRemovals.has(name)) continue
        triedRemovals.add(name)
        void tearDown(name).catch((error: unknown) => {
          mod.ui.toast(`cmod teardown ${name} did not run: ${messageOf(error)}`)
        })
      }
    }

    mod.on('SessionStart', watchRemovals)
    mod.on('UserPromptSubmit', watchRemovals)
  },
})
