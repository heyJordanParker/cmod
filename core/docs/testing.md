# Testing

`testMod` runs a mod against a fake Claude Code in `bun test`, so a test drives the mod the way a person and Claude do and reads what they would see. It needs no running Claude Code.

```ts
testMod<State, Options>(definition: ModDefinition<State, string, Options>, options?: TestOptions<State, Options>): TestedMod<State>
```

```ts
import { expect, test } from 'bun:test'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { todo } from '../src/mod.js'

test('/todo adds the item to the project list', async () => {
  const tested = testMod(todo)

  expect(await tested.type('/todo buy milk')).toEqual({ text: 'Added: buy milk', note: 'The to-do list is now: buy milk' })
  expect(tested.state.project.items).toEqual(['buy milk'])
})
```

Assert what a person or Claude sees: `tested.shown.page.lines()`, `tested.lines(...)`, `tested.shown`, `tested.state`, and what `tested.raise...`, `tested.type(...)`, and `tested.callTool(...)` return.

## TestOptions

```ts
type TestOptions<State, Options> = {
  readonly state?: { [Lifetime in keyof State]?: Partial<State[Lifetime]> }
  readonly options?: Partial<OptionValues<Options>>
  readonly scope?: 'user' | 'project'
  readonly projectRoot?: string
  readonly cwd?: string
  readonly dependencies?: { [Name in keyof CmodDependencies]?: CmodDependencies[Name] }
  readonly files?: Readonly<Record<string, string>>
  readonly links?: Readonly<Record<string, string>>
  readonly sessions?: readonly FakeSession[]
}
```

| Option | What it sets | Default |
| --- | --- | --- |
| `state` | Values over the declared starting state | The declared state |
| `options` | The option values Claude Code passes, as a person set them ([options.md](options.md)) | none: each option gets its default |
| `scope` | `'project'` makes the mod a project plugin, in `<projectRoot>/.claude/skills/<name>` | `'user'` |
| `projectRoot` | `sessions.current.project` | `/test/plugins/<name>`, or `/test/project` for a project plugin |
| `cwd` | `sessions.current.cwd` | `projectRoot` |
| `dependencies` | The methods other mods answer with | none: every call fails with `<name> is not installed. Install it in Plugins.` |
| `files` | The fake file system, absolute path to text | no files |
| `links` | Symbolic links in the fake file system, absolute link path to its target | no links |
| `sessions` | The earlier conversations `sessions.list` and `sessions.search` read, each `{ id, messages?, goal?, … }` ([Build a conversation](#build-a-conversation)) | none: only the current session, `test-session` |

A project plugin finds its repository through a `.git` entry at `projectRoot`, so a test of one puts it in `files`, such as `files: { '/test/project/.git': '' }`. Without it the project plugin has no repository, and its rules match calls in every folder, as a user mod's do.

The fake session's id is `test-session`, its model is `test-model`, and its home is `/test/home`. So `mod.dataFolder` is `/test/home/.local/share/cmod/data/<name>`, and `mod.folder` is `/test/plugins/<name>`. The mod is installed and draws on a terminal 80 columns wide.

## TestedMod

```ts
type TestedMod<State> = {
  start(): Promise<void>
  readonly raise: Raise
  fire(event, input, below?): Promise<EventResult>
  settle(): Promise<void>
  add(message: MessageDraft, options?: { task?: string }): Promise<Message[]>
  endTurn(ending?: { answer?: string; failure?: { type: string; text: string } }, options?: { task?: string }): Promise<void>
  compact(): Promise<void>
  startSession(start: { source: 'startup' | 'resume' | 'clear' | 'fork'; id?: string }): Promise<void>
  startTask(task: { title: string; agentType?: string; model?: string; openedBy?: string; parent?: string; isBackground?: true; forkedFrom?: string }): Promise<string>
  lines(area: Area, props?: { columns?: number }): Promise<string[]>
  lines(kind: Row, props, requestId?): Promise<string[]>
  type(line: string): Promise<CommandReply>
  hotkey(name: string): Promise<void>
  callTool(name: string, input: Record<string, unknown>): Promise<EventResult<'tool.call'>>
  press(area: Area, key: string): Promise<void>
  moveTo(projectRoot: string, cwd?: string): Promise<void>
  readonly api: { [method: string]: (input?: unknown) => Promise<unknown> }
  readonly state: Readonly<State>
  readonly calls: readonly TestCall[]
  readonly fakes: Fakes
  readonly shown: Shown
}
```

### start

Starts the mod: loads its state, runs `setup`, and adds its listeners, pages, panes, widgets, and jobs. `raise`, `fire`, `lines`, `type`, `hotkey`, `callTool`, `press`, `moveTo`, and `api` start the mod first, so a test calls `start` only before it reads `state` or `shown` with nothing else to run. It rejects with the reason when the mod does not start.

### raise

`raise.<method>(payload)` runs the mod's listeners of that `on` or `before` method of `sessions.current`, and of `commands`, and returns the answer they combine to.

- Each process method takes its payload without `session` and `cwd`, which `raise` fills: `raise.beforeModelChange({ model: 'haiku', previous: 'opus', source: 'command', … })`, `raise.onCwdChange({ previous: '/work/old' })`, `raise.beforeRun({ name: 'compact', args: '', from: { type: Person } })`.
- Each message `before` method takes a `MessageDraft` without its `type`, placed in the open turn: `raise.beforeToolCall({ name: 'Bash', input: { command: 'rm -rf build' } })` and `raise.beforePrompt({ text: 'Deploy to prod' })`. `{ task }` places it in a task.
- `raise.beforeToolResult({ callId, output })` passes `output` to the listener as given, so a test gives what the tool answered Claude Code: `{ stdout: 'ok', stderr: '' }` for Bash, or Edit's `{ filePath, structuredPatch }`. A `ToolResult` that `tested.add` adds holds the text Claude read, as a transcript does.
- `raise.beforeTaskStart({ title, agentType?, model? })` asks about a task about to start.
- `raise.beforeTurnEnd({ answer?, failure? })` asks about the open turn ending. It rejects when no turn is open: add a `Prompt` first.
- `raise.beforeContextEnd()` asks about a compaction of the open context, and resolves with the mod's answer, such as `{ summary }`. `{ task }` asks about the compaction of a task's context, a task `tested.startTask` started.
- `raise.beforeSessionStart({ source: 'compact' })` asks about the main agent's compaction. `{ source: 'compact', task }` asks about a subagent's, which only `sessions.current.goal.beforeSessionStart` hears.
- A `note` that `raise` returns is the mod's own text. What Claude Code receives, as `claudeCodeOf(tested).fire` shows it, holds the note inside the mod's tag, such as `<guard_mod>…</guard_mod>`.

```ts
test('a force push is refused', async () => {
  const tested = testMod(guard)
  await tested.add({ type: Prompt, text: 'Push it' })

  expect(await tested.raise.beforeToolCall({ name: 'Bash', input: { command: 'git push --force' } })).toEqual({ refuse: 'Force pushes rewrite shared history.' })
})
```

The `on` methods of the conversation, such as `onPrompt` and `onTurnEnd`, run when the test builds the conversation ([Build a conversation](#build-a-conversation)).

### fire

```ts
fire(event: 'tool.check' | 'prompt.context' | 'cmod.call' | 'ui.render' | 'ui.scroll' | 'ui.close', input: Args<event>, below?): Promise<EventResult<event>>
```

`fire` raises the Claude Code events no method covers:

- `fire('tool.check', { tool: 'Edit', input: { … }, tool_use_id: 'toolu_1' }, { decision: 'allow' })` asks the mod's `permissions` job and `beforePermissionCheck` listeners about any call. `below` is Claude Code's own verdict.
- `fire('prompt.context', { blocks: [] }, { blocks: [] })` starts the conversation's context, which gives each `prompt` job its first block.
- `fire('cmod.call', { to, method, input })` calls a method `setup` returned, as another mod's `mod.dependencies` does, and returns `{ value }` with what the method returned, or `{ deny }` with the reason it failed. `tested.api.<method>(input)` does the same and resolves the value, or rejects with the reason.
- `ui.render`, `ui.scroll`, and `ui.close` are what `lines` and a pane's own events raise. `shown.pane.lines()` and `lines` are the way to draw.
- `fire('ui.close', { id, origin: { kind: 'person' } })` closes the pane as Escape or its ✕ does, and draws it once more before it closes, as Claude Code does. A pane's `ui.render` shows a pane Claude Code held back, as Claude Code does when the terminal widens.

```ts
expect(await tested.fire('cmod.call', { to: 'safe-delete', method: 'restore', input: { path: 'a.ts' } })).toEqual({ value: { restored: true } })
```

```ts
import { expect, test } from 'bun:test'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { guard } from '../src/mod.js'

test('a force push is denied with the reason', async () => {
  const tested = testMod(guard)

  const answer = await tested.fire('tool.check', { tool: 'Bash', input: { command: 'git push --force' }, tool_use_id: 'toolu_1' }, { decision: 'allow' })

  expect(answer).toEqual({ decision: 'deny', reason: 'Force pushes rewrite shared history.' })
})
```

### Test a note on matching prompts

A mod that adds a note to the prompts about a release answers `beforePrompt`, and `raise.beforePrompt` asks it:

```ts
import { defineMod, sessions } from '../node_modules/@cmodjs/core/mod.js'

export const release = defineMod({
  name: 'release',
  setup() {
    sessions.current.beforePrompt({ text: /\brelease\b/i }, () => ({ note: 'Run bun run release, then push the tag.' }))
  },
})
```

```ts
import { expect, test } from 'bun:test'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { release } from '../src/mod.js'

test('a prompt about a release gets the release steps, and another prompt gets nothing', async () => {
  const tested = testMod(release)

  expect(await tested.raise.beforePrompt({ text: 'Cut a release' })).toEqual({ note: 'Run bun run release, then push the tag.' })
  expect(await tested.raise.beforePrompt({ text: 'Fix the bug' })).toBeUndefined()
})
```

### settle

Waits until the work a listener started without awaiting it has run, such as a `void` call in an `onTurnEnd` listener. It returns while a fake the test holds open has not answered.

### Build a conversation

The current session, `test-session`, starts empty. A test builds the conversation the mod reads through `sessions` ([session.md](session.md)), the way Claude Code would write it:

- `add(message, { task? })` adds a message and returns it, placed in its context and turn. A `Prompt` opens a new turn. With `task`, the message is that task's.
- `endTurn({ answer?, failure? })` ends the open turn, as Claude stopping does. `answer` is Claude's last words, and `failure` ends it on an error, such as `{ type: 'rate_limit', text: 'Rate limited' }`. `{ task }` ends the open turn of that task's owner instead, and the first one a background task's session ends also ends the task.
- `compact()` records a compaction boundary, which ends the context and starts the next, as a compaction does.
- `startSession({ source, id? })` starts a session as `/clear`, `/resume`, or a fork does, under `id` when it names one. The mod's `session` values are that session's, so a `resume` to `test-session` brings the first session's values back, and `onSessionStart` hears the `source`.
- `startTask({ title, agentType?, model?, openedBy?, parent?, isBackground?, forkedFrom? })` starts a task and returns its id, under the task `parent` names when it has one. Its owner runs `agentType` on `model`, and a `Prompt` added with its `task` opens the owner's own turn. `forkedFrom: 'test-session'` starts a fork, `isBackground: true` a background task whose owner is a session of its own, and both together a clone. A message added with a background task's `task` goes into its owner's session.

Each one runs the mod's session listeners, as a new message does in Claude Code. A `MessageDraft` is a message without its place: `{ type: Prompt, text, from? }`, `{ type: Note, text, from? }`, `{ type: Reply, text }`, `{ type: ToolCall, name, input?, callId? }`, `{ type: ToolResult, callId, output, isError? }`, `{ type: Skill, name, text }`, `{ type: InstructionFile, path, text }`, `{ type: AttachedFile, path, attachmentType, text }`, or `{ type: Notice, text }`.

The `sessions` option gives the earlier conversations, each a `FakeSession`: an `id`, its `messages` as drafts, its `goal`, and any `Session` field, such as `title`, `color`, `project`, or `isRunning`. A session that names no `project` is in the test's project. `{ id: 'test-session', color: 'cyan' }` gives the current session its `/color` from the mod's start, and `tested.type('/color cyan')` and `tested.type('/color default')` run Claude Code's `/color`, which changes `sessions.current.color`. `tested.type('/color')` throws, because Claude Code picks a random color for it.

```ts
import { expect, test } from 'bun:test'
import { Prompt, Reply } from '../node_modules/@cmodjs/core/mod.js'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { recall } from '../src/mod.js'

test('/recall finds the earlier session about the deploy', async () => {
  const tested = testMod(recall, { sessions: [{ id: 'older', title: 'Fix the deploy', messages: [{ type: Prompt, text: 'Why did the deploy fail?' }] }] })
  await tested.add({ type: Prompt, text: 'Recall the deploy' })
  await tested.add({ type: Reply, text: 'Looking.' })
  await tested.endTurn()

  expect(await tested.type('/recall deploy')).toEqual({ text: 'Fix the deploy: Why did the deploy fail?' })
})
```

`shown.sent` lists what the mod sent to other sessions and to tasks' owners, each with its `session`, and its `task` for an owner. `fakes.agent.spawn` answers the current session's `startTask` and `fork`, such as `async () => ({ agentId: 'agent-7', model: 'test-model' })`, and `fakes.tool.call` its `callTool`. A background `startTask` and a `clone` start their task in the fake session, after asking the mod's `beforeTaskStart` listeners, and so do another session's `startTask` and `fork`.

A `before` listener on the current session answers what `raise` asks, such as `tested.raise.beforePrompt({ text: 'Deploy to prod' })` or `tested.raise.beforeToolCall({ name: 'Bash', input: { command: 'rm -rf build' } })`.

### lines

- `shown.page.lines()` draws the page the mod shows in the Sidebar now, and `shown.pane.lines()` the pane it shows now, and each returns its rows of text. Each rejects when the mod shows none, such as `No pane of notes shows. Open one with pane.open(), from a slash command, a hotkey, or setup.` A page gets `params`, `isFocused`, and `columns`, 80 unless `lines({ columns })` gives another. A pane gets `params`, `title`, `isFocused`, true once an `open` or `toggle` with `{ focus: true }` opened it, `bodyColumns`, which is the `columns` that `lines({ columns })` gives, else the pane's own `columns`, else 80, `placement: 'dock'`, `scroll: { offset: 0, bodyRows: 24 }`, and `view: {}`. `shown.page.id` and `shown.pane.id` name what shows, and `params` holds its params.
- A `Markdown` element in the mod's pages, panes, and widgets draws through the mod's own markdown styles, as it does in a session. Other mods' styles are not drawn.
- A key in a page or widget draws as the cmod plugin gives it to Claude Code: `<mod>/<page>:<key>` in a page, `<mod>/<widget>:<key>` in a widget, and `<mod>/markdown:<scope>:<block>:<key>` in what a markdown style draws, where `<scope>` is the drawn key of the `Markdown` element that holds the block, or its place among the `Markdown` elements without a key, and `<block>` is the block's number in that element's markdown, each from `0`. In the mod's own pane, a style's key draws as `<scope>:<block>:<key>`, and in a reply as `<block>:<key>`. `press`, `input`, and `select` take the key the mod wrote, and a key two blocks share reaches the first.
- Claude Code refuses a whole tree in which two `Input`, `Select`, `Markdown`, `Client`, `Raster`, or `Image` elements have one key, anywhere in it, and a refused Sidebar draws blank for the session. So drawing a page, a pane, a widget area, or a style that does it rejects with Claude Code's own text, such as `cmod: returned a tree Pane refuses: Markdown "notes/all:item-text:0" is drawn twice; each takes its own key`. Elements of different types, such as a `Box` and a `Markdown`, may share a key.
- A `Button` draws as Claude Code draws it: `[ Save ]`, or `1: Save` when it is `plain` with a `hotkey`, or `Save` when it is `plain` alone. Borders and colors are not drawn.
- `lines(area)` draws the mod's widgets in that area, in the rows the person would see, and returns them. A new widget is in the first row of its first area. A layout given in `files` as `/test/home/.local/share/cmod/widgets.json` places the widgets another way. `{ columns }` sets the row's width, 80 by default. `lines(TurnEnd)` draws under the last turn that ended, and rejects when none has: end one with `tested.endTurn()` first.
- `lines(kind, props, requestId?)` draws the mod's style of that kind with `props` and returns its rows. `Default` draws a plain listing of the props it gets, so a test sees what the style changed. Draw `Reply` with a reply's `text` to test a markdown style. Draws that pass one `requestId` grow one streamed reply.

```ts
import { expect, test } from 'bun:test'
import { BelowPrompt, Prompt } from '../node_modules/@cmodjs/core/mod.js'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { prompts } from '../src/mod.js'

test('the prompt count shows below the prompt', async () => {
  const tested = testMod(prompts)
  await tested.add({ type: Prompt, text: 'hello' })

  expect(await tested.lines(BelowPrompt)).toEqual(['Prompts: 1'])
})
```

### type

`type('/<command> <arguments>')` runs a slash command as the person types it and returns its reply, `{ text?, note? }`. The mod's `commands.beforeRun` listeners hear it first, so `type('/compact')` tests a listener that refuses a built-in. It rejects a line that does not start with `/`, a command nothing in the mod answers, and a command of the mod that calls `next(e)` on to Claude Code's own run of it, which shows the person `<mod> registered /<command> but no command.run hook answered it`. `hotkey` rejects the same way.

### hotkey

`hotkey(name)` presses the hotkey `defineMod` declared under `name`, as the person pressing its combo does, and awaits its listeners. A page it opens shows as `shown.page`. It rejects a name the mod does not declare.

```ts
test('the hotkey shows the prompt count in the Sidebar', async () => {
  const tested = testMod(myMod)
  await tested.add({ type: Prompt, text: 'hello' })
  await tested.hotkey('toggle')
  expect(await tested.shown.page.lines()).toEqual(['Prompts this session: 1'])
})
```

### callTool

`callTool(name, input)` runs the mod's permission rules on a call of its own tool, then the tool. `name` is the name given to `tool`, without `mcp__<plugin>__`. It returns `{ result }`, or `{ deny }` when a rule or the input check denies the call. It rejects a call a rule would ask the person about, and a tool the mod does not add.

### press, input, and select

`shown.page` and `shown.pane` act on an element of what shows as the person does, and await its handler. Each rejects when it does not draw the element: `The pane "<pane>" of <mod> draws no <Element> with the key "<key>".`, or the same for a page.

- `press(key)` presses the `Button` whose `key` or `label` is `key`, and runs its `onPress`.
- `press(key, link)` presses the link `link` in the `Markdown` whose `key` is `key`, and runs its `onLinkPress`.
- `input(key, text)` types `text` into the `Input` whose `key` is `key` and presses Enter, which runs its `onSubmit`. With a third argument `'change'` it runs `onInput` instead, as one edit does.
- `select(key, value)` picks the option `value` of the `Select` whose `key` is `key`, and runs its `onSelect`. It rejects an option the `Select` does not have.
- `tested.press(area, key)` presses a `Button` one of the mod's widgets draws in that area, the way the person presses it in a row.

```ts
await tested.shown.page.input('search', 'deploy')
await tested.shown.page.select('agent', 'explorer')
expect(await tested.shown.page.lines()).toContain('deploy by explorer')
```

### moveTo

`moveTo(projectRoot, cwd?)` moves the session. A new `projectRoot` runs a `/cd` there, so the mod loads that project's state. A `cwd` then runs a Bash `cd` there. The mod's `onCwdChange` listeners run for each move, and `sessions.current` follows it.

### state

The mod's current values. Reading it before the mod starts throws.

### calls

Every call the mod made to the fake Claude Code, in order, as `{ call, args }`, such as `{ call: 'process.run', args: [['git', 'status'], { cwd: '/work' }] }` and `{ call: 'cmod.call', args: [{ to, method, input }] }`.

### fakes

```ts
type Fakes = {
  process: { run?, spawn? }
  fs: { read?, write?, list?, exists?, stat? }
  http: { fetch? }
  settings: { read? }
  config: { list? }
  command: { list?, run? }
  ui: { ask?, open?, scroll?, copy?, focus? }
  session: { messages?, append?, send?, surfaces?, usage? }
  prompt: { submit? }
  model: { complete? }
  agent: { list?, spawn? }
  clock: { now?, after?, every? }
  cmod: { call? }
  tool: { call? }
}
```

Set a fake to answer a call:

- `session.surfaces` answers `['terminal']` unless set. Set it to `async () => []` to test a session no Claude app shows, such as `claude -p`.
- A call with no fake throws `<call>(<args>) has no fake answer. Set fakes.<call> on the tested mod.` So set `fakes.process.run` before a test runs a program, and `fakes.ui.ask` before the mod asks a question.
- A `program` job is the exception: it catches the `process.spawn` error and retries after 1, 2, 4, 8 and 16 seconds on real timers, so its `ready()` waits past `bun test`'s 5-second timeout. Set `fakes.process.spawn` before a test starts a `program` job.
- A `program` job with `singleInstance` spawns `/test/home/.local/share/cmod/programs/cmod program <mod> -- <command…>`, so `fakes.process.spawn` gets that `argv`. Each line the fake writes to standard output is the address of the copy that runs now, so a test fakes another session's copy taking over by writing a second line, and `ready()` resolves the new address.
- `files` already fills the `fs` fakes: a write is read back, and `list` lists the given files. The fake file system resolves a relative path against `/`, not against the session's working folder, so a mod under test reads `${sessions.current.project}/<file>` rather than a relative path. `fs.list()` with no path rejects.
- `ui.open` places every pane by default. A fake that answers `{ isPlaced: false }` holds a pane back.
- `ui.scroll` answers `{}` by default, as when the window moved. A fake that answers `{ deny }` refuses the scroll.
- `clipboard.write(text)` reaches `ui.copy({ text })`, so a test keeps each copied text with a fake that answers `{ isCopied: true }`.
- `clock.now()` answers the real time unless a fake gives its own, so a test of a deadline can move time. `clock.after(ms, fn)` and `clock.every(ms, fn)` each return `{ cancel() }`, and so must a fake of either. `clock.after` runs a real timer by default. `clock.every` never fires unless a fake keeps `fn` for the test to call, so a test of `mod.every` keeps it and calls it once per tick.
- `session.append` and `prompt.submit` take every note and prompt by default, into `shown.notes` and `shown.prompts`. A fake that answers `{ deny }` or `{ drop }` refuses one.
- `model.complete` has no default: set it to the answer the model gives, such as `async () => ({ isAnswered: true, text: 'no', usage })`.
- `settings.read` answers `{}` by default, as Claude Code does with no `settings.json` files.
- `config.list` answers no `/config` rows by default. A `config.list` fake that answers a row with `isLocked: true` locks that option as managed settings do.
- `command.list` answers the slash commands the mod added by default, and `command.run` answers `{}`, a command that printed nothing.
- `tool.call` answers `CronCreate`, `CronDelete`, and `CronList` by default, keeping the crons a `schedule` makes in `shown.schedules`. A call to any other tool needs a fake.
- `files` takes symbolic links too: `testMod(mod, { files, links: { '/work/skills': '/shared/skills' } })` makes `/work/skills` a link to `/shared/skills`, so a test of `fs.find` or `metadata.update` follows it as a real file system does.
- `testMod` opens no install page: an option with no default and no value fails `start()` with its fix, and the `installer` steps are not shown. Test a step's `render` and `isDone` by calling them with the started `mod`.
- The `committer` below runs `git`, and the `process.run` fake answers in its place.

```ts
import { expect, test } from 'bun:test'
import { Prompt } from '../node_modules/@cmodjs/core/mod.js'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { committer } from '../src/mod.js'

test('a Commit answer commits', async () => {
  const tested = testMod(committer)
  tested.fakes.ui.ask = async () => 'Commit'
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  await tested.add({ type: Prompt, text: 'Fix the bug' })
  await tested.endTurn()
  await tested.settle()

  expect(tested.calls.filter(({ call }) => call === 'process.run').map(({ args }) => args[0])).toEqual([['git', 'commit', '-am', 'wip']])
})
```

### shown

```ts
type Shown = {
  readonly toasts: ShownToast[]
  readonly notes: string[]
  readonly prompts: string[]
  readonly logs: string[]
  readonly debug: string[]
  readonly openPanes: Set<string>
  readonly commands: string[]
  readonly tools: string[]
  readonly schedules: { readonly id: string; readonly cron: string; readonly prompt: string }[]
  readonly sent: { readonly session: string; readonly type: string; readonly text: string; readonly as?: string }[]
  readonly page: ShownPart
  readonly pane: ShownPart
}

type ShownPart = {
  readonly id: string
  readonly params: unknown
  lines(options?: { columns?: number }): Promise<string[]>
  press(key: string, link?: string): Promise<void>
  input(key: string, text: string, type?: 'submit' | 'change'): Promise<void>
  select(key: string, value: string): Promise<void>
}

type ShownToast = { readonly type: ToastType; readonly message: string; readonly description?: string }
```

What the person and Claude would see: the toasts shown now, with a text description, the notes the mod added for Claude with `sessions.current.send` or a `prompt` that follows the state, and the `beforePrompt` notes a subagent reads as it starts from a spawn the test fires, the prompts it sent to the current session, the messages it sent to other sessions in `sent`, the log lines, the debug log lines, the open panes, the slash commands and tools the mod added, and the crons its `schedule` keeps now.

The test kit keeps no Log, as a cmod older than 4.3.0 keeps none, so every error cmod catches for the mod shows in `toasts` ([ui.md](ui.md#toasts)).

```ts
test('the Mode prompt follows the mode', async () => {
  const tested = testMod(modes)
  await tested.fire('prompt.context', { blocks: [] }, { blocks: [] })

  tested.state.session.mode = 'build'
  await tested.settle()

  expect(tested.shown.notes).toEqual(['# Mode\nYou are in build mode.'])
})
```

`testing.js` exports the types `TestOptions`, `TestedMod`, `Raise`, `Fakes`, `Shown`, and `TestCall`, so a test helper can take them.

## Run the tests

Run `bun test` in the mod's folder. `cmod check` runs the test files the same way, all but those that import `claude-code/testing`. A test file that imports `claude-code/testing` is for Claude Code's own test kit, and `cmod check` runs those with `claude plugin test` instead. `testMod` tests import neither.
