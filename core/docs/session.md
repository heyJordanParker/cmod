# Sessions

`sessions` reads and follows Claude Code's conversations: the one the mod runs in, every other one Claude Code saved, and a search across them. A mod never parses a transcript.

```ts
import { Prompt, sessions } from '../node_modules/@cmodjs/core/mod.js'

const prompts = (await sessions.current.messages()).filter((message) => message.type === Prompt)
```

A mod hears and reads the session it runs in with no permission. Every other session needs the `conversation` permission. Sending to a session and changing its text need `prompt`, calling a tool and changing a tool call need `tools`, and starting or changing a task needs `tasks`. A `refuse` answer needs no permission ([permissions.md](permissions.md)).

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

Every part of the record answers the same three calls: `search` finds its messages, `on` hears what happens in it, and `before` changes or refuses what is about to happen in it.

## sessions

```ts
type Sessions = {
  readonly current: CurrentSession
  list(options?: { running?: boolean; since?: string; everyProject?: boolean }): Promise<Session[]>
  search(text: string, matcher?: Matcher<Message>, options?: { running?: boolean; since?: string; everyProject?: boolean; before?: Message }): AsyncIterable<Message>
  onMessage(matcher?, listener, options?): Disposable   // and every on method below
}
```

- `current` is the session the mod runs in. It is there from `setup` on, and follows `/clear`, `/resume`, a fork, `/cd`, and a `cd` in a Bash or PowerShell call.
- `list` lists the project's sessions, the most recent first. `everyProject` lists every project's, `running` keeps the sessions still open in a Claude Code window, and `since` keeps those active since a time, written as `30m`, `6h`, `2d`, `1w`, or a date such as `2026-10-01`.
- `search` yields the messages whose text contains `text`, any case, newest first, in the project's sessions or, with `everyProject`, every project's. `text` is at least 3 characters. It reads the index a page at a time as the loop asks for more, and `break` stops it. A matcher keeps the messages it matches, and `before` starts after a message, so a "load more" picks up where a loop broke. A tool call is searched by its name and the first 1,024 characters of each input value, an instruction file by its path and text, and a tool result is not searched.

```ts
const found: Message[] = []
for await (const message of sessions.search('deploy job', { type: Prompt }, { since: '1w' })) {
  found.push(message)
  if (found.length === 20) break
}
const more = sessions.search('deploy job', { type: Prompt }, { since: '1w', before: found.at(-1) })
```

- Its `on` methods hear every running session of the project, this one included, and need the `conversation` permission ([Listen](#listen-to-a-record)). `sessions.current`'s methods hear this session with none. `sessions` has no `before` methods. To change what happens in another session, call a `before` method on that session ([Change what happens](#change-what-happens)).

While a mod holds the `conversation` permission, the cmod plugin indexes every conversation in the background at each session's start, so `search` waits only for what changed since. The `cmod history` command answers the same questions in a terminal ([commands.md](commands.md#cmod-history)).

## Session

```ts
type Session = {
  readonly id: string
  readonly title: string
  readonly project: string
  readonly agentType?: string
  readonly model: string
  readonly cwd: string
  readonly isRunning: boolean
  readonly startedAt: string
  readonly lastAt: string
  readonly forkedFrom?: string
  readonly goal: Goal
  context(): Promise<Context>
  contexts(): Promise<Context[]>
  turn(): Promise<Turn | undefined>
  turns(options?: { last?: number }): Promise<Turn[]>
  messages(options?: { after?: string; last?: number }): Promise<Message[]>
  search(text: string, matcher?: Matcher<Message>): AsyncIterable<Message>
  onMessage(matcher?, listener, options?): Disposable      // and every on method below
  beforePrompt(matcher?, listener, options?): Disposable   // and every before method below
  send(message: { type: Prompt | Note; text: string; as?: Person | Session }): Promise<void>
  startTask(task: { prompt: string; title: string; agentType?: string; model?: string; name?: string; cwd?: string }): Promise<Task>
  callTool(call: { name: string; input: Record<string, unknown> }): Promise<ToolResult>
  usage(): Promise<Usage>
  surfaces(): Promise<Surface[]>
}
```

- `id` is Claude Code's session id, and a task owner's `id` is its task's id. `title` is the name the person gave it with `/rename`, or the first line of its first prompt. A resumed or forked session with no name, and a session the mod started in after its first prompt, has an empty `sessions.current.title` until `sessions.list()` reads it.
- `project` is the project the session works in, and `cwd` is its working folder. For the current session both follow `/cd`, and `cwd` follows a `cd` in a Bash or PowerShell call.
- `agentType` is the agent definition the session runs, such as `Explore` for a task's owner, or the agent a session started with `claude --agent` runs. A plain session has none.
- `model` is the model the session runs on. `startedAt` and `lastAt` are ISO times.
- `forkedFrom` names the session a `/branch` or a fork copied it from.
- `isRunning` is true while the session is open in a Claude Code window, and for a task's owner while its task runs.

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

### Listen to a record

```ts
part.on<Event>(listener: (payload, time: { deadline: number; signal: AbortSignal }) => unknown, options?: { timeoutMs?: number }): Disposable
part.on<Event>(matcher: Matcher<payload>, listener, options?): Disposable
```

Each event has its own method, such as `onReply` or `onTaskStart`, which runs `listener` for each new message, turn, context, task, goal change, or usage change, as it happens. `sessions`, a session, its goal, a task, a context, and a turn each have every `on` method, and each hears what happens inside it: an event reaches the part it happens in and every part above it.

A session is one agent: the conversation's main agent, or the agent doing a task. An event runs up one chain:

```
Turn ──> Context ──> Session ──> that session's Task ──> each Task above ──> Goal ──> sessions
```

The goal belongs to the main agent, so the main agent's events reach it too. So:
- `sessions.current.onToolCall(…)` hears the main agent's tool calls only.
- `sessions.current.goal.onToolCall(…)` hears every agent's in the session.
- `task.onMessage(…)` hears every message of the task's owner and of the tasks it handed on, and `task.owner.onMessage(…)` hears the owner's alone.
- `turn.onReply(…)` hears the replies of that turn only, and `sessions.onPrompt(…)` hears every prompt of every running session in the project.

A turn or a context that has ended takes no listener: its methods throw `<mod>: turn <id> has ended, so its onReply never fires. Listen on its Session.`

| Method | The listener gets | It happens in |
| --- | --- | --- |
| `onMessage` | Every new message. | Its turn |
| `onPrompt`, `onNote`, `onReply`, `onToolCall`, `onToolResult`, `onSkill`, `onInstructionFile`, `onNotice` | Each new message of that type. | Its turn |
| `onTurnStart`, `onTurnEnd` | The `Turn` that started or ended. | Its context |
| `onContextStart`, `onContextEnd` | The `Context` that started or ended. | The session |
| `onTaskStart`, `onTaskEnd` | The `Task` that started or ended. | Its parent task, or the goal |
| `onGoalChange` | The `Goal` with its new text. | The goal |
| `onUsageChange` | The session's new `Usage`. | The session |

The current session's events arrive as Claude Code writes them, and another running session's within a moment.

A matcher keeps the payloads it matches. It is a partial copy of the payload: a key it names must match, and a key it leaves out matches anything. A string matches the same string, a `RegExp` matches the text it tests true on, and a list matches any one of its items. A key the payload lacks matches nothing.

```ts
import { sessions } from '../node_modules/@cmodjs/core/mod.js'

sessions.current.onToolCall({ name: /^(Edit|Write)$/ }, (call) => void (mod.state.session.edits += 1))
sessions.current.onTaskStart({ owner: { agentType: 'Explore' } }, (task) => mod.log(`Exploring: ${task.title}`))
```

A listener that throws shows the error toast `The <method> listener failed`, such as `The onReply listener failed`. `dispose()` on the `Disposable` stops the listener.

### Give a listener time

A listener gets 10 seconds. `timeoutMs` changes that, a whole number above 0 and at most `600000`. The second argument a listener gets is its `deadline`, the time it ends as `Date.now()` counts, and a `signal` that aborts then, so a slow call such as `http.fetch` can stop with it. Time a listener spends waiting on a call, such as `process.run`, never counts against the 10 seconds Claude Code gives a hook's own code, so a listener that waits can use its whole `timeoutMs`:

```ts
sessions.current.onTurnEnd(async (turn, { signal }) => {
  await http.fetch('https://hooks.example.com/turn', { method: 'POST', body: turn.answer ?? '', signal })
}, { timeoutMs: 30_000 })
```

An `on` listener that passes its time stops quietly. A `before` listener that passes its time shows the error toast, and what was about to happen goes on as it was. With `onFailure: 'refuse'`, a `before` listener that throws or passes its time refuses instead, with the error as the reason, for a gate that must hold even when it breaks. The gate holds when Claude Code stops the mod's hook too, as it does when the listener's own code runs past 10 seconds without waiting on a call, and the toast `Claude Code stopped its <hook> hook` says so. On another session, it holds when that session does not answer within 5 seconds, or within what is left of the 8 seconds cmod waits on other sessions for one event, for what the listener's matcher and part cover. A `beforePermissionRequest` listener always refuses when it fails.

### Change what happens

```ts
part.before<Event>(listener: (payload, time) => Answer | void, options?: { timeoutMs?: number; onFailure?: 'pass' | 'refuse' }): Disposable
part.before<Event>(matcher: Matcher<payload>, listener, options?): Disposable
```

Each `before` method, such as `beforeToolCall`, runs `listener` just before something happens, and its answer changes or refuses it. Returning nothing lets it happen as it was. Each part except `sessions` has every `before` method, and hears what is about to happen inside it, the way `on` methods do.

| Method | The listener can answer | Covers |
| --- | --- | --- |
| `beforePrompt` | `{ text?, note?, title? }` or `{ refuse }` | A typed prompt, a mod's prompt, a command Claude Code sends as a prompt, such as a project's `/review`, and a message from another session. `note` reaches Claude beside a typed or a mod's prompt, and `title` names the session. A task's first prompt reaches `beforePrompt` as the subagent starts, where `note` is the only answer and the subagent reads it before its first step. To keep a task from starting, refuse it in `beforeTaskStart`. A built-in command such as `/model` is never a prompt: `commands.beforeRun` hears every command ([mod.md](mod.md#commands-slash-commands)). |
| `beforeNote` | `{ text }` | A note any mod or Claude Code adds |
| `beforeSkill` | `{ text }` | A Skill as Claude Code loads it |
| `beforeInstructionFile` | `{ text }` or `{ refuse }` | A `CLAUDE.md` file as Claude Code reads it. `refuse` leaves it out |
| `beforeReply`, `beforeNotice` | `{ text }` | The text the transcript keeps |
| `beforeToolResult` | `{ output?, isError?, note? }` | The result, after the tool ran. Here `output` is what the tool answered Claude Code, such as `{ stdout, stderr }` for Bash, and an `output` answer replaces it in the same shape, `note` adds text beside it, and `isError: true` makes Claude read it as a failure, with the note as the reason. A failed call takes only a note |
| `beforeToolCall` | `{ input }`, `{ result }`, or `{ refuse }` | A tool call. `result` answers it without running the tool |
| `beforeTaskStart` | `{ owner: { model } }` or `{ refuse }` | A task about to start, and the model its owner runs |
| `beforeTurnEnd` | `{ refuse }` | The agent about to stop. `refuse` sends it on with the reason. On `task.owner`, it is the task about to hand back its answer |
| `beforeContextEnd` | `{ refuse }` | A compaction about to start. `refuse` keeps the context |

```ts
sessions.current.beforeToolCall({ name: 'Bash', input: { command: /\brm -rf\b/ } }, () => ({ refuse: 'Delete files one at a time.' }))
sessions.current.beforeTaskStart({ owner: { agentType: 'Explore' } }, () => ({ owner: { model: 'haiku' } }))
sessions.current.beforeTurnEnd(async () => ((await testsPass()) ? undefined : { refuse: 'The tests fail. Fix them before you stop.' }))
```

An answer that changes text needs the `prompt` permission, a `beforeToolCall` answer needs `tools`, and a `beforeTaskStart` answer needs `tasks`. Without it the answer changes nothing, and the toast `The <method> listener failed` names the permission. When several listeners answer, each sees what the one before it changed, and the first `refuse` or `result` decides.

Claude reads each mod's `note` inside the mod's own tag, such as `<tracer_mod>…</tracer_mod>` for the mod `tracer`. Every note Claude received becomes a `Note` whose `from` is `{ type: 'mod', name }`, so `onNote({ from: { type: 'mod', name: 'tracer' } })` hears each note of tracer's that Claude got, and never one Claude Code dropped.

### The session's own events

`sessions.current` is a `CurrentSession`, which also hears what happens to the session itself. Each event has an `on` method, and one a mod can change also has a `before` method. A `before` method's answer reaches Claude Code, and an `on` listener never makes Claude Code wait. These methods hear the main agent, never a subagent.

| Method | Claude Code's moment | The payload | The listener can answer |
| --- | --- | --- | --- |
| `beforeProjectSetup`, `onProjectSetup` | `claude --init-only` sets up the project | `ProjectSetup`: `trigger` | nothing: Claude Code waits for it |
| `beforeSessionStart`, `onSessionStart` | a startup, resume, `/clear`, or fork, and for `beforeSessionStart` a compaction | `SessionStartAsked`, `SessionStarted`: `source`, `model?`, `title?`, `idleSeconds?`, `contextTokenCount?`, `isCacheWarm?`, `cacheWriteUsd?` | `{ note?, title?, reloadSkills?, firstPrompt? }` |
| `onSessionEnd` | the session ends | `SessionEnded`: `reason` | |
| `beforeModelChange`, `onModelChange` | `/model` switches the model | `ModelChange`: `model`, `previous`, `requested?`, `source`, `contextTokenCount`, `isCacheWarm`, `cacheTtl`, `cacheWriteUsd`, `pricing?` | `{ ask }` or `{ refuse }` |
| `onCwdChange` | the working folder moves | `CwdChange`: `previous`, and `cwd` is the new folder | |
| `onDirectoryAdd` | `/add-dir` adds a folder | `DirectoryAdd`: `directory`, `source` | |
| `beforeWorktreeCreate`, `onWorktreeCreate`, `onWorktreeRemove` | a worktree is made or removed | `Worktree`: `name?`, `path?` | `{ result }`, the worktree's path |
| `onNotification` | Claude Code notifies the person | `Notification`: `text`, `title?`, `type` | |
| `beforeElicitation`, `onElicitation` | an MCP server asks the person | `Elicitation`: `id?`, `server`, `text`, `mode?`, `url?`, `schema?` | `{ refuse }` |
| `beforeElicitationResponse`, `onElicitationResponse` | the person answers an MCP server | `ElicitationResponse`: `id?`, `server`, `mode?`, `action`, `content?` | `{ refuse }` |
| `beforePermissionCheck`, `onPermissionCheck` | Claude Code decides whether a tool call runs, asks, or is refused, before any dialog, and when a mod asks `tools.check` | `PermissionCheck`: `name`, `input`, `callId?`, `decision`, `reason?`, `rule?`, `ceiling?` | `{ allow: true }`, `{ ask }`, or `{ refuse }`. `allow` approves a call in every mode, auto mode included, and needs `approve`. A mod never overrides a refusal from the person's settings |
| `beforePermissionRequest`, `onPermissionRequest` | a permission dialog is about to show | `PermissionRequest`: `name`, `input`, `suggestions`, `mcpServer?` | `{ allow: true, input?, updates? }` or `{ refuse, interrupt? }` |
| `beforePermissionDenial`, `onPermissionDenial` | a tool call was denied | `PermissionDenial`: `name`, `input`, `callId`, `reason`, `mcpServer?` | `{ retry: true }` |
| `beforeToolBatch`, `onToolBatch` | a batch of tool calls finished | `ToolBatch`: `calls`, each `{ callId, name, input, output? }` | `{ note }` |
| `beforeTodoCreate`, `onTodoCreate`, `beforeTodoComplete`, `onTodoComplete` | a todo is added to or ticked on the checklist | `Todo`: `id`, `subject`, `description?`, `teammate?` | `{ refuse }` |
| `beforeReplyDisplay`, `onReplyDisplay` | a reply is about to show | `ReplyDisplay`: `replyId`, `index`, `isLast`, `text` | `{ text }`, what the person sees |

The four `PermissionCheck` and `PermissionRequest` methods work only in a mod whose `hooks/register.ts` calls `registerPermissionCheck` ([mod.md](mod.md#register-the-mod-with-claude-code)). Without it they throw where they are called.

At a compaction, Claude reads the `note` at the start of the window the compaction opens, and `title`, `reloadSkills`, and `firstPrompt` apply to the whole session. The payload carries `model` for the main agent and `contextTokenCount` as the compaction left it. `sessions.current.beforeSessionStart` hears the main agent's compactions. `sessions.current.goal.beforeSessionStart` also hears every subagent's, with the subagent in `task`, and its note reaches that subagent's window:

```ts
sessions.current.goal.beforeSessionStart({ source: 'compact' }, ({ task }) => ({ note: primerFor(task) }))
```

Every payload also carries where it happened: `session`, `cwd`, and `agentType?` and `permissionMode?` when Claude Code reports them. A matcher keeps the payloads it matches:

```ts
sessions.current.beforeSessionStart({ source: 'compact' }, () => ({ note: 'Re-read DESIGN.md before you continue.' }))
sessions.current.beforeModelChange({ model: /haiku/ }, () => ({ refuse: 'This project stays on opus.' }))
sessions.current.onCwdChange(({ cwd, previous }) => mod.log(`moved from ${previous} to ${cwd}`))
```

A `before` method on another session asks the mod over cmod from that session. That session waits up to 5 seconds for the answer, then lets the event happen as it was and logs why.

### Act on a session

Every action works on the current session and on every other running session. cmod carries an action to another session, and that session's cmod does it there.

- `send` adds a message to the session, and needs the `prompt` permission.
  - A `Note` is text the agent reads on its next call to the model and the person does not see. It starts no turn. It rejects with `<mod>: Claude Code refused the note: <reason>` when a plugin refuses it.
  - A `Prompt` is the next prompt, so the agent answers it as a turn of its own. Claude Code holds it until the session is idle, so it never cuts into a turn, and frames it as `The <mod> plugin sent a message:`. With `as: Person`, the agent reads it bare, as the person's own words, while every hook still sees that the mod sent it. It rejects with `<mod>: Claude Code dropped the prompt: <reason>` when a plugin drops it.
  - `as: Session` sends it to another session as a message from this one, which Claude Code shows as one session writing to another.
  - To a task's owner, `send` delivers the text to that running subagent.
- `startTask` starts a task in the session, the way the Agent tool starts one, and resolves the `Task` once it started. It does not wait for the task to finish. `title` is the task's title, `agentType` names the owner's agent type, such as `Explore`, `name` is the address a teammate's `SendMessage` reaches it by, and `model` and `cwd` change what it runs on and where. It needs the `tasks` permission, and rejects with `<mod>: Claude Code refused the task: <reason>` when a hook refuses it.
- `callTool` runs a tool in the session, such as `{ name: 'Bash', input: { command: 'bun test' } }`, and resolves its `ToolResult`. It needs the `tools` permission.
- `usage` answers the session's model, its context window's fill, and its cost so far, as the status line shows them: `{ model, contextWindow: { tokenCount?, size?, percent? }, cost?: { usd } }`. For an ended session and a task's owner it answers the model and the tokens of its last reply, from its transcript.
- `surfaces` answers the Claude apps showing the session now: `'terminal'`, `'desktop'`, `'mobile'`, and `'vscode'`. An ended session shows in none.

A task's owner is a `TaskOwner`, a session without `startTask` and `callTool`, because Claude Code gives a subagent no way to start a task or run a tool from outside. It takes `send`, `usage`, and `surfaces`. An action on a session that has ended rejects with `session <id> has ended`, and `send` with `<mod>: session <id> has ended, so it takes no messages.`

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
      if (answer?.type === Reply) mod.ui.toast(answer.text)
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
}
```

- `id` names the transcript row the message is in. When one row holds several messages, such as a reply with its tool calls, each `id` ends in `:<n>`. `mod.ui.scroll({ to: { requestId: message.id.split(':')[0] } })` scrolls to the message's row ([ui.md](ui.md#scrolling)).
- `at` is its ISO time. `session` is the session's id, and `context` the number of the context it is in, from 1.
- `turn` is the `id` of the prompt that opened its turn. A task's message names its owner's turn. A message before the first prompt has none.
- `task` is the id of the task whose message it is. A message of the session itself has none.

| Type | Constant | Its own fields |
| --- | --- | --- |
| `'prompt'` | `Prompt` | `text`, `from`: the prompt that opens a turn. A command Claude Code sends as a prompt reads as typed, such as `/review 12`. |
| `'note'` | `Note` | `text`, `from`: text Claude reads that is not a prompt, such as a mod's note or a task's notification. |
| `'reply'` | `Reply` | `text`: what Claude said. |
| `'toolCall'` | `ToolCall` | `callId`, `name`, `input`, `cwd`, `files`: a tool Claude called, the folder it called it in, and the files it reads and changes. |
| `'toolResult'` | `ToolResult` | `callId`, `name`, `input`, `cwd`, `files`, `output`, `isError`: the call's tool, input, folder, and files, and what the tool answered. `output` is the text Claude read, or the tool's own result for `callTool`. |
| `'skill'` | `Skill` | `name`, `text`: a Skill Claude Code loaded. |
| `'instructionFile'` | `InstructionFile` | `path`, `text`, `isRule`: a `CLAUDE.md` file or a rule file Claude Code read. `isRule` is true for a file in a `.claude/rules/` folder. |
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
  messages(): Promise<Message[]>
  abort(): Promise<void>
  search; on…; before…
}

type Context = { readonly number: number; readonly openedAt: string; readonly closedAt?: string; turns(): Promise<Turn[]>; search; on…; before… }

type Goal = { text(): Promise<string>; tasks(): Promise<Task[]>; search; on…; before…; update(change: { text: string }): Promise<void> }

type Task = {
  readonly id: string
  readonly title: string
  readonly owner: TaskOwner
  readonly openedBy: string
  readonly openedAt: string
  readonly closedAt?: string
  tasks(): Promise<Task[]>
  messages(): Promise<Message[]>
  search; on…; before…
}
```

- A turn's `closedAt` is set once the agent stops. A turn still running has none.
- The turn `onTurnEnd` hears carries why it ended. `reason` is `'answer'` when Claude finished, with its last words in `answer`, and `'error'` when a request failed, with `failure` naming the error's `type`, such as `'rate_limit'`, and its `text`. A turn a mod kept going with `beforeTurnEnd` ends only at the stop that nothing refuses. A turn read later through `turns()` has `closedAt` and none of these.

```ts
sessions.current.onTurnEnd((turn) => {
  if (turn.failure !== undefined) mod.ui.toast.error(`Claude stopped: ${turn.failure.text}`)
})
```
- `abort()` stops a turn while it runs, a task's turn included, and needs the `prompt` permission. It throws on a turn that has ended. Claude Code shows no marker, so a mod that aborts tells the person with a toast.
- A context's `number` counts from 1. Its `closedAt` is set at the compaction that ended it.
- A goal's text starts as the session's first prompt, and `text()` reads it. `update` replaces it, and `onGoalChange` hears the goal, whose `text()` reads the new text.
- A task's `owner` is a `TaskOwner`: the session doing the work, which can't start tasks or call tools. Its goal is the task's prompt, its `agentType` and `model` are what the task runs, and its turns and messages are the task's own. Claude Code's checklist tools, `TaskCreate`, `TaskUpdate`, and `TaskList`, are not tasks: they are its todo list, which `onTodoCreate` and `onTodoComplete` hear.
- A task's `openedBy` is the `callId` of the Agent call that started it, and empty for a task a mod started. Its `closedAt` is set once it answered.

## Test it

`testMod` fakes the conversation: `tested.add`, `tested.endTurn`, `tested.compact`, and `tested.startTask` build the current session, and the `sessions` option gives the earlier ones ([testing.md](testing.md#build-a-conversation)).
