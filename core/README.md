# @cmodjs/core

The library Claude Code mods import. CMod is the Claude Mod Manager: it installs, tries, builds, checks, and publishes Claude Code mods, which are plugins with hooks, panes, commands, tools, permissions, and an install step that runs with your consent.

```sh
npm i -g @cmodjs/cli
cmod new my-mod
```

`cmod new` writes a mod that depends on this package. A mod imports it by path, such as `../node_modules/@cmodjs/core/mod.js`, because Claude Code loads a plugin's own files only.

The guide and the CMod plugin live at [github.com/heyJordanParker/cmod](https://github.com/heyJordanParker/cmod).
