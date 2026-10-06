import type { Register } from 'claude-code'
import { connect } from '../node_modules/@cmodjs/core/connect.js'
import { notInstalled } from '../node_modules/@cmodjs/core/mod.js'
import { cmodPlugin } from '../src/mod.js'
import type { Cmod } from '../types/index.js'

export const register: Register = (on) => {
  on('engine.create', async (_$, e, next) => {
    const built = await next(e)
    const cmod: Cmod = {
      async call(input) {
        return { deny: notInstalled(input.to) }
      },
    }
    return { ...built, cmod }
  })
  connect(on, cmodPlugin)
}
