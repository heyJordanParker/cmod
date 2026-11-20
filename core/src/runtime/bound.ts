import type { Imports } from '../mod.js'
import { listed } from '../utils/text.js'

let current: Imports | undefined

export function bind(imports: Imports): void {
  current = imports
}

export function bound(): Imports {
  if (current === undefined) throw new Error("A mod's imports work once its setup runs. Call them from setup or from a hook, never at the top of a module.")
  return current
}

export function importsOnly(granted: Partial<Imports>, holder: string): Imports {
  return new Proxy(granted as Imports, {
    get: (target, key) => {
      if (typeof key === 'string' && Object.hasOwn(target, key)) return target[key as keyof Imports]
      throw new Error(`${holder} imports only ${listed(Object.keys(granted))} from @cmodjs/core/mod.js, because ${String(key)} belongs to a Claude Code session.`)
    },
  })
}
