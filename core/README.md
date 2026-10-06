# @cmodjs/core

The library every Claude Mod Manager mod imports. Claude Mod Manager (CMod) installs, tries, builds, checks, and publishes Claude Code mods: plugins with hooks, panes, slash commands, tools, permission rules, and an install step that runs with your consent.

```sh
npm i -g @cmodjs/cli
cmod new my-mod
```

`cmod new` writes a mod that depends on this package. A mod imports it by path, such as `../node_modules/@cmodjs/core/mod.js`, because Claude Code loads a plugin's own files only.

## Docs

This package ships its docs in `docs/`, so a mod's `node_modules/@cmodjs/core/docs/index.md` is the map of the docs for the version it installed. The same docs are on GitHub at [core/docs](https://github.com/heyJordanParker/cmod/blob/main/core/docs/index.md).

The CMod plugin and the `cmod` source live at [github.com/heyJordanParker/cmod](https://github.com/heyJordanParker/cmod).
