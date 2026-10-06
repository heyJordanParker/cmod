# @cmodjs/cli

The `cmod` command. CMod is the Claude Mod Manager: it installs, tries, builds, checks, and publishes Claude Code mods, which are plugins with hooks, panes, commands, tools, permissions, and an install step that runs with your consent.

```sh
npm i -g @cmodjs/cli
cmod new my-mod
```

`cmod` runs the newest cmod program on this machine, and downloads its own version from the GitHub release the first time. A mod imports the library from [@cmodjs/core](https://www.npmjs.com/package/@cmodjs/core).

The guide and the CMod plugin live at [github.com/heyJordanParker/cmod](https://github.com/heyJordanParker/cmod).
