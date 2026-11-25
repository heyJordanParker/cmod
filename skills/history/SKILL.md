---
name: history
description: Search and read what Claude Code sessions did, on any of the person's devices, with cmod sessions search and read. Find where something was decided, built, or broken, read a session's messages, turns, tasks, goal, and usage, or follow a session live. TRIGGER when the work needs earlier work, such as "what did we decide about", "find the session that", "what did that worker do", or "when did this break". DO NOT TRIGGER to message or drive a session; use /cmod:sessions.
allowed-tools: Bash(cmod sessions:*)
---

# History

- cmod indexes every saved Claude Code conversation on each device, and `cmod sessions search` and `read` reach every device's index through cmod serve.
- A conversation is messages in turns, turns in contexts, a new context after each compaction, and tasks, the subagents and background sessions it started.

## 1. Search for the text

`cmod sessions search "<text>"` prints the newest 50 messages that hold the text, each with its time, session, message id, and the words around the match. `--every-project` searches every project, `--since 2d` the last two days, and `--running` the sessions that run now.

### Search the words the work would have used
A search matches text, at least 3 characters, in messages and in the first 1,024 characters of each tool input, never in tool results. Search for a file name, a command, or an error message, then widen the scope.
Example: `cmod sessions search "docker build -t" --every-project --since 1w`

### Page and narrow the search
`--limit <n>` changes the 50. `--before <session>:<id>` takes the last line of a page and prints the next. `--session <id>` searches one conversation, and inside it `--task`, `--turn`, `--context`, and `--agent` keep one part.

## 2. Read the session

`cmod sessions read messages <session>` prints its messages in order, each with its id. `--last <n>` keeps the newest, `--after <id>` starts after a message, `--turn <id>` keeps one turn, and `--task <id>` reads a task's own messages.

The other parts read the same way:
- `read turns`: each prompt and when Claude finished it
- `read contexts`: each context and the compaction that closed it
- `read tasks`: the tasks it started, with `--nested` at every depth
- `read goal`: what the session is for
- `read usage`: its model and the context's tokens

### Read the turns first
`read turns` shows the shape of a long session in a screen. Read the messages of the turn that matters.

## 3. Follow a session live

`cmod sessions follow <session>` prints each message and change as Claude Code saves it, until stopped, for a session on this computer. `--json` prints each as one line of JSON.

### Print JSON for a script
Every read takes `--json`, which prints the same data a mod reads.
