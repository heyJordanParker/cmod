import type { Imports } from '../mod.js'

let current: Imports | undefined

export function bind(imports: Imports): void {
  current = imports
}

export function bound(): Imports {
  if (current === undefined) throw new Error("A mod's imports work once its setup runs. Call them from setup or from a hook, never at the top of a module.")
  return current
}
