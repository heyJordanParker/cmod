# CMod

CMod installs Claude Code mods, runs their install and uninstall steps with the person's consent, and builds and publishes new mods.

# Facts

- No Bun workspaces: a workspace hoists packages to the root `node_modules`, outside a plugin's import boundary.
- `core/` publishes as `@cmodjs/core` on npm, the library mods import.
- `cli/` publishes as `@cmodjs/cli` on npm, which ships only the launcher in `cli/bin/cmod`. `cli/src/` is the cmod program's source, compiled into the binaries each GitHub release carries.
- The cmod program is the one runner of a mod's steps, and the library never runs them.
- The cmod program in `cli/` imports the `src/` modules of `@cmodjs/core` as a dev dependency. The library never imports the cmod program.
- `.claude-plugin/plugin.json`, `core/package.json`, and `cli/package.json` share one version, which is the version of the cmod program too.
- The sample mods `file-tree` and `architecture-diagrams` are checked out beside this repository.
