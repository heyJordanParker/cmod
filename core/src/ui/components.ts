import type { RenderChildren, RenderElement } from 'claude-code'
import { Box, Button, Text } from './elements.js'

export type Tab = { readonly key: string; readonly label: string }

export function Tabs({ tabs, selected, onSelect, children }: { readonly tabs: readonly Tab[]; readonly selected: string; readonly onSelect: (key: string) => void; readonly children?: RenderChildren }): RenderElement {
  const row = tabs.map((tab, index) => {
    const hotkey = index < 9 ? `${index + 1}` : undefined
    return tab.key === selected
      ? Text({ children: [...(hotkey === undefined ? [] : [Text({ color: 'claude', children: hotkey }), ': ']), Text({ bold: true, underline: true, children: tab.label })] })
      : Button({ plain: true, dimColor: true, key: `tab:${tab.key}`, ...(hotkey === undefined ? {} : { hotkey }), label: tab.label, onPress: () => onSelect(tab.key) })
  })
  return Box({ flexDirection: 'column', gap: 1, children: [Box({ gap: 3, children: row }), children] })
}

export function Split({ children }: { readonly children: readonly RenderElement[] }): RenderElement {
  const width = `${Math.floor(100 / Math.max(children.length, 1))}%`
  return Box({ gap: 1, children: children.map((child) => Box({ width, children: child })) })
}

export function Panel({ title, children }: { readonly title: string; readonly children?: RenderChildren }): RenderElement {
  return Box({ flexDirection: 'column', flexGrow: 1, borderStyle: 'round', borderColor: 'subtle', paddingX: 1, children: [Text({ bold: true, children: title }), children] })
}

export function Toggle({ label, checked, onChange }: { readonly label: string; readonly checked: boolean; readonly onChange: (checked: boolean) => void }): RenderElement {
  return Button({ plain: true, key: `toggle:${label}`, label: `${checked ? '[x]' : '[ ]'} ${label}`, onPress: () => onChange(!checked) })
}

export function Tooltip({ text, children }: { readonly text: string; readonly children?: RenderChildren }): RenderElement {
  return Box({ key: `tooltip:${text}`, children: [children, card(text, false)] })
}

export function Help({ text, isOpen, onOpenChange }: { readonly text: string; readonly isOpen: boolean; readonly onOpenChange: (isOpen: boolean) => void }): RenderElement {
  return Box({ key: `help:${text}`, children: [Button({ plain: true, key: `help-button:${text}`, label: '?', onPress: () => onOpenChange(!isOpen) }), card(text, isOpen)] })
}

export function Dialog({ title, children, actions }: { readonly title: string; readonly children?: RenderChildren; readonly actions: RenderChildren }): RenderElement {
  return Box({ flexDirection: 'column', gap: 1, paddingX: 1, children: [Text({ bold: true, children: title }), children, Box({ gap: 2, children: actions })] })
}

export function Pagination({ page, pages, onPage }: { readonly page: number; readonly pages: number; readonly onPage: (page: number) => void }): RenderElement {
  return Box({
    gap: 2,
    children: [
      page > 1 ? Button({ plain: true, hotkey: 'p', label: 'Previous', onPress: () => onPage(page - 1) }) : Text({ dimColor: true, children: 'p: Previous' }),
      Text({ dimColor: true, children: `${page} of ${pages}` }),
      page < pages ? Button({ plain: true, hotkey: 'n', label: 'Next', onPress: () => onPage(page + 1) }) : Text({ dimColor: true, children: 'n: Next' }),
    ],
  })
}

export function ProgressBar({ done, total, width = 24 }: { readonly done: number; readonly total: number; readonly width?: number }): RenderElement {
  const filled = total > 0 ? Math.round(Math.min(done / total, 1) * width) : 0
  return Text({ children: [Text({ color: 'claude', children: '█'.repeat(filled) }), Text({ color: 'subtle', children: '░'.repeat(width - filled) }), '  ', Text({ dimColor: true, children: `${done}/${total}` })] })
}

const cardColumns = 36

function card(text: string, isShown: boolean): RenderElement {
  return Box({
    position: 'absolute',
    bottom: 1,
    left: 0,
    width: Math.min(text.length + 2, cardColumns),
    ...(isShown ? {} : { display: 'none' as const, hover: { display: 'flex' as const } }),
    backgroundColor: 'text',
    paddingX: 1,
    children: Text({ color: 'inverseText', wrap: 'wrap', children: text }),
  })
}
