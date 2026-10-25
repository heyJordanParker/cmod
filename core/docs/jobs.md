# Jobs

A job is a ready-made feature of a mod: a slash command, a tool, permission rules, a check, a prompt, a schedule, or a background program. Add each in `setup` with `mod.use`.

```ts
mod.use<Handle>(job: Job<Handle, State>): Handle

type Job<Handle, State> = (context: JobContext<State>) => Handle
```

Each job function, such as `slashCommand(options)`, returns a `Job`. `mod.use` runs the job and returns its handle. A job that has nothing to hand back returns `void`.

A job's bad options throw at one of two times. `check`, `permissions`, `prompt`, and `schedule` check their options when the job function is called. `slashCommand`, `tool`, and `program` check theirs when the job runs, at `mod.use`, so the error surfaces as `its setup function threw: …`.

| Job | Import | Adds |
| --- | --- | --- |
| `slashCommand` | `jobs/slash-command.js` | A slash command the person types |
| `tool` | `jobs/tool.js` | A tool Claude calls |
| `permissions` | `jobs/permissions.js` | Rules that deny a call, or ask the person first |
| `check` | `jobs/check.js` | A command that runs after matching calls, and reports a failure to Claude |
| `prompt` | `jobs/prompt.js` | Text Claude reads: kept current with the mod's state, before matching prompts, or after matching calls |
| `schedule` | `jobs/schedule.js` | A prompt Claude Code sends Claude on a cron schedule, kept current with the mod's state |
| `program` | `jobs/program.js` | A background program the mod talks to over HTTP |

Each job announces itself. The first time a version starts, Claude Mod Manager (cmod) logs what the mod added, such as `tasks added /tasks, the open_ticket tool and 2 permission rules.`

## Deadlines

A job gives each function it calls a deadline. The whole function must answer within it, every call it makes included, or the job goes on without its answer and names what passed the deadline, as in `the open_ticket tool passed the 30 s deadline of tool`.

| Job and function | Deadline | Past the deadline |
| --- | --- | --- |
| `slashCommand`'s `reply` | 30 s | The command shows `/<name> failed: /<name> passed the 30 s deadline of slashCommand`. |
| `tool`'s `execute` | 30 s | The call is denied with `The <name> tool failed: the <name> tool passed the 30 s deadline of tool`. |
| `prompt`'s `prompt` | 5 s | The prompt adds nothing, and the reason goes to Claude Code's debug log. |
| `permissions`' `when` | 2 s | The rule matches, and its reason adds `Its when check failed: it passed the 2 s deadline of permissions`. |
| `check`'s `run` | `timeoutMs`, 60 s by default, 10 minutes at most | The call's result says the command passed the deadline. |

A deadline stops waiting for the function, not the work it started: a program the function spawned runs on until it exits or the mod stops. A function that waits on something slow keeps it short, such as a `process.run` with its own `timeoutMs`.

Outside a job, in a listener or a render, a `mod.dependencies` call fails after 30 s, and the other calls have only Claude Code's own limits ([mod.md](mod.md)).

## slashCommand

```ts
slashCommand<State>(options: {
  readonly name: string
  readonly description: string
  readonly argumentHint?: string
  readonly immediate?: true
  readonly reply: (input: { args: string; positionals: string[] }, mod: Mod<State>) => CommandReply | void | Promise<CommandReply | void>
}): Job<SlashCommand, State>

type CommandReply = string | { text?: string; context?: string } | undefined
type SlashCommand = { readonly name: string; remove(): void }
```

- `name` is the command without the slash: 1 to 64 letters, digits, `_`, or `-`. The person types `/<name>`. Another name throws `<mod>: "<name>" is not a slash command name.`
- `description` is the line the typeahead and `/help` show.
- `argumentHint` is drawn dim after the name, such as `[path]`.
- `immediate: true` runs the command at once while Claude is still working. Without it, the command waits for the turn to end.
- A command lasts for the session. Adding a command with a name the session already has replaces it, and Claude Code has no call that removes one, so a command whose source is gone answers that it no longer applies. `remove()` on the handle stops the mod answering the command.
- A command's `reply` runs inside the person's own input, so a page or pane it opens shows at any width ([ui.md](ui.md#the-sidebar-and-its-pages)).
- A key combo is a hotkey, not a command ([mod.md](mod.md#hotkeys)).
- `reply` gets `args` and `positionals`. `args` is everything after the name as Claude Code passes it, and `''` for a bare `/<name>`. cmod hands it on unchanged. `positionals` is that text split into words the way a shell splits them, so extra spaces never reach it. `tested.type('/todo  milk')` drops the spaces after the name.
- A `string` reply, or `text`, shows as the command's output. `context` is text Claude reads after the output, and the person never sees. `undefined` shows nothing.
- A `reply` that throws shows `/<name> failed: <error>`.
- Two commands with one name in a mod throw `<mod>: the slash command /<name> is already added. Give each slashCommand its own name.`
- When Claude Code refuses to add the command, cmod logs `<mod>: /<name> is not added: <error>`.

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
  readonly isDeferred?: boolean
  readonly execute: (input: FromSchema<Schema>, mod: Mod<State>) => unknown
}): Job<Tool, State>

type Tool = { readonly name: string; remove(): void }
```

- `name` is 1 to 64 letters, digits, `_`, or `-`. Claude sees the tool as `mcp__<plugin name>__<name>`, and the handle's `name` is that full name. `remove()` on the handle stops the mod answering the tool.
- `description` tells Claude what the tool does.
- `inputSchema` is a JSON Schema with `type: 'object'`. It types `execute`'s `input`, so write it inline. cmod checks each call's input against it, draft 2020-12, and denies an input that does not fit with the list of its errors. Its properties cannot be named `tool`, `tool_use_id`, `consent`, or `agentId`, which Claude Code keeps for itself.
- `isDeferred: false` puts the tool's schema in Claude's tool list from the first turn, for a tool Claude calls in most turns. `true`, or leaving it out, keeps the tool behind Claude Code's ToolSearch, so Claude searches for it before its first call. Each tool kept in the list adds its schema to every turn's context.
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
- A pattern that starts with `!` leaves out the calls it matches. A call matches the target when it matches a pattern without `!` and no pattern with one: `{ write: ['**', '!docs/plans/**'] }` matches every write except those under `docs/plans/`, and `{ command: ['git', '!git status', '!git log'] }` matches every git command except those two. A line of several commands matches when one of its commands does, so `git status && git push` matches that rule. A target needs a pattern without `!`, or it throws `A <key> target needs a pattern without "!" for its "!" patterns to leave calls out of, such as ['**', ...]`.
- A `read` or `write` pattern is relative to the project root. A pattern that starts with `~/` is relative to the home folder, and one that starts with `/` is absolute. A pattern that starts with `**` matches an absolute path too. A path that leads through a symbolic link also matches by where it lands.
- A mod installed for the person matches calls in every folder. A project plugin, made with `cmod new --project`, matches only calls inside its own repository's work trees, linked worktrees included, and its relative patterns start at the root of the work tree the call is in.

### Command patterns

A `command` pattern is not a glob. cmod splits it into words the way it splits a Bash command, and matches each command of the call:

- `'*'` alone matches every shell command. A `*` inside a pattern is a plain character.
- The first word is the program, matched by its name, so `/bin/rm` counts as `rm`.
- Every other word that does not start with `-` must appear in the command in the pattern's order, and other words may sit between them: `git push` matches `git push origin main`.
- Every flag, a word that starts with `-`, must appear somewhere in the command, in any order. `--force` also matches `--force=yes`.
- cmod splits a cluster of short flags into single flags, in the pattern and in the command alike, so `rm -rf` matches `rm -rf`, `rm -fr`, and `rm -r -f`. A letter that takes a value keeps the rest of the cluster as its value. These programs keep their flags as written: `find`, `java`, `javac`, `go`, `gcc`, `g++`, `clang`, `clang++`, `swift`, `swiftc`, `xcodebuild`, `xcrun`, `ffmpeg`, `ffprobe`, `openssl`, `plutil`, `defaults`, `security`, and `codesign`.
- Words and flags match exactly, letter case included.
- Each command of a pipeline or a `&&` chain counts, and so does the command a wrapper runs: `sudo rm -rf /` holds the commands `sudo` and `rm -rf /`. The wrappers are `sudo`, `env`, `doas`, `timeout`, `flock`, `stdbuf`, `watch`, `nohup`, `nice`, `time`, `exec`, `command`, and `xargs`.

## permissions

A `deny` rule needs no permission. An `ask` rule takes effect only with `"approve": true` in `package.json` `"cmod".permissions` ([permissions.md](permissions.md)).

```ts
permissions<State>(rules: PermissionRules<State> | ((state: State) => PermissionRules<State>)): Job<void, State>

type PermissionRules<State> = { deny?: Rule<State>[]; ask?: Rule<State>[] }

type Rule<State> = Target & {
  when?: (call: <the call of the target's key> & { folder: string }, mod: Mod<State>) => boolean | Promise<boolean>
  reason?: string
}
```

- Before each call, cmod tries every `deny` rule, then every `ask` rule. The first rule that matches decides, and its `reason` goes with the decision. No match leaves the call to Claude Code.
- Rules that change with the mod's state come from a function of `mod.state`, which cmod calls before each call. A mode that changes what Claude may write changes `mod.state`, and the next call follows it, as the panes and a `prompt` with no trigger do. A function that throws, or returns a rule that names no target, denies the call with `The permission rules of <mod> failed, so it denies the call: <error>`. A function that returns `{}` leaves every call to Claude Code.
- The strictest answer wins: a mod's `ask` or `deny` beats Claude Code's `allow`, and Claude Code's `deny` beats a mod's `ask`.
- `when` narrows a rule. The rule matches only when `when` resolves true. A `when` that throws makes the rule match, and the reason adds `Its when check failed: <error>`.
- When cmod cannot read the call or the session, it denies the call with the reason.
- For a PowerShell command, or a Bash command cmod cannot fully parse, a `command` rule matches when every word of its pattern appears in the command line. A `read` or `write` rule matches when the command line holds the last segment of its pattern, after the last `/`, and only when that segment holds none of `*?[]{}`. So `{ write: 'Domain.md' }` matches such a command that names `Domain.md`, and `{ write: '**/.env*' }` never matches one. A `!` pattern leaves nothing out of such a line, so the rule errs toward matching.
- `permissions({})` throws `permissions: give it a deny or an ask rule, or remove it from setup.`
- A mod that uses `permissions` calls `registerPermissionCheck(addHook)` after `registerMod` in `hooks/register.ts` ([mod.md](mod.md)). Without it `mod.use(permissions(…))` throws, so a mod that uses it in `setup` does not start.

`when` gets the call, typed by the target's key. `jobs/permissions.js` exports each type, and `Call` is any of them:

| Key | Call type | Fields beyond `tool`, `input`, `agentId`, `agentType`, and `folder` |
| --- | --- | --- |
| `command` | `CommandCall` | `commands`, each `[program, ...arguments]`, and `isFullyParsed` |
| `read`, `write` | `FileCall` | `path`, and for an `Edit` or a `Write`, `content`, the new text, and `previousContent`, the text before |
| `fetch` | `FetchCall` | `url` |
| `subagent`, `tool` | `Call` | none |

`tool` is the tool's name, such as `Bash`, and `input` is its input as Claude Code sent it, such as `{ command, description }` for `Bash`, so a rule reads any field cmod does not parse. `agentId` and `agentType` name the subagent that makes the call. In the main conversation `agentId` is absent, and `agentType` is the agent the session started as, when it started as one. `folder` is the root of the git work tree that holds the call's file or folder, or that folder itself outside one, so `process.run(['git', 'status'], { cwd: call.folder })` asks the repository the call works in. `jobs/permissions.js` also exports `Target`, `Rule`, and `PermissionRules`.

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

Its command needs `"run"` with the program's name, such as `"run": ["tsc"]` ([permissions.md](permissions.md)).

```ts
check<State>(options: { readonly after: Target | Target[]; readonly run: readonly string[]; readonly timeoutMs?: number }): Job<void, State>
```

- After each call that matches `after` and succeeds, cmod runs `run`. A call that was denied or failed runs nothing.
- For a `read` or `write` target, cmod adds the matched files that still exist to the end of `run`, as absolute paths. For any other target it runs `run` as it is.
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

It needs `"prompt": true`. Without the grant it adds nothing and logs once which line to add ([permissions.md](permissions.md)).

```ts
prompt<State>(options: {
  name: string
  prompt: string | ((input: { call?: Call & { folder: string } }, mod: Mod<State>) => string | undefined | Promise<string | undefined>)
  after?: Target | Target[]
}): Job<void, State>
```

`prompt` adds text that Claude reads. `after` picks when:

| Options | When Claude reads the text |
| --- | --- |
| no `after` | At the start of each conversation, as a block of context named `name`. A block of that name already in the context wins. Then again whenever `mod.state` changes and the text differs from what Claude last got. |
| `after` | After each call that matches a target and succeeds, with the call's result, under the heading `# <name>`. `input.call` is the matched call, with its `folder` as `permissions` gives it. |

- Without `after`, the text follows the mod's state. After a change to `mod.state`, cmod calls `prompt` again, and when the text differs from what Claude last got, it adds `# <name>` and the new text to the conversation as a `Note` Claude reads on its next call to the model, as `sessions.current.send` does ([session.md](session.md#act-on-a-session)). Several changes in a row give one note with the last text. A note waits until the conversation has started, so a state change before the first prompt changes only the first block.
- A `prompt` function that returns `undefined` or `''` adds nothing. One that throws adds nothing, and the error goes to Claude Code's debug log.
- `name` cannot be blank. Two prompts with one name in a mod throw.
- Text for the prompts that match a pattern is a `beforePrompt` note: `sessions.current.beforePrompt({ text: /\bmigrat/i }, () => ({ note: 'Every migration has a down step.' }))` ([session.md](session.md#change-what-happens)).

```ts
import { defineMod, fs, sessions } from '../node_modules/@cmodjs/core/mod.js'
import { prompt } from '../node_modules/@cmodjs/core/jobs/prompt.js'

export const conventions = defineMod({
  name: 'conventions',
  state: { session: { mode: 'build' } },
  setup(mod) {
    mod.use(prompt({ name: 'Commit messages', prompt: 'Write commit messages in the imperative mood.' }))
    mod.use(prompt({ name: 'Mode', prompt: (_input, mod) => `You are in ${mod.state.session.mode} mode.` }))
    mod.use(prompt({ name: 'Schema', after: { write: 'db/schema.sql' }, prompt: async () => `The schema is now:\n${await fs.read(`${sessions.current.project}/db/schema.sql`)}` }))
  },
})
```

## schedule

It needs `"prompt": true`, because each cron starts a turn ([permissions.md](permissions.md)).

```ts
schedule<State>(entry: ScheduledPrompt | ((state: State) => ScheduledPrompt | undefined)): Job<void, State>

type ScheduledPrompt = { readonly cron: string; readonly prompt: string }
```

`schedule` gives Claude a prompt on a schedule, through the cron jobs Claude Code keeps for `/loop`. `cron` is a standard 5-field cron in local time, such as `*/10 * * * *` for every 10 minutes. At each fire Claude Code shows one `Running scheduled task` row and Claude answers the prompt.

- A function of the state follows it. After each change to `mod.state`, cmod calls it again, and when its answer differs, cmod deletes the cron and makes the new one. `undefined` deletes the cron and makes none, which is how a mod pauses.
- Claude Code fires a cron only while Claude is idle, on whole minutes, up to a tenth of the period late. A recurring cron expires after 7 days.
- A cron lasts only as long as the session. The job makes it again each time the mod starts, and deletes the one it made before `/reload-plugins`, so a cron is never doubled.
- A blank `cron` or `prompt` throws. A function that throws keeps the last cron, and a cron Claude Code refuses writes a log line naming why.
- Work that needs no turn of Claude's, such as polling a file, belongs in `mod.every`. A mod pauses a schedule by turning it off: a hook that drops a fire still leaves two rows, `Running scheduled task` and `Prompt dropped by a hook:`.

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { schedule } from '../node_modules/@cmodjs/core/jobs/schedule.js'

export const loop = defineMod({
  name: 'loop',
  state: { project: { isOn: false, cron: '*/10 * * * *', prompt: 'Check the CI and fix what failed.' } },
  setup(mod) {
    mod.use(schedule((state) => (state.project.isOn ? { cron: state.project.cron, prompt: state.project.prompt } : undefined)))
  },
})
```

## program

It needs `"run"` with the program's name. Without the grant the program stops at once and names the line to add ([permissions.md](permissions.md)).

```ts
program(options: { readonly command: readonly string[]; readonly environment?: Record<string, string>; readonly singleInstance?: boolean }): Job<Program>

type Program = {
  readonly state: 'stopped' | 'starting' | 'running' | 'backoff' | 'fatal'
  ready(): Promise<{ url: string; socketPath?: string }>
}
```

`program` runs a background program, such as a preview server, and hands the mod its address.

- `command` is the program on `PATH` and its arguments. `environment` sets variables for it. An empty `command` throws.
- The program's first line on standard output must be its address: `127.0.0.1:<port>`, or `unix:<absolute socket path>`. `ready()` then resolves `{ url: 'http://127.0.0.1:<port>' }`, or `{ url: 'http://localhost', socketPath }`. Pass both to `http.fetch`, which reaches that address with no `network` permission while the program runs.
- In an interactive session the program starts with the mod. Otherwise it starts at the first `ready()`.
- When the program exits, cmod starts it again after 1, 2, 4, 8, and 16 seconds. After 5 failed tries, or a first line that is not an address, the state is `fatal`, `ready()` rejects, and cmod logs `<mod>: the <program> program stopped: <reason>`.
- `singleInstance: true` runs one copy on the computer, however many sessions load the mod, such as a server that is the only writer of its data. Each session runs it through [`cmod program`](commands.md#cmod-program): the first session starts the copy, and every session's `ready()` resolves that copy's address and reaches it with no `network` permission. When the session running the copy ends, another open session starts a new copy, and from then on `ready()` resolves the new address in every session, so ask `ready()` before each use rather than keeping its answer. A copy a killed session left running is stopped before the new one starts. Two `singleInstance` programs with the same program name in one mod throw at `mod.use`.
- A program that ships with the mod gets onto `PATH` through the `program` key of the mod's `package.json` ([install-steps.md](install-steps.md)). A program an install step fetched with `cmod download` is not on `PATH`, so `command` names it by its full path, `${mod.dataFolder}/bin/<program>`.

```ts
import { defineMod, http } from '../node_modules/@cmodjs/core/mod.js'
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
        reply: async () => {
          const { url, socketPath } = await server.ready()
          const response = await http.fetch(`${url}/status`, socketPath === undefined ? {} : { socketPath })
          return response.text
        },
      }),
    )
  },
})
```

## Write a job of your own

A `Job` is a function. `mod.use` calls it with a `JobContext` and returns what it returns:

```ts
type JobContext<State> = {
  readonly mod: Mod<State>
  announce(feature: string): void
  reserveName(type: string, name: string, taken: string): Reservation
}

type Reservation = { remove(): void }
```

- `mod` is the mod that uses the job. A job builds on `mod.every`, the `add` calls of `mod`, and the imports from `mod.js`, such as the methods of `sessions`, as `setup` does ([mod.md](mod.md)).
- `announce` adds a phrase to the list cmod logs when the mod first starts.
- `reserveName` throws `taken` when the mod already reserved that `type` and `name`, so a job refuses a duplicate. `remove()` on what it returns frees the name again.

A job that hands back a feature the mod turns off returns a handle with `remove()`, as `slashCommand` and `tool` do:

```ts
import { defineMod, sessions, type Job } from '../node_modules/@cmodjs/core/mod.js'

type EditCounter = { count(): number; remove(): void }

const editCounter = (tool: string): Job<EditCounter> => ({ mod, announce, reserveName }) => {
  const reserved = reserveName('editCounter', tool, `${mod.name}: edits of ${tool} are already counted.`)
  let edits = 0
  const listening = sessions.current.onToolCall({ name: tool }, () => void (edits += 1))
  announce(`a count of ${tool} calls`)
  return {
    count: () => edits,
    remove() {
      listening.remove()
      reserved.remove()
    },
  }
}

export const counter = defineMod({
  name: 'counter',
  setup(mod) {
    const writes = mod.use(editCounter('Write'))
    sessions.current.onTurnEnd(() => mod.toast(`${writes.count()} files written so far`))
  },
})
```

### The building blocks

The built-in jobs are written from these building blocks, which a job of your own may import:

| Import | Export | What it does |
| --- | --- | --- |
| `jobs/context.js` | `afterCall(job, contextAfter, failed)` | Runs `contextAfter` after each call that succeeds, and adds the lines it returns to the call's result. |
| `jobs/context.js` | `inFolder(call, folder, workspace)` | Adds the `folder` a rule's `when` gets: the work tree that holds the call's path or folder, or the folder itself. |
| `jobs/context.js` | `withinDeadline(mod, deadline, subject, run)` | Runs `run`, and rejects with `<subject> passed the <n> s deadline of <job>` when it has not answered by `deadline`, `{ ms, job? }`. |
| `jobs/context.js` | `workspaceReader(job)` | A function that reads the session's project, working folder, home, file access, and project scope. |
| `jobs/permissions/decide-permission.js` | `decidePermission`, `stricterVerdict`, and the types `Rule`, `PermissionRules`, `Decision`, `Verdict` | Decides a call against permission rules. |
| `jobs/permissions/find-project-scope.js` | `findProjectScope`, and the types `ProjectScope`, `Workspace` | Finds the repository a project plugin belongs to. |

A job of your own matches calls against targets through the `permissions`, `check`, and `prompt` jobs. A `prompt` with `after` runs any code after a matching call, and may add no text: `prompt({ name: 'commits', after: { command: 'git commit' }, prompt: (_input, mod) => { mod.state.project.commits += 1; return undefined } })`.

## Test a job

`tested.type('/todo milk')` runs a slash command. `tested.callTool('open_ticket', { title: 'Crash' })` runs the permission rules, then the tool. `tested.fire('tool.check', …)` asks the permission rules about any call. `tested.shown.notes` holds the notes a `prompt` sent after a state change. [testing.md](testing.md) covers each.
