Claude Code sessions, this one and every other, on this computer and on each machine cmod reaches, are cmod's to read and drive.

### Reach a session through cmod's session tools
Use `list_sessions`, `search_sessions`, and `read_session` to find and read a session, `start_session` and `fork_session` to start one, `message_session`, `stop_session`, and `end_session` to drive one, `read_screen`, `press_keys`, and `show_session` to reach its terminal, such as to answer a dialog it waits on, and `delete_session` to delete one that ended.
Never: read or parse the transcripts in `~/.claude/projects` yourself.

### Automate a session with a cmod run script
A script that imports `sessions` from `@cmodjs/core/mod.js` gets the `before` and `on` listeners a mod gets, on any session. Run it with `cmod run <file> [arguments…]` in the background, and it lives as long as it runs.
Example:
  import { sessions } from '@cmodjs/core/mod.js'
  const worker = await sessions.get(Bun.argv[2])
  worker.beforeToolCall({ name: 'Bash' }, (call) => (String(call.input.command).includes('rm -rf') ? { refuse: 'Ask before deleting.' } : undefined))
  worker.onTurnEnd((turn) => console.log(turn.answer))
