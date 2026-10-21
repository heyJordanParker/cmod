import type { RenderElement } from 'claude-code'
import { elementOf } from '../ui/elements.js'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import { partMethods, type DrawnPart, type PartPress } from './ui.js'

export type DrawnParts = {
  fill(mod: string, cached: string, input: Readonly<Record<string, unknown>>, name: string): Promise<void> | undefined
  element(mod: string, cached: string, keyPrefix: string, name: string, reportId: string): RenderElement | undefined
  forget(mod: string): void
}

type Drawn = { readonly data: DrawnPart | null; readonly generation: number }

const keptDrawings = 200

export function drawnParts({ claude, report, press }: { readonly claude: Claude; readonly report: (id: string, message: string, error: unknown) => void; readonly press: (mod: string, press: PartPress) => void }): DrawnParts {
  const drawn = new Map<string, Drawn>()
  const drawing = new Map<string, Promise<void>>()
  const generations = new Map<string, number>()
  const keyOf = (mod: string, cached: string) => `${mod}\u0000${cached}`
  const generationOf = (mod: string) => generations.get(mod) ?? 0

  return {
    fill(mod, cached, input, name) {
      const key = keyOf(mod, cached)
      const generation = generationOf(mod)
      if (drawn.get(key)?.generation === generation) return undefined
      const keep = (data: DrawnPart | null) => {
        drawn.delete(key)
        drawn.set(key, { data, generation })
        const [oldest] = drawn.keys()
        if (drawn.size > keptDrawings && oldest !== undefined) drawn.delete(oldest)
        if (generationOf(mod) !== generation) claude.ui.invalidate('ui.render')
      }
      const pending =
        drawing.get(key) ??
        claude.cmod
          .call({ to: mod, method: partMethods.draw, input })
          .then(
            (data) => keep((data ?? null) as DrawnPart | null),
            (error: unknown) => {
              claude.ui.log(`cmod: ${name} drew nothing: ${messageOf(error)}`, { to: 'debug' })
              keep(null)
            },
          )
          .finally(() => drawing.delete(key))
      drawing.set(key, pending)
      return pending
    },
    element(mod, cached, keyPrefix, name, reportId) {
      const key = keyOf(mod, cached)
      const entry = drawn.get(key)
      if (entry === undefined) return undefined
      drawn.delete(key)
      drawn.set(key, entry)
      const { data } = entry
      if (data === null || data.tree === null) return undefined
      try {
        return elementOf(data.tree, keyPrefix, (handler, args) => press(mod, { draw: data.draw, handler, args })) as RenderElement
      } catch (error) {
        report(reportId, `${name} could not draw`, error)
        return undefined
      }
    },
    forget(mod) {
      generations.set(mod, generationOf(mod) + 1)
    },
  }
}
