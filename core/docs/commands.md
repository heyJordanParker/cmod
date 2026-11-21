# cmod commands

The `cmod` command of Claude Mod Manager (cmod) builds, checks, and publishes mods, and installs them. `npm i -g @cmodjs/cli` puts it on `PATH`. `cmod <command> --help` prints a command's arguments, and `cmod --version` prints the version.

Each command below restates what `cmod <command> --help` prints, for a mod author. The help text is the full word.

## Build a mod

### cmod new

```text
cmod new <name> [--project]
```

Creates a mod in `./<name>`: a `defineMod` with one listener, a view, a widget, and a hotkey that shows the view, a Skill, a test, and a `CHANGELOG.md` ([mod.md](mod.md#release-notes)). Then installs its packages.

- `<name>` is lowercase letters, digits, and `-`, starting with a letter.
- `--project` creates a project-scope plugin in `./.claude/skills/<name>/` of the repository in the current folder, which loads for everyone who trusts the repository. Run it in the repository's root.
- `CMOD_CORE` sets the `@cmodjs/core` dependency it writes. By default it writes `^<the version of this cmod>`. To build against an unreleased `@cmodjs/core`, point it at a packed tarball, such as `file:/path/to/cmodjs-core-<version>.tgz`. Only a `.tgz` works: a folder installs as links into that folder, and `claude plugin validate --strict` refuses the mod.
- When the packages fail to install, it deletes the new folder.

### cmod link

```text
cmod link [path] [--option key=value]...
```

Loads the checkout at `path` (default: the current folder) in every Claude Code session, the running ones too, in place of the installed mod. Installs the cmod plugin when Claude Code lacks it, unless the checkout is cmod itself. Then installs the checkout's packages, builds the program `cli/` declares and links it into cmod's programs folder and `~/.local/bin`, and runs the checkout's install step. The build is `bin/<program>/<version>/<program>.linked` in the cmod store, beside the released program of the installed copy, which it never replaces.

It loads the checkout through a marketplace cmod keeps in the checkout's parent folder:

1. It lists the checkout in `<parent>/.claude-plugin/marketplace.json`, named `<parent folder>-linked`, beside the cmod plugin from the `release` branch of `heyJordanParker/cmod`, so the mod's `cmod` dependency resolves in that marketplace. Every checkout linked from one folder shares its marketplace. The checkout's own `.claude-plugin/marketplace.json`, the one `cmod publish` writes, stays as it was.
2. It adds that file, and `<parent>/.claude/settings.local.json` beside it, to the parent's `.git/info/exclude` when the parent is inside a git repository.
3. It adds the marketplace to Claude Code with `claude plugin marketplace add <parent> --scope local`, which declares it in `<parent>/.claude/settings.local.json`, so the `settings.json` you share between computers holds no path of this one, the way `npm link` keeps a link out of the shared `package.json`. Then it installs `<mod>@<parent folder>-linked` from it, which loads the checkout's own files in every session, in any project, at the next reload.
4. It turns off the installed copy of the mod from any other marketplace, and records it in `links.json` in the cmod store, so `cmod unlink` turns that copy back on.

It refuses a parent folder whose `.claude-plugin/marketplace.json` cmod did not write. Once a change builds, `cmod watch` tells every session, and each one still running the old build offers Reload, 35 seconds after the last change and between turns. To test your edits without pressing Reload, start the session with `claude --plugin-dir <checkout>`: Claude Code then reloads the checkout by itself between turns, in that session only, and that session offers nothing for it.

- `--option key=value` sets one of the mod's options through `claude plugin configure`, once per option, under the linked id, `<mod>@<parent folder>-linked`. It refuses a key the mod does not declare, and names the keys it does ([options.md](options.md)).

### cmod unlink

```text
cmod unlink [path]
```

Stops loading the checkout at `path` (default: the current folder) in every Claude Code session. Uninstalls it through Claude Code and takes it out of the marketplace in its parent folder. Once that marketplace lists no checkout, it uninstalls the cmod plugin the marketplace installed, removes the marketplace and its declaration in `<parent>/.claude/settings.local.json` from Claude Code, and deletes its file and its line in `.git/info/exclude`. The line for `settings.local.json` stays while that file does, because Claude Code leaves it behind, empty. Then it turns back on the copy of the mod `cmod link` turned off and sets up the copy of the mod Claude Code still has, which keeps the mod's data and secrets and links the released program that copy already has, with no download, then deletes the program `cmod link` built. Only when Claude Code has no other copy does it run the checkout's uninstall step and remove what cmod set up.

### cmod check

```text
cmod check [path]
```

Runs every check this device can run on the mod at `path` (default: the current folder), each failure with its fix:

1. Installs its packages.
2. Checks its layout.
3. Checks that each step runs a script.
4. Checks that `package.json` `"os"` and `"cpu"` list only machines cmod runs mods on, darwin and linux on arm64 and x64, and that the install step downloads a program for each machine they list.
5. Checks the permission check. It adds `"approve": true` to `package.json` `"cmod"` when the mod allows or asks on Claude Code's permission check and `hooks/register.ts` calls `registerPermissionCheck`. It fails a mod whose `src/` hears the permission check while `register.ts` does not call `registerPermissionCheck`, and a mod on `@cmodjs/core` 5.0.0 or later whose `package.json` `"cmod"` still declares `"permissions"`, with the fix `Delete "permissions" from package.json "cmod", and write "approve": true there if the mod approves tool calls.`
6. Reads the metadata of every file in the mod, and names each file whose metadata cmod cannot read.
7. Writes the options `defineMod` declares into `.claude-plugin/plugin.json` `userConfig`, and its hotkeys into `package.json` `"cmod"` `hotkeys`, keeping each file's own formatting, so Claude Code shows the options in `/config` ([options.md](options.md)). It loads `hooks/register.ts` to read them, without starting the mod.
8. Writes the `cmod` dependency in `.claude-plugin/plugin.json` as `>=` the oldest cmod the `@cmodjs/core` the mod installed runs on, `oldestCmodVersion` in its `records.js`, such as `>=8.0.0`, so every newer cmod runs the mod. When the mod needs a newer cmod than that, such as one whose cmod plugin carries out a call the mod makes, write that minimum yourself as `>=` its version, such as `>=8.1.0`, and `cmod check` keeps it. It raises only a minimum below that oldest cmod, and writes any other range as `>=` that oldest cmod. A `@cmodjs/core` that does not export `oldestCmodVersion` runs on the cmod of its own version, so the range is `>=` that version, such as `>=4.3.4`. A mod still on `@cmodjs/core` 3 keeps its own range ([dependencies.md](dependencies.md#call-the-methods-mod-dependencies)). Claude Code turns a mod off when its cmod is older than that dependency, so `cmod check` first compares it with every cmod plugin Claude Code installed on this device. When an installed copy is older, it updates them as `cmod update cmod` does. When one is still older, as when your `@cmodjs/core` needs a cmod newer than every published one, the check fails, keeps the old dependency, and names the `@cmodjs/core` to install instead. When a cmod linked from a checkout is older, the check fails the same way and says to pull that checkout, because no update reaches it. On a device without Claude Code or without a cmod plugin, such as CI, it writes the dependency at once.
9. Checks the imports of every file the release ships, the files `cmod publish` would release. It fails a file that imports the `claude-code` module, because every type a mod writes comes from `@cmodjs/core` ([index.md](index.md#what-a-mod-is)). A provider's types file adds to that module with `declare module 'claude-code'`, which imports nothing, so the check keeps it. A folder the release leaves out, such as a library its `"files"` list does not name, may import anything.
10. Looks for prebuilt binaries outside `cli/`.
11. Builds the release in a temporary folder as `cmod publish` builds it, with its `"files"` list and its bundled hooks module, and validates the release with Claude Code, `claude plugin validate --strict`. So it fails on a path `plugin.json` names that `"files"` leaves out, a `"files"` path that matches no file in the mod, and each reason a bundle fails, and prints every line the validator writes. Then it deletes the folder.
12. Compiles it against Claude Code's API with `tsc`, with `tsconfig.json`, and then with `tests/tsconfig.json` when it exists. `cmod new` writes both: the root config leaves Bun out of `src/`, which runs inside Claude Code, and the tests config adds `bun-types`, so a test can run a real program with `Bun.spawn` or read files with `node:fs`. When `.claude-plugin/types/` is missing, as in a fresh clone or in CI, Claude Code writes it first: cmod loads the mod in one `claude -p` run with a config folder of its own and no model to reach, so the run sends nothing.
13. Lints it with `oxlint`.
14. Runs, with `bun test`, every test file that does not import `claude-code/testing`. When `bunfig.toml` names a `[test]` `root`, it runs only the test files under that folder, as `bun test` does.
15. Runs, with `claude plugin test`, the test files that import `claude-code/testing`. It skips this when none does.
16. Checks its name against other plugins. Only a project plugin, in `.claude/skills/<name>/` of a repository, runs this check: it fails when an installed or linked plugin has the same name and hides the project plugin. Any other mod passes it at once.

The checks that read the mod's files, the metadata, imports, binaries, permission check, and test files, skip every file git ignores, such as scratch work in an ignored folder, because no release holds it.

`cmod check` fetches `tsc` 7.0.2 and `oxlint` 1.86.0 into the cmod store the first time. A check it cannot run, such as one that needs Claude Code on a device without it, fails with the reason, and the later checks still run. It ends with a count of passed, failed, and skipped checks, and exits 1 when one failed.

### cmod try

```text
cmod try <owner/repo | path>... [--option key=value]... [--home <folder>] [-- claude arguments]
```

Starts one throwaway Claude Code session with mods set up, for trying a mod by hand or testing it with an agent. Installs each mod's packages, installs the cmod plugin when Claude Code lacks it, and runs each mod's install step. Then starts one Claude Code session that loads every mod with `--plugin-dir`.

- `--option key=value` sets one option of the mod. With several mods, write `--option <mod>.key=value`.
- The session runs with a new home folder, so it sees only the mods named here and changes none of your Claude Code settings, mods, key bindings, or history. The folder is deleted when the session ends.
- The session stays logged in as you, with no login screen:
  - On macOS, Claude Code reads your login from the keychain, which `cmod try` links into the new home as `~/Library/Keychains`. Deleting the home removes only the link.
  - Elsewhere, `CLAUDE_SECURESTORAGE_CONFIG_DIR` points Claude Code at the folder that holds your login, so it reads and refreshes that login where it is.
  - `ANTHROPIC_CONFIG_DIR` points at your `~/.config/anthropic` login profiles, and `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` pass through.
- The session keeps how Claude Code reaches the model and what it must never do, so a try is as safe as your own session. From your `settings.json` it keeps `env` (a proxy or `ANTHROPIC_BASE_URL`), the credential helpers (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper`, `proxyAuthHelper`), the login pins (`forceLoginMethod`, `forceLoginOrgUUID`, `forceLoginGatewayUrl`, `gatewayInternalNetworks`), `sandbox`, and `permissions.deny`. From `~/.claude.json` it keeps your account and the API keys you approved. A `~/` in a helper still means your own home. Hooks, plugins, allow rules, the model, and every other preference stay behind. Managed settings apply as always.
- `--home <folder>` runs in that folder and keeps it, so the next `cmod try --home <folder>` starts from it. `--home ~` runs in your own home, with your settings and mods.
- A checkout's program is built from its `cli/` the way `cmod link` builds it, with your own home and environment, so the build finds your toolchains and caches. A GitHub mod's program downloads from the GitHub release of the mod's version, so it fails until `cmod publish` has released that version.
- When the session ends, even when its terminal closes, it runs each mod's uninstall step and deletes its record, data folder, cache folder, approval, key bindings, and program, so the mod stays uninstalled. A checkout already set up from the same folder keeps its setup.
- A GitHub mod is cloned into a temporary folder, which is deleted too.
- A mod another folder has set up in that home is refused, so `cmod try` never replaces an installed copy.
- Arguments after `--` go to `claude`, such as `-- -p "hello"`. An agent tests a mod with one `cmod try <path> -- -p "<prompt>"` run.

### cmod log

```text
cmod log [<mod>] [--json]
```

Prints the Log that Settings shows in cmod's entry, newest first: each failure and warning a mod or cmod met in any session on this computer, with the text `Copy` gives, the versions of the mod, its `@cmodjs/core`, cmod, and Claude Code it happened on, and how often it repeated in its session ([ui.md](ui.md#toasts)). `<mod>` keeps one mod's entries, so an agent working on a mod reads what went wrong in every session without opening Settings. `--json` prints the entries as a list of `{ mod, id, level, message, details, at, firstAt, count, session, versions }`.

### cmod publish

```text
cmod publish [path] [--dry-run]
```

Releases the mod at `path` (default: the current folder) at the version in its `plugin.json`.

1. Runs the checks of `cmod check` that read what the release ships, steps 2 to 10 of `cmod check`, and releases nothing when one fails, so a mod whose layout, steps, options, `cmod` dependency, or imports are wrong never reaches the people who install it. It runs no `tsc`, lint, or tests: `cmod check` runs those on each commit, on your computer and in CI, and the release is built from a commit they already passed, as `cargo publish` builds a crate and runs none of its tests. Where `cmod check` writes a fix, such as the options `defineMod` declares into `userConfig`, its hotkeys, or the `cmod` dependency, `cmod publish` fails that check instead and leaves the file as it is, with the fix `Run cmod check, which writes it, commit <file>, then run the command again.` So `--dry-run` changes no file either.
2. Builds the release from the files git does not ignore, leaving out `cli/`, `.github/`, and `.claude/`. A `"files"` list in `package.json` limits the release to the paths it lists, a path in those three folders included, such as `cli/bin/<launcher>`, plus the folders of the install and uninstall steps, `.claude-plugin/`, `package.json`, `tsconfig.json`, the README, the license, and `CHANGELOG.md`, the way `npm publish` reads it. `tsconfig.json` holds the JSX settings the bundle in step 3 needs. List every folder the hooks module imports from, such as `"files": ["hooks", "src", "skills"]`, because the bundle in step 3 is built from the release.
3. Bundles the hooks module that `hooks/hooks.json` names, with the mod's source and packages, into one readable `.js` file, writes each control character in it as a `\u` escape, and points `hooks/hooks.json` at it. Anthropic's plugin directory reads a repository without installing its packages, so it can follow a mod only when all its code is in one file. Without `"approve": true` in `package.json` `"cmod"`, the bundle leaves out the code that allows and asks on Claude Code's permission check, because Anthropic's plugin directory does not list a mod that can approve Claude's tool calls ([mod.md](mod.md#register-the-mod-with-claude-code)).
4. Checks the release's `.claude-plugin/plugin.json`, and its `.claude-plugin/marketplace.json` when it has one, with `claude plugin validate --strict`, and stops with every line the validator writes when it fails. `cmod check` builds and validates the release the same way, so it fails first.
5. Commits the release as the `release` branch, and builds the release archive from that commit.
6. Builds the program `cli/` declares, and writes `SHA256SUMS` for every file of the release.
7. Writes `.claude-plugin/marketplace.json`, listing the archive, the cmod plugin, and each other mod `plugin.json` depends on. The cmod entry points at the `release` branch of `heyJordanParker/cmod`, so the mod's `"cmod"` dependency resolves in this marketplace and follows each cmod release with no new publish of the mod. Each other dependency's entry points at the `release` branch of the GitHub repository of the marketplace Claude Code added on your computer that lists it ([dependencies.md](dependencies.md#call-the-methods-mod-dependencies)).
8. Commits that file, tags `v<version>`, tags the release commit `<name>--v<version>`, which Claude Code installs a version range from when a marketplace lists the mod from its git repository, pushes both tags and the `release` branch, creates the GitHub release with every file, then pushes the branch that holds `marketplace.json`. So Claude Code never updates anyone to a release whose files are not up yet. Its notes are the version's section of the committed `CHANGELOG.md`, above GitHub's compare link ([mod.md](mod.md#release-notes)). `--dry-run` prints them.
9. Prints the link to paste as the Repository when you submit the mod at [claude.ai/directory/manage](https://claude.ai/directory/manage), such as `https://github.com/owner/my-mod/tree/release`. The portal reads the branch from the link, so the directory follows `release`.

The release keeps `package.json`, so Claude Code still installs the mod's packages for its install and uninstall steps. It keeps `bun.lock` too, unless a `"files"` list leaves it out. `main` keeps the source only.

It needs, and refuses to start without:

- the mod's folder as the root of a git repository with at least one commit, because the release is committed as the `release` branch
- a `## [<version>]` section with notes in the committed `CHANGELOG.md`
- `node_modules` in the mod's folder, from `bun install`, when the hooks module imports a package
- each mod `plugin.json` depends on, other than cmod, listed in a GitHub marketplace Claude Code added on your computer, so install it from its marketplace first
- a `register` declared as a function in the hooks module, as `cmod new` writes it, because the validator refuses a bundled `register` that is not one
- the `claude` command, which validates the release
- an `origin` remote on GitHub
- a `package.json` with no dependency on a `file:` or `link:` path, which no user has
- a `"files"` list, when `package.json` has one, whose every path matches a file in the mod
- a `"program"` in the `cmod` key of `package.json` that names the program `cli/` declares, when `cli/` declares one
- a `cmod` dependency in `.claude-plugin/plugin.json` of `>=` the oldest cmod the `@cmodjs/core` the mod bundles runs on, which `cmod check` writes
- for a real publish, a working tree with no uncommitted changes, no `v<version>` or `<name>--v<version>` tag yet, a `git push` to `origin` that succeeds, and the `gh` command, which creates the GitHub release

`--dry-run` builds everything into a temporary folder, and pushes nothing. It writes `marketplace.json` there too, so the working tree stays as it was. It allows uncommitted changes and an existing tag, and builds from the working tree, uncommitted changes included. It prints the folder that holds the release, so you can read what the directory will read. A real publish deletes that folder once the release is out.

## Install mods

`cmod install`, `cmod update`, `cmod remove`, `cmod enable`, `cmod disable`, `cmod link`, `cmod unlink`, and `cmod try` write the time to `plugins-changed` in the cmod store, then write `store-changed` beside it, when they finish, also when they fail partway, such as an update that updated some mods. The cmod plugin of every running session watches `store-changed` and Claude Code's `installed_plugins.json`, and reads the `enabledPlugins` of the user's `settings.json` each time Claude Code reports that file changed and at each prompt, whether a `cmod` command, `/plugin`, `claude plugin`, or Claude Code's automatic update changed them. While `plugins-changed`, `installed_plugins.json`, or `enabledPlugins` differs from what the session loaded, the session keeps running the plugins it loaded and shows one `Plugins changed` toast with a Reload button. It names each change, such as `my-mod updated to 1.3.0` or `my-mod turned on`, or counts them past 3, and each further change updates the same toast. The person presses Reload, which runs `/reload-plugins`, or when the turn ends if Claude is working, and the prompt the person is typing stays. A change back to what the session loaded, or the person's own `/reload-plugins`, takes the toast away. A session no app shows, such as `claude -p`, shows nothing. A reload keeps the prompt cache: the next request reads the whole conversation from the cache and pays only for the plugins' new content. A reload clears each mod's `memory` state. A device where cmod set up no mod has no store, and these commands write nothing there.

### cmod install

```text
cmod install <owner/repo | path> [name] [--option key=value]...
cmod install <name | name@marketplace> [--option key=value]...
```

Adds the plugin's marketplace to Claude Code and installs the plugin through Claude Code. A mod also gets the cmod plugin when Claude Code lacks it, and its install step runs. Any other plugin installs through Claude Code alone, and cmod keeps no record of it.

- When the marketplace lists several plugins, name the one to install after it.
- Given `name@marketplace` of a marketplace Claude Code has added, it installs that plugin.
- Given the name of a plugin Claude Code already holds, it runs a mod's install step again.
- A path holds a `/`, such as `./my-mod`. A folder's marketplace is declared in that folder's `.claude/settings.local.json`, so the `settings.json` you share between computers holds no path of this one, and an `owner/repo` marketplace is declared in `settings.json`. In a git checkout, that file goes into `.git/info/exclude`, so `git status` stays clean. `cmod remove` keeps the line, because the marketplace and its file stay after the plugin is gone.
- `--option key=value` sets one of the mod's options through `claude plugin configure`, once per option, so a scripted install needs no visit to `/config`. It refuses a key the mod does not declare, and names the keys it does ([options.md](options.md)).

### cmod update

```text
cmod update [name]
```

Updates the named plugin, or every plugin Claude Code has installed, through Claude Code, then runs the install step of each mod whose version or scripts changed. A linked plugin is skipped, because saving its files updates it. When Claude Code fails to update a plugin, `cmod update` names it, updates the rest, and exits 1. Every running session then loads the new version.

### cmod remove

```text
cmod remove <name>
```

Uninstalls the plugin through Claude Code. When cmod set the plugin up as a mod and Claude Code still has another copy of it, such as one from another marketplace or a linked checkout, it sets that copy up, which keeps the mod's data and secrets. When no copy is left, it runs the uninstall step cmod saved and removes what cmod set up.

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

Lists every plugin Claude Code has installed or linked, with its version. A mod shows whether cmod set it up, and any other plugin shows whether Claude Code enabled it. A plugin Claude Code turned off shows Claude Code's reason, such as `Requires "cmod@market" >=4.2.0, installed 4.0.0`. It also lists every mod Claude Code removed whose uninstall step has not run yet. A mod that runs a program as a service of this computer, for a `program` job with `isService` ([jobs.md](jobs.md#program)), names it, as in `ready, runs <program> as a service of this computer`.

- `--json` prints the list as JSON: one object per row with its `name`, `version`, `state`, and `unsatisfied`, the dependencies Claude Code turned the plugin off for because they are older than the plugin needs. A plugin whose folder exists also has `folder`, the folder it runs from: the checkout for a linked mod, and Claude Code's copy for any other. A mod also has `dataFolder`, and the two are the folders its `mod.folder` and `mod.dataFolder` name. A mod that runs programs as services of this computer also has `services`, their names. A removed mod has only `dataFolder`, because its data stays until `cmod teardown` deletes it.

- The `cmod` commands count a plugin as a mod only when its `package.json` has a `cmod` step key or cmod holds an install record for it. A mod made with `cmod new` has neither until its first Claude Code session sets it up, so until then `cmod list` shows it as `enabled`, like any other plugin.

## Read your conversations

### cmod sessions

```text
cmod sessions list [--every-project] [--since 2d] [--running] [--project <folder>] [--json]
cmod sessions search <text> [--every-project] [--since 2d] [--running] [--project <folder>] [--session <id> [--task <id>] [--turn <id>] [--context <n>] [--agent]] [--limit <n>] [--before <session>:<id>] [--json]
cmod sessions read messages [<session>] [--task <id>] [--turn <id>] [--after <id>] [--last <n>] [--json]
cmod sessions read turns [<session>] [--task <id>] [--context <n>] [--last <n>] [--json]
cmod sessions read contexts [<session>] [--task <id>] [--json]
cmod sessions read tasks [<session>] [--task <id> | --nested] [--json]
cmod sessions read goal [<session>] [--task <id>] [--json]
cmod sessions read usage [<session>] [--task <id>] [--json]
cmod sessions read state [<session>] [--json]
cmod sessions read <part> <session> --transcripts <folder> [--json]
cmod sessions follow [<session>...] [--running] [--json]
cmod sessions index
```

Reads every conversation Claude Code saved, as the sessions, contexts, turns, tasks, and messages `sessions` answers a mod ([session.md](session.md)), so a person or an agent reads them in a terminal without parsing a transcript. `list`, `search`, and `read` are the `sessions`, `search`, and `read` calls of the `cmod/Sessions` interface.

- `list` lists the conversations of the current folder's project, or `--project`'s, newest first, each with its time, id, and title. `--every-project` lists every project's, `--since` keeps those active in the last `30m`, `6h`, `2d`, or `1w`, or since a date such as `2026-10-01`, and `--running` keeps those open in Claude Code now.
- `search` prints the newest 50 messages whose text or tool input contains the text, at least 3 characters, any case, each with its time and session. Each tool input value is searched in its first 1,024 characters, and tool results are not searched. `--every-project`, `--since`, and `--running` scope it as they scope `list`, `--limit` changes the 50, and `--before <session>:<id>` prints the page after the message it names, the last one of the page before. `--session` searches one conversation, and inside it `--task` searches a task and the tasks it started, `--turn` one turn, `--context` one context, and `--agent` keeps the main agent's messages, or with `--task` that task's own, without the tasks it started.
- `read messages` prints one conversation's messages in order: the session named, or the one the command runs in when Claude Code runs it. `--task` reads a task's messages instead, `--turn` keeps one turn's, `--after` starts after a message id, and `--last` keeps that many from the end.
- `read turns` prints the conversation's turns, each opened by a prompt and closed when Claude finishes. `--context` keeps one context's, and `--last` keeps that many from the end. With `--json`, a turn names the `device` it ran on, as `Turn.device` does ([session.md](session.md#turn-context-goal-and-task)).
- `read contexts` prints the conversation's contexts, a new one after each compaction.
- `read tasks` prints the tasks the conversation started, with `--task` the tasks that task started, and with `--nested` every task at any depth.
- `read goal` prints what the conversation is for: the goal a mod set, or its first prompt.
- `read usage` prints the model and the context's tokens as of the last reply.
- `--task` reads the `turns`, `contexts`, `goal`, and `usage` of the session a task's owner runs, the way they read the conversation's.
- `read state` prints what a running conversation resumes from. It reads the index without writing to it, so it never waits for another cmod that is writing the index.
- `read --transcripts <folder>` reads the conversation from the transcripts in `<folder>/projects`, a Claude Code folder such as one copied from a computer that is off, through an index of its own that lives only while the command runs. So the index of this computer's conversations never lists it, and a mod that serves another device's sessions answers `cmod/Sessions` `read` in cmod's own shapes. It takes every flag each part takes.
- `follow` prints each message, turn, context, task, and goal change of the sessions named as Claude Code saves it, until stopped with Ctrl+C. `--running` follows every running session of the project too, and each one that starts later.
- `--json` prints JSON instead of one line each.
- `index` reads every saved conversation into the index at `~/.local/share/cmod/history-13.sqlite`, which holds where each message is in its transcript, not a copy of it, and each conversation's turns, with the device each ran on, contexts, and tasks. While cmod has set up a mod other than cmod, the cmod plugin runs it in the background at each session's start, and a second run while one is running exits at once. The index forgets a conversation whose transcript is deleted.

A cmod plugin before 8.0.0 runs `cmod history`, with `sessions` for `list`, each part of `read` without `read`, and `--all` for `--every-project`, which still works.

### cmod ui

```text
cmod ui list <widgets|views|pages> <session>
cmod ui draw <session> <mod> <id> [--columns <n>] [--surface <surface>] [--area <area>]
cmod ui press <session> <handler> [<json>]
cmod ui open <session> <mod> <id>
cmod ui close <session> <mod> <id>
cmod ui show <session> <client> [<mod>/<id>...] [--host]
cmod ui follow [<session>...] [--after <cursor>]
```

Reaches each running session's widgets, views, and pages as an app that draws them does, such as cmod's Herdr mod ([ui.md](ui.md#herdr-draws-them-through-cmod-ui)). Each one is a call of the `cmod/UI` interface ([ui.md](ui.md#every-app-reaches-them-through-cmod-ui)) through `cmod serve`, which sends it to the cmod plugin of the session it names, and prints the answer as JSON. A session no cmod plugin on this computer holds fails with `No session <session> runs on this computer, so it shows no UI.`

- `list` prints the session's widgets, each `{ mod, id, areas }`, or its views or pages, each `{ mod, id, title }`.
- `draw` prints the widget, view, or page as element data, with each handler as `{ "$cmodHandler": <number> }`, or `null` while the mod has not drawn it yet. `--columns` is the width it draws in, 80 unless given, and `--surface` the app that draws it: `terminal`, the default, `desktop`, `mobile`, `vscode`, `browser`, or `herdr`. `--area` is the area a widget shows in, one of the areas it lists: `abovePrompt`, `belowPrompt`, `working`, `turnEnd`, or `dashboard`. Without it, a widget draws for the Dashboard when it lists the Dashboard, else for its first area. For `turnEnd`, it draws the session's last finished turn, and prints `null` before the first one finishes.
- `press` runs the handler with that number from one of the part's last two drawings, with the press `<json>` gives: `{ surface, key, kind, value, link }`, whose `surface` is `terminal` unless it names one.
- `open` and `close` show or take away the view or page in the session's Sidebar.
- `show` tells which views and pages one place an app draws in shows, as `cmod/UI` `show` does ([ui.md](ui.md#every-app-reaches-them-through-cmod-ui)), so each one counts as `isShown` in its mod. `<client>` names that place, and each part is `<mod>/<id>`. It replaces that client's last list, a run with no parts clears it, and `cmod serve` forgets a list 16 seconds after its client's last `show`, so an app runs it again before then. `--host` says the place hosts the session's views, as `isHost` does, and a run with `--host` and no parts keeps the host.
- `follow` prints the next batch of `Change`, `Redraw`, `Open`, and `Close` events of the sessions named, or of every session, as `{ cursor, events, missed }`, and exits: at once when events came after the `--after` cursor, else on the next event, else after 8 seconds, the time `cmod serve` answers each poll within. Each event is `{ event: "Change", session, part }`, `{ event: "Redraw", session, mod, id }`, or `{ event: "Open" or "Close", session, mod, id }` for a view or page its mod opened or closed itself, and an `Open` the person asked for carries `isAsked: true`. Pass the `cursor` it printed to `--after` on the next run, so a loop that runs it again misses no event. `missed` is true when the events before the cursor are unknown: on a run without `--after`, once `cmod serve` started again, or once more events passed than `cmod serve` keeps, 500 of each. Then read every list and drawing again.

### cmod run

```text
cmod run <file> [arguments…]
```

Runs a TypeScript script that reads and drives sessions, for a person or an agent at a terminal. The script imports `sessions` from `@cmodjs/core/mod.js`, as a mod does, and `cmod run` connects it to `cmod serve` ([cmod serve](#cmod-serve)): `sessions.list`, `sessions.get`, and `sessions.search` read every session on this computer and through each sessions provider ([session.md](session.md#sessions-providers)), and a session's `send`, `fork`, and `end` reach the session that runs it. A script hears no session, because a listener lives in the session it listens to, as a mod hears only the session it runs in, so its `on` and `before` methods throw `<script>: <method> works only in a mod's own session.` The script also imports `provide` and `providers`, which reach the programs that provide interfaces on this computer through the same connection to `cmod serve`, and a `provide` answers every session while the script runs ([dependencies.md](dependencies.md#interfaces-several-mods-answer-one-name)). The script reads its arguments from `Bun.argv[2]` on. Any other import of `mod.js` throws `a cmod run script imports only sessions, provide and providers from @cmodjs/core/mod.js`, because it belongs to a Claude Code session. `cmod run` ends once the script's top level has run.

```ts
import { Prompt, sessions } from '@cmodjs/core/mod.js'

const session = await sessions.get(Bun.argv[2])
const [last] = await session.messages({ last: 1 })
console.log(last?.type === 'reply' ? last.text : session.title)
await session.send({ type: Prompt, text: 'Run the tests again.' })
```

### cmod web

```text
cmod web
```

Opens the browser app at `http://127.0.0.1:<port>/` and prints that address. The browser app lists every Claude Code session that runs on the computer, in every project, and every running session of each sessions provider, in four groups: Needs you (a permission prompt, a question, or a turn that failed or was stopped), Replied (an answer the person has not opened), Working, and Idle. A session opens its conversation with a prompt box under it, which sends the text as the person's own prompt in that session, a Stop button while it works, and a tab for each of its views, the cmod plugin's Dashboard, History, and Settings among them, and each page open in it, where a press, a text, or a pick runs the mod's handler in that session. `j` and `k` move between sessions, `Enter` opens one and puts the cursor in its prompt box, `Esc` returns to the list, `e` marks a reply done, and `u` marks it unread. A permission prompt or a question is answered in the session's terminal. The browser app runs while `Show the Sidebar in your browser` is on in Settings, under cmod, Preferences, which `open in browser` on the Sidebar's key bar turns on and runs this command. When it does not run, `cmod web` exits 1 and says so. It opens the address by the rule a `Button` with `href` follows ([ui.md](ui.md#a-button-opens-a-web-page-with-href)): with the program `BROWSER` names, else `open` on macOS and `xdg-open` on Linux. Over ssh, on Linux with no display, or with `BROWSER` set to `true`, it opens nothing, prints the address, and exits 1 with `this computer has no browser to open, so open the address above yourself.` When the opener fails, it exits 1 after it printed the address. While the browser app is on the person's tailnet ([cmod program](#cmod-program)), it also prints `From your other devices: https://<computer>.<tailnet>.ts.net:<port>/`, which opens the browser app from each of the person's devices.

## Run in an install script

### cmod watch

```text
cmod watch
```

Tells every running session once a checkout `cmod link` linked builds after a change, so each one still running the old build offers Reload. It watches each linked folder, outside `node_modules` and `.git`, and skips a change to a file git ignores, such as the `.claude-plugin/types/` Claude Code writes each time it loads the mod, a change inside the program's `output` folder, and a change to a file that is gone again and git does not track, such as a build's temporary file. Once a folder has had no change for 2 seconds, it bundles the mod's hooks module as `cmod publish` does. When a changed file is one the program's build reads, a file in `cli/` or one the JavaScript or TypeScript file `cli/package.json` `bin` names imports, such as the mod's own `src/`, it also builds the program `cli/` declares and links it as `cmod link` does, so the program in cmod's programs folder is never older than the mod. A change no program build reads builds no program. A program whose build failed builds again at the next change, whatever it changed. A build that changes the program stops its running copy, so a `singleInstance` or `isService` program restarts on the new build ([cmod program](#cmod-program)), and a build that writes the same program leaves the file and the copy as they are. A mod that builds writes the time of its last change to `plugins-changed`. A session that has not started the mod since then shows the `Plugins changed` toast once 35 seconds passed since the change and no turn runs, the time Claude Code takes at most to restart a `--plugin-dir` copy by itself, and no session reloads by itself. A bundle or program build that still fails 10 seconds after the last change shows `<mod> does not build` with the error as one toast in each session working inside the checkout, the last program that built keeps running, and the toast goes once the mod builds. So an agent's half-written file offers nothing and shows nothing. At its start it bundles again each mod whose failure it finds in `build-failures.json`, so a failure an older cmod wrote goes once the mod builds. The cmod plugin starts one only in a session that an app shows, once a mod is linked, at the session's start or later, so a device with no linked mod runs none. The first holds `watch.lock` in the cmod store, watches, and touches its file there every 5 seconds. Another one exits at once while it runs, and the cmod plugin of each such session starts one again once that file is gone or 15 seconds old, so a device runs one watcher however many sessions it has open. Before each touch it reads the newest cmod in the cmod store, the newest version folder of `bin/cmod` that the launcher runs. A `cmod watch` older than that exits and lets go of `watch.lock`, so after a cmod update the new cmod's watcher judges the linked mods by its own rules within 15 seconds. It also exits once the process that started it ends, so a session that crashed leaves no watcher behind.

A cmod before 4.1.0 linked a checkout by writing it into `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of Claude Code's `settings.json`. `cmod watch` at its start, and `cmod setup`, link each folder still in that list as `cmod link` does now and take it out of the list. A folder that fails to link stays in the list, and its error prints on stderr.

### cmod download

```text
cmod download <program> <machine> <url> <sha256> [<machine> <url> <sha256> …]
```

Downloads a program for an install script: fetches the download for this machine, checks its SHA-256, unpacks it, and moves `<program>` to `$CMOD_CACHE/bin/<program>`, the mod's cache folder. It links cmod's programs folder and `$CMOD_DATA/bin/<program>`, where cmod 7 put it, to that file. Before the install step, `cmod setup` moves each program cmod 7 downloaded to `$CMOD_DATA/bin/` there and leaves that link in its place. [install-steps.md](install-steps.md#download-a-program-in-an-install-step) explains it.

## Run from a mod's program

A mod's own program runs outside any session, as one copy per computer or over `ssh` on a computer with no Claude Code open. These give it what a mod reads in a session.

### cmod options

```text
cmod options get <mod> [--project <folder>]... [--json]
cmod options set <mod> <key> <value>
```

`get` prints a mod's option values in two levels. `person` holds the values the person set in `/config`. `projects` holds the values each project's committed `.claude/cmods/<mod>/options.json` sets, keyed by the project's git root as `git rev-parse --show-toplevel` prints it, or by the project's own folder outside git. With no `--project`, it reads every project cmod's conversation index holds a session of, and lists only those whose `options.json` exists. It leaves out secrets, and the entries a session would ignore, and names each of those on stderr. A session uses a project's value over the person's, and a value the person's organization locks over both, which this command cannot read outside Claude Code. `--json` prints `{ person, projects }`:

```json
{ "person": { "<option>": "<value>" }, "projects": { "<project>": { "<option>": "<value>" } } }
```

`set` sets one option of an installed plugin through `claude plugin configure`, the way `/config` sets it, such as `cmod options set my-mod branch main`. A list option takes its items separated by commas. It refuses a key the plugin's `plugin.json` `userConfig` does not declare. A field in Settings and the option questions a mod asks at its first start run it, and the mod reads the new value at its next start ([options.md](options.md)).

A mod built on `@cmodjs/core` before 8.0.0 runs `cmod options <mod>` for `get` and `cmod option <mod> <key> <value>` for `set`, and both still work.

### cmod device

```text
cmod device [--json]
```

Prints the computer as a mod's `device.read()` gives it: its id, name, operating system, and architecture ([mod.md](mod.md#device-the-computer-the-session-runs-on)). It runs the same reader, so a program names each computer by the id its mod sees. `--json` prints `{ id, name, os, arch }`. On a computer with no machine id, it exits 1 and says so.

### cmod data

```text
cmod data [--json]
```

Prints the data folder of each mod cmod set up, the folder its `mod.dataFolder` names, so a program that moves a person's work to another computer knows what to copy. It reads the mods from the install records in the cmod store, as `cmod list` does, adds the cmod plugin, which has no install record but keeps each session's goal, tasks, and Log in its data folder, and leaves out a mod whose data folder does not exist. It leaves out each `mod.cacheFolder`, such as the programs `cmod download` fetches, because a mod builds that folder again wherever it is missing ([mod.md](mod.md#mod-this-mod)). It leaves out `secrets.json`, which sits at the root of the cmod store, outside every data folder. It prints one `<mod> <folder>` line for each mod, and `--json` prints a list:

```json
[{ "mod": "<mod>", "folder": "<absolute path of its data folder>" }]
```

## Run by cmod

cmod runs these itself. A person runs them to see a step's whole log, or to finish a step.

### cmod setup

```text
cmod setup <plugin-root> [--events]
```

Refuses a machine the `os` and `cpu` keys of the mod's `package.json` leave out. Downloads the program its `cmod.program` names, or builds it from the checkout's `cli/` when `cmod link` loaded the mod, so a linked checkout whose version has no release yet still sets up, and links it into cmod's programs folder, which Claude Code runs it from by its name, and into `~/.local/bin` unless a file there is not cmod's. Runs the mod's install step, saves its uninstall step, binds its hotkeys, and records the mod as set up, asking nothing first ([install-steps.md](install-steps.md#when-the-steps-run)). Linking a new version stops the running copy of a program the mod runs as one copy or as a service of the computer, so it restarts on the new program, and an install step that fails links the old version back and stops the new one's copy the same way ([cmod program](#cmod-program)). A mod installed from a marketplace whose automatic updates the person has not turned on or off gets them turned on, unless the marketplace is a folder, which Claude Code reads in place, through `"autoUpdate": true` on the marketplace's `extraKnownMarketplaces` entry in Claude Code's `settings.json`, and the setup says so. An unchanged mod runs nothing. `--events` prints one event per line for a program to read, and the mod's install toast in Claude Code reads them. Before all of that, it links each folder a cmod before 4.1.0 left in `CLAUDE_CODE_PLUGIN_DIRS`, as [`cmod watch`](#cmod-watch) does.

### cmod teardown

```text
cmod teardown <plugin-name> [--events]
```

Runs a removed mod's saved uninstall step, then deletes its install record, the saved step, every version of its program, its data folder, its cache folder, and `instances/<plugin-name>/`, where its `singleInstance` and `isService` programs keep each running copy's pid and address, stops and deletes each service of the computer it runs a program as, with its record and log in `services/<plugin-name>/` ([cmod program](#cmod-program)), takes each web app it put on the person's tailnet off it and deletes `tailnet/<plugin-name>/`, takes out each Claude Code setting it changed that still has the value it set, deletes its secrets ([cmod secrets](#cmod-secrets)), and deletes its entry in `consent.json`. It keeps the mod's config folder, `~/.claude/cmods/<plugin-name>`. A failed uninstall step keeps the record, so `cmod teardown` can run again.

### cmod hotkeys

```text
cmod hotkeys set <mod | plugin-root> <hotkey> <combo>
```

`set` binds one hotkey of a mod to a new combo in Claude Code's `keybindings.json`, such as `cmod hotkeys set my-mod toggle ctrl+shift+n`, and removes the combo it had. It binds a hotkey without a default combo the same way. A plugin root holds a `/`, such as `./my-mod`, so a mod Claude Code loads with `--plugin-dir`, which has no install record, binds its hotkeys too. A combo in Settings, under the mod, Hotkeys, runs it, and so does the cmod plugin for its own two hotkeys at its first start, with its own plugin folder. It refuses a combo that is not one, and a combo the person already bound to something else, with `<combo> already runs something else in ~/.claude/keybindings.json. Pick another combo.` The mod's next update keeps the combo ([mod.md](mod.md#hotkeys)). A cmod plugin before 8.0.0 runs `cmod hotkey` with the same arguments, which still works.

### cmod secrets

```text
cmod secrets store <mod> <key>
cmod secrets get <mod> <key>
cmod secrets delete <mod> <key>
```

Keeps a mod's secrets, for `mod.secrets` and the mod's own programs ([mod.md](mod.md#mod-secrets)). `store` reads the value from stdin, such as `printf '%s' "$TOKEN" | cmod secrets store my-mod token`, and refuses a terminal, where the value would show, and an empty value. `get` prints the value to stdout as it was stored, with no newline added, and prints nothing for a secret the mod does not have. `delete` removes one secret. A value never goes in the arguments, where every process on the computer can read it. A mod built on `@cmodjs/core` before 8.0.0 runs `cmod secret` with the same arguments, which still works.

Every mod's secrets live as plain values in `secrets.json` at the root of the cmod store, mode 600, as `{ "<mod>": { "<key>": "<value>" } }`, on every platform and with no keychain. A value cmod 7.0.0 or older sealed on macOS is opened once with the `cmod Safe Storage` key in the login keychain and written back plain, the first time it is read or the file changes. `cmod teardown` deletes the secrets of a removed mod.

### cmod settings

```text
cmod settings update <mod> <user|project|local> <json> [--project <folder>]
```

`update` changes Claude Code settings for a set-up mod, as its `settings.user.update`, `settings.project.update`, and `settings.local.update` do ([mod.md](mod.md#settings-claude-code-s-settings-files)), such as `cmod settings update my-mod user '{"env":{"EDITOR":"vim"}}'`. It merges the JSON object into the user, project, or local settings as a JSON Merge Patch: an object merges into the object already there, `null` removes the key, and an array or any other value replaces it. The project and local settings are those of `--project`, the current folder when it is left out, and `mcpServers` in the project settings goes to `.mcp.json`. cmod keeps every other key and the file's formatting, and `cmod teardown` takes out each value the mod set that is still the same, then each object that leaves empty. A cmod plugin before 8.0.0 runs `cmod settings <mod> <user|project|local> <json>`, with no `update`, which still works.

### cmod rules

```text
cmod rules sync [--project <folder>] [--plugin <folder>] [--json]
```

`sync` links the `rules/` folder of each mod that is on into Claude Code's rules folder, and removes the link of each that is off or removed ([mod.md](mod.md#rules)). A mod the person installed links at `<config>/rules/<mod>`, and one turned on only for `--project`, the current folder when it is left out, links at `<project>/.claude/rules/<mod>`. It prints the rules it linked. With `--json` it prints `{ linked, placed, removed, watched }`, where `placed` and `removed` name the mods whose link this run made or took away, and `watched` lists the files and folders whose change can change the next run. `--plugin` names the cmod plugin's own folder, whose `rules/` links for every project, because the cmod plugin has no install record. `cmod install`, `update`, `remove`, `enable`, `disable`, `setup`, `teardown`, `link`, and `unlink` run it after they succeed. The cmod plugin runs it with `--plugin` when a session starts and before a prompt, each time only when a `watched` path changed since its last run. A cmod plugin before 8.0.0 runs `cmod rules` with no `sync`, which still works.

### cmod task

```text
cmod task start <prompt> --title <title> [--clone [--at <message>]] [--agent <type>] [--model <model>] [--cwd <folder>] [--json]
```

Starts a task in a new background Claude Code session, for a mod's `startTask` with `isBackground` and its `fork` with `isBackground` ([session.md](session.md#act-on-a-session)). The task belongs to the session Claude Code names in `CLAUDE_CODE_SESSION_ID`, which the cmod plugin sets when it runs the command. It runs `claude --bg` on the prompt in `--cwd`, the current folder when it is left out. With `--clone` it first writes a fork of that session's conversation as a new transcript beside it, as Claude Code's own fork writes one: each message of the conversation's current branch, from its first through its last, or through the message `--at` names and nothing after it, each naming the message it copies in `forkedFrom`. It then runs `claude --bg --resume <fork>`, so the new session carries on from the copy. `--agent` and `--model` pick the agent definition and the model of a fresh session. It finds the new session's id from the 8 characters `claude --bg` prints, through `claude agents --json --all`, and passes the starting session and the task in the new session's `--settings` env, so its cmod plugin tells the starting session at its first stop that the task answered. It saves the task in cmod's data folder, so `cmod sessions read tasks` of the starting session lists it, with the status `claude agents` gives it. It prints the task, as one line of JSON with `--json`.

### cmod program

```text
cmod program <mod> [--web-app] [--no-wait | --service [--env <name>]... [--process-type <type>] | --remove-service] -- <command…>
```

Runs one copy of a mod's program for the whole computer, for a `program` job with `singleInstance` ([jobs.md](jobs.md#program)). The first one takes `instances/<mod>/<program>.json.lock` in the cmod store, runs the command without `CLAUDE_CODE_SESSION_ID`, because the copy serves every session, and with `CMOD_MOD`, the mod's name, and `CMOD_PROGRAM`, the program's, which `connect()` reads to provide interfaces ([dependencies.md](dependencies.md#connect-a-program-s-connection-to-cmod-serve)), and `CMOD_DATA` and `CMOD_CACHE`, the mod's data and cache folders, which an install step gets too ([install-steps.md](install-steps.md#how-a-step-runs)), writes its first line on standard output, its address, with the copy's pid and start time to `instances/<mod>/<program>.json`, and prints it. For a program that prints nothing and only provides interfaces through `connect()`, it writes the copy's pid and start time there, with no address, once `cmod serve` says the copy provided one, so every command that stops a copy finds both kinds, and prints `provided`, which the session reads as the copy's start. It asks `cmod serve` again every 5 seconds while `cmod serve` is down or starts again. It touches its file in the lock every 5 seconds. With `--no-wait`, which a mod's session passes, another one touches the holder's file, prints `held`, and exits 0, and the session reads the address from `instances/<mod>/<program>.json` and runs `cmod program` again once that file is gone or the holder's file is 15 seconds old. Without it, as a mod built on `@cmodjs/core` before 5.3.0 runs it, another one prints the address in that file, then each new one as it changes, and tries the lock again whenever that folder changes and every 5 seconds, so it takes over once the holder exits. A lock whose process is gone counts as free. The holder stops its copy and gives up the lock on SIGTERM, SIGINT, or SIGHUP, and when the session that started it exits, which it checks every 5 seconds. When the copy exits on its own, the holder exits with the copy's exit code, and the copy's standard error passes through. The cmod command that replaces the program's file in the cmod store's `programs` folder stops the copy itself: `cmod setup` when it links a new version, or links the old one back after a failed install step, `cmod link` and `cmod watch` when a build of the linked checkout changes the program, and `cmod download`. It sends SIGTERM, then SIGKILL after 5 seconds, to the copy each `instances/<mod>/<program>.json` names, once its process and start time match, so the copy restarts whatever cmod program holds it, an older one included. The holder then deletes that file and exits with the copy. The session that ran it runs `cmod program` again a second later, and every other session does too once that file is gone, so one of them starts the new file and the others follow its address. A service's holder exits the same way, and launchd or systemd starts it again. A build with the same bytes, and a link placed again at the same file, leave the program as it was, so the copy keeps running. A new holder that finds a copy an earlier holder left running sends it SIGTERM, then SIGKILL after 5 seconds, and starts its own copy only once that one is gone, so two copies never run at once.

With `--service`, which a session passes for a `program` job with `isService`, it makes the holder a service of the computer named `com.claudemodmanager.<mod>.<program>`: a launchd agent in `~/Library/LaunchAgents` on macOS, loaded into the person's login session, and a systemd user service in `~/.config/systemd/user` on Linux, enabled for `default.target`. Its file is mode 600, because it holds the program's environment. The service runs `cmod program <mod> -- <command…>` through the cmod store's `programs/cmod` at login and again whenever it exits, launchd at most once every 10 seconds and systemd 10 seconds after the exit, with `HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, and `HERDR_APP_HOME` as the session has them, so the program reads the same folders the session does, such as its `CMOD_DATA` and `CMOD_CACHE` and the Herdr home `cmod serve` places its Herdr mod in, a `PATH` of the cmod store's `programs` folder, `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, and `/sbin`, `CLAUDE_CODE_EXECPATH`, and each `--env` variable, which the job passes for each key of its `environment`, `PATH` included. The `PATH` is fixed, because sessions started from different shells hold different ones, and a service rewritten for each would restart at every session start. `CLAUDE_CODE_EXECPATH` names the Claude Code of the session that wrote the service, so a `cmod` command the program runs finds Claude Code though the `PATH` holds none. It names the path Claude Code's updates keep, `~/.local/bin/claude` when that launcher runs the same install, because the updater deletes old versions and a service rewritten for each version would restart at every update. cmod records it in `services/<mod>/<program>.json` in the cmod store. On macOS the launchd agent writes the service's standard error, the program's and cmod's own, to `services/<mod>/<program>.log` beside that record, because launchd keeps no output of its own. Each holder that starts the program first cuts a log over 1 MiB to the whole lines of its last 512 KiB, so a program that fails at every restart, which launchd starts again every 10 seconds, never fills the disk. Linux keeps the program's output in the systemd journal, so the systemd user service writes no log. It holds the mod's lock in the cmod store while it writes and loads the service and waits for it, so sessions that start the mod at once, as every session does after an update, never load it beside each other or beside `cmod setup` or `cmod teardown` of the mod. It loads the service when it is new, changed, or not loaded, waits up to 15 seconds for the program to start, prints `held`, and exits 0, so the session follows the instance file as with `--no-wait`. The program has started once `instances/<mod>/<program>.json` names its running copy, which the holder writes when the program prints its address or `cmod serve` holds an interface its connection provided, so a program that only provides releases the mod's lock at its first `provide`. A program that has done neither after 15 seconds still counts as started while a holder holds `instances/<mod>/<program>.json.lock`, so a program slow to listen keeps its service. A service with neither, such as a program that exits at once and whose holder therefore held the lock only for a moment, is stopped, disabled, and deleted with its record, as `cmod remove` does, and it fails with what shows why: on macOS the service's log in the cmod store, which the removal keeps, and on Linux `journalctl --user -u <label>.service`. When the computer does not take the service, such as a Linux device without a systemd user session, it deletes what it wrote, says why on standard error, and runs as `--no-wait` does. When the computer took the service, a loaded launchd agent or an enabled systemd user service, and starting it still failed, such as systemd refusing a program that exited too often, it stops, disables, and deletes the service and its record as `cmod remove` does, and fails with the service manager's error and what shows why, because the program fails and the person needs that error. The service restarts on a new program as every copy does, and `cmod teardown` stops and deletes each one.

With `--web-app`, which a session passes for a `program` job with `isWebApp`, the holder puts the copy on the person's tailnet while `servesTailnet` in `preferences.json` in the cmod store is on, as it is unless the person turned it off, and `tailscale status --json` says Tailscale is signed in with HTTPS on. It finds `tailscale` on its `PATH`, then at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, the macOS app's own copy. It runs the copy with `CMOD_TAILNET_NAME`, the computer's tailnet name, and `CMOD_TAILNET_LOGIN`, the login of the computer's owner, and once the copy prints `127.0.0.1:<port>`, runs `tailscale serve --bg --https=<tailnet port> http://127.0.0.1:<port>` before it writes the address, so the instance file carries `tailnetUrl`, `https://<name>:<tailnet port>/`, from the moment a session reads it. The tailnet port is the first port the copy listened on, which `tailnet/<mod>/<program>.json` in the cmod store keeps with the address, or the reason the copy is not on the tailnet, such as Tailscale signed out, HTTPS off, or that port already serving something else on the tailnet, which Settings shows. When the copy exits, the holder runs `tailscale serve --https=<tailnet port> off`, so no address on the tailnet points at a port the copy left. It stops the copy, which starts again as after any exit, when `servesTailnet` changes, which it reads every 5 seconds, and when Tailscale becomes ready for a copy that started without it, which it checks every minute. A service passes `--web-app` on to the `cmod program` its service runs.

With `--process-type`, which a session passes for a `program` job with `processType`, the launchd agent carries that `ProcessType`: `Interactive` runs the program at the priority of an app, where launchd throttles a service with none on a loaded Mac, and `Background` runs it at the lowest. systemd has no such class, so a Linux service carries none.

With `--remove-service`, it stops the program's service, deletes its file, its record in `services/<mod>/<program>.json`, and its log, and exits 0, holding the mod's lock in the cmod store so it never runs beside `cmod setup` or `cmod teardown` of the mod. A program with no service changes nothing. A session that starts a mod runs it for each record in `services/<mod>/` whose program the mod's setup no longer adds as an `isService` program, so a new version that dropped `isService` or renamed the program leaves no service of the old one. A session reads that folder without a process, so a mod with no `services/<mod>/` folder runs nothing for it.

### cmod serve

```text
cmod serve
cmod web serve
```

Serves this computer's sessions to every session, script, and browser on it. The cmod plugin runs it as a service of the computer, `com.claudemodmanager.cmod.cmod`, of launchd's `Interactive` class on macOS, because every session waits on it ([cmod program](#cmod-program)). It listens on `serve.sock` in the cmod store, which only the person can open, and prints `unix:<socket>` once it listens. `cmod web serve` runs the same server, for a session whose cmod plugin is from before 7.0.0.

On that socket it answers the `cmod/Sessions` interface as JSON-RPC ([dependencies.md](dependencies.md#interfaces-several-mods-answer-one-name)): it lists and reads every session from the conversation index it keeps open, as [`cmod sessions`](#cmod-sessions) does, carries each action on a session to the cmod plugin of the session that runs it, and tells a `Change` for each session that starts or stops running, is visited or deleted, or changes its tasks, goal, or status. It lists each running session's `status` and `waitingFor` from Claude Code's record of it, `sessions/<pid>.json`, which it reads again 300 ms after that folder changes, and adds what only the session's cmod plugin hears: a turn's start and end, the tool call a permission prompt or a question waits on, `contextPercent`, and `lastTurn`. It answers a session it does not hold with the not-held code, `-32098`, and a listener on anything but `Change` with `cmod/Sessions tells only Change, because a mod hears only the session it runs in.` It answers the same calls under `cmod/SessionStore` and `cmod/Session`, the names a cmod plugin from 7.0.0 calls it by. Each session's cmod plugin holds one connection to it and names its session. It also holds every interface a program on this computer provides through `connect()`, and carries each call and listener to the connection that provides it, so each session reaches a program through its one connection to `cmod serve`. A program's providers end with its connection. It reaches a program from a 7.0.0 core, which serves its own wire and names its interfaces as `provides` in `instances/<mod>/<program>.json`, by connecting to the address there. It connects to the `cmod serve` of each device a `cmod/Devices` provider names, at the address the provider gives, or over the messages the provider carries with its `send` and `Message` ([dependencies.md](dependencies.md#cmod-devices-providers-on-your-other-devices)), lists that device's providers with its `device`, and carries each call and listener on one of them there. It offers another device only this computer's providers, and starts a background task whose `device` names this computer. A `Prompt` to a session that has ended resumes it with `claude --bg --resume`, `delete` deletes an ended session, and `visit` keeps when each session's reply was last read in `visited.json` in the cmod store. At its start it deletes each file of the cmod plugin's `before` folder, where a cmod plugin from before 7.0.0 kept its session's `before` listeners, whose session no longer runs, and moves `web-read.json`, the replies `cmod web serve` before 7.0.0 marked read, to `visited.json`.

At its start it also places cmod's Herdr mod, which draws every session's widgets, views, and pages in the Herdr app through [`cmod ui`](#cmod-ui) ([ui.md](ui.md#herdr-draws-them-through-cmod-ui)), in `mods/cmod/` of Herdr's home: `$HERDR_APP_HOME`, else `$XDG_CONFIG_HOME/herdr-app`, else `~/.config/herdr-app`, when that folder exists. It writes only a file that differs from the one the cmod program carries, records the hash of each file it wrote in `herdr.json` in the cmod store, and replaces or deletes only a file that still holds what it wrote. A `mods/cmod/` folder whose files it did not write stays as it is, and it says so on standard error and places nothing. `cmod teardown cmod` deletes each file it wrote that still holds what it wrote, and the folder once only what Herdr and the mod write while they run is left in it.

While `Show the Sidebar in your browser` is on in Settings, under cmod, Preferences, it serves the browser app that [`cmod web`](#cmod-web) opens, on 127.0.0.1 only, and on the person's tailnet while Tailscale is signed in with HTTPS on. It reads every running session itself: Claude Code's `sessions/<pid>.json` records, a process counting as running only while its pid runs with the start time Claude Code recorded, and leaving out each `sdk-cli` process, then each session's transcript through the conversation index. It lists the running sessions of each other sessions provider, another device's `cmod serve` or a mod's program, beside them, and sends a prompt or a Stop there as that provider's `cmod/Sessions` `send` and `abort`. A session Claude Code records as waiting on a permission prompt or a question moves to Needs you as soon as the dialog opens, and a turn stopped while a command it ran keeps running in the background says so. It reaches each session as every other app does: its status, the permission prompt or question it waits on, how its last turn ended, and its context fill through `cmod/Sessions` `sessions` and `Change`, its views and pages, the cmod plugin's own Dashboard, History, and Settings among them, through `cmod/UI` with `surface: 'browser'`, which it draws, presses, opens, and closes there and follows by `Change`, `Redraw`, `Open`, and `Close`, and a prompt or a Stop through `cmod/Sessions` `send` and `abort`. A session whose cmod plugin is older shows only what its transcript says. A cmod plugin from 7.0.0 posts to `/api/sessions/<session>` and polls `/api/sessions/<session>/events`, and `cmod serve` answers the post with `{}` and the poll after 8 seconds with no views and no actions, so that session warns nothing until it reloads. It keeps `web.json` in the cmod store with the page's port, and listens on that port again while it is free, so a browser tab left open reconnects after a restart. It refuses a request for any host but `127.0.0.1` and `localhost` with its port, and a change from any other page. Through the tailnet it answers a request only when its host is `CMOD_TAILNET_NAME` and its `Tailscale-User-Login` is `CMOD_TAILNET_LOGIN`, the person's own, and answers no session call, which comes only through `serve.sock`. It closes the page once the preference is off, and opens it again when it is on.
