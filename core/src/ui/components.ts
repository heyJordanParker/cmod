import { Box, Button, drawnIn, hostComponent, Text, type Color } from './elements.js'

export type Tab = { readonly key: string; readonly label: string; readonly hotkey?: string }

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'critical'

type Pressed = () => void

const toneColors: Readonly<Record<Tone, string | undefined>> = { neutral: undefined, info: 'suggestion', success: 'success', warning: 'warning', critical: 'error' }

const textOf = (tone: Tone) => {
  const color = toneColors[tone]
  return color === undefined ? { dimColor: true } : { color }
}

export const Tabs = hostComponent(
  'Tabs',
  ({ tabs, selected, onSelect, children }: { readonly tabs: readonly Tab[]; readonly selected: string; readonly onSelect: (key: string) => void; readonly children?: JSX.Children }) => ({
    key: '',
    tabs: tabs.map(({ key, label, hotkey }) => ({ key, label, ...(hotkey === undefined ? {} : { hotkey }), isSelected: key === selected, onSelect: () => onSelect(key) })),
    ...(children === undefined ? {} : { children }),
  }),
  ({ key: prefix, tabs, children }: { readonly key: string; readonly tabs: readonly (Tab & { readonly isSelected: boolean; readonly onSelect: Pressed })[]; readonly children?: JSX.Children }) => {
    const row = tabs.map(({ key, label, hotkey, isSelected, onSelect }) =>
      isSelected
        ? Text({ children: [...(hotkey === undefined ? [] : [Text({ color: 'claude', children: hotkey }), ': ']), Text({ bold: true, underline: true, children: label })] })
        : Button({ plain: true, dimColor: true, key: `${prefix}tab:${key}`, ...(hotkey === undefined ? {} : { hotkey }), label, onPress: onSelect }),
    )
    return Box({ flexDirection: 'column', gap: 1, children: [Box({ gap: 3, children: row }), children] })
  },
)

export const Split = hostComponent(
  'Split',
  ({ children }: { readonly children: readonly JSX.Element[] }) => ({ children }),
  ({ children }: { readonly children: readonly JSX.Element[] }) => {
    const width = `${Math.floor(100 / Math.max(children.length, 1))}%`
    return Box({ gap: 1, children: children.map((child) => Box({ width, children: child })) })
  },
)

type PanelProps = { readonly title: string; readonly description?: string; readonly actions?: JSX.Children; readonly children?: JSX.Children }

export const Panel = hostComponent(
  'Panel',
  ({ title, description, actions, children }: PanelProps): PanelProps => ({ title, ...(description === undefined ? {} : { description }), ...(actions === undefined ? {} : { actions }), ...(children === undefined ? {} : { children }) }),
  ({ title, description, actions, children }: PanelProps) => {
    const header = description === undefined && actions === undefined ? [] : [Box({ justifyContent: 'space-between', columnGap: 2, flexWrap: 'wrap', children: [Text({ dimColor: true, wrap: 'wrap', children: description ?? '' }), ...(actions === undefined ? [] : [Box({ gap: 2, flexShrink: 0, children: actions })])] })]
    return Box({
      flexDirection: 'column',
      flexGrow: 1,
      children: [
        Box({ flexDirection: 'column', flexGrow: 1, gap: header.length === 0 ? 0 : 1, minWidth: [...title].length + 6, borderStyle: 'round', borderColor: 'subtle', paddingX: 1, children: [...header, children] }),
        Box({ position: 'absolute', top: 0, left: 2, children: Text({ bold: true, wrap: 'truncate-end', children: ` ${title} ` }) }),
      ],
    })
  },
)

export const Toggle = hostComponent(
  'Toggle',
  ({ label, checked, onChange }: { readonly label: string; readonly checked: boolean; readonly onChange: (checked: boolean) => void }) => ({ key: '', label, checked, onToggle: () => onChange(!checked) }),
  ({ key, label, checked, onToggle }: { readonly key: string; readonly label: string; readonly checked: boolean; readonly onToggle: Pressed }) => Button({ plain: true, key: `${key}toggle:${label}`, label: `${checked ? '[x]' : '[ ]'} ${label}`, onPress: onToggle }),
)

const cardColumns = 36

function card(text: string, isShown: boolean): JSX.Element {
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

export const Tooltip = hostComponent(
  'Tooltip',
  ({ text, children }: { readonly text: string; readonly children?: JSX.Children }) => ({ key: '', text, ...(children === undefined ? {} : { children }) }),
  ({ key, text, children }: { readonly key: string; readonly text: string; readonly children?: JSX.Children }) => Box({ key: `${key}tooltip:${text}`, children: [children, card(text, false)] }),
)

export const Help = hostComponent(
  'Help',
  ({ text, isOpen, onOpenChange }: { readonly text: string; readonly isOpen: boolean; readonly onOpenChange: (isOpen: boolean) => void }) => ({ key: '', text, isOpen, onToggle: () => onOpenChange(!isOpen) }),
  ({ key, text, isOpen, onToggle }: { readonly key: string; readonly text: string; readonly isOpen: boolean; readonly onToggle: Pressed }) =>
    Box({ key: `${key}help:${text}`, children: [Button({ plain: true, key: `${key}help-button:${text}`, label: '?', onPress: onToggle }), card(text, isOpen)] }),
)

export const Dialog = hostComponent(
  'Dialog',
  ({ title, children, actions }: { readonly title: string; readonly children?: JSX.Children; readonly actions: JSX.Children }) => ({ title, actions, ...(children === undefined ? {} : { children }) }),
  ({ title, children, actions }: { readonly title: string; readonly children?: JSX.Children; readonly actions: JSX.Children }) =>
    Box({ flexDirection: 'column', gap: 1, paddingX: 1, children: [Text({ bold: true, children: title }), children, Box({ gap: 2, children: actions })] }),
)

export const Pagination = hostComponent(
  'Pagination',
  ({ page, pages, onPage }: { readonly page: number; readonly pages: number; readonly onPage: (page: number) => void }) => ({
    page,
    pages,
    ...(page > 1 ? { onPrevious: () => onPage(page - 1) } : {}),
    ...(page < pages ? { onNext: () => onPage(page + 1) } : {}),
  }),
  ({ page, pages, onPrevious, onNext }: { readonly page: number; readonly pages: number; readonly onPrevious?: Pressed; readonly onNext?: Pressed }) =>
    Box({
      gap: 2,
      children: [
        onPrevious === undefined ? Text({ dimColor: true, children: 'p: Previous' }) : Button({ plain: true, hotkey: 'p', label: 'Previous', onPress: onPrevious }),
        Text({ dimColor: true, children: `${page} of ${pages}` }),
        onNext === undefined ? Text({ dimColor: true, children: 'n: Next' }) : Button({ plain: true, hotkey: 'n', label: 'Next', onPress: onNext }),
      ],
    }),
)

export type ProgressSection = { readonly value: number } & ({ readonly tone?: Tone } | { readonly color: Color })

type ProgressProps = ({ readonly value: number; readonly tone?: Tone } | { readonly sections: readonly ProgressSection[] }) & { readonly buffer?: number; readonly width?: number; readonly label?: string }

type ProgressData = { readonly value: number; readonly width: number; readonly label?: string; readonly sections?: readonly ProgressSection[]; readonly buffer?: number }

const eighths = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

const roundedLeft = '\u{E0B6}'

const roundedRight = '\u{E0B4}'

const barColors: Readonly<Record<Tone, string>> = { neutral: 'inactive', info: 'suggestion', success: 'success', warning: 'warning', critical: 'error' }

function filledSections(sections: readonly ProgressSection[]): ProgressSection[] {
  let reached = 0
  return sections.map((section) => {
    const filled = Math.min(Math.max(section.value, 0), 100 - reached)
    reached += filled
    return { ...section, value: filled }
  })
}

export const Progress = hostComponent(
  'Progress',
  ({ width = 24, label, buffer, ...given }: ProgressProps): ProgressData => {
    const sections = 'sections' in given ? filledSections(given.sections) : given.tone === undefined ? undefined : filledSections([given])
    const value = sections === undefined && 'value' in given ? Math.min(Math.max(given.value, 0), 100) : (sections ?? []).reduce((sum, each) => sum + each.value, 0)
    const buffered = buffer === undefined ? undefined : Math.min(Math.max(buffer, value), 100)
    return { value, width, ...(label === undefined ? {} : { label }), ...(sections === undefined ? {} : { sections }), ...(buffered === undefined || buffered === value ? {} : { buffer: buffered }) }
  },
  ({ value, width, sections, buffer }: ProgressData) => {
    const isRounded = drawnIn().hasNerdFont && width > 2
    const cells = isRounded ? width - 2 : width
    const units = cells * eighths.length
    let reached = 0
    const ends = (sections ?? [{ value }]).map((section) => {
      reached += section.value
      return { end: Math.round((reached / 100) * units), color: 'color' in section ? section.color : section.tone === undefined ? 'claude' : barColors[section.tone] }
    })
    const buffered = Math.round(((buffer ?? 0) / 100) * units)
    const colorAt = (unit: number) => ends.find(({ end }) => unit < end)?.color ?? (unit < buffered ? 'promptBorder' : 'subtle')
    const drawn: BarCell[] = []
    for (let cell = 0; cell < cells; cell++) {
      const from = cell * eighths.length
      const left = colorAt(from)
      const right = colorAt(from + eighths.length - 1)
      let edge = 1
      while (edge < eighths.length && colorAt(from + edge) === left) edge++
      drawn.push(left === right ? { color: left, children: '█' } : { color: left, backgroundColor: right, children: eighths[edge] ?? '█' })
    }
    const capped = isRounded ? [{ color: colorAt(0), children: roundedLeft }, ...drawn, { color: colorAt(units - 1), children: roundedRight }] : drawn
    return Text({ children: runsOf(capped).map((run) => Text(run)) })
  },
)

type BarCell = { color: string; backgroundColor?: string; children: string }

function runsOf(cells: readonly BarCell[]): BarCell[] {
  const runs: BarCell[] = []
  for (const cell of cells) {
    const last = runs.at(-1)
    if (last !== undefined && last.color === cell.color && last.backgroundColor === cell.backgroundColor && last.children !== roundedLeft && cell.children !== roundedRight) last.children += cell.children
    else runs.push({ ...cell })
  }
  return runs
}

export const List = hostComponent(
  'List',
  ({ label, children }: { readonly label: string; readonly children?: JSX.Children }) => ({ label, ...(children === undefined ? {} : { children }) }),
  ({ children }: { readonly label: string; readonly children?: JSX.Children }) => Box({ flexDirection: 'column', children }),
)

type ListItemShared = { readonly key: string; readonly label: string; readonly description?: string; readonly leading?: string; readonly trailing?: JSX.Children; readonly tone?: Tone | 'off'; readonly isSelected?: boolean; readonly depth?: number; readonly isOpen?: boolean; readonly onPress?: Pressed }

type ListItemProps = ListItemShared & { readonly onOpenChange?: (isOpen: boolean) => void }

type ListItemData = ListItemShared & { readonly onToggle?: Pressed }

const statusOf = (tone: ListItemProps['tone']) => (tone === undefined ? [] : [tone === 'off' ? Text({ dimColor: true, children: '○ ' }) : Text({ ...textOf(tone), children: '● ' })])

function treeRow({ key, label, description, leading, trailing, tone, isSelected, depth = 0, isOpen, onToggle, onPress }: ListItemData): JSX.Element {
  const opener = isOpen !== undefined && onToggle !== undefined ? Button({ plain: true, key: `${key}:toggle`, onPress: onToggle, children: Text({ dimColor: true, children: isOpen ? '▾' : '▸' }) }) : Text({ children: ' ' })
  const shown = Text({ wrap: 'truncate-end', ...(isSelected === true ? { bold: true } : {}), children: [...statusOf(tone), ...(leading === undefined ? [] : [Text({ dimColor: true, children: `${leading} ` })]), label] })
  const row = Box({ columnGap: 1, minWidth: 0, children: [opener, onPress === undefined ? shown : Button({ plain: true, key, onPress, children: shown })] })
  const end = [...(description === undefined ? [] : [Text({ dimColor: true, children: description })]), ...(trailing === undefined ? [] : [trailing])]
  if (end.length === 0) return Box({ paddingLeft: depth * 2, children: row })
  return Box({ width: '100%', paddingLeft: depth * 2, columnGap: 1, justifyContent: 'space-between', children: [row, Box({ flexShrink: 0, columnGap: 1, children: end })] })
}

export const ListItem = hostComponent(
  'ListItem',
  ({ onOpenChange, ...props }: ListItemProps): ListItemData => ({ ...props, ...(onOpenChange === undefined || props.isOpen === undefined ? {} : { onToggle: () => onOpenChange(props.isOpen !== true) }) }),
  (props: ListItemData) => {
    const { key, label, description, leading, trailing, tone, isSelected, depth, onPress } = props
    if (depth !== undefined) return treeRow(props)
    const shown = [...statusOf(tone), ...(leading === undefined ? [] : [Text({ dimColor: true, children: `${leading} ` })]), label, ...(description === undefined ? [] : [Text({ dimColor: true, children: ` ${description}` })]), ...(trailing === undefined ? [] : [' ', trailing])]
    if (isSelected === true || onPress === undefined) return Box({ ...(isSelected === true ? { backgroundColor: 'userMessageBackground' } : {}), paddingX: 1, children: Text({ wrap: 'truncate-end', ...(isSelected === true ? { bold: true } : {}), children: shown }) })
    return Box({ paddingX: 1, children: Button({ plain: true, dimColor: true, key, onPress, children: shown }) })
  },
)

export const Badge = hostComponent(
  'Badge',
  ({ tone = 'neutral', children }: { readonly tone?: Tone; readonly children: JSX.Children }) => ({ tone, children }),
  ({ tone, children }: { readonly tone: Tone; readonly children: JSX.Children }) => Text({ ...textOf(tone), children }),
)

const wordsOf = (children: JSX.Children): string | undefined => {
  const all = [children].flat(Infinity as 1).filter((each) => each !== null && each !== undefined && typeof each !== 'boolean')
  return all.every((each) => typeof each === 'string' || typeof each === 'number') ? all.join('') : undefined
}

export const Banner = hostComponent(
  'Banner',
  ({ tone = 'info', title, children, actions }: { readonly tone?: Tone; readonly title?: string; readonly children?: JSX.Children; readonly actions?: JSX.Children }) => ({ tone, ...(title === undefined ? {} : { title }), ...(children === undefined ? {} : { children }), ...(actions === undefined ? {} : { actions }) }),
  ({ tone, title, children, actions }: { readonly tone: Tone; readonly title?: string; readonly children?: JSX.Children; readonly actions?: JSX.Children }) =>
    Box({
      flexDirection: 'column',
      children: [
        ...(title === undefined ? [] : [Text({ ...textOf(tone), bold: true, wrap: 'wrap', children: title })]),
        ...(children === undefined ? [] : [wordsOf(children) === undefined ? children : Text({ ...(title === undefined ? textOf(tone) : {}), wrap: 'wrap', children: wordsOf(children) })]),
        ...(actions === undefined ? [] : [Box({ gap: 2, flexShrink: 0, children: actions })]),
      ],
    }),
)
