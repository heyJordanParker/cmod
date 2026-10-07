# UI

A mod draws in four places: its own panes, the rows Claude Code draws (slots), the blocks of Claude's replies (markdown slots), and short messages: toasts, progress lines, and questions. All of it lives on `mod.ui`.

```ts
mod.ui.pane(pane: Pane<State>): PaneHandle
mod.ui.render<S extends Slot>(slot: S, Component: (props: SlotProps<S>) => RenderElement): void
mod.ui.toast(text: string, options?: { timeoutMs?: number }): void
mod.ui.progress<T>(title: string, task: (report: (step: ProgressStep) => void) => Promise<T>): Promise<T>
mod.ui.ask(question: string, options?: readonly string[] | AskOptions): Promise<string>
mod.ui.scroll(args: UiScrollArgs): Promise<UiScrollResult>
```

Claude Mod Manager (cmod) draws the mod again whenever a value in `mod.state` changes. A render reads `mod.state` and returns what to show. It never draws by hand.

## Elements

`ui/elements.js` exports the elements a render draws with. Each takes the props Claude Code types in the `claude-code` module:

| Element | Props type | What it draws |
| --- | --- | --- |
| `Box` | `BoxProps` | A flex container: `flexDirection`, `gap`, `padding`, `margin`, `minWidth`, and the rest |
| `Text` | `TextProps` | Text: `bold`, `dimColor`, `color`, `wrap`, and the rest |
| `Button` | `ButtonProps` | A button: `label` or one string child, `onPress`, `hotkey`, `key`, `variant` |
| `Link` | `LinkProps` | A link |
| `Code` | `CodeProps` | Highlighted code |
| `Markdown` | `MarkdownProps` | Markdown text, as Claude Code draws a reply |
| `Input` | `InputProps` | A text input |
| `Select` | `SelectProps` | A choice of options |
| `Image` | `ImageProps` | An image, with `alt` text |

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

An element called outside a render throws `<Element> was called outside a render. Use it inside a pane's render or a slot's component.` So build elements inside a pane's `render` or a slot's component, never at module load or in a hook.

`drawWith(table, draw, markdown?)` is the function cmod draws a render with. A mod never calls it.

## Components

`ui/components.js` exports controls built from the elements and Claude Code's theme colors, so they follow the person's theme and look the same in every mod. Each is a component like the ones a mod writes: a function of props, used in a pane's `render` or a slot's component.

```ts
Tabs(props: { tabs: readonly { key: string; label: string }[]; selected: string; onSelect(key: string): void; children? })
Split(props: { children: readonly RenderElement[] })
Panel(props: { title: string; children? })
Toggle(props: { label: string; checked: boolean; onChange(checked: boolean): void })
Tooltip(props: { text: string; children? })
Help(props: { text: string; isOpen: boolean; onOpenChange(isOpen: boolean): void })
Dialog(props: { title: string; children?; actions })
Pagination(props: { page: number; pages: number; onPage(page: number): void })
ProgressBar(props: { done: number; total: number; width?: number })
```

- `Tabs` draws a row of tabs over `children`. The selected tab's number is in the accent color and its label bold and underlined. Each other tab is a `Button` whose hotkey is its number, so a pane that holds the keyboard switches tabs by number, Tab, or a click. A hotkey is one digit, so only the first nine tabs have a number.
- `Split` lays its children side by side in equal widths. `Panel` frames one part of a pane in a rounded border with a bold title.
- `Toggle` draws `[x] label` or `[ ] label` as a `Button`. Enter or a click calls `onChange` with the other value.
- `Tooltip` shows `text` in an inverted card above its children while the pointer rests on them. The card opens upward, because Claude Code paints a card over the rows drawn before it and under the rows drawn after it. It has no border, so a one-line card needs one free row above its children. The pointer alone opens it, so put nothing only a tooltip says.
- `Help` draws a `?` that shows `text` the same way. A press of `?` keeps the card open until the next press, so the keyboard reaches it too. Keep `isOpen` in `mod.state`.
- `Dialog` lays out a dialog's title, body, and `actions`, the buttons in a row. Put the safe action first, as the `primary` Button with `autoFocus`.
- `Pagination` draws `p: Previous  2 of 5  n: Next`. `p` and `n` are its hotkeys, and an end it cannot pass is dim text.
- `ProgressBar` fills `width` columns, 24 unless given, in proportion to `done` of `total`, and shows the count. The progress lines `mod.ui.progress` draws use it too.
- `Tabs`, `Toggle`, `Help`, and `Pagination` hold no state of their own. Keep their value in `mod.state` and set it in the callback, as in React's controlled components.

A pane opened with `focus`, `closeOnEscape`, and `holdToasts` is a dialog. Claude Code shows it as a tab of the dock, beside the mod's other panes, and Escape closes it:

```tsx
import { definePane } from '../../node_modules/@cmodjs/core/ui/define-pane.js'
import { Dialog } from '../../node_modules/@cmodjs/core/ui/components.js'
import { Button, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'

export const confirmPane = definePane<{ session: { deleting: boolean } }>({
  id: 'delete-branch',
  title: 'Delete branch',
  rows: 9,
  closeOnEscape: true,
  holdToasts: true,
  render: (mod) => (
    <Dialog
      title="Delete the branch feature/kit?"
      actions={[
        <Button variant="primary" autoFocus label="Keep it" onPress={() => void mod.ui.toast('Kept feature/kit')} />,
        <Button label="Delete" onPress={() => void (mod.state.session.deleting = true)} />,
      ]}
    >
      <Text dimColor wrap="wrap">Its 3 commits are not on main. Deleting it removes them from this machine.</Text>
    </Dialog>
  ),
})
```

Open it with `mod.ui.pane(confirmPane).open({ focus: true })`. It draws as:

```text
 Widgets   Delete branch                                        ✕
 Delete the branch feature/kit?

 Its 3 commits are not on main. Deleting it removes them from
 this machine.

 [ Keep it ]  [ Delete ]
```

A pane with `Tabs`, a `Tooltip`, a `ProgressBar`, `Pagination`, and a `Toggle` with `Help` draws as:

```text
 1: Controls   2: Split   3: Files

 3 files read

 ██████████████░░░░░░░░░░  7/12

 p: Previous  2 of 5  n: Next

 [x] Show hidden files ?
```

With the pointer on `3 files read` and `Help` open, the two cards cover the rows above them:

```text
 1: Controls   2: Split   3: Files
  Files Claude read this session
 3 files read

 ██████████████░░░░░░░░░░  7/12

 p: Previous  2 of 5  n Hidden files start with a dot,
                        such as .env.
 [x] Show hidden files ?
```

and its Split tab, two `Panel`s in a `Split`, as:

```text
 1: Controls   2: Split   3: Files

 ╭─────────────────────────────────╮ ╭────────────────────────────────╮
 │ Changed files                   │ │ src/mod.tsx                    │
 │ src/mod.tsx                     │ │ + mod.ui.pane(widgetsPane)     │
 │ src/state.ts                    │ │ - mod.ui.pane(oldPane)         │
 ╰─────────────────────────────────╯ ╰────────────────────────────────╯
```

## Panes

A pane is a framed region the mod opens. Claude Code docks it beside the transcript in fullscreen, or shows it above the prompt.

### definePane

```ts
definePane<State>(pane: Pane<State>): Pane<State>

type Pane<State> = {
  readonly id: string
  readonly title: string
  readonly columns?: number | ((state: State) => number | undefined)
  readonly rows?: number | ((state: State) => number | undefined)
  readonly closeOnEscape?: true
  readonly holdToasts?: true
  render(mod: Mod<State>, props: Frozen<RenderPropsOf['Pane']>): RenderElement
  onScroll?(mod: Mod<State>, e: Frozen<UiScrollInput>): void | Promise<void>
  onClose?(mod: Mod<State>, e: Frozen<PaneCloseInput>): void | Promise<void>
}
```

- `id` is 1 to 64 letters, digits, `_`, or `-`. Another id throws `definePane: "<id>" is not a pane id.`
- `title` labels the pane's tab while more than one pane is open.
- `columns` and `rows` ask for a size. A number must be a whole number above 0, or `definePane` throws. A function reads the state and returns the size, or `undefined` for Claude Code's default. When the state changes the size, cmod resizes an open pane. A function that returns a bad size keeps an open pane at its size and logs the pane's title to the debug log. `open`, and `toggle` on a closed pane, reject with that size instead.
- `closeOnEscape` closes the pane when the person presses Escape while it holds the keyboard, as their own close does. Left out, Escape gives the keyboard back to the prompt and the pane stays.
- `holdToasts` holds every toast back while the pane is shown, the toasts of other plugins and of Claude Code included. Use it for a pane the person answers and closes, never for one that stays open.
- `render` draws the pane's body. `props` holds `title`, `isFocused`, `bodyColumns`, `placement` (`'dock'` or `'inline'`), `scroll`, the body's window over a taller drawing, and `view`, which transcript is on screen beside the pane.
- `onScroll` runs after this pane's window moved, by the person's wheel or keys or by `mod.ui.scroll`. `e` holds the new `offset`, the move's `by`, `bodyRows`, `contentRows`, and `origin`. Another pane's scroll and the band's never reach it, and a scroll Claude Code refused does not either.
- `onClose` runs after the pane closed, by the person or by `close()`. `e.origin.kind` is `'person'` or `'plugin'`.
- A handler that throws logs `<mod>: the <title> pane's <handler> threw: <error>`.

Put each pane in its own file in `src/panes/`.

```tsx
import { definePane } from '../../node_modules/@cmodjs/core/ui/define-pane.js'
import { Box, Button, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'

export type NotesState = { global: { notes: readonly string[] } }

export const notesPane = definePane<NotesState>({
  id: 'notes',
  title: 'Notes',
  columns: (state) => (state.global.notes.length > 10 ? 40 : 24),
  render: (mod) => (
    <Box flexDirection="column" gap={1}>
      {mod.state.global.notes.map((note) => <Text>{note}</Text>)}
      <Button label="Clear" onPress={() => { mod.state.global.notes = [] }} />
    </Box>
  ),
})
```

### mod.ui.pane

`mod.ui.pane(pane)` adds the pane and returns its handle:

```ts
type PaneHandle = {
  open(options?: { readonly focus?: true }): Promise<void>
  close(): Promise<void>
  toggle(options?: { readonly focus?: true }): Promise<void>
  readonly isOpen: boolean
}
```

- `open` asks Claude Code to show the pane. `isOpen` turns true once Claude Code places it. Claude Code may hold a pane back, and then `isOpen` stays false.
- `{ focus: true }` asks Claude Code to give the pane the keyboard as it opens. Claude Code gives it only while the prompt is empty and holds the keyboard, so typed text, a dialog, or another pane the person is using keeps it. cmod sends `focus` only on that one open, never when it resizes the pane.
- `mod.ui.pane` only adds the pane. cmod opens it only when the mod calls `open` or `toggle`, and Claude Code shows a pane only once the plugin has opened it. So give the person a way in, such as a slash command whose `reply` calls `pane.toggle()`.
- A pane opened from what the person did, such as a slash command they typed or a `Button` they pressed, shows at any terminal width. A pane opened from anything else, such as `setup`, a timer, or `SessionStart`, shows only on a terminal 144 columns wide, or 110 for a pane the person opened before. Below that it waits undrawn until the person opens it or the terminal widens.
- `close` closes it. The person closes a pane too, and `isOpen` follows.
- `toggle` closes an open pane and opens a closed one.
- When the mod starts, `isOpen` is true for each of its panes Claude Code already shows.
- Adding two panes with one id throws `<mod>: the pane "<id>" is already added. Give each pane its own id.`
- A `render` that throws draws `The <title> pane could not draw: <error>` in the pane, and cmod logs `<mod>: the <title> pane render threw: <error>` once.
- The line cmod logs when the mod first starts names the pane by its `title`, as in `the Notes pane`.

```tsx
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import { notesPane, type NotesState } from './panes/notes.js'

const initialState: NotesState = { global: { notes: [] } }

export const notes = defineMod({
  name: 'notes',
  state: initialState,
  setup(mod) {
    const pane = mod.ui.pane(notesPane)
    mod.use(slashCommand({ name: 'notes', description: 'Show or hide the notes', reply: () => pane.toggle({ focus: true }) }))
  },
})
```

## Slots: change a row Claude Code draws

`mod.ui.render(slot, Component)` draws in place of one of Claude Code's own rows. `ui/slots.js` exports `slots`:

| Slot | What Claude Code draws there |
| --- | --- |
| `slots.AssistantMessage` | One text block of Claude's reply |
| `slots.UserMessage` | A user row: the prompt, a task notification, or another agent's message |
| `slots.ToolUse` | A tool call's row |
| `slots.ToolResult` | A tool call's result |
| `slots.ToolGroup` | The condensed row of a group of tool calls |
| `slots.ToolProgress` | A tool's progress line |
| `slots.CommandOutput` | A slash command's output |
| `slots.AskUserQuestion` | The dialog the AskUserQuestion tool opens |
| `slots.InfoNotice` | A dim status line under the logo |
| `slots.Spinner` | The spinner line while Claude works |
| `slots.TurnDuration` | The line that closes a turn |
| `slots.SessionMode` | The session's modes |
| `slots.PromptHint` | The prompt's hint line, such as `? for shortcuts` |
| `slots.AbovePrompt` | The band above the prompt, where surveys draw |

`Component` gets `SlotProps<S>`: the props Claude Code types as `RenderPropsOf['<Slot>']`, plus `Default`.

- `Default` draws what Claude Code, and the renders of other mods, would draw. Pass it props to change what it draws, such as `<Default hint="…" />`. Return `<Default />` to change nothing.
- A render adds to what it wraps. In `AbovePrompt`, drawing `<Default />` and a line under it keeps the lines of Claude Code and other mods.
- A render must draw the same for the same props. One that calls `Default` a different number of times on a second draw falls back to Claude Code's drawing.
- A render that throws falls back to Claude Code's drawing. cmod logs `<mod>: the <Slot> render threw, so Claude Code draws its own: <error>` once.
- A mod renders each slot once. A second `mod.ui.render` of one slot throws `<mod>: a render of <Slot> is already added. Render each slot once.` For a markdown slot the error names it as `a render of markdown <Kind>`, such as `a render of markdown CodeBlock`.
- `slots.ToolUse` changes a call's own row. A group of calls shows the `slots.ToolGroup` row, which Claude Code builds from the stored message, so a mod that hides a tool's input also sets `isExpanded` on `slots.ToolGroup` to unfold the group into `ToolUse` rows.
- No slot covers the permission dialog.

```tsx
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { Box, Text } from '../node_modules/@cmodjs/core/ui/elements.js'
import { slots } from '../node_modules/@cmodjs/core/ui/slots.js'

export const hints = defineMod({
  name: 'hints',
  state: { session: { prompts: 0 } },
  setup(mod) {
    mod.ui.render(slots.PromptHint, ({ hint, Default }) => <Default hint={hint.toUpperCase()} />)
    mod.ui.render(slots.AbovePrompt, ({ hasSurvey, Default }) =>
      hasSurvey ? <Default /> : (
        <Box flexDirection="column">
          <Default />
          <Text dimColor>{`Prompts: ${mod.state.session.prompts}`}</Text>
        </Box>
      ))
    mod.on('UserPromptSubmit', () => {
      mod.state.session.prompts += 1
    })
  },
})
```

`Slot` and `SlotProps` are the types behind `slots`. Type a component's props as `SlotProps<typeof slots.PromptHint>`.

## Markdown slots: change the blocks of a reply

`ui/markdown.js` exports `markdownSlots`, one per markdown block:

| Slot | Block | Props beyond `text` and `source` |
| --- | --- | --- |
| `markdownSlots.Heading` | A heading | `depth`, 1 to 6 |
| `markdownSlots.Paragraph` | A paragraph | none |
| `markdownSlots.CodeBlock` | A code block | `lang`, `meta`, `value` |
| `markdownSlots.BlockQuote` | A block quote | none |
| `markdownSlots.List` | A list | `ordered`, `start`, `spread` |
| `markdownSlots.Table` | A table | `align` |
| `markdownSlots.ThematicBreak` | A `---` line | none |
| `markdownSlots.HtmlBlock` | An HTML block | `value` |

- `text` is the block's plain text, one line per list item, table row, or quoted line. `source` is the block's markdown.
- `Default` draws the block as Claude Code would. `<Default source="…" />` draws other markdown in its place.
- A markdown slot render draws in Claude's replies and in every `Markdown` element of the mod's panes.
- While a reply streams in, Claude Code draws a block that is not finished yet. The mod draws it once it is.
- A render that throws falls back to Claude Code's drawing of the block and logs once.

```tsx
import type { RenderElement } from 'claude-code'
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { Text } from '../node_modules/@cmodjs/core/ui/elements.js'
import { markdownSlots } from '../node_modules/@cmodjs/core/ui/markdown.js'
import type { SlotProps } from '../node_modules/@cmodjs/core/ui/slots.js'

function MermaidBlock({ lang, value, Default }: SlotProps<typeof markdownSlots.CodeBlock>): RenderElement {
  return lang === 'mermaid' ? <Text>{`diagram: ${value}`}</Text> : <Default />
}

export const diagrams = defineMod({
  name: 'diagrams',
  setup(mod) {
    mod.ui.render(markdownSlots.CodeBlock, MermaidBlock)
  },
})
```

```ts
markdownBlocks<S>(text: string, slot: S): Omit<SlotProps<S>, 'Default'>[]
```

`markdownBlocks` returns the props of every block of one kind in a markdown text. A test uses it to call a component with real props.

`MarkdownKind`, `MarkdownReader`, and `MarkdownPiece` are the types behind `markdownSlots`. A mod never builds them.

## Toasts

`mod.ui.toast(text, options?)` shows the person a short message on Claude Code's stack of plugin toasts, over the transcript's top right corner and under the mod's name. It stays 4 seconds, or `timeoutMs`. A click takes it off, and the pointer resting on it holds it. While a pane opened with `holdToasts` is shown, it waits.

## Progress lines

```ts
mod.ui.progress<T>(title: string, task: (report: (step: ProgressStep) => void) => Promise<T>): Promise<T>

type ProgressStep = { readonly done: number; readonly total: number; readonly label?: string }
```

`progress` draws a line in the band above the prompt while `task` runs, and removes it when `task` settles. The line shows a spinner and the title. After the first `report` it also shows a bar, `done/total`, and the label. `progress` resolves or rejects as `task` does.

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'

export const indexer = defineMod({
  name: 'indexer',
  setup(mod) {
    mod.on('SessionStart', async () => {
      const entries = await mod.fs.list(mod.projectRoot)
      await mod.ui.progress('Indexing', async (report) => {
        for (const [index, entry] of entries.entries()) report({ done: index + 1, total: entries.length, label: entry.name })
      })
    })
  },
})
```

## Questions

```ts
mod.ui.ask(question: string, options?: readonly string[] | AskOptions): Promise<string>

type AskOptions = { options?: readonly string[]; header?: string; multiSelect?: true }
```

`ask` shows a question with 2 to 4 options and resolves the answer. Fewer than two options are padded with Yes and No, and the person may type an answer of their own. `header` is a short chip beside the question, 12 characters at most. `multiSelect` lets the person pick several, and the answer comes back joined by commas.

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'

export const committer = defineMod({
  name: 'committer',
  setup(mod) {
    mod.on('Stop', async () => {
      const answer = await mod.ui.ask('Commit the changes?', { options: ['Commit', 'Wait'], header: 'Commit' })
      if (answer === 'Commit') await mod.process.run(['git', 'commit', '-am', 'wip'], { cwd: mod.projectRoot })
    })
  },
})
```

## Scrolling

```ts
mod.ui.scroll(args: { to: 'start' | 'end' | { key: string } | { requestId: string }; in?: string; block?: 'start' | 'center' | 'end' | 'nearest' }): Promise<UiScrollResult>
```

`scroll` brings something the mod drew into view. `{ key }` is an element the mod drew with that `key`. `'start'` and `'end'` are the top and bottom of the pane whose id `in` names, and `'end'` keeps up with rows the mod adds until the person scrolls. `{ requestId }` is a row Claude Code drew, such as a message of the transcript, which scrolls only while the mod answers the person's own press or key. `block` places the target in the window, `'nearest'` by default. It resolves `{}` once the window moved, or `{ deny }` with the reason it did not.

```tsx
<Button label="Latest" onPress={() => mod.ui.scroll({ to: 'end', in: 'log' })} />
```

## Test the UI

`tested.lines(paneId)` reads an open pane as rows of text. `tested.lines(slot, props)` draws a slot render. `tested.press(paneId, key)` presses a button. `tested.shown.toasts` lists the toasts. [testing.md](testing.md) covers each.
