import { AbovePrompt, BelowPrompt, clipboard, Dashboard, fs, longestMs, messageOf, process, TurnEnd, Working, type Area, type ConfigRow, type Mod, type Pane, type Surface } from '../node_modules/@cmodjs/core/mod.js'
import { finishStepsMethod, hotkeyCommand, isLogEntry, isObject, logFolder, loggedFailures, logReport, marketplaceOf, newestLog, parseLog, parsePreferences, parseTailnetRecord, pendingStepsMethod, preferencesPath, readRecord, readSteps, serviceFolder, storeChangedPath, tailnetFolder, versionsLine, type LogEntry, type LogLevel, type LogVersions, type Preferences } from '../node_modules/@cmodjs/core/records.js'
import { filledButton } from '../node_modules/@cmodjs/core/runtime/buttons.js'
import { isStillInstalling } from '../node_modules/@cmodjs/core/runtime/dependencies.js'
import { engineOf } from '../node_modules/@cmodjs/core/runtime/engine.js'
import { readCombos } from '../node_modules/@cmodjs/core/runtime/hotkeys.js'
import { cmodError, cmodStore, newestCmodVersion } from '../node_modules/@cmodjs/core/runtime/programs.js'
import { failedMethod, reportLink, reportPrompt, type LoggedFailure } from '../node_modules/@cmodjs/core/runtime/toaster.js'
import { builtInWidgets, moved, placedIn, toggled, type Move, type PlacedWidget, type Widgets } from '../node_modules/@cmodjs/core/runtime/widgets.js'
import { areas } from '../node_modules/@cmodjs/core/ui/areas.js'
import { Badge, Banner, List, ListItem, Panel, Toggle } from '../node_modules/@cmodjs/core/ui/components.js'
import { Box, Button, Input, Markdown, Text } from '../node_modules/@cmodjs/core/ui/elements.js'
import { changelogSections, unreleased, type ChangelogSection } from '../node_modules/@cmodjs/core/utils/changelog.js'
import { ifMissing, relativePath } from '../node_modules/@cmodjs/core/utils/paths.js'
import { formatExit } from '../node_modules/@cmodjs/core/utils/text.js'
import type { SettingsView } from './sidebar.js'

export type SettingsState = {
  readonly memory: { removing: string | null; views: readonly ModView[]; log: readonly LogEntry[]; reporting: string | null; preferences: Preferences }
  readonly session: { selected: string | null; viewParams: unknown; notice: string | null; widget: string | null }
}

export const settingsMemory: SettingsState['memory'] = { removing: null, views: [], log: [], reporting: null, preferences: parsePreferences(undefined, 'preferences.json') }

export const settingsSession: SettingsState['session'] = { selected: null, viewParams: null, notice: null, widget: null }

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
  readonly isService: boolean
  readonly webApps: readonly WebAppView[]
}

type WebAppView = { readonly name: string; readonly url: string | null; readonly reason: string | null }

const preferenceTitles = {
  showsInstalledModErrors: 'Show errors from installed mods',
  servesWebUi: 'Show the Sidebar in your browser',
  servesTailnet: 'Open web apps from your other devices, through Tailscale',
} satisfies Partial<Record<keyof Preferences, string>>

const viewSection = 'view:'

const panelColumns = 4

const shownVersions = 5

export function storeOf(mod: object): Promise<string> {
  return cmodStore(engineOf(mod).claude)
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

const sameFailure = (left: Pick<LogEntry, 'mod' | 'id'>) => (right: LogEntry) => left.mod === right.mod && left.id === right.id

async function readEntries(path: string): Promise<LogEntry[]> {
  const value = await readJson(path).catch((error: unknown) => {
    throw new Error(`${path} is not JSON (${messageOf(error)}). Delete it, and cmod starts it again.`)
  })
  return parseLog(value, path)
}

export async function readLog(mod: Mod<object>): Promise<LogEntry[]> {
  const folder = logFolder(await storeOf(mod))
  const files = (await fs.list(folder).catch(ifMissing([]))).filter((file) => file.isFile && file.name.endsWith('.json')).toSorted((left, right) => right.modifiedAt - left.modifiedAt)
  const read: LogEntry[] = []
  for (const file of files) {
    const oldestKept = newestLog(read)[loggedFailures - 1]
    if (oldestKept !== undefined && Date.parse(oldestKept.at) > file.modifiedAt) break
    const entries = await readEntries(`${folder}/${file.name}`).catch((error: unknown) => {
      engineOf(mod).claude.ui.warn('log:read', `cmod: the Log skips a file: ${messageOf(error)}`)
      return []
    })
    read.push(...entries)
  }
  return newestLog(read)
}

async function readPreferences(mod: Mod<object>): Promise<Preferences> {
  const path = preferencesPath(await storeOf(mod))
  return parsePreferences(await readJson(path), path)
}

export async function refreshPreferences<State extends SettingsState>(mod: Mod<State>): Promise<void> {
  mod.state.memory.preferences = await readPreferences(mod)
}

export function failureLog<State extends SettingsState>(mod: Mod<State>): (failure: LoggedFailure) => Promise<{ readonly showsToast: boolean }> {
  const { claude } = engineOf(mod)
  let writing: Promise<unknown> = Promise.resolve()
  const cmodVersion = fs
    .read(`${claude.plugin.root}/.claude-plugin/plugin.json`)
    .then((text) => String((JSON.parse(text) as { readonly version?: unknown }).version))
    .catch((error: unknown) => `unknown (${messageOf(error)})`)
  const versionsOf = async (failure: LoggedFailure): Promise<LogVersions> => {
    const program = await newestCmodVersion(claude).catch((error: unknown) => `unknown (${messageOf(error)})`)
    const claudeCode = await claude.session.version().catch((error: unknown) => `unknown (${messageOf(error)})`)
    return { ...(failure.version === undefined ? {} : { mod: failure.version }), ...(failure.core === undefined ? {} : { core: failure.core }), cmod: await cmodVersion, ...(program === undefined ? {} : { program }), claudeCode }
  }
  const add = async (entry: Omit<LogEntry, 'count' | 'firstAt'>) => {
    const path = `${logFolder(await storeOf(mod))}/${entry.session}.json`
    const earlier = await readEntries(path)
    const same = earlier.find(sameFailure(entry))
    const counted: LogEntry = { ...entry, count: (same?.count ?? 0) + 1, firstAt: same?.firstAt ?? same?.at ?? entry.at }
    const kept = [counted, ...earlier.filter((each) => !sameFailure(entry)(each))].slice(0, loggedFailures)
    await fs.write(path, `${JSON.stringify(kept, null, 2)}\n`)
    mod.state.memory.log = [counted, ...mod.state.memory.log.filter((each) => !sameFailure(entry)(each))].slice(0, loggedFailures)
  }
  return async (failure) => {
    if (!isLogEntry(failure) || !isText(failure.root) || typeof failure.isCritical !== 'boolean') throw new Error(`${failedMethod} takes the failure's mod, id, message, details, at, and root as text, and isCritical as true or false.`)
    const { mod: name, id, message, details, at, contact } = failure
    const level: LogLevel = failure.level === 'warning' ? 'warning' : 'error'
    const [session, versions] = await Promise.all([claude.session.id(), versionsOf(failure)])
    const added = writing.then(() => add({ mod: name, id, level, message, details, at, session, versions, ...(contact === undefined ? {} : { contact }) }))
    writing = Promise.allSettled([added])
    await added
    if (level === 'warning') return { showsToast: false }
    if (failure.isCritical) return { showsToast: true }
    if (marketplaceOf(failure.root, failure.mod) === undefined) return { showsToast: await isInside(mod, failure.root) }
    return { showsToast: (await readPreferences(mod)).showsInstalledModErrors }
  }
}

export async function isInside(mod: object, folder: string): Promise<boolean> {
  const { claude } = engineOf(mod)
  const real = async (path: string) => (await claude.fs.stat(path, { resolve: true }).catch(ifMissing(undefined)))?.realPath ?? path
  return relativePath(await real(folder), await real(await claude.session.root())) !== undefined
}

export async function writePreference(mod: Mod<object>, key: keyof Preferences, isOn: boolean): Promise<void> {
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

function widgetsLayout<State extends SettingsState>(current: Mod<State>, widgets: Widgets): JSX.Element {
  const widgetFor = (key: string, area: Area): PlacedWidget => widgets.widgets().find((widget) => widget.key === key) ?? { key, mod: key.slice(0, key.indexOf('/')), title: key, areas: [area] }
  const layout = widgets.layout()
  const selected = current.state.session.widget
  const item = (key: string, area: Area) => {
    const widget = widgetFor(key, area)
    const isRunning = widgets.widgets().some((each) => each.key === key)
    const isHidden = layout.hidden.includes(widget.key)
    const notes = [widget.mod === 'claude' || widget.title === widget.key ? undefined : widget.mod, isRunning ? undefined : 'not running', isHidden ? 'hidden' : undefined].filter((note) => note !== undefined)
    return ListItem({ key: `widget:${widget.key}`, label: widget.title, ...(notes.length === 0 ? {} : { description: notes.join(' · ') }), ...(isHidden || !isRunning ? { tone: 'off' as const } : {}), isSelected: selected === widget.key, onPress: () => void (current.state.session.widget = widget.key) })
  }
  const groups = areas.map((area) => {
    const keys = [...(area === BelowPrompt ? builtInWidgets.map(({ key }) => key) : []), ...layout.areas[area].flatMap((row) => [...row.left, ...row.right])]
    return Box({ key: `area:${area}`, flexDirection: 'column', children: [Text({ dimColor: true, children: areaTitles[area] }), keys.length === 0 ? Text({ dimColor: true, children: 'No widgets' }) : List({ label: areaTitles[area], children: keys.map((key) => item(key, area)) })] })
  })
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
  return Box({ flexDirection: 'column', gap: 1, children: [...groups, ...actions] })
}

export function settings<State extends SettingsState>(mod: Mod<State>) {
  return (pane: Pane, changed: () => void): SettingsView => {
    const { parts, widgets, claude } = engineOf(mod)
    if (parts === undefined || widgets === undefined) throw new Error('cmod draws no Settings, because the cmod plugin started without its pages and widgets.')

    const read = (path: string) => fs.read(path).catch(ifMissing(undefined))

    const viewOf = async (store: string, name: string, root: string | undefined, version: string, isOn: boolean, rows: readonly ConfigRow[], combos: ReadonlyMap<string, string>): Promise<ModView> => {
      const readIn = async (file: string) => (root === undefined ? undefined : read(`${root}/${file}`))
      const manifest: unknown = await readIn('package.json').then((text) => (text === undefined ? undefined : JSON.parse(text)))
      const plugin: unknown = await readIn('.claude-plugin/plugin.json').then((text) => (text === undefined ? undefined : JSON.parse(text)))
      const steps = isObject(manifest) ? readSteps(manifest) : undefined
      const ask = async (method: string): Promise<readonly string[]> => {
        if (name === mod.name) return []
        const answer = await claude.cmod.call({ to: name, method, input: null }).catch((error: unknown) => {
          if (!isStillInstalling(name, error)) claude.ui.warn(`settings:${name}:${method}`, `cmod: ${name} did not answer ${method}: ${messageOf(error)}`)
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
        changelog: changelogSections((await readIn('CHANGELOG.md')) ?? ''),
        isService: (await fs.list(serviceFolder(store, name)).catch(ifMissing([]))).some((entry) => entry.name.endsWith('.json')),
        webApps: await webAppsOf(store, name),
      }
    }

    const webAppsOf = async (store: string, name: string): Promise<WebAppView[]> => {
      const folder = tailnetFolder(store, name)
      const files = (await fs.list(folder).catch(ifMissing([]))).filter((entry) => entry.name.endsWith('.json'))
      const views = await Promise.all(files.map(async (file) => ({ name: file.name.slice(0, -'.json'.length), record: parseTailnetRecord(await readJson(`${folder}/${file.name}`), `${folder}/${file.name}`) })))
      return views.flatMap(({ name: program, record }) => (record === undefined ? [] : [{ name: program, url: record.url, reason: record.reason }]))
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
      const cmod = await viewOf(store, mod.name, mod.folder, own.version ?? '', true, [], combos)
      const told = parts.declared().filter((each) => each.mod !== mod.name && !records.some((record) => record.name === each.mod))
      const loaded = [...records, ...told.map((each) => ({ name: each.mod, root: undefined, version: '' }))]
      const views = await Promise.all(loaded.map(({ name, root, version }) => viewOf(store, name, root, version, !turnedOff.includes(name), rows, combos)))
      return [cmod, ...views.sort((left, right) => left.name.localeCompare(right.name))]
    }

    const refresh = async () => {
      const failed = (what: string) => (error: unknown) => void (mod.state.session.notice = `${what} did not load: ${messageOf(error)}`)
      await load().then((views) => void (mod.state.memory.views = views), failed('The mods'))
      await readLog(mod).then((log) => void (mod.state.memory.log = log), failed('The Log'))
      await readPreferences(mod).then((preferences) => void (mod.state.memory.preferences = preferences), failed('The preferences'))
    }

    void refresh()

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

    const setOption = (name: string, row: ConfigRow, text: string) => act(() => runCmod(['options', 'set', name, row.key.slice(name.length + 1), text.split(',').map((item) => item.trim()).join(',')], `Saved ${row.label}. ${name} reads it at its next start.`))

    const bind = (name: string, hotkey: HotkeyView, combo: string) => act(() => runCmod(['hotkeys', 'set', name, hotkey.name, combo.trim()], `Bound ${combo.trim()} to ${hotkey.title}.`))

    const settingsViewsOf = (view: ModView) => parts.declared().find((each) => each.mod === view.name)?.views.filter((settingsView) => settingsView.place === 'settings') ?? []

    const selectedView = () => mod.state.memory.views.find((each) => each.name === mod.state.session.selected)

    const select = (name: string | null) => {
      mod.state.session.selected = name
      mod.state.session.viewParams = null
      mod.state.memory.removing = null
      changed()
    }

    const failuresLog = (): JSX.Element => {
      const { log, reporting } = mod.state.memory
      if (log.length === 0) return Text({ dimColor: true, children: 'No mod has failed.' })
      const copy = (entry: LogEntry) =>
        act(async () => {
          await clipboard.write(logReport(entry))
          return 'Copied the error.'
        })
      const askClaude = (entry: LogEntry) =>
        act(async () => {
          mod.state.memory.reporting = null
          await claude.prompt.submit({ text: reportPrompt(entry.mod, entry.contact, logReport(entry)), asUser: true })
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
                  ...(entry.contact === undefined ? [] : [reportLink(`report-link:${key}`, entry.contact, entry.mod, entry.message, logReport(entry))]),
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
              Text({
                wrap: 'truncate-end',
                children: [
                  Text({ bold: true, children: entry.mod }),
                  ...(entry.level === 'warning' ? [' ', Badge({ tone: 'warning', children: 'warning' })] : []),
                  Text({ dimColor: true, children: ` · ${timeOf(entry.at)}${(entry.count ?? 1) > 1 ? ` · ${entry.count} times since ${timeOf(entry.firstAt ?? entry.at)}` : ''}` }),
                ],
              }),
              Text({ wrap: 'wrap', children: entry.message }),
              ...(entry.versions === undefined ? [] : [Text({ dimColor: true, wrap: 'truncate-end', children: versionsLine(entry.versions) })]),
              Box({ gap: 2, flexWrap: 'wrap', children: choices }),
            ],
          })
        }),
      })
    }

    const section = (key: string, title: string, children: JSX.Children) => Box({ key: `section:${key}`, flexDirection: 'column', children: Panel({ title, children }) })

    const preferences = () =>
      Object.entries(preferenceTitles).map(([key, title]) => {
        const isOn = mod.state.memory.preferences[key as keyof Preferences]
        const turn = async () => {
          await writePreference(mod, key as keyof Preferences, !isOn)
          return undefined
        }
        return Toggle({ label: title, checked: isOn, onChange: () => act(turn) })
      })

    const optionRows = (view: ModView) =>
      view.options.map((row) =>
        row.isLocked
          ? ListItem({ key: `option:${row.key}`, label: row.label, description: `${String(row.value)} · set by your organization` })
          : Input({ key: `option:${row.key}`, label: row.label, value: Array.isArray(row.value) ? row.value.join(', ') : String(row.value), submitLabel: 'save', onSubmit: (text: string) => setOption(view.name, row, text) }),
      )

    const hotkeyRows = (view: ModView) => view.hotkeys.map((hotkey) => Input({ key: `hotkey:${hotkey.name}`, label: hotkey.title, value: hotkey.combo ?? '', placeholder: 'Unbound', submitLabel: 'bind', onSubmit: (combo: string) => bind(view.name, hotkey, combo) }))

    const changes = (view: ModView) => {
      const installed = view.changelog.findIndex(({ version }) => version === view.version)
      const shown = view.changelog.filter((_, index) => index < shownVersions || index === installed)
      return shown.map(({ version, date, text }) =>
        Box({
          key: `changelog:${version}`,
          flexDirection: 'column',
          children: [Text({ children: [Text({ bold: true, children: version }), Text({ dimColor: true, children: `${date === undefined ? '' : ` · ${date}`}${version === view.version ? ' · installed' : ''}` })] }), Markdown({ text: text === '' ? '_No changes listed._' : text })],
        }),
      )
    }

    const finishSetup = (view: ModView) =>
      act(async () => {
        const opened: unknown = await claude.cmod.call({ to: view.name, method: finishStepsMethod, input: null })
        if (isObject(opened)) parts.update(view.name, opened)
        return undefined
      })

    const detail = (view: ModView, columns: number, isFocused: boolean, surface: Surface): JSX.Element => {
      const { removing } = mod.state.memory
      const { notice, viewParams } = mod.state.session
      const isCmod = view.name === mod.name
      const actions = isCmod || removing === view.name ? undefined : [filledButton({ key: 'turn', label: view.isOn ? 'Turn off' : 'Turn on', onPress: () => turn(view.name, !view.isOn) }), filledButton({ key: 'remove', label: 'Remove', onPress: () => void (mod.state.memory.removing = view.name) })]
      const facts = [...(view.isService ? ['Runs as a service of this computer'] : []), ...view.webApps.flatMap((app) => (app.url !== null ? [`${app.name} opens from your other devices at ${app.url}`] : app.reason !== null ? [`${app.name} is not on your tailnet: ${app.reason}`] : []))]
      const removal = removing === view.name ? [Banner({ tone: 'warning', children: `Remove ${view.name}? Its uninstall step runs, and Claude Code deletes it.`, actions: [filledButton({ key: 'keep', variant: 'primary', label: 'Keep', onPress: () => void (mod.state.memory.removing = null) }), filledButton({ key: 'remove-confirmed', label: 'Remove', onPress: () => remove(view.name) })] })] : []
      const attention = [
        ...(view.isOn ? [] : [Banner({ tone: 'warning', children: 'Off: Claude Code does not load it.' })]),
        ...(view.pendingSteps.length === 0 ? [] : [Banner({ tone: 'warning', children: `Needs setup: ${view.pendingSteps.join(', ')}`, actions: [filledButton({ key: 'finish', variant: 'primary', label: 'Finish setup', onPress: () => finishSetup(view) })] })]),
      ]
      const inner = columns - panelColumns * 2
      const about = [view.version, view.description].filter((part) => part !== undefined && part !== '').join(' · ')
      const sections = [
        ...settingsViewsOf(view).map((each) => section(`${viewSection}${each.id}`, each.title, parts.element(view.name, each.id, viewParams, inner, isFocused, surface) ?? Text({ dimColor: true, children: 'Drawing…' }))),
        ...(isCmod || view.options.length === 0 ? [] : [section('options', 'Options', Box({ flexDirection: 'column', gap: 1, children: optionRows(view) }))]),
        ...(view.hotkeys.length === 0 ? [] : [section('hotkeys', 'Hotkeys', Box({ flexDirection: 'column', gap: 1, children: hotkeyRows(view) }))]),
        ...(isCmod ? [section('widgets', 'Widgets', widgetsLayout(mod, widgets)), section('log', 'Log', failuresLog()), section('preferences', 'Preferences', Box({ flexDirection: 'column', gap: 1, children: preferences() }))] : []),
        ...(view.changelog.length === 0 ? [] : [section('changelog', 'Changelog', Box({ flexDirection: 'column', gap: 1, children: changes(view) }))]),
      ]
      return Box({
        flexDirection: 'column',
        gap: 1,
        children: [
          Button({ plain: true, dimColor: true, key: 'back', label: '← All mods', onPress: () => select(null) }),
          Panel({
            title: view.name,
            ...(about === '' ? {} : { description: about }),
            ...(actions === undefined ? {} : { actions }),
            children: Box({ flexDirection: 'column', gap: 1, children: [...facts.map((fact) => Text({ dimColor: true, wrap: 'wrap', children: fact })), ...removal, ...attention, ...(notice === null ? [] : [Text({ dimColor: true, wrap: 'wrap', children: notice })]), ...sections] }),
          }),
        ],
      })
    }

    const modList = (views: readonly ModView[]): JSX.Element => {
      const { notice } = mod.state.session
      const toneOf = (each: ModView) => (!each.isOn ? { tone: 'off' as const } : each.pendingSteps.length > 0 ? { tone: 'warning' as const } : {})
      return Box({
        flexDirection: 'column',
        gap: 1,
        children: [
          ...(notice === null ? [] : [Text({ dimColor: true, wrap: 'wrap', children: notice })]),
          List({ label: 'Mods', children: views.map((each) => ListItem({ key: `mod:${each.name}`, label: each.name, ...(each.isOn ? (each.version === '' ? {} : { description: each.version }) : { description: 'off' }), ...toneOf(each), onPress: () => select(each.name) })) }),
        ],
      })
    }

    return {
      draw(columns, isFocused, surface) {
        const { views } = mod.state.memory
        if (views.length === 0) return Text({ dimColor: true, children: mod.state.session.notice ?? 'Reading your mods…' })
        const view = selectedView()
        return view === undefined ? modList(views) : detail(view, columns, isFocused, surface)
      },
      refresh,
      shownView() {
        const view = selectedView()
        const first = view === undefined ? undefined : settingsViewsOf(view)[0]
        return view === undefined || first === undefined ? undefined : { mod: view.name, id: first.id }
      },
      closeView(name, shown) {
        const view = selectedView()
        if (view === undefined || view.name !== name || !settingsViewsOf(view).some((each) => each.id === shown)) return false
        mod.state.session.viewParams = null
        return true
      },
      async show(name, section, params) {
        await refresh()
        const view = mod.state.memory.views.find((each) => each.name === name)
        if (view === undefined) throw new Error(`${name} is not a mod cmod set up.`)
        mod.state.session.selected = name
        mod.state.memory.removing = null
        mod.state.session.viewParams = section?.startsWith(viewSection) === true ? (params ?? null) : null
        if (section === undefined) return
        const shown = view.changelog.some(({ version }) => version === view.version) ? view.version : unreleased
        await pane.scrollTo({ key: section === 'changelog' ? `changelog:${shown}` : `section:${section}` }, { block: 'start' })
      },
    }
  }
}
