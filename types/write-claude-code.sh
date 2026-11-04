#!/bin/bash
set -euo pipefail

version=${1:?Usage: types/write-claude-code.sh <Claude Code version, or latest>}
root=$(cd "$(dirname "$0")/.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

npm install --prefix "$scratch" --no-save --no-package-lock --silent "@anthropic-ai/claude-code@$version"
claude="$scratch/node_modules/.bin/claude"
written=$("$claude" --version)
written=${written%% *}

rm -rf "$root/.claude-plugin/types"
(
  cd "$root"
  env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
    CLAUDE_CONFIG_DIR="$scratch/config" \
    CLAUDE_CODE_PLUGIN_DIR_WATCH=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    ANTHROPIC_BASE_URL=http://127.0.0.1:9 \
    "$claude" --plugin-dir . -p ok > "$scratch/claude.log" 2>&1 || true
)

for types in claude-code claude-code-tools; do
  if [ ! -f "$root/.claude-plugin/types/$types/index.d.ts" ]; then
    cat "$scratch/claude.log" >&2
    echo "Claude Code $written wrote no .claude-plugin/types/$types/index.d.ts when it loaded $root." >&2
    exit 1
  fi
  mkdir -p "$root/types/$types"
  cp "$root/.claude-plugin/types/$types/index.d.ts" "$root/types/$types/index.d.ts"
done
echo "Wrote types/claude-code/ and types/claude-code-tools/ from Claude Code $written."
