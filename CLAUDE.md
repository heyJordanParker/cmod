# CMod

CMod installs Claude Code mods, runs their install and uninstall steps with the person's consent, and builds and publishes new mods.

# Facts

- No Bun workspaces: a workspace hoists packages to the root `node_modules`, outside a plugin's import boundary.
- The cmod program is the one runner of a mod's steps, and cmod-sdk never runs them.
- The cmod program in `cli/` depends on cmod-sdk and imports its `src/` modules. cmod-sdk never imports the cmod program.
- The sample mods `file-tree` and `architecture-diagrams` are checked out beside this repository.
