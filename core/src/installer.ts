import type { Frozen, RenderElement, RenderPropsOf } from 'claude-code'
import type { Mod } from './mod.js'

export type Step<State extends object = Record<never, never>> = {
  readonly id: string
  readonly title: string
  render(mod: Mod<State>, props: Frozen<RenderPropsOf['Pane']>): RenderElement
  isDone(mod: Mod<State>): boolean | Promise<boolean>
}

const stepId = /^[A-Za-z0-9_-]{1,64}$/

export function defineStep<State extends object = Record<never, never>>(step: Step<State>): Step<State> {
  if (!stepId.test(step.id)) throw new Error(`defineStep: "${step.id}" is not a step id. Use 1 to 64 letters, digits, "_", or "-".`)
  if (step.title.trim() === '') throw new Error(`defineStep: the step "${step.id}" needs a title, the line the installer shows above it.`)
  return step
}
