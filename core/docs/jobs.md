# Jobs

A job is a ready-made part of a mod: a slash command, a tool, permission rules, a check, a prompt, a status line, or a background program. Add each in `setup` with `mod.use`.

```ts
mod.use<Handle>(part: Part<Handle, State>): Handle

type Part<Handle, State> = (context: PartContext<State>) => Handle
```

Each job function, such as `slashCommand(options)`, returns a `Part`. `mod.use` runs the part and returns its handle. A job that has nothing to hand back returns `void`.

A job's bad options throw at one of two times. `check`, `permissions`, and `prompt` check their options when the job function is called. `slashCommand`, `tool`, `statusLine`, and `program` check theirs inside the part, at `mod.use`, so the error surfaces as `its setup function threw: …`.

| Job | Import | Adds |
| --- | --- | --- |
| `slashCommand` | `jobs/slash-command.js` | A slash command the person types |
| `tool` | `jobs/tool.js` | A tool Claude calls |
| `permissions` | `jobs/permissions.js` | Rules that deny a call, or ask the person first |
| `check` | `jobs/check.js` | A command that runs after matching calls, and reports a failure to Claude |
| `prompt` | `jobs/prompt.js` | Text Claude reads: once, before matching prompts, or after matching calls |
| `statusLine` | `jobs/status-line.js` | A status line |
| `program` | `jobs/program.js` | A background program the mod talks to over HTTP |

Each job announces itself. The first time a version starts, Claude Mod Manager (CMod) logs what the mod added, such as `tasks added /tasks, the open_ticket tool and 2 permission rules.`

## Deadlines

Inside a job, the `mod` a function receives fails each call that runs past the job's deadline, with `<call> passed the <n> s deadline of <job>`, such as `mod.fs.read passed the 30 s deadline of tool`.

| Job and function | Deadline of each `mod.fs`, `mod.http`, `mod.dependencies`, and `mod.process.spawn` call | `mod.process.run` |
| --- | --- | --- |
| `slashCommand`'s `reply` | 30 s | 30 s, or `timeoutMs` up to 10 minutes |
| `tool`'s `execute` | 30 s | 30 s, or `timeoutMs` up to 10 minutes |
| `prompt`'s `prompt` | 5 s | 5 s, or `timeoutMs` up to 10 minutes |
| `statusLine`'s `text` | 2 s | 2 s at most |
| `permissions`' `when` | 2 s | 2 s at most |
| `check`'s `run` | none: `run` is the check's only call | `timeoutMs`, 60 s by default, 10 minutes at most |

Outside a job, in a hook or a render, a `mod.dependencies` call fails after 30 s, and the other calls have only Claude Code's own limits ([mod.md](mod.md)).

## slashCommand

```ts
slashCommand<State>(options: {
  readonly name: string
  readonly description: string
  readonly argumentHint?: string
  readonly immediate?: true
  readonly reply: (input: { args: string; positionals: string[] }, mod: Mod<State>) => Reply | void | Promise<Reply | void>
}): Part<void, State>

type Reply = string | { text?: string; context?: string } | undefined
```

- `name` is the command without the slash: 1 to 64 letters, digits, `_`, or `-`. The person types `/<name>`. Another name throws `<mod>: "<name>" is not a slash command name.`
- `description` is the line the typeahead and `/help` show.
- `argumentHint` is drawn dim after the name, such as `[path]`.
- `immediate: true` runs the command at once while Claude is still working. Without it, the command waits for the turn to end.
- `reply` gets `args` and `positionals`. `args` is everything after the name as Claude Code passes it, and `''` for a bare `/<name>`. CMod hands it on unchanged. `positionals` is that text split into words the way a shell splits them, so extra spaces never reach it. `tested.type('/todo  milk')` drops the spaces after the name.
- A `string` reply, or `text`, shows as the command's output. `context` is text Claude reads after the output, and the person never sees. `undefined` shows nothing.
- A `reply` that throws shows `/<name> failed: <error>`.
- Two commands with one name in a mod throw `<mod>: the slash command /<name> is already added. Give each slashCommand its own name.`
- When Claude Code refuses to add the command, CMod logs `<mod>: /<name> is not added: <error>`.

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'

export const todo = defineMod({
  name: 'todo',
  state: { project: { items: [] as readonly string[] } },
  setup(mod) {
    mod.use(
      slashCommand({
        name: 'todo',
        description: 'Add an item to the project to-do list',
        argumentHint: '<item>',
        reply: ({ args }, mod) => {
          mod.state.project.items = [...mod.state.project.items, args]
          return { text: `Added: ${args}`, context: `The to-do list is now: ${mod.state.project.items.join(', ')}` }
        },
      }),
    )
  },
})
```

## tool

```ts
tool<Schema, State>(options: {
  readonly name: string
  readonly description: string
  readonly inputSchema?: Schema
  readonly execute: (input: FromSchema<Schema>, mod: Mod<State>) => unknown
}): Part<{ readonly name: string }, State>
```

- `name` is 1 to 64 letters, digits, `_`, or `-`. Claude sees the tool as `mcp__<plugin name>__<name>`, and the handle's `name` is that full name.
- `description` tells Claude what the tool does.
- `inputSchema` is a JSON Schema with `type: 'object'`. It types `execute`'s `input`, so write it inline. CMod checks each call's input against it, draft 2020-12, and denies an input that does not fit with the list of its errors. Its properties cannot be named `tool`, `tool_use_id`, `consent`, or `agentId`, which Claude Code keeps for itself.
- `execute` returns the result Claude reads. A `string` and an array of content blocks go to Claude as they are. Any other value goes as JSON. `undefined` returns nothing.
- An input that does not fit the schema is denied with one line per error under a heading, such as `The open_ticket tool input is not valid:` followed by `- #: Instance does not have required property "title".` The text after `- ` is the location in the input, `#` for its root, and the validator's message.
- An `execute` that throws denies the call with `The <name> tool failed: <error>`.
- Two tools with one name in a mod throw.

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { tool } from '../node_modules/@cmodjs/core/jobs/tool.js'

export const tickets = defineMod({
  name: 'tickets',
  state: { project: { opened: [] as readonly string[] } },
  setup(mod) {
    mod.use(
      tool({
        name: 'open_ticket',
        description: 'Open a ticket with a title',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        execute: (input, mod) => {
          mod.state.project.opened = [...mod.state.project.opened, input.title]
          return `Opened "${input.title}"`
        },
      }),
    )
  },
})
```

## Targets: which calls a rule, check, or prompt matches

`permissions`, `check`, and `prompt` name the calls they act on with targets. A target names exactly one key, with a pattern or a list of patterns. A target that names none or two throws an error that starts `A rule names exactly one of command, read, write, fetch, subagent, tool`.

| Target | Matches |
| --- | --- |
| `{ command: 'git push --force' }` | A Bash command. [Command patterns](#command-patterns) explains how it matches. |
| `{ read: 'src/**/*.ts' }` | A `Read` of a matching file, a `Grep` whose `path` matches (the working folder when it names none), a `Glob` whose `pattern`, joined to its `path`, matches, and a Bash command that reads a matching file |
| `{ write: '.env*' }` | A call that changes a matching file: `Edit`, `Write`, `NotebookEdit`, and a Bash command that writes the file |
| `{ fetch: 'https://api.example.com/**' }` | A `WebFetch` of a matching URL, and a Bash command that fetches it. The glob runs over the whole URL, so `**` crosses `/` and `*` stops at it: `https://example.com/**` matches every page of that host, `https://*.example.com/**` every page of its subdomains, and `https://example.com/*` only the pages one level down. A bare host, such as `example.com`, matches nothing. |
| `{ subagent: 'explorer' }` | An `Agent` call that starts a matching subagent type. A call that names none starts `general-purpose`. |
| `{ tool: 'mcp__tickets__*' }` | A call of a matching tool name |

- A `read`, `write`, `fetch`, `subagent`, or `tool` pattern is a glob, matched without regard to case.
- A `read` or `write` pattern is relative to the project root. A pattern that starts with `~/` is relative to the home folder, and one that starts with `/` is absolute. A pattern that starts with `**` matches an absolute path too. A path that leads through a symbolic link also matches by where it lands.
- A mod installed for the person matches calls in every folder. A project plugin, made with `cmod new --project`, matches only calls inside its own repository's work trees, linked worktrees included, and its relative patterns start at the root of the work tree the call is in.

### Command patterns

A `command` pattern is not a glob. CMod splits it into words the way it splits a Bash command, and matches each command of the call:

- `'*'` alone matches every shell command. A `*` inside a pattern is a plain character.
- The first word is the program, matched by its name, so `/bin/rm` counts as `rm`.
- Every other word that does not start with `-` must appear in the command in the pattern's order, and other words may sit between them: `git push` matches `git push origin main`.
- Every flag, a word that starts with `-`, must appear somewhere in the command, in any order. `--force` also matches `--force=yes`.
- CMod splits a cluster of short flags into single flags, in the pattern and in the command alike, so `rm -rf` matches `rm -rf`, `rm -fr`, and `rm -r -f`. A letter that takes a value keeps the rest of the cluster as its value. These programs keep their flags as written: `find`, `java`, `javac`, `go`, `gcc`, `g++`, `clang`, `clang++`, `swift`, `swiftc`, `xcodebuild`, `xcrun`, `ffmpeg`, `ffprobe`, `openssl`, `plutil`, `defaults`, `security`, and `codesign`.
- Words and flags match exactly, letter case included.
- Each command of a pipeline or a `&&` chain counts, and so does the command a wrapper runs: `sudo rm -rf /` holds the commands `sudo` and `rm -rf /`. The wrappers are `sudo`, `env`, `doas`, `timeout`, `flock`, `stdbuf`, `watch`, `nohup`, `nice`, `time`, `exec`, `command`, and `xargs`.

## permissions

```ts
permissions<State>(rules: { deny?: Rule<State>[]; ask?: Rule<State>[] }): Part<void, State>

type Rule<State> = Target & {
  when?: (call: <the call of the target's key>, mod: Mod<State>) => boolean | Promise<boolean>
  reason?: string
}
```

- Before each call, CMod tries every `deny` rule, then every `ask` rule. The first rule that matches decides, and its `reason` goes with the decision. No match leaves the call to Claude Code.
- The strictest answer wins: a mod's `ask` or `deny` beats Claude Code's `allow`, and Claude Code's `deny` beats a mod's `ask`.
- `when` narrows a rule. The rule matches only when `when` resolves true. A `when` that throws makes the rule match, and the reason adds `Its when check failed: <error>`.
- When CMod cannot read the call or the session, it denies the call with the reason.
- For a PowerShell command, or a Bash command CMod cannot fully parse, a `command` rule matches when every word of its pattern appears in the command line. A `read` or `write` rule matches when the command line holds the last segment of its pattern, after the last `/`, and only when that segment holds none of `*?[]{}`. So `{ write: 'Domain.md' }` matches such a command that names `Domain.md`, and `{ write: '**/.env*' }` never matches one.
- `permissions({})` throws `permissions: give it a deny or an ask rule, or remove it from setup.`

`when` gets the call, typed by the target's key. `jobs/permissions.js` exports each type:

| Key | Call type | Fields beyond `tool`, `agentId`, and `agentType` |
| --- | --- | --- |
| `command` | `CommandCall` | `commands`, each `[program, ...arguments]`, and `isFullyParsed` |
| `read`, `write` | `FileCall` | `path`, and for an `Edit` or a `Write`, `content`, the new text, and `previousContent`, the text before |
| `fetch` | `FetchCall` | `url` |
| `subagent`, `tool` | `ToolCall` | none |

`agentId` and `agentType` name the subagent that makes the call. In the main conversation `agentId` is absent, and `agentType` is the agent the session started as, when it started as one. `jobs/permissions.js` also exports `Target`, `Rule`, and `PermissionRules`.

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { permissions } from '../node_modules/@cmodjs/core/jobs/permissions.js'

export const guard = defineMod({
  name: 'guard',
  state: { project: { isFrozen: false } },
  setup(mod) {
    mod.use(
      permissions({
        deny: [
          { command: 'git push --force', reason: 'Force pushes rewrite shared history.' },
          { command: 'git push', when: (_call, mod) => mod.state.project.isFrozen, reason: 'The branch is frozen.' },
          { write: '**/.env*', reason: 'Edit .env files by hand.' },
        ],
        ask: [{ write: 'Domain.md', when: (call) => call.content?.includes('Avoid') === true, reason: 'Domain.md changes need a review.' }],
      }),
    )
  },
})
```

## check

```ts
check<State>(options: { readonly after: Target | Target[]; readonly run: readonly string[]; readonly timeoutMs?: number }): Part<void, State>
```

- After each call that matches `after` and succeeds, CMod runs `run`. A call that was denied or failed runs nothing.
- For a `read` or `write` target, CMod adds the matched files that still exist to the end of `run`, as absolute paths. For any other target it runs `run` as it is.
- A mod installed for the person passes no folder, so Claude Code runs the command in the session's working folder. A project plugin runs it at the root of the work tree that holds the last matched file, or the matched command's folder.
- A command that exits with another code than 0 adds `<command> exited with <code>:` and its output to the call's result, so Claude reads the failure right after its own call.
- `timeoutMs` is 60 seconds by default and 10 minutes at most.
- An empty `after`, an empty `run`, or a `timeoutMs` out of range throws, naming the check and the fix.

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { check } from '../node_modules/@cmodjs/core/jobs/check.js'

export const lint = defineMod({
  name: 'lint',
  setup(mod) {
    mod.use(check({ after: { write: '**/*.ts' }, run: ['bun', 'x', 'oxlint'] }))
  },
})
```

## prompt

```ts
prompt<State>(options: {
  name: string
  prompt: string | ((input: { userPrompt?: string; call?: ToolCall }, mod: Mod<State>) => string | undefined | Promise<string | undefined>)
  when?: RegExp | ((userPrompt: string) => boolean)
  after?: Target | Target[]
}): Part<void, State>
```

`prompt` adds text that Claude reads. `when` and `after` pick when:

| Options | When Claude reads the text |
| --- | --- |
| neither | Once per conversation, as a block of context named `name`. A block of that name already in the context wins. |
| `when` | With each prompt the person sends whose text matches the `RegExp`, or for which the function returns true. `input.userPrompt` is the prompt. |
| `after` | After each call that matches a target and succeeds, with the call's result. `input.call` is the matched call. |

- With `when` or `after`, the text goes to Claude under the heading `# <name>`.
- A `prompt` function that returns `undefined` or `''` adds nothing. One that throws adds nothing, and the error goes to Claude Code's debug log.
- `name` cannot be blank. `when` and `after` together throw: add a second `prompt` for the other trigger. Two prompts with one name in a mod throw.
- A `when` prompt runs on `prompt.submit` and adds its text to the event it passes down. In a test, `fire('prompt.submit', …)` returns that text in the answer's `context`. [testing.md](testing.md#test-a-prompt-with-when) shows how.

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { prompt } from '../node_modules/@cmodjs/core/jobs/prompt.js'

export const conventions = defineMod({
  name: 'conventions',
  setup(mod) {
    mod.use(prompt({ name: 'Commit messages', prompt: 'Write commit messages in the imperative mood.' }))
    mod.use(prompt({ name: 'Migrations', when: /\bmigrat/i, prompt: 'Every migration has a down step.' }))
    mod.use(prompt({ name: 'Schema', after: { write: 'db/schema.sql' }, prompt: async (_input, mod) => `The schema is now:\n${await mod.fs.read(`${mod.projectRoot}/db/schema.sql`)}` }))
  },
})
```

## statusLine

```ts
statusLine<State>(options: {
  readonly text: (usage: Usage, mod: Mod<State>) => string | undefined | Promise<string | undefined>
  readonly interval?: number
}): Part<void, State>

type Usage = { model: string; context: { tokens?: number; window: number; percent?: number }; cost?: { usd: number } }
```

- `text` returns the status line's text, or `undefined` to clear it.
- CMod calls `text` when the mod starts, every `interval` milliseconds (10000 by default), and whenever Claude Code measures the session. It sends the text only when it changed.
- A `text` that throws keeps the last text, and the error goes to Claude Code's debug log.
- A mod has one status line. A second `statusLine` throws: join the texts in one.
- An `interval` below 1 throws.

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { statusLine } from '../node_modules/@cmodjs/core/jobs/status-line.js'

export const usage = defineMod({
  name: 'usage',
  setup(mod) {
    mod.use(statusLine({ text: ({ model, context }) => `${model} ${context.percent ?? 0}%` }))
  },
})
```

## program

```ts
program(options: { readonly command: readonly string[]; readonly environment?: Record<string, string> }): Part<Program>

type Program = {
  readonly state: 'stopped' | 'starting' | 'running' | 'backoff' | 'fatal'
  ready(): Promise<{ url: string; socketPath?: string }>
}
```

`program` runs a background program, such as a preview server, and hands the mod its address.

- `command` is the program on `PATH` and its arguments. `environment` sets variables for it. An empty `command` throws.
- The program's first line on standard output must be its address: `127.0.0.1:<port>`, or `unix:<absolute socket path>`. `ready()` then resolves `{ url: 'http://127.0.0.1:<port>' }`, or `{ url: 'http://localhost', socketPath }`. Pass both to `mod.http.fetch`.
- In an interactive session the program starts with the mod. Otherwise it starts at the first `ready()`.
- When the program exits, CMod starts it again after 1, 2, 4, 8, and 16 seconds. After 5 failed tries, or a first line that is not an address, the state is `fatal`, `ready()` rejects, and CMod logs `<mod>: the <program> program stopped: <reason>`.
- A program that ships with the mod gets onto `PATH` through the `program` key of the mod's `package.json` ([install-steps.md](install-steps.md)). A program an install step fetched with `cmod download` is not on `PATH`, so `command` names it by its full path, `${mod.dataFolder}/bin/<program>`.

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { program } from '../node_modules/@cmodjs/core/jobs/program.js'
import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'

export const preview = defineMod({
  name: 'preview',
  setup(mod) {
    const server = mod.use(program({ command: ['preview-server', '--port', '0'] }))
    mod.use(
      slashCommand({
        name: 'preview-status',
        description: 'Ask the preview server for its status',
        reply: async (_input, mod) => {
          const { url, socketPath } = await server.ready()
          const response = await mod.http.fetch(`${url}/status`, socketPath === undefined ? {} : { socketPath })
          return response.text
        },
      }),
    )
  },
})
```

## Write a job of your own

A `Part` is a function. `mod.use` calls it with a `PartContext` and returns what it returns:

```ts
type PartContext<State> = {
  readonly mod: Mod<State>
  readonly claude: Claude
  on<N extends RoutedEvent>(event: N, hook: RoutedHook<N>): void
  announce(feature: string): void
  reserveName(kind: string, name: string, taken: string): void
  readonly toolCalls: ToolCalls
}
```

- `claude` reaches Claude Code itself. [The claude members](#the-claude-members) lists each one.
- `claude.store` is where CMod saves `mod.state`, under keys that start with `<mod>.`, such as `<mod>.<key>`. A job of your own never writes those keys, or it changes the mod's state behind CMod's back.
- `on` adds a Claude Code hook-module handler, `(e, next) => …`, on a `classic.<ModEvent>` event or on `tool.check`, `tool.call`, `prompt.submit`, `prompt.context`, `command.run`, `session.measure`, `skill.prompt`, `ui.render`, `ui.press`, `ui.close`, or `cmod.call`. The handler calls `next(e)` to pass the event on.
- `announce` adds a phrase to the list CMod logs when the mod first starts.
- `reserveName` throws `taken` when the mod already reserved that `kind` and `name`. A job calls it to refuse a duplicate.
- `toolCalls.agentOf(toolUseId)` resolves `{ agentId?, agentType? }`, the subagent behind a call.
- `toolCalls.cwdOf(toolUseId)` returns the working folder at the call's `PreToolUse`, or `undefined` once its `PostToolUse` or `PostToolUseFailure` has run. CMod keeps the folders of the last 100 calls.

```ts
import { defineMod, type Part } from '../node_modules/@cmodjs/core/mod.js'

const clock: Part<{ now(): Promise<number> }> = ({ claude, announce }) => {
  announce('a clock')
  return { now: () => claude.clock.now() }
}

export const timer = defineMod({
  name: 'timer',
  setup(mod) {
    const started = mod.use(clock)
    mod.on('Stop', async () => {
      mod.ui.toast(`Turn ended at ${new Date(await started.now()).toISOString()}`)
    })
  },
})
```

### The claude members

`mod.js` exports the types `Claude`, `RoutedEvent`, `RoutedHook`, and `ToolCalls`, so a job of your own names them in its own helpers, such as `(claude: Claude, calls: ToolCalls): RoutedHook<'command.run'> => …`.

Each member calls the member of the same name in Claude Code's hooks API, `$`, with the same arguments. The `env` members read `$.env.get` instead.

| Member | What it does |
| --- | --- |
| `plugin.name` | The plugin's name. |
| `plugin.root` | The plugin's own folder, absolute, where the files the mod ships live. |
| `ui.toast(text, options?)` | Shows `text` for a few seconds, 4000 ms unless `options.timeoutMs` says otherwise. |
| `ui.status(text)` | Pins `text` as the plugin's one status line under the prompt. `undefined` removes it. |
| `ui.log(text, options?)` | Adds a dim line to the transcript that Claude does not read, or with `{ to: 'debug' }` a line to the debug log only. |
| `ui.notice(toolUseId, text)` | Shows `text` as a line under the open permission dialog of that call. `undefined` removes it. |
| `ui.invalidate(event)` | Draws `ui.render` again, or drops the cached answers of `prompt.context` and the other cached events. |
| `ui.ask(question, options?)` | Asks the person in Claude Code's question dialog, and resolves the label they chose. It rejects when they dismiss it, and in a `-p` run. |
| `ui.open(pane)` | Opens a pane, `{ id, title?, focus?, closeOnEscape?, holdToasts?, rows?, columns? }`, and resolves `{ isPlaced }`. |
| `ui.close(pane)` | Closes the open pane with that `{ id }`. |
| `ui.panes()` | The plugin's open panes: each one's id, title, and whether it is shown, holds the keyboard, and is placed. |
| `ui.resolve(e)` | The element table of the surface a `ui.render` event draws on. |
| `process.run(argv, init?)` | Runs a program to its end. `mod.process.run` is built on it. |
| `process.spawn(request)` | Starts a program and streams its output. `mod.process.spawn` is built on it. |
| `fs.read`, `fs.write`, `fs.list` | What `mod.fs` calls. A relative path is under the session's working folder. |
| `fs.exists(path)` | Resolves whether the path exists. |
| `fs.stat(path, options?)` | Resolves `{ kind, size, mtimeMs, isLink }`, and `realPath` with `{ resolve: true }`. It rejects for a missing path. |
| `http.fetch(url, init?)` | What `mod.http.fetch` calls. |
| `settings.read(args?)` | What `mod.settings.read` calls. |
| `store.get`, `store.set`, `store.delete`, `store.keys` | The plugin's key-value store, where CMod also keeps `mod.state`. |
| `clock.now()` | Resolves milliseconds since the epoch. |
| `clock.after(ms, fn)` | Calls `fn` once after `ms` milliseconds, and returns `{ cancel() }`. |
| `clock.every(ms, fn)` | Calls `fn` every `ms` milliseconds, at least 1, and returns `{ cancel() }`. |
| `session.id()` | The session's id, the transcript file's name. |
| `session.root()` | The session's project root. A shell `cd` does not move it. |
| `session.cwd()` | The folder the session runs in. |
| `session.model()` | The main conversation's model, as `/model` shows it. |
| `session.usage()` | When the session began, the context window's fill, the rate-limit windows, and the cost, as the status line has them. |
| `session.surfaces()` | Every surface the session draws on, `terminal` first. Empty in a plain `-p` run. |
| `command.register(spec)` | Adds a slash command. `slashCommand` is built on it. |
| `tool.register(spec)` | Adds a tool. `tool` is built on it. |
| `agent.list()` | The session's subagents and teammates so far. |
| `env.home()` | The `HOME` variable, or `undefined` when it is unset. |
| `env.dataHome()` | The `XDG_DATA_HOME` variable, or `undefined`. |
| `env.configHome()` | The `CLAUDE_CONFIG_DIR` variable, or `undefined`. |
| `cmod.call({ to, method, input })` | Calls `method` of the mod named `to`. `mod.dependencies` is built on it. |

### The building blocks

The built-in jobs are written from these building blocks, which a job of your own may import:

| Import | Export | What it does |
| --- | --- | --- |
| `jobs/part-context.js` | `afterCall(part, contextAfter, failed)` | Runs `contextAfter` after each call that succeeds, and adds the lines it returns to the call's result. |
| `jobs/part-context.js` | `modWithin(part, deadline, workTree?)` | A `mod` whose calls fail at `deadline`, `{ ms, job?, longestMs? }`. |
| `jobs/part-context.js` | `modOf(part, { call?, folder }, workspace, deadline)` | `modWithin`, with `mod.process` calls run in the call's work tree. |
| `jobs/part-context.js` | `workspaceReader(part)` | A function that reads the session's `projectRoot`, `cwd`, `home`, file access, and project scope. |
| `jobs/permissions/decide-permission.js` | `decidePermission`, `stricterVerdict`, and the types `Rule`, `PermissionRules`, `Decision`, `Verdict` | Decides a call against permission rules. |
| `jobs/permissions/find-project-scope.js` | `findProjectScope`, and the types `ProjectScope`, `Workspace` | Finds the repository a project plugin belongs to. |

A job of your own matches calls against targets through the `permissions`, `check`, and `prompt` jobs. A `prompt` with `after` runs any code after a matching call, and may add no text: `prompt({ name: 'commits', after: { command: 'git commit' }, prompt: (_input, mod) => { mod.state.project.commits += 1; return undefined } })`.

## Test a job

`tested.type('/todo milk')` runs a slash command. `tested.callTool('open_ticket', { title: 'Crash' })` runs the permission rules, then the tool. `tested.fire('tool.check', …)` asks the permission rules about any call. `tested.fire('prompt.submit', …)` returns the context a `when` prompt added. [testing.md](testing.md) covers each.
