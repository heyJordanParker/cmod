import type { On, PluginOptions } from 'claude-code'
import { notInstalled } from '../node_modules/@cmodjs/core/mod.js'
import { registerMod } from '../node_modules/@cmodjs/core/register.js'
import { cmodPlugin, isLoaded } from '../src/mod.js'
import type { Cmod } from '../types/index.js'

export function register(addHook: On, options: PluginOptions): void {
  addHook('engine.create', async (_$, eventInput, passOn) => {
    const built = await passOn(eventInput)
    const cmod: Cmod = {
      async call(input) {
        throw new Error((await isLoaded(input.to)) ? `${input.to} did not answer in time, so Claude Code went on without it.` : notInstalled(input.to))
      },
    }
    return { ...built, cmod }
  })
  registerMod(addHook, cmodPlugin, options)
}
