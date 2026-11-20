import { expect, test } from 'bun:test'
import type { Imports } from '../../src/mod.js'
import { importsOnly } from '../../src/runtime/bound.js'

test('an import a holder was not granted throws a refusal that lists every granted import', () => {
  const refusalOf = (names: readonly (keyof Imports)[]) => {
    const imports = importsOnly(Object.fromEntries(names.map((name) => [name, {}])), 'a script')
    try {
      return imports.fs
    } catch (error) {
      return (error as Error).message
    }
  }

  expect(refusalOf(['provide'])).toBe('a script imports only provide from @cmodjs/core/mod.js, because fs belongs to a Claude Code session.')
  expect(refusalOf(['provide', 'providers'])).toBe('a script imports only provide and providers from @cmodjs/core/mod.js, because fs belongs to a Claude Code session.')
  expect(refusalOf(['sessions', 'provide', 'providers'])).toBe('a script imports only sessions, provide and providers from @cmodjs/core/mod.js, because fs belongs to a Claude Code session.')
})
