#!/bin/sh
set -eu

fail() {
  echo "cmod bootstrap: $1" >&2
  exit 1
}

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$root/.claude-plugin/plugin.json")
[ -n "$version" ] || fail "$root/.claude-plugin/plugin.json names no version"

launcher="$root/node_modules/@cmodjs/cli/bin/cmod"
store="${XDG_DATA_HOME:-$HOME/.local/share}/cmod/bin/cmod"
bin="$HOME/.local/bin"
copy="$store/.cmod.$$"
link="$bin/.cmod.$$"
trap 'rm -f "$copy" "$link"' EXIT
trap 'exit 1' HUP INT TERM

[ -x "$launcher" ] || fail "$launcher is missing, so cmod cannot be installed. Reinstall the cmod plugin, then restart Claude Code."
if [ -e "$bin/cmod" ] || [ -L "$bin/cmod" ]; then
  case "$(readlink "$bin/cmod" || true)" in
    "$store"/*) ;;
    *) fail "$bin/cmod exists and cmod did not make it, so cmod will not replace it. Move it out of $bin, then restart Claude Code." ;;
  esac
fi

echo "progress 0 2 Downloading cmod $version"
"$launcher" --version > /dev/null || fail "$launcher could not install cmod $version"
[ -x "$store/$version/cmod" ] || fail "$launcher did not install cmod $version, the version of the cmod plugin. Reinstall the cmod plugin, then restart Claude Code."

echo "progress 1 2 Linking $bin/cmod"
mkdir -p "$bin"
cp "$launcher" "$copy"
mv -f "$copy" "$store/cmod"
ln -s "$store/cmod" "$link"
mv -f "$link" "$bin/cmod"
command -v cmod > /dev/null || fail "cmod is installed at $bin/cmod, but PATH finds no cmod. Put $bin on PATH, then restart Claude Code."

echo "progress 2 2 cmod $version is installed"
