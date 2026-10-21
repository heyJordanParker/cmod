import type { RenderElement } from 'claude-code'
import { Dashboard, type Mod, type Pane } from '../node_modules/@cmodjs/core/mod.js'
import { engineOf } from '../node_modules/@cmodjs/core/runtime/engine.js'
import type { PageRequest, SettingsTab } from '../node_modules/@cmodjs/core/runtime/ui.js'
import { Box, Button, Text } from '../node_modules/@cmodjs/core/ui/elements.js'

export type OpenPage = { readonly mod: string; readonly page: string; readonly params: unknown }

export type SidebarState = { readonly session: { pages: readonly OpenPage[]; shown: string } }

const dashboardTab = 'dashboard'

const settingsTab = 'settings'

const pageHotkeys = 8

export const sidebarSession: SidebarState['session'] = { pages: [], shown: dashboardTab }

export type SettingsView = {
  draw(columns: number, isFocused: boolean): RenderElement
  show(mod: string, section?: SettingsTab | `page:${string}`, params?: unknown): Promise<void>
  shownPage(): Pick<OpenPage, 'mod' | 'page'> | undefined
  closePage(mod: string, page: string): boolean
}

const keyOf = ({ mod, page }: Pick<OpenPage, 'mod' | 'page'>) => `${mod}/${page}`

export function sidebar<State extends SidebarState>(mod: Mod<State>, settings: (sidebar: Pane, changed: () => void) => SettingsView) {
  const { pages, widgets } = engineOf(mod)
  if (pages === undefined || widgets === undefined) throw new Error('cmod draws no Sidebar, because the cmod plugin started without its pages and widgets.')
  const told = new Set<string>()

  const titleOf = (open: OpenPage) => pages.declared().find((each) => each.mod === open.mod)?.pages.find((page) => page.id === open.page)?.title ?? open.page

  const tell = () => {
    const { pages: open, shown } = mod.state.session
    const isShown = pane.isShown
    const inSettings = isShown && shown === settingsTab ? view.shownPage() : undefined
    const mods = new Set([...told, ...open.map((each) => each.mod), ...(inSettings === undefined ? [] : [inSettings.mod])])
    for (const name of mods) {
      const own = open.filter((each) => each.mod === name)
      const shownPage = inSettings?.mod === name ? inSettings.page : isShown ? (own.find((each) => keyOf(each) === shown)?.page ?? null) : null
      pages.tell(name, { open: own.map(({ page, params }) => ({ id: page, params })), shown: shownPage, isFocused: shownPage !== null && pane.isFocused })
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

  const tab = (key: string, label: string, hotkey: string | undefined, isShown: boolean): RenderElement =>
    isShown
      ? Text({ children: [...(hotkey === undefined ? [] : [Text({ color: 'claude', children: hotkey }), ': ']), Text({ bold: true, underline: true, children: label })] })
      : Button({ plain: true, dimColor: true, key: `tab:${key}`, ...(hotkey === undefined ? {} : { hotkey }), label, onPress: () => show(key) })

  const body = (columns: number, isFocused: boolean): RenderElement => {
    const { pages: open, shown } = mod.state.session
    if (shown === settingsTab) return view.draw(columns, isFocused)
    const page = open.find((each) => keyOf(each) === shown)
    if (page === undefined) {
      const rows = widgets.rows(Dashboard, columns)
      return rows.length === 0 ? Text({ dimColor: true, children: 'No widget is on the Dashboard yet. Move one here in Settings, under cmod, Widgets.' }) : Box({ flexDirection: 'column', children: rows })
    }
    return pages.element(page.mod, page.page, page.params, columns, isFocused) ?? Text({ dimColor: true, children: `Drawing ${titleOf(page)}…` })
  }

  const pane: Pane = mod.panes.add({
    id: 'sidebar',
    title: 'Sidebar',
    closeOnEscape: true,
    render(current, { bodyColumns, isFocused }) {
      const { pages: open, shown } = current.state.session
      const isPageShown = open.some((each) => keyOf(each) === shown)
      const shownTab = shown === settingsTab || isPageShown ? shown : dashboardTab
      const separator = Text({ dimColor: true, children: '│' })
      const pageTabs = open.flatMap((each, index) => {
        const key = keyOf(each)
        const isShown = key === shownTab
        return [tab(key, titleOf(each), index < pageHotkeys ? `${index + 1}` : undefined, isShown), ...(isShown ? [Button({ plain: true, dimColor: true, key: `close:${key}`, label: '×', onPress: () => void closePage(key) })] : [])]
      })
      const row = Box({ gap: 2, children: [tab(dashboardTab, 'Dashboard', '0', shownTab === dashboardTab), separator, ...pageTabs, ...(pageTabs.length === 0 ? [] : [separator]), tab(settingsTab, 'Settings', '9', shownTab === settingsTab)] })
      return Box({ flexDirection: 'column', gap: 1, children: [row, body(bodyColumns, isFocused)] })
    },
    onClose: () => tell(),
  })

  const view = settings(pane, () => tell())

  const placeOf = (name: string, page: string) => pages.declared().find((each) => each.mod === name)?.pages.find((each) => each.id === page)?.place

  const apply = async (name: string, requests: readonly PageRequest[]) => {
    for (const request of requests) {
      if ('open' in request && placeOf(name, request.open) === 'settings') {
        show(settingsTab)
        await pane.open({ focus: true })
        await view.show(name, `page:${request.open}`, request.params)
      } else if ('open' in request) {
        const opened: OpenPage = { mod: name, page: request.open, params: request.params }
        const open = mod.state.session.pages
        mod.state.session.pages = open.some((each) => keyOf(each) === keyOf(opened)) ? open.map((each) => (keyOf(each) === keyOf(opened) ? opened : each)) : [...open, opened]
        show(keyOf(opened))
        await pane.open(request.focus === true ? { focus: true } : {})
      } else if ('close' in request) {
        if (!view.closePage(name, request.close)) await closePage(keyOf({ mod: name, page: request.close }))
      } else if ('scroll' in request) {
        const to = typeof request.to === 'string' ? request.to : { key: `${name}/${request.scroll}:${request.to.key}` }
        await pane.scrollTo(to, request.block === undefined ? {} : { block: request.block })
      } else if ('settings' in request) {
        show(settingsTab)
        await pane.open({ focus: true })
        await view.show(name, request.tab)
      } else {
        mod.log(`${name} sent a page request this cmod does not know, so it skips it: ${JSON.stringify(request)}`)
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
  }
}
