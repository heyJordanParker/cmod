# Changelog

What changed in each version of cmod, for the people who build and use mods. Releases before 1.0.0 have their notes on GitHub.

## [Unreleased]

## [1.5.0] - 2026-10-14

### Added
- `before` changes or refuses what is about to happen: rewrite or refuse a prompt, a slash command, or another session's message, rewrite a note, a Skill, a reply, a tool result, or a notice, leave out a `CLAUDE.md` file, rewrite, answer, or refuse a tool call, pick the model a task runs on or refuse it, and keep a task, a turn, or a context from ending.
- `sessions`, every session, its goal, a task, a context, and a turn each have `search`, `on`, and `before`, and each hears what happens inside it, so `turn.on(Reply, …)` hears that turn's replies and `sessions.on(Prompt, …)` hears every running session's prompts.
- Every session action works on every running session, not only the current one: `send`, `startTask`, the new `callTool`, `usage`, and the new `clients`. `usage` reads an ended session's model and tokens from its transcript.
- A task's `owner` is the session doing its work, with its own goal, turns, messages, `agentType`, and `model`. A session has `agentType`, `context()`, and `turn()`.
- `UsageChange` hears a session's new usage.
- A mod's `rules/` folder of Claude Code rules applies while the mod is on and has the `prompt` permission, and stays out of a project that turned the mod off. A rule that applies everywhere reaches a running session as a note, a rule taken out is withdrawn by a note, and the Installed toast lists the rules.
- All 33 of Claude Code's hooks are constants, among them `MessageDisplay`, `WorktreeCreate`, `PreModelSwitch`, and `TodoCreated` and `TodoCompleted` for its todo checklist. `HookAnswer` takes `displayContent` and `worktreePath`.
- A pane's handle says whether the pane `isShown` and `isFocused`.
- `settings.list()` lists every `/config` row.
- `fs` reads `$HOME` and `$CLAUDE_CONFIG_DIR` paths.
- `cmod history search --session` searches one conversation, or one task, turn, context, or goal in it. `cmod history usage` prints a session's model and tokens, and `--task` reads a task's owner like a session. `cmod rules` links the mods' rules. `cmod history follow --running` follows every running session of the project, and each one that starts later.
- `testMod`'s `startTask` takes a `parent`, to start a subtask.
- Every failure toast has `Retry` where running the step again can work, `Report`, and `Hide`. `Report` opens its choices inside the toast, with the keys on the first: ask Claude to report the failure to the mod's author, open a filled-in GitHub issue or email, or copy the error. `Hide` keeps the same failure hidden in later sessions.
- A failed install that waiting can fix retries in the background, from 2 seconds up to every 128 seconds, and clears its toast once it works: a linked checkout's failed build, once the checkout changed, and a release download that got 404 or no answer, as right after a release is published.
- A mod the person declined has an `Install` button that asks again.

### Changed
- No message sends the person to a terminal. A call to a mod that is not set up says `<mod> is not set up. Its toast says why.`, and one to a mod that is not installed says `<mod> is not installed. Add it with /plugin.`
- `cmod publish` creates the GitHub release with every file before it pushes `marketplace.json`, so no update reaches a release without its files.
- One compaction moves a context once, for the session and for each task, and `ContextEnd` reaches the mods when a session compacts.
- A guard registered by a session that ended without closing, such as a crashed one, no longer fails every later prompt. It is cleared.
- Each mod's install and consent popup is its own, so one mod no longer draws another mod's popup.
- A background install retry keeps the consent the person gave, instead of asking again.
- A task's `agentType` and `model` moved to its `owner`.
- A task's messages name their own turn.
- A matcher's `RegExp` no longer matches a key the payload lacks.
- The cmod plugin asks for the `prompt` permission, to add the notes of the mods' rules.
- The conversation index is `history-5.sqlite`, rebuilt from the transcripts on first use.
- `sessions.on` and `sessions.before` reach every running session of the current project, including those that start later, and no other project's.

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
- `mod.fs`, `mod.process`, `mod.http`, `mod.model`, and `mod.metadata`. Import `fs`, `process`, `http`, `model`, and `metadata` from `mod.js`.
- `mod.history` and `mod.session`. Read `sessions` from `mod.js`, and `sessions.current` for the session the mod runs in.
- `mod.projectRoot` and `mod.cwd`. Read `sessions.current.project` and `sessions.current.cwd`.
- `mod.claude`, Claude Code's raw API. Each use has its own replacement: a slash command is `mod.use(slashCommand(…))`, which works after setup too, `ui.scroll` is `mod.ui.scroll`, `ui.log` is `mod.log`, and `session.id()` is `sessions.current.id`.
- `ui/slots.js`. Use the place constants from `mod.js` and the markdown places from `ui/markdown.js`.
- `mod.ui.progress`, `ProgressStep`, and `ProgressBar`. Use a loading toast and `Progress`.
- The Breaking changes list `cmod publish` built from commit messages. The changelog section replaces it.

### Fixed
- A call to another mod resolves with its answer and rejects with the reason it was refused, instead of resolving with `{ value }` or `{ deny }`.
- `cmod check` compiles mods on current Claude Code again.
- An installer step whose `isDone` throws counts as not done and shows in the installer, instead of stopping it.
- `cmod link --option` and `cmod try --option` set a linked mod's options, under the id Claude Code lists for the checkout.
- A linked checkout whose version moved past its last release sets up: setup builds its program from the checkout instead of downloading a release that does not exist.
