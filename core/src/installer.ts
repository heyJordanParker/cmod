import type { Frozen, RenderElement, RenderPropsOf } from 'claude-code'
import type { Mod } from './mod.js'

export type Step<State extends object = Record<never, never>> = {
  readonly id: string
  readonly title: string
  render(mod: Mod<State>, props: Frozen<RenderPropsOf['Pane']>): RenderElement
  isDone(mod: Mod<State>): boolean | Promise<boolean>
}

const stepId = /^[A-Za-z0-9_-]{1,64}$/

export function checkSteps(name: string, steps: readonly Step<never>[]): void {
  const seen = new Set<string>()
  for (const step of steps) {
    if (!stepId.test(step.id)) throw new Error(`${name}: the install step "${step.id}" has no valid id. Use 1 to 64 letters, digits, "_", or "-".`)
    if (step.title.trim() === '') throw new Error(`${name}: the install step "${step.id}" needs a title, the line the installer shows above it.`)
    if (seen.has(step.id)) throw new Error(`${name}: two install steps have the id "${step.id}". Give each step its own id.`)
    seen.add(step.id)
  }
}
