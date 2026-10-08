import type { Args, Frozen, RenderElement, RenderPropsOf } from 'claude-code'
import type { Step } from '../installer.js'
import type { Mod } from '../mod.js'
import type { Option } from '../options.js'
import { permissionWords } from '../records.js'
import { Box, Button, drawWith, Input, Text } from '../ui/elements.js'
import { messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'

export const installerPaneId = 'cmod-installer'

export type Consent = {
  readonly install: string
  readonly uninstall: string
  readonly keys: string
  readonly permissions: readonly string[]
  readonly updates?: string | undefined
}

type Page = {
  draw(props: Frozen<RenderPropsOf['Pane']>): RenderElement
  cancel(): void
}

export type Installer = {
  draws(e: Frozen<Args<'ui.render'>>): boolean
  draw(e: Frozen<Args<'ui.render'>>): RenderElement
  closed(id: string): void
  consent(consent: Consent): Promise<boolean>
  options(missing: readonly (readonly [string, Option])[], save: (key: string, value: string) => Promise<string | undefined>): Promise<boolean>
  step<State extends object>(mod: Mod<State>, step: Step<State>, index: number, total: number): Promise<boolean>
  close(): Promise<void>
}

export function createInstaller(name: string, claude: () => Claude): Installer {
  let page: Page | undefined
  let isOpen = false

  const show = async <Answer>(build: (answer: (value: Answer) => void) => Omit<Page, 'cancel'>, cancelled: Answer): Promise<Answer> => {
    page?.cancel()
    const answer = new Promise<Answer>((resolve) => {
      const done = (value: Answer) => {
        if (page === shown) page = undefined
        resolve(value)
      }
      const shown: Page = { ...build(done), cancel: () => done(cancelled) }
      page = shown
    })
    if (!isOpen) {
      isOpen = true
      await claude().ui.open({ id: installerPaneId, title: `Install ${name}`, focus: true, holdToasts: true, closeOnEscape: true })
    }
    claude().ui.invalidate('ui.render')
    return answer
  }

  const frame = (title: string, body: readonly RenderElement[], actions: readonly RenderElement[]) =>
    Box({ flexDirection: 'column', gap: 1, paddingX: 1, children: [Text({ bold: true, children: title }), ...body, Box({ gap: 3, children: actions })] })

  const bullet = (text: string) => Text({ children: [Text({ color: 'claude', children: '◆ ' }), text] })

  return {
    draws: (e) => e.component === 'Pane' && e.requestId === installerPaneId,
    draw(e) {
      return drawWith(claude().ui.resolve(e), () => page?.draw(e.props as Frozen<RenderPropsOf['Pane']>) ?? Text({ dimColor: true, children: `${name} is installing.` }))
    },
    closed(id) {
      if (id !== installerPaneId) return
      isOpen = false
      page?.cancel()
    },
    consent({ install, uninstall, keys, permissions, updates }) {
      const changes = [
        ...(install === '' ? [] : [`Run ${install} now${uninstall === '' ? '' : `, and ${uninstall} when you remove it`}`]),
        ...(install === '' && uninstall !== '' ? [`Run ${uninstall} when you remove it`] : []),
        ...(keys === '' ? [] : [`Bind ${keys}`]),
        ...(updates === undefined ? [] : [`Update ${name} automatically from the ${updates} marketplace`]),
      ]
      return show<boolean>(
        (answer) => ({
          draw: () =>
            frame(
              `${name} wants to:`,
              [
                ...(permissions.length === 0 ? [] : [Box({ flexDirection: 'column', children: permissions.map((item) => bullet(permissionWords(item))) })]),
                ...(changes.length === 0 ? [] : [Text({ children: permissions.length === 0 ? 'Change your computer:' : 'and change your computer:' }), Box({ flexDirection: 'column', children: changes.map(bullet) })]),
                Text({ dimColor: true, children: 'You can turn each permission off later in /mods.' }),
              ],
              [Button({ key: 'not-now', hotkey: 'n', label: 'Not now', onPress: () => answer(false) }), Button({ key: 'accept', hotkey: 'a', label: 'Accept', onPress: () => answer(true) })],
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
            frame(
              `${name} needs ${missing.length === 1 ? 'one setting' : `${missing.length} settings`}:`,
              missing.map(([key, option]) => {
                const label = Text({ children: [Text({ bold: true, children: option.title }), option.description === '' ? '' : Text({ dimColor: true, children: `  ${option.description}` })] })
                if (option.kind === 'secret') return Box({ flexDirection: 'column', children: [label, Text({ dimColor: true, children: `Set it in /config, where Claude Code keeps it in your keychain, then press Next.` })] })
                const failure = failures.get(key)
                const field = Input({
                  key: `option:${key}`,
                  label: '› ',
                  placeholder: option.kind === 'choice' ? (option.choices ?? []).join(', ') : option.kind === 'toggle' ? 'true or false' : option.kind === 'list' ? 'comma-separated' : '',
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
                      .finally(() => claude().ui.invalidate('ui.render')),
                })
                const status = failure !== undefined ? Text({ color: 'error', children: failure }) : saved.has(key) ? Text({ color: 'success', children: '✔ saved' }) : Text({ children: '' })
                return Box({ flexDirection: 'column', children: [label, field, status] })
              }),
              [Button({ key: 'not-now', hotkey: 'n', label: 'Not now', onPress: () => answer(false) }), Button({ key: 'next', hotkey: 'x', label: 'Next', onPress: () => answer(true) })],
            ),
        }),
        false,
      )
    },
    step(mod, step, index, total) {
      let notice: string | undefined
      return show<boolean>(
        (answer) => ({
          draw: (props) => {
            let body: RenderElement
            try {
              body = step.render(mod, props)
            } catch (error) {
              body = Text({ color: 'error', children: `The ${step.title} step could not draw: ${messageOf(error)}` })
            }
            const next = async () => {
              const isDone = await Promise.resolve(step.isDone(mod)).catch(() => false)
              if (isDone) answer(true)
              else {
                notice = `Finish ${step.title} first.`
                claude().ui.invalidate('ui.render')
              }
            }
            return frame(
              `${step.title}  (${index} of ${total})`,
              [body, ...(notice === undefined ? [] : [Text({ color: 'warning', children: notice })])],
              [Button({ key: 'not-now', hotkey: 'n', label: 'Not now', onPress: () => answer(false) }), Button({ key: 'next', hotkey: 'x', label: index === total ? 'Finish' : 'Next', onPress: () => void next() })],
            )
          },
        }),
        false,
      )
    },
    async close() {
      page = undefined
      if (!isOpen) return
      isOpen = false
      await claude().ui.close({ id: installerPaneId })
    },
  }
}
