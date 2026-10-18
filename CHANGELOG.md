# Changelog

What changed in each version of cmod, for the people who build and use mods. Releases before 1.0.0 have their notes on GitHub.

## [Unreleased]

## [2.1.0] - 2026-10-18

### Added
- `tested.raise.beforeContextEnd({ task })` tests a mod's answer to the compaction of a task's context.
- `cmod check` fails a mod whose `src/` hears permissions while `hooks/register.ts` does not call `registerPermissionCheck`.

### Changed
- `cmod check` adds `"approve": true` only for a mod that answers the permission check, with a `before` method or the `permissions` job. A mod that only listens with `onPermissionCheck` or `onPermissionRequest` no longer asks the person to let it approve tool calls.

### Fixed
- A mod that never calls `registerPermissionCheck` carries no permission hook at all. On 2.0.1 every mod's bundle registered one that only passed the check on, and Anthropic's plugin directory refused it as unable to show that the mod leaves each permission decision with the person.
- `onPermissionCheck`, `beforePermissionCheck`, `onPermissionRequest`, `beforePermissionRequest`, and `mod.use(permissions(…))` throw where they are called when `hooks/register.ts` does not call `registerPermissionCheck`, and name the line to add. On 2.0.1 one added after `setup` heard nothing and said nothing.
- `tested.raise.beforeToolResult` hands the listener its `output` as given, so a test can give what a tool answers Claude Code, such as Edit's `structuredPatch`. On 2.0.1 it turned the output into text.

## [2.0.1] - 2026-10-17

cmod 2.0.1 fixes what mods ran into on 2.0.0 and makes cmod lighter: a prompt no longer waits on a cmod process, and nothing it reads blocks for minutes behind the conversation index.

### Fixed
- A mod that names a version range on cmod, such as `"version": "^2.0.0"`, installs on a computer without cmod. Claude Code installs a dependency's range only from a tag named `<name>--v<version>`, which cmod's releases now carry, back to 0.1.5. `cmod publish` pushes that tag on each release of your mod too, for a marketplace that lists your mod from its git repository.
- In an interactive session, a mod's listeners on its own session work again. On 2.0.0 the cmod plugin did not yet know its session when a mod set up, so it refused them for lacking the conversation grant and showed three error toasts.
- A mod that decides no permissions passes Anthropic's plugin directory check again. Only a mod that calls `registerPermissionCheck` carries the code that answers a permission.
- A `beforeSessionStart` note reaches Claude in `claude -p` and the SDK, where Claude Code runs SessionStart before mods start.
- `onInstructionFile` and `beforeInstructionFile` name the file's `path` for every instruction file Claude Code adds as it runs.
- `beforeToolCall`'s `cwd` is the folder a subagent runs in, for a task started with its own `cwd`.
- A message the conversation index is writing no longer makes a read of the running session wait up to two minutes and then fail with "database is locked". The index writes a large session in steps.
- `cmod setup`, `link`, `install`, `update`, and `try` say a mod "is already set up" when its install step has nothing to run, instead of "Installing".
- Two `before` listeners that each answer a `note` both reach Claude.

### Changed
- A prompt no longer waits for `cmod rules`. The cmod plugin runs it only when a file it reads changed, and `cmod rules --json` lists those files as `watched`.
- The cmod launcher starts faster, and frees the disk space of each older cmod build once it installs a newer one. What ran the older build runs the newer one.
- Checking whether another session still runs reads only the running sessions, once for every waiting call.
- The conversation index finds deleted transcripts with one listing per folder, and reads each transcript row once per query.
- A mod with no `state.session` does no session bookkeeping at session start.
- cmod waiting for a newer cmod checks every 10 seconds after the first minute.

## [2.0.0] - 2026-10-17

cmod 2.0 gives a mod one way to hear and change Claude Code: a named `on` or `before` method for each moment, on the part of the conversation it happens in. `mod.on` and Claude Code's raw hook inputs and answers are gone, and the docs' session.md lists every method.

### Added
- Every moment of a session is a method on `sessions.current`, with a typed payload and answer: `onSessionStart` and `beforeSessionStart` with a `note`, `beforeModelChange`, `onCwdChange`, `beforePermissionCheck` and `beforePermissionRequest`, `beforeToolBatch`, `beforeTodoCreate`, `beforeReplyDisplay`, worktrees, elicitations, and notifications.
- `commands` hears, changes, and runs every slash command, built-ins such as `/compact` included: `commands.beforeRun` rewrites a command's arguments, answers in its place, or refuses it, `commands.onRun` hears it ran, `commands.run` runs one, and `commands.list` lists them all.
- Every `on` and `before` method takes `{ timeoutMs }`, and its listener gets a `deadline` and an `AbortSignal` that aborts then. `onFailure: 'refuse'` makes a `before` gate that breaks refuse instead of letting the moment through.
- A tool call and its result list the files they read and change, as `files: { read, changed }`, Bash command lines included.
- A tool result names its call's tool and input.
- A turn that ends says why: Claude's `answer`, or a `failure` with its type. `turn.abort()` stops a running turn.
- `beforePrompt` adds a `note` beside a prompt and names the session with `title`, and a task's first prompt takes a `note` its subagent reads before its first step. `beforeToolResult` adds a `note` beside a result, or marks it an error.
- `fs.onChange` hears the files that change under a path, and `settings.beforeFileChange` refuses an edit to a settings file while the session runs.
- `mod.log(text, { to: 'transcript' })` writes a dim line the person reads in the conversation.
- `InstructionFile` has `isRule`, true for a rule file. The `Engine` sender marks Claude Code's own continuation prompt.
- The test kit raises any method with `tested.raise.<method>(payload)`, starts a new session with `tested.startSession({ source, id })`, and ends a turn with an `answer` or a `failure`.

### Changed
- A session is one agent: `sessions.current`'s listeners hear the main agent only, `sessions.current.goal` hears every agent in the session, and `task.owner` hears one subagent. A task's `owner` is a `TaskOwner`, without `startTask` and `callTool`.
- `on(Event, …)` and `before(Event, …)` are named methods: `onReply(…)` for `on(Reply, …)`, `beforeToolCall(…)` for `before(ToolCall, …)`. `sessions` has `on` methods only, and a `before` method on another session changes what happens there.
- `session.goal` is a property that follows the session, as `sessions.current` does, and `goal.text()` reads its text. Write `sessions.current.goal.tasks()` for `(await sessions.current.goal()).tasks()`.
- `search` streams: it returns an `AsyncIterable` newest first and takes a matcher. Loop with `for await` and `break` instead of `limit`, and pass `before` to continue a loop that broke.
- `search` covers what the part's listeners hear: a session's `search` its own agent's messages, its goal's every agent's, and a task's its owner's and every task below it.
- `cmod history search --goal` is `--agent`, which keeps the main agent's messages, or with `--task` that task's own.
- `ToolResult.text` is `output`, and `beforeToolResult` answers `{ output }`.
- `Document` is `InstructionFile`, `clients()` is `surfaces()`, and `usage()`'s `context: { tokens, window }` is `contextWindow: { tokenCount, size }`.
- `settings.list()` is `config.list()`, and `Setting` is `ConfigRow`.
- `startTask` takes a `title`, and `name` is the address a teammate's `SendMessage` reaches it by.
- A `slashCommand` reply's `context` is `note`.
- A built-in command such as `/model` no longer reaches `beforePrompt`: `commands.beforeRun` hears every command, and `beforePrompt` hears a command Claude Code sends as a prompt.
- A task about to end is `task.owner.beforeTurnEnd`.
- `statusLine` redraws when the usage or the mod's state changes. A line that follows a clock sets the state from `mod.every`.
- The conversation index is `history-6.sqlite`, and cmod deletes `history-5.sqlite`.
- A mod built on `@cmodjs/core` 2.0 reads conversations through the cmod plugin 2.0, so update the cmod plugin with `/plugin` before such a mod.

### Removed
- `mod.on`, the 33 hook constants such as `PreToolUse` and `Stop`, and `HookInput`, `HookAnswer`, `HookListener`, and `HookOptions`. Each hook's job is a method: `sessions.current.onToolResult` for `PostToolUse`, `sessions.current.beforeToolCall` for `PreToolUse`, `sessions.current.beforeTurnEnd` for `Stop`, `sessions.current.beforeSessionStart` for `SessionStart`, and `sessions.current.onPrompt` or `beforePrompt` for `UserPromptSubmit`.
- `beforeTaskEnd`. Use `task.owner.beforeTurnEnd`.
- `prompt`'s `when`. Add the note with `sessions.current.beforePrompt({ text: /pattern/ }, () => ({ note }))`.
- `statusLine`'s `interval`.
- `tested.fire` for Claude Code's hooks, and `TestInput`. Use `tested.raise`, and `tested.add`, `endTurn`, `compact`, `startTask`, and `startSession` to build the conversation. `fire` keeps `tool.check`, `prompt.context`, `cmod.call`, and the `ui` events.
- The `SessionEvent`, `SessionPayload`, `BeforeEvent`, `BeforeAnswer`, and `UsageChange` exports, and the event constants such as `TurnEnd` and `TaskStart`. The methods carry their payload types.

## [1.6.0] - 2026-10-16

### Added
- A mod changes one value inside a setting and leaves the rest alone: `settings.user.update({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' } })` keeps every other variable in `env` and the file's comments. Removing the mod takes out only that value, and only while it still holds what the mod set.
- A `config` permission names a key path: `"config": ["env.ANTHROPIC_BASE_URL"]` covers that one value, and `"config": ["env"]` covers every key in `env`.

### Changed
- `settings.<source>.update` merges an object into the object already there, at every depth, instead of replacing it. `null` still removes a key, and an array or any other value still replaces it. To replace a whole object, read it and set each key you drop to `null`.
- A mod that declares a `config` permission waits for cmod 1.6.0, because an older cmod replaces the whole object.

### Fixed
- A mod whose installed folder was deleted no longer stops `cmod link` and `cmod rules` from linking every other mod's rules.
- A cmod release ships the `@cmodjs/core` and `@cmodjs/cli` it just published. The cmod plugin 1.5.1 shipped with `@cmodjs/core` 1.5.0.

## [1.5.1] - 2026-10-14

### Fixed
- `Retry` keeps the failure toast where it is while it runs. The progress shows in place of the toast's description, or of its buttons when it has none, so nothing moves until the try ends.
- While a mod's install popup waits for the person's answer, its toast no longer spins. Each spin redrew the popup, and a press that landed during a redraw was lost.
- Two builds of one checkout take turns, so a linked mod's build no longer clears the output of a `cmod publish` running at the same time.

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
