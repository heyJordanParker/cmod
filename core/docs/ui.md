# UI

A mod draws in five ways: pages in the Sidebar and in Settings, panes of its own, widgets the person places around the prompt and on the Dashboard, styles that change how Claude Code draws a row or a block of a reply, and short messages: toasts and questions. Each part is added with one `add` call in `setup`, and each call returns the part, with `remove()` to take it back.

```ts
mod.sidebar.add<Params>(page: PageInit<State, Params>): Page<Params>
mod.settings.add<Params>(page: PageInit<State, Params>): Page<Params>
mod.settings.open(): Promise<void>
mod.panes.add<Params>(pane: PaneInit<State, Params>): Pane<Params>
mod.widgets.add(widget: WidgetInit<State>): Widget
mod.styles.add<K extends Kind>(style: StyleInit<K, State>): Style
mod.toast: Toast
mod.ask(question: string, options?: readonly string[] | AskOptions): Promise<string>
```

`mod.js` exports the types: `PageInit`, `Page`, `PageProps`, `PaneInit`, `Pane`, `PaneProps`, `OpenOptions`, `ScrollTarget`, `ScrollOptions`, `WidgetInit`, `Widget`, `WidgetContext`, `Area`, `StyleInit`, `Style`, `StyleProps`, `Kind`, and `Row`.

Claude Mod Manager (cmod) draws the mod again whenever a value in `mod.state` changes. A render reads `mod.state` and returns what to show. It never draws by hand.

## Every message the person acts on carries a button

A mod never asks the person to type a command. When a toast, a page, or a pane needs the person to do something, it draws a `Button` that does it, or that opens the place where they do it, such as `mod.settings.open()` or a page's `open()`. cmod follows the same rule: a failure caused by a provider that is not installed carries a `Plugins` button, and a secret option carries an `Open /config` button. A failure caused by a permission the person turned off shows no toast, because the person chose it, and goes to the Log in Settings.

## Elements

`ui/elements.js` exports the elements a render draws with. Each takes the props Claude Code types in the `claude-code` module:

- `Box`, with `BoxProps`, draws a flex container: `flexDirection`, `gap`, `padding`, `margin`, `minWidth`, and the rest.
- `Text`, with `TextProps`, draws text: `bold`, `dimColor`, `color`, `wrap`, and the rest.
- `Button`, with `ButtonProps`, draws a button: `label` or one string child, `onPress`, `hotkey`, `key`, `variant`.
- `Link`, with `LinkProps`, draws a link.
- `Code`, with `CodeProps`, draws highlighted code.
- `Markdown`, with `MarkdownProps`, draws markdown text, as Claude Code draws a reply.
- `Input`, with `InputProps`, draws a text input. It is one line tall unless `rows` says more: `rows: 4` draws four lines that wrap, as a `<textarea>`, for a note or a comment.
- `Select`, with `SelectProps`, draws a choice of options.
- `Image`, with `ImageProps`, draws an image, with `alt` text. Only the terminal draws it.
- `Raster`, with `RasterProps`, draws a grid of terminal cells, each a glyph with its colors. Only the terminal draws it.
- `Svg`, with `SvgProps`, draws an SVG drawing, with `alt` text. The desktop and phone apps draw it, and the terminal does not.
- `Client`, with `ClientProps`, draws a region the mod's own surface module draws and handles input for, named by `module`, a string literal path such as `'./board.tsx'`. It draws only in a pane or a style. A page or widget that draws it shows `The <title> page could not draw` with `Client draws only in panes and styles.` under it.

Claude Code refuses a whole drawing that holds an element its app does not draw, and draws its own instead. A style reads `surface` to pick what to draw, and a pane reads it from its props.

Write them as JSX in a `.tsx` file. The template's `tsconfig.json` sets `jsx: react` with `jsxFactory: h` and `jsxFragmentFactory: Fragment`. Claude Code declares `h` and `Fragment` as globals, and `testMod` supplies them in tests. Never declare, import, or name anything `h` or `Fragment` in a file that writes JSX. A component is a function that returns a `RenderElement`:

```tsx
import type { RenderElement } from 'claude-code'
import { Box, Text } from '../node_modules/@cmodjs/core/ui/elements.js'

export function Count({ label, count }: { readonly label: string; readonly count: number }): RenderElement {
  return (
    <Box gap={1}>
      <Text bold>{label}</Text>
      <Text dimColor>{`${count}`}</Text>
    </Box>
  )
}
```

An element built outside a render, at module load or in a hook, holds its props until a render draws it. So a hook can build a toast's `description` and the band draws it later.

`drawWith(table, draw, markdown?)` is the function cmod draws a render with. A mod never calls it.

## Components

`ui/components.js` exports controls built from the elements and Claude Code's theme colors, so they follow the person's theme and look the same in every mod. Each is a component like the ones a mod writes: a function of props, used in a render.

```ts
Tabs(props: { tabs: readonly { key: string; label: string; hotkey?: string }[]; selected: string; onSelect(key: string): void; children? })
Split(props: { children: readonly RenderElement[] })
Panel(props: { title: string; children? })
Toggle(props: { label: string; checked: boolean; onChange(checked: boolean): void })
Tooltip(props: { text: string; children? })
Help(props: { text: string; isOpen: boolean; onOpenChange(isOpen: boolean): void })
Dialog(props: { title: string; children?; actions })
Pagination(props: { page: number; pages: number; onPage(page: number): void })
Progress(props: { value: number; width?: number })
```

- `Tabs` draws a row of tabs over `children`. The selected tab's label is bold and underlined. Each other tab is a `Button`, so a part that holds the keyboard switches tabs by Tab and Enter or a click. A tab given a `hotkey`, one digit or one lowercase letter, draws it before its label, as `o: Open`, and that key switches to it. Leave the Sidebar's digits to the Sidebar: inside a page, a tab's hotkey that matches one replaces it.
- `Split` lays its children side by side in equal widths. `Panel` frames one part of a page or pane in a rounded border with its bold title in the top border, as `╭─ Changed files ──╮`, grows to fill the room its parent gives it, and is never narrower than its title.
- `Toggle` draws `[x] label` or `[ ] label` as a `Button`. Enter or a click calls `onChange` with the other value.
- `Tooltip` shows `text` in an inverted card above its children while the pointer rests on them. The card opens upward, because Claude Code paints a card over the rows drawn before it and under the rows drawn after it. It has no border, so a one-line card needs one free row above its children. The pointer alone opens it, so put nothing only a tooltip says.
- `Help` draws a `?` that shows `text` the same way. A press of `?` keeps the card open until the next press, so the keyboard reaches it too. Keep `isOpen` in `mod.state`.
- `Dialog` lays out a dialog's title, body, and `actions`, the buttons in a row. Put the safe action first, as the `primary` Button with `autoFocus`.
- `Pagination` draws `p: Previous  2 of 5  n: Next`. `p` and `n` are its hotkeys, and an end it cannot pass is dim text.
- `Progress` fills `value` percent of `width` columns, 24 unless given. Put the count or a label beside it in a `Text`, or pass it as a loading toast's `description`.
- `Tabs`, `Toggle`, `Help`, and `Pagination` hold no state of their own. Keep their value in `mod.state` and set it in the callback, as in React's controlled components.

## The Sidebar and its pages

The Sidebar is one pane the cmod plugin draws beside the conversation for every mod. Its tabs are the Dashboard, the pages mods opened, and Settings. A mod that asks the person to install it, to set an option, or to finish a step opens its install page there, the `Install <mod>` tab ([install-steps.md](install-steps.md#consent)). The person shows or hides it with `meta+0`, switches tabs with `0` for the Dashboard, `1` to `8` for the pages, and `9` for Settings, and closes a page with the `×` on its tab. They change both combos in Settings, under cmod, Hotkeys.

A page is a part of a mod that draws in the Sidebar. Put each page in its own file in `src/pages/`:

```tsx
import type { PageInit } from '../../node_modules/@cmodjs/core/mod.js'
import { Box, Button, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'

export type NotesState = { global: { notes: readonly string[] } }

export const notesPage: PageInit<NotesState> = {
  id: 'notes',
  title: 'Notes',
  render: (mod) => (
    <Box flexDirection="column" gap={1}>
      {mod.state.global.notes.map((note) => <Text>{note}</Text>)}
      <Button label="Clear" onPress={() => { mod.state.global.notes = [] }} />
    </Box>
  ),
}
```

```ts
type PageInit<State, Params = undefined> = {
  readonly id: string
  readonly title: string
  render(mod: Mod<State>, props: { readonly params: Params; readonly isFocused: boolean; readonly columns: number }): RenderElement
}

type Page<Params = undefined> = {
  readonly id: string
  readonly isOpen: boolean
  readonly isShown: boolean
  readonly isFocused: boolean
  readonly params: Params | undefined
  open(options?: { readonly params?: Params; readonly focus?: true }): Promise<void>
  toggle(options?: { readonly focus?: true }): Promise<void>
  close(): Promise<void>
  scrollTo(target: 'start' | 'end' | { readonly key: string }, options?: { readonly block?: 'start' | 'center' | 'end' | 'nearest' }): Promise<void>
  remove(): void
}
```

- `id` is 1 to 64 letters, digits, `_`, or `-`, unique among the mod's pages. `title` labels the page's tab. Either one missing throws `<mod>: "<id>" is not a page id.` or `<mod>: the page "<id>" needs a title, the label its tab shows.`
- `mod.sidebar.add(page)` adds the page and returns it. Adding two pages with one id throws `<mod>: the page "<id>" is already added. Give each page its own id.`
- `open` shows the page as a tab of the Sidebar, and shows the Sidebar. `params` is what the page shows, such as a run's number, and the page reads it as `props.params`. A page whose `Params` is not `undefined` must be given `params`. `{ focus: true }` gives it the keyboard.
- `toggle` closes an open page and opens a closed one. `close` takes its tab away, and the Sidebar hides once no page is left.
- `isOpen` is true while the page has a tab, `isShown` while its tab is the one on screen, and `isFocused` while it has the keyboard.
- `scrollTo` brings an element the page drew with that `key` into view, or the page's start or end.
- `props.columns` is the width the page draws in. The Sidebar draws the page in a panel titled with the mod's name, under its tab bar and above its key bar, so `columns` is the Sidebar's width less 6: its padding of one column on each side, and the panel's border and padding.
- A page opened from what the person did, such as a slash command they typed, a hotkey, or a `Button` they pressed, shows at any terminal width. A page opened from anything else, such as `setup`, a timer, or a listener, shows only on a terminal 144 columns wide. Below that it waits until the person opens the Sidebar.
- A page draws only the elements of `ui/elements.js` and `ui/components.js`, text, numbers, and plain objects, because the cmod plugin draws it. A `Button`'s `onPress` runs in the mod.
- A `render` that throws draws nothing, and cmod shows the error toast `The <title> page could not draw` once, until the page draws again.

A hotkey is the usual way in:

```tsx
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { notesPage, type NotesState } from './pages/notes.js'

const initialState: NotesState = { global: { notes: [] } }

export const notes = defineMod({
  name: 'notes',
  state: initialState,
  hotkeys: {
    toggle: { title: 'Show or hide the notes', default: 'alt+shift+n' },
  },
  setup(mod) {
    const page = mod.sidebar.add(notesPage)
    mod.hotkeys.toggle.onPress(() => page.toggle({ focus: true }))
  },
})
```

### Settings pages

`mod.settings.add(page)` adds a page to the mod's entry in Settings, beside the Options, Permissions, Hotkeys, and Changelog cmod draws for every mod. It takes the same `PageInit` and returns the same `Page`. `mod.settings.open()` shows Settings at the mod's entry. `/mods` and `meta+m` open Settings too.

## Panes

A pane is a framed region of the mod's own, outside the Sidebar. Claude Code docks it beside the transcript in fullscreen, or shows it above the prompt. Use a page unless the part needs its own size, its own Escape, or to hold back toasts, as a dialog does.

```ts
type PaneInit<State, Params = undefined> = {
  readonly id: string
  readonly title: string
  readonly columns?: number | ((state: State) => number | undefined)
  readonly rows?: number | ((state: State) => number | undefined)
  readonly closeOnEscape?: true
  readonly holdToasts?: true
  render(mod: Mod<State>, props: PaneProps<Params>): RenderElement
  onScroll?(mod: Mod<State>, e: Frozen<UiScrollInput>): void | Promise<void>
  onClose?(mod: Mod<State>, e: Frozen<PaneCloseInput>): void | Promise<void>
}
```

`mod.panes.add(pane)` adds the pane and returns a `Pane`, with the same members as a `Page`.

- `id` is 1 to 64 letters, digits, `_`, or `-`. Another id throws `<mod>: "<id>" is not a pane id.`
- `title` labels the pane's tab while more than one pane is open.
- `columns` and `rows` ask for a size. A number must be a whole number above 0, or `mod.panes.add` throws. A function reads the state and returns the size, or `undefined` for Claude Code's default. When the state changes the size, cmod resizes an open pane.
- `closeOnEscape` closes the pane when the person presses Escape while it holds the keyboard. Left out, Escape gives the keyboard back to the prompt and the pane stays.
- `holdToasts` holds every toast back while the pane is shown, the toasts of other plugins and of Claude Code included. Use it for a pane the person answers and closes, never for one that stays open.
- `render` draws the pane's body. `props` holds `params`, `surface`, the app that draws it, `title`, `isFocused`, `bodyColumns`, `placement` (`'dock'` or `'inline'`), `scroll`, and `view`, which transcript is on screen beside the pane.
- `onScroll` runs after this pane's window moved. `onClose` runs after the pane closed, by the person or by `close()`, and `e.origin.kind` is `'person'` or `'plugin'`. A handler that throws shows the error toast `The <title> pane's <handler> threw`.
- `open` asks Claude Code to show the pane, and `isOpen` turns true once Claude Code places it. A pane opened from what the person did shows at any width, and one opened from anything else only at 144 columns, or 110 for a pane the person opened before.
- Adding two panes with one id throws `<mod>: the pane "<id>" is already added. Give each pane its own id.`
- A `render` that throws draws `The <title> pane could not draw: <error>` in the pane.

A pane with `closeOnEscape` and `holdToasts`, opened with `focus`, is a dialog:

```tsx
import type { PaneInit } from '../../node_modules/@cmodjs/core/mod.js'
import { Dialog } from '../../node_modules/@cmodjs/core/ui/components.js'
import { Button, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'

export const confirmPane: PaneInit<{ session: { deleting: boolean } }> = {
  id: 'delete-branch',
  title: 'Delete branch',
  rows: 9,
  closeOnEscape: true,
  holdToasts: true,
  render: (mod) => (
    <Dialog
      title="Delete the branch feature/kit?"
      actions={[
        <Button variant="primary" autoFocus label="Keep it" onPress={() => void mod.toast('Kept feature/kit')} />,
        <Button label="Delete" onPress={() => void (mod.state.session.deleting = true)} />,
      ]}
    >
      <Text dimColor wrap="wrap">Its 3 commits are not on main. Deleting it removes them from this machine.</Text>
    </Dialog>
  ),
}
```

Open it with `mod.panes.add(confirmPane).open({ focus: true })`. It draws as:

```text
 Delete branch                                                    ✕
 Delete the branch feature/kit?

 Its 3 commits are not on main. Deleting it removes them from
 this machine.

 [ Keep it ]  [ Delete ]
```

## Widgets

A widget is a small piece of a mod, such as the branch, a CI status, or a cost, that the person places. The mod says which areas a widget can draw in, and the person decides where it draws, in which row, on which side, or whether it draws at all.

```ts
type WidgetInit<State> = {
  readonly id: string
  readonly title: string
  readonly areas: readonly [Area, ...Area[]]
  readonly place?: { readonly side?: 'left' | 'right'; readonly size?: 'fit' | 'fill' }
  render(mod: Mod<State>, context: WidgetContext): RenderElement | undefined
}

type WidgetContext =
  | { readonly area: typeof TurnEnd; readonly columns: number; readonly turn: Turn }
  | { readonly area: Exclude<Area, typeof TurnEnd>; readonly columns: number }

type Widget = { readonly id: string; readonly area: Area | undefined; remove(): void }
```

`mod.js` exports the five areas:

- `AbovePrompt` draws above the prompt, in the band where toasts draw. Nothing draws there while Claude Code shows a survey.
- `BelowPrompt` draws below the prompt, under Claude Code's hint line.
- `Working` draws under the spinner, while Claude works.
- `TurnEnd` draws under the line that closes each turn, in the transcript.
- `Dashboard` draws on the Sidebar's Dashboard tab.

- `id` is 1 to 64 letters, digits, `_`, or `-`, unique in the mod. `title` names the widget in Settings, under cmod, Widgets.
- `areas` lists where the person may place the widget. A new widget first draws in the first row of its first area. `area` on the returned `Widget` is where the person placed it.
- `place.side` is the side of that row a new widget lands on: `'left'`, the default, or `'right'`.
- `place.size` is how wide the widget draws. `'fit'`, the default, keeps the widget's own width and never shrinks. `'fill'` gives up width when its line runs short, so the `fit` widgets beside it stay whole.
- A `fill` widget draws its text with `wrap: 'truncate-end'`, so the text ends in `…` where its width runs out. Text that wraps breaks into lines instead.
- `render` returns the widget's elements, or `undefined` to draw nothing now. `columns` is the width of the row it draws in.
- In `TurnEnd`, `context.turn` is the [turn](session.md#turn) that closed, so a widget there reads its answer, failure, or usage.
- A widget draws only the elements of `ui/elements.js` and `ui/components.js`, text, numbers, and plain objects. A `Button`'s `onPress` runs in the mod.
- A `render` that throws draws nothing, and cmod shows the error toast `The <title> widget could not draw` once, until the widget draws again. The widgets beside it still draw.
- Adding two widgets with one id throws `<mod>: the widget "<id>" is already added. Give each widget its own id.`

```tsx
import { BelowPrompt, Dashboard, type WidgetInit } from '../../node_modules/@cmodjs/core/mod.js'
import { Text } from '../../node_modules/@cmodjs/core/ui/elements.js'

export const promptsWidget: WidgetInit<{ session: { prompts: number } }> = {
  id: 'prompts',
  title: 'Prompt count',
  areas: [BelowPrompt, Dashboard],
  render: (mod) => <Text dimColor>{`Prompts: ${mod.state.session.prompts}`}</Text>,
}
```

This mod places a path on the left of the row below the prompt, and its usage, branch, time, and date on the right. The path and the usage are `fill` widgets, so they give up width when the row runs short, and the branch, time, and date always keep their full text.

```tsx
import { BelowPrompt, defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { Text } from '../node_modules/@cmodjs/core/ui/elements.js'

export const status = defineMod({
  name: 'status',
  state: { session: { path: '', usage: '', branch: '', time: '', date: '' } },
  setup(mod) {
    mod.widgets.add({ id: 'path', title: 'Path', areas: [BelowPrompt], place: { size: 'fill' }, render: (current) => <Text wrap="truncate-end">{current.state.session.path}</Text> })
    mod.widgets.add({ id: 'usage', title: 'Usage', areas: [BelowPrompt], place: { side: 'right', size: 'fill' }, render: (current) => <Text wrap="truncate-end">{current.state.session.usage}</Text> })
    mod.widgets.add({ id: 'branch', title: 'Branch', areas: [BelowPrompt], place: { side: 'right' }, render: (current) => <Text>{current.state.session.branch}</Text> })
    mod.widgets.add({ id: 'time', title: 'Time', areas: [BelowPrompt], place: { side: 'right' }, render: (current) => <Text>{current.state.session.time}</Text> })
    mod.widgets.add({ id: 'date', title: 'Date', areas: [BelowPrompt], place: { side: 'right' }, render: (current) => <Text>{current.state.session.date}</Text> })
  },
})
```

### Where the person places widgets

The person arranges every mod's widgets in Settings, under cmod, Widgets. They pick a widget, then move it with `h`, `j`, `k`, and `l`, or the arrow buttons, and hide or show it with `x`.

- Each area holds rows, and each row has a left side and a right side.
- A row stays one line. Its `fill` widgets shorten first, and a row too narrow even for its `fit` widgets ends at its right edge, so the person moves a widget to another row in Settings.
- A widget the person moved stays where they put it, whatever its `place.side` says.
- Moving a widget down from the last row gives it a row of its own, and moving it down again, or up from the first row, takes it to the next area it can draw in.
- A hidden widget keeps its place and draws nothing.
- Claude Code's own hint and mode labels, below the prompt, show there too. The person can hide them, and never move them.
- The layout is one file for every session, `widgets.json` in the cmod store, so every running session follows a change at once.

## Styles: change how Claude Code draws

`mod.styles.add({ kind, render })` draws in place of one kind of row Claude Code draws, or one kind of markdown block in Claude's replies. It returns a `Style` with `remove()`, after which Claude Code draws that kind as before.

The rows a style changes:

- `Prompt`: a prompt row, the person's prompt, a task notification, or another session's message.
- `Reply`: one text block of Claude's reply.
- `ToolCall`: a tool call's row.
- `ToolResult`: a tool call's result.
- `Notice`: a dim status line under the logo.
- `ToolGroup`: the condensed row of a group of tool calls.
- `ToolProgress`: a tool's progress line.
- `CommandOutput`: a slash command's output.
- `AskUserQuestion`: the dialog the AskUserQuestion tool opens.
- `Working`: the spinner line while Claude works.
- `TurnEnd`: the line that closes a turn.

`render` gets the mod and `StyleProps<K>`: the props Claude Code draws that row with, plus `surface`, the app that draws it (`'terminal'`, `'desktop'`, `'mobile'`, or `'vscode'`), `columns`, how wide it is, `id`, which row it is, the same id on every draw of that row, and `Default`. A markdown block's `id` is its reply's, and a block outside a reply has none.

- `Default` draws what Claude Code, and the styles of other mods, would draw. Pass it props to change what it draws, such as `<Default word="Baked" />`. Return `<Default />` to change nothing.
- A style adds to what it wraps. In `Working`, drawing `<Default />` and a line under it keeps the lines of Claude Code and other mods.
- A style must draw the same for the same props. One that throws, or calls `Default` a different number of times on a second draw, falls back to Claude Code's drawing, and cmod shows the error toast `The <Kind> style failed` once, with the reason under it.
- A mod adds one style per kind. A second throws `<mod>: the style of <Kind> is already added. Add one style per kind.`
- `ToolCall` changes a call's own row. A group of calls shows the `ToolGroup` row, so a mod that hides a tool's input also sets `isExpanded` on `ToolGroup` to unfold the group into `ToolCall` rows.

```tsx
import { defineMod, sessions, TurnEnd } from '../node_modules/@cmodjs/core/mod.js'
import { Box, Text } from '../node_modules/@cmodjs/core/ui/elements.js'

export const turns = defineMod({
  name: 'turns',
  state: { session: { turns: 0 } },
  setup(mod) {
    mod.styles.add({
      kind: TurnEnd,
      render: (current, { Default }) => (
        <Box flexDirection="column">
          <Default />
          <Text dimColor>{`Turn ${current.state.session.turns}`}</Text>
        </Box>
      ),
    })
    sessions.current.onTurnEnd(() => {
      mod.state.session.turns += 1
    })
  },
})
```

### Markdown blocks

Each kind of markdown block of a reply is a kind of its own. `ui/markdown.js` exports them, apart from the rest, because it brings the markdown reader, about 230 KB that takes some 18 ms to load. A mod that imports none of them starts without it.

- `Heading`: a heading, with `depth`, 1 to 6.
- `Paragraph`: a paragraph.
- `CodeBlock`: a code block, with `lang`, `meta`, and `value`.
- `BlockQuote`: a block quote.
- `List`: a list, with `ordered`, `start`, and `spread`.
- `Table`: a table, with `align`.
- `ThematicBreak`: a `---` line.
- `HtmlBlock`: an HTML block, with `value`.

Every block's props hold `text`, its plain text, one line per list item, table row, or quoted line, and `source`, its markdown. `Default` draws the block as Claude Code would, and `<Default source="…" />` draws other markdown in its place. A style may call `Default` once per part, such as once per list item, quoted line, or table cell. In a pane, where the mod draws a `Markdown` element with a `key` through its own styles, the first `Default` takes that key and each later one takes it with `:1`, `:2`, and so on, because Claude Code refuses two `Markdown` elements with one key. While a reply streams in, Claude Code draws a block that is not finished yet, and the mod draws it once it is.

A markdown style draws wherever markdown shows: in Claude's replies and in every `Markdown` element any mod or cmod draws, in panes, pages, widgets, the Dashboard, Settings, and changelogs. A `Markdown` element goes through the styles of the mod that draws it first, then through each other mod's, in the order the mods added their first markdown style. A mod that removes its last markdown style and adds one again moves to the end. Another mod's style shows as soon as that mod has drawn the block, and Claude Code's drawing shows until then. When that mod does not answer, Claude Code's drawing stays, and cmod reports `The markdown style of <mod> drew nothing` to the Log, with the reason.

Claude Code refuses a whole drawing in which two `Input`, `Select`, `Markdown`, `Client`, `Raster`, or `Image` elements share a key. So cmod puts each block's place in front of every key its style draws, and the keys a style draws need be unique only within the one block it draws, as a component's keys are in React. The place is the block's number in its markdown, from `0`, after the `key` of the `Markdown` element that holds it, or that element's number among the ones drawn without a key. A block that draws again in its place keeps its keys, so Claude Code keeps what the person typed in its `Input`.

```tsx
import type { RenderElement } from 'claude-code'
import { defineMod, type StyleProps } from '../node_modules/@cmodjs/core/mod.js'
import { CodeBlock } from '../node_modules/@cmodjs/core/ui/markdown.js'
import { Text } from '../node_modules/@cmodjs/core/ui/elements.js'

function MermaidBlock({ lang, value, Default }: StyleProps<typeof CodeBlock>): RenderElement {
  return lang === 'mermaid' ? <Text>{`diagram: ${value}`}</Text> : <Default />
}

export const diagrams = defineMod({
  name: 'diagrams',
  setup(mod) {
    mod.styles.add({ kind: CodeBlock, render: (_mod, props) => <MermaidBlock {...props} /> })
  },
})
```

`markdownBlocks(text, kind)`, from `ui/markdown.js`, returns the props of every block of one kind in a markdown text, such as every code block of a reply:

```ts
import { CodeBlock, markdownBlocks } from '../node_modules/@cmodjs/core/ui/markdown.js'

const diagrams = markdownBlocks(reply, CodeBlock).filter((block) => block.lang === 'mermaid')
```

## Toasts

`mod.toast` shows the person a short message in the band above the prompt, one row per toast, under the mod's name. Its shape follows [Sonner](https://sonner.emilkowal.ski/toast):

```ts
mod.toast(message: string, options?: ToastOptions): ToastId
mod.toast.success(message, options?) / .info / .warning / .error / .loading
mod.toast.promise<T>(task: Promise<T> | (() => Promise<T>), messages: { loading: string; success: string | ((value: T) => string); error: string | ((error: unknown) => string) }): { unwrap(): Promise<T> }
mod.toast.dismiss(id?: ToastId): void

type ToastOptions = {
  id?: ToastId
  description?: string | RenderElement
  action?: { label: string; onClick(): unknown }
  duration?: number
}
```

- Each type draws its icon: `✓` success, `ℹ` info, `⚠` warning, `✗` error, and a spinner for loading.
- A toast stays 4 seconds once the band draws it, or `duration` ms. `Infinity` keeps it until the person closes it, and a loading toast stays until it changes.
- A toast with the `id` of a shown toast replaces it in place, so a loading toast turns into its success or error.
- A text `description` shows its first line dim under the message. A press on the message unfolds the whole text and stops the time. An element `description`, such as a `Progress`, draws as it is.
- `action` draws a button after the message. Give every toast that asks the person to do something an `action` that does it.
- `✕` closes the toast. The band shows the newest 3, and `+N more` shows every toast.
- `promise` shows `loading` while `task` runs, then `success` or `error` in the same row. `unwrap()` resolves or rejects as `task` does.

Every error cmod catches for a mod, such as a listener that throws, goes to the Log, in Settings on cmod's page. The Log keeps the newest 100 failures of every session, each with the mod, the time, the message, `Copy`, and `Report`, and the same failure again updates its entry.

An error also shows as a toast when any of these holds:

- it is critical: the mod's install or setup failed, its program stopped, or a button or hotkey the person pressed failed
- the mod runs from its checkout, linked with [`cmod link`](commands.md#cmod-link) or loaded with `--plugin-dir`, because the person is its author
- `Show errors from installed mods` is on, in Settings on cmod's page under Preferences

A refusal for a permission the mod declared and the person turned off, whose text ends in `Turn it on in Settings.`, shows no toast. It goes to the Log and to Claude Code's debug log. A cmod older than 4.3.0 keeps no Log, so there every error shows its toast, this one included.

The error toast stays, with its buttons on a line under the message:

- `Retry` runs the failed step again, where running it again can work: an install, the mod's setup, or a program that stopped.
- `Report` replaces the toast's buttons with the ways to tell the mod's author. `Ask Claude to report it` sends this session a prompt to file the report with the person's own tools. `Report it on GitHub (opens your browser)` opens a filled-in issue on the mod's `supportUrl` or `repository` in its `plugin.json`, or `Email the author (opens your mail app)` writes to its `author.email`. `Copy the error` copies the mod's name and version, the `@cmodjs/core` version, the message, the whole cause, and the stack.
- `Hide` closes the toast and keeps the same failure hidden in later sessions. A new version of the mod, or a different failure, shows again.

`clipboard.write(text)`, from `mod.js`, puts `text` on the person's clipboard. It rejects with Claude Code's reason when the terminal cannot take it.

## Questions

```ts
mod.ask(question: string, options?: readonly string[] | AskOptions): Promise<string>

type AskOptions = { options?: readonly string[]; header?: string; multiSelect?: true }
```

`ask` shows a question with 2 to 4 options and resolves the answer. Fewer than two options are padded with Yes and No, and the person may type an answer of their own. `header` is a short chip beside the question, 12 characters at most. `multiSelect` lets the person pick several, and the answer comes back joined by commas.

```ts
import { defineMod, process, sessions } from '../node_modules/@cmodjs/core/mod.js'

export const committer = defineMod({
  name: 'committer',
  setup(mod) {
    sessions.current.onTurnEnd(async () => {
      const answer = await mod.ask('Commit the changes?', { options: ['Commit', 'Wait'], header: 'Commit' })
      if (answer === 'Commit') await process.run(['git', 'commit', '-am', 'wip'], { cwd: sessions.current.project })
    })
  },
})
```

## The conversation's rows

Two members of `sessions.current` reach the rows Claude Code draws for the conversation ([session.md](session.md)):

```ts
sessions.current.scrollTo(message: Message, options?: { block?: 'start' | 'center' | 'end' | 'nearest' }): Promise<void>
sessions.current.caption(toolCall: ToolCall message, text: string | undefined): void
```

- `scrollTo` brings a [message](session.md#message)'s row into view, such as the message a person pressed in a history page. It scrolls only while the mod answers the person's own press or key.
- `caption` shows `text` as one line under the permission dialog that is open for that tool call, such as `checked by safe-delete`. `undefined` removes the line, and Claude Code removes it on its own once the call is decided.

## Test the UI

`tested.shown.page` and `tested.shown.pane` read the page or pane the mod shows now, with `lines()`, `press(key)`, `input(key, text)`, and `select(key, value)`. `tested.lines(area)` draws the mod's widgets in an area, and `tested.lines(kind, props)` draws a style. `tested.hotkey(name)` presses a hotkey. `tested.shown.toasts` lists the toasts shown now, each as `{ type, message, description? }`. [testing.md](testing.md) covers each.
