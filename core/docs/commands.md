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

Loads the checkout at `path` (default: the current folder) in every Claude Code session, the running ones too, in place of the installed mod. Installs the cmod plugin when Claude Code lacks it, unless the checkout is cmod itself. Then installs the checkout's packages, builds the program `cli/` declares and links it into cmod's programs folder and `~/.local/bin`, and runs the checkout's install step.

It loads the checkout through a marketplace cmod keeps in the checkout's parent folder:

1. It lists the checkout in `<parent>/.claude-plugin/marketplace.json`, named `<parent folder>-linked`, beside the cmod plugin from the `release` branch of `heyJordanParker/cmod`, so the mod's `cmod` dependency resolves in that marketplace. Every checkout linked from one folder shares its marketplace. The checkout's own `.claude-plugin/marketplace.json`, the one `cmod publish` writes, stays as it was.
2. It adds that file to the parent's `.git/info/exclude` when the parent is inside a git repository.
3. It adds the marketplace to Claude Code and installs `<mod>@<parent folder>-linked` from it, which loads the checkout's own files in every session at the next reload.
4. It turns off the installed copy of the mod from any other marketplace, and records it in `links.json` in the cmod store, so `cmod unlink` turns that copy back on.

It refuses a parent folder whose `.claude-plugin/marketplace.json` cmod did not write. `cmod watch` reloads every session once a change builds.

- `--yes` approves the mod's install and uninstall commands without asking.
- `--option key=value` sets one of the mod's options through `claude plugin configure`, once per option, under the linked id, such as `my-mod@Developer-linked`. It refuses a key the mod does not declare, and names the keys it does ([options.md](options.md)).

### cmod unlink

```text
cmod unlink [path]
```

Stops loading the checkout at `path` (default: the current folder) in every Claude Code session. Uninstalls it through Claude Code and takes it out of the marketplace in its parent folder. Once that marketplace lists no checkout, it uninstalls the cmod plugin the marketplace installed, removes the marketplace from Claude Code, and deletes its file and its line in `.git/info/exclude`. Then it turns back on the copy of the mod `cmod link` turned off, runs the checkout's uninstall step, and removes the program `cmod link` built, with its links.

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

Starts one throwaway Claude Code session with mods set up, for trying a mod by hand or testing it with an agent. Installs each mod's packages, installs the cmod plugin when Claude Code lacks it, and runs each mod's install step after asking consent. Then starts one Claude Code session that loads every mod with `--plugin-dir`.

- `--option key=value` sets one option of the mod. With several mods, write `--option <mod>.key=value`.
- The session runs with a new home folder, so it sees only the mods named here and changes none of your Claude Code settings, mods, key bindings, or history. The folder is deleted when the session ends.
- The session stays logged in as you, with no login screen:
  - On macOS, Claude Code reads your login from the keychain, which `cmod try` links into the new home as `~/Library/Keychains`. Deleting the home removes only the link.
  - Elsewhere, `CLAUDE_SECURESTORAGE_CONFIG_DIR` points Claude Code at the folder that holds your login, so it reads and refreshes that login where it is.
  - `ANTHROPIC_CONFIG_DIR` points at your `~/.config/anthropic` login profiles, and `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` pass through.
- The session keeps how Claude Code reaches the model and what it must never do, so a try is as safe as your own session. From your `settings.json` it keeps `env` (a proxy or `ANTHROPIC_BASE_URL`), the credential helpers (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper`, `proxyAuthHelper`), the login pins (`forceLoginMethod`, `forceLoginOrgUUID`, `forceLoginGatewayUrl`, `gatewayInternalNetworks`), `sandbox`, and `permissions.deny`. From `~/.claude.json` it keeps your account and the API keys you approved. A `~/` in a helper still means your own home. Hooks, plugins, allow rules, the model, and every other preference stay behind. Managed settings apply as always.
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

`cmod install`, `cmod update`, `cmod remove`, `cmod enable`, `cmod disable`, `cmod link`, `cmod unlink`, and `cmod try` write the time to `plugins-changed` in the cmod store, then write `store-changed` beside it, when they finish, also when they fail partway, such as an update that updated some mods. The cmod plugin of every running session watches `store-changed` and Claude Code's `installed_plugins.json`, reads the `enabledPlugins` of the user's `settings.json` each time Claude Code reports that file changed and at each prompt, and runs `/reload-plugins` in its session once `plugins-changed`, `installed_plugins.json`, or `enabledPlugins` changed and then stayed the same for 2 seconds, whether a `cmod` command, `/plugin`, `claude plugin`, or Claude Code's automatic update changed them, so an update of several plugins reloads once. A session in the middle of a turn reloads when the turn ends, a session no app shows, such as `claude -p`, never reloads, and the prompt the person is typing stays. After the reload, each plugin whose version changed shows a corner toast, `<plugin> updated to <version>`. An update that granted a permission always has its own toast, followed by each permission it granted, and more than 3 others show one toast, `<n> plugins updated`. A reload keeps the prompt cache: the next request reads the whole conversation from the cache and pays only for the plugins' new content. A reload clears each mod's `memory` state. A machine where cmod set up no mod has no store, and these commands write nothing there. `cmod permission` needs no reload, because a mod sees its grants change before its next call.

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
- `index` reads every saved conversation into the index at `~/.local/share/cmod/history-11.sqlite`, which holds where each message is in its transcript, not a copy of it, and each conversation's turns, contexts, and tasks. While a mod other than cmod holds the `conversation` permission, the cmod plugin runs it in the background at each session's start, and a second run while one is running exits at once. The index forgets a conversation whose transcript is deleted.

## Run in an install script

### cmod watch

```text
cmod watch
```

Tells every running session once a checkout `cmod link` linked builds after a change. It watches each linked folder, outside `node_modules` and `.git`, and skips a change to a file git ignores, such as the `.claude-plugin/types/` Claude Code writes each time it loads the mod. Once a folder has had no change for 2 seconds, it bundles the mod's hooks module as `cmod publish` does. A bundle that builds marks `plugins-changed`, so every session reloads its plugins, and shows no toast, because the version stays the same. A bundle that still fails 10 seconds after the last change shows `<mod> does not build` with the error as one toast in every session, and the toast goes once the mod builds. So an agent's half-written file reloads nothing and shows nothing. At its start it bundles again each mod whose failure it finds in `build-failures.json`, so a failure an older cmod wrote goes once the mod builds. The cmod plugin starts one only in a session that an app shows, once a mod is linked, at the session's start or later, so a machine with no linked mod runs none. The first holds `watch.lock` in the cmod store, watches, and touches its file there every 5 seconds. Another one exits at once while it runs, and the cmod plugin of each such session starts one again once that file is gone or 15 seconds old, so a machine runs one watcher however many sessions it has open. Before each touch it reads the newest cmod in the cmod store, the newest version folder of `bin/cmod` that the launcher runs. A `cmod watch` older than that exits and lets go of `watch.lock`, so after a cmod update the new cmod's watcher judges the linked mods by its own rules within 15 seconds.

A cmod before 4.1.0 linked a checkout by writing it into `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of Claude Code's `settings.json`. `cmod watch` at its start, and `cmod setup`, link each folder still in that list as `cmod link` does now and take it out of the list. A folder that fails to link stays in the list, and its error prints on stderr.

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

Refuses a machine the `os` and `cpu` keys of the mod's `package.json` leave out. Downloads the program its `cmod.program` names, or builds it from the checkout's `cli/` when `cmod link` loaded the mod, so a linked checkout whose version has no release yet still sets up, and links it into cmod's programs folder, which Claude Code runs it from by its name, and into `~/.local/bin` unless a file there is not cmod's. Runs the mod's install step, saves its uninstall step, grants the permissions its `cmod.permissions` lists, and records the mod as set up. A mod installed from a marketplace whose automatic updates the person has not turned on or off gets them turned on, through `"autoUpdate": true` on the marketplace's `extraKnownMarketplaces` entry in Claude Code's `settings.json`, and the consent question says so. The consent covers the scripts, the program, the hotkeys, and the permissions together, and an update asks again only for what changed. A permission an update adds is granted without asking, unless `preferences.json` in the cmod store holds `"asksBeforeUpdatePermissions": true`, and a permission the person turned off stays off ([install-steps.md](install-steps.md#consent)). An unchanged mod runs nothing. `--events` prints one event per line for a program to read, and the mod's install toast in Claude Code reads them. Before all of that, it links each folder a cmod before 4.1.0 left in `CLAUDE_CODE_PLUGIN_DIRS`, as [`cmod watch`](#cmod-watch) does.

### cmod teardown

```text
cmod teardown <plugin-name> [--events]
```

Runs a removed mod's saved uninstall step, then deletes its install record, the saved step, every version of its program, its data folder, and `instances/<plugin-name>/`, where its `singleInstance` programs keep their addresses, takes out each Claude Code setting it changed that still has the value it set, and forgets the scripts and the permissions the person approved for it. It keeps the mod's config folder, `~/.claude/cmods/<plugin-name>`. A failed uninstall step keeps the record, so `cmod teardown` can run again.

### cmod permission

```text
cmod permission <mod> <name> [value] on|off
```

Turns one permission of a set-up mod on or off, such as `cmod permission ci-watch model off` or `cmod permission ci-watch network api.github.com on`. A toggle in Settings runs it. It refuses a permission the mod's `package.json` `cmod.permissions` does not list, and the mod sees the change before its next call, with no reload ([permissions.md](permissions.md)).

### cmod hotkey

```text
cmod hotkey <mod> <hotkey> <combo>
```

Binds one hotkey of a mod to a new combo in Claude Code's `keybindings.json`, such as `cmod hotkey notes toggle ctrl+shift+n`, and removes the combo it had. It binds a hotkey without a default combo the same way. A combo in Settings, under the mod, Hotkeys, runs it, and so does the cmod plugin for its own two hotkeys at its first start. It refuses a combo that is not one, and a combo the person already bound to something else, with `<combo> already runs something else in ~/.claude/keybindings.json. Pick another combo.` The mod's next update keeps the combo ([mod.md](mod.md#hotkeys)).

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

### cmod task

```text
cmod task start <prompt> --title <title> [--clone] [--agent <type>] [--model <model>] [--cwd <folder>] [--json]
```

Starts a task in a new background Claude Code session, for a mod's `startTask` with `isBackground` and its `clone` ([session.md](session.md#act-on-a-session)). The task belongs to the session Claude Code names in `CLAUDE_CODE_SESSION_ID`, which the cmod plugin sets when it runs the command. It runs `claude --bg` on the prompt in `--cwd`, the current folder when it is left out, and with `--clone` runs `claude --resume <session> --fork-session --bg`, so the new session starts on a copy of the conversation. `--agent` and `--model` pick the agent definition and the model of a fresh session. It finds the new session's id from the 8 characters `claude --bg` prints, through `claude agents --json --all`, and passes the starting session and the task in the new session's `--settings` env, so its cmod plugin tells the starting session at its first stop that the task answered. It saves the task in cmod's data folder, so `cmod history tasks` of the starting session lists it, with the status `claude agents` gives it. It prints the task, as one line of JSON with `--json`.

### cmod program

```text
cmod program <mod> -- <command…>
```

Runs one copy of a mod's program for the whole computer, for a `program` job with `singleInstance` ([jobs.md](jobs.md#program)), which every session of the mod runs it for. The first one takes `instances/<mod>/<program>.json.lock` in the cmod store, runs the command without `CLAUDE_CODE_SESSION_ID`, because the copy serves every session, writes its first line on standard output, its address, with the copy's process to `instances/<mod>/<program>.json`, and prints it. Every other one prints the address in that file, then each new one as it changes, and tries the lock again whenever that folder changes and every 5 seconds, so it takes over once the holder exits. A lock whose process is gone counts as free. The holder stops its copy and gives up the lock on SIGTERM, SIGINT, or SIGHUP, and when the session that started it exits, which it checks every 5 seconds. When the copy exits on its own, the holder exits with the copy's exit code, and the copy's standard error passes through. A new holder that finds a copy an earlier holder left running sends it SIGTERM, then SIGKILL after 5 seconds, and starts its own copy only once that one is gone, so two copies never run at once.

### cmod option

```text
cmod option <name> <key> <value>
```

Sets one option of an installed plugin through `claude plugin configure`, the way `/config` sets it, such as `cmod option ci-watch branch main`. A list option takes its items separated by commas. It refuses a key the plugin's `plugin.json` `userConfig` does not declare. A field in Settings and the option questions a mod asks at its first start run it, and the mod reads the new value at its next start ([options.md](options.md)).
