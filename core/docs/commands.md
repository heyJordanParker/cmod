# cmod commands

The `cmod` command of Claude Mod Manager (cmod) builds, checks, and publishes mods, and installs them. `npm i -g @cmodjs/cli` puts it on `PATH`. `cmod <command> --help` prints a command's arguments, and `cmod --version` prints the version.

Each command below restates what `cmod <command> --help` prints, for a mod author. The help text is the full word.

## Build a mod

### cmod new

```text
cmod new <name> [--project]
```

Creates a mod in `./<name>`: a `defineMod` with one hook, one pane, and one render of the band above the prompt, a Skill, and a test. Then installs its packages.

- `<name>` is lowercase letters, digits, and `-`, starting with a letter.
- `--project` creates a project-scope plugin in `./.claude/skills/<name>/` of the repository in the current folder, which loads for everyone who trusts the repository. Run it in the repository's root.
- `CMOD_CORE` sets the `@cmodjs/core` dependency it writes. By default it writes `^<the version of this cmod>`. To build against an unreleased `@cmodjs/core`, point it at a packed tarball, such as `file:/path/to/cmodjs-core-<version>.tgz`. Only a `.tgz` works: a folder installs as links into that folder, and `claude plugin validate --strict` refuses the mod.
- When the packages fail to install, it deletes the new folder.

### cmod link

```text
cmod link [path] [--yes]
```

Loads the checkout at `path` (default: the current folder) in every new Claude Code session, in place of the installed mod. Installs the cmod plugin when Claude Code lacks it, unless the checkout is cmod itself. Then installs the checkout's packages, builds the program `cli/` declares into `~/.local/bin`, writes the folder into `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of Claude Code's `settings.json`, and runs the checkout's install step. A session that is already running loads it after `/reload-plugins`.

- `--yes` approves the mod's install and uninstall commands without asking.

### cmod unlink

```text
cmod unlink [path]
```

Stops loading the checkout at `path` (default: the current folder) in new Claude Code sessions. Removes the folder from `CLAUDE_CODE_PLUGIN_DIRS` in Claude Code's `settings.json`, runs the checkout's uninstall step, and removes the program `cmod link` built into `~/.local/bin`.

### cmod check

```text
cmod check [path]
```

Runs every check this machine can run on the mod at `path` (default: the current folder), each failure with its fix:

1. Installs its packages.
2. Checks its layout.
3. Checks that each step runs a script.
4. Writes the options `defineMod` declares into `.claude-plugin/plugin.json` `userConfig`, keeping the file's own formatting, so Claude Code shows them in `/config` ([options.md](options.md)). It loads `hooks/register.ts` to read them, without starting the mod.
5. Checks its imports.
6. Looks for prebuilt binaries outside `cli/`.
7. Bundles the hooks module as `cmod publish` does, and names each reason a bundle fails.
8. Validates it with Claude Code, `claude plugin validate --strict`.
9. Type-checks it with `tsc`, with `tsconfig.json`, and then with `tests/tsconfig.json` when it exists. `cmod new` writes both: the root config leaves Bun out of `src/`, which runs inside Claude Code, and the tests config adds `bun-types`, so a test can run a real program with `Bun.spawn` or read files with `node:fs`. When `.claude-plugin/types/` is missing, as in a fresh clone or in CI, Claude Code writes it first: cmod loads the mod in one `claude -p` run with a config folder of its own and no model to reach, so the run sends nothing.
10. Lints it with `oxlint`.
11. Runs, with `bun test`, every test file that does not import `claude-code/testing`.
12. Runs, with `claude plugin test`, the test files that import `claude-code/testing`. It skips this when none does.
13. Checks its name against other plugins. Only a project plugin, in `.claude/skills/<name>/` of a repository, runs this check: it fails when an installed or linked plugin has the same name and hides the project plugin. Any other mod passes it at once.

`cmod check` fetches `tsc` 7.0.2 and `oxlint` 1.86.0 into the cmod store the first time. It ends with a count of passed, failed, and skipped checks, and exits 1 when one failed.

### cmod try

```text
cmod try <owner/repo | path>... [--yes] [--home <folder>] [-- claude arguments]
```

Starts one throwaway Claude Code session with mods set up, for trying a mod by hand or testing it with an agent. Installs each mod's packages, installs the cmod plugin when Claude Code lacks it, and runs each mod's install step after asking consent. Then starts one Claude Code session with every mod loaded through `--plugin-dir`.

- The session runs with a new home folder, so it sees only the mods named here and changes none of your Claude Code settings, mods, key bindings, or history. The folder is deleted when the session ends.
- The session stays logged in as you, with no login screen:
  - On macOS, Claude Code reads your login from the keychain, which `cmod try` links into the new home as `~/Library/Keychains`. Deleting the home removes only the link.
  - Elsewhere, `CLAUDE_SECURESTORAGE_CONFIG_DIR` points Claude Code at the folder that holds your login, so it reads and refreshes that login where it is.
  - `ANTHROPIC_CONFIG_DIR` points at your `~/.config/anthropic` login profiles, and `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` pass through.
- The session keeps how Claude Code reaches the model and what it must never do, so a try is as safe as your own session. From your `settings.json` it keeps `env` (a proxy or `ANTHROPIC_BASE_URL`, without `cmod link`'s `CLAUDE_CODE_PLUGIN_DIRS`), the credential helpers (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper`, `proxyAuthHelper`), the login pins (`forceLoginMethod`, `forceLoginOrgUUID`, `forceLoginGatewayUrl`, `gatewayInternalNetworks`), `sandbox`, and `permissions.deny`. From `~/.claude.json` it keeps your account and the API keys you approved. A `~/` in a helper still means your own home. Hooks, plugins, allow rules, the model, and every other preference stay behind. Managed settings apply as always.
- `--home <folder>` runs in that folder and keeps it, so the next `cmod try --home <folder>` starts from it. `--home ~` runs in your own home, with your settings and mods.
- Unlike `cmod link`, it builds no program from `cli/`. A mod whose `package.json` `cmod.program` names a program downloads it from the GitHub release of the mod's version, so it fails until `cmod publish` has released that version.
- When the session ends, even when its terminal closes, it runs each mod's uninstall step and deletes its record, data folder, approval, key bindings, and program, so the mod stays uninstalled. A checkout already set up from the same folder keeps its setup.
- A GitHub mod is cloned into a temporary folder, which is deleted too.
- A mod another folder has set up in that home is refused, so `cmod try` never replaces an installed copy.
- Arguments after `--` go to `claude`, such as `-- -p "hello"`. An agent tests a mod with one `cmod try <path> --yes -- -p "<prompt>"` run.

### cmod publish

```text
cmod publish [path] [--dry-run]
```

Releases the mod at `path` (default: the current folder) at the version in its `plugin.json`. It refuses a `plugin.json` whose `userConfig` differs from the options `defineMod` declares, and says to run `cmod check` and commit `.claude-plugin/plugin.json`.

1. Builds the release from the committed files, leaving out `cli/`, `.github/`, and `.claude/`. A `"files"` list in `package.json` limits the release to the paths it lists, plus the folders of the install and uninstall steps, `.claude-plugin/`, `package.json`, `tsconfig.json`, the README, and the license, the way `npm publish` reads it. `tsconfig.json` holds the JSX settings the bundle in step 2 needs. List every folder the hooks module imports from, such as `"files": ["hooks", "src", "skills"]`, because the bundle in step 2 is built from the release.
2. Bundles the hooks module that `hooks/hooks.json` names, with the mod's source and packages, into one readable `.js` file, writes each control character in it as a `\u` escape, and points `hooks/hooks.json` at it. Anthropic's plugin directory reads a repository without installing its packages, so it can follow a mod only when all its code is in one file.
3. Checks the release with `claude plugin validate --strict`, and stops with the validator's message when it fails.
4. Commits the release as the `release` branch, and builds the release archive from that commit.
5. Builds the program `cli/` declares, and writes `SHA256SUMS` for every file of the release.
6. Writes `.claude-plugin/marketplace.json`, listing the archive and the cmod plugin.
7. Commits that file, tags `v<version>`, pushes the tag and the `release` branch, and creates the GitHub release.
8. Prints the link to paste as the Repository when you submit the mod at [claude.ai/directory/manage](https://claude.ai/directory/manage), such as `https://github.com/owner/greeter/tree/release`. The portal reads the branch from the link, so the directory follows `release`.

The release keeps `package.json`, so Claude Code still installs the mod's packages for its install and uninstall steps. It keeps `bun.lock` too, unless a `"files"` list leaves it out. `main` keeps the source only.

It needs, and refuses to start without:

- the mod's folder as the root of a git repository with at least one commit, because `git archive` builds from `HEAD`
- `node_modules` in the mod's folder, from `bun install`, when the hooks module imports a package
- a `register` declared as a function in the hooks module, as `cmod new` writes it, because the validator refuses a bundled `register` that is not one
- the `claude` command, which validates the release
- an `origin` remote on GitHub
- a `package.json` with no dependency on a `file:` or `link:` path, which no user has
- a `"files"` list, when `package.json` has one, whose every path matches a committed file
- a `"program"` in the `cmod` key of `package.json` that names the program `cli/` declares, when `cli/` declares one
- the network, to hash the cmod plugin release it lists, unless the mod is cmod itself
- for a real publish, a working tree with no uncommitted changes, a `v<version>` tag that does not exist yet, a `git push` to `origin` that succeeds, and the `gh` command, which creates the GitHub release

`--dry-run` builds everything into a temporary folder, and pushes nothing. It writes `marketplace.json` there too, so the working tree stays as it was. It allows uncommitted changes and an existing tag, and builds from the last commit. It prints the folder that holds the release, so you can read what the directory will read.

## Install mods

### cmod install

```text
cmod install <owner/repo | path> [name] [--yes]
cmod install <name | name@marketplace> [--yes]
```

Adds the plugin's marketplace to Claude Code and installs the plugin through Claude Code. A mod also gets the cmod plugin when Claude Code lacks it, and its install step runs. Any other plugin installs through Claude Code alone, and cmod keeps no record of it.

- When the marketplace lists several plugins, name the one to install after it.
- Given `name@marketplace` of a marketplace Claude Code has added, it installs that plugin.
- Given the name of a plugin Claude Code already holds, it runs a mod's install step again.
- A path holds a `/`, such as `./my-mod`.
- `--yes` approves the mod's install and uninstall commands without asking.

### cmod update

```text
cmod update [name] [--yes]
```

Updates the named plugin, or every plugin Claude Code has installed, through Claude Code, then runs the install step of each mod whose version or scripts changed. A linked plugin is skipped, because saving its files updates it. When Claude Code fails to update a plugin, `cmod update` names it, updates the rest, and exits 1. A running session loads the new version after `/reload-plugins`.

- `--yes` approves changed install and uninstall commands without asking.

### cmod remove

```text
cmod remove <name>
```

Uninstalls the plugin through Claude Code. When cmod set the plugin up as a mod, it then runs the uninstall step cmod saved and removes what cmod set up.

### cmod list

```text
cmod list
```

Lists every plugin Claude Code has installed or linked, with its version. A mod shows whether cmod set it up, and any other plugin shows whether Claude Code enabled it. It also lists every mod Claude Code removed whose uninstall step has not run yet.

- The `cmod` commands count a plugin as a mod only when its `package.json` has a `cmod` step key or cmod holds an install record for it. A mod made with `cmod new` has neither until its first Claude Code session sets it up, so until then `cmod list` shows it as `enabled`, like any other plugin.

## Run in an install script

### cmod download

```text
cmod download <program> <machine> <url> <sha256> [<machine> <url> <sha256> …]
```

Downloads a program for an install script: fetches the download for this machine, checks its SHA-256, unpacks it, and moves `<program>` to `$CMOD_DATA/bin/<program>`. [install-steps.md](install-steps.md) explains it.

## Run by cmod

cmod runs these two itself. A person runs them to see a step's whole log or to finish a step.

### cmod setup

```text
cmod setup <plugin-root> [--events] [--consent <sha256>] [--yes]
```

Downloads the program the mod's `package.json` `cmod.program` names into `~/.local/bin`, runs the mod's install step, saves its uninstall step, and records the mod as set up. An unchanged mod runs nothing. `--events` prints one event per line for a program to read, and the mod's progress line in Claude Code reads them.

### cmod teardown

```text
cmod teardown <plugin-name> [--events]
```

Runs a removed mod's saved uninstall step, then deletes its install record, the saved step, every version of its program, and its data folder, and forgets the scripts the person approved for it. It keeps the mod's config folder, `~/.claude/cmods/<plugin-name>`. A failed uninstall step keeps the record, so `cmod teardown` can run again.
