---
name: verify-live
description: Prove a CMod behavior in a real Claude Code session, because the test kit's fake Claude Code passes code that real Claude Code breaks. TRIGGER when a change depends on which events Claude Code fires and in what order, what it draws, what its validator accepts, or when it loads mods, and on "live run", "verify live", "run book", "prove it in Claude Code". DO NOT TRIGGER for logic the test kit runs whole, such as parsing, records, or state values; use /write-test.
---

# Verify Live

The test kit's fake Claude Code (`sdk/src/testing/fake-claude.ts`, driven by `testMod`) is a model of Claude Code, and the session is the truth. A behavior only a session shows is proven only in a session.

## 1. Name each claim only a session proves

List each claim of the change that depends on Claude Code itself: which events fire and in what order, what it draws, what its validator accepts, and when it loads mods. Tests prove the rest.

These Facts were observed in Claude Code 2.1.289. Under a newer `claude --version`, the run proves each one it relies on again.

- `/cd` fires the engine event `command.run` with `command: 'cd'`, and no classic hook. Its `next(e)` resolves after the move.
- `classic.CwdChanged` fires only after a Bash command changes the shell's folder, and only when a settings or `hooks.json` hook for `CwdChanged` or `FileChanged` exists, which a cmod mod never has. The SDK fires `CwdChanged` to a mod's own hooks from `followSession` in `sdk/src/runtime/lifecycle.ts`.
- A Bash `cd` moves the cwd, never `$.session.root()`.
- Claude Code fires `classic.SessionStart` before every mod's `setup` has finished, and gives each hook 10 seconds. The SDK holds it at most 9 seconds for a mod to start (`sessionStartHoldMs` in `sdk/src/runtime/lifecycle.ts`). A mod that starts later runs its SessionStart hooks then, and Claude Code never reads their answer.
- Elements built by Claude Code's `Box` are opaque: a render reads no `props` or `children` from them.
- The condensed `ToolGroup` row and the permission dialog draw from data no render changes.
- A hook cannot read `addMargin`.

## 2. Build the fixtures and an isolated home

Every fixture, home, log, and socket lives under a new `/private/tmp/<task-slug>/`. The real `~/.claude`, `~/.config`, and `~/.local` stay untouched.

- `127.0.0.1:8317` is the local model proxy, so `ANTHROPIC_API_KEY` takes a placeholder.
- Claude Code fetches its official plugin catalog over the network even with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- Each hook event a chain of mods handles logs a `hooks module <plugins> <event> settled in <ms>` line in the `--debug-file` log, and each call a mod makes logs a `$.<noun>.<method> (<mod>)` line.
- `CMOD_DIST_SERVER=file://<folder>` points the CMod bootstrap at a local release folder holding `v<version>/cmod-<os>-<arch>` and its `SHA256SUMS`.

### Start every `claude` command and every tmux server under `env -i`, on a socket only the run uses
tmux ignores `-e PATH`, and a tmux server hands its own environment to every session it starts, so the default tmux server leaks `XDG_CONFIG_HOME` and `NPM_TOKEN` into Claude Code. Start `claude` by its absolute path, so the real `~/.local/bin` stays off PATH and only the `cmod` the run installs answers.
Template:
    env -i HOME=<scratch>/home CLAUDE_CONFIG_DIR=<scratch>/home/.claude ANTHROPIC_BASE_URL=http://127.0.0.1:8317 ANTHROPIC_API_KEY=isolated-probe-placeholder CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CMOD_DIST_SERVER=file://<scratch>/releases PATH=<scratch>/home/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin TERM=xterm-256color LANG=en_US.UTF-8 tmux -S <scratch>/tmux.sock new-session -d -s <session> -x 200 -y 50 -c <project> '<absolute path of claude> --debug-file <scratch>/logs/debug-1.log'

### Install the mods from a local directory marketplace
Run `claude plugin marketplace add <scratch>/marketplace`, then `claude plugin install <mod>@<marketplace name>`, each behind the same `env -i` prefix without tmux. Each entry carries its own `node_modules`, installed from the packed SDK through /repack-sdk, and no `bun.lock`. Claude Code runs `bun install` against the npm registry for an entry that has a `bun.lock`. The CMod plugin's entry is a `git archive` of this checkout without `cli/`, which is what `cmod publish` releases.

## 3. Write the run book

Write it as `RUN.md` in the Task's Evidence folder, `docs/agents/<NNN>-<task-slug>/`. One step per claim, in order. Each command is one line, so no step depends on shell state.

Template:
    ## <N>. <the claim this step proves>

    ```bash
    <one command>
    ```

    Look at: <the `tmux -S <socket> capture-pane -p` output, the debug-log line, or the file>.
    Result: <the exact text or state expected>. Any other result is a difference: record it.

IF you work in build mode:
### Hand the run book to your dispatcher
The Harness refuses every `claude` command but `--version` and `--help` in build mode. Your dispatcher runs the book through the `cto` Agent, which runs sessions and writes no fixtures, so every fixture is built before you hand it over.

## 4. Run each step and keep its Evidence

Save each step's capture or matched debug-log line as `<NN>-<step>.txt` beside `RUN.md`. Before each `tmux -S <socket> send-keys`, capture the screen and check that the screen the step names is showing.

## 5. Correct the fake with every difference

IF the session contradicts the test kit's fake:
### Change the fake in the same change, with a test that fails on the old fake
Write the test with /write-test and watch it fail before you change the fake. A fake that stays wrong passes the next Agent's broken code.
