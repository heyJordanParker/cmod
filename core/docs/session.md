# Sessions

`sessions` reads and follows Claude Code's conversations: the one the mod runs in, every other one Claude Code saved, and a search across them. A mod never parses a transcript.

```ts
import { Prompt, sessions } from '../node_modules/@cmodjs/core/mod.js'

const prompts = (await sessions.current.messages()).filter((message) => message.type === Prompt)
```

Reading a conversation needs the `conversation` permission, sending to one needs `prompt`, and starting a task needs `tasks` ([permissions.md](permissions.md)).

## The shape of a conversation

A session is one conversation. It runs as a series of contexts: a compaction or `/compact` ends one context and starts the next with a summary of the last. Each context holds turns: a turn starts at a prompt and ends when Claude stops. Each turn holds the messages Claude and the people and programs around it exchanged. The session's goal is what the conversation is for, and its tasks are the subagents Claude or a mod started to work beside it.

```
Session
├── Goal               what the session is for
│   └── Task           a subagent working beside Claude
│       ├── Message    its own messages
│       └── Task       a task it started
└── Context            from the start, or a compaction, to the next compaction
    └── Turn           from a prompt to the end of Claude's answer
        └── Message    a prompt, a reply, a tool call, and the rest
```

## sessions

```ts
type Sessions = {
  readonly current: Session
  list(options?: { running?: boolean; since?: string; everyProject?: boolean }): Promise<Session[]>
  search(text: string, options?: { running?: boolean; since?: string; everyProject?: boolean; limit?: number; before?: Message }): Promise<Message[]>
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

While a mod holds the `conversation` permission, the cmod plugin indexes every conversation in the background at each session's start, so `search` waits only for what changed since. The `cmod history` command answers the same questions in a terminal ([commands.md](commands.md#cmod-history)).

## Session

```ts
type Session = {
  readonly id: string
  readonly title: string
  readonly project: string
  readonly cwd: string
  readonly model: string
  readonly startedAt: string
  readonly lastAt: string
  readonly forkedFrom?: string
  readonly isRunning: boolean
  usage(): Promise<Usage>
  on(event, listener): Disposable
  on(event, matcher, listener): Disposable
  send(message: { type: Prompt | Note; text: string; as?: Person | Session }): Promise<void>
  startTask(task: { prompt: string; agentType?: string; model?: string; name?: string; cwd?: string }): Promise<Task>
  messages(options?: { after?: string; last?: number }): Promise<Message[]>
  turns(options?: { last?: number }): Promise<Turn[]>
  contexts(): Promise<Context[]>
  goal(): Promise<Goal>
}
```

- `id` is Claude Code's session id. `title` is the name the person gave it with `/rename`, or the first line of its first prompt. A resumed or forked session with no name, and a session the mod started in after its first prompt, has an empty `sessions.current.title` until `sessions.list()` reads it.
- `project` is the project the session works in, and `cwd` is its working folder. For the current session both follow `/cd`, and `cwd` follows a `cd` in a Bash or PowerShell call.
- `model` is the model the session runs on. `startedAt` and `lastAt` are ISO times.
- `forkedFrom` names the session a `/branch` or a fork copied it from.
- `isRunning` is true while the session is open in a Claude Code window.
- `usage` answers the current session's model, its context window's fill, and its cost so far, as the status line shows them: `{ model, context: { tokens?, window, percent? }, cost?: { usd } }`.

### Read a conversation

- `messages` answers the session's messages in order, those of its tasks left out. `last` keeps that many from the end, and `after` starts after a message's `id`.
- `turns` answers its turns in order, `last` keeping that many from the end. A turn's `messages()` answers its own.
- `contexts` answers its contexts in order. A context's `turns()` answers its own.
- `goal` answers its goal. The goal's `tasks()` answers the tasks Claude or a mod started, and each task's `messages()` and `tasks()` answer its own.

```ts
const [last] = await sessions.current.turns({ last: 1 })
const calls = (await last?.messages() ?? []).filter((message) => message.type === ToolCall)
```

### Listen to a conversation

```ts
session.on(event: SessionEvent, listener: (payload) => unknown): Disposable
session.on(event: SessionEvent, matcher: Matcher<payload>, listener: (payload) => unknown): Disposable
```

`on` runs `listener` for each new message, turn, context, task, or goal change of that session, as it happens. The current session's arrive as Claude Code writes them, and another running session's within a moment.

| Event | The listener gets |
| --- | --- |
| `Message` | Every new message. |
| `Prompt`, `Note`, `Reply`, `ToolCall`, `ToolResult`, `Skill`, `Document`, `Notice` | Each new message of that type. |
| `TurnStart`, `TurnEnd` | The `Turn` that started or ended. |
| `ContextStart`, `ContextEnd` | The `Context` that started or ended. |
| `TaskStart`, `TaskEnd` | The `Task` that started or ended. |
| `GoalChange` | The `Goal` with its new text. |

A matcher keeps the payloads it matches. It is a partial copy of the payload: a key it names must match, and a key it leaves out matches anything. A string matches the same string, a `RegExp` matches the text it tests true on, and a list matches any one of its items.

```ts
import { Reply, sessions, ToolCall } from '../node_modules/@cmodjs/core/mod.js'

sessions.current.on(ToolCall, { name: /^(Edit|Write)$/ }, (call) => void (mod.state.session.edits += 1))
sessions.current.on(Reply, (reply) => mod.log(`Claude said ${reply.text.length} characters`))
```

A listener that throws shows the error toast `The <event> listener failed`. `dispose()` on the `Disposable` stops the listener.

### Send to a conversation

`send` adds a message to the session, and needs the `prompt` permission.

- A `Note` to the current session is text Claude reads on its next call to the model and the person does not see. It starts no turn. It rejects with `<mod>: Claude Code refused the note: <reason>` when a plugin refuses it.
- A `Prompt` to the current session is the next prompt, so Claude answers it as a turn of its own. Claude Code holds it until the session is idle, so it never cuts into a turn, and frames it as `The <mod> plugin sent a message:`. With `as: Person`, Claude reads it bare, as the person's own words, while every hook still sees that the mod sent it. It rejects with `<mod>: Claude Code dropped the prompt: <reason>` when a plugin drops it.
- To another running session, cmod delivers the message, and that session's cmod adds it the same way. `as: Session` sends it as a message from this session instead, which Claude Code shows as one session writing to another.
- A session that has ended takes no messages, and `send` rejects with `<mod>: session <id> has ended, so it takes no messages.`

A prompt that comes on a clock, such as every 10 minutes, belongs in a `schedule` job instead, which Claude Code shows as one `Running scheduled task` row ([jobs.md](jobs.md#schedule)).

```ts
mod.every(60_000, async () => {
  const { stdout } = await process.run(['gh', 'run', 'list', '--limit', '1', '--json', 'conclusion'])
  if (JSON.parse(stdout)[0]?.conclusion !== 'failure') return
  await sessions.current.send({ type: Note, text: 'CI failed on the last push.' })
  await sessions.current.send({ type: Prompt, text: 'Find the cause of the CI failure and fix it.' })
})
```

### Start a task

`startTask` starts a subagent in the current session, the way Claude's Agent tool starts one, and resolves the `Task` once it started. It does not wait for the task to finish. `agentType` names an agent type, such as `explorer`, `name` titles the task, and `model` and `cwd` change what it runs on and where. It rejects with `<mod>: Claude Code refused the task: <reason>` when a hook refuses it, and on any session other than the current one.

The task's answer arrives once it finishes, on a `TaskEnd` listener or the mod's `SubagentStop` hook, whose `agent_id` is the task's `id`:

```ts
const answers = new Map<string, (answer: string) => void>()

mod.on(SubagentStop, (input) => answers.get(input.agent_id)?.(input.last_assistant_message ?? ''))

mod.on(UserPromptSubmit, { prompt: /^\/summarize/ }, async () => {
  const task = await sessions.current.startTask({ prompt: 'Summarize README.md in one line.', agentType: 'Explore', name: 'Summarize the README' })
  const summary = await new Promise<string>((resolve) => answers.set(task.id, resolve))
  return { hookSpecificOutput: { hookEventName: UserPromptSubmit, additionalContext: summary } }
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
- `turn` is the `id` of the prompt that opened its turn. A message before the first prompt, and a task's message, has none.
- `task` is the id of the task whose message it is. A message of the session itself has none.

| Type | Constant | Its own fields |
| --- | --- | --- |
| `'prompt'` | `Prompt` | `text`, `from`: the prompt that opens a turn. A slash command reads as the command typed, such as `/review 12`. |
| `'note'` | `Note` | `text`, `from`: text Claude reads that is not a prompt, such as a mod's note or a task's notification. |
| `'reply'` | `Reply` | `text`: what Claude said. |
| `'toolCall'` | `ToolCall` | `callId`, `name`, `input`, `cwd`: a tool Claude called, and the folder it called it in. |
| `'toolResult'` | `ToolResult` | `callId`, `text`, `isError`: what the tool answered. |
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
type Turn = { readonly prompt: Prompt; readonly context: number; readonly openedAt: string; readonly closedAt?: string; messages(): Promise<Message[]> }

type Context = { readonly number: number; readonly openedAt: string; readonly closedAt?: string; turns(): Promise<Turn[]> }

type Goal = { readonly text: string; update(change: { text: string }): Promise<void>; tasks(): Promise<Task[]> }

type Task = {
  readonly id: string
  readonly title: string
  readonly agentType: string
  readonly model?: string
  readonly openedBy: string
  readonly openedAt: string
  readonly closedAt?: string
  messages(): Promise<Message[]>
  tasks(): Promise<Task[]>
}
```

- A turn's `closedAt` is set once Claude stops. A turn still running has none.
- A context's `number` counts from 1. Its `closedAt` is set at the compaction that ended it.
- A goal's `text` starts as the session's first prompt. `update` replaces it, and a `GoalChange` listener on the current session hears the new text.
- A task's `openedBy` is the `callId` of the Agent call that started it, and empty for a task a mod started. Its `closedAt` is set once it answered.

## Test it

`testMod` fakes the conversation: `tested.add`, `tested.endTurn`, `tested.compact`, and `tested.startTask` build the current session, and the `sessions` option gives the earlier ones ([testing.md](testing.md#build-a-conversation)).
