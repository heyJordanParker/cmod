---
name: change-public-api
description: Change what a mod author writes against, so cmod-sdk, the `cmod new` template, README.md, and the sample mods keep one word per idea and one way per job, and Claude Code still loads the result. TRIGGER when adding, renaming, or removing an export of `sdk/src/mod.ts`, `testing.ts`, `connect.ts`, `ui/`, or `jobs/`, when editing `cli/src/commands/new.ts`, README.md, or a sample mod, and when moving code between SDK folders. DO NOT TRIGGER for consent, a mod's install and uninstall steps, `cmod try`, teardown, or permission rules; use /guard-user-machine.
---

# Change Public API

A mod author learns CMod from the template, the README, and the samples, then writes against the SDK. All four say each idea with one word and do each job one way, so they change together.

- The Public API is `sdk/src/mod.ts`, `sdk/src/testing.ts`, `sdk/src/connect.ts`, `sdk/src/ui/`, and `sdk/src/jobs/`. Every other file under `sdk/src/` is internal.
- `cli/src/commands/new.ts` holds the template `cmod new` writes. `cli/tests/new.test.ts` keeps the README's "Make a mod in 30 seconds" code equal to it.
- The samples are `file-tree` and `architecture-diagrams`, checked out beside this repository.

## 1. Find every place the idea appears

Search the SDK, the template, README.md, and both samples for the word and for every other word that names the same idea.
Example: `trace grep -i "panel" sdk/src cli README.md ../file-tree ../architecture-diagrams`.

### Give one idea one word everywhere
Rename every straggler in the same change. A second word for one idea, or one word for two ideas, makes the author guess which is meant.
Example: "pane" in every file, because the Public API says `mod.ui.pane`, `definePane`, and `PaneHandle`.
Never: "session" for both the conversation's values (`mod.state.session`) and the project folder (`mod.projectRoot`).

### Delete the old way when you add a new way to do a job
Example: `check` runs commands and `prompt` adds text, so neither takes an option that does the other's job.

## 2. Keep imports flowing one way

- `utils/` imports only `utils/` and the vendored libraries.
- `ui/` imports only `ui/` and types from `mod.ts`.
- `runtime/` builds on `ui/` and `utils/`.
- `jobs/` builds on `runtime/` and `utils/`.
- `testing/` holds the test kit's fakes, and only `testing.ts` imports it.

### Put new code in the folder its imports allow
A move that makes two folders import each other is the wrong move.
Example: `drawWith` stays in `ui/elements.ts` beside `Box` and `Text`, which share its element table. In `runtime/` it would make `ui/` import `runtime/`.

## 3. Test what the person using the mod sees

Write each test with /write-test. Assert what `tested.lines(...)`, `tested.shown`, `tested.state`, or `tested.fire(...)` returns.
Never: the test kit's printout of a fake element's props, a store key, or `lifecycle.phase`.

## 4. Keep every hooks module loadable by Claude Code's validator

Claude Code reads a plugin's hooks module and types file before it loads them, and `claude plugin validate --strict` runs the same check. Claude Code 2.1.289 refuses:

- `$` passed to a function in another module. Each call is spelled `$.noun.event(...)` in the module that registers the hook, as `connect.ts`'s `claudeOf` spells them.
- A module that keeps the table `next(e)` returns at `engine.create` for later use.
- A types file that augments any module but `'claude-code'`. A mod's `api` types add to `CmodDependencies` there.

The validator accepts the shape of the hooks `connect.ts` registers: each a top-level function in `connect.ts`, registered there with `on`, sharing one module-level `lifecycle`. A new hook keeps that shape.

The template's `tsconfig.json` repeats the JSX options, because Bun needs them before Claude Code first loads the mod and writes the `.claude-plugin/types/tsconfig.json` the template extends.

### Prove the change through `cmod check` and a live session
Run /repack-sdk, whose end gate runs the validator through `cmod check`. A change to what Claude Code loads or draws is also proven with /verify-live.
