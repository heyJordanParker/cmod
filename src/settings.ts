import type { ConfigRow, RenderElement } from 'claude-code'
import { AbovePrompt, BelowPrompt, clipboard, Dashboard, fs, longestMs, messageOf, process, TurnEnd, Working, type Area, type Mod, type Pane } from '../node_modules/@cmodjs/core/mod.js'
import { finishStepsMethod, hotkeyCommand, isObject, marketplaceOf, parsePreferences, pendingStepsMethod, preferencesPath, readRecord, readSteps, storeChangedPath, storeFolder, type Preferences } from '../node_modules/@cmodjs/core/records.js'
import { filledButton } from '../node_modules/@cmodjs/core/runtime/buttons.js'
import { engineOf } from '../node_modules/@cmodjs/core/runtime/engine.js'
import { readCombos } from '../node_modules/@cmodjs/core/runtime/hotkeys.js'
import { cmodError } from '../node_modules/@cmodjs/core/runtime/programs.js'
import { failedMethod, reportLink, reportPrompt, type LoggedFailure } from '../node_modules/@cmodjs/core/runtime/toaster.js'
import { builtInWidgets, moved, placedIn, toggled, type Move, type PlacedWidget, type Widgets } from '../node_modules/@cmodjs/core/runtime/widgets.js'
import { areas } from '../node_modules/@cmodjs/core/ui/areas.js'
import { Panel } from '../node_modules/@cmodjs/core/ui/components.js'
import { Box, Button, Input, Markdown, Text } from '../node_modules/@cmodjs/core/ui/elements.js'
import { changelogSections, unreleased, type ChangelogSection } from '../node_modules/@cmodjs/core/utils/changelog.js'
import { ifMissing } from '../node_modules/@cmodjs/core/utils/paths.js'
import { formatExit } from '../node_modules/@cmodjs/core/utils/text.js'
import type { SettingsView } from './sidebar.js'

export type SettingsState = {
  readonly memory: { removing: string | null; views: readonly ModView[]; log: readonly LogEntry[]; reporting: string | null; preferences: Preferences }
  readonly session: { selected: string | null; section: string; pageParams: unknown; notice: string | null; widget: string | null }
}

export const settingsMemory: SettingsState['memory'] = { removing: null, views: [], log: [], reporting: null, preferences: parsePreferences(undefined, 'preferences.json') }

export const settingsSession: SettingsState['session'] = { selected: null, section: 'options', pageParams: null, notice: null, widget: null }

const areaTitles: Readonly<Record<Area, string>> = {
  [AbovePrompt]: 'Above the prompt',
  [BelowPrompt]: 'Below the prompt',
  [Working]: 'While Claude works',
  [TurnEnd]: 'When a turn ends',
  [Dashboard]: 'On the Dashboard, in the Sidebar',
}

const moves: readonly { readonly move: Move; readonly hotkey: string; readonly label: string }[] = [
  { move: 'left', hotkey: 'h', label: '← left' },
  { move: 'down', hotkey: 'j', label: '↓ down' },
  { move: 'up', hotkey: 'k', label: '↑ up' },
  { move: 'right', hotkey: 'l', label: '→ right' },
]

type HotkeyView = { readonly name: string; readonly title: string; readonly combo: string | undefined }

export type ModView = {
  readonly name: string
  readonly version: string
  readonly description: string | undefined
  readonly isOn: boolean
  readonly hotkeys: readonly HotkeyView[]
  readonly options: readonly ConfigRow[]
  readonly pendingSteps: readonly string[]
  readonly changelog: readonly ChangelogSection[]
}

type LogEntry = Omit<LoggedFailure, 'isCritical' | 'root'>

const loggedFailures = 100

const preferenceTitles = {
  showsInstalledModErrors: 'Show errors from installed mods',
} satisfies Partial<Record<keyof Preferences, string>>

const pageSection = 'page:'

const selectedColor = 'userMessageBackground'

const statusColumns = 2

const rowPadding = 2

const panelColumns = 4

const detailMinColumns = 40

export async function storeOf(mod: object): Promise<string> {
  const { claude } = engineOf(mod)
  return storeFolder({ HOME: await claude.env.home(), XDG_DATA_HOME: await claude.env.dataHome() })
}

export async function setUpMods(mod: Mod<object>): Promise<string[]> {
  const records = await fs.list(`${await storeOf(mod)}/records`).catch(ifMissing([]))
  return records.filter((entry) => entry.name.endsWith('.json')).map((entry) => entry.name.slice(0, -'.json'.length)).filter((name) => name !== mod.name)
}

export async function configRootOf(mod: object): Promise<string | undefined> {
  const { claude } = engineOf(mod)
  const [configHome, home] = await Promise.all([claude.env.configHome(), claude.env.home()])
  return configHome ?? (home === undefined ? undefined : `${home}/.claude`)
}

export async function readJson(path: string): Promise<unknown> {
  const text = await fs.read(path).catch(ifMissing(undefined))
  return text === undefined ? undefined : JSON.parse(text)
}

const isText = (value: unknown) => typeof value === 'string'

const isLogEntry = (value: unknown): value is LogEntry => isObject(value) && ['mod', 'id', 'message', 'details', 'at'].every((key) => isText(value[key]))

const sameFailure = (left: LogEntry) => (right: LogEntry) => left.mod === right.mod && left.id === right.id

async function readEntries(path: string): Promise<LogEntry[]> {
  const value = await readJson(path).catch((error: unknown) => {
    throw new Error(`${path} is not JSON (${messageOf(error)}). Delete it, and cmod starts it again.`)
  })
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(isLogEntry)) throw new Error(`${path} is not a list of mod failures. Delete it, and cmod starts it again.`)
  return value
}

const logFolder = (mod: Mod<object>) => `${mod.dataFolder}/log`

export async function readLog(mod: Mod<object>): Promise<LogEntry[]> {
  const folder = logFolder(mod)
  const files = (await fs.list(folder).catch(ifMissing([]))).filter((file) => file.isFile && file.name.endsWith('.json')).toSorted((left, right) => right.modifiedAt - left.modifiedAt)
  const newest = new Map<string, LogEntry>()
  const newestFirst = () => [...newest.values()].toSorted((left, right) => right.at.localeCompare(left.at))
  for (const file of files) {
    const oldestKept = newestFirst()[loggedFailures - 1]
    if (oldestKept !== undefined && Date.parse(oldestKept.at) > file.modifiedAt) break
    const entries = await readEntries(`${folder}/${file.name}`).catch((error: unknown) => {
      mod.log(`the Log skips a file: ${messageOf(error)}`)
      return []
    })
    for (const entry of entries) {
      const key = `${entry.mod}\n${entry.id}`
      if ((newest.get(key)?.at ?? '') < entry.at) newest.set(key, entry)
    }
  }
  return newestFirst().slice(0, loggedFailures)
}

async function readPreferences(mod: Mod<object>): Promise<Preferences> {
  const path = preferencesPath(await storeOf(mod))
  return parsePreferences(await readJson(path), path)
}

export async function refreshPreferences<State extends SettingsState>(mod: Mod<State>): Promise<void> {
  mod.state.memory.preferences = await readPreferences(mod)
}

export function failureLog<State extends SettingsState>(mod: Mod<State>): (failure: LoggedFailure) => Promise<{ readonly showsToast: boolean }> {
  let writing: Promise<unknown> = Promise.resolve()
  const add = async (entry: LogEntry) => {
    const path = `${logFolder(mod)}/${await engineOf(mod).claude.session.id()}.json`
    const kept = [entry, ...(await readEntries(path)).filter((each) => !sameFailure(entry)(each))].slice(0, loggedFailures)
    await fs.write(path, `${JSON.stringify(kept, null, 2)}\n`)
    mod.state.memory.log = [entry, ...mod.state.memory.log.filter((each) => !sameFailure(entry)(each))].slice(0, loggedFailures)
  }
  return async (failure) => {
    if (!isLogEntry(failure) || !isText(failure.root) || typeof failure.isCritical !== 'boolean') throw new Error(`${failedMethod} takes the failure's mod, id, message, details, at, and root as text, and isCritical as true or false.`)
    const { mod: name, id, message, details, at, contact } = failure
    const added = writing.then(() => add({ mod: name, id, message, details, at, ...(contact === undefined ? {} : { contact }) }))
    writing = Promise.allSettled([added])
    await added
    return { showsToast: failure.isCritical || marketplaceOf(failure.root, failure.mod) === undefined || (await readPreferences(mod)).showsInstalledModErrors }
  }
}

async function writePreference(mod: Mod<object>, key: keyof Preferences, isOn: boolean): Promise<void> {
  const store = await storeOf(mod)
  const path = preferencesPath(store)
  const saved = await readJson(path)
  parsePreferences(saved, path)
  await fs.write(path, `${JSON.stringify({ ...(isObject(saved) ? saved : {}), [key]: isOn }, null, 2)}\n`)
  await fs.write(storeChangedPath(store), '')
}

function timeOf(at: string): string {
  const date = new Date(at)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

function widgetsLayout<State extends SettingsState>(current: Mod<State>, widgets: Widgets): RenderElement {
  const widgetFor = (key: string, area: Area): PlacedWidget => widgets.widgets().find((widget) => widget.key === key) ?? { key, mod: key.slice(0, key.indexOf('/')), title: key, areas: [area] }
  const chip = (key: string, area: Area) => {
    const widget = widgetFor(key, area)
    const isRunning = widgets.widgets().some((each) => each.key === key)
    const isHidden = widgets.layout().hidden.includes(widget.key)
    const isSelected = current.state.session.widget === widget.key
    const label = `${isSelected ? '▸ ' : ''}${widget.title}${widget.mod === 'claude' || widget.title === widget.key ? '' : ` (${widget.mod})`}${isRunning ? '' : ' (not running)'}${isHidden ? ' (hidden)' : ''}`
    return Button({ plain: true, key: `widget:${widget.key}`, label, ...(isHidden || !isRunning ? { dimColor: true } : {}), onPress: () => void (current.state.session.widget = widget.key) })
  }
  const layout = widgets.layout()
  const sections = areas.map((area) => {
    const rows = layout.areas[area].map((row, index) => Box({ key: `row:${area}:${index}`, columnGap: 2, flexWrap: 'wrap', children: [...row.left.map((key) => chip(key, area)), Text({ dimColor: true, children: '│' }), ...row.right.map((key) => chip(key, area))] }))
    const builtIns = area === BelowPrompt ? [Box({ columnGap: 2, flexWrap: 'wrap', children: builtInWidgets.map(({ key }) => chip(key, area)) })] : []
    return Box({ flexDirection: 'column', children: [Text({ bold: true, children: areaTitles[area] }), ...builtIns, ...(rows.length === 0 ? [Text({ dimColor: true, children: 'No widgets' })] : rows)] })
  })
  const selected = current.state.session.widget
  const area = selected === null ? undefined : placedIn(layout, selected)
  const isBuiltIn = builtInWidgets.some((widget) => widget.key === selected)
  const actions =
    selected === null || (area === undefined && !isBuiltIn)
      ? [Text({ dimColor: true, children: 'Pick a widget to move it, hide it, or show it.' })]
      : [
          Box({
            columnGap: 2,
            flexWrap: 'wrap',
            children: [
              ...(area === undefined ? [] : moves.map(({ move, hotkey, label }) => Button({ plain: true, key: `move:${move}`, hotkey, label, onPress: () => void widgets.change((now) => moved(now, widgetFor(selected, area), move)) }))),
              Button({ plain: true, key: 'hide', hotkey: 'x', label: layout.hidden.includes(selected) ? 'Show' : 'Hide', onPress: () => void widgets.change((now) => toggled(now, selected)) }),
            ],
          }),
        ]
  return Box({ flexDirection: 'column', gap: 1, children: [...sections, ...actions] })
}

export function settings<State extends SettingsState>(mod: Mod<State>) {
  return (pane: Pane, changed: () => void): SettingsView => {
    const { pages, widgets, claude } = engineOf(mod)
    if (pages === undefined || widgets === undefined) throw new Error('cmod draws no Settings, because the cmod plugin started without its pages and widgets.')

    const read = (path: string) => fs.read(path).catch(ifMissing(undefined))

    const viewOf = async (name: string, root: string, version: string, isOn: boolean, rows: readonly ConfigRow[], combos: ReadonlyMap<string, string>): Promise<ModView> => {
      const manifest: unknown = await read(`${root}/package.json`).then((text) => (text === undefined ? undefined : JSON.parse(text)))
      const plugin: unknown = await read(`${root}/.claude-plugin/plugin.json`).then((text) => (text === undefined ? undefined : JSON.parse(text)))
      const steps = isObject(manifest) ? readSteps(manifest) : undefined
      const ask = async (method: string): Promise<readonly string[]> => {
        if (name === mod.name) return []
        const answer = await claude.cmod.call({ to: name, method, input: null }).catch((error: unknown) => {
          mod.log(`${name} did not answer ${method}: ${messageOf(error)}`)
          return undefined
        })
        return Array.isArray(answer) ? (answer as string[]) : []
      }
      return {
        name,
        version,
        description: isObject(plugin) && typeof plugin['description'] === 'string' ? plugin['description'] : undefined,
        isOn,
        hotkeys: Object.entries(steps?.hotkeys ?? {}).map(([hotkey, { title }]) => ({ name: hotkey, title, combo: combos.get(hotkeyCommand(name, hotkey)) })),
        options: rows.filter((row) => row.key.startsWith(`${name}.`)),
        pendingSteps: await ask(pendingStepsMethod),
        changelog: changelogSections((await read(`${root}/CHANGELOG.md`)) ?? ''),
      }
    }

    const load = async (): Promise<readonly ModView[]> => {
      const store = await storeOf(mod)
      const rows = await claude.config.list()
      const combos = await readCombos(claude, await configRootOf(mod))
      const enabledPlugins = (await claude.settings.read())['enabledPlugins']
      const enabled = Object.entries(isObject(enabledPlugins) ? enabledPlugins : {}).map(([id, isEnabled]) => ({ name: id.replace(/@[^@]*$/, ''), isEnabled }))
      const turnedOff = enabled.filter(({ name, isEnabled }) => isEnabled === false && !enabled.some((each) => each.name === name && each.isEnabled === true)).map(({ name }) => name)
      const records = (await Promise.all((await setUpMods(mod)).map((name) => readRecord(read, store, name)))).filter((record) => record !== undefined)
      const own = JSON.parse((await read(`${mod.folder}/.claude-plugin/plugin.json`)) ?? '{}') as { readonly version?: string }
      const cmod = await viewOf(mod.name, mod.folder, own.version ?? '', true, [], combos)
      const views = await Promise.all(records.map((record) => viewOf(record.name, record.root, record.version, !turnedOff.includes(record.name), rows, combos)))
      return [cmod, ...views.sort((left, right) => left.name.localeCompare(right.name))]
    }

    let hasLoaded = false
    const refresh = async () => {
      hasLoaded = true
      const failed = (what: string) => (error: unknown) => void (mod.state.session.notice = `${what} did not load: ${messageOf(error)}`)
      await load().then((views) => void (mod.state.memory.views = views), failed('The mods'))
      await readLog(mod).then((log) => void (mod.state.memory.log = log), failed('The Log'))
      await readPreferences(mod).then((preferences) => void (mod.state.memory.preferences = preferences), failed('The preferences'))
    }

    const act = (task: () => Promise<string | undefined>) =>
      void task()
        .then((notice) => {
          mod.state.session.notice = notice ?? null
          return refresh()
        })
        .catch((error: unknown) => void (mod.state.session.notice = messageOf(error)))

    const runCmod = async (argv: readonly string[], done: string, timeoutMs?: number) => {
      const { exitCode, stdout, stderr } = await process.run(['cmod', ...argv], timeoutMs === undefined ? {} : { timeoutMs })
      return exitCode === 0 ? done || stdout.trim() : `cmod ${argv.slice(0, 2).join(' ')} ${formatExit(exitCode, cmodError(stderr, argv[0]))}`
    }

    const remove = (name: string) =>
      act(async () => {
        mod.state.memory.removing = null
        mod.state.session.notice = `Removing ${name}…`
        return runCmod(['remove', name], `Removed ${name}.`, longestMs)
      })

    const turn = (name: string, isOn: boolean) => act(() => runCmod([isOn ? 'enable' : 'disable', name], `Turned ${name} ${isOn ? 'on' : 'off'}.`))

    const setOption = (name: string, row: ConfigRow, text: string) => act(() => runCmod(['option', name, row.key.slice(name.length + 1), text.split(',').map((item) => item.trim()).join(',')], `Saved ${row.label}. ${name} reads it at its next start.`))

    const bind = (name: string, hotkey: HotkeyView, combo: string) => act(() => runCmod(['hotkey', name, hotkey.name, combo.trim()], `Bound ${combo.trim()} to ${hotkey.title}.`))

    const sectionsOf = (view: ModView) => {
      const own = pages.declared().find((each) => each.mod === view.name)?.pages.filter((page) => page.place === 'settings') ?? []
      return [
        ...own.map((page) => ({ key: `${pageSection}${page.id}`, label: page.title })),
        ...(view.name === mod.name ? [] : [{ key: 'options', label: 'Options' }]),
        { key: 'hotkeys', label: 'Hotkeys' },
        ...(view.name === mod.name
          ? [
              { key: 'widgets', label: 'Widgets' },
              { key: 'log', label: 'Log' },
              { key: 'preferences', label: 'Preferences' },
            ]
          : []),
        ...(view.changelog.length === 0 ? [] : [{ key: 'changelog', label: 'Changelog' }]),
      ]
    }

    const shownOf = () => {
      const { selected, section } = mod.state.session
      const view = mod.state.memory.views.find((each) => each.name === selected) ?? mod.state.memory.views[0]
      const sections = view === undefined ? [] : sectionsOf(view)
      return { view, section: sections.some(({ key }) => key === section) ? section : (sections[0]?.key ?? 'hotkeys') }
    }

    const failuresLog = (): RenderElement => {
      const { log, reporting } = mod.state.memory
      if (log.length === 0) return Text({ dimColor: true, children: 'No mod has failed.' })
      const copy = (entry: LogEntry) =>
        act(async () => {
          await clipboard.write(entry.details)
          return 'Copied the error.'
        })
      const askClaude = (entry: LogEntry) =>
        act(async () => {
          mod.state.memory.reporting = null
          await claude.prompt.submit({ text: reportPrompt(entry.mod, entry.contact, entry.details), asUser: true })
          return undefined
        })
      return Box({
        flexDirection: 'column',
        gap: 1,
        children: log.map((entry) => {
          const key = `${entry.mod}/${entry.id}`
          const choices =
            reporting === key
              ? [
                  Button({ plain: true, key: `ask-claude:${key}`, label: 'Ask Claude to report it', onPress: () => askClaude(entry) }),
                  ...(entry.contact === undefined ? [] : [reportLink(entry.contact, entry.mod, entry.message, entry.details)]),
                  Button({ plain: true, dimColor: true, key: `back:${key}`, label: 'Back', onPress: () => void (mod.state.memory.reporting = null) }),
                ]
              : [
                  Button({ plain: true, key: `copy:${key}`, label: 'Copy', onPress: () => copy(entry) }),
                  Button({ plain: true, key: `report:${key}`, label: 'Report', onPress: () => void (mod.state.memory.reporting = key) }),
                ]
          return Box({
            key: `log:${key}`,
            flexDirection: 'column',
            children: [
              Text({ wrap: 'truncate-end', children: [Text({ bold: true, children: entry.mod }), Text({ dimColor: true, children: ` · ${timeOf(entry.at)}` })] }),
              Text({ wrap: 'wrap', children: entry.message }),
              Box({ gap: 2, flexWrap: 'wrap', children: choices }),
            ],
          })
        }),
      })
    }

    const drawSection = (view: ModView, section: string, columns: number, isFocused: boolean): RenderElement => {
      if (section.startsWith(pageSection)) return pages.element(view.name, section.slice(pageSection.length), mod.state.session.pageParams, columns, isFocused) ?? Text({ dimColor: true, children: 'Drawing…' })
      if (section === 'widgets') return widgetsLayout(mod, widgets)
      if (section === 'log') return failuresLog()
      if (section === 'preferences') {
        return Box({
          flexDirection: 'column',
          children: Object.entries(preferenceTitles).map(([key, title]) => {
            const isOn = mod.state.memory.preferences[key as keyof Preferences]
            const turn = async () => {
              await writePreference(mod, key as keyof Preferences, !isOn)
              return undefined
            }
            return Button({ plain: true, key: `preference:${key}`, label: `${isOn ? '[x]' : '[ ]'} ${title}`, onPress: () => act(turn) })
          }),
        })
      }
      if (section === 'options') {
        if (view.options.length === 0) return Text({ dimColor: true, children: `${view.name} has no options.` })
        return Box({
          flexDirection: 'column',
          gap: 1,
          children: view.options.map((row) =>
            Box({
              flexDirection: 'column',
              children: [
                Text({ children: [Text({ bold: true, children: row.label }), row.isLocked ? Text({ dimColor: true, children: '  set by your organization' }) : ''] }),
                row.isLocked ? Text({ children: String(row.value) }) : Input({ key: `option:${row.key}`, label: 'Value', value: Array.isArray(row.value) ? row.value.join(', ') : String(row.value), submitLabel: 'save', onSubmit: (text: string) => setOption(view.name, row, text) }),
              ],
            }),
          ),
        })
      }
      if (section === 'hotkeys') {
        if (view.hotkeys.length === 0) return Text({ dimColor: true, children: `${view.name} has no hotkeys.` })
        return Box({
          flexDirection: 'column',
          gap: 1,
          children: view.hotkeys.map((hotkey) =>
            Box({
              flexDirection: 'column',
              children: [
                Text({ children: [Text({ bold: true, children: hotkey.title }), ...(hotkey.combo === undefined ? [Text({ dimColor: true, children: ' · unbound' })] : [])] }),
                Input({ key: `hotkey:${hotkey.name}`, label: 'Combo', value: hotkey.combo ?? '', placeholder: 'none', submitLabel: 'bind', onSubmit: (combo: string) => bind(view.name, hotkey, combo) }),
              ],
            }),
          ),
        })
      }
      return Box({
        flexDirection: 'column',
        gap: 1,
        children: view.changelog.map(({ version, date, text }) =>
          Box({
            key: `changelog:${version}`,
            flexDirection: 'column',
            children: [
              Text({ children: [Text({ bold: true, children: version }), Text({ dimColor: true, children: `${date === undefined ? '' : ` · ${date}`}${version === view.version ? ' · installed' : ''}` })] }),
              Markdown({ text: text === '' ? '_No changes listed._' : text }),
            ],
          }),
        ),
      })
    }

    return {
      draw(columns, isFocused) {
        if (!hasLoaded) void refresh()
        const { removing, views } = mod.state.memory
        const { notice } = mod.state.session
        const { view, section: shownSection } = shownOf()
        if (view === undefined) return Text({ dimColor: true, children: notice ?? 'Reading your mods…' })
        const sections = sectionsOf(view)
        const status = (each: ModView) => (!each.isOn ? Text({ dimColor: true, children: '○ ' }) : each.pendingSteps.length > 0 ? Text({ color: 'warning', children: '● ' }) : Text({ dimColor: true, children: '● ' }))
        const rowLabel = (each: ModView) => `${each.name}${each.isOn ? '' : ' (off)'}`
        const listColumns = Math.max(...views.map((each) => rowLabel(each).length)) + statusColumns + rowPadding + panelColumns
        const isWide = columns - listColumns - 1 >= detailMinColumns
        const mods = Panel({
          title: 'Mods',
          children: Box({
            flexDirection: 'column',
            children: views.map((each) =>
              each === view
                ? Box({ backgroundColor: selectedColor, paddingX: 1, children: Text({ wrap: 'truncate-end', children: [status(each), Text({ bold: true, children: rowLabel(each) })] }) })
                : Box({
                    paddingX: 1,
                    children: Button({
                      plain: true,
                      dimColor: true,
                      key: `mod:${each.name}`,
                      onPress: () => {
                        mod.state.session.selected = each.name
                        mod.state.session.pageParams = null
                        mod.state.memory.removing = null
                        changed()
                      },
                      children: [status(each), rowLabel(each)],
                    }),
                  }),
            ),
          }),
        })
        const actions =
          view.name === mod.name || removing === view.name
            ? []
            : [
                Box({
                  gap: 2,
                  flexShrink: 0,
                  children: [filledButton({ key: 'turn', label: view.isOn ? 'Turn off' : 'Turn on', onPress: () => turn(view.name, !view.isOn) }), filledButton({ key: 'remove', label: 'Remove', onPress: () => void (mod.state.memory.removing = view.name) })],
                }),
              ]
        const header = Box({
          flexDirection: 'column',
          children: [
            Box({ justifyContent: 'space-between', columnGap: 2, flexWrap: 'wrap', children: [Text({ dimColor: true, children: view.version }), ...actions] }),
            ...(view.description === undefined ? [] : [Text({ dimColor: true, wrap: 'wrap', children: view.description })]),
          ],
        })
        const removal =
          removing === view.name
            ? [
                Box({
                  flexDirection: 'column',
                  children: [
                    Text({ color: 'warning', wrap: 'wrap', children: `Remove ${view.name}? Its uninstall step runs, and Claude Code deletes it.` }),
                    Box({ gap: 2, flexShrink: 0, children: [filledButton({ key: 'keep', variant: 'primary', label: 'Keep', onPress: () => void (mod.state.memory.removing = null) }), filledButton({ key: 'remove-confirmed', label: 'Remove', onPress: () => remove(view.name) })] }),
                  ],
                }),
              ]
            : []
        const finishSetup = () =>
          act(async () => {
            const opened: unknown = await claude.cmod.call({ to: view.name, method: finishStepsMethod, input: null })
            if (isObject(opened)) pages.update(view.name, opened)
            return undefined
          })
        const attention = [
          ...(view.isOn ? [] : [Text({ color: 'warning', wrap: 'wrap', children: 'Off: Claude Code does not load it.' })]),
          ...(view.pendingSteps.length === 0 ? [] : [Box({ flexDirection: 'column', children: [Text({ color: 'warning', wrap: 'wrap', children: `Needs setup: ${view.pendingSteps.join(', ')}` }), filledButton({ key: 'finish', variant: 'primary', label: 'Finish setup', onPress: finishSetup })] })]),
        ]
        const row = Box({
          flexWrap: 'wrap',
          children: sections.map(({ key, label }) =>
            key === shownSection
              ? Text({ backgroundColor: selectedColor, bold: true, wrap: 'truncate-end', children: ` ${label} ` })
              : Box({
                  paddingX: 1,
                  flexShrink: 0,
                  children: Button({
                    plain: true,
                    dimColor: true,
                    key: `section:${key}`,
                    label,
                    onPress: () => {
                      mod.state.session.section = key
                      mod.state.session.pageParams = null
                      changed()
                    },
                  }),
                }),
          ),
        })
        const detailColumns = (isWide ? columns - listColumns - 1 : columns) - panelColumns
        const details = Panel({
          title: view.name,
          children: Box({
            flexDirection: 'column',
            gap: 1,
            children: [header, ...removal, ...attention, row, drawSection(view, shownSection, detailColumns, isFocused), ...(notice === null ? [] : [Text({ dimColor: true, wrap: 'wrap', children: notice })])],
          }),
        })
        return isWide ? Box({ flexGrow: 1, columnGap: 1, children: [Box({ width: listColumns, flexShrink: 0, children: mods }), details] }) : Box({ flexDirection: 'column', flexGrow: 1, gap: 1, children: [Box({ flexDirection: 'column', flexShrink: 0, children: mods }), details] })
      },
      shownPage() {
        const { view, section } = shownOf()
        return view !== undefined && section.startsWith(pageSection) ? { mod: view.name, page: section.slice(pageSection.length) } : undefined
      },
      closePage(name, page) {
        const view = mod.state.memory.views.find((each) => each.name === name)
        if (mod.state.session.selected !== name || mod.state.session.section !== `${pageSection}${page}` || view === undefined) return false
        mod.state.session.section = sectionsOf(view).find(({ key }) => !key.startsWith(pageSection))?.key ?? 'hotkeys'
        mod.state.session.pageParams = null
        return true
      },
      async show(name, section, params) {
        await refresh()
        const view = mod.state.memory.views.find((each) => each.name === name)
        if (view === undefined) throw new Error(`${name} is not a mod cmod set up.`)
        mod.state.session.selected = name
        mod.state.memory.removing = null
        mod.state.session.section = section ?? sectionsOf(view)[0]?.key ?? 'hotkeys'
        mod.state.session.pageParams = params ?? null
        if (section !== 'changelog') return
        const shown = view.changelog.some(({ version }) => version === view.version) ? view.version : unreleased
        await pane.scrollTo({ key: `changelog:${shown}` }, { block: 'start' })
      },
    }
  }
}
