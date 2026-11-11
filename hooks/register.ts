import { notInstalled } from '../node_modules/@cmodjs/core/mod.js'
import { registerCmodPlugin, type AddHook, type PluginOptions } from '../node_modules/@cmodjs/core/register.js'
import { didNotAnswer } from '../node_modules/@cmodjs/core/runtime/dependencies.js'
import { cmodPlugin, isLoaded } from '../src/mod.js'
import type { Cmod } from '../types/index.js'

export function register(addHook: AddHook, options: PluginOptions): void {
  addHook('engine.create', async (_$, eventInput, passOn) => {
    const built = await passOn(eventInput)
    const cmod: Cmod = {
      async call(input) {
        throw new Error((await isLoaded(input.to)) ? didNotAnswer(input.to) : notInstalled(input.to))
      },
    }
    return { ...built, cmod }
  })
  registerCmodPlugin(addHook, cmodPlugin, options)
}
