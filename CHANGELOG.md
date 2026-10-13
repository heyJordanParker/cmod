# Changelog

What changed in each version of cmod, for the people who build and use mods. Releases before 1.0.0 have their notes on GitHub.

## [Unreleased]

## [1.0.0] - 2026-10-13

### Added
- `sessions` reads every saved conversation as contexts, turns, messages, a goal, and tasks: `sessions.current`, `sessions.list()`, and `sessions.search()`, which answers in under 0.3 s on 800,000 messages.
- `session.on` hears each new message, turn, context, task, and goal change, in this session or another running one, with a matcher on its fields. `session.send` gives another session a Prompt or a Note, and `session.startTask` starts a task beside Claude.
- `cmod history` reads sessions, turns, contexts, tasks, goals, and messages in a terminal, searches them, and `follow` streams another session's changes.
- `mod.ui.toast` draws toasts above the prompt: success, info, warning, error, loading, and promise, each with an optional action button. `mod.ui.copy` puts text on the clipboard.
- Every failure cmod catches for a mod is an error toast with a Copy button that copies the versions, the message, the whole cause chain, and the stack. A failed install has a Retry button.
- An Installed toast says what a mod adds, what its setup did, and what you allowed it. An Updated toast shows what changed since the version you had, from the mod's `CHANGELOG.md`. Neither shows on a reload or a new session.
- A mod's `CHANGELOG.md` is its release notes: `cmod publish` releases the version's section, the Updated toast shows it, and /mods has a Changelog page.
- `settings.user`, `settings.project`, and `settings.local` change Claude Code settings. The `config` permission lists the setting names a mod may change, and `cmod teardown` puts back each value the mod changed.
- `mod.ui.scroll` scrolls the transcript to a message.
- A conversation forked into a new Claude Code process keeps every mod's session values.
- A mod that failed or was declined starts on your next prompt once `cmod install <mod>` sets it up, with no `/reload-plugins`.
- `cmod new` writes a `CHANGELOG.md` and pins the cmod plugin to `^1.0.0` in `plugin.json`.

### Changed
- What Claude Code or your computer owns is an import from `mod.js`: `sessions`, `settings`, `model`, `fs`, `metadata`, `process`, and `http`. Every `Mod` member is the mod's own.
- Hooks and places are constants from `mod.js`, such as `mod.on(UserPromptSubmit, …)` and `mod.ui.render(AbovePrompt, …)`. Slots are places. The markdown places, such as `CodeBlock`, come from `ui/markdown.js`, so a mod that draws no markdown never loads the markdown reader.
- `mod.on`, `mod.ui.render`, `slashCommand`, and `tool` return a `Disposable`.
- A mod built on `@cmodjs/core` 1.0 pins the cmod plugin in `.claude-plugin/plugin.json` with `"dependencies": [{ "name": "cmod", "version": "^1.0.0" }]`, so Claude Code turns it off with a clear error beside an older cmod plugin.
- One word per idea: `type` replaces `kind`, the `agents` permission is `tasks`, `SlotProps` is `PlaceProps`, the slash command reply type is `CommandReply`, and a schedule's entry is a `ScheduledPrompt`.
- The `config` permission is a list of setting names, such as `"config": ["cleanupPeriodDays"]`, instead of `true`.
- A session value lasts as long as Claude Code keeps the conversation, instead of the 20 newest sessions.
- `cmod try` links its mods into the home it runs in, as `cmod link` does, so /mods and a mod's first-start questions set their options there too.
- The cmod plugin indexes conversations only while a mod holds the `conversation` permission, and turning that permission off stops the mod's `session.on` listeners from the next prompt.

### Removed
- `mod.claude`, `mod.history`, `mod.session`, `mod.fs`, `mod.process`, `mod.http`, `mod.model`, `mod.metadata`, `mod.projectRoot`, and `mod.cwd`. Import the matching name from `mod.js`, and read `sessions.current.project` and `sessions.current.cwd` for the folders.
- `ui/slots.js`. Use the place constants from `mod.js` and the markdown places from `ui/markdown.js`.
- `mod.ui.progress`, `ProgressStep`, and `ProgressBar`. Use a loading toast and `Progress`.
- The Breaking changes list `cmod publish` built from commit messages. The changelog section replaces it.

### Fixed
- A call to another mod resolves with its answer and rejects with the reason it was refused, instead of resolving with `{ value }` or `{ deny }`.
- `cmod check` compiles mods on current Claude Code again.
- An installer step whose `isDone` throws counts as not done and shows in the installer, instead of stopping it.
- `cmod link --option` and `cmod try --option` set a linked mod's options, under the id Claude Code lists for the checkout.
- A linked checkout whose version moved past its last release sets up: setup builds its program from the checkout instead of downloading a release that does not exist.
