import { defineMod, longestMs, messageOf } from '../node_modules/cmod-sdk/mod.js'
import { parseEvent } from '../node_modules/cmod-sdk/records.js'

export type CmodPluginState = { installedPlugins: readonly string[] | null }

export const cmodPlugin = defineMod({
  name: 'cmod',
  state: { global: { installedPlugins: null } as CmodPluginState },

  setup(mod) {
    const tearDown = async (name: string) => {
      const { exitCode, stdout, stderr } = await mod.process.run(['cmod', 'teardown', name, '--events'], { timeoutMs: longestMs })
      const outcome = parseEvent(stdout.trim().split('\n').at(-1) ?? '')
      if (outcome.kind === 'done') mod.ui.toast(`${name} is uninstalled`)
      else if (exitCode !== 0) {
        const error = outcome.kind === 'failed' ? outcome.message : stderr.trim().split('\n').at(-1)
        mod.ui.toast(`cmod teardown ${name} exited ${exitCode}: ${error}`)
      }
    }

    const watchRemovals = async () => {
      const enabledPlugins = (await mod.settings.read({ source: 'user' }))['enabledPlugins'] as Record<string, unknown> | undefined
      const current = [...new Set(Object.keys(enabledPlugins ?? {}).map((key) => key.replace(/@[^@]*$/, '')))]
      const previous = mod.state.global.installedPlugins
      if (previous !== null && previous.length === current.length && previous.every((name) => current.includes(name))) return
      mod.state.global.installedPlugins = current
      for (const name of previous ?? []) {
        if (current.includes(name)) continue
        void tearDown(name).catch((error: unknown) => {
          mod.ui.toast(`cmod teardown ${name} did not run: ${messageOf(error)}`)
        })
      }
    }

    mod.on('SessionStart', watchRemovals)
    mod.on('UserPromptSubmit', watchRemovals)
  },
})
