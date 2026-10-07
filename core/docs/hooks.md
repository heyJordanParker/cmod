# Hooks

`mod.on` runs a function when Claude Code raises an event, such as a prompt or a tool call. The function reads the event's input and may answer to change what Claude Code does next.

## mod.on

```ts
mod.on<E extends ModEvent>(event: E, hook: ModHook<E>): void

type ModHook<E> = (input: HookInput<E>) => HookAnswer | void | Promise<HookAnswer | void>
```

Add hooks in `setup`. Each `mod.on` adds one more hook. Several hooks on one event all run.

`HookInput<E>`, exported from `mod.js`, is the input a hook on `E` gets, for a hook that lives in a function of its own:

```ts
import type { HookAnswer, HookInput, Mod } from '../node_modules/@cmodjs/core/mod.js'

export async function addBranch(mod: Mod, input: HookInput<'SessionStart'>): Promise<HookAnswer | undefined> {
  const { stdout } = await mod.process.run(['git', 'branch', '--show-current'], { cwd: input.cwd })
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `The git branch is ${stdout.trim()}.` } }
}
```

A `PreToolUse` hook runs on Claude Code's `tool.call`, before Claude Code checks the call's permission. It rewrites the call's input, adds context to it, or denies it, and Claude Code's permission check sees the rewritten input. A `permissionDecision` of `'allow'` or `'ask'` decides the call's permission, so it takes effect in Claude Code's permission check, and only when the mod's `hooks/register.ts` calls `registerPermissionCheck(addHook)` after `registerMod` ([mod.md](mod.md)):

- `'allow'` runs the call without asking the person, and `'ask'` asks them, with `permissionDecisionReason` as the question's reason.
- A deny from a settings rule or another hook still denies the call, and the mod's own `permissions` job can still ask or deny.
- Without `registerPermissionCheck`, an `'allow'` or `'ask'` denies the call with `<mod>: the PreToolUse hook answered permissionDecision "allow", so hooks/register.ts must call registerPermissionCheck(addHook) after registerMod.`

A hook on `PermissionRequest` takes part in that check too, so a mod with one does not start without `registerPermissionCheck`.

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'

export const safeDelete = defineMod({
  name: 'safe-delete',
  setup(mod) {
    mod.on('PreToolUse', (input) => {
      const command = input.tool_input['command']
      if (input.tool_name !== 'Bash' || typeof command !== 'string' || !command.startsWith('rm ')) return
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, command: command.replace(/^rm /, 'trash ') } } }
    })
  },
})
```

## Every ModEvent

`ModEvent` names the 18 events a mod hooks. The input of each is the hook input a `settings.json` hook reads for that event, typed as `ClassicHookInputs['<event>']` in the `claude-code` module, with the changes this table names.

| Event | Input changes |
| --- | --- |
| `SessionStart` | none |
| `SessionEnd` | none |
| `UserPromptSubmit` | none |
| `InstructionsLoaded` | none |
| `PreToolUse` | Claude Mod Manager (cmod) builds the input: `session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`, `agent_id` inside a subagent, `agent_type` inside a subagent or when the session started as an agent, and `files`. It has no `transcript_path` and no `permission_mode`. |
| `PermissionRequest` | none |
| `PermissionDenied` | none |
| `PostToolUse` | adds `files` |
| `PostToolUseFailure` | adds `files` |
| `PostToolBatch` | none |
| `SubagentStart` | none |
| `SubagentStop` | none |
| `Notification` | none |
| `PreCompact` | none |
| `Stop` | none |
| `StopFailure` | none |
| `CwdChanged` | no `transcript_path` |
| `FileChanged` | none |

cmod raises `CwdChanged` itself, never Claude Code. It raises it when the working folder changes: after `/cd`, after a Bash or PowerShell call, and at a prompt. `mod.cwd` and `mod.projectRoot` already hold the new folder when the hook runs.

Claude Code raises `FileChanged` when a file it watches changes, with the file's `file_path` and `event`: `'change'`, `'add'`, or `'unlink'`. It watches the paths a `SessionStart` hook answers in `watchPaths`:

```ts
mod.on('SessionStart', () => ({ hookSpecificOutput: { hookEventName: 'SessionStart', watchPaths: [`${mod.dataFolder}/history`] } }))
mod.on('FileChanged', ({ file_path, event }) => mod.ui.toast(`${file_path}: ${event}`))
```

## files: what a tool call reads and changes

The input of `PreToolUse`, `PostToolUse`, and `PostToolUseFailure` has `files: { read: string[]; changed: string[] }`, absolute paths that cmod works out from the call:

- `Read` reads its `file_path`. `Edit`, `Write`, and `NotebookEdit` change their path.
- `Grep` counts its `path`, or the working folder when it names none, and `Glob` counts its `pattern` joined to its `path`. Since `read` lists only files, a `Grep` of a folder and every `Glob` usually leave `read` empty.
- A `Bash` command reads and changes the files its commands name, such as `cat a.ts > b.ts`. A path that holds a shell expansion, such as `$HOME`, is left out.
- `read` lists only paths that are files now. `changed` lists every path the call writes, whether it exists or not.
- When cmod cannot work the files out, both lists are empty, and the reason goes to Claude Code's debug log.

## shell.js and path.js: read a command line

`shell.js` reads a Bash line the way cmod does for `files`, and `path.js` is `node:path`'s POSIX functions, which a mod cannot import from Node:

```ts
parseShell(line: string): ParsedShell

type ParsedShell = { commands: ShellCommand[]; reads: string[]; writes: string[]; fetches: string[]; isFullyParsed: boolean }
type ShellCommand = { argv: [string, ...string[]]; folder: string }

resolve(...paths): string   join(...paths): string   dirname(path): string   basename(path, suffix?): string
extname(path): string        relative(from, to): string   isAbsolute(path): boolean   normalize(path): string
```

- `commands` lists every command the line runs, those inside `sudo`, `bash -c`, `$(…)`, and heredocs included, with flags such as `-rf` split into `-r` and `-f`.
- `folder` is where a command runs, as the line wrote it: `''` for the folder the line starts in, `src` after `cd src`, `/tmp` after `cd /tmp`, and `~/p` after `cd ~/p`. `resolve(input.cwd, folder)` makes it absolute.
- `reads`, `writes`, and `fetches` are the paths and URLs the commands name, as written. A path that holds a shell expansion makes `isFullyParsed` false, and so does a line the parser cannot read.
- `resolve` has no working folder to start from in Claude Code's hooks, so pass an absolute folder first, such as `resolve(mod.cwd, path)`.

```ts
import { basename, resolve } from '../node_modules/@cmodjs/core/path.js'
import { parseShell } from '../node_modules/@cmodjs/core/shell.js'

mod.on('PreToolUse', (input) => {
  if (input.tool_name !== 'Bash') return
  for (const { argv, folder } of parseShell(String(input.tool_input['command'])).commands) {
    if (basename(argv[0]) === 'trace') mod.ui.toast(`trace runs in ${resolve(input.cwd, folder)}`)
  }
})
```

## HookAnswer: what a hook can answer

Return nothing to leave the event as it is. Return a `HookAnswer` to change it. The fields are the ones a `settings.json` hook writes as JSON:

```ts
type HookAnswer = {
  continue?: boolean
  stopReason?: string
  suppressOutput?: boolean
  systemMessage?: string
  decision?: 'block'
  reason?: string
  hookSpecificOutput?: {
    hookEventName?: ModEvent
    additionalContext?: string
    permissionDecision?: 'allow' | 'deny' | 'ask'
    permissionDecisionReason?: string
    updatedInput?: Record<string, unknown>
    sessionTitle?: string
    suppressOriginalPrompt?: boolean
    initialUserMessage?: string
    watchPaths?: string[]
    reloadSkills?: boolean
    decision?: PermissionRequestDecision
    updatedToolOutput?: unknown
    updatedMCPToolOutput?: unknown
    retry?: boolean
  }
}
```

- `continue: false` stops the session after the event, and `stopReason` is the text Claude Code shows. `PreToolUse` takes neither.
- `decision: 'block'` with a `reason` blocks the event. On `PreToolUse` it denies the call with the reason. On `Stop` it keeps Claude going with the reason.
- `systemMessage` shows the text to the person as a log line.
- cmod ignores `suppressOutput`.
- `hookSpecificOutput.hookEventName` is optional. When set, it must be the event's own name.

Each event reads only some `hookSpecificOutput` fields:

| Event | `hookSpecificOutput` fields it reads |
| --- | --- |
| `SessionStart` | `additionalContext`, `initialUserMessage`, `sessionTitle`, `watchPaths`, `reloadSkills` |
| `UserPromptSubmit` | `additionalContext`, `sessionTitle`, `suppressOriginalPrompt` |
| `PreToolUse` | `additionalContext`, `permissionDecision` (`'allow'` and `'ask'` need `registerPermissionCheck`), `permissionDecisionReason`, `updatedInput` |
| `PermissionRequest` | `decision` |
| `PermissionDenied` | `retry` |
| `PostToolUse` | `additionalContext`, `updatedToolOutput`, `updatedMCPToolOutput` |
| `PostToolUseFailure`, `PostToolBatch`, `SubagentStart`, `SubagentStop`, `Stop` | `additionalContext` |
| `SessionEnd`, `InstructionsLoaded`, `Notification`, `PreCompact`, `StopFailure`, `CwdChanged`, `FileChanged` | none |

A field the event does not read is an error: `it answered hookSpecificOutput.<field>, which <event> does not read. Remove it from the answer.` A flag set to `false`, such as `retry: false`, counts as unset.

## How answers combine

Every mod's hooks and Claude Code's own `settings.json` hooks answer the same event.

- `additionalContext` from every hook reaches Claude, each in turn.
- `PreToolUse` hooks run one inside the next, in the order mods and `mod.on` added them. A deny stops the call there, so no hook after it runs. `updatedInput` replaces the tool's input for every hook after it and for Claude Code. `additionalContext` reaches Claude with the call's result, and not at all when Claude Code refuses the call.
- For every other field, the mod's answer replaces the answer of the hooks beneath it.

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'

export const keepGoing = defineMod({
  name: 'keep-going',
  state: { session: { hasCheckedTests: false } },
  setup(mod) {
    mod.on('Stop', () => {
      if (mod.state.session.hasCheckedTests) return
      mod.state.session.hasCheckedTests = true
      return { decision: 'block', reason: 'Run the tests before you stop.' }
    })
  },
})
```

## When a hook fails

A hook that throws, rejects, or answers a field its event does not read fails:

- On `PreToolUse` the call is denied with `<mod>: the PreToolUse hook failed: <error>`.
- On `PermissionRequest` the request is denied with `<mod>: the PermissionRequest hook failed: <error>`.
- On every other event cmod logs `<mod>: the <event> hook failed: <error>`, and the event goes on as if the hook answered nothing.

## The first SessionStart

A mod that is still installing when the session starts misses Claude Code's `SessionStart`. cmod holds `SessionStart` up to 9 seconds for the mod to start. When the mod starts later, cmod runs its `SessionStart` hooks then, and Claude Code no longer reads their answer.

## Test a hook

`tested.fire(event, input)` runs the mod's hooks on an event and returns the combined answer. It fills `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and `tool_use_id`, so a test gives only the event's own fields. [testing.md](testing.md) covers it.
