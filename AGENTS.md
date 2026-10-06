# Claude Mod Manager

Claude Mod Manager (cmod) installs Claude Code mods, runs their install and uninstall steps with the person's consent, and builds and publishes new mods.

# Facts

- No Bun workspaces: a workspace hoists packages to the root `node_modules`, outside a plugin's import boundary.
- `core/` publishes as `@cmodjs/core` on npm, the library mods import.
- `cli/` publishes as `@cmodjs/cli` on npm, which ships only the launcher in `cli/bin/cmod`. `cli/src/` is the cmod program's source, compiled into the binaries each GitHub release carries.
- The cmod program is the one runner of a mod's steps, and the library never runs them.
- The cmod program in `cli/` imports the `src/` modules of `@cmodjs/core` as a dev dependency. The library never imports the cmod program.
- `.claude-plugin/plugin.json`, `core/package.json`, and `cli/package.json` share one version, which is the version of the cmod program too.
- Raising that version in all three files, with the root `package.json`'s `@cmodjs/cli` and `@cmodjs/core` ranges, and pushing to `main` releases both npm packages and the cmod plugin. CONTRIBUTING.md has the release steps.
- `core/docs/` ships inside `@cmodjs/core` as the mod author docs, so a change to the Public API changes `core/docs/` in the same commit.
- The sample mods `file-tree` and `architecture-diagrams` are checked out beside this repository.
- `site/` is claudemodmanager.com, a VitePress site GitHub Pages serves. Its landing page is `site/index.md`, and its docs are `core/docs/` of the latest release tag, copied in at build. `bun run --cwd site dev` serves it locally with the working tree's `core/docs/`.
- `site/mods.json` is the list the site's Mods page shows, and a pull request adds a mod to it.
- The site's build writes `llms.txt`, `llms-full.txt`, and a Markdown copy of each docs page, and `site/public/og.png` is the image a shared link shows.
