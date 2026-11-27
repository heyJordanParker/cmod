---
name: sessions
description: Talk to and drive other Claude Code sessions on any of the person's devices with the cmod command. Find one, message it, start or fork a background session on a task, stop its turn, end it, compact it, delete it, or answer a dialog in its terminal. TRIGGER when work needs another session, such as handing off a task, asking a running session something, checking on a worker, or answering a session that waits on a permission dialog. DO NOT TRIGGER to search or read what past sessions did; use /cmod:search-history.
allowed-tools: Bash(cmod sessions:*), Bash(cmod terminal:*), Bash(cmod run:*)
---

# Sessions

- Every Claude Code session the person runs, on this computer and on each device cmod reaches, is one `cmod sessions` command away. cmod serve carries each command to the session's own cmod plugin, wherever it runs.
- A session id is what `cmod sessions list` prints. Inside Claude Code, `CLAUDE_CODE_SESSION_ID` names this session, and a command that names no session takes it.

## 1. Find the session

Run `cmod sessions list --running` for every session that runs now, in every project, or `cmod sessions list --every-project` for every saved one. Each line names the session's id, title, the session it forked from, whether it runs or waits on a dialog, and its device. A session id from a file or a message is the address: use it as it is.
Example: `cmod sessions list --running`

## 2. Message it

`cmod sessions send <session> "<text>"` sends a prompt, which the session answers as its next turn, and prints `Sent message <id>`, with the start of the id and the title of the session it reached. Check that line names the session you meant. The message reaches the session as soon as no turn runs there, or once it is resumed, so send it once. `--note` sends a note it reads with its next prompt instead, for a fact it should know without a turn of its own. A session that ended resumes on the prompt. A `<session>` is the full id or any start of it no other session shares. `cmod sessions read mail <session>` lists its mail with each one's state.

### Answer a `<cmod-message>` with the command its `reply` names
A message another session sent arrives inside `<cmod-message from="<id>" title="<title>" reply="…">`.
Example: `cmod sessions send 4b1e9c2a --reply-to 12 "The fix is in a3f2c1."`

### Write the message so the session can act on it alone
The other session sees none of this conversation. Say what you need, why, and what to send back.
Example: `cmod sessions send 4b1e… "The parser tests fail on main since a3f2c1. Find the cause, fix it, and send me the commit."`

## 3. Start work in a background session

`cmod sessions start "<prompt>" --title "<a few words>"` starts a background session on a task, owned by this session, which hears when it ends. `--agent-type`, `--model`, `--cwd`, and `--device` pick its agent, model, folder, and device. `cmod sessions fork "<prompt>" --title "<title>"` starts one on a copy of this conversation instead, or of `--session <id>`'s, whole or through the message `--at <id>` names. A fork belongs to the session it copies.

### Give a fresh session the whole task in its prompt
A started session knows nothing of this conversation. A fork knows the conversation it copies, so its prompt names only the new task.

## 4. Drive it

Each command acts on the session's own cmod plugin:
- `cmod sessions stop <session>` stops its running turn, as Esc does
- `cmod sessions end <session>` ends its Claude Code now between turns, or once its turn ends, says which, and keeps its conversation
- `cmod sessions compact [<session>] --keep "<what the summary keeps>"` compacts it once its turn ends, then prompts it to carry on
- `cmod sessions delete <session>` deletes a session that ended

## 5. Answer a dialog in its terminal

A session that waits on a dialog lists as `waiting for <dialog>`. `cmod terminal screen <session>` prints its screen, `cmod terminal press <session> "1\r"` types keys into it, where `\r` is Enter and `\e` is Esc, and `cmod terminal show <session>` shows it in a pane of the app that runs it. A session `claude --bg` started has no terminal.

### Read the screen before you press
Read the dialog with `cmod terminal screen`, decide as the person would, then press.

## 6. Automate with a script

A TypeScript script that imports `sessions` from `@cmodjs/core/mod.js` reads and acts on any session, as a mod does. Run it with `cmod run <file> [arguments…]`. It hears no session, so its `on` and `before` methods throw, and it ends once its top level has run.
Example:
  import { Prompt, sessions } from '@cmodjs/core/mod.js'
  const worker = await sessions.get(Bun.argv[2])
  const [last] = await worker.messages({ last: 1 })
  if (last?.type === 'reply' && last.text.includes('tests fail')) await worker.send({ type: Prompt, text: 'Fix the failing tests.' })
