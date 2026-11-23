import { Dashboard, type Mod, type Pane, type Surface, type View } from '../node_modules/@cmodjs/core/mod.js'
import { filledButton } from '../node_modules/@cmodjs/core/runtime/buttons.js'
import { engineOf } from '../node_modules/@cmodjs/core/runtime/engine.js'
import { installView } from '../node_modules/@cmodjs/core/runtime/installer.js'
import type { PartRequest, SettingsTab } from '../node_modules/@cmodjs/core/runtime/ui.js'
import { Panel } from '../node_modules/@cmodjs/core/ui/components.js'
import { Box, Button, Text } from '../node_modules/@cmodjs/core/ui/elements.js'
import type { HistoryView } from './history.js'

export type OpenTab = { readonly mod: string; readonly id: string; readonly params: unknown }

export type SidebarState = { readonly session: { tabs: readonly OpenTab[]; shown: string } }

const dashboardTab = 'dashboard'

const settingsTab = 'settings'

const tabHotkeys = 8

const barColor = 'userMessageBackground'

const shownColor = 'claude'

const focusedKeys = [
  ['↑↓', 'scroll'],
  ['tab', 'move'],
  ['esc', 'hide'],
] as const

const unfocusedKeys = [['click', 'focus']] as const

const panelColumns = 4

const bodyPadding = 2

type TabView = { readonly key: string; readonly label: string; readonly hotkey: string | undefined; readonly isShown: boolean; readonly onClose: (() => void) | undefined }

const tabText = ({ label, hotkey }: Pick<TabView, 'label' | 'hotkey'>) => (hotkey === undefined ? label : `${hotkey}: ${label}`)

const closeGlyph = ' × '

const tabColumns = (each: TabView) => [...tabText(each)].length + 2 + (each.onClose === undefined ? 0 : 1 + [...closeGlyph].length)

export const sidebarSession: SidebarState['session'] = { tabs: [], shown: dashboardTab }

export type SettingsView = {
  draw(columns: number, isFocused: boolean, surface: Surface): JSX.Element
  refresh(): Promise<void>
  show(mod: string, section?: SettingsTab | 'widgets' | `view:${string}`, params?: unknown): Promise<void>
  shownView(): Pick<OpenTab, 'mod' | 'id'> | undefined
  closeView(mod: string, view: string): boolean
}

const keyOf = ({ mod, id }: Pick<OpenTab, 'mod' | 'id'>) => `${mod}/${id}`

export function sidebar<State extends SidebarState>(mod: Mod<State>, settings: (sidebar: Pane, changed: () => void) => SettingsView, history: (isShown: () => boolean) => HistoryView, openInBrowser: () => Promise<void>) {
  const { parts, widgets } = engineOf(mod)
  if (parts === undefined || widgets === undefined) throw new Error('cmod draws no Sidebar, because the cmod plugin started without its views, pages, and widgets.')
  const told = new Set<string>()

  const historyTab: OpenTab = { mod: mod.name, id: 'history', params: null }
  const historyKey = keyOf(historyTab)
  const isHistory = (open: Pick<OpenTab, 'mod' | 'id'>) => keyOf(open) === historyKey
  const historyView = history(() => (mod.state.session.tabs.some(isHistory) && pane.isShown && mod.state.session.shown === historyKey) || historyPart.isShown)

  const declaredOf = (name: string) => parts.declared().find((each) => each.mod === name)
  const isPage = ({ mod: name, id }: Pick<OpenTab, 'mod' | 'id'>) => declaredOf(name)?.pages.some((page) => page.id === id) === true
  const titleOf = (open: OpenTab) => {
    if (isHistory(open)) return historyView.title
    if (open.id === installView) return `Install ${open.mod}`
    const declared = declaredOf(open.mod)
    return [...(declared?.views ?? []), ...(declared?.pages ?? [])].find((each) => each.id === open.id)?.title ?? open.id
  }

  const tell = () => {
    const shown = mod.state.session.shown
    const open = mod.state.session.tabs.filter((each) => !isHistory(each))
    const isShown = pane.isShown
    const inSettings = isShown && shown === settingsTab ? view.shownView() : undefined
    const mods = new Set([...told, ...open.map((each) => each.mod), ...(inSettings === undefined ? [] : [inSettings.mod])])
    for (const name of mods) {
      const own = open.filter((each) => each.mod === name)
      const inPane = inSettings?.mod === name ? inSettings.id : isShown ? own.find((each) => keyOf(each) === shown)?.id : undefined
      const shownId = inPane ?? null
      parts.tell(name, { open: own.map(({ id, params }) => ({ id, params })), shown: shownId, isFocused: inPane !== undefined && pane.isFocused })
      if (own.length === 0 && shownId === null) told.delete(name)
      else told.add(name)
    }
  }

  const show = (tab: string) => {
    mod.state.session.shown = tab
    tell()
  }

  const closeTab = async (key: string) => {
    const { tabs: open, shown } = mod.state.session
    const index = open.findIndex((each) => keyOf(each) === key)
    if (index === -1) return
    const left = open.filter((each) => keyOf(each) !== key)
    mod.state.session.tabs = left
    if (shown !== key) return tell()
    const next = left[Math.min(index, left.length - 1)]
    if (next === undefined) {
      mod.state.session.shown = dashboardTab
      await pane.close()
      return tell()
    }
    show(keyOf(next))
  }

  const tab = ({ key, label, hotkey, isShown, onClose }: TabView): JSX.Element => {
    const closes = onClose === undefined ? [] : [Button({ plain: true, key: `close:${key}`, onPress: onClose, children: Text({ ...(isShown ? { color: shownColor, backgroundColor: 'inverseText' } : { color: barColor, backgroundColor: 'inactive' }), children: closeGlyph }) })]
    return Box({
      flexShrink: 0,
      paddingX: 1,
      columnGap: 1,
      ...(isShown ? { backgroundColor: shownColor } : {}),
      children: [isShown ? Text({ color: 'inverseText', bold: true, children: tabText({ label, hotkey }) }) : Button({ plain: true, dimColor: true, key: `tab:${key}`, ...(hotkey === undefined ? {} : { hotkey }), label, onPress: () => show(key) }), ...closes],
    })
  }

  const edge = (glyph: string, left: readonly TabView[], right: TabView, columns: number): JSX.Element => {
    const widths = left.map(tabColumns)
    const rightColumns = tabColumns(right)
    const leftColumns = widths.reduce((sum, width) => sum + width, 0)
    if (leftColumns + rightColumns > columns) return Text({ color: barColor, children: glyph.repeat(columns) })
    const shown = left.findIndex((each) => each.isShown)
    const start = shown === -1 ? columns - rightColumns : widths.slice(0, shown).reduce((sum, width) => sum + width, 0)
    const width = shown === -1 ? rightColumns : (widths[shown] ?? 0)
    return Text({ children: [Text({ color: barColor, children: glyph.repeat(start) }), Text({ color: shownColor, children: glyph.repeat(width) }), Text({ color: barColor, children: glyph.repeat(columns - start - width) })] })
  }

  const arrangeWidgets = async () => {
    show(settingsTab)
    await view.show(mod.name, 'widgets')
    tell()
  }

  const emptyDashboard = () =>
    Box({
      flexDirection: 'column',
      gap: 1,
      children: [
        Box({ flexDirection: 'column', children: [Text({ children: 'Nothing is on the Dashboard yet.' }), Text({ dimColor: true, wrap: 'wrap', children: 'Place the widgets your mods add here, in Settings.' })] }),
        filledButton({ key: 'arrange-widgets', variant: 'primary', label: 'Arrange widgets', onPress: () => void arrangeWidgets() }),
      ],
    })

  const openTabOf = (tab: string) => mod.state.session.tabs.find((each) => keyOf(each) === tab)

  const drawDashboard = (columns: number, surface: Surface) => {
    const rows = widgets.rows(Dashboard, { columns: columns - panelColumns, surface })
    return Panel({ title: 'Widgets', children: rows.length === 0 ? emptyDashboard() : Box({ flexDirection: 'column', children: rows }) })
  }

  const drawHistory = () => Panel({ title: historyView.title, children: historyView.draw() })

  const bodyOf = (tab: string, columns: number, isFocused: boolean, surface: Surface): JSX.Element => {
    if (tab === settingsTab) return view.draw(columns, isFocused, surface)
    const open = openTabOf(tab)
    if (open === undefined) return drawDashboard(columns, surface)
    if (isHistory(open)) return drawHistory()
    const drawing = `Drawing ${titleOf(open)}…`
    if (isPage(open)) return parts.element(open.mod, open.id, open.params, columns, isFocused, surface) ?? Text({ dimColor: true, children: drawing })
    return Panel({ title: open.mod, children: parts.element(open.mod, open.id, open.params, columns - panelColumns, isFocused, surface) ?? Text({ dimColor: true, children: drawing }) })
  }

  const tabViews = (shownTab: string): { readonly left: readonly TabView[]; readonly right: TabView } => ({
    left: [
      { key: dashboardTab, label: 'Dashboard', hotkey: '0', isShown: shownTab === dashboardTab, onClose: undefined },
      ...mod.state.session.tabs.map((each, index): TabView => {
        const key = keyOf(each)
        return { key, label: titleOf(each), hotkey: index < tabHotkeys ? `${index + 1}` : undefined, isShown: key === shownTab, onClose: () => void closeTab(key) }
      }),
    ],
    right: { key: settingsTab, label: 'Settings', hotkey: '9', isShown: shownTab === settingsTab, onClose: undefined },
  })

  const pane: Pane = mod.panes.add({
    id: 'sidebar',
    title: 'Sidebar',
    closeOnEscape: true,
    render(current, { bodyColumns, isFocused, placement, scroll, surface }) {
      const { tabs: open, shown } = current.state.session
      const isTabShown = open.some((each) => keyOf(each) === shown)
      const shownTab = shown === settingsTab || isTabShown ? shown : dashboardTab
      const { left, right } = tabViews(shownTab)
      const shownOpen = openTabOf(shownTab)
      const fillsWidth = shownOpen !== undefined && isPage(shownOpen)
      const tabBar = Box({
        flexDirection: 'column',
        children: [
          edge('▄', left, right, bodyColumns),
          Box({ backgroundColor: barColor, justifyContent: 'space-between', children: [Box({ flexWrap: 'wrap', flexShrink: 1, minWidth: 0, children: left.map(tab) }), tab(right)] }),
          edge('▀', left, right, bodyColumns),
        ],
      })
      const keyBar = Box({
        backgroundColor: barColor,
        paddingX: 1,
        columnGap: 2,
        flexWrap: 'wrap',
        children: [...(isFocused ? focusedKeys : unfocusedKeys).map(([keys, does]) => Text({ wrap: 'truncate-end', children: [keys, Text({ dimColor: true, children: ` ${does}` })] })), Button({ plain: true, key: 'open-in-browser', label: 'open in browser', onPress: () => void openInBrowser() })],
      })
      return Box({
        flexDirection: 'column',
        gap: 1,
        ...(placement === 'dock' ? { minHeight: scroll.bodyRows } : {}),
        children: [tabBar, Box({ flexDirection: 'column', flexGrow: 1, ...(fillsWidth ? {} : { paddingX: 1 }), children: bodyOf(shownTab, fillsWidth ? bodyColumns : bodyColumns - bodyPadding, isFocused, surface) }), keyBar],
      })
    },
    onClose: () => tell(),
  })

  const view = settings(pane, () => tell())

  let dashboardView: View | undefined
  const hasDashboard = () => {
    const layout = widgets.layout()
    const running = new Set(widgets.widgets().map((widget) => widget.key))
    return layout.areas[Dashboard].some((row) => [...row.left, ...row.right].some((key) => running.has(key) && !layout.hidden.includes(key)))
  }
  const placeDashboard = () => {
    if (hasDashboard() === (dashboardView !== undefined)) return
    if (dashboardView === undefined) dashboardView = mod.views.add({ id: dashboardTab, title: 'Dashboard', render: (_current, { columns, surface }) => drawDashboard(columns, surface) })
    else {
      dashboardView.remove()
      dashboardView = undefined
    }
  }
  placeDashboard()
  widgets.onChange(placeDashboard)
  const historyPart = mod.views.add({ id: historyTab.id, title: historyView.title, render: () => drawHistory() })
  mod.views.add({ id: settingsTab, title: 'Settings', render: (_current, { columns, isFocused, surface }) => view.draw(columns, isFocused, surface) })
  const isFixedTab = (name: string, id: string) => name === mod.name && (id === dashboardTab || id === settingsTab)

  const placeOf = (name: string, id: string) => declaredOf(name)?.views.find((each) => each.id === id)?.place

  const addTab = (opened: OpenTab) => {
    const open = mod.state.session.tabs
    mod.state.session.tabs = open.some((each) => keyOf(each) === keyOf(opened)) ? open.map((each) => (keyOf(each) === keyOf(opened) ? opened : each)) : [...open, opened]
  }

  const apply = async (name: string, requests: readonly PartRequest[]) => {
    for (const request of requests) {
      if ('open' in request && placeOf(name, request.open) === 'settings') {
        show(settingsTab)
        if (!parts.isHosted()) await pane.open({ focus: true })
        await view.show(name, `view:${request.open}`, request.params)
      } else if ('open' in request) {
        const opened: OpenTab = { mod: name, id: request.open, params: request.params }
        addTab(opened)
        show(keyOf(opened))
        if (!parts.isHosted()) await pane.open(request.focus === true ? { focus: true } : {})
      } else if ('close' in request) {
        if (!view.closeView(name, request.close)) await closeTab(keyOf({ mod: name, id: request.close }))
      } else if ('scroll' in request) {
        const to = typeof request.to === 'string' ? request.to : { key: `${name}/${request.scroll}:${request.to.key}` }
        await pane.scrollTo(to, request.block === undefined ? {} : { block: request.block })
      } else if ('focus' in request) {
        await pane.focus(`${name}/${request.focus}:${request.key}`)
      } else if ('settings' in request) {
        show(settingsTab)
        if (!parts.isHosted()) await pane.open({ focus: true })
        await view.show(name, request.tab)
      } else {
        engineOf(mod).claude.ui.warn(`page-request:${name}`, `cmod: ${name} sent a request this cmod does not know, so it skips it: ${JSON.stringify(request)}`)
      }
    }
    tell()
  }
  parts.apply(apply)
  parts.onOpen(async (name, id, isOpen) => {
    if (isFixedTab(name, id)) return
    if (isOpen) addTab({ mod: name, id, params: openTabOf(keyOf({ mod: name, id }))?.params ?? null })
    else await closeTab(keyOf({ mod: name, id }))
    tell()
  })

  const reveal = async (id: string) => {
    if (!parts.revealed(mod.name, id)) await pane.open({ focus: true })
  }

  const openHistory = async () => {
    addTab(historyTab)
    show(historyKey)
    historyView.refresh()
    await reveal(historyTab.id)
    tell()
  }

  return {
    pane,
    refreshSettings: () => view.refresh(),
    async toggle() {
      await pane.toggle({ focus: true })
      tell()
    },
    async toggleSettings() {
      if (pane.isShown && mod.state.session.shown === settingsTab) {
        await pane.close()
        return tell()
      }
      show(settingsTab)
      await reveal(settingsTab)
      tell()
    },
    async openSettings(name?: string) {
      show(settingsTab)
      await reveal(settingsTab)
      if (name !== undefined) await view.show(name)
      tell()
    },
    openHistory,
    async toggleHistory() {
      if (pane.isShown && mod.state.session.shown === historyKey) return closeTab(historyKey)
      await openHistory()
    },
  }
}
