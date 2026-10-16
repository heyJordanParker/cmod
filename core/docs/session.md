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
  readonly current: Session
  list(options?: { running?: boolean; since?: string; everyProject?: boolean }): Promise<Session[]>
  search(text: string, options?: { running?: boolean; since?: string; everyProject?: boolean; limit?: number; before?: Message }): Promise<Message[]>
  onMessage(matcher?, listener): Disposable   // and every on method below
}
```

- `current` is the session the mod runs in. It is there from `setup` on, and follows `/clear`, `/resume`, a fork, `/cd`, and a `cd` in a Bash or PowerShell call.
- `list` lists the project's sessions, the most recent first. `everyProject` lists every project's, `running` keeps the sessions still open in a Claude Code window, and `since` keeps those active since a time, written as `30m`, `6h`, `2d`, `1w`, or a date such as `2026-10-01`.
- `search` answers the newest 50 messages whose text contains `text`, any case, in the project's sessions or, with `everyProject`, every project's. `text` is at least 3 characters. `limit` changes the 50, and `before` takes the last message of a page to answer the page after it. A tool call is searched by its name and the first 1,024 characters of each input value, a document by its path and text, and a tool result is not searched.

```ts
const earlier = await sessions.search('deploy job', { since: '1w' })
const last = earlier.at(-1)
const older = last === undefined ? [] : await sessions.search('deploy job', { since: '1w', before: last })
```

- Its `on` methods hear every running session of the project, this one included ([Listen](#listen-to-a-record)). `sessions` has no `before` methods. To change what happens in another session, call a `before` method on that session ([Change what happens](#change-what-happens)).

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
  goal(): Promise<Goal>
  context(): Promise<Context>
  contexts(): Promise<Context[]>
  turn(): Promise<Turn | undefined>
  turns(options?: { last?: number }): Promise<Turn[]>
  messages(options?: { after?: string; last?: number }): Promise<Message[]>
  search(text: string, options?: { limit?: number; before?: Message }): Promise<Message[]>
  onMessage(matcher?, listener): Disposable         // and every on method below
  beforePrompt(matcher?, listener): Disposable      // and every before method below
  send(message: { type: Prompt | Note; text: string; as?: Person | Session }): Promise<void>
  startTask(task: { prompt: string; agentType?: string; model?: string; name?: string; cwd?: string }): Promise<Task>
  callTool(call: { name: string; input: Record<string, unknown> }): Promise<ToolResult>
  usage(): Promise<Usage>
  clients(): Promise<Client[]>
}
```

- `id` is Claude Code's session id, and a task owner's `id` is its task's id. `title` is the name the person gave it with `/rename`, or the first line of its first prompt. A resumed or forked session with no name, and a session the mod started in after its first prompt, has an empty `sessions.current.title` until `sessions.list()` reads it.
- `project` is the project the session works in, and `cwd` is its working folder. For the current session both follow `/cd`, and `cwd` follows a `cd` in a Bash or PowerShell call.
- `agentType` is the agent definition the session runs, such as `Explore` for a task's owner, or the agent a session started with `claude --agent` runs. A plain session has none.
- `model` is the model the session runs on. `startedAt` and `lastAt` are ISO times.
- `forkedFrom` names the session a `/branch` or a fork copied it from.
- `isRunning` is true while the session is open in a Claude Code window, and for a task's owner while its task runs.

### Read a record

- `goal` answers its goal. The goal's `tasks()` answers the tasks the session handed on, and each task's `owner` reads like any session.
- `context` answers the context it is in now, and `contexts` all of them in order. A context's `turns()` answers its own.
- `turn` answers the turn running now, and nothing between turns. `turns` answers its turns in order, `last` keeping that many from the end. A turn's `messages()` answers its own.
- `messages` answers its messages in order, those of its tasks left out. `last` keeps that many from the end, and `after` starts after a message's `id`.
- `search` finds its messages whose text contains `text`, newest first, the way `sessions.search` does. A goal's, a task's, a context's, and a turn's `search` find only their own.

```ts
const [last] = await sessions.current.turns({ last: 1 })
const calls = (await last?.messages() ?? []).filter((message) => message.type === ToolCall)
const explorers = (await (await sessions.current.goal()).tasks()).filter((task) => task.owner.agentType === 'Explore')
```

A session that has ended keeps its record, so every read works on it.

### Listen to a record

```ts
part.on<Event>(listener: (payload) => unknown): Disposable
part.on<Event>(matcher: Matcher<payload>, listener: (payload) => unknown): Disposable
```

Each event has its own method, such as `onReply` or `onTaskStart`, which runs `listener` for each new message, turn, context, task, goal change, or usage change, as it happens. `sessions`, a session, its goal, a task, a context, and a turn each have every `on` method, and each hears what happens inside it: an event reaches the part it happens in and every part above it.

A session is one agent: the conversation's main agent, or the agent doing a task. An event runs up one chain:

```
Turn ──> Context ──> Session ──> that session's Task ──> each Task above ──> Goal ──> sessions
```

The goal belongs to the main agent, so the main agent's events reach it too. So:
- `sessions.current.onToolCall(…)` hears the main agent's tool calls only.
- `(await sessions.current.goal()).onToolCall(…)` hears every agent's in the session.
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

A listener that throws shows the error toast `The <event> listener failed`. `dispose()` on the `Disposable` stops the listener.

### Change what happens

```ts
part.before<Event>(listener: (payload) => Answer | void): Disposable
part.before<Event>(matcher: Matcher<payload>, listener: (payload) => Answer | void): Disposable
```

Each `before` method, such as `beforeToolCall`, runs `listener` just before something happens, and its answer changes or refuses it. Returning nothing lets it happen as it was. Each part except `sessions` has every `before` method, and hears what is about to happen inside it, the way `on` methods do.

| Method | The listener can answer | Covers |
| --- | --- | --- |
| `beforePrompt` | `{ text?, note?, title? }` or `{ refuse }` | A typed prompt, a mod's prompt, a slash command, and a message from another session. `note` reaches Claude beside a typed or a mod's prompt, and `title` names the session |
| `beforeNote` | `{ text }` | A note any mod or Claude Code adds |
| `beforeSkill` | `{ text }` | A Skill as Claude Code loads it |
| `beforeInstructionFile` | `{ text }` or `{ refuse }` | A `CLAUDE.md` file as Claude Code reads it. `refuse` leaves it out |
| `beforeReply`, `beforeNotice` | `{ text }` | The text the transcript keeps |
| `beforeToolResult` | `{ output?, isError?, note? }` | The result Claude reads, after the tool ran. `output` replaces it, `note` adds text beside it, and `isError: true` makes Claude read it as a failure, with the note as the reason. A failed call takes only a note |
| `beforeToolCall` | `{ input }`, `{ result }`, or `{ refuse }` | A tool call. `result` answers it without running the tool |
| `beforeTaskStart` | `{ owner: { model } }` or `{ refuse }` | A task about to start, and the model its owner runs |
| `beforeTaskEnd` | `{ refuse }` | A task about to end. `refuse` sends its owner on with the reason |
| `beforeTurnEnd` | `{ refuse }` | The agent about to stop. `refuse` sends it on with the reason |
| `beforeContextEnd` | `{ refuse }` | A compaction about to start. `refuse` keeps the context |

```ts
sessions.current.beforeToolCall({ name: 'Bash', input: { command: /\brm -rf\b/ } }, () => ({ refuse: 'Delete files one at a time.' }))
sessions.current.beforeTaskStart({ owner: { agentType: 'Explore' } }, () => ({ owner: { model: 'haiku' } }))
sessions.current.beforeTurnEnd(async () => ((await testsPass()) ? undefined : { refuse: 'The tests fail. Fix them before you stop.' }))
```

An answer that changes text needs the `prompt` permission, a `ToolCall` answer needs `tools`, and a `TaskStart` or `TaskEnd` answer needs `tasks`. Without it the answer changes nothing, and the toast `The before(<event>) listener failed` names the permission. When several listeners answer, each sees what the one before it changed, and the first `refuse` or `result` decides.

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
| `beforePermissionRequest`, `onPermissionRequest` | a permission dialog is about to show | `PermissionRequest`: `name`, `input`, `suggestions`, `mcpServer?` | `{ allow: true, input?, updates? }` or `{ refuse, interrupt? }` |
| `beforePermissionDenial`, `onPermissionDenial` | a tool call was denied | `PermissionDenial`: `name`, `input`, `callId`, `reason`, `mcpServer?` | `{ retry: true }` |
| `beforeToolBatch`, `onToolBatch` | a batch of tool calls finished | `ToolBatch`: `calls`, each `{ callId, name, input, output? }` | `{ note }` |
| `beforeTodoCreate`, `onTodoCreate`, `beforeTodoComplete`, `onTodoComplete` | a todo is added to or ticked on the checklist | `Todo`: `id`, `subject`, `description?`, `teammate?` | `{ refuse }` |
| `beforeReplyDisplay`, `onReplyDisplay` | a reply is about to show | `ReplyDisplay`: `replyId`, `index`, `isLast`, `text` | `{ text }`, what the person sees |

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
- `startTask` starts a task in the session, the way the Agent tool starts one, and resolves the `Task` once it started. It does not wait for the task to finish. `agentType` names the owner's agent type, such as `Explore`, `name` titles the task, and `model` and `cwd` change what it runs on and where. It needs the `tasks` permission, and rejects with `<mod>: Claude Code refused the task: <reason>` when a hook refuses it.
- `callTool` runs a tool in the session, such as `{ name: 'Bash', input: { command: 'bun test' } }`, and resolves its `ToolResult`. It needs the `tools` permission.
- `usage` answers the session's model, its context window's fill, and its cost so far, as the status line shows them: `{ model, context: { tokens?, window?, percent? }, cost?: { usd } }`. For an ended session and a task's owner it answers the model and the tokens of its last reply, from its transcript.
- `clients` answers the Claude apps showing the session now: `'terminal'`, `'desktop'`, `'mobile'`, and `'vscode'`. An ended session shows in none.

A task's owner is a `TaskOwner`, a session without `startTask` and `callTool`, because Claude Code gives a subagent no way to start a task or run a tool from outside. It takes `send`, `usage`, and `clients`. An action on a session that has ended rejects with `session <id> has ended`, and `send` with `<mod>: session <id> has ended, so it takes no messages.`

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
mod.on(UserPromptSubmit, { prompt: /^\/summarize/ }, async () => {
  const task = await sessions.current.startTask({ prompt: 'Summarize README.md in one line.', agentType: 'Explore', name: 'Summarize the README' })
  const ended = await new Promise<Task>((resolve) => task.onTaskEnd(resolve))
  const [answer] = await ended.owner.messages({ last: 1 })
  return { hookSpecificOutput: { hookEventName: UserPromptSubmit, additionalContext: answer?.type === Reply ? answer.text : '' } }
})
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
| `'prompt'` | `Prompt` | `text`, `from`: the prompt that opens a turn. A slash command reads as the command typed, such as `/review 12`. |
| `'note'` | `Note` | `text`, `from`: text Claude reads that is not a prompt, such as a mod's note or a task's notification. |
| `'reply'` | `Reply` | `text`: what Claude said. |
| `'toolCall'` | `ToolCall` | `callId`, `name`, `input`, `cwd`, `files`: a tool Claude called, the folder it called it in, and the files it reads and changes. |
| `'toolResult'` | `ToolResult` | `callId`, `name`, `input`, `cwd`, `files`, `output`, `isError`: the call's tool, input, folder, and files, and what the tool answered. `output` is the text Claude read, or the tool's own result for `callTool`. |

`files` is `{ read, changed }`, each a list of absolute paths. cmod reads them from the call's input, a Bash command line included, and `read` lists only paths that are files.
| `'skill'` | `Skill` | `name`, `text`: a Skill Claude Code loaded. |
| `'document'` | `Document` | `path`, `text`: a `CLAUDE.md` file Claude Code read for a folder. |
| `'notice'` | `Notice` | `text`: a line Claude Code added, such as a model switch. |

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

## Turn, Context, Goal, and Task

```ts
type Turn = { readonly prompt: Prompt; readonly context: number; readonly openedAt: string; readonly closedAt?: string; messages(): Promise<Message[]>; search; on; before }

type Context = { readonly number: number; readonly openedAt: string; readonly closedAt?: string; turns(): Promise<Turn[]>; search; on; before }

type Goal = { readonly text: string; tasks(): Promise<Task[]>; search; on; before; update(change: { text: string }): Promise<void> }

type Task = {
  readonly id: string
  readonly title: string
  readonly owner: Session
  readonly openedBy: string
  readonly openedAt: string
  readonly closedAt?: string
  tasks(): Promise<Task[]>
  messages(): Promise<Message[]>
  search; on; before
}
```

- A turn's `closedAt` is set once the agent stops. A turn still running has none.
- A context's `number` counts from 1. Its `closedAt` is set at the compaction that ended it.
- A goal's `text` starts as the session's first prompt. `update` replaces it, and a `GoalChange` listener hears the new text.
- A task's `owner` is the session doing the work. Its goal is the task's prompt, its `agentType` and `model` are what the task runs, and its turns and messages are the task's own. Claude Code's checklist tools, `TaskCreate`, `TaskUpdate`, and `TaskList`, are not tasks: they are its todo list, which the `TodoCreated` and `TodoCompleted` hooks hear ([hooks.md](hooks.md)).
- A task's `openedBy` is the `callId` of the Agent call that started it, and empty for a task a mod started. Its `closedAt` is set once it answered.

## Test it

`testMod` fakes the conversation: `tested.add`, `tested.endTurn`, `tested.compact`, and `tested.startTask` build the current session, and the `sessions` option gives the earlier ones ([testing.md](testing.md#build-a-conversation)).
