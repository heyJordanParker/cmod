# Define a mod

`defineMod` describes a mod: its name, its state, its options, its hotkeys, and the `setup` function that adds everything to Claude Code and returns the methods it offers other mods. `registerMod` registers the definition with Claude Code.

## defineMod

```ts
defineMod<State, Name, Options, Hotkeys>(definition: ModDefinition<State, Name, Options, Hotkeys>): ModDefinition<State, Name, Options, Hotkeys>
```

```ts
type ModDefinition<State, Name, Options, Hotkeys> = {
  readonly name: Name
  readonly state?: State
  readonly options?: Options
  readonly hotkeys?: Hotkeys
  readonly installer?: readonly Step<State>[]
  setup(mod: Mod<State, Options, Hotkeys>): Api | void | Promise<Api | void>
}
```

- `name` is the mod's name. Use the `name` in `.claude-plugin/plugin.json`. Claude Mod Manager (cmod) keys the saved state and the options by this name, and the data folder and the Skill overrides by the plugin's name, so the two must match. `defineMod` throws `defineMod: the mod needs a name, such as the name in .claude-plugin/plugin.json.` for a blank name.
- `state` holds the starting values, grouped by how long they last. [state.md](state.md) explains the groups.
- `options` declares what a person sets, such as a token, and types `mod.options`. [options.md](options.md) explains them.
- `hotkeys` declares the key combos the mod listens for, each with a title and an optional default combo the person can change ([Hotkeys](#hotkeys)).
- `installer` lists the steps the person finishes in Claude Code after the permissions and the options, such as signing in. [install-steps.md](install-steps.md#steps-in-claude-code) explains them.
- `setup` runs once when the mod starts. It adds listeners, pages, panes, widgets, styles, and jobs. It may be `async`. What it returns is the mod's API: an object of methods other mods call. Return nothing for a mod that offers none. [dependencies.md](dependencies.md) explains it.

```tsx
import { defineMod, sessions } from '../node_modules/@cmodjs/core/mod.js'

export const greeter = defineMod({
  name: 'greeter',
  state: { session: { isGreeted: false } },

  setup(mod) {
    sessions.current.onPrompt(() => {
      if (mod.state.session.isGreeted) return
      mod.state.session.isGreeted = true
      mod.toast(`Hello from ${mod.name}`)
    })
  },
})
```

## When setup runs

Claude Code loads the mod at the start of each session. cmod then checks that the mod is set up. A mod the person has not accepted yet opens its install page, the `Install <name>` tab of the Sidebar, which lists its permissions and the changes it makes to the computer, and waits for Accept ([install-steps.md](install-steps.md)). An option with no default and no value is asked next on the same page. Then cmod loads the saved state, runs `setup`, marks as open each of the mod's panes that Claude Code already shows, and opens the install page again for each `installer` step the mod declares that is not done.

The first time a mod starts on a machine, cmod shows the toast `Installed` under its name. Opened, it lists the mod's `plugin.json` `description`, what setup added, such as `Adds the my-mod pane, the Branch widget and /deploy.`, what its install step set up, and each permission the person allowed, with a Settings button that opens Settings at the mod. A new version shows no toast of the mod's own: after the reload that loads it, the cmod plugin shows `<mod> updated to <version>` in the corner, followed by each permission the update granted ([commands.md](commands.md#install-mods)). A new session and `/reload-plugins` show no toast.

When a step fails, or the person declines the install, the mod stays stopped. Once another session sets it up, the mod starts at the next prompt of every session it stopped in, with no `/reload-plugins`.

A mod that loads while a session runs, such as after `/reload-plugins` or `/plugin install`, hears no SessionStart from Claude Code. cmod runs its `onSessionStart` and `beforeSessionStart` listeners before the next prompt instead, once, with the source `resume`.

When a step fails, the mod does not start. An error toast above the prompt names the failure, with the fix under it:

- `<mod>: state.<group> is not a lifetime. …` or `<mod>: state.<group> is not an object of values. …` when the declared state is not valid ([state.md](state.md)).
- `its state did not load: <error>` when reading the saved values fails.
- `it needs <titles>` when the person chose Not now on an option with no default, or no one can answer, as in `claude -p` ([options.md](options.md)). This one says `Retry asks for it.`, and `Retry` opens the question again.
- `its setup function threw: <error>` when `setup` throws or rejects.
- `its open panes did not load: <error>` when Claude Code cannot list the open panes.
- `the details of its session did not load: <error>` when Claude Code cannot name the session's id, model, or start time.

Each of these has `Retry`, which starts the mod again, and `Report` and `Hide` ([ui.md](ui.md#toasts)). A failed step is critical, so its toast shows for an installed mod too, unless the failure is a refusal for a permission the person turned off, which goes only to the Log.

## Rules

A mod's `rules/` folder holds rules in Claude Code's own rule format: one Markdown file per rule, with an optional `paths` list in its front matter. A rule without `paths` applies to every conversation, and a rule with `paths` applies when Claude reads a matching file.

```
my-mod/
└── rules/
    ├── tests.md        <- applies to every conversation
    └── sql.md          <- front matter paths: ["**/*.sql"]
```

While the mod is on and has the `prompt` permission, cmod links the folder into Claude Code's rules folder: a mod the person installed links at `<config>/rules/<mod>`, and a mod turned on for one project at `<project>/.claude/rules/<mod>`. A mod turned off for one project keeps its rules out of that project through `claudeMdExcludes` in the project's `.claude/settings.local.json`. A rule the person excluded with `claudeMdExcludes` stays out of the notes too. Turning the mod off, turning `prompt` off, and removing the mod remove the link, and an update links the new version's folder. cmod changes only the links and exclusions it made.

Claude Code reads rules without `paths` only as a session starts. So when cmod links a mod's rules into a running session, it adds them to the conversation as one note, and when it removes the link, one note says the mod's rules no longer apply. A rule taken out of the folder is withdrawn by a note too. When an update changes a rule without `paths`, one note gives its new text. Claude Code loads rules with `paths` itself, at the read that matches.

The `Installed` toast lists the rules, as in `Adds 2 rules: sql and tests.` `cmod check` fails a mod with a `rules/` folder whose `package.json` `"cmod"` does not ask for `"prompt": true`.

## Release notes

A mod's `CHANGELOG.md`, at its root, holds what changed in each version, written for the people who use it. It follows the Keep a Changelog format: an `## [Unreleased]` section for what is not released yet, then one `## [<version>] - <date>` section per release, newest first, with its entries under `### Added`, `### Changed`, `### Removed`, and `### Fixed`. A breaking change goes under Changed or Removed, and raises the major version.

```markdown
# Changelog

## [Unreleased]

## [1.4.0] - 2026-10-13

### Added
- /rollback undoes the last deploy, including its database migration.

### Removed
- /deploy-old. Use /deploy --legacy instead.
```

- `cmod publish` releases the version's section as the GitHub release's notes, and refuses a version with no section ([commands.md](commands.md#cmod-publish)). Every release ships the file.
- Settings shows the mod's Changelog, the whole file with the installed version at the top of the view.
- A linked checkout whose version has no section yet shows its `[Unreleased]` section, so the notes show as soon as the version moves.
- `cmod new` writes the file with an `[Unreleased]` and a `[0.1.0]` section.

## Register the mod with Claude Code

`hooks/hooks.json` names `hooks/register.ts` as the plugin's hooks module. `register.ts` calls `registerMod` and does nothing else:

```ts
import type { On, PluginOptions } from 'claude-code'
import { registerMod } from '../node_modules/@cmodjs/core/register.js'
import { greeter } from '../src/mod.js'

export function register(addHook: On, options: PluginOptions): void {
  registerMod(addHook, greeter, options)
}
```

```ts
registerMod<State, Options>(addHook: On, definition: ModDefinition<State, string, Options>, options: PluginOptions): void
registerPermissionCheck(addHook: On): void
registeredMod(): ModDefinition | undefined
```

`registerMod` registers one handler per Claude Code event the mod can use, and routes each event to the mod. `options` is what Claude Code passes `register`: the values of the mod's options ([options.md](options.md)). `registeredMod` returns the definition `registerMod` got, for `cmod check` to read the mod's options without starting it. `registerMod` leaves out Claude Code's permission check, the events `tool.check` and `PermissionRequest`.

A mod that hears permissions calls `registerPermissionCheck` after `registerMod`. That covers `sessions.current.onPermissionCheck`, `beforePermissionCheck`, `onPermissionRequest`, `beforePermissionRequest`, and the `permissions` job:

```ts
export function register(addHook: On, options: PluginOptions): void {
  registerMod(addHook, guard, options)
  registerPermissionCheck(addHook)
}
```

A mod that allows or asks, with a `before` method or an `ask` rule of the `permissions` job, also declares `"approve": true` in its `package.json` `"cmod".permissions`, so the person grants it at install. `cmod check` adds the line when it is missing, and without the grant cmod drops every allow or ask the mod answers, so Claude Code decides those calls itself. A mod that only refuses needs no `approve`, and its bundle holds no code that allows, so Anthropic's plugin directory can list it ([permissions.md](permissions.md)). A mod without `registerPermissionCheck` has no part in Claude Code's permission check, so the plugin directory reads it as one that never answers a permission. Without it, each of those methods and `mod.use(permissions(…))` throws `<mod>: <method> hears Claude Code's permission check, so hooks/register.ts must call registerPermissionCheck(addHook) after registerMod.` where it is called, so a mod that calls one in `setup` does not start. `cmod check` fails a mod whose `src/` uses one while `register.ts` does not call `registerPermissionCheck`.

Where an organization manages Claude Code, Claude Code passes a mod the person installed over on its classic hooks, the notes it adds to a prompt, its Skill and instruction-file text, and compactions, and runs those only for a plugin the organization lists in managed settings. There, the `on` and `before` methods built on them hear nothing until the organization lists the mod and the cmod plugin. `claude plugin validate` names each such hook.

Keep `register.ts` this small. Claude Code checks a hooks module before it loads it, and refuses some shapes, such as a `$` passed to a function in another module. The plugin directory reads the bundled module too, and flags it when the name of `register`'s first parameter is declared anywhere else in the bundle. `@cmodjs/core` declares `on` as a key, so name that parameter `addHook`. Declare `register` as a function, as here: `cmod publish` bundles the hooks module into one file, and Claude Code refuses a bundled `register` that is not one.

## mod: this mod

`setup` gets `mod`, of type `Mod<State, Options, Hotkeys>`. Every listener, render, and job gets the same `mod`. `mod` holds what belongs to this mod: its name, its folders, its values, its grants, its hotkeys, and what it adds to Claude Code.

```ts
type Mod<State, Options, Hotkeys> = {
  readonly name: string
  readonly folder: string
  readonly dataFolder: string
  readonly state: Readonly<State>
  readonly options: OptionValues<Options>
  readonly permissions: Permissions
  readonly hotkeys: { readonly [name in keyof Hotkeys]: Hotkey }
  every(ms, listener): Timer
  after(ms, listener): Timer
  use(job): Handle
  log(text, options?): void
  readonly sidebar: { add(page): Page }
  readonly settings: { add(page): Page; open(): Promise<void> }
  readonly panes: { add(pane): Pane }
  readonly widgets: { add(widget): Widget }
  readonly styles: { add(style): Style }
  readonly toast: Toast
  ask(question, options?): Promise<string>
  readonly dependencies: CmodDependencies
}
```

- `name` is the mod's name from `defineMod`.
- `folder` is the plugin's own folder, where the files the mod ships live.
- `dataFolder` is the mod's own folder in the cmod store: `$XDG_DATA_HOME/cmod/data/<plugin name>`, or `~/.local/share/cmod/data/<plugin name>` when `XDG_DATA_HOME` is not set. The install step gets the same folder as `CMOD_DATA`. cmod deletes it when the mod is removed ([install-steps.md](install-steps.md)).
- `state` holds the mod's values. Assign to a key to change it ([state.md](state.md)).
- `options` holds the values a person set for the mod's options, typed from their declaration. Read-only ([options.md](options.md)).
- `permissions` says whether the person granted each permission ([permissions.md](permissions.md)).
- `hotkeys` holds each hotkey `defineMod` declared ([Hotkeys](#hotkeys)).
- `every` and `after` run a listener on a timer while the session runs.
- `use` adds a job, such as a slash command or a tool, and returns its handle ([jobs.md](jobs.md)).
- `log` writes a line, under the mod's name, to Claude Code's debug log.
- `sidebar`, `settings`, `panes`, `widgets`, and `styles` add the mod's pages, panes, widgets, and styles. `toast` shows a short message and `ask` asks a question ([ui.md](ui.md)).
- `dependencies` calls the methods of other mods ([dependencies.md](dependencies.md)).

Everything that is Claude Code's or the computer's rather than the mod's is an import from `mod.js`, so a function in any file calls it without being handed `mod`:

```ts
import { clipboard, commands, config, fs, http, metadata, model, process, sessions, settings } from '../node_modules/@cmodjs/core/mod.js'
```

- `sessions` is the conversations: the one the mod runs in, every other one, and search across them. Everything that happens in a session, from a prompt to a permission dialog, is a method on it ([session.md](session.md)).
- `commands` is every slash command: it lists them, runs one, and hears or changes each run.
- `settings` is Claude Code's `settings.json` files: the person's, the project's, and the project's local one.
- `config` is the rows of Claude Code's `/config` menu.
- `model` asks a model one question, outside the conversation.
- `fs` reads, writes, lists, finds, and watches files.
- `metadata` reads and changes the mod's keys in one file's metadata.
- `process` runs a program.
- `http` fetches a URL.
- `clipboard` puts text on the person's clipboard ([ui.md](ui.md#toasts)).

Each import works once the mod has started, in `setup` and anything it adds. Each one checks the permission it needs, and rejects with the line to add or the grant to turn on when the person has not granted it ([permissions.md](permissions.md)).

### Take back what the mod added

Every `add` call, every `on` and `before` method, `fs.onChange`, `settings.beforeFileChange`, and `hotkey.onPress` return a part or a `Subscription`, and each has `remove()`, which takes back what the call added. So a mod turns a feature off and on while it runs. Everything a mod adds is taken back when the mod stops, so a mod that keeps a feature for the whole session ignores what the call returns.

```ts
type Subscription = { remove(): void }
```

```ts
const watching = sessions.current.onToolCall({ name: 'Edit' }, () => void (mod.state.session.edits += 1))
mod.use(slashCommand({ name: 'stop-counting', description: 'Stop counting edits', reply: () => watching.remove() }))
```

### mod.every and mod.after

```ts
mod.every(ms: number, listener: () => unknown): Timer
mod.after(ms: number, listener: () => unknown): Timer

type Timer = { readonly isRunning: boolean; stop(): void }
```

`every` runs `listener` every `ms` milliseconds until the session ends or the mod calls `stop()`. A tick that comes while the last run is still going is skipped, so a slow run never stacks up. `after` runs `listener` once, `ms` milliseconds from now, unless the mod calls `stop()` first. `isRunning` is true until the timer stops, and an `after` timer stops once it ran. A run that throws shows the error toast `The every <ms> ms timer failed`, or `The after <ms> ms timer failed`, and the next tick of an `every` runs again. `ms` is a whole number above 0 and at most `2147483647`, and any other `ms` stops `setup` with `<mod>: mod.every is <ms>. Give a whole number of milliseconds above 0 and at most 2147483647.`

A watch that reacts on its own is `every` plus `mod.state` plus a `prompt` with no trigger: `every` checks the outside world, writes what it found to `mod.state`, and the panes and the prompt follow the state ([jobs.md](jobs.md#prompt)).

```ts
mod.every(60_000, async () => {
  const { stdout } = await process.run(['gh', 'run', 'list', '--limit', '1', '--json', 'conclusion'])
  mod.state.session.ci = JSON.parse(stdout)[0]?.conclusion ?? 'running'
})
```

### mod.log

```ts
mod.log(text: string, options?: { to?: 'debug' | 'transcript' }): void
```

`log` writes `<mod>: <text>` to Claude Code's debug log, which `claude --debug` shows. It is for what helps the mod's author find a fault and the person never needs to see. Tell the person with a toast instead ([ui.md](ui.md#toasts)).

With `{ to: 'transcript' }`, the line shows dim in the conversation, where the person reads it and Claude never does, such as "Formatted 3 files" after a turn.

### Hotkeys

A hotkey is a key combo the mod listens for, such as `alt+shift+p` to show a page. The mod declares each one with a title and an optional default combo, and the person changes the combo in Settings, under the mod, Hotkeys, the way VS Code handles an extension's keybindings.

```ts
hotkeys?: { readonly [name: string]: { readonly title: string; readonly default?: Combo } }

type Hotkey = {
  readonly title: string
  readonly combo: Combo | undefined
  onPress(listener: () => unknown): Subscription
}
```

- A name is letters, digits, and `_`, starting with a letter. `title` is the label Settings shows beside the combo.
- A combo is one or two of `ctrl`, `alt`, `shift`, and `meta`, in that order, then a key: a letter, a digit, `f1` to `f12`, `tab`, `enter`, `escape`, `space`, `backspace`, `delete`, an arrow, `home`, `end`, `pageup`, `pagedown`, or a mark such as `/`. `ctrl+q`, `alt+shift+p`, and `ctrl+shift+k` are combos.
- `defineMod` throws for a name, a title, or a combo that is not one, and for two hotkeys with one default.
- `cmod check` writes the hotkeys into `package.json` `"cmod".hotkeys`, and `cmod publish` refuses a mod whose `package.json` differs from `defineMod`. The install question lists each default combo, and `cmod setup` binds it in Claude Code's `keybindings.json`. A combo the person already bound to something else keeps their binding, and the hotkey has no combo until they pick one in Settings.
- A hotkey without a `default` starts unbound. The install question and the Installed toast leave it out, and Settings lists it as unbound until the person binds it there or with `cmod hotkey` ([commands.md](commands.md#cmod-hotkey)). Leave out `default` when the person should choose the key, such as for an action few people press.
- `combo` is the combo bound when the mod started, or `undefined` when `keybindings.json` binds none to the hotkey, such as when another binding kept the default or the hotkey has no default.
- `onPress` runs `listener` each time the person presses the combo. A page or pane the listener opens shows at any width, because the press is the person's own ([ui.md](ui.md#the-sidebar-and-its-pages)).
- `tested.hotkey(name)` presses a hotkey in a test ([testing.md](testing.md)).

```tsx
export const notes = defineMod({
  name: 'notes',
  hotkeys: {
    toggle: { title: 'Show or hide the notes', default: 'alt+shift+n' },
  },
  setup(mod) {
    const page = mod.sidebar.add(notesPage)
    mod.hotkeys.toggle.onPress(() => page.toggle({ focus: true }))
  },
})
```

## commands: slash commands

```ts
commands.list(): Promise<CommandInfo[]>
commands.run(name: string, args?: string): Promise<{ text?: string; note?: string }>
commands.beforeRun(matcher?, listener: (run: CommandRun) => Answer | void, options?): Subscription
commands.onRun(matcher?, listener: (run: CommandRun) => unknown, options?): Subscription

type CommandInfo = { name: string; description: string; source: 'builtin' | 'plugin' | 'user' | 'mcp'; plugin?: string }
type CommandRun = { name: string; args: string; source?: 'builtin' | 'plugin' | 'user' | 'mcp'; from: Sender; session: string; cwd: string }
```

- `list` answers every command the person can type: Claude Code's own, each plugin's, the person's and the project's, and each MCP server's prompts.
- `run` runs a command, a built-in such as `compact` included, the way the person typing `/<name> <args>` would. It resolves the text the command printed and the note it left Claude. It needs the `prompt` permission.
- `beforeRun` runs just before any command runs, typed or run by a mod, and its answer changes it: `{ args?, note? }` runs it with new arguments and adds a note Claude reads after its output, `{ result, exitCode? }` answers in its place without running it, and `{ refuse }` runs nothing and shows the reason as its output. An answer needs the `prompt` permission. `exitCode` is what a `claude -p "/lint"` run exits with.
- `onRun` hears each command once it ran.
- A command a project or a plugin writes as a Markdown prompt, such as `/review`, also reaches `beforePrompt` after `beforeRun`, as its text goes to Claude ([session.md](session.md#change-what-happens)). A built-in such as `/model` reaches only these two.

```ts
commands.beforeRun({ name: 'compact' }, () => (mod.state.session.isDeploying ? { refuse: 'Compact once the deploy finishes.' } : undefined))
commands.onRun({ name: 'model' }, (run) => mod.log(`model set to ${run.args}`))
```

A command of the mod's own is a `slashCommand` job ([jobs.md](jobs.md#slashcommand)).

## settings: Claude Code's settings files

```ts
settings.user.read(): Promise<Settings>
settings.user.update(values: Readonly<Record<string, unknown>>): Promise<void>
settings.project.read(): Promise<Settings>
settings.project.update(values: Readonly<Record<string, unknown>>): Promise<void>
settings.local.read(): Promise<Settings>
settings.local.update(values: Readonly<Record<string, unknown>>): Promise<void>
settings.beforeFileChange(matcher?, listener: (change: SettingsFileChange) => { refuse: string } | void): Subscription
```

`settings.user` is the person's own `~/.claude/settings.json`, `settings.project` is the project's `.claude/settings.json`, and `settings.local` is the project's `.claude/settings.local.json`.

- `read` answers the values in that one file, such as `(await settings.user.read())['enabledPlugins']`.
- `update` merges `values` into that file as a JSON Merge Patch ([RFC 7396](https://www.rfc-editor.org/rfc/rfc7396)). `mcpServers` in `settings.project` goes to the project's `.mcp.json`, where Claude Code reads a project's servers.
- An object merges into the object already at that key, at every depth, so every key it does not name stays as it was. `null` removes the key at its depth. An array or any other value replaces the value. To replace a whole object, read it and set each key you drop to `null`.
- The file's comments and formatting stay as they were.
- Each value needs a `config` permission for its key path or a path above it ([permissions.md](permissions.md)): `"config": ["env.ANTHROPIC_BASE_URL"]` covers that one value, and `"config": ["env"]` covers every key in `env`. `update` rejects with the line to add for a value no grant covers, and changes nothing.
- Removing the mod takes out each value it set that still equals what it set, then each object that leaves empty. A value the person changed since stays.
- `fs.write` to a Claude Code settings file rejects and names `update`, because a whole-file write loses the person's own edits and leaves the mod's values behind when it is removed.

A mod that points Claude Code at its local proxy sets one variable in `env`, and the person's other variables stay:

```ts
await settings.user.update({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' } })
```

`beforeFileChange` hears each settings file Claude Code sees edited while the session runs, and a Skill file edited, and `{ refuse }` keeps Claude Code on the values it had. `source` is `'user'`, `'project'`, `'local'`, `'policy'`, or `'skills'`, and `path` is the file, when Claude Code names it:

```ts
type SettingsFileChange = { source: 'user' | 'project' | 'local' | 'policy' | 'skills'; path?: string }

settings.beforeFileChange({ source: /^(user|project)$/ }, () => ({ refuse: 'Settings are locked while the deploy runs.' }))
```

## config: the /config menu

```ts
config.list(): Promise<ConfigRow[]>

type ConfigRow = { key: string; label: string; description?: string; kind: 'boolean' | 'choice' | 'text' | 'number'; value: boolean | string | number | readonly string[]; options?: readonly string[]; plugin?: string; isLocked: boolean }
```

`config.list` answers every row of Claude Code's `/config` menu, its own and each plugin's, with the value each holds now. `plugin` names the plugin a row belongs to, and Claude Code's own rows have none. `isLocked` is true when a managed setting or the organization's policy holds the value.

## model: one question outside the conversation

```ts
model.complete(request: ModelCompleteRequest, options?: { signal?: AbortSignal }): Promise<ModelCompleteResult>
```

`complete` asks a model one question through Claude Code's own login, outside the conversation, so the answer costs no context and the person sees no turn. The request names the `model`, such as `'haiku'`, and the `prompt`, and takes `system`, `maxTokens`, `effort`, and `timeoutMs`. `timeoutMs` stops a model that is slow or down, so the listener that waits on it still answers in time. `options.signal` stops the call when its `AbortController` aborts. It needs the `model` permission.

The call never rejects for what the model did. The result's `isAnswered` is true with the reply's `text`, or false with a `reason`, such as `'api-error'` or `'aborted'`.

Give the listener that waits on it time too, with its `timeoutMs` ([session.md](session.md#give-a-listener-time)), which also covers the work around the call:

```ts
sessions.current.beforeTurnEnd(async (turn, { signal }) => {
  const verdict = await model.complete({ model: 'haiku', prompt: `Does this reply ask the person to do work Claude could do itself? Answer yes or no.\n\n${turn.answer ?? ''}`, timeoutMs: 8000 }, { signal })
  if (verdict.isAnswered && verdict.text.trim().toLowerCase().startsWith('yes')) return { refuse: 'Do that work yourself, then reply.' }
}, { timeoutMs: 9000 })
```

## process: run a program

```ts
process.run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult>
process.spawn(argv: readonly string[], init?: { cwd?, env?, input? }): HookStream<ProcessSpawnChunk, ProcessSpawnResult>
```

Both run a program without a shell. `argv[0]` is the program and the rest are its arguments. A bare name that cmod installed, such as `trace`, runs from cmod's programs folder ([install-steps.md](install-steps.md#run-a-program-by-its-name)), and any other name runs through Claude Code's `PATH`. Each program needs its `run` permission.

- `init.cwd` is the program's folder, absolute or relative to the session's working folder. Without it the program runs in the session's working folder.
- `init.env` sets variables over Claude Code's own environment.
- `run` takes `stdin`, and `spawn` takes `input`: text written to standard input, which then closes.
- `run` takes `timeoutMs`: Claude Code kills the program after it, 30 seconds by default and 10 minutes at most. `longestMs`, exported from `mod.js`, is those 10 minutes in milliseconds, `600000`.
- `run` resolves `{ exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated }` once the program exits, whatever its exit code. It keeps the first 4 MiB of each stream. A program ended by a signal has `exitCode` 1.
- `run` rejects when the program cannot start, and when it is still running at `timeoutMs`. It reads the whole output, so a background process the program leaves writing holds the call until the timeout.
- `spawn` streams `{ stream: 'stdout' | 'stderr', text }` pieces as the program writes them. Its `result` resolves `{ code, signal }` once the stream is read to its end. Its first pull rejects when the program cannot start.
- The `for await` loop over a `spawn` is the program's life. Leaving the loop, or calling `return()` on the stream, kills the program, and so does unloading the mod. Returning from the listener does not.

A job's deadline bounds the whole callback that makes these calls ([jobs.md](jobs.md#deadlines)).

```ts
import { defineMod, process, sessions } from '../node_modules/@cmodjs/core/mod.js'

export const branchNote = defineMod({
  name: 'branch-note',
  setup() {
    sessions.current.beforeSessionStart(async () => {
      const { exitCode, stdout } = await process.run(['git', 'branch', '--show-current'], { cwd: sessions.current.project })
      if (exitCode !== 0) return
      return { note: `The git branch is ${stdout.trim()}.` }
    })
  },
})
```

## fs: files

```ts
fs.read(path: string): Promise<string>
fs.write(path: string, text: string): Promise<void>
fs.list(path?: string): Promise<Entry[]>
fs.exists(path: string): Promise<boolean>
fs.stat(path: string, options?: { resolve: boolean }): Promise<Stat>
fs.find(glob: string | readonly string[]): Promise<readonly FileMatch[]>
fs.onChange({ path: string | readonly string[] }, listener: (change: FileChange) => unknown): Subscription
```

```ts
type FileChange = { path: string; type: 'change' | 'add' | 'unlink' }
type Entry = { name: string; isFile: boolean; isFolder: boolean; isLink: boolean; size: number; modifiedAt: number }
type Stat = { isFile: boolean; isFolder: boolean; isLink: boolean; size: number; modifiedAt: number; realPath?: string }
```

- A relative path is under the session's working folder. An absolute path is used as given. `~/.claude` and `$CLAUDE_CONFIG_DIR` are Claude Code's config folder, and `~` and `$HOME` are the home folder. Text is UTF-8.
- `read` rejects a missing file and a file over 4 MiB.
- `write` writes the whole file and creates its folders. Writing outside the project and the mod's data folder needs the `files` permission.
- `list` lists a folder, the working folder without a path. A symbolic link is neither a file nor a folder, with `isLink` true. `modifiedAt` is the time it last changed, in milliseconds since 1970.
- `exists` answers whether the path leads to a file or a folder.
- `stat` answers what the path leads to, following a symbolic link, and rejects a missing path. With `{ resolve: true }` it also answers `realPath`: the absolute path, every symbolic link followed.
- `onChange` hears each file that changes, appears, or goes at a path or under a folder, the mod's own saves included. cmod checks the paths twice a second, and at most 2000 files under one call's folders. A call over more stops, with an error toast that names its paths. It works from `setup` or any time later, and for a path that does not exist yet. A relative path is under the session's working folder. `path` takes strings only, unlike other matchers:

```ts
fs.onChange({ path: `${mod.dataFolder}/history` }, ({ path, type }) => mod.toast(`${path}: ${type}`))
```

A file the mod ships is under `mod.folder`. A file the mod keeps for itself belongs in `mod.dataFolder`.

`find` answers every file a glob matches, each with its metadata, so a mod finds the Skills, agents, scripts, or notes it acts on in one call:

```ts
type FileMatch = { readonly path: string; readonly name?: string; readonly metadata: Readonly<Record<string, string>>; readonly error?: string }
```

- A glob starting with `~/.claude` starts at Claude Code's config folder, `CLAUDE_CONFIG_DIR` when it is set. One starting with `~/` starts at home, one starting with `/` is absolute, and any other starts at the project. Several globs answer each file once.
- `path` is absolute. `name` is a Markdown file's frontmatter `name`. `metadata` holds the mod's own keys, bare, as `metadata.read` answers them.
- `find` follows symbolic links into the folders they point at, once each. It skips `.git` and `node_modules` unless the glob names them.
- A file whose metadata cmod cannot read comes back with empty `metadata` and an `error` naming the line, and cmod logs it once. A file cmod cannot open comes back the same way, with an `error` naming the reason.
- A folder cmod cannot list, such as one it has no permission to read, is left out, and cmod writes `<mod>: fs.find skipped <folder>: <reason>` to Claude Code's debug log once.
- cmod keeps what it read of each file until the file's modified time or size changes.

```ts
const skills = await fs.find(['~/.claude/skills/*/SKILL.md', '.claude/skills/*/SKILL.md'])
const planning = skills.filter((skill) => skill.metadata['modes']?.split(' ').includes('plan'))
```

## metadata: a file's own keys

```ts
metadata.read(path: string): Promise<Readonly<Record<string, string>>>
metadata.update(path: string, change: (metadata: Record<string, string>) => void): Promise<void>
```

Metadata is a file's own set of string keys, kept in the file, so it moves and is committed with the file. Each mod reads and writes its own keys only: the file stores them as `<mod>.<key>`, and the mod sees them bare. A value is one line of text, and a list is one space-separated string.

Where a file keeps its metadata depends on its type:

```markdown
---
name: plan
metadata:
  modes.modes: plan build
---
```

```sh
#!/bin/sh
# /// metadata
# modes.modes: plan build
# ///
```

- A Markdown file keeps it in its frontmatter, under `metadata:`.
- A `.sh`, `.py`, `.ts`, `.js`, `.yaml`, or `.toml` file keeps it in a `/// metadata` comment block after any shebang, in the file's own comment, `#` or `//`, the way PEP 723 keeps a Python script's dependencies.
- Any other file keeps it in a sidecar, `<file>.meta`.

`update` hands `change` the mod's current keys, and writes what `change` leaves. It changes only the metadata block, keeps other mods' keys, writes nothing when nothing changed, and removes an empty block. It writes through a symbolic link to the file it points at. Writing a file outside the project and the mod's data folder needs the `files` permission, as `fs.write` does ([permissions.md](permissions.md)). A key is letters, digits, `_`, `.`, and `-`, and `update` rejects any other key and a value with a line break.

`read` rejects when cmod cannot open the file or read its metadata, with the reason or the line. `update` rejects the same way and writes nothing, so it never overwrites metadata it could not read.

```ts
await metadata.update('.claude/skills/plan/SKILL.md', (keys) => {
  keys['modes'] = 'plan build'
})
```

`cmod check` reads the metadata of every file the mod ships, and fails one cmod cannot read.

## http: fetch a URL

```ts
http.fetch(url: string, init?: HttpInit): Promise<HttpResponse>
```

- `init` takes `method` (`GET` by default), `headers`, `body` as text, and `socketPath`, the absolute path of a Unix socket the request goes over.
- The response is `{ status, ok, headers, text }`. `ok` is true for a 2xx status. Header names are lower case.
- Each host needs its `network` permission. A fetch to the address the mod's own `program` job answers on needs none, while that program runs ([jobs.md](jobs.md#program)).

## messageOf

```ts
messageOf(error: unknown): string
```

Returns an `Error`'s `message`, or the value as text. Use it in a `catch`, where the error is `unknown`.

```ts
import { defineMod, fs, messageOf, sessions } from '../node_modules/@cmodjs/core/mod.js'

export const notes = defineMod({
  name: 'notes',
  setup(mod) {
    sessions.current.onTurnEnd(async () => {
      await fs.write(`${mod.dataFolder}/last-stop.txt`, new Date().toISOString()).catch((error: unknown) => {
        mod.toast.error('Could not save the last stop', { description: messageOf(error) })
      })
    })
  },
})
```

## shell.js and path.js: read a command line

`shell.js` reads a Bash line the way cmod does for a tool call's `files` ([session.md](session.md#files-what-a-tool-call-reads-and-changes)), and `path.js` is `node:path`'s POSIX functions, which a mod cannot import from Node:

```ts
parseShell(line: string): ParsedShell

type ParsedShell = { commands: ShellCommand[]; reads: string[]; writes: string[]; fetches: string[]; isFullyParsed: boolean }
type ShellCommand = { argv: [string, ...string[]]; folder: string; input?: number }

resolve(...paths): string   join(...paths): string   dirname(path): string   basename(path, suffix?): string
extname(path): string        relative(from, to): string   isAbsolute(path): boolean   normalize(path): string
```

- `commands` lists every command the line runs, those inside `sudo`, `bash -c`, `$(…)`, and heredocs included, with flags such as `-rf` split into `-r` and `-f`.
- `folder` is where a command runs, as the line wrote it: `''` for the folder the line starts in, `src` after `cd src`, `/tmp` after `cd /tmp`, and `~/p` after `cd ~/p`. `resolve(call.cwd, folder)` makes it absolute.
- `input` is the index in `commands` of the command whose output this one reads through `|` or `|&`, and is absent for a command that reads no pipe. `trace read a.ts | head -5` gives `head` the `input` `0`. A wrapper such as `timeout 5 trace read a.ts` writes the output of the command it runs, so `input` names `trace`, not `timeout`.
- `reads`, `writes`, and `fetches` are the paths and URLs the commands name, as written. A path that holds a shell expansion makes `isFullyParsed` false, and so does a line the parser cannot read.
- `resolve` has no working folder to start from in Claude Code, so pass an absolute folder first, such as `resolve(sessions.current.cwd, path)`.

```ts
import { basename, resolve } from '../node_modules/@cmodjs/core/path.js'
import { parseShell } from '../node_modules/@cmodjs/core/shell.js'
import { sessions } from '../node_modules/@cmodjs/core/mod.js'

sessions.current.onToolCall({ name: 'Bash' }, (call) => {
  for (const { argv, folder } of parseShell(String(call.input['command'])).commands) {
    if (basename(argv[0]) === 'trace') mod.toast(`trace runs in ${resolve(call.cwd, folder)}`)
  }
})
```
