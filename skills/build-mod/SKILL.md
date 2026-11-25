---
name: build-mod
description: Build, test, and publish a Claude Code mod with @cmodjs/core and the cmod command, from cmod new to cmod publish. Covers the mod's setup, views, widgets, jobs, and tests, the dev loop with cmod link, and the checks before a release. TRIGGER when the person wants a mod made, changed, tested, or released with @cmodjs/core, or works in a folder whose package.json depends on @cmodjs/core. DO NOT TRIGGER for a plugin written against Claude Code's raw hooks API; that is the built-in plugin-authoring skill.
allowed-tools: Bash(cmod new:*), Bash(cmod check:*), Bash(cmod link:*), Bash(cmod unlink:*), Bash(cmod log:*), Bash(cmod try:*), Bash(bun test:*)
---

# Build a mod

- A mod is a Claude Code plugin whose `src/mod.tsx` calls `defineMod` from `@cmodjs/core`. Its views, widgets, slash commands, hotkeys, options, and programs draw and run in every app cmod reaches: the terminal, Herdr, and the browser.
- The docs ship inside the package, in `node_modules/@cmodjs/core/docs/`: `index.md` maps every part, and `mod.md`, `ui.md`, `session.md`, `jobs.md`, and `testing.md` hold the API.

## 1. Start from the template

`cmod new <name>` writes a mod that builds, checks, and passes its tests, with its `package.json`, `.claude-plugin/plugin.json`, `src/mod.tsx`, and a test. Change it from there.

## 2. Read the docs for the part you add

Open the doc of the part before you write it, and use the component it names. A host component, such as `Panel`, `List`, `Progress`, or `Banner`, draws natively in every app, so a view built from them looks right everywhere.
Never: draw a bar, a box, or a list out of text characters a component already draws.

## 3. Test what the person sees

Each test runs the mod with `testMod` from `@cmodjs/core/testing.js` and asserts what the person sees or the session receives, such as `tested.shown.pane.lines()`, or what `tested.fire(...)` answers. Run them with `bun test`.

## 4. Run it in Claude Code

`cmod link` loads the checkout in every session, and offers Reload in each once a change builds. For a session that reloads the mod by itself between turns, start one with `claude --plugin-dir <checkout>`. `cmod try <folder>` starts one throwaway session with the mod set up.

### Read the Log after each run
`cmod log <mod>` prints every failure the mod met, in every session. A linked mod also shows its failures as toasts in a session inside its checkout.

## 5. Check and publish

`cmod check` runs every check a release needs, Claude Code's validator, the type check, the lint, and the tests, each failure with its fix. `cmod publish` builds the release from the version's `CHANGELOG.md` section, tags it, and publishes it on GitHub.

### Write the CHANGELOG section first
`cmod publish` refuses a version without its `## [<version>] - <date>` section, which becomes the release notes.
