# Define a mod

`defineMod` describes a mod: its name, its state, the methods it offers other mods, and the `setup` function that attaches everything to Claude Code. `connect` hands the definition to Claude Code.

## defineMod

```ts
defineMod<State, Name>(definition: ModDefinition<State, Name>): ModDefinition<State, Name>
```

```ts
type ModDefinition<State, Name> = {
  readonly name: Name
  readonly state?: State
  readonly api?: { … }
  setup(mod: Mod<State>): void | Promise<void>
}
```

- `name` is the mod's name. Use the `name` in `.claude-plugin/plugin.json`. Claude Mod Manager (CMod) keys the saved state and the `state.json` files by this name, and the data folder and the Skill overrides by the plugin's name, so the two must match. `defineMod` throws `defineMod: the mod needs a name, such as the name in .claude-plugin/plugin.json.` for a blank name.
- `state` holds the starting values, grouped by how long they last. [state.md](state.md) explains the groups.
- `api` holds the methods other mods call. [dependencies.md](dependencies.md) explains it.
- `setup` runs once when the mod starts. It adds hooks, panes, slot renders, and jobs. It may be `async`.

```tsx
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'

export const greeter = defineMod({
  name: 'greeter',
  state: { session: { isGreeted: false } },

  setup(mod) {
    mod.on('UserPromptSubmit', () => {
      if (mod.state.session.isGreeted) return
      mod.state.session.isGreeted = true
      mod.ui.toast(`Hello from ${mod.name}`)
    })
  },
})
```

## When setup runs

Claude Code loads the mod at the start of each session. CMod then checks that the mod is set up. A mod with an install step that has not run waits for the person's consent and the install first ([install-steps.md](install-steps.md)). Then CMod loads the saved state, runs `setup`, and marks as open each of the mod's panes that Claude Code already shows.

The first time a version starts, CMod shows the toast `<name> is ready` and logs `<name> added <what setup added>`, such as `the my-mod pane, a render of AbovePrompt and a hook on UserPromptSubmit`.

When a step fails, the mod does not start. Its progress line above the prompt names the failure and the fix:

- `<mod>: state.<group> is not a lifetime. …` or `<mod>: state.<group> is not an object of values. …` when the declared state is not valid ([state.md](state.md)).
- `its state did not load: <error>` when reading the saved values or a `state.json` fails.
- `its setup function threw: <error>` when `setup` throws or rejects.
- `its open panes did not load: <error>` when Claude Code cannot list the open panes.

Each of these says `Fix it, then run /reload-plugins.`

## Connect the mod to Claude Code

`hooks/hooks.json` names `hooks/register.ts` as the plugin's hooks module. `register.ts` calls `connect` and does nothing else:

```ts
import type { On } from 'claude-code'
import { connect } from '../node_modules/@cmodjs/core/connect.js'
import { greeter } from '../src/mod.js'

export function register(on: On): void {
  connect(on, greeter)
}
```

```ts
connect<State>(on: On, definition: ModDefinition<State>): void
```

`connect` registers one handler per Claude Code event the mod can use, and routes each event to the mod. Keep `register.ts` this small. Claude Code checks a hooks module before it loads it, and refuses some shapes, such as a `$` passed to a function in another module. Declare `register` as a function, as here: `cmod publish` bundles the hooks module into one file, and Claude Code refuses a bundled `register` that is not one.

## What `mod` can call

`setup` gets `mod`, of type `Mod<State>`. Every hook, render, and job gets the same `mod`.

```ts
type Mod<State> = {
  readonly name: string
  readonly state: Readonly<State>
  readonly dataFolder: string
  readonly projectRoot: string
  readonly cwd: string
  on(event, hook): void
  use(job): Handle
  readonly ui: { pane, render, toast, progress, ask }
  readonly process: { run, spawn }
  readonly fs: { read, write, list }
  readonly http: { fetch }
  readonly settings: { read }
  readonly dependencies: CmodDependencies
}
```

| Member | What it is | Docs |
| --- | --- | --- |
| `name` | The mod's name from `defineMod`. | |
| `state` | The mod's values. Assign to a key to change it. | [state.md](state.md) |
| `dataFolder` | The mod's own folder in the CMod store: `$XDG_DATA_HOME/cmod/data/<plugin name>`, or `~/.local/share/cmod/data/<plugin name>` when `XDG_DATA_HOME` is not set. The install step gets the same folder as `CMOD_DATA`. CMod deletes it when the mod is removed. | [install-steps.md](install-steps.md) |
| `projectRoot` | The project the session works in. It follows `/cd`. | |
| `cwd` | The session's working folder. It follows a `cd` in a Bash or PowerShell call, and `/cd`. | |
| `on` | Adds a hook on a Claude Code event. | [hooks.md](hooks.md) |
| `use` | Adds a job, such as a slash command or a tool, and returns its handle. | [jobs.md](jobs.md) |
| `ui` | Panes, slot renders, toasts, progress lines, and questions. | [ui.md](ui.md) |
| `process` | Runs a program. | below |
| `fs` | Reads and writes files. | below |
| `http` | Fetches a URL. | below |
| `settings` | Reads Claude Code's settings. | below |
| `dependencies` | Calls the methods of other mods. | [dependencies.md](dependencies.md) |

### mod.process

```ts
mod.process.run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult>
mod.process.spawn(argv: readonly string[], init?: { cwd?, env?, input? }): HookStream<ProcessSpawnChunk, ProcessSpawnResult>
```

Both run a program without a shell. `argv[0]` is the program and the rest are its arguments.

- `init.cwd` is the program's folder, absolute or relative to the session's working folder. Without it the program runs in the session's working folder.
- `init.env` sets variables over Claude Code's own environment.
- `run` takes `stdin`, and `spawn` takes `input`: text written to standard input, which then closes.
- `run` takes `timeoutMs`: Claude Code kills the program after it, 30 seconds by default and 10 minutes at most. `longestMs`, exported from `mod.js`, is those 10 minutes in milliseconds, `600000`.
- `run` resolves `{ exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated }` once the program exits, whatever its exit code. It keeps the first 4 MiB of each stream. A program ended by a signal has `exitCode` 1.
- `run` rejects when the program cannot start, and when it is still running at `timeoutMs`. It reads the whole output, so a background process the program leaves writing holds the call until the timeout.
- `spawn` streams `{ stream: 'stdout' | 'stderr', text }` pieces as the program writes them. Its `result` resolves `{ code, signal }` once the stream is read to its end. Its first pull rejects when the program cannot start.
- The `for await` loop over a `spawn` is the program's life. Leaving the loop, or calling `return()` on the stream, kills the program, and so does unloading the mod. Returning from the hook does not.

Inside a job, CMod adds the job's deadline to each call ([jobs.md](jobs.md)).

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'

export const branchNote = defineMod({
  name: 'branch-note',
  setup(mod) {
    mod.on('SessionStart', async () => {
      const { exitCode, stdout } = await mod.process.run(['git', 'branch', '--show-current'], { cwd: mod.projectRoot })
      if (exitCode !== 0) return
      return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `The git branch is ${stdout.trim()}.` } }
    })
  },
})
```

### mod.fs

```ts
mod.fs.read(path: string): Promise<string>
mod.fs.write(path: string, text: string): Promise<void>
mod.fs.list(path?: string): Promise<FsEntry[]>
```

- A relative path is under the session's working folder. An absolute path is used as given. Text is UTF-8.
- `read` rejects a missing file and a file over 4 MiB.
- `write` writes the whole file and creates its folders.
- `list` lists a folder, the working folder without a path. Each entry is `{ name, kind, size, mtimeMs, isLink }`, and `kind` is `'file'`, `'dir'`, or `'other'`. A symbolic link is `'other'` with `isLink` true.

A file the mod ships is under the plugin's folder. `mod` has no member that names that folder, so a job of your own reads it from `claude.plugin.root` ([jobs.md](jobs.md#the-claude-members)). A file the mod keeps for itself belongs in `mod.dataFolder`.

### mod.http

```ts
mod.http.fetch(url: string, init?: HttpInit): Promise<HttpResponse>
```

- `init` takes `method` (`GET` by default), `headers`, `body` as text, and `socketPath`, the absolute path of a Unix socket the request goes over.
- The response is `{ status, ok, headers, text }`. `ok` is true for a 2xx status. Header names are lower case.

### mod.settings

```ts
mod.settings.read(args?: { source?: 'user' | 'project' | 'local' | 'flag' | 'policy' }): Promise<Settings>
```

Without a `source` it answers the settings Claude Code runs under, every source merged. With a `source` it answers that one source: `user` is `~/.claude/settings.json`, `project` is `.claude/settings.json`, and `local` is `.claude/settings.local.json`. The answer is keyed as a `settings.json` is, such as `permissions`, `env`, and `enabledPlugins`.

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'

export const pluginCount = defineMod({
  name: 'plugin-count',
  setup(mod) {
    mod.on('SessionStart', async () => {
      const enabled = (await mod.settings.read({ source: 'user' }))['enabledPlugins'] as Record<string, unknown> | undefined
      mod.ui.toast(`${Object.keys(enabled ?? {}).length} plugins are enabled`)
    })
  },
})
```

## messageOf

```ts
messageOf(error: unknown): string
```

Returns an `Error`'s `message`, or the value as text. Use it in a `catch`, where the error is `unknown`.

```ts
import { defineMod, messageOf } from '../node_modules/@cmodjs/core/mod.js'

export const notes = defineMod({
  name: 'notes',
  setup(mod) {
    mod.on('Stop', async () => {
      await mod.fs.write(`${mod.dataFolder}/last-stop.txt`, new Date().toISOString()).catch((error: unknown) => {
        mod.ui.toast(`notes could not save: ${messageOf(error)}`)
      })
    })
  },
})
```
