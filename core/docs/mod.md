# Define a mod

`defineMod` describes a mod: its name, its state, the methods it offers other mods, and the `setup` function that attaches everything to Claude Code. `registerMod` registers the definition with Claude Code.

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

- `name` is the mod's name. Use the `name` in `.claude-plugin/plugin.json`. Claude Mod Manager (cmod) keys the saved state and the `state.json` files by this name, and the data folder and the Skill overrides by the plugin's name, so the two must match. `defineMod` throws `defineMod: the mod needs a name, such as the name in .claude-plugin/plugin.json.` for a blank name.
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

Claude Code loads the mod at the start of each session. cmod then checks that the mod is set up. A mod with an install step that has not run waits for the person's consent and the install first ([install-steps.md](install-steps.md)). Then cmod loads the saved state, runs `setup`, and marks as open each of the mod's panes that Claude Code already shows.

The first time a version starts, cmod shows the toast `<name> is ready` and logs `<name> added <what setup added>`, such as `the my-mod pane, a render of AbovePrompt and a hook on UserPromptSubmit`.

When a step fails, the mod does not start. Its progress line above the prompt names the failure and the fix:

- `<mod>: state.<group> is not a lifetime. …` or `<mod>: state.<group> is not an object of values. …` when the declared state is not valid ([state.md](state.md)).
- `its state did not load: <error>` when reading the saved values or a `state.json` fails.
- `its setup function threw: <error>` when `setup` throws or rejects.
- `its open panes did not load: <error>` when Claude Code cannot list the open panes.
- `it decides permissions on <events>, so hooks/register.ts must call registerPermissionCheck(addHook) after registerMod` when `setup` adds a hook on `PermissionRequest`, or a job that decides permissions, and `register.ts` does not register the permission check.

Each of these says `Fix it, then run /reload-plugins.`

## Register the mod with Claude Code

`hooks/hooks.json` names `hooks/register.ts` as the plugin's hooks module. `register.ts` calls `registerMod` and does nothing else:

```ts
import type { On } from 'claude-code'
import { registerMod } from '../node_modules/@cmodjs/core/register.js'
import { greeter } from '../src/mod.js'

export function register(addHook: On): void {
  registerMod(addHook, greeter)
}
```

```ts
registerMod<State>(addHook: On, definition: ModDefinition<State>): void
registerPermissionCheck(addHook: On): void
```

`registerMod` registers one handler per Claude Code event the mod can use, and routes each event to the mod. A `PreToolUse` hook runs on `tool.call`, which `registerMod` registers ([hooks.md](hooks.md)). It leaves out Claude Code's permission check, the events `tool.check` and `PermissionRequest`.

A mod that decides permissions calls `registerPermissionCheck` after `registerMod`. That covers a `PreToolUse` hook that answers `permissionDecision: 'allow'` or `'ask'`, a hook on `PermissionRequest`, the `permissions` job, and a job of your own on `tool.check`:

```ts
export function register(addHook: On): void {
  registerMod(addHook, guard)
  registerPermissionCheck(addHook)
}
```

A mod without it has no part in Claude Code's permission check, so the plugin directory reads it as one that never answers a permission. A mod that decides permissions without it does not start, and its progress line names the line to add.

Keep `register.ts` this small. Claude Code checks a hooks module before it loads it, and refuses some shapes, such as a `$` passed to a function in another module. The plugin directory reads the bundled module too, and flags it when the name of `register`'s first parameter is declared anywhere else in the bundle. `@cmodjs/core` declares `on` as the method `mod.on`, so name that parameter `addHook`. Declare `register` as a function, as here: `cmod publish` bundles the hooks module into one file, and Claude Code refuses a bundled `register` that is not one.

## What `mod` can call

`setup` gets `mod`, of type `Mod<State>`. Every hook, render, and job gets the same `mod`.

```ts
type Mod<State> = {
  readonly name: string
  readonly state: Readonly<State>
  readonly dataFolder: string
  readonly projectRoot: string
  readonly cwd: string
  on(event, hook, options?): void
  use(job): Handle
  every(ms, hook): Timer
  readonly ui: { pane, render, toast, progress, ask, scroll }
  readonly process: { run, spawn }
  readonly fs: { read, write, list, exists, stat }
  readonly http: { fetch }
  readonly settings: { read }
  readonly session: { messages, append, submit }
  readonly agent: { spawn }
  readonly model: { complete }
  readonly dependencies: CmodDependencies
}
```

| Member | What it is | Docs |
| --- | --- | --- |
| `name` | The mod's name from `defineMod`. | |
| `state` | The mod's values. Assign to a key to change it. | [state.md](state.md) |
| `dataFolder` | The mod's own folder in the cmod store: `$XDG_DATA_HOME/cmod/data/<plugin name>`, or `~/.local/share/cmod/data/<plugin name>` when `XDG_DATA_HOME` is not set. The install step gets the same folder as `CMOD_DATA`. cmod deletes it when the mod is removed. | [install-steps.md](install-steps.md) |
| `projectRoot` | The project the session works in. It follows `/cd`. | |
| `cwd` | The session's working folder. It follows a `cd` in a Bash or PowerShell call, and `/cd`. | |
| `on` | Adds a hook on a Claude Code event. | [hooks.md](hooks.md) |
| `use` | Adds a job, such as a slash command or a tool, and returns its handle. | [jobs.md](jobs.md) |
| `every` | Runs a function every so many milliseconds while the session runs. | below |
| `ui` | Panes, slot renders, toasts, progress lines, questions, and scrolling. | [ui.md](ui.md) |
| `process` | Runs a program. | below |
| `fs` | Reads, writes, and looks up files. | below |
| `http` | Fetches a URL. | below |
| `settings` | Reads Claude Code's settings. | below |
| `session` | Reads the conversation or a subagent's, adds a note Claude reads, and asks Claude for a turn. | below |
| `agent` | Starts a subagent. | below |
| `model` | Asks a model one question, outside the conversation. | below |
| `dependencies` | Calls the methods of other mods. | [dependencies.md](dependencies.md) |

### mod.every

```ts
mod.every(ms: number, hook: () => unknown): Timer
```

`every` runs `hook` every `ms` milliseconds until the session ends or the mod calls `cancel()` on the `Timer` it returns. A tick that comes while the last run is still going is skipped, so a slow run never stacks up. A run that throws logs `<mod>: the every <ms> ms hook failed: <error>`, and the next tick runs again. `ms` is a whole number above 0 and at most `2147483647`, and any other `ms` stops `setup` with the fix.

A watch that reacts on its own is `every` plus `mod.state` plus a `prompt` with no trigger: `every` checks the outside world, writes what it found to `mod.state`, and the panes and the prompt follow the state ([jobs.md](jobs.md#prompt)).

```ts
mod.every(60_000, async () => {
  const { stdout } = await mod.process.run(['gh', 'run', 'list', '--limit', '1', '--json', 'conclusion'])
  mod.state.session.ci = JSON.parse(stdout)[0]?.conclusion ?? 'running'
})
```

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

Inside a job, cmod adds the job's deadline to each call ([jobs.md](jobs.md)).

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
mod.fs.exists(path: string): Promise<boolean>
mod.fs.stat(path: string, options?: { resolve: boolean }): Promise<FsStat>
```

- A relative path is under the session's working folder. An absolute path is used as given. Text is UTF-8.
- `read` rejects a missing file and a file over 4 MiB.
- `write` writes the whole file and creates its folders.
- `list` lists a folder, the working folder without a path. Each entry is `{ name, kind, size, mtimeMs, isLink }`, and `kind` is `'file'`, `'dir'`, or `'other'`. A symbolic link is `'other'` with `isLink` true.
- `exists` answers whether the path leads to a file or a folder.
- `stat` answers `{ kind, size, mtimeMs, isLink }` of what the path leads to, following a symbolic link, and rejects a missing path. With `{ resolve: true }` it also answers `realPath`: the absolute path, every symbolic link followed.

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

### mod.session

```ts
mod.session.messages(): Promise<SessionMessage[]>
mod.session.messages(args: { agentId?: string; as?: 'api' }): Promise<…>
mod.session.append(text: string): Promise<void>
mod.session.submit(text: string): Promise<void>
```

`messages` reads the main conversation, one `{ role, text, toolUses, toolResults }` entry per message. A message has no id of its own, and each tool use carries its `tool_use_id`. `{ agentId }` reads that subagent's conversation instead, the id a `SubagentStart` or `SubagentStop` hook gets as `agent_id`, and answers `{ deny }` when the session cannot read it, so `Array.isArray` tells the two apart. `{ as: 'api' }` reads it in the Messages API form, `{ role, content }` with the content blocks whole.

```ts
mod.on('SubagentStop', async ({ agent_id }) => {
  const read = await mod.session.messages({ agentId: agent_id })
  if (Array.isArray(read)) mod.ui.toast(read.at(-1)?.text ?? '')
})
```

`append` adds `text` to the conversation as a user message the person does not see, so Claude reads it on its next call to the model. It starts no turn. It rejects with `<mod>: Claude Code refused the note: <reason>` when a plugin's `session.append` handler refuses it.

`submit` sends `text` as the person's next prompt, so Claude answers it as a turn of its own. Claude Code holds it until the session is idle, so it never cuts into a turn, and shows it under `The <mod> plugin sent a message:`. It rejects with `<mod>: Claude Code dropped the prompt: <reason>` when a plugin drops it. A prompt that comes on a clock, such as every 10 minutes, belongs in a `schedule` job instead, which Claude Code shows as one `Running scheduled task` row ([jobs.md](jobs.md#schedule)).

```ts
mod.every(60_000, async () => {
  const { stdout } = await mod.process.run(['gh', 'run', 'list', '--limit', '1', '--json', 'conclusion'])
  if (JSON.parse(stdout)[0]?.conclusion !== 'failure') return
  await mod.session.append('CI failed on the last push.')
  await mod.session.submit('Find the cause of the CI failure and fix it.')
})
```

### mod.agent

```ts
mod.agent.spawn(args: { prompt: string; description?; subagentType?; model?; name?; cwd? }): Promise<AgentSpawnResult>
```

`spawn` starts a subagent in the background, the way the Agent tool starts one, and resolves `{ agentId, model }` once it started, or `{ deny }` when a hook refused it. It does not wait for the subagent to finish. `subagentType` names an agent type, such as `explorer`. `mod.session.messages({ agentId })` reads the subagent's conversation so far.

The subagent's answer arrives on the mod's `SubagentStop` hook once it finishes: the input's `agent_id` is the `agentId` that `spawn` resolved, and its `last_assistant_message` is the subagent's final reply. A hook may wait for it, as this one does:

```ts
const answers = new Map<string, (answer: string) => void>()

mod.on('SubagentStop', (input) => {
  answers.get(input.agent_id)?.(input.last_assistant_message ?? '')
})

mod.on('UserPromptSubmit', async (input) => {
  if (!input.prompt.startsWith('/summarize')) return
  const spawned = await mod.agent.spawn({ prompt: 'Summarize README.md in one line.', subagentType: 'Explore' })
  if (spawned.agentId === undefined) return
  const summary = await new Promise<string>((resolve) => answers.set(spawned.agentId as string, resolve))
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: summary } }
})
```

### mod.model

```ts
mod.model.complete(request: ModelCompleteRequest, options?: { signal?: AbortSignal }): Promise<ModelCompleteResult>
```

`complete` asks a model one question through Claude Code's own login, outside the conversation, so the answer costs no context and the person sees no turn. The request names the `model`, such as `'haiku'`, and the `prompt`, and takes `system`, `maxTokens`, `effort`, and `timeoutMs`. `timeoutMs` stops a model that is slow or down, so the hook that waits on it still answers in time. `options.signal` stops the call when its `AbortController` aborts.

The call never rejects for what the model did. The result's `isAnswered` is true with the reply's `text`, or false with a `reason`, such as `'api-error'` or `'aborted'`.

Put a limit on the hook too, with `mod.on`'s `timeoutMs` ([hooks.md](hooks.md#mod-on)), which also covers the work around the call:

```ts
mod.on('Stop', async ({ last_assistant_message }) => {
  const verdict = await mod.model.complete({ model: 'haiku', prompt: `Does this reply ask the person to do work Claude could do itself? Answer yes or no.\n\n${last_assistant_message}`, timeoutMs: 8000 })
  if (verdict.isAnswered && verdict.text.trim().toLowerCase().startsWith('yes')) return { decision: 'block', reason: 'Do that work yourself, then reply.' }
}, { timeoutMs: 9000 })
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
