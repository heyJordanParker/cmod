# cmod commands

The `cmod` command of Claude Mod Manager (cmod) builds, checks, and publishes mods, and installs them. `npm i -g @cmodjs/cli` puts it on `PATH`. `cmod <command> --help` prints a command's arguments, and `cmod --version` prints the version.

Each command below restates what `cmod <command> --help` prints, for a mod author. The help text is the full word.

## Build a mod

### cmod new

```text
cmod new <name> [--project]
```

Creates a mod in `./<name>`: a `defineMod` with one listener, a Sidebar page, a widget, and a hotkey that shows the page, a Skill, a test, and a `CHANGELOG.md` ([mod.md](mod.md#release-notes)). Then installs its packages.

- `<name>` is lowercase letters, digits, and `-`, starting with a letter.
- `--project` creates a project-scope plugin in `./.claude/skills/<name>/` of the repository in the current folder, which loads for everyone who trusts the repository. Run it in the repository's root.
- `CMOD_CORE` sets the `@cmodjs/core` dependency it writes. By default it writes `^<the version of this cmod>`. To build against an unreleased `@cmodjs/core`, point it at a packed tarball, such as `file:/path/to/cmodjs-core-<version>.tgz`. Only a `.tgz` works: a folder installs as links into that folder, and `claude plugin validate --strict` refuses the mod.
- When the packages fail to install, it deletes the new folder.

### cmod link

```text
cmod link [path] [--yes] [--option key=value]...
```

Loads the checkout at `path` (default: the current folder) in every new Claude Code session, in place of the installed mod. Installs the cmod plugin when Claude Code lacks it, unless the checkout is cmod itself. Then installs the checkout's packages, builds the program `cli/` declares and links it into cmod's programs folder and `~/.local/bin`, writes the folder into `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of Claude Code's `settings.json`, and runs the checkout's install step. Claude Code reads that list only when a session starts, so a session that is already running loads the checkout once the person starts a new one. From then on, Claude Code reloads the checkout in each session when a file in it is saved.

- `--yes` approves the mod's install and uninstall commands without asking.
- `--option key=value` sets one of the mod's options through `claude plugin configure`, once per option, under the id `claude plugin list` shows for the linked checkout, such as `my-mod@inline`. It refuses a key the mod does not declare, and names the keys it does ([options.md](options.md)).

### cmod unlink

```text
cmod unlink [path]
```

Stops loading the checkout at `path` (default: the current folder) in new Claude Code sessions. Removes the folder from `CLAUDE_CODE_PLUGIN_DIRS` in Claude Code's `settings.json`, runs the checkout's uninstall step, and removes the program `cmod link` built, with its links.

### cmod check

```text
cmod check [path]
```

Runs every check this machine can run on the mod at `path` (default: the current folder), each failure with its fix:

1. Installs its packages.
2. Checks its layout.
3. Checks that each step runs a script.
4. Checks that `package.json` `"os"` and `"cpu"` list only machines cmod runs mods on, darwin and linux on arm64 and x64, and that the install step downloads a program for each machine they list.
5. Prints the permissions the person grants at install and can grant later, as the person reads them ([permissions.md](permissions.md)). It adds `"approve": true` when the mod allows or asks on the permission check and `hooks/register.ts` calls `registerPermissionCheck`. It fails a mod whose `src/` hears permissions while `register.ts` does not call `registerPermissionCheck`.
6. Reads the metadata of every file in the mod, and names each file whose metadata cmod cannot read.
7. Writes the options `defineMod` declares into `.claude-plugin/plugin.json` `userConfig`, and its hotkeys into `package.json` `"cmod"` `hotkeys`, keeping each file's own formatting, so Claude Code shows the options in `/config` ([options.md](options.md)). It loads `hooks/register.ts` to read them, without starting the mod.
8. Writes the `cmod` dependency in `.claude-plugin/plugin.json` as `>=` the version of the `@cmodjs/core` the mod installed, such as `>=4.0.0`, so every newer cmod runs the mod. A mod still on `@cmodjs/core` 3 keeps its own range ([dependencies.md](dependencies.md#call-the-methods-mod-dependencies)).
9. Checks its imports.
10. Looks for prebuilt binaries outside `cli/`.
11. Bundles the hooks module as `cmod publish` does, and names each reason a bundle fails.
12. Validates it with Claude Code, `claude plugin validate --strict`.
13. Compiles it against Claude Code's API with `tsc`, with `tsconfig.json`, and then with `tests/tsconfig.json` when it exists. `cmod new` writes both: the root config leaves Bun out of `src/`, which runs inside Claude Code, and the tests config adds `bun-types`, so a test can run a real program with `Bun.spawn` or read files with `node:fs`. When `.claude-plugin/types/` is missing, as in a fresh clone or in CI, Claude Code writes it first: cmod loads the mod in one `claude -p` run with a config folder of its own and no model to reach, so the run sends nothing.
14. Lints it with `oxlint`.
15. Runs, with `bun test`, every test file that does not import `claude-code/testing`. When `bunfig.toml` names a `[test]` `root`, it runs only the test files under that folder, as `bun test` does.
16. Runs, with `claude plugin test`, the test files that import `claude-code/testing`. It skips this when none does.
17. Checks its name against other plugins. Only a project plugin, in `.claude/skills/<name>/` of a repository, runs this check: it fails when an installed or linked plugin has the same name and hides the project plugin. Any other mod passes it at once.

`cmod check` fetches `tsc` 7.0.2 and `oxlint` 1.86.0 into the cmod store the first time. It ends with a count of passed, failed, and skipped checks, and exits 1 when one failed.

### cmod try

```text
cmod try <owner/repo | path>... [--yes] [--option key=value]... [--home <folder>] [-- claude arguments]
```

Starts one throwaway Claude Code session with mods set up, for trying a mod by hand or testing it with an agent. Installs each mod's packages, installs the cmod plugin when Claude Code lacks it, and runs each mod's install step after asking consent. Then links every mod into the home's `settings.json`, as `cmod link` does, starts one Claude Code session, and unlinks each folder it linked when the session ends. With `--home ~`, a session you start meanwhile loads the tried mods too.

- `--option key=value` sets one option of the mod. With several mods, write `--option <mod>.key=value`.
- The session runs with a new home folder, so it sees only the mods named here and changes none of your Claude Code settings, mods, key bindings, or history. The folder is deleted when the session ends.
- The session stays logged in as you, with no login screen:
  - On macOS, Claude Code reads your login from the keychain, which `cmod try` links into the new home as `~/Library/Keychains`. Deleting the home removes only the link.
  - Elsewhere, `CLAUDE_SECURESTORAGE_CONFIG_DIR` points Claude Code at the folder that holds your login, so it reads and refreshes that login where it is.
  - `ANTHROPIC_CONFIG_DIR` points at your `~/.config/anthropic` login profiles, and `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` pass through.
- The session keeps how Claude Code reaches the model and what it must never do, so a try is as safe as your own session. From your `settings.json` it keeps `env` (a proxy or `ANTHROPIC_BASE_URL`, without `cmod link`'s `CLAUDE_CODE_PLUGIN_DIRS`), the credential helpers (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper`, `proxyAuthHelper`), the login pins (`forceLoginMethod`, `forceLoginOrgUUID`, `forceLoginGatewayUrl`, `gatewayInternalNetworks`), `sandbox`, and `permissions.deny`. From `~/.claude.json` it keeps your account and the API keys you approved. A `~/` in a helper still means your own home. Hooks, plugins, allow rules, the model, and every other preference stay behind. Managed settings apply as always.
- `--home <folder>` runs in that folder and keeps it, so the next `cmod try --home <folder>` starts from it. `--home ~` runs in your own home, with your settings and mods.
- A checkout's program is built from its `cli/` the way `cmod link` builds it, with your own home and environment, so the build finds your toolchains and caches. A GitHub mod's program downloads from the GitHub release of the mod's version, so it fails until `cmod publish` has released that version.
- When the session ends, even when its terminal closes, it runs each mod's uninstall step and deletes its record, data folder, approval, key bindings, and program, so the mod stays uninstalled. A checkout already set up from the same folder keeps its setup.
- A GitHub mod is cloned into a temporary folder, which is deleted too.
- A mod another folder has set up in that home is refused, so `cmod try` never replaces an installed copy.
- Arguments after `--` go to `claude`, such as `-- -p "hello"`. An agent tests a mod with one `cmod try <path> --yes -- -p "<prompt>"` run.

### cmod publish

```text
cmod publish [path] [--dry-run]
```

Releases the mod at `path` (default: the current folder) at the version in its `plugin.json`. It refuses a `plugin.json` whose `userConfig` differs from the options `defineMod` declares, and says to run `cmod check` and commit `.claude-plugin/plugin.json`.

1. Builds the release from the committed files, leaving out `cli/`, `.github/`, and `.claude/`. A `"files"` list in `package.json` limits the release to the paths it lists, plus the folders of the install and uninstall steps, `.claude-plugin/`, `package.json`, `tsconfig.json`, the README, the license, and `CHANGELOG.md`, the way `npm publish` reads it. `tsconfig.json` holds the JSX settings the bundle in step 2 needs. List every folder the hooks module imports from, such as `"files": ["hooks", "src", "skills"]`, because the bundle in step 2 is built from the release.
2. Bundles the hooks module that `hooks/hooks.json` names, with the mod's source and packages, into one readable `.js` file, writes each control character in it as a `\u` escape, and points `hooks/hooks.json` at it. Anthropic's plugin directory reads a repository without installing its packages, so it can follow a mod only when all its code is in one file. Without `"approve": true` in `package.json` `"cmod".permissions`, the bundle leaves out the code that allows and asks on Claude Code's permission check ([permissions.md](permissions.md)).
3. Checks the release with `claude plugin validate --strict`, and stops with the validator's message when it fails.
4. Commits the release as the `release` branch, and builds the release archive from that commit.
5. Builds the program `cli/` declares, and writes `SHA256SUMS` for every file of the release.
6. Writes `.claude-plugin/marketplace.json`, listing the archive and the cmod plugin. The cmod entry points at the `release` branch of `heyJordanParker/cmod`, so the mod's `"cmod"` dependency resolves in this marketplace and follows each cmod release with no new publish of the mod.
7. Commits that file, tags `v<version>`, tags the release commit `<name>--v<version>`, which Claude Code installs a version range from when a marketplace lists the mod from its git repository, pushes both tags and the `release` branch, creates the GitHub release with every file, then pushes the branch that holds `marketplace.json`. So Claude Code never updates anyone to a release whose files are not up yet. Its notes are the version's section of the committed `CHANGELOG.md`, above GitHub's compare link ([mod.md](mod.md#release-notes)). `--dry-run` prints them.
8. Prints the link to paste as the Repository when you submit the mod at [claude.ai/directory/manage](https://claude.ai/directory/manage), such as `https://github.com/owner/greeter/tree/release`. The portal reads the branch from the link, so the directory follows `release`.

The release keeps `package.json`, so Claude Code still installs the mod's packages for its install and uninstall steps. It keeps `bun.lock` too, unless a `"files"` list leaves it out. `main` keeps the source only.

It needs, and refuses to start without:

- the mod's folder as the root of a git repository with at least one commit, because `git archive` builds from `HEAD`
- a `## [<version>]` section with notes in the committed `CHANGELOG.md`
- `node_modules` in the mod's folder, from `bun install`, when the hooks module imports a package
- a `register` declared as a function in the hooks module, as `cmod new` writes it, because the validator refuses a bundled `register` that is not one
- the `claude` command, which validates the release
- an `origin` remote on GitHub
- a `package.json` with no dependency on a `file:` or `link:` path, which no user has
- a `"files"` list, when `package.json` has one, whose every path matches a committed file
- a `"program"` in the `cmod` key of `package.json` that names the program `cli/` declares, when `cli/` declares one
- a `cmod` dependency in `.claude-plugin/plugin.json` of `>=` the `@cmodjs/core` the mod bundles, which `cmod check` writes
- for a real publish, a working tree with no uncommitted changes, no `v<version>` or `<name>--v<version>` tag yet, a `git push` to `origin` that succeeds, and the `gh` command, which creates the GitHub release

`--dry-run` builds everything into a temporary folder, and pushes nothing. It writes `marketplace.json` there too, so the working tree stays as it was. It allows uncommitted changes and an existing tag, and builds from the last commit. It prints the folder that holds the release, so you can read what the directory will read.

## Install mods

`cmod install`, `cmod update`, `cmod remove`, `cmod enable`, `cmod disable`, `cmod link`, `cmod unlink`, and `cmod try` write the time to `plugins-changed` in the cmod store when they finish, also when they fail partway, such as an update that updated some mods. The cmod plugin of every running session watches that file and runs `/reload-plugins`, so each session runs the mods the person has now. A reload clears each mod's `memory` state. A machine where cmod set up no mod has no store, and these commands write nothing there. `cmod permission` needs no reload, because a mod sees its grants change before its next call.

### cmod install

```text
cmod install <owner/repo | path> [name] [--yes] [--option key=value]...
cmod install <name | name@marketplace> [--yes] [--option key=value]...
```

Adds the plugin's marketplace to Claude Code and installs the plugin through Claude Code. A mod also gets the cmod plugin when Claude Code lacks it, and its install step runs. Any other plugin installs through Claude Code alone, and cmod keeps no record of it.

- When the marketplace lists several plugins, name the one to install after it.
- Given `name@marketplace` of a marketplace Claude Code has added, it installs that plugin.
- Given the name of a plugin Claude Code already holds, it runs a mod's install step again.
- A path holds a `/`, such as `./my-mod`.
- `--yes` approves the mod's install and uninstall commands without asking.
- `--option key=value` sets one of the mod's options through `claude plugin configure`, once per option, so a scripted install needs no visit to `/config`. It refuses a key the mod does not declare, and names the keys it does ([options.md](options.md)).

### cmod update

```text
cmod update [name] [--yes]
```

Updates the named plugin, or every plugin Claude Code has installed, through Claude Code, then runs the install step of each mod whose version or scripts changed. A linked plugin is skipped, because saving its files updates it. When Claude Code fails to update a plugin, `cmod update` names it, updates the rest, and exits 1. Every running session then loads the new version.

- `--yes` approves changed install and uninstall commands without asking.

### cmod remove

```text
cmod remove <name>
```

Uninstalls the plugin through Claude Code. When cmod set the plugin up as a mod, it then runs the uninstall step cmod saved and removes what cmod set up.

### cmod enable and cmod disable

```text
cmod enable <name>
cmod disable <name>
```

Turns the plugin on or off through Claude Code, as `/plugin` does, and every running session follows. A mod keeps its setup, its data, and its program while it is off, and runs no install or uninstall step either way. They refuse a plugin linked with `cmod link`, which `cmod unlink` stops loading. The `Turn off` and `Turn on` buttons in Settings run them.

### cmod list

```text
cmod list [--json]
```

Lists every plugin Claude Code has installed or linked, with its version. A mod shows whether cmod set it up, and any other plugin shows whether Claude Code enabled it. A plugin Claude Code turned off shows Claude Code's reason, such as `Requires "cmod@market" >=4.2.0, installed 4.0.0`. It also lists every mod Claude Code removed whose uninstall step has not run yet.

- `--json` prints the list as JSON: one object per row with its `name`, `version`, `state`, and `unsatisfied`, the dependencies Claude Code turned the plugin off for because they are older than the plugin needs.

- The `cmod` commands count a plugin as a mod only when its `package.json` has a `cmod` step key or cmod holds an install record for it. A mod made with `cmod new` has neither until its first Claude Code session sets it up, so until then `cmod list` shows it as `enabled`, like any other plugin.

## Read your conversations

### cmod history

```text
cmod history sessions [--all] [--since 2d] [--running] [--project <folder>] [--json]
cmod history search <text> [--all] [--since 2d] [--running] [--project <folder>] [--session <id> [--task <id>] [--turn <id>] [--context <n>] [--agent]] [--limit <n>] [--before <session>:<id>] [--json]
cmod history messages [<session>] [--task <id>] [--turn <id>] [--after <id>] [--last <n>] [--json]
cmod history turns [<session>] [--task <id>] [--context <n>] [--last <n>] [--json]
cmod history contexts [<session>] [--task <id>] [--json]
cmod history tasks [<session>] [--task <id> | --nested] [--json]
cmod history goal [<session>] [--task <id>] [--json]
cmod history usage [<session>] [--task <id>] [--json]
cmod history state [<session>] [--json]
cmod history follow [<session>...] [--running] [--json]
cmod history index
```

Reads every conversation Claude Code saved, as the sessions, contexts, turns, tasks, and messages `sessions` answers a mod ([session.md](session.md)), so a person or an agent reads them in a terminal without parsing a transcript.

- `sessions` lists the conversations of the current folder's project, or `--project`'s, newest first, each with its time, id, and title. `--all` lists every project's, `--since` keeps those active in the last `30m`, `6h`, `2d`, or `1w`, or since a date such as `2026-10-01`, and `--running` keeps those open in Claude Code now.
- `search` prints the newest 50 messages whose text or tool input contains the text, at least 3 characters, any case, each with its time and session. Each tool input value is searched in its first 1,024 characters, and tool results are not searched. `--all`, `--since`, and `--running` scope it as they scope `sessions`, `--limit` changes the 50, and `--before <session>:<id>` prints the page after the message it names, the last one of the page before. `--session` searches one conversation, and inside it `--task` searches a task and the tasks it started, `--turn` one turn, `--context` one context, and `--agent` keeps the main agent's messages, or with `--task` that task's own, without the tasks it started.
- `messages` prints one conversation's messages in order: the session named, or the one the command runs in when Claude Code runs it. `--task` reads a task's messages instead, `--turn` keeps one turn's, `--after` starts after a message id, and `--last` keeps that many from the end.
- `turns` prints the conversation's turns, each opened by a prompt and closed when Claude finishes. `--context` keeps one context's, and `--last` keeps that many from the end.
- `contexts` prints the conversation's contexts, a new one after each compaction.
- `tasks` prints the tasks the conversation started, with `--task` the tasks that task started, and with `--nested` every task at any depth.
- `goal` prints what the conversation is for: the goal a mod set, or its first prompt.
- `usage` prints the model and the context's tokens as of the last reply.
- `--task` reads `turns`, `contexts`, `goal`, and `usage` of the session a task's owner runs, the way they read the conversation's.
- `state` prints what a running conversation resumes from.
- `follow` prints each message, turn, context, task, and goal change of the sessions named as Claude Code saves it, until stopped with Ctrl+C. `--running` follows every running session of the project too, and each one that starts later. The cmod plugin runs it to hear other running sessions.
- `--json` prints JSON instead of one line each.
- `index` reads every saved conversation into the index at `~/.local/share/cmod/history-8.sqlite`, which holds where each message is in its transcript, not a copy of it, and each conversation's turns, contexts, and tasks. While a mod other than cmod holds the `conversation` permission, the cmod plugin runs it in the background at each session's start, and a second run while one is running exits at once. The index forgets a conversation whose transcript is deleted.

## Run in an install script

### cmod download

```text
cmod download <program> <machine> <url> <sha256> [<machine> <url> <sha256> …]
```

Downloads a program for an install script: fetches the download for this machine, checks its SHA-256, unpacks it, and moves `<program>` to `$CMOD_DATA/bin/<program>`. [install-steps.md](install-steps.md) explains it.

## Run by cmod

cmod runs these itself. A person runs them to see a step's whole log, to finish a step, or to grant a permission.

### cmod setup

```text
cmod setup <plugin-root> [--events] [--consent <sha256>] [--yes]
```

Refuses a machine the `os` and `cpu` keys of the mod's `package.json` leave out. Downloads the program its `cmod.program` names, or builds it from the checkout's `cli/` when `cmod link` loaded the mod, so a linked checkout whose version has no release yet still sets up, and links it into cmod's programs folder, which Claude Code runs it from by its name, and into `~/.local/bin` unless a file there is not cmod's. Runs the mod's install step, saves its uninstall step, grants the permissions its `cmod.permissions` lists, and records the mod as set up. A mod installed from a marketplace whose automatic updates the person has not turned on or off gets them turned on, through `"autoUpdate": true` on the marketplace's `extraKnownMarketplaces` entry in Claude Code's `settings.json`, and the consent question says so. The consent covers the scripts, the program, the hotkeys, and the permissions together, and an update asks again only for what changed. An unchanged mod runs nothing. `--events` prints one event per line for a program to read, and the mod's install toast in Claude Code reads them.

### cmod teardown

```text
cmod teardown <plugin-name> [--events]
```

Runs a removed mod's saved uninstall step, then deletes its install record, the saved step, every version of its program, and its data folder, takes out each Claude Code setting it changed that still has the value it set, and forgets the scripts and the permissions the person approved for it. It keeps the mod's config folder, `~/.claude/cmods/<plugin-name>`. A failed uninstall step keeps the record, so `cmod teardown` can run again.

### cmod permission

```text
cmod permission <mod> <name> [value] on|off
```

Turns one permission of a set-up mod on or off, such as `cmod permission ci-watch model off` or `cmod permission ci-watch network api.github.com on`. A toggle in Settings runs it. It refuses a permission the mod's `package.json` `cmod.permissions` does not list, and the mod sees the change before its next call, with no reload ([permissions.md](permissions.md)).

### cmod hotkey

```text
cmod hotkey <mod> <hotkey> <combo>
```

Binds one hotkey of a mod to a new combo in Claude Code's `keybindings.json`, such as `cmod hotkey notes toggle ctrl+shift+n`, and removes the combo it had. A combo in Settings, under the mod, Hotkeys, runs it, and so does the cmod plugin for its own two hotkeys at its first start. It refuses a combo that is not one, and a combo the person already bound to something else, with `<combo> already runs something else in ~/.claude/keybindings.json. Pick another combo.` The mod's next update keeps the combo ([mod.md](mod.md#hotkeys)).

### cmod settings

```text
cmod settings <mod> <user|project|local> <json> [--project <folder>]
```

Changes Claude Code settings for a set-up mod, as its `settings.user.update`, `settings.project.update`, and `settings.local.update` do ([mod.md](mod.md#settings-claude-code-s-settings-files)), such as `cmod settings oneclaude user '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:8317"}}'`. It merges the JSON object into the user, project, or local settings as a JSON Merge Patch: an object merges into the object already there, `null` removes the key, and an array or any other value replaces it. The project and local settings are those of `--project`, the current folder when it is left out, and `mcpServers` in the project settings goes to `.mcp.json`. Each value needs the mod's `config` permission for its key path or a path above it. cmod keeps every other key and the file's formatting, and `cmod teardown` takes out each value the mod set that is still the same, then each object that leaves empty.

### cmod rules

```text
cmod rules [--project <folder>] [--json]
```

Links the `rules/` folder of each mod that is on and has the `prompt` permission into Claude Code's rules folder, and removes the link of each that is off, lacks the permission, or is removed ([mod.md](mod.md#rules)). A mod the person installed links at `<config>/rules/<mod>`, and one turned on only for `--project`, the current folder when it is left out, links at `<project>/.claude/rules/<mod>`. It prints the rules it linked. With `--json` it prints `{ linked, placed, removed, watched }`, where `placed` and `removed` name the mods whose link this run made or took away, and `watched` lists the files and folders whose change can change the next run. `cmod install`, `update`, `remove`, `enable`, `disable`, `permission`, `setup`, `teardown`, `link`, and `unlink` run it after they succeed. The cmod plugin runs it when a session starts and before a prompt, each time only when a `watched` path changed since its last run.

### cmod option

```text
cmod option <name> <key> <value>
```

Sets one option of an installed plugin through `claude plugin configure`, the way `/config` sets it, such as `cmod option ci-watch branch main`. A list option takes its items separated by commas. It refuses a key the plugin's `plugin.json` `userConfig` does not declare. A field in Settings and the option questions a mod asks at its first start run it, and the mod reads the new value at its next start ([options.md](options.md)).
