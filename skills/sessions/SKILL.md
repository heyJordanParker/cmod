---
name: sessions
description: Talk to and drive other Claude Code sessions on any of the person's devices with the cmod command. Find one, message it, start or fork a background session on a task, stop its turn, end it, compact it, delete it, or answer a dialog in its terminal. TRIGGER when work needs another session, such as handing off a task, asking a running session something, checking on a worker, or answering a session that waits on a permission dialog. DO NOT TRIGGER to search or read what past sessions did; use /cmod:history.
allowed-tools: Bash(cmod sessions:*), Bash(cmod terminal:*), Bash(cmod run:*)
---

# Sessions

- Every Claude Code session the person runs, on this computer and on each device cmod reaches, is one `cmod sessions` command away. cmod serve carries each command to the session's own cmod plugin, wherever it runs.
- A session id is what `cmod sessions list` prints. Inside Claude Code, `CLAUDE_CODE_SESSION_ID` names this session, and a command that names no session takes it.

## 1. Find the session

Run `cmod sessions list`, with `--every-project` for every project and `--running` for the sessions that run now. Each line names the session's title, whether it runs or waits on a dialog, and its device.
Example: `cmod sessions list --every-project --running`

## 2. Message it

`cmod sessions send <session> "<text>"` sends a prompt, which the session answers as its next turn, from this session, so it knows who sent it. `--note` sends a note it reads with its next prompt instead, for a fact it should know without a turn of its own. A session that ended resumes on the prompt.

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
- `cmod sessions end <session>` ends its Claude Code once its turn ends, and keeps its conversation
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
