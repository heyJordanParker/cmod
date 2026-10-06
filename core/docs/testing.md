# Testing

`testMod` runs a mod against a fake Claude Code in `bun test`, so a test drives the mod the way a person and Claude do and reads what they would see. It needs no running Claude Code.

```ts
testMod<State>(definition: ModDefinition<State>, options?: TestOptions<State>): TestedMod<State>
```

```ts
import { expect, test } from 'bun:test'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { todo } from '../src/mod.js'

test('/todo adds the item to the project list', async () => {
  const tested = testMod(todo)

  expect(await tested.type('/todo buy milk')).toEqual({ text: 'Added: buy milk', context: 'The to-do list is now: buy milk' })
  expect(tested.state.project.items).toEqual(['buy milk'])
})
```

Assert what a person or Claude sees: `tested.lines(...)`, `tested.shown`, `tested.state`, and what `tested.fire(...)`, `tested.type(...)`, and `tested.callTool(...)` return.

## TestOptions

```ts
type TestOptions<State> = {
  readonly state?: { [Lifetime in keyof State]?: Partial<State[Lifetime]> }
  readonly scope?: 'user' | 'project'
  readonly projectRoot?: string
  readonly cwd?: string
  readonly dependencies?: { [Name in keyof CmodDependencies]?: CmodDependencies[Name] }
  readonly files?: Readonly<Record<string, string>>
}
```

| Option | What it sets | Default |
| --- | --- | --- |
| `state` | Values over the declared starting state | The declared state |
| `scope` | `'project'` makes the mod a project plugin, in `<projectRoot>/.claude/skills/<name>` | `'user'` |
| `projectRoot` | `mod.projectRoot` | `/test/plugins/<name>`, or `/test/project` for a project plugin |
| `cwd` | `mod.cwd` | `projectRoot` |
| `dependencies` | The methods other mods answer with | none: every call fails with `<name> is not installed. Run cmod install <name>.` |
| `files` | The fake file system, absolute path to text | no files |

A project plugin finds its repository through a `.git` entry at `projectRoot`, so a test of one puts it in `files`, such as `files: { '/test/project/.git': '' }`. Without it the project plugin has no repository, and its rules match calls in every folder, as a user mod's do.

The fake session's id is `test-session`, its model is `test-model`, and its home is `/test/home`. So `mod.dataFolder` is `/test/home/.local/share/cmod/data/<name>`. The mod is installed and draws on a terminal 80 columns wide.

## TestedMod

```ts
type TestedMod<State> = {
  start(): Promise<void>
  fire(event, input, below?): Promise<EventResult>
  settle(): Promise<void>
  lines(paneId: string): Promise<string[]>
  lines(slot, props, requestId?): Promise<string[]>
  type(line: string): Promise<Reply>
  callTool(name: string, input: Record<string, unknown>): Promise<EventResult<'tool.call'>>
  press(paneId: string, key: string): Promise<void>
  moveTo(projectRoot: string, cwd?: string): Promise<void>
  readonly state: Readonly<State>
  readonly calls: readonly TestCall[]
  readonly fakes: Fakes
  readonly shown: Shown
}
```

### start

Starts the mod: loads its state, runs `setup`, and adds its parts. `fire`, `lines`, `type`, `callTool`, `press`, and `moveTo` start the mod first, so a test calls `start` only before it reads `state` or `shown` with nothing else to run. It rejects with the reason when the mod does not start.

### fire

```ts
fire<E extends ModEvent>(event: E, input: TestInput<E>, below?): Promise<EventResult<`classic.${E}`>>
fire<N extends RoutedEvent>(event: N, input: Args<N>, below?): Promise<EventResult<N>>
```

- `fire('UserPromptSubmit', { prompt: 'hello' })` runs the mod's hooks on a `ModEvent`. `TestInput<E>` is the event's input without the fields `fire` fills: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and a new `tool_use_id` for each tool event.
- For a tool event, `files` is worked out from the call and the test's `files`, as in Claude Code.
- `below` is what the hooks beneath the mod answered, `{}` by default. Pass it to test how the mod's answer combines with another, such as a `deny` beneath. When nothing in the mod answers, `fire` returns `below` as it is.
- It returns the combined answer in Claude Code's own field names: `additionalContext` is a list, a `PreToolUse` decision is `allow: true`, or the key `ask` or `deny` with the reason as its value, and `decision: 'block'` is `block`.
- `fire('tool.check', { tool: 'Edit', input: { … }, tool_use_id: 'toolu_1' }, { decision: 'allow' })` asks the mod's permission rules about any call. A name with a dot fires that Claude Code hook-module event as it is.

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

### Test a prompt with when

A `prompt` with `when` runs on the hook-module event `prompt.submit`, not on `UserPromptSubmit`, so `fire('UserPromptSubmit', …)` never reaches it. It adds its text to the `context` field of the event it passes down, and `fire` returns `below`, so the answer does not show the text either. Read it with a spy part used after the prompt, which sees the event the prompt passes down:

- The `prompt.submit` input is `{ text, wait, origin }`. A prompt the person typed has `wait: false` and `origin: { kind: 'composer' }`.
- `context` is a list of strings, each `# <name>\n<text>`. It is `undefined` when no prompt added anything.

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { prompt } from '../node_modules/@cmodjs/core/jobs/prompt.js'

export const release = defineMod({
  name: 'release',
  setup(mod) {
    mod.use(prompt({ name: 'release-steps', prompt: 'Run bun run release, then push the tag.', when: /\brelease\b/i }))
  },
})
```

```ts
import { expect, test } from 'bun:test'
import { defineMod, type Part } from '../node_modules/@cmodjs/core/mod.js'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { release } from '../src/mod.js'

function contextBelow(passedOn: unknown[]): Part<void> {
  return ({ on }) => {
    on('prompt.submit', async (e, next) => {
      passedOn.push(e.context)
      return next(e)
    })
  }
}

test('a prompt about a release gets the release steps, and another prompt gets nothing', async () => {
  const passedOn: unknown[] = []
  const tested = testMod(
    defineMod({
      ...release,
      setup(mod) {
        release.setup(mod)
        mod.use(contextBelow(passedOn))
      },
    }),
  )

  await tested.fire('prompt.submit', { text: 'Cut a release', wait: false, origin: { kind: 'composer' } }, { text: '' })
  await tested.fire('prompt.submit', { text: 'Fix the bug', wait: false, origin: { kind: 'composer' } }, { text: '' })

  expect(passedOn).toEqual([['# release-steps\nRun bun run release, then push the tag.'], undefined])
})
```

### settle

Waits until the work a hook started without awaiting it has run, such as a `void` call in a `Stop` hook. It returns while a fake the test holds open has not answered.

### lines

- `lines(paneId)` draws an open pane and returns its rows of text. It rejects a pane that is not open: open it first with `tested.type('/<command>')` or `pane.open()` in the mod. The render gets the props `title`, `isFocused`, `bodyColumns`, and `placement: 'dock'`, and no `scroll` or `view`, so a render that reads those two gets `undefined` in a test.
- `lines(slot, props, requestId?)` draws a slot render with `props` and returns its rows. `Default` draws a plain listing of the props it gets, so a test sees what the render changed. Draw `slots.AssistantMessage` with a reply's `text` to test a markdown slot render. Draws that pass one `requestId` grow one streamed reply.

```ts
import { expect, test } from 'bun:test'
import type { RenderPropsOf } from 'claude-code'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { slots } from '../node_modules/@cmodjs/core/ui/slots.js'
import { hints } from '../src/mod.js'

const band: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 75, scroll: { offset: 0, bodyRows: 12 }, view: {} }

test('the band shows the prompt count on its last line', async () => {
  const tested = testMod(hints)
  await tested.fire('UserPromptSubmit', { prompt: 'hello' })

  expect((await tested.lines(slots.AbovePrompt, band)).at(-1)).toBe('Prompts: 1')
})
```

### type

`type('/<command> <arguments>')` runs a slash command as the person types it and returns its reply, `{ text?, context? }`. It rejects a line that does not start with `/`, and a command the mod does not add.

### callTool

`callTool(name, input)` runs the mod's permission rules on a call of its own tool, then the tool. `name` is the name given to `tool`, without `mcp__<plugin>__`. It returns `{ result }`, or `{ deny }` when a rule or the input check denies the call. It rejects a call a rule would ask the person about, and a tool the mod does not add.

### press

`press(paneId, key)` presses the `Button` of an open pane whose `key` or `label` is `key`, and awaits its `onPress`.

### moveTo

`moveTo(projectRoot, cwd?)` moves the session. A new `projectRoot` runs a `/cd` there, so the mod loads that project's state. A `cwd` then runs a Bash `cd` there. The mod's `CwdChanged` hooks run for each move.

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
  ui: { ask?, open? }
  agent: { list? }
  clock: { after?, every? }
  cmod: { call? }
}
```

Set a fake to answer a call:

- A call with no fake throws `<call>(<args>) has no fake answer. Set fakes.<call> on the tested mod.` So set `fakes.process.run` before a test runs a program, and `fakes.ui.ask` before the mod asks a question.
- A `program` job is the exception: it catches the `process.spawn` error and retries after 1, 2, 4, 8 and 16 seconds on real timers, so its `ready()` waits past `bun test`'s 5-second timeout. Set `fakes.process.spawn` before a test starts a `program` job.
- `files` already fills the `fs` fakes: a write is read back, and `list` lists the given files. The fake file system resolves a relative path against `/`, not against `mod.cwd`, so a mod under test reads `${mod.projectRoot}/<file>` rather than a relative path. `fs.list()` with no path rejects.
- `ui.open` places every pane by default. A fake that answers `{ isPlaced: false }` holds a pane back.
- `clock.after(ms, fn)` and `clock.every(ms, fn)` each return `{ cancel() }`, and so must a fake of either. `clock.after` runs a real timer by default. `clock.every` never fires unless a fake keeps `fn` for the test to call.

```ts
import { expect, test } from 'bun:test'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { committer } from '../src/mod.js'

test('a Commit answer commits', async () => {
  const tested = testMod(committer)
  tested.fakes.ui.ask = async () => 'Commit'
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  await tested.fire('Stop', { stop_hook_active: false })

  expect(tested.calls.filter(({ call }) => call === 'process.run').map(({ args }) => args[0])).toEqual([['git', 'commit', '-am', 'wip']])
})
```

### shown

```ts
type Shown = {
  readonly toasts: string[]
  readonly logs: string[]
  readonly debug: string[]
  readonly statuses: (string | undefined)[]
  readonly openPanes: Set<string>
  readonly commands: string[]
  readonly tools: string[]
}
```

What the person would see: the toasts, the log lines, the debug log lines, each status line text, the open panes, and the slash commands and tools the mod added.

`testing.js` exports the types `TestOptions`, `TestInput`, `TestedMod`, `Fakes`, `Shown`, and `TestCall`, so a test helper can take them.

## Run the tests

Run `bun test` in the mod's folder. `cmod check` runs the test files the same way, all but those that import `claude-code/testing`. A test file that imports `claude-code/testing` is for Claude Code's own test kit, and `cmod check` runs those with `claude plugin test` instead. `testMod` tests import neither.
