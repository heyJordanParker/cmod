import type { RenderElement } from 'claude-code'
import type { Step } from '../installer.js'
import type { Mod } from '../mod.js'
import type { Option } from '../options.js'
import { isObject, permissionWords, secretFix } from '../records.js'
import { Box, elementData, Input, Text, type Handler } from '../ui/elements.js'
import { filledButton } from './buttons.js'
import type { PageProps } from '../ui/panes.js'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import { cmodPluginName, withBareRefusals } from './dependencies.js'
import { merged, partMethods, type DrawnPart, type PartPress, type PartsUpdate, type ShownPages } from './ui.js'

export const installPage = 'cmod:install'

export type Consent = {
  readonly install: string
  readonly uninstall: string
  readonly hotkeys: string
  readonly permissions: readonly string[]
  readonly updates?: string | undefined
}

type Question = {
  draw(props: PageProps<undefined>): RenderElement
  cancel(): void
}

export type Installer = {
  answer(method: string, input: unknown): Promise<{ readonly value: unknown }> | undefined
  hear(shown: ShownPages): void
  consent(consent: Consent): Promise<boolean>
  options(missing: readonly (readonly [string, Option])[], save: (key: string, value: string) => Promise<string | undefined>): Promise<boolean>
  step<State extends object>(mod: Mod<State>, step: Step<State>, index: number, total: number): Promise<boolean>
  close(): Promise<void>
  shown(): Promise<void>
  collect(run: () => Promise<unknown>): Promise<PartsUpdate>
}

const keptDraws = 8

export function createInstaller(name: string, claude: () => Claude, waiting: { show(open: () => Promise<void>): void; hide(): void }, nextDraw: () => number): Installer {
  let question: Question | undefined
  let isOpen = false
  let isSeen = false
  let waitingForShow: (() => void)[] = []
  let collected: PartsUpdate[] | undefined
  const draws = new Map<number, readonly Handler[]>()

  const send = async (update: PartsUpdate) => {
    if (collected !== undefined) return void collected.push(update)
    await withBareRefusals(claude()).cmod.call({ to: cmodPluginName, method: partMethods.changed, input: update })
  }

  const log = (what: string) => (error: unknown) => claude().ui.log(`${name}: ${what}: ${messageOf(error)}`, { to: 'debug' })

  const open = (isAsked: boolean) => send({ requests: [{ open: installPage, focus: true }], ...(isAsked ? { isAsked: true } : {}) })

  const show = async <Answer>(build: (answer: (value: Answer) => void) => Omit<Question, 'cancel'>, cancelled: Answer): Promise<Answer> => {
    question?.cancel()
    const answer = new Promise<Answer>((resolve) => {
      let isAnswered = false
      const done = (value: Answer) => {
        if (isAnswered) return
        isAnswered = true
        waiting.hide()
        claude().clock.after(0, () => resolve(value))
      }
      question = { ...build(done), cancel: () => done(cancelled) }
    })
    waiting.show(() => open(true))
    if (isOpen) {
      await send({ redraw: true }).catch(log('the installer did not redraw'))
    } else {
      isOpen = true
      await open(false).catch((error: unknown) => {
        isOpen = false
        waiting.hide()
        throw error
      })
    }
    for (const resolve of waitingForShow) resolve()
    waitingForShow = []
    return answer
  }

  const redraw = () => void send({ redraw: true }).catch(log('the installer did not redraw'))

  const actions = (...buttons: readonly RenderElement[]) => Box({ gap: 2, flexShrink: 0, children: buttons })

  const dialog = (title: RenderElement, ...children: readonly RenderElement[]) => Box({ flexDirection: 'column', gap: 1, children: [title, ...children] })

  const bullet = (text: string) => Box({ gap: 1, children: [Text({ dimColor: true, children: '•' }), Text({ wrap: 'wrap', children: text })] })

  const group = (heading: string, items: readonly string[]) => Box({ flexDirection: 'column', children: [Text({ bold: true, children: heading }), ...items.map(bullet)] })

  const draw = (columns: number, isFocused: boolean): DrawnPart => {
    if (question === undefined && !isOpen) claude().clock.after(0, () => void send({ requests: [{ close: installPage }] }).catch(log('a leftover install page stayed open')))
    const handlers: Handler[] = []
    const tree = elementData(question?.draw({ params: undefined, isFocused, columns }) ?? Text({ dimColor: true, children: `${name} needs nothing from you now.` }), handlers)
    const drawn = nextDraw()
    draws.set(drawn, handlers)
    for (const kept of draws.keys()) if (draws.size > keptDraws) draws.delete(kept)
    return { draw: drawn, tree }
  }

  const collect = async (run: () => unknown): Promise<PartsUpdate> => {
    const outer = collected
    const mine: PartsUpdate[] = []
    collected = mine
    try {
      await run()
    } finally {
      collected = outer
    }
    return merged(mine)
  }

  const press = async ({ draw: drawn, handler, args }: PartPress): Promise<PartsUpdate> => {
    const run = draws.get(drawn)?.[handler]
    if (run === undefined) throw new Error(`${name}: that button drew before the last redraw. Press the one it shows now.`)
    return collect(() => run(...args))
  }

  return {
    answer(method, input) {
      if (method === partMethods.draw && isObject(input) && input['page'] === installPage) return Promise.resolve({ value: draw(Number(input['columns']), input['isFocused'] === true) })
      if (method === partMethods.press && isObject(input) && typeof input['draw'] === 'number' && draws.has(input['draw'])) return press(input as PartPress).then((value) => ({ value }))
      return undefined
    },
    hear(shown) {
      if (shown.open.some((each) => each.id === installPage)) {
        isSeen = isOpen
        return
      }
      if (!isSeen) return
      isOpen = false
      isSeen = false
      question?.cancel()
    },
    consent({ install, uninstall, hotkeys, permissions, updates }) {
      const changes = [
        ...(install === '' ? [] : [`Run ${install} now${uninstall === '' ? '' : `, and ${uninstall} when you remove it`}`]),
        ...(install === '' && uninstall !== '' ? [`Run ${uninstall} when you remove it`] : []),
        ...(hotkeys === '' ? [] : [`Bind ${hotkeys}`]),
        ...(updates === undefined ? [] : [`Update ${name} automatically from the ${updates} marketplace`]),
      ]
      return show<boolean>(
        (answer) => ({
          draw: () =>
            dialog(
              Text({ bold: true, children: `Install ${name}?` }),
              ...(permissions.length === 0 ? [] : [group(`${name} wants to:`, permissions.map(permissionWords))]),
              ...(changes.length === 0 ? [] : [group(permissions.length === 0 ? `${name} wants to change your computer:` : 'and change your computer:', changes)]),
              Text({ dimColor: true, wrap: 'wrap', children: 'You can turn each permission off later in Settings.' }),
              actions(filledButton({ key: 'accept', hotkey: 'a', variant: 'primary', label: 'Accept', onPress: () => answer(true) }), filledButton({ key: 'not-now', hotkey: 'n', label: 'Not now', onPress: () => answer(false) })),
            ),
        }),
        false,
      )
    },
    options(missing, save) {
      const saved = new Map<string, string>()
      const failures = new Map<string, string>()
      return show<boolean>(
        (answer) => ({
          draw: () =>
            dialog(
              Text({ bold: true, children: `Set up ${name}` }),
              Text({ children: `${name} needs ${missing.length === 1 ? 'one setting' : `${missing.length} settings`}:` }),
              ...missing.map(([key, option]) => {
                  const label = Box({ flexDirection: 'column', children: [Text({ bold: true, children: option.title }), ...(option.description === '' ? [] : [Text({ dimColor: true, wrap: 'wrap', children: option.description })])] })
                  if (option.type === 'secret') {
                    return Box({ flexDirection: 'column', children: [label, Text({ dimColor: true, wrap: 'wrap', children: `${secretFix} Then press Next.` }), filledButton({ key: `secret:${key}`, label: 'Open /config', onPress: () => void claude().command.run({ command: 'config' }) })] })
                  }
                  const failure = failures.get(key)
                  const field = Input({
                    key: `option:${key}`,
                    label: 'Value',
                    placeholder: option.type === 'choice' ? (option.choices ?? []).join(', ') : option.type === 'toggle' ? 'true or false' : option.type === 'list' ? 'comma-separated' : '',
                    value: saved.get(key) ?? '',
                    submitLabel: 'save',
                    onSubmit: (value: string) =>
                      void save(key, value)
                        .then((refused) => {
                          if (refused === undefined) {
                            saved.set(key, value)
                            failures.delete(key)
                          } else failures.set(key, refused)
                        })
                        .catch((error: unknown) => failures.set(key, messageOf(error)))
                        .finally(redraw),
                  })
                  const status = failure !== undefined ? [Text({ color: 'error', wrap: 'wrap', children: failure })] : saved.has(key) ? [Text({ color: 'success', children: '✓ saved' })] : []
                return Box({ flexDirection: 'column', children: [label, field, ...status] })
              }),
              actions(filledButton({ key: 'next', hotkey: 'x', variant: 'primary', label: 'Next', onPress: () => answer(true) }), filledButton({ key: 'not-now', hotkey: 'n', label: 'Not now', onPress: () => answer(false) })),
            ),
        }),
        false,
      )
    },
    step(mod, step, index, total) {
      let notice: { readonly color: 'warning' | 'error'; readonly text: string } | undefined
      return show<boolean>(
        (answer) => ({
          draw: (props) => {
            let body: RenderElement
            try {
              body = step.render(mod, props)
            } catch (error) {
              body = Text({ color: 'error', wrap: 'wrap', children: `The ${step.title} step could not draw: ${messageOf(error)}` })
            }
            const next = async () => {
              try {
                if (await step.isDone(mod)) return answer(true)
                notice = { color: 'warning', text: `Finish ${step.title} first.` }
              } catch (error) {
                notice = { color: 'error', text: `The ${step.title} step's isDone failed: ${messageOf(error)}` }
              }
              await send({ redraw: true })
            }
            return dialog(
              Text({ children: [Text({ bold: true, children: step.title }), Text({ dimColor: true, children: `  (${index} of ${total})` })] }),
              body,
              ...(notice === undefined ? [] : [Text({ color: notice.color, wrap: 'wrap', children: notice.text })]),
              actions(filledButton({ key: 'next', hotkey: 'x', variant: 'primary', label: index === total ? 'Finish' : 'Next', onPress: () => void next() }), filledButton({ key: 'not-now', hotkey: 'n', label: 'Not now', onPress: () => answer(false) })),
            )
          },
        }),
        false,
      )
    },
    async close() {
      question?.cancel()
      question = undefined
      if (!isOpen) return
      isOpen = false
      isSeen = false
      await send({ requests: [{ close: installPage }] }).catch(log('the install page stayed open'))
    },
    shown: () => new Promise<void>((resolve) => void waitingForShow.push(resolve)),
    collect,
  }
}
