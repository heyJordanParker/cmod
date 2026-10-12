# Claude Mod Manager

Claude Mod Manager (cmod) installs Claude Code mods, runs their install and uninstall steps with the person's consent, and builds and publishes new mods.

# Facts

- No Bun workspaces: a workspace hoists packages to the root `node_modules`, outside a plugin's import boundary.
- `core/` publishes as `@cmodjs/core` on npm, the library mods import.
- `cli/` publishes as `@cmodjs/cli` on npm, which ships only the launcher in `cli/bin/cmod`. `cli/src/` is the cmod program's source, compiled into the binaries each GitHub release carries.
- The cmod program is the one runner of a mod's steps, and the library never runs them.
- The cmod program in `cli/` imports the `src/` modules of `@cmodjs/core` as a dev dependency. The library never imports the cmod program.
- `.claude-plugin/plugin.json`, `core/package.json`, and `cli/package.json` share one version, which is the version of the cmod program too. `coreVersion` in `core/src/records.ts` holds it as well, because a published mod bundles `@cmodjs/core` and ships no `node_modules` to read it from.
- Raising that version in all three files, with the root `package.json`'s `@cmodjs/cli` and `@cmodjs/core` ranges, and pushing to `main` releases both npm packages and the cmod plugin. CONTRIBUTING.md has the release steps.
- `core/docs/` ships inside `@cmodjs/core` as the mod author docs, so a change to the Public API changes `core/docs/` in the same commit.
- The sample mods `file-tree` and `architecture-diagrams` are checked out beside this repository.
- A plugin's `cmod.call` hook answers `{ value }` or `{ deny }`. Claude Code 2.1.296 resolves the caller's `$.cmod.call` with the bare value, and rejects it with `<caller>: $.cmod.call: <deny>`. `calledAnswer` in `core/src/testing/fake-claude.ts` makes the test kit answer the same way, and `withBareRefusals` in `core/src/runtime/dependencies.ts` strips that prefix before a mod sees the error.
- Every failure cmod catches for a mod shows through `showFailure` in `core/src/runtime/toaster.ts`: an error toast that stays, with a Copy button for the whole error.
- Claude Code runs `session.start` down the chain of plugins, and `startMod` in `core/src/register.ts` starts its mod while it passes `session.start` on, so every mod starts at once, whatever its place in the chain. A `cmod.call` to a mod that is still starting waits for its start, and one to a mod waiting on its install is refused with "is installing".
- `mod.history` and `mod.claude.settings.update` reach the cmod plugin through `cmod.call`, and it answers by running `cmod history` and `cmod settings`. The conversation index is `history-2.sqlite` in the cmod store. It holds where each message is in its transcript, never a copy, and a schema change raises the number in the file's name, so a newer cmod deletes the older file instead of migrating it.
- Claude Code tells a forked session nothing about the session it came from. `/branch` forks inside the running process, and `--fork-session` and a move to the agents view start a new process on the fork's id with the copied conversation, which the cmod plugin matches to its parent.
- Claude Code 2.1.295 and later write a plugin's `.claude-plugin/types/` under `claude -p` only when `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` is set.
- `site/` is claudemodmanager.com, a VitePress site GitHub Pages serves. Its landing page is `site/index.md`, and its docs are `core/docs/` of the latest release tag, copied in at build. `bun run --cwd site dev` serves it locally with the working tree's `core/docs/`.
- `site/mods.json` is the list the site's Mods page shows, and a pull request adds a mod to it.
- The site's build writes `llms.txt`, `llms-full.txt`, and a Markdown copy of each docs page, and `site/public/og.png` is the image a shared link shows.
