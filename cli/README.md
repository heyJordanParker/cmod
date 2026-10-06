# @cmodjs/cli

The `cmod` command of Claude Mod Manager. Claude Mod Manager (CMod) installs, tries, builds, checks, and publishes Claude Code mods: plugins with hooks, panes, slash commands, tools, permission rules, and an install step that runs with your consent.

```sh
npm i -g @cmodjs/cli
cmod new my-mod
```

`cmod` runs the newest cmod program on this machine, and downloads its own version from the GitHub release the first time. `cmod --help` lists every command. A mod imports the library from [@cmodjs/core](https://www.npmjs.com/package/@cmodjs/core).

## Docs

The mod author docs ship inside `@cmodjs/core`, so a mod's `node_modules/@cmodjs/core/docs/index.md` is their map. [commands.md](https://github.com/heyJordanParker/cmod/blob/main/core/docs/commands.md) covers every `cmod` command.

The CMod plugin and the `cmod` source live at [github.com/heyJordanParker/cmod](https://github.com/heyJordanParker/cmod).
