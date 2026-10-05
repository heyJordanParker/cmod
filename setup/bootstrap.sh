#!/bin/sh
set -eu

fail() {
  echo "cmod bootstrap: $1" >&2
  exit 1
}

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$root/.claude-plugin/plugin.json")
[ -n "$version" ] || fail "$root/.claude-plugin/plugin.json names no version"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "cmod has no build for $(uname -s). Build it from https://github.com/heyJordanParker/cmod/tree/main/cli" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "cmod has no build for $(uname -m). Build it from https://github.com/heyJordanParker/cmod/tree/main/cli" ;;
esac

release="${CMOD_DIST_SERVER:-https://github.com/heyJordanParker/cmod/releases/download}/v$version"
build="cmod-$os-$arch"
store="${XDG_DATA_HOME:-$HOME/.local/share}/cmod/bin/cmod"
folder="$store/$version"
bin="$HOME/.local/bin"
partial="$folder/.cmod.$$"
sums="$folder/.SHA256SUMS.$$"
link="$bin/.cmod.$$"
trap 'rm -f "$partial" "$sums" "$link"' EXIT
trap 'exit 1' HUP INT TERM

if [ -e "$bin/cmod" ] || [ -L "$bin/cmod" ]; then
  case "$(readlink "$bin/cmod" || true)" in
    "$store"/*) ;;
    *) fail "$bin/cmod exists and CMod did not make it, so CMod will not replace it. Move it out of $bin, then restart Claude Code." ;;
  esac
fi
found=$(command -v cmod || true)
case "$found" in
  "" | "$bin/cmod") ;;
  *) fail "PATH already finds cmod at $found, so the cmod CMod installs would never run. Remove that cmod from PATH, then restart Claude Code." ;;
esac

echo "progress 0 3 Downloading cmod $version"
mkdir -p "$folder" "$bin"
curl -fsL -o "$sums" "$release/SHA256SUMS" || fail "could not fetch $release/SHA256SUMS (curl exit $?)"
curl -fsL -o "$partial" "$release/$build" || fail "could not fetch $release/$build (curl exit $?)"
expected=$(sed -n "s/^\([0-9a-f]\{64\}\) [ *]$build\$/\1/p" "$sums")
[ -n "$expected" ] || fail "$release/SHA256SUMS lists no $build, so the download cannot be checked"
actual=$( (sha256sum "$partial" 2>/dev/null || shasum -a 256 "$partial") | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] || fail "$release/$build has SHA-256 $actual, but SHA256SUMS lists $expected, so nothing was installed"
chmod +x "$partial"

echo "progress 1 3 Checking cmod $version"
reported=$("$partial" --version) || fail "$release/$build downloaded, but running it with --version failed"
[ "$reported" = "$version" ] || fail "$release/$build reports version $reported, not $version"
mv -f "$partial" "$folder/cmod"

echo "progress 2 3 Linking $bin/cmod"
ln -s "$folder/cmod" "$link"
mv -f "$link" "$bin/cmod"
found=$(command -v cmod || true)
[ "$found" = "$bin/cmod" ] || fail "cmod is installed at $bin/cmod, but PATH finds ${found:-no cmod}. Put $bin first on PATH, then restart Claude Code."

echo "progress 3 3 cmod $version is installed"
