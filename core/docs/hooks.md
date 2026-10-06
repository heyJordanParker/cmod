# Hooks

`mod.on` runs a function when Claude Code raises an event, such as a prompt or a tool call. The function reads the event's input and may answer to change what Claude Code does next.

## mod.on

```ts
mod.on<E extends ModEvent>(event: E, hook: ModHook<E>): void

type ModHook<E> = (input: HookInputs[E]) => HookAnswer | void | Promise<HookAnswer | void>
```

Add hooks in `setup`. Each `mod.on` adds one more hook. Several hooks on one event all run.

A hook on `PreToolUse` or `PermissionRequest` takes part in Claude Code's permission check, so the mod's `hooks/register.ts` calls `registerPermissionCheck(addHook)` after `registerMod` ([mod.md](mod.md)). Without it the mod does not start.

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

`ModEvent` names the 17 events a mod hooks. The input of each is the hook input a `settings.json` hook reads for that event, typed as `ClassicHookInputs['<event>']` in the `claude-code` module, with the changes this table names.

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

cmod raises `CwdChanged` itself, never Claude Code. It raises it when the working folder changes: after `/cd`, after a Bash or PowerShell call, and at a prompt. `mod.cwd` and `mod.projectRoot` already hold the new folder when the hook runs.

## files: what a tool call reads and changes

The input of `PreToolUse`, `PostToolUse`, and `PostToolUseFailure` has `files: { read: string[]; changed: string[] }`, absolute paths that cmod works out from the call:

- `Read` reads its `file_path`. `Edit`, `Write`, and `NotebookEdit` change their path.
- `Grep` counts its `path`, or the working folder when it names none, and `Glob` counts its `pattern` joined to its `path`. Since `read` lists only files, a `Grep` of a folder and every `Glob` usually leave `read` empty.
- A `Bash` command reads and changes the files its commands name, such as `cat a.ts > b.ts`. A path that holds a shell expansion, such as `$HOME`, is left out.
- `read` lists only paths that are files now. `changed` lists every path the call writes, whether it exists or not.
- When cmod cannot work the files out, both lists are empty, and the reason goes to Claude Code's debug log.

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
| `PreToolUse` | `additionalContext`, `permissionDecision`, `permissionDecisionReason`, `updatedInput` |
| `PermissionRequest` | `decision` |
| `PermissionDenied` | `retry` |
| `PostToolUse` | `additionalContext`, `updatedToolOutput`, `updatedMCPToolOutput` |
| `PostToolUseFailure`, `PostToolBatch`, `SubagentStart`, `SubagentStop`, `Stop` | `additionalContext` |
| `SessionEnd`, `InstructionsLoaded`, `Notification`, `PreCompact`, `StopFailure`, `CwdChanged` | none |

A field the event does not read is an error: `it answered hookSpecificOutput.<field>, which <event> does not read. Remove it from the answer.` A flag set to `false`, such as `retry: false`, counts as unset.

## How answers combine

Every mod's hooks and Claude Code's own `settings.json` hooks answer the same event.

- `additionalContext` from every hook reaches Claude, each in turn.
- On `PreToolUse` the strictest decision wins: `deny` over `ask` over `allow`. A mod's `allow` never overrides a `deny` from another hook.
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
