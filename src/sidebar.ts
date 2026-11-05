import type { RenderElement } from 'claude-code'
import { Dashboard, type Mod, type Pane } from '../node_modules/@cmodjs/core/mod.js'
import { filledButton } from '../node_modules/@cmodjs/core/runtime/buttons.js'
import { engineOf } from '../node_modules/@cmodjs/core/runtime/engine.js'
import { installPage } from '../node_modules/@cmodjs/core/runtime/installer.js'
import type { PageRequest, SettingsTab } from '../node_modules/@cmodjs/core/runtime/ui.js'
import type { SidebarTab } from '../node_modules/@cmodjs/core/runtime/web.js'
import { Panel } from '../node_modules/@cmodjs/core/ui/components.js'
import { Box, Button, Text } from '../node_modules/@cmodjs/core/ui/elements.js'

export type OpenPage = { readonly mod: string; readonly page: string; readonly params: unknown }

export type SidebarState = { readonly session: { pages: readonly OpenPage[]; shown: string } }

const dashboardTab = 'dashboard'

const settingsTab = 'settings'

const pageHotkeys = 8

const barColor = 'userMessageBackground'

const shownColor = 'claude'

const focusedKeys = [
  ['↑↓', 'scroll'],
  ['tab', 'move'],
  ['esc', 'hide'],
] as const

const unfocusedKeys = [['click', 'focus']] as const

const panelColumns = 4

type TabView = { readonly key: string; readonly label: string; readonly hotkey: string | undefined; readonly isShown: boolean; readonly onClose: (() => void) | undefined }

const tabText = ({ label, hotkey }: Pick<TabView, 'label' | 'hotkey'>) => (hotkey === undefined ? label : `${hotkey}: ${label}`)

const closeGlyph = ' × '

const tabColumns = (each: TabView) => [...tabText(each)].length + 2 + (each.onClose === undefined ? 0 : 1 + [...closeGlyph].length)

export const sidebarSession: SidebarState['session'] = { pages: [], shown: dashboardTab }

export type SettingsView = {
  draw(columns: number, isFocused: boolean): RenderElement
  show(mod: string, section?: SettingsTab | 'widgets' | `page:${string}`, params?: unknown): Promise<void>
  shownPage(): Pick<OpenPage, 'mod' | 'page'> | undefined
  closePage(mod: string, page: string): boolean
}

const keyOf = ({ mod, page }: Pick<OpenPage, 'mod' | 'page'>) => `${mod}/${page}`

export function sidebar<State extends SidebarState>(mod: Mod<State>, settings: (sidebar: Pane, changed: () => void) => SettingsView, openInBrowser: () => Promise<void>) {
  const { pages, widgets } = engineOf(mod)
  if (pages === undefined || widgets === undefined) throw new Error('cmod draws no Sidebar, because the cmod plugin started without its pages and widgets.')
  const told = new Set<string>()
  let inBrowser: ReadonlySet<string> = new Set()

  const titleOf = (open: OpenPage) => (open.page === installPage ? `Install ${open.mod}` : (pages.declared().find((each) => each.mod === open.mod)?.pages.find((page) => page.id === open.page)?.title ?? open.page))

  const tell = () => {
    const { pages: open, shown } = mod.state.session
    const isShown = pane.isShown
    const inSettings = isShown && shown === settingsTab ? view.shownPage() : undefined
    const mods = new Set([...told, ...open.map((each) => each.mod), ...(inSettings === undefined ? [] : [inSettings.mod])])
    for (const name of mods) {
      const own = open.filter((each) => each.mod === name)
      const inPane = inSettings?.mod === name ? inSettings.page : isShown ? own.find((each) => keyOf(each) === shown)?.page : undefined
      const shownPage = inPane ?? own.find((each) => inBrowser.has(keyOf(each)))?.page ?? null
      pages.tell(name, { open: own.map(({ page, params }) => ({ id: page, params })), shown: shownPage, isFocused: inPane !== undefined && pane.isFocused })
      if (own.length === 0 && shownPage === null) told.delete(name)
      else told.add(name)
    }
  }

  const show = (tab: string) => {
    mod.state.session.shown = tab
    tell()
  }

  const closePage = async (key: string) => {
    const { pages: open, shown } = mod.state.session
    const index = open.findIndex((each) => keyOf(each) === key)
    if (index === -1) return
    const left = open.filter((each) => keyOf(each) !== key)
    mod.state.session.pages = left
    if (shown !== key) return tell()
    const next = left[Math.min(index, left.length - 1)]
    if (next === undefined) {
      mod.state.session.shown = dashboardTab
      await pane.close()
      return tell()
    }
    show(keyOf(next))
  }

  const tab = ({ key, label, hotkey, isShown, onClose }: TabView): RenderElement => {
    const closes = onClose === undefined ? [] : [Button({ plain: true, key: `close:${key}`, onPress: onClose, children: Text({ ...(isShown ? { color: shownColor, backgroundColor: 'inverseText' } : { color: barColor, backgroundColor: 'inactive' }), children: closeGlyph }) })]
    return Box({
      flexShrink: 0,
      paddingX: 1,
      columnGap: 1,
      ...(isShown ? { backgroundColor: shownColor } : {}),
      children: [isShown ? Text({ color: 'inverseText', bold: true, children: tabText({ label, hotkey }) }) : Button({ plain: true, dimColor: true, key: `tab:${key}`, ...(hotkey === undefined ? {} : { hotkey }), label, onPress: () => show(key) }), ...closes],
    })
  }

  const edge = (glyph: string, left: readonly TabView[], right: TabView, columns: number): RenderElement => {
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

  const bodyOf = (tab: string, columns: number, isFocused: boolean): RenderElement => {
    if (tab === settingsTab) return view.draw(columns, isFocused)
    const page = mod.state.session.pages.find((each) => keyOf(each) === tab)
    if (page === undefined) {
      const rows = widgets.rows(Dashboard, columns - panelColumns)
      return Panel({ title: 'Widgets', children: rows.length === 0 ? emptyDashboard() : Box({ flexDirection: 'column', children: rows }) })
    }
    return Panel({ title: page.mod, children: pages.element(page.mod, page.page, page.params, columns - panelColumns, isFocused) ?? Text({ dimColor: true, children: `Drawing ${titleOf(page)}…` }) })
  }

  const tabViews = (shownTab: string): { readonly left: readonly TabView[]; readonly right: TabView } => ({
    left: [
      { key: dashboardTab, label: 'Dashboard', hotkey: '0', isShown: shownTab === dashboardTab, onClose: undefined },
      ...mod.state.session.pages.map((each, index): TabView => {
        const key = keyOf(each)
        return { key, label: titleOf(each), hotkey: index < pageHotkeys ? `${index + 1}` : undefined, isShown: key === shownTab, onClose: () => void closePage(key) }
      }),
    ],
    right: { key: settingsTab, label: 'Settings', hotkey: '9', isShown: shownTab === settingsTab, onClose: undefined },
  })

  const pane: Pane = mod.panes.add({
    id: 'sidebar',
    title: 'Sidebar',
    closeOnEscape: true,
    render(current, { bodyColumns, isFocused, placement, scroll }) {
      const { pages: open, shown } = current.state.session
      const isPageShown = open.some((each) => keyOf(each) === shown)
      const shownTab = shown === settingsTab || isPageShown ? shown : dashboardTab
      const { left, right } = tabViews(shownTab)
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
        children: [tabBar, Box({ flexDirection: 'column', flexGrow: 1, paddingX: 1, children: bodyOf(shownTab, bodyColumns - 2, isFocused) }), keyBar],
      })
    },
    onClose: () => tell(),
  })

  const view = settings(pane, () => tell())

  const placeOf = (name: string, page: string) => pages.declared().find((each) => each.mod === name)?.pages.find((each) => each.id === page)?.place

  const addTab = (opened: OpenPage) => {
    const open = mod.state.session.pages
    mod.state.session.pages = open.some((each) => keyOf(each) === keyOf(opened)) ? open.map((each) => (keyOf(each) === keyOf(opened) ? opened : each)) : [...open, opened]
  }

  const apply = async (name: string, requests: readonly PageRequest[]) => {
    for (const request of requests) {
      if ('open' in request && placeOf(name, request.open) === 'settings') {
        show(settingsTab)
        await pane.open({ focus: true })
        await view.show(name, `page:${request.open}`, request.params)
      } else if ('open' in request) {
        const opened: OpenPage = { mod: name, page: request.open, params: request.params }
        addTab(opened)
        show(keyOf(opened))
        await pane.open(request.focus === true ? { focus: true } : {})
      } else if ('close' in request) {
        if (!view.closePage(name, request.close)) await closePage(keyOf({ mod: name, page: request.close }))
      } else if ('scroll' in request) {
        const to = typeof request.to === 'string' ? request.to : { key: `${name}/${request.scroll}:${request.to.key}` }
        await pane.scrollTo(to, request.block === undefined ? {} : { block: request.block })
      } else if ('focus' in request) {
        await pane.focus(`${name}/${request.focus}:${request.key}`)
      } else if ('settings' in request) {
        show(settingsTab)
        await pane.open({ focus: true })
        await view.show(name, request.tab)
      } else {
        engineOf(mod).claude.ui.warn(`page-request:${name}`, `cmod: ${name} sent a page request this cmod does not know, so it skips it: ${JSON.stringify(request)}`)
      }
    }
    tell()
  }
  pages.apply(apply)

  return {
    pane,
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
      await pane.open({ focus: true })
      tell()
    },
    async openSettings(name?: string) {
      show(settingsTab)
      await pane.open({ focus: true })
      if (name !== undefined) await view.show(name)
      tell()
    },
    tabs(): SidebarTab[] {
      const { left, right } = tabViews(mod.state.session.shown)
      return [...left, right].map(({ key, label, onClose }) => ({ key, label, isClosable: onClose !== undefined }))
    },
    draw: (tab: string, columns: number) => bodyOf(tab, columns, true),
    closeTab: (tab: string) => closePage(tab),
    addTab(opened: OpenPage) {
      addTab(opened)
      tell()
    },
    showInBrowser(tabs: ReadonlySet<string>) {
      inBrowser = tabs
      tell()
    },
  }
}
