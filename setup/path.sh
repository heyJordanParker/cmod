#!/bin/sh
# Claude Code runs this on SessionStart. It puts cmod's programs folder first on
# PATH for Claude's Bash commands, so a mod's program runs by its name even
# when a system command has the same name.
set -eu
[ -n "${CLAUDE_ENV_FILE:-}" ] || exit 0
programs="${XDG_DATA_HOME:-$HOME/.local/share}/cmod/programs"
printf 'export PATH="%s:$PATH"\n' "$programs" >> "$CLAUDE_ENV_FILE"
