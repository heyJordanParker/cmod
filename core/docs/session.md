# Sessions

`sessions` reads and follows Claude Code's conversations: the one the mod runs in, every other one Claude Code saved, and a search across them. A mod never parses a transcript.

```ts
import { Prompt, sessions } from '../node_modules/@cmodjs/core/mod.js'

const prompts = (await sessions.current.messages()).filter((message) => message.type === Prompt)
```

A mod reads and acts on the session it runs in, every other session on the computer, and every session of another device a sessions provider serves to this one. It hears only the session it runs in, as a VS Code extension hears only its own window.

## The shape of a conversation

A session is one agent and its record. It runs as a series of contexts: a compaction or `/compact` ends one context and starts the next with a summary of the last. Each context holds turns: a turn starts at a prompt and ends when the agent stops. Each turn holds the messages the agent and the people and programs around it exchanged. The session's goal is what it is for, and its tasks are the work it handed to other sessions. Each task's `owner` is the session that does that work, such as an `Explore` subagent, with a record of its own.

```
Session                one agent and its record
├── Goal               what the session is for
│   └── Task           work handed to another session
│       ├── owner      the Session doing it, with its own goal, turns, and messages
│       └── Task       a task its owner handed on
└── Context            from the start, or a compaction, to the next compaction
    └── Turn           from a prompt to the end of the agent's answer
        └── Message    a prompt, a reply, a tool call, and the rest
```

Every part of the record answers `search`, which finds its messages. Every part of the session the mod runs in also answers `on`, which hears what happens in it, and `before`, which changes or refuses what is about to happen in it.

## sessions

```ts
type Sessions = {
  readonly current: CurrentSession
  list(options?: { running?: boolean; since?: string; everyProject?: boolean }): Promise<Session[]>
  get(id: string): Promise<Session>
  search(text: string, matcher?: Matcher<Message>, options?: { running?: boolean; since?: string; everyProject?: boolean; before?: Message }): AsyncIterable<Message>
}
```

- `current` is the session the mod runs in. It is there from `setup` on, and follows `/clear`, `/resume`, a fork, `/cd`, and a `cd` in a Bash or PowerShell call.
- `list` lists the project's sessions, the most recent first. `everyProject` lists every project's, `running` keeps the sessions still open in a Claude Code window, and `since` keeps those active since a time, written as `30m`, `6h`, `2d`, `1w`, or a date such as `2026-10-01`. It lists this computer's sessions and those of every sessions provider a mod's program runs ([Sessions providers](#sessions-providers)).
- `get` finds one session by its `id`, running or ended, on this computer or through any sessions provider, asking each provider for that id alone, and rejects with `no session <id> on any of your devices.` when none holds it.
- `search` yields the messages whose text contains `text`, any case, newest first, in the project's sessions or, with `everyProject`, every project's. `text` is at least 3 characters. It reads the index a page at a time as the loop asks for more, and `break` stops it. A matcher keeps the messages it matches, and `before` starts after a message, so a "load more" picks up where a loop broke. A tool call is searched by its name and the first 1,024 characters of each input value, an instruction file by its path and text, and a tool result is not searched.

```ts
const found: Message[] = []
for await (const message of sessions.search('deploy job', { type: Prompt }, { since: '1w' })) {
  found.push(message)
  if (found.length === 20) break
}
const more = sessions.search('deploy job', { type: Prompt }, { since: '1w', before: found.at(-1) })
```

- `sessions` and a listed session have no `on` and no `before` methods, because a mod hears only the session it runs in. `sessions.current` and its parts have them ([Listen](#listen-to-a-record)).

While cmod has set up a mod other than cmod, the cmod plugin indexes every conversation in the background at each session's start, so `search` waits only for what changed since. The `cmod sessions` command answers the same questions in a terminal ([commands.md](commands.md#cmod-sessions)), and a script `cmod run` runs reads and drives sessions with the same `sessions` ([commands.md](commands.md#cmod-run)).

### Sessions providers

One `cmod serve` per computer serves its sessions to every session and script on it ([commands.md](commands.md#cmod-serve)). When a mod's program provides `cmod/Devices` ([dependencies.md](dependencies.md#cmod-devices-providers-on-your-other-devices)), `cmod serve` reaches the `cmod serve` of each device it names, and that `cmod serve` provides `cmod/Sessions` for its device's sessions. A mod whose program provides the `cmod/Sessions` interface ([dependencies.md](dependencies.md#interfaces-several-mods-answer-one-name)) serves the sessions of other devices the same way. So `list`, `get`, and `search` read every device's sessions, and every action reaches them, as they reach this computer's. A call on one session goes to each provider in turn, `cmod serve` first, and the first that holds the session answers it. A provider that does not hold the session throws `NotHeld` from `rpc.js`, and a call no provider holds rejects with the last provider's message, such as `No session <id> on this computer.` or `This provider holds no session <id>.`

A provider answers each session it lists with `device: { id, name }`, the computer the session runs on, in the shape `device.read()` answers ([mod.md](mod.md#device-the-computer-the-session-runs-on)). `cmod serve` names this computer, and a provider a mod's program runs names the device each of its sessions runs on. A session of a computer without a machine id has no `device`.

## Session

```ts
type Session = {
  readonly id: string
  readonly title: string
  readonly color?: string
  readonly project: string
  readonly agentType?: string
  readonly model: string
  readonly cwd: string
  readonly transcriptPath?: string
  readonly isRunning: boolean
  readonly startedAt: string
  readonly lastAt: string
  readonly forkedFrom?: string
  readonly visitedAt?: string
  readonly device?: { id: string; name: string }
  readonly status?: 'busy' | 'shell' | 'idle' | 'waiting'
  readonly waitingFor?: { dialog: string; tool?: string; input?: Record<string, unknown>; question?: string }
  readonly contextPercent?: number
  readonly lastTurn?: { reason: 'answered' | 'stopped' | 'failed'; at: string; failure?: string; reply?: string }
  readonly openCall?: { tool: string; summary: string }
  readonly goal: Goal
  context(): Promise<Context>
  contexts(): Promise<Context[]>
  turn(): Promise<Turn | undefined>
  turns(options?: { last?: number }): Promise<Turn[]>
  messages(options?: { after?: string; last?: number }): Promise<Message[]>
  search(text: string, matcher?: Matcher<Message>): AsyncIterable<Message>
  send(message: { type: Prompt | Note; text: string; as?: Person | Session }): Promise<SendReceipt>
  startTask(task: { prompt: string; title: string; agentType?: string; model?: string; name?: string; cwd?: string; isBackground?: boolean; device?: string }): Promise<Task>
  fork(task: { prompt: string; title: string; isBackground?: boolean; at?: string }): Promise<Task>
  callTool(call: { name: string; input: Record<string, unknown> }): Promise<ToolResult>
  usage(): Promise<Usage>
  surfaces(): Promise<Surface[]>
  end(): Promise<void>
  visit(at?: string): Promise<void>
  delete(): Promise<void>
}
```

- `id` is Claude Code's session id, and a task owner's `id` is its task's id. `title` is the name the person gave it with `/rename`, or the first line of its first prompt. A resumed or forked session with no name, and a session the mod started in after its first prompt, has an empty `sessions.current.title` until `sessions.list()` reads it. `sessions.current.device` is empty until `sessions.list()` reads the current session from `cmod serve`, which names this computer, and holds from then on.
- `color` is the color the person last picked with `/color`, such as `cyan`, and is absent when they never picked one or reset it with `/color default`. A task's owner has none. `sessions.current.color` follows each `/color` the person runs, and a resumed session's color holds from the mod's start, as `title` does.
- `project` is the project the session works in, and `cwd` is its working folder. For the current session both follow `/cd`, and `cwd` follows a `cd` in a Bash or PowerShell call.
- `agentType` is the agent definition the session runs, such as `Explore` for a task's owner, or the agent a session started with `claude --agent` runs. A plain session has none.
- `model` is the model the session runs on. `startedAt` and `lastAt` are ISO times.
- `forkedFrom` names the session a `/branch` or a fork copied it from, and for a task's owner the session whose `fork` started it.
- `visitedAt` is when the person last opened the session's reply, in the browser app or in a mod that calls `visit`, as an ISO time. A reply after it is unread. A session nobody visited has none.
- `transcriptPath` is the file Claude Code writes the session's conversation to. A task's owner names its own file, `subagents/agent-<task>.jsonl` in the folder beside the session's file, and a background task names the file of the session that runs it.
- `isRunning` is true while the session is open in a Claude Code window, and for a task's owner while its task runs.
- `device` is the computer the session runs on, its `id` and `name` as `device.read()` answers them ([mod.md](mod.md#device-the-computer-the-session-runs-on)). A listed session's is the one its sessions provider names ([Sessions providers](#sessions-providers)). A session of a computer without a machine id has none, and so does a task's `owner`. `sessions.get(task.id)` reads a background task's session with the device its store names.
- `status` is what a running session does now, as Claude Code records it: `busy` while a turn runs, `waiting` while a dialog waits on the person, `shell` while a command a stopped turn left runs in its terminal, and `idle` between turns. A session whose Claude Code records none has the one its cmod plugin hears: `busy` from a turn's start to its end, `waiting` while a permission prompt or a question is open, else `idle`. An ended session, a task's `owner`, and `sessions.current` have none.
- `waitingFor` is what a `waiting` session waits on. `dialog` is Claude Code's name for it, such as `permission prompt`, `input needed`, or `dialog open`. A permission prompt for a tool call adds the call's `tool` and `input`, and an `AskUserQuestion` call adds its first `question`.
- `contextPercent` is how full the session's context window is, in percent, from its `usage()` after each turn. A session before its first answer has none.
- `lastTurn` is how the session's last main turn ended, as its cmod plugin hears it: `answered`, `stopped` when the person stopped it with Esc or an app's `abort`, or `failed` with the `failure` text Claude Code gave, and `at`, the ISO time it ended. An `answered` turn adds `reply`, the first line of Claude's last answer in it. A running session no cmod plugin holds takes it from its transcript: `answered`, with `reply`, once its last main turn ended. A turn stopped with Esc has no ending in its transcript until the next prompt, so only the cmod plugin's hooks hear it. A running turn and an ended session have none.
- `openCall` is the tool call the session's main agent runs now, as its cmod plugin hears it: its `tool`, such as `Bash`, and `summary`, the first line of its command, file, pattern, URL, query, question, description, or prompt. It goes away once the call returns. An `idle` session, a session between calls, and an ended session have none.
- `cmod/Sessions` tells a `Change` of `part: 'status'` whenever a session's `status`, `waitingFor`, `contextPercent`, `lastTurn`, or `openCall` changes, and one of `part: 'title'` when the name Claude Code records for a running session changes.

### Read a record

- `goal` is its goal. `sessions.current.goal` follows the session the mod runs in, as `sessions.current` does, so a listener added on it in `setup` keeps hearing across `/clear`, `/resume`, and a fork. The goal's `text()` reads its text now, and its `tasks()` answers the tasks the session handed on. Each task's `owner` reads like any session.
- `context` answers the context it is in now, and `contexts` all of them in order. A context's `turns()` answers its own.
- `turn` answers the turn running now, and nothing between turns. `turns` answers its turns in order, `last` keeping that many from the end. A turn's `messages()` answers its own.
- `messages` answers its messages in order, those of its tasks left out. `last` keeps that many from the end, and `after` starts after a message's `id`.
- `search` yields its messages whose text contains `text`, newest first, the way `sessions.search` does. A goal's, a task's, a context's, and a turn's `search` find only their own.

```ts
const [last] = await sessions.current.turns({ last: 1 })
const calls = (await last?.messages() ?? []).filter((message) => message.type === ToolCall)
const explorers = (await sessions.current.goal.tasks()).filter((task) => task.owner.agentType === 'Explore')
```

A session that has ended keeps its record, so every read works on it.

`sessions.current` adds two members for the rows Claude Code draws, `scrollTo(message, options?)` and `caption(toolCall, text)` ([ui.md](ui.md#the-conversation-s-rows)).

### Listen to a record

```ts
part.on<Event>(listener: (payload, time: { deadline: number; signal: AbortSignal }) => unknown, options?: { timeoutMs?: number }): Subscription
part.on<Event>(matcher: Matcher<payload>, listener, options?): Subscription
```

Each event has its own method, such as `onReply` or `onTaskStart`, which runs `listener` for each new message, turn, context, task, goal change, or usage change, as it happens. `sessions.current`, its goal, a task, a task's owner, a context, and a turn each have every `on` method, and each hears what happens inside it: an event reaches the part it happens in and every part above it.

A mod hears only the session it runs in, as a VS Code extension hears only its own window. A listed session has no `on` method, and a listener on a part of another session, such as a background task's owner or a turn read from another session, throws `<mod>: onReply works only in a mod's own session.`, as every listener of a `cmod run` script does. A background task's own `onTaskEnd` still hears it end, because the task belongs to this session's goal.

A session is one agent: the conversation's main agent, or the agent doing a task. An event runs up one chain:

```
Turn ──> Context ──> Session ──> that session's Task ──> each Task above ──> Goal
```

The goal belongs to the main agent, so the main agent's events reach it too. So:
- `sessions.current.onToolCall(…)` hears the main agent's tool calls only.
- `sessions.current.goal.onToolCall(…)` hears every agent's in the session.
- `task.onMessage(…)` hears every message of the task's owner and of the tasks it handed on, and `task.owner.onMessage(…)` hears the owner's alone.
- `turn.onReply(…)` hears the replies of that turn only.

A turn or a context that has ended takes no listener: its methods throw `<mod>: turn <id> has ended, so its onReply never fires. Listen on its Session.`

| Method | The listener gets | It happens in |
| --- | --- | --- |
| `onMessage` | Every new message. | Its turn |
| `onPrompt`, `onNote`, `onReply`, `onToolCall`, `onToolResult`, `onSkill`, `onInstructionFile`, `onAttachedFile`, `onNotice` | Each new message of that type. | Its turn |
| `onTurnStart`, `onTurnEnd` | The `Turn` that started or ended. | Its context |
| `onContextStart`, `onContextEnd` | The `Context` that started or ended. | The session |
| `onTaskStart`, `onTaskEnd` | The `Task` that started or ended. | Its parent task, or the goal |
| `onGoalChange` | The `Goal` with its new text. | The goal |
| `onUsageChange` | The session's new `Usage`. | The session |

The events arrive as Claude Code writes them.

A matcher keeps the payloads it matches. It is a partial copy of the payload: a key it names must match, and a key it leaves out matches anything. A string matches the same string, a `RegExp` matches the text it tests true on, and a list matches any one of its items. A key the payload lacks matches nothing.

```ts
import { sessions } from '../node_modules/@cmodjs/core/mod.js'

sessions.current.onToolCall({ name: /^(Edit|Write)$/ }, (call) => void (mod.state.session.edits += 1))
sessions.current.onTaskStart({ owner: { agentType: 'Explore' } }, (task) => mod.log(`Exploring: ${task.title}`))
```

A listener that throws shows the error toast `The <method> listener failed`, such as `The onReply listener failed`. `remove()` on the `Subscription` stops the listener.

### Give a listener time

A listener gets 10 seconds. `timeoutMs` changes that, a whole number above 0 and at most `600000`. The second argument a listener gets is its `deadline`, the time it ends as `Date.now()` counts, and a `signal` that aborts then, or as soon as the person cancels the work the listener runs for, as Esc does during a tool call, so a slow call such as `http.fetch` can stop with it. Time a listener spends waiting on a call, such as `process.run`, never counts against the 10 seconds Claude Code gives a hook's own code, so a listener that waits can use its whole `timeoutMs`:

```ts
sessions.current.onTurnEnd(async (turn, { signal }) => {
  await http.fetch('https://hooks.example.com/turn', { method: 'POST', body: turn.answer ?? '', signal })
}, { timeoutMs: 30_000 })
```

A cancel stops the listener quietly. Claude Code stops the programs its `process.run` and `process.spawn` calls started, cmod goes on without its answer, and nothing it throws shows a toast.

An `on` listener that passes its time stops quietly. A `before` listener that passes its time shows the error toast, and what was about to happen goes on as it was. With `onFailure: 'refuse'`, a `before` listener that throws or passes its time refuses instead, with the error as the reason, for a gate that must hold even when it breaks. The gate holds when Claude Code stops the mod's hook too, as it does when the listener's own code runs past 10 seconds without waiting on a call, and the toast `Claude Code stopped its <hook> hook` says so. A `beforePermissionRequest` listener always refuses when it fails.

### Change what happens

```ts
part.before<Event>(listener: (payload, time) => Answer | void, options?: { timeoutMs?: number; onFailure?: 'pass' | 'refuse' }): Subscription
part.before<Event>(matcher: Matcher<payload>, listener, options?): Subscription
```

Each `before` method, such as `beforeToolCall`, runs `listener` just before something happens, and its answer changes or refuses it. Returning nothing lets it happen as it was. Each part that has `on` methods has every `before` method, and hears what is about to happen inside it, the way `on` methods do.

| Method | The listener can answer | Covers |
| --- | --- | --- |
| `beforePrompt` | `{ text?, note?, title? }` or `{ refuse }` | A typed prompt, a mod's prompt, a command Claude Code sends as a prompt, such as a project's `/review`, and a message from another session. `note` reaches Claude beside a typed or a mod's prompt, and `title` names the session. A task's first prompt reaches `beforePrompt` as the subagent starts, where `note` is the only answer and the subagent reads it before its first step. To keep a task from starting, refuse it in `beforeTaskStart`. A built-in command such as `/model` is never a prompt: `commands.beforeRun` hears every command ([mod.md](mod.md#commands-slash-commands)). |
| `beforeNote` | `{ text }` | A note any mod or Claude Code adds |
| `beforeSkill` | `{ text }` | A Skill as Claude Code loads it |
| `beforeInstructionFile` | `{ text }` or `{ refuse }` | A `CLAUDE.md` file as Claude Code reads it. `refuse` leaves it out |
| `beforeAttachedFile` | `{ text }` or `{ refuse }` | A file Claude Code attaches by itself, such as one the person mentions with `@` or one it puts back after a compaction. `text` replaces what Claude reads, and `refuse` leaves it out |
| `beforeReply`, `beforeNotice` | `{ text }` | The text the transcript keeps |
| `beforeToolResult` | `{ output?, isError?, note? }` | The result, after the tool ran. Here `output` is what the tool answered Claude Code, such as `{ stdout, stderr }` for Bash, and an `output` answer replaces it in the same shape, `note` adds text beside it, and `isError: true` makes Claude read it as a failure, with the note as the reason. A failed call takes only a note |
| `beforeToolCall` | `{ input?, note? }`, `{ result, note? }`, or `{ refuse }` | A tool call. `result` answers it without running the tool, and `note` reaches Claude with the call's result |
| `beforeTaskStart` | `{ prompt?, title?, owner?: { agentType?, model?, cwd? }, isAsync? }` or `{ refuse }` | A task about to start. `prompt` and `title` replace what Claude wrote, `owner` picks the agent that does it, its model, and its folder, and `isAsync` runs a subagent while Claude goes on. A background task takes `prompt`, `title`, `owner`, and `refuse`, a background fork takes `prompt`, `title`, and `refuse`, and a workflow's agent takes only `refuse` |
| `beforeTurnEnd` | `{ note }` or `{ refuse }` | The agent about to stop. `refuse` tells it it may not stop yet, and it reads the reason as an error. `note` gives it new information, which it reads at once and keeps working. On `task.owner`, it is the task about to hand back its answer |
| `beforeContextEnd` | `{ summary }` or `{ refuse }` | A compaction about to start. `summary` is the text the new context starts with, which Claude reads as one prompt, in place of the summary Claude Code's model would write, so no model runs. `refuse` keeps the context, whatever another mod answered. When several mods answer `summary`, the last one asked stands |

```ts
sessions.current.beforeToolCall({ name: 'Bash', input: { command: /\brm -rf\b/ } }, () => ({ refuse: 'Delete files one at a time.' }))
sessions.current.beforeTaskStart({ owner: { agentType: 'Explore' } }, () => ({ owner: { model: 'haiku' } }))
sessions.current.beforeTurnEnd(async () => ((await testsPass()) ? undefined : { refuse: 'The tests fail. Fix them before you stop.' }))
```

When several listeners answer, each sees what the one before it changed, and the first `refuse` or `result` decides.

Claude reads each mod's `note` inside the mod's own tag, such as `<my-mod_mod>…</my-mod_mod>` for the mod `my-mod`. Every note Claude received becomes a `Note` whose `from` is `{ type: 'mod', name }`, so `onNote({ from: { type: 'mod', name: 'my-mod' } })` hears each note from my-mod that Claude got, and never one Claude Code dropped.

### The session's own events

`sessions.current` is a `CurrentSession`, which also hears what happens to the session itself. Each event has an `on` method, and one a mod can change also has a `before` method. A `before` method's answer reaches Claude Code, and an `on` listener never makes Claude Code wait. These methods hear the main agent, never a subagent.

| Method | Claude Code's moment | The payload | The listener can answer |
| --- | --- | --- | --- |
| `beforeProjectSetup`, `onProjectSetup` | `claude --init-only` sets up the project | `ProjectSetup`: `trigger` | `{ note }`, which Claude reads in the session it sets up. Claude Code waits for the answer |
| `beforeSessionStart`, `onSessionStart` | a startup, resume, `/clear`, or fork, and for `beforeSessionStart` a compaction | `SessionStartAsked`, `SessionStarted`: `source`, `model?`, `title?`, `idleSeconds?`, `contextTokenCount?`, `isCacheWarm?`, `cacheWriteUsd?` | `{ note?, title?, reloadSkills?, firstPrompt? }` |
| `onSessionEnd` | the session ends | `SessionEnded`: `reason` | |
| `beforeModelChange`, `onModelChange` | `/model` switches the model | `ModelChange`: `model`, `previous`, `requested?`, `source`, `contextTokenCount`, `isCacheWarm`, `cacheTtl`, `cacheWriteUsd`, `pricing?` | `{ ask }`, `{ refuse }`, or `{ note }`, which Claude reads right after the switch |
| `onCwdChange` | the working folder moves | `CwdChange`: `previous`, and `cwd` is the new folder | |
| `onDirectoryAdd` | `/add-dir` adds a folder | `DirectoryAdd`: `directory`, `source` | |
| `beforeWorktreeCreate`, `onWorktreeCreate`, `onWorktreeRemove` | a worktree is made or removed | `Worktree`: `name?`, `path?` | `{ result }`, the worktree's path |
| `onNotification` | Claude Code notifies the person | `Notification`: `text`, `title?`, `type` | |
| `beforeElicitation`, `onElicitation` | an MCP server asks the person | `Elicitation`: `id?`, `server`, `text`, `mode?`, `url?`, `schema?` | `{ refuse }` |
| `beforeElicitationResponse`, `onElicitationResponse` | the person answers an MCP server | `ElicitationResponse`: `id?`, `server`, `mode?`, `action`, `content?` | `{ refuse }` |
| `beforePermissionCheck`, `onPermissionCheck` | Claude Code decides whether a tool call runs, asks, or is refused, before any dialog, and when a mod asks `tools.check` | `PermissionCheck`: `name`, `input`, `callId?`, `decision`, `reason?`, `rule?`, `ceiling?` | `{ allow: true }`, `{ ask }`, or `{ refuse }`, each with an optional `note`, or `{ note }` alone. `allow` approves a call in every mode, auto mode included. A `note` reaches Claude with the result of the call it checked, as a `beforeToolCall` note does. `allow` and `ask` need `"approve": true` in `package.json` `"cmod"` ([mod.md](mod.md#register-the-mod-with-claude-code)). A mod never overrides a refusal from the person's settings |
| `beforePermissionRequest`, `onPermissionRequest` | a permission dialog is about to show | `PermissionRequest`: `name`, `input`, `suggestions`, `mcpServer?` | `{ allow: true, input?, updates? }` or `{ refuse, interrupt? }` |
| `beforePermissionDenial`, `onPermissionDenial` | a tool call was denied | `PermissionDenial`: `name`, `input`, `callId`, `reason`, `mcpServer?` | `{ retry: true }` |
| `beforeToolBatch`, `onToolBatch` | a batch of tool calls finished | `ToolBatch`: `calls`, each `{ callId, name, input, output? }` | `{ note }` |
| `beforeTodoCreate`, `onTodoCreate`, `beforeTodoComplete`, `onTodoComplete` | a todo is added to or ticked on the checklist | `Todo`: `id`, `subject`, `description?`, `teammate?` | `{ refuse }` |
| `beforeReplyDisplay`, `onReplyDisplay` | a reply is about to show | `ReplyDisplay`: `replyId`, `index`, `isLast`, `text` | `{ text }`, what the person sees |

The four `PermissionCheck` and `PermissionRequest` methods work only in a mod whose `hooks/register.ts` calls `registerPermissionCheck` ([mod.md](mod.md#register-the-mod-with-claude-code)). Without it they throw where they are called.

At a compaction, Claude reads the `note` at the start of the window the compaction opens, and the person never sees it, and `title`, `reloadSkills`, and `firstPrompt` apply to the whole session. The payload carries `model` for the main agent and `contextTokenCount` as the compaction left it. `sessions.current.beforeSessionStart` hears the main agent's compactions. `sessions.current.goal.beforeSessionStart` also hears every subagent's, with the subagent in `task`, and its note reaches that subagent's window. A subagent's compaction takes only `note`:

```ts
sessions.current.goal.beforeSessionStart({ source: 'compact' }, ({ task }) => ({ note: primerFor(task) }))
```

Every payload also carries where it happened: `session`, `cwd`, and `agentType?` and `permissionMode?` when Claude Code reports them. A matcher keeps the payloads it matches:

```ts
sessions.current.beforeSessionStart({ source: 'compact' }, () => ({ note: 'Re-read DESIGN.md before you continue.' }))
sessions.current.beforeModelChange({ model: /haiku/ }, () => ({ refuse: 'This project stays on opus.' }))
sessions.current.onCwdChange(({ cwd, previous }) => mod.log(`moved from ${previous} to ${cwd}`))
```

### Act on a session

Every action works on the current session and on every other running session, on this computer or through a sessions provider. cmod carries an action to another session, and that session's cmod does it there.

- `send` adds a message to the session, and resolves a `SendReceipt`, `{ id?, state }`.
  - A `Note` is text the agent reads on its next call to the model and the person does not see. It starts no turn. To the current session it rejects with `<mod>: Claude Code refused the note: <reason>` when a plugin refuses it.
  - A `Prompt` is the next prompt, so the agent answers it as a turn of its own. Claude Code holds it until the session is idle, so it never cuts into a turn, and frames it as `The <mod> plugin sent a message:`. With `as: Person`, the agent reads it bare, as the person's own words, while every hook still sees that the mod sent it. To the current session it rejects with `<mod>: Claude Code dropped the prompt: <reason>` when a plugin drops it.
  - To another session, the message is mail: the `cmod serve` of the device the session runs on stores it in `mail.sqlite` before it delivers it, so a restart of either side never drops it. `send` resolves once the mail is stored and never waits on the session, as an SMTP server answers once it queued a message. `id` names the mail, and `state` is the mail's state when `send` resolved, which is always `'queued'`. The mail turns delivered once the session's cmod plugin took it, which waits while the session runs a turn, as Claude Code finishes the turn before it takes a prompt, while no cmod plugin in the session reaches `cmod serve`, or while the plugin refused it. `cmod/Sessions` tells a `Change` of `part: 'mail'` each time a mail to the session is stored or delivered. The plugin gets each queued mail, in the order it was sent, each time it reaches `cmod serve` again, as it does at its start and at a reload. `cmod sessions read mail` lists a session's mail with its state ([commands.md](commands.md#cmod-sessions)).
  - `as: Session` sends it from the current session, which its cmod plugin names with the session's id and title: the session reads it inside `<cmod-message from="<id>" title="<title>" reply="cmod sessions send <id start> --reply-to <mail>">`, which names the sender and the command that answers it, and leaves `title` out for a session with no title. To the current session itself it rejects with `<mod>: session <id> cannot send as itself to itself.`
  - To the current session and to a task's owner, which takes the text in its running subagent, a message is no mail, and `send` resolves `{ state: 'delivered' }`.
  - To a session that has ended, the mail resumes it in a new background Claude Code session, as `claude --bg --resume` does, which answers it. A session Claude Code still runs is never resumed, so a message never starts a second copy of it: its mail stays queued until a cmod plugin in it reaches `cmod serve`.
- `startTask` starts a task in the session, the way the Agent tool starts one, and resolves the `Task` once it started. It does not wait for the task to finish. `title` is the task's title, `agentType` names the owner's agent type, such as `Explore`, `name` is the address a teammate's `SendMessage` reaches it by, and `model` and `cwd` change what it runs on and where. It rejects with `<mod>: Claude Code refused the task: <reason>` when a hook refuses it.
  - With `isBackground: true`, the owner is a new background Claude Code session, as `claude --bg` starts, which starts fresh on the prompt and keeps running after this session ends. It takes no `name`, and rejects with `<mod>: a background task takes no name.` for one.
  - `device` names the device the background session runs on, by its name or its cmod device id. A `device` other than this computer starts through the sessions provider that serves it ([Sessions providers](#sessions-providers)): cmod asks the `startTask` of each provider on that device, its `cmod serve` among them, or of every provider when none runs there, in turn, with the whole task, `device` included, and the first that does not answer not-held starts the session there and answers its task. A device's `cmod serve` starts it in the task's `cwd`, or the project of this session when the task names none, and rejects with `<device> has no folder <cwd>, so the task did not start. Give the task a cwd on <device>.` when that device lacks the folder. With no such provider, the call rejects with `<mod>: no mod starts sessions on <device>, so the task did not start. Leave device out to start it on <this computer>.`
- `fork` starts a subagent that keeps this session's whole conversation and does what the prompt says.
  - With `isBackground: true`, the owner is a new background session on a copy of the conversation, which cmod writes as a transcript of its own, and which carries on with the prompt.
  - `at` is the `id` of a message of the conversation. The copy holds the conversation from its first message through that one, and nothing after it, and needs `isBackground: true`, else the call rejects with `<mod>: a fork through a message runs as a background session. Add isBackground: true.`
- `end` ends the session's Claude Code once its running turn ends, or at once between turns, a background session through `claude stop` and any other through `/exit`. Its conversation stays, so a `Prompt` sent to it later resumes it.
- `visit` marks the session's reply read at `at`, an ISO time, or now, which moves its `visitedAt`.
- `delete` deletes a session that has ended: its transcripts, its goal, its tasks, and its rows in the index. A running session stays, and the call rejects with `session <id> runs, so it stays. End it first.`

Every task shows in this session's goal. `fork` takes only `prompt`, `title`, `isBackground`, and `at`, because the owner is a copy of this session. A `beforeTaskStart` listener that refuses a background task or a background fork rejects the call with `<mod>: a beforeTaskStart listener refused the task: <reason>`.

```ts
await sessions.current.startTask({ title: 'Map the auth code', prompt, agentType: 'Explore' })
await sessions.current.fork({ title: 'Write the tests', prompt: 'Write tests for what we just built.' })
await sessions.current.fork({ title: 'Try SQL instead', prompt: 'Rebuild this on SQL.', isBackground: true })
await sessions.current.startTask({ title: 'Upgrade dependencies', prompt, isBackground: true })
```

| Call | `task.isBackground` | `task.owner` |
| --- | --- | --- |
| `startTask` | absent | a subagent of this session, with its `agentType` |
| `fork` | absent | a subagent of this session, `forkedFrom` this session |
| `fork` with `isBackground` | `true` | a new session whose `id` is the task's, `forkedFrom` this session |
| `startTask` with `isBackground` | `true` | a new session whose `id` is the task's |
- `callTool` runs a tool in the session, such as `{ name: 'Bash', input: { command: 'bun test' } }`, and resolves its `ToolResult`.
- `usage` answers the session's model, its context window's fill, its rate limits, and its cost so far, as the status line shows them: `{ model, contextWindow: { tokenCount?, size?, percent? }, rateLimits?: { type, percent, resetsAt? }[], cost?: { usd } }`. Each rate limit is one window of the account's plan: its `type`, such as `five_hour`, `seven_day`, or a Claude gateway's `spend_limit`, how much of it is used, 0 to 100, and when it resets, as an ISO 8601 time. For an ended session and a task's owner it answers the model and the tokens of its last reply, from its transcript, with no rate limits.
- `surfaces` answers the Claude apps showing the session now: `'terminal'`, `'desktop'`, `'mobile'`, and `'vscode'`. An ended session shows in none.

A task's owner is a `TaskOwner`, a session without `startTask`, `fork`, `callTool`, and `delete`, because Claude Code gives a subagent no way to start a task or run a tool from outside. It takes `send`, `usage`, and `surfaces`, and a background task's owner also `end` and `visit`. An action other than `send`, `usage`, `surfaces`, `visit`, and `delete` on a session that has ended rejects with `session <id> has ended, so it takes no <action>. Message it to resume it.`

A prompt that comes on a clock, such as every 10 minutes, belongs in a `schedule` job instead, which Claude Code shows as one `Running scheduled task` row ([jobs.md](jobs.md#schedule)).

```ts
mod.every(60_000, async () => {
  const { stdout } = await process.run(['gh', 'run', 'list', '--limit', '1', '--json', 'conclusion'])
  if (JSON.parse(stdout)[0]?.conclusion !== 'failure') return
  await sessions.current.send({ type: Note, text: 'CI failed on the last push.' })
  await sessions.current.send({ type: Prompt, text: 'Find the cause of the CI failure and fix it.' })
})
```

The task's answer arrives once it finishes, on an `onTaskEnd` listener:

```ts
mod.use(slashCommand({
  name: 'summarize',
  description: 'Summarize the README in one line',
  async reply() {
    const task = await sessions.current.startTask({ prompt: 'Summarize README.md in one line.', title: 'Summarize the README', agentType: 'Explore' })
    task.onTaskEnd(async (ended) => {
      const [answer] = await ended.owner.messages({ last: 1 })
      if (answer?.type === Reply) mod.toast(answer.text)
    })
    return 'Summarizing the README.'
  },
}))
```

## Message

Every message has these fields, and the fields of its type:

```ts
type MessageOf<Type> = {
  readonly id: string
  readonly type: Type
  readonly at: string
  readonly session: string
  readonly context: number
  readonly turn?: string
  readonly task?: string
  readonly agentType?: string
}
```

- `id` names the transcript row the message is in. When one row holds several messages, such as a reply with its tool calls, each `id` ends in `:<n>`. `sessions.current.scrollTo(message)` scrolls to the message's row ([ui.md](ui.md#the-conversation-s-rows)).
- `at` is its ISO time. `session` is the session's id, and `context` the number of the context it is in, from 1.
- `turn` is the `id` of the prompt that opened its turn. A task's message names its owner's turn. A message before the first prompt has none.
- `task` is the id of the task whose message it is. A message of the session itself has none.
- `agentType` is the agent definition of the agent the message belongs to: the task's agent for a task's message, and the agent the session runs, as `claude --agent` starts one, for the session's own. A message of a plain session has none.

| Type | Constant | Its own fields |
| --- | --- | --- |
| `'prompt'` | `Prompt` | `text`, `from`: the prompt that opens a turn. A command Claude Code sends as a prompt reads as typed, such as `/review 12`. A command a mod runs, such as cmod's `/reload-plugins`, is no prompt, and `commands.onRun` hears it. |
| `'note'` | `Note` | `text`, `from`: text Claude reads that is not a prompt, such as a mod's note or a task's notification. |
| `'reply'` | `Reply` | `text`: what Claude said. |
| `'toolCall'` | `ToolCall` | `callId`, `name`, `input`, `cwd`, `files`: a tool Claude called, the folder it called it in, and the files it reads and changes. |
| `'toolResult'` | `ToolResult` | `callId`, `name`, `input`, `cwd`, `files`, `output`, `isError`: the call's tool, input, folder, and files, and what the tool answered. `output` is the text Claude read, or the tool's own result for `callTool`. |
| `'skill'` | `Skill` | `name`, `text`: a Skill Claude Code loaded. |
| `'instructionFile'` | `InstructionFile` | `path`, `text`, `isRule`: a `CLAUDE.md` file or a rule file Claude Code read. `isRule` is true for a file in a `.claude/rules/` folder. |
| `'attachedFile'` | `AttachedFile` | `path`, `attachmentType`, `text`: a file Claude Code attached by itself, without a tool call. `attachmentType` is `'contents'` for the whole file, such as one the person mentioned with `@` or one Claude Code put back after a compaction, `'reference'` for a file Claude read before a compaction whose contents Claude Code left out, and `'change'` for what changed in a file Claude read since it read it. `text` is what Claude reads. A file Claude reads with a tool is a `ToolResult` instead. |
| `'notice'` | `Notice` | `text`: a line Claude Code added, such as a model switch. |

### files: what a tool call reads and changes

A `ToolCall`'s and a `ToolResult`'s `files` is `{ read: string[]; changed: string[] }`, absolute paths that cmod works out from the call:

- `Read` reads its `file_path`. `Edit`, `Write`, and `NotebookEdit` change their path.
- `Grep` counts its `path`, or the working folder when it names none, and `Glob` counts its `pattern` joined to its `path`. Since `read` lists only files, a `Grep` of a folder and every `Glob` usually leave `read` empty.
- A `Bash` command reads and changes the files its commands name, such as `cat a.ts > b.ts`. A path that holds a shell expansion, such as `$HOME`, is left out.
- `read` lists only paths that are files now. `changed` lists every path the call writes, whether it exists or not.
- A path cmod cannot check, such as one it has no permission to read, is left out of `read`, and cmod writes the path and the reason to Claude Code's debug log.
- When cmod cannot work the files out, both lists are empty, and the reason goes to Claude Code's debug log.

```ts
sessions.current.onToolResult(({ files }) => void (mod.state.session.edited += files.changed.length))
```

`Message` is any of these, and `message.type` tells them apart:

```ts
for (const message of await sessions.current.messages()) {
  if (message.type === ToolCall) console.log(message.name, message.input)
}
```

### Sender

A prompt's and a note's `from` says who sent it:

```ts
type Sender = { readonly type: SenderType; readonly name?: string; readonly as?: 'person' }
```

| `type` | Who sent it |
| --- | --- |
| `Person` (`'person'`) | The person, at the keyboard or from a phone. |
| `'mod'` | A mod, named by `name`. `as: Person` when it sent the prompt as the person's. |
| `'session'` | Another session. |
| `'task'` | A task, reporting back. |
| `Schedule` (`'schedule'`) | A scheduled prompt. |
| `Channel` (`'channel'`) | A channel, such as Slack, named by `name`. |
| `Sdk` (`'sdk'`) | A program driving Claude Code through the SDK. |
| `Engine` (`'engine'`) | Claude Code itself, such as the prompt that keeps a turn going after it hit its output limit. |

## Turn, Context, Goal, and Task

```ts
type Turn = {
  readonly prompt: Prompt
  readonly context: number
  readonly openedAt: string
  readonly closedAt?: string
  readonly answer?: string
  readonly reason?: 'answer' | 'error'
  readonly failure?: { readonly type: string; readonly text: string }
  readonly isAfterRefusal?: true
  readonly device?: Device
  messages(): Promise<Message[]>
  abort(): Promise<void>
  search; on…; before…
}

type Context = { readonly number: number; readonly openedAt: string; readonly closedAt?: string; turns(): Promise<Turn[]>; search; on…; before… }

type Goal = { text(): Promise<string>; tasks(): Promise<Task[]>; search; on…; before…; update(change: { text: string }): Promise<void> }

type TaskStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

type Task = {
  readonly id: string
  readonly title: string
  readonly owner: TaskOwner
  readonly openedBy: string
  readonly openedAt: string
  readonly closedAt?: string
  readonly status?: TaskStatus
  readonly name?: string
  readonly spawnedBy?: string
  readonly isBackground?: true
  tasks(): Promise<Task[]>
  messages(): Promise<Message[]>
  search; on…; before…
}
```

- A turn's `closedAt` is set once the agent stops. A turn still running has none.
- The turn `onTurnEnd` hears carries why it ended. `reason` is `'answer'` when Claude finished, with its last words in `answer`, and `'error'` when a request failed, with `failure` naming the error's `type`, such as `'rate_limit'`, and its `text`. A turn a mod kept going with `beforeTurnEnd` ends only at the stop that nothing refuses, and the turn `beforeTurnEnd` hears at each stop after a refusal has `isAfterRefusal: true`, so a listener can let the agent stop the second time. A turn read later through `turns()` has `closedAt` and none of these.

```ts
sessions.current.onTurnEnd((turn) => {
  if (turn.failure !== undefined) mod.toast.error(`Claude stopped: ${turn.failure.text}`)
})
```
- A turn's `device` is the computer it ran on ([mod.md](mod.md#device-the-computer-the-session-runs-on)). At each start, resume, `/clear`, and compaction, the cmod plugin adds a note Claude reads and the person never sees, naming the computer the session runs on and the time, so a session resumed on another computer names that one from then on. A turn runs on the device the last such note before it names, and a task's turns on the device its session ran on when it started the task, so the note a subagent's compaction puts in its own window changes no turn's device. A turn with no such note before it, such as one from a session an older cmod ran, has no `device`.
- `abort()` stops a turn while it runs, a task's turn included. It throws on a turn that has ended. Claude Code shows no marker, so a mod that aborts tells the person with a toast.
- A context's `number` counts from 1. Its `closedAt` is set at the compaction that ended it.
- A goal's text starts as the session's first prompt, and `text()` reads it. `update` replaces it, and `onGoalChange` hears the goal, whose `text()` reads the new text.
- A task's `owner` is a `TaskOwner`: the session doing the work, which can't start tasks or call tools. Its goal is the task's prompt, its `agentType` and `model` are what the task runs, and its turns and messages are the task's own. Claude Code's checklist tools, `TaskCreate`, `TaskUpdate`, and `TaskList`, are not tasks: they are its todo list, which `onTodoCreate` and `onTodoComplete` hear.
- A task's `openedBy` is the `callId` of the Agent call that started it, and empty for a task a mod started. Its `closedAt` is set once it ended, with `status` saying how: `completed`, `failed`, or `killed`. A subagent's ends when its Agent call returns, at the notification Claude Code gives when it completes, fails, or is stopped, and at a `TaskStop` call that stops it. A notification that it waits on its own background work ends nothing. A subagent whose session's Claude Code ended, or restarted after it started, ended with it, as `killed`. A background task ends at the first stop of the session that does it, which that session's cmod tells this session, and one on another device once its sessions provider tells, with a `Change` of `part: 'running'`, that the session no longer runs.
- A task with `isBackground` is done by a separate session, whose `id` is the task's. Its owner reads that session's own turns and messages, and `task.messages()`, `task.tasks()`, and `task.search` read them too. `task.on…` and `task.before…` hear the task's start and end. `task.owner` takes no listener, because it is another session. Claude Code's own fork agent reads as a fork: an Agent call that forks shows an owner `forkedFrom` this session, with no `agentType`.
- A task Claude Code still runs holds `status`, where its agent stands now, `name`, the name a teammate is messaged by, and `spawnedBy`, the plugin that started it, absent when Claude or the person did, read through the cmod plugin of the session that runs it, so the tasks of every running session read live. A background task holds the `status` `claude agents` lists for its session. `cmod/Sessions` tells a `Change` of `part: 'tasks'` each time one of a session's tasks starts or ends.

## Test it

`testMod` fakes the conversation: `tested.add`, `tested.endTurn`, `tested.compact`, and `tested.startTask` build the current session, and the `sessions` option gives the earlier ones ([testing.md](testing.md#build-a-conversation)).
