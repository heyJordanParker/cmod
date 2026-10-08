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
programs="${XDG_DATA_HOME:-$HOME/.local/share}/cmod/programs"
bin="$HOME/.local/bin"
copy="$store/.cmod.$$"
link="$bin/.cmod.$$"
program="$programs/.cmod.$$"
trap 'rm -f "$copy" "$link" "$program"' EXIT
trap 'exit 1' HUP INT TERM

[ -x "$launcher" ] || fail "$launcher is missing, so cmod cannot be installed. Reinstall the cmod plugin, then restart Claude Code."

echo "progress 0 2 Downloading cmod $version"
"$launcher" --version > /dev/null || fail "$launcher could not install cmod $version"
[ -x "$store/$version/cmod" ] || fail "$launcher did not install cmod $version, the version of the cmod plugin. Reinstall the cmod plugin, then restart Claude Code."

echo "progress 1 2 Linking cmod"
mkdir -p "$programs"
cp "$launcher" "$copy"
mv -f "$copy" "$store/cmod"
ln -s "$store/cmod" "$program"
mv -f "$program" "$programs/cmod"
owner=cmod
if [ -e "$bin/cmod" ] || [ -L "$bin/cmod" ]; then
  case "$(readlink "$bin/cmod" || true)" in
    "$store"/*) ;;
    *) owner=other ;;
  esac
fi
if [ "$owner" = cmod ]; then
  mkdir -p "$bin"
  ln -s "$store/cmod" "$link"
  mv -f "$link" "$bin/cmod"
else
  echo "$bin/cmod is not cmod's, so a terminal runs that cmod. Claude Code runs $programs/cmod."
fi

echo "progress 2 2 cmod $version is installed"
