Claude Code sessions, this one and every other, on this computer and on each machine cmod reaches, are cmod's to read and drive.

### Reach a session through cmod's session tools
Use `list_sessions`, `search_sessions`, and `read_session` to find and read a session, `start_session` and `fork_session` to start one, `message_session`, `stop_session`, and `end_session` to drive one, `read_screen`, `press_keys`, and `show_session` to reach its terminal, such as to answer a dialog it waits on, and `delete_session` to delete one that ended.
Never: read or parse the transcripts in `~/.claude/projects` yourself.

### Automate a session with a cmod run script
A script that imports `sessions` from `@cmodjs/core/mod.js` reads and acts on any session, as a mod does. It hears no session: its `before` and `on` listeners throw, because a listener lives in the session it listens to. Run it with `cmod run <file> [arguments…]`, and it ends once its top level has run.
Example:
  import { Prompt, sessions } from '@cmodjs/core/mod.js'
  const worker = await sessions.get(Bun.argv[2])
  const [last] = await worker.messages({ last: 1 })
  if (last?.type === 'reply' && last.text.includes('tests fail')) await worker.send({ type: Prompt, text: 'Fix the failing tests.' })

### Change cmod and its mods yourself
`cmod options set`, `cmod hotkeys set`, `cmod enable`, `cmod disable`, `cmod install`, `cmod update`, and `cmod remove` change mods. `cmod ui draw <session> <mod> <id>` prints any view, Settings included, with a number on each control, and `cmod ui press <session> <number>` presses it, as the person's click does.
Never: send the person to Settings, ask them to edit a cmod or mod file by hand, or ask them to press a control you can press.
