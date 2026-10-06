import type { On } from 'claude-code'
import { notInstalled } from '../node_modules/@cmodjs/core/mod.js'
import { registerMod } from '../node_modules/@cmodjs/core/register.js'
import { cmodPlugin } from '../src/mod.js'
import type { Cmod } from '../types/index.js'

export function register(addHook: On): void {
  addHook('engine.create', async (_$, eventInput, passOn) => {
    const built = await passOn(eventInput)
    const cmod: Cmod = {
      async call(input) {
        return { deny: notInstalled(input.to) }
      },
    }
    return { ...built, cmod }
  })
  registerMod(addHook, cmodPlugin)
}
