# Define a mod

`defineMod` describes a mod: its name, its state, the methods it offers other mods, and the `setup` function that attaches everything to Claude Code. `registerMod` registers the definition with Claude Code.

## defineMod

```ts
defineMod<State, Name, Options>(definition: ModDefinition<State, Name, Options>): ModDefinition<State, Name, Options>
```

```ts
type ModDefinition<State, Name, Options> = {
  readonly name: Name
  readonly state?: State
  readonly options?: Options
  readonly api?: { … }
  readonly installer?: readonly Step<State>[]
  setup(mod: Mod<State, Options>): unknown
}
```

- `name` is the mod's name. Use the `name` in `.claude-plugin/plugin.json`. Claude Mod Manager (cmod) keys the saved state and the options by this name, and the data folder and the Skill overrides by the plugin's name, so the two must match. `defineMod` throws `defineMod: the mod needs a name, such as the name in .claude-plugin/plugin.json.` for a blank name.
- `state` holds the starting values, grouped by how long they last. [state.md](state.md) explains the groups.
- `options` declares what a person sets, such as a token, and types `mod.options`. [options.md](options.md) explains them.
- `api` holds the methods other mods call. [dependencies.md](dependencies.md) explains it.
- `installer` lists the steps the person finishes in Claude Code after the permissions and the options, such as signing in. [install-steps.md](install-steps.md#steps-in-claude-code) explains them.
- `setup` runs once when the mod starts. It adds hooks, panes, renders, and jobs. It may be `async`.

```tsx
import { defineMod, UserPromptSubmit } from '../node_modules/@cmodjs/core/mod.js'

export const greeter = defineMod({
  name: 'greeter',
  state: { session: { isGreeted: false } },

  setup(mod) {
    mod.on(UserPromptSubmit, () => {
      if (mod.state.session.isGreeted) return
      mod.state.session.isGreeted = true
      mod.ui.toast(`Hello from ${mod.name}`)
    })
  },
})
```

## When setup runs

Claude Code loads the mod at the start of each session. cmod then checks that the mod is set up. A mod the person has not accepted yet opens the installer pane, `Install <name>`, which lists its permissions and the changes it makes to the computer, and waits for Accept ([install-steps.md](install-steps.md)). An option with no default and no value is asked on the next page of the same pane. Then cmod loads the saved state, runs `setup`, marks as open each of the mod's panes that Claude Code already shows, and opens the pane again for each `installer` step the mod declares that is not done.

The first time a mod starts on a machine, cmod shows the toast `Installed` under its name. Opened, it lists the mod's `plugin.json` `description`, what setup added, such as `Adds the my-mod pane, a render of AbovePrompt and a hook on UserPromptSubmit.`, what its install step set up, and each permission the person allowed, with a Settings button for `/mods <name>`. The first time a new version starts, the toast is `Updated to <version>`: the first three changes of that version's `CHANGELOG.md` section, the version the machine ran before, and a Changelog button ([Release notes](#release-notes)). A mod with no changelog lists what it adds now and no longer adds instead. A new session, `/reload-plugins`, and a version the machine already ran show no toast.

When a step fails, or the person declines the install, the mod stays stopped. Once another session sets it up, the mod starts at the next prompt of every session it stopped in, with no `/reload-plugins`.

When a step fails, the mod does not start. An error toast above the prompt names the failure, with the fix under it:

- `<mod>: state.<group> is not a lifetime. …` or `<mod>: state.<group> is not an object of values. …` when the declared state is not valid ([state.md](state.md)).
- `its state did not load: <error>` when reading the saved values fails.
- `it needs <titles>` when the person chose Not now on an option with no default, or no one can answer, as in `claude -p` ([options.md](options.md)). This one says `Set it in /config.` instead, and Claude Code reloads the mod once the value is set.
- `its setup function threw: <error>` when `setup` throws or rejects.
- `its open panes did not load: <error>` when Claude Code cannot list the open panes.
- `the details of its session did not load: <error>` when Claude Code cannot name the session's id, model, or start time.
- `it decides permissions on <events>, so hooks/register.ts must call registerPermissionCheck(addHook) after registerMod` when `setup` adds a hook on `PermissionRequest`, or a job that decides permissions, and `register.ts` does not register the permission check.

Each of these has `Retry`, which starts the mod again, and `Report` and `Hide` ([ui.md](ui.md#toasts)).

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
- The Updated toast shows the first three changes of the new version's section, and its Changelog button opens `/mods <name> changelog`, the whole file with the installed version at the top of the view.
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

`registerMod` registers one handler per Claude Code event the mod can use, and routes each event to the mod. `options` is what Claude Code passes `register`: the values of the mod's options ([options.md](options.md)). `registeredMod` returns the definition `registerMod` got, for `cmod check` to read the mod's options without starting it. A `PreToolUse` hook runs on `tool.call`, which `registerMod` registers ([hooks.md](hooks.md)). It leaves out Claude Code's permission check, the events `tool.check` and `PermissionRequest`.

A mod that decides permissions calls `registerPermissionCheck` after `registerMod`. That covers a `PreToolUse` hook that answers `permissionDecision: 'allow'` or `'ask'`, a hook on `PermissionRequest`, the `permissions` job, and a job of your own on `tool.check`:

```ts
export function register(addHook: On, options: PluginOptions): void {
  registerMod(addHook, guard, options)
  registerPermissionCheck(addHook)
}
```

Such a mod also declares `"approve": true` in its `package.json` `"cmod".permissions`, so the person grants it at install. `cmod check` adds the line when it is missing, and without the grant cmod drops every allow or ask the mod answers, so Claude Code decides those calls itself ([permissions.md](permissions.md)). A mod without `registerPermissionCheck` has no part in Claude Code's permission check, so the plugin directory reads it as one that never answers a permission. A mod that decides permissions without it does not start, and its error toast names the line to add.

Keep `register.ts` this small. Claude Code checks a hooks module before it loads it, and refuses some shapes, such as a `$` passed to a function in another module. The plugin directory reads the bundled module too, and flags it when the name of `register`'s first parameter is declared anywhere else in the bundle. `@cmodjs/core` declares `on` as the method `mod.on`, so name that parameter `addHook`. Declare `register` as a function, as here: `cmod publish` bundles the hooks module into one file, and Claude Code refuses a bundled `register` that is not one.

## mod: this mod

`setup` gets `mod`, of type `Mod<State, Options>`. Every hook, render, and job gets the same `mod`. `mod` holds what belongs to this mod: its name, its folders, its values, its grants, and what it adds to Claude Code.

```ts
type Mod<State, Options> = {
  readonly name: string
  readonly folder: string
  readonly dataFolder: string
  readonly state: Readonly<State>
  readonly options: OptionValues<Options>
  readonly permissions: Permissions
  on(hook, listener, options?): Disposable
  on(hook, matcher, listener, options?): Disposable
  every(ms, listener): Disposable
  after(ms, listener): Disposable
  use(job): Handle
  log(text): void
  readonly ui: { pane, render, toast, ask, copy, scroll, notice }
  readonly settings: { page, open }
  readonly dependencies: CmodDependencies
}
```

| Member | What it is | Docs |
| --- | --- | --- |
| `name` | The mod's name from `defineMod`. | |
| `folder` | The plugin's own folder, where the files the mod ships live. | |
| `dataFolder` | The mod's own folder in the cmod store: `$XDG_DATA_HOME/cmod/data/<plugin name>`, or `~/.local/share/cmod/data/<plugin name>` when `XDG_DATA_HOME` is not set. The install step gets the same folder as `CMOD_DATA`. cmod deletes it when the mod is removed. | [install-steps.md](install-steps.md) |
| `state` | The mod's values. Assign to a key to change it. | [state.md](state.md) |
| `options` | The values a person set for the mod's options, typed from their declaration. Read-only. | [options.md](options.md) |
| `permissions` | Says whether the person granted each permission. | [permissions.md](permissions.md) |
| `on` | Listens to a Claude Code hook, such as `PreToolUse`. | [hooks.md](hooks.md) |
| `every` and `after` | Run a listener on a timer while the session runs. | below |
| `use` | Adds a job, such as a slash command or a tool, and returns its handle. | [jobs.md](jobs.md) |
| `log` | Writes a line, under the mod's name, to Claude Code's debug log. | below |
| `ui` | Panes, renders at a place Claude Code draws, toasts, questions, the clipboard, scrolling, and a line under a permission dialog. | [ui.md](ui.md) |
| `settings` | Adds the mod's own pages to `/mods`, and opens them. | below |
| `dependencies` | Calls the methods of other mods. | [dependencies.md](dependencies.md) |

Everything that is Claude Code's or the computer's rather than the mod's is an import from `mod.js`, so a function in any file calls it without being handed `mod`:

```ts
import { fs, http, metadata, model, process, sessions, settings } from '../node_modules/@cmodjs/core/mod.js'
```

| Import | What it is | Docs |
| --- | --- | --- |
| `sessions` | The conversations: the one the mod runs in, every other one, and search across them. | [session.md](session.md) |
| `settings` | Claude Code's `settings.json` files: the person's, the project's, and the project's local one. | below |
| `model` | Asks a model one question, outside the conversation. | below |
| `fs` | Reads, writes, lists, and finds files. | below |
| `metadata` | Reads and changes the mod's keys in one file's metadata. | below |
| `process` | Runs a program. | below |
| `http` | Fetches a URL. | below |

Each import works once the mod has started, in `setup` and anything it adds. Each one checks the permission it needs, and rejects with the line to add or the grant to turn on when the person has not granted it ([permissions.md](permissions.md)).

### Disposable

`mod.on`, `mod.every`, `mod.after`, `mod.ui.render`, and a session's `on` each return a `Disposable`. `dispose()` takes back what the call added, so a mod turns a feature off and on while it runs. Everything a mod adds is taken back when the mod stops, so a mod that keeps a feature for the whole session ignores the `Disposable`.

```ts
type Disposable = { dispose(): void }
```

```ts
const watching = mod.on(PostToolUse, { tool_name: 'Edit' }, () => void (mod.state.session.edits += 1))
mod.use(slashCommand({ name: 'stop-counting', description: 'Stop counting edits', reply: () => watching.dispose() }))
```

### mod.every and mod.after

```ts
mod.every(ms: number, listener: () => unknown): Disposable
mod.after(ms: number, listener: () => unknown): Disposable
```

`every` runs `listener` every `ms` milliseconds until the session ends or the mod disposes it. A tick that comes while the last run is still going is skipped, so a slow run never stacks up. `after` runs `listener` once, `ms` milliseconds from now, unless the mod disposes it first. A run that throws shows the error toast `The every <ms> ms timer failed`, or `The after <ms> ms timer failed`, and the next tick of an `every` runs again. `ms` is a whole number above 0 and at most `2147483647`, and any other `ms` stops `setup` with `<mod>: mod.every is <ms>. Give a whole number of milliseconds above 0 and at most 2147483647.`

A watch that reacts on its own is `every` plus `mod.state` plus a `prompt` with no trigger: `every` checks the outside world, writes what it found to `mod.state`, and the panes and the prompt follow the state ([jobs.md](jobs.md#prompt)).

```ts
mod.every(60_000, async () => {
  const { stdout } = await process.run(['gh', 'run', 'list', '--limit', '1', '--json', 'conclusion'])
  mod.state.session.ci = JSON.parse(stdout)[0]?.conclusion ?? 'running'
})
```

### mod.log

```ts
mod.log(text: string): void
```

`log` writes `<mod>: <text>` to Claude Code's debug log, which `claude --debug` shows. It is for what helps the mod's author find a fault and the person never needs to see. Tell the person with a toast instead ([ui.md](ui.md#toasts)).

### mod.settings

```ts
mod.settings.page(page: Pane<State>): void
mod.settings.open(pageId?: string): Promise<void>
```

`/mods` shows each mod's description, options, permissions, keys, and changelog, and turns a mod off or removes it. `page` adds a page of the mod's own to its entry there, drawn as any pane is ([ui.md](ui.md)). The id `changelog` is taken by the Changelog page, so `page` refuses it. `open` opens that page, or with no id opens the mod's entry in `/mods`. `open` rejects for an id `page` did not add.

```tsx
mod.settings.page(definePane({ id: 'runs', title: 'Runs', render: (current) => <Text>{current.state.session.lastRun}</Text> }))
mod.use(slashCommand({ name: 'ci-runs', description: 'Show the CI runs', reply: () => void mod.settings.open('runs') }))
```

## settings: Claude Code's settings files

```ts
settings.list(): Promise<Setting[]>
settings.user.read(): Promise<Settings>
settings.user.update(values: Readonly<Record<string, unknown>>): Promise<void>
settings.project.read(): Promise<Settings>
settings.project.update(values: Readonly<Record<string, unknown>>): Promise<void>
settings.local.read(): Promise<Settings>
settings.local.update(values: Readonly<Record<string, unknown>>): Promise<void>
```

`settings.list` answers every row of Claude Code's `/config` menu, its own and each plugin's, with the value each holds now:

```ts
type Setting = { key: string; label: string; description?: string; kind: 'boolean' | 'choice' | 'text' | 'number'; value: boolean | string | number | readonly string[]; options?: readonly string[]; plugin?: string; isLocked: boolean }
```

`plugin` names the plugin a row belongs to, and Claude Code's own rows have none. `isLocked` is true when a managed setting or the organization's policy holds the value.

`settings.user` is the person's own `~/.claude/settings.json`, `settings.project` is the project's `.claude/settings.json`, and `settings.local` is the project's `.claude/settings.local.json`.

- `read` answers the values in that one file, such as `(await settings.user.read())['enabledPlugins']`.
- `update` writes each top-level key of `values` into that file. `mcpServers` in `settings.project` goes to the project's `.mcp.json`, where Claude Code reads a project's servers.
- A key replaces its whole value, and `null` removes the key. Every other key, and the file's formatting, stays as it was.
- Each key needs its own `config` permission, such as `"config": ["cleanupPeriodDays"]` ([permissions.md](permissions.md)), and `update` rejects with the line to add for a key without one.
- Removing the mod takes out each value it set that still equals what it set, so a value the person changed since stays.
- `fs.write` to a Claude Code settings file rejects and names `update`, because a whole-file write loses the person's own edits and leaves the mod's values behind when it is removed.

```ts
await settings.user.update({ cleanupPeriodDays: 365 })
```

## model: one question outside the conversation

```ts
model.complete(request: ModelCompleteRequest, options?: { signal?: AbortSignal }): Promise<ModelCompleteResult>
```

`complete` asks a model one question through Claude Code's own login, outside the conversation, so the answer costs no context and the person sees no turn. The request names the `model`, such as `'haiku'`, and the `prompt`, and takes `system`, `maxTokens`, `effort`, and `timeoutMs`. `timeoutMs` stops a model that is slow or down, so the listener that waits on it still answers in time. `options.signal` stops the call when its `AbortController` aborts. It needs the `model` permission.

The call never rejects for what the model did. The result's `isAnswered` is true with the reply's `text`, or false with a `reason`, such as `'api-error'` or `'aborted'`.

Put a limit on the listener too, with `mod.on`'s `timeoutMs` ([hooks.md](hooks.md#mod-on)), which also covers the work around the call:

```ts
mod.on(Stop, async ({ last_assistant_message }) => {
  const verdict = await model.complete({ model: 'haiku', prompt: `Does this reply ask the person to do work Claude could do itself? Answer yes or no.\n\n${last_assistant_message}`, timeoutMs: 8000 })
  if (verdict.isAnswered && verdict.text.trim().toLowerCase().startsWith('yes')) return { decision: 'block', reason: 'Do that work yourself, then reply.' }
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
import { defineMod, process, SessionStart, sessions } from '../node_modules/@cmodjs/core/mod.js'

export const branchNote = defineMod({
  name: 'branch-note',
  setup(mod) {
    mod.on(SessionStart, async () => {
      const { exitCode, stdout } = await process.run(['git', 'branch', '--show-current'], { cwd: sessions.current.project })
      if (exitCode !== 0) return
      return { hookSpecificOutput: { hookEventName: SessionStart, additionalContext: `The git branch is ${stdout.trim()}.` } }
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
```

```ts
type Entry = { name: string; isFile: boolean; isFolder: boolean; isLink: boolean; size: number; modifiedAt: number }
type Stat = { isFile: boolean; isFolder: boolean; isLink: boolean; size: number; modifiedAt: number; realPath?: string }
```

- A relative path is under the session's working folder. An absolute path is used as given. `~/.claude` and `$CLAUDE_CONFIG_DIR` are Claude Code's config folder, and `~` and `$HOME` are the home folder. Text is UTF-8.
- `read` rejects a missing file and a file over 4 MiB.
- `write` writes the whole file and creates its folders. Writing outside the project and the mod's data folder needs the `files` permission.
- `list` lists a folder, the working folder without a path. A symbolic link is neither a file nor a folder, with `isLink` true. `modifiedAt` is the time it last changed, in milliseconds since 1970.
- `exists` answers whether the path leads to a file or a folder.
- `stat` answers what the path leads to, following a symbolic link, and rejects a missing path. With `{ resolve: true }` it also answers `realPath`: the absolute path, every symbolic link followed.

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
import { defineMod, fs, messageOf, Stop } from '../node_modules/@cmodjs/core/mod.js'

export const notes = defineMod({
  name: 'notes',
  setup(mod) {
    mod.on(Stop, async () => {
      await fs.write(`${mod.dataFolder}/last-stop.txt`, new Date().toISOString()).catch((error: unknown) => {
        mod.ui.toast.error('Could not save the last stop', { description: messageOf(error) })
      })
    })
  },
})
```
