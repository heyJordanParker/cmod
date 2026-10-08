import type { ConfigRow, RenderElement } from 'claude-code'
import { longestMs, messageOf, type Mod } from '../node_modules/@cmodjs/core/mod.js'
import { consentPath, finishStepsMethod, isObject, openPageMethod, parseConsent, pendingStepsMethod, permissionWords, readRecord, readSteps, settingsPagesMethod, storeFolder } from '../node_modules/@cmodjs/core/records.js'
import { Tabs } from '../node_modules/@cmodjs/core/ui/components.js'
import { definePane } from '../node_modules/@cmodjs/core/ui/define-pane.js'
import { Box, Button, Input, Text } from '../node_modules/@cmodjs/core/ui/elements.js'

export type ModsState = { readonly memory: { selected: string | null; tab: Tab; notice: string | null; removing: string | null; views: readonly ModView[] } }

export const modsMemory: ModsState['memory'] = { selected: null, tab: 'options', notice: null, removing: null, views: [] }

type Tab = 'options' | 'permissions' | 'keys' | 'pages'

type Permission = { readonly item: string; readonly isOn: boolean }

export type ModView = {
  readonly name: string
  readonly version: string
  readonly description: string | undefined
  readonly isOn: boolean
  readonly permissions: readonly Permission[]
  readonly keys: readonly (readonly [string, string])[]
  readonly options: readonly ConfigRow[]
  readonly pages: readonly { readonly id: string; readonly title: string }[]
  readonly pendingSteps: readonly string[]
}

const tabs: readonly { readonly key: Tab; readonly label: string }[] = [
  { key: 'options', label: 'Options' },
  { key: 'permissions', label: 'Permissions' },
  { key: 'keys', label: 'Keys' },
  { key: 'pages', label: 'Pages' },
]

export function modsPanel<State extends ModsState>(mod: Mod<State>) {
  const load = async (): Promise<readonly ModView[]> => {
    const store = storeFolder({ HOME: await mod.claude.env.home(), XDG_DATA_HOME: await mod.claude.env.dataHome() })
    const consent = (await mod.fs.exists(consentPath(store))) ? parseConsent(JSON.parse(await mod.fs.read(consentPath(store))), consentPath(store)) : {}
    const rows = await mod.claude.config.list()
    const enabledPlugins = (await mod.claude.settings.read())['enabledPlugins']
    const turnedOff = Object.entries(isObject(enabledPlugins) ? enabledPlugins : {})
      .filter(([, isEnabled]) => isEnabled === false)
      .map(([id]) => id.replace(/@[^@]*$/, ''))
    const names = (await mod.fs.exists(`${store}/records`)) ? (await mod.fs.list(`${store}/records`)).filter((entry) => entry.name.endsWith('.json')).map((entry) => entry.name.slice(0, -'.json'.length)) : []
    const read = (path: string) => mod.fs.read(path).catch(() => undefined)
    const records = (await Promise.all(names.map((name) => readRecord(read, store, name)))).filter((record) => record !== undefined)
    const views = await Promise.all(
      records.map(async (record): Promise<ModView> => {
        const manifest: unknown = await mod.fs.read(`${record.root}/package.json`).then(JSON.parse, () => undefined)
        const plugin: unknown = await mod.fs.read(`${record.root}/.claude-plugin/plugin.json`).then(JSON.parse, () => undefined)
        const declared = (isObject(manifest) ? readSteps(manifest)?.permissions : undefined) ?? []
        const granted = consent[record.name] ?? []
        const ask = async <Value>(method: string): Promise<readonly Value[]> => {
          const answer = await mod.claude.cmod.call({ to: record.name, method, input: null }).catch(() => undefined)
          return isObject(answer) && Array.isArray(answer['value']) ? (answer['value'] as Value[]) : []
        }
        const pages = await ask<ModView['pages'][number]>(settingsPagesMethod)
        const pendingSteps = await ask<string>(pendingStepsMethod)
        return {
          name: record.name,
          version: record.version,
          description: isObject(plugin) && typeof plugin['description'] === 'string' ? plugin['description'] : undefined,
          isOn: !turnedOff.includes(record.name),
          permissions: declared.map((item) => ({ item, isOn: granted.includes(item) })),
          keys: Object.entries(record.keys ?? {}).map(([key, command]) => [key, `/${command}`] as const),
          options: rows.filter((row) => row.key.startsWith(`${record.name}.`)),
          pages,
          pendingSteps,
        }
      }),
    )
    return views.sort((left, right) => left.name.localeCompare(right.name))
  }

  const refresh = async () => {
    try {
      mod.state.memory.views = await load()
    } catch (error) {
      mod.state.memory.notice = `The mods did not load: ${messageOf(error)}`
    }
  }

  const act = (task: () => Promise<string | undefined>) =>
    void task()
      .then((notice) => {
        mod.state.memory.notice = notice ?? null
        return refresh()
      })
      .catch((error: unknown) => void (mod.state.memory.notice = messageOf(error)))

  const toggle = (name: string, { item, isOn }: Permission) =>
    act(async () => {
      const split = item.indexOf(':')
      const words = split === -1 ? [item] : [item.slice(0, split), item.slice(split + 1)]
      const { exitCode, stdout, stderr } = await mod.process.run(['cmod', 'permission', name, ...words, isOn ? 'off' : 'on'])
      return exitCode === 0 ? stdout.trim() : stderr.trim()
    })

  const remove = (name: string) =>
    act(async () => {
      mod.state.memory.removing = null
      mod.state.memory.notice = `Removing ${name}…`
      const { exitCode, stderr } = await mod.process.run(['cmod', 'remove', name], { timeoutMs: longestMs })
      if (exitCode === 0) return `Removed ${name}. This session stops running it after /reload-plugins.`
      return `cmod remove ${name} exited ${exitCode}: ${stderr.trim().split('\n').at(-1) ?? ''}`
    })

  const turn = (name: string, isOn: boolean) =>
    act(async () => {
      const action = isOn ? 'enable' : 'disable'
      const { exitCode, stderr } = await mod.process.run(['cmod', action, name])
      if (exitCode === 0) return `Turned ${name} ${isOn ? 'on' : 'off'}. This session follows after /reload-plugins.`
      return `cmod ${action} ${name} exited ${exitCode}: ${stderr.trim().split('\n').at(-1) ?? ''}`
    })

  const setOption = (row: ConfigRow, text: string) =>
    act(async () => {
      const listed = text.split(',').map((item) => item.trim()).filter((item) => item !== '')
      const value = row.kind === 'number' ? Number(text) : row.kind === 'boolean' ? text.trim() === 'true' : Array.isArray(row.value) ? listed : text
      const saved = await mod.claude.config.set({ key: row.key, value })
      return saved.deny ?? `Saved ${row.label}.`
    })

  const drawTab = (view: ModView, tab: Tab): RenderElement => {
    if (tab === 'options') {
      if (view.options.length === 0) return Text({ dimColor: true, children: `${view.name} has no options.` })
      return Box({
        flexDirection: 'column',
        gap: 1,
        children: view.options.map((row) =>
          Box({
            flexDirection: 'column',
            children: [
              Text({ children: [Text({ bold: true, children: row.label }), row.isLocked ? Text({ dimColor: true, children: '  set by your organization' }) : ''] }),
              row.isLocked ? Text({ children: String(row.value) }) : Input({ key: `option:${row.key}`, label: '› ', value: Array.isArray(row.value) ? row.value.join(', ') : String(row.value), submitLabel: 'save', onSubmit: (text: string) => setOption(row, text) }),
            ],
          }),
        ),
      })
    }
    if (tab === 'permissions') {
      if (view.permissions.length === 0) return Text({ dimColor: true, children: `${view.name} asks for no permissions.` })
      return Box({ flexDirection: 'column', children: view.permissions.map((permission) => Button({ plain: true, key: `permission:${permission.item}`, label: `${permission.isOn ? '[x]' : '[ ]'} ${permissionWords(permission.item)}`, onPress: () => toggle(view.name, permission) })) })
    }
    if (tab === 'keys') {
      if (view.keys.length === 0) return Text({ dimColor: true, children: `${view.name} binds no keys.` })
      return Box({ flexDirection: 'column', children: view.keys.map(([key, command]) => Text({ children: `${key.padEnd(12)}${command}` })) })
    }
    if (view.pages.length === 0) return Text({ dimColor: true, children: `${view.name} adds no pages.` })
    return Box({ gap: 2, children: view.pages.map((page) => Button({ key: `page:${page.id}`, label: page.title, onPress: () => act(async () => (await mod.claude.cmod.call({ to: view.name, method: openPageMethod, input: page.id }), undefined)) })) })
  }

  const pane = definePane<State>({
    id: 'mods',
    title: 'Mods',
    closeOnEscape: true,
    render(current) {
      const { selected, tab, notice, removing, views } = current.state.memory
      const view = views.find((each) => each.name === selected) ?? views[0]
      if (view === undefined) return Text({ dimColor: true, children: notice ?? 'No mod is set up yet. Run cmod install <owner/repo> to add one.' })
      const list = Box({
        flexDirection: 'column',
        minWidth: 18,
        children: views.map((each) => {
          const label = `${each === view ? '▸' : ' '} ${each.name}${each.isOn ? '' : ' (off)'}`
          return each === view ? Text({ bold: true, children: label }) : Button({ plain: true, key: `mod:${each.name}`, label, onPress: () => void Object.assign(current.state.memory, { selected: each.name, removing: null }) })
        }),
      })
      const actions =
        view.name === 'cmod'
          ? []
          : removing === view.name
            ? [
                Box({
                  flexDirection: 'column',
                  children: [
                    Text({ color: 'warning', children: `Remove ${view.name}? Its uninstall step runs, and Claude Code deletes it.` }),
                    Box({
                      gap: 2,
                      children: [
                        Button({ key: 'keep', label: 'Keep', onPress: () => void (current.state.memory.removing = null) }),
                        Button({ key: 'remove-confirmed', label: 'Remove', onPress: () => remove(view.name) }),
                      ],
                    }),
                  ],
                }),
              ]
            : [
                Box({
                  gap: 2,
                  children: [
                    Button({ key: 'turn', label: view.isOn ? 'Turn off' : 'Turn on', onPress: () => turn(view.name, !view.isOn) }),
                    Button({ key: 'remove', label: 'Remove', onPress: () => void (current.state.memory.removing = view.name) }),
                  ],
                }),
              ]
      const details = Box({
        flexDirection: 'column',
        gap: 1,
        children: [
          Box({
            flexDirection: 'column',
            children: [
              Text({ children: [Text({ bold: true, children: view.name }), Text({ dimColor: true, children: ` ${view.version}` })] }),
              ...(view.description === undefined ? [] : [Text({ dimColor: true, children: view.description })]),
              ...(view.isOn ? [] : [Text({ color: 'warning', children: 'Off: Claude Code does not load it.' })]),
            ],
          }),
          ...actions,
          ...(view.pendingSteps.length === 0
            ? []
            : [
                Box({
                  gap: 2,
                  children: [
                    Text({ color: 'warning', children: `Needs setup: ${view.pendingSteps.join(', ')}` }),
                    Button({ key: 'finish', label: 'Finish setup', onPress: () => act(async () => (await mod.claude.cmod.call({ to: view.name, method: finishStepsMethod, input: null }), undefined)) }),
                  ],
                }),
              ]),
          Tabs({ tabs, selected: tab, onSelect: (key) => void (current.state.memory.tab = key as Tab), children: drawTab(view, tab) }),
          ...(notice === null ? [] : [Text({ dimColor: true, children: notice })]),
        ],
      })
      return Box({ gap: 2, children: [list, details] })
    },
  })

  const handle = mod.ui.pane(pane)

  return {
    async open(name?: string, page?: string) {
      await refresh()
      if (name !== undefined) {
        if (!mod.state.memory.views.some((view) => view.name === name)) throw new Error(`${name} is not a mod cmod set up. cmod list shows the mods.`)
        mod.state.memory.selected = name
        mod.state.memory.tab = 'options'
      }
      if (name !== undefined && page !== undefined) {
        await mod.claude.cmod.call({ to: name, method: openPageMethod, input: page })
        return
      }
      await handle.open({ focus: true })
    },
  }
}
