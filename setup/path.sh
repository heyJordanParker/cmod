#!/bin/sh
# Claude Code runs this on SessionStart. It puts cmod's programs folder first on
# PATH for Claude's Bash commands, so a mod's program runs by its name even
# when a system command has the same name.
set -eu
[ -n "${CLAUDE_ENV_FILE:-}" ] || exit 0
line="export PATH=\"${XDG_DATA_HOME:-$HOME/.local/share}/cmod/programs:\$PATH\""
grep -qxF "$line" "$CLAUDE_ENV_FILE" 2>/dev/null || printf '%s\n' "$line" >> "$CLAUDE_ENV_FILE"
