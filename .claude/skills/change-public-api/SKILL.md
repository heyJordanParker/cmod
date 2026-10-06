---
name: change-public-api
description: Change what a mod author writes against, so the `@cmodjs/core` library, the `cmod new` template, `core/docs/`, README.md, and the sample mods keep one word per idea and one way per job, and Claude Code still loads the result. TRIGGER when adding, renaming, or removing an export of `core/src/mod.ts`, `testing.ts`, `register.ts`, `ui/`, or `jobs/`, when editing `cli/src/commands/new.ts`, `core/docs/`, README.md, or a sample mod, and when moving code between `core/src/` folders. DO NOT TRIGGER for consent, a mod's install and uninstall steps, `cmod try`, teardown, or permission rules; use /guard-user-machine.
---

# Change Public API

A mod author learns Claude Mod Manager (CMod) from the template, `core/docs/`, the README, and the samples, then writes against `@cmodjs/core`. All five say each idea with one word and do each job one way, so they change together.

- The Public API is `core/src/mod.ts`, `core/src/testing.ts`, `core/src/register.ts`, `core/src/ui/`, and `core/src/jobs/`. Every other file under `core/src/` is internal.
- `cli/src/commands/new.ts` holds the template `cmod new` writes. `cli/tests/new.test.ts` keeps the README's "Make a mod in 30 seconds" code equal to it.

## 1. Find every place the idea appears

Search `core/src/`, the template, `core/docs/`, README.md, and both samples for the word and for every other word that names the same idea.
Example: `trace grep -i "panel" core/src core/docs cli README.md ../file-tree ../architecture-diagrams`.

### Give one idea one word everywhere
Rename every straggler in the same change. A second word for one idea, or one word for two ideas, makes the author guess which is meant.
Example: "pane" in every file, because the Public API says `mod.ui.pane`, `definePane`, and `PaneHandle`.
Never: "session" for both the conversation's values (`mod.state.session`) and the project folder (`mod.projectRoot`).

### Delete the old way when you add a new way to do a job
Example: `check` runs commands and `prompt` adds text, so neither takes an option that does the other's job.

## 2. Keep imports flowing one way

- `utils/` imports only `utils/` and the vendored libraries.
- `ui/` imports only `ui/`, the vendored libraries, and types from `mod.ts`.
- `runtime/` builds on `ui/`, `utils/`, and `records.ts`, and imports only types from `mod.ts`.
- `jobs/` builds on `runtime/` and `utils/`, never `ui/`.
- Only `testing.ts` imports `testing/`.

`bun run --cwd core check` runs the oxlint rules in `core/.oxlintrc.json` that enforce each line.

## 3. Test what the person using the mod sees

Write each test with /write-test. Assert what `tested.lines(...)`, `tested.shown`, `tested.state`, or `tested.fire(...)` returns.
Never: the test kit's printout of a fake element's props, a store key, or `lifecycle.phase`.

## 4. Keep every hooks module loadable by Claude Code's validator

Claude Code reads a plugin's hooks module and types file before it loads them, and `claude plugin validate --strict` runs the same check. Claude Code 2.1.289 refuses:

- `$` passed to a function in another module. Each call is spelled `$.noun.event(...)` in the module that registers the hook, as `register.ts`'s `startMod` spells them.
- A module that keeps the table `next(e)` returns at `engine.create` for later use.
- A types file that augments any module but `'claude-code'`. A mod's `api` types add to `CmodDependencies` there.
- An event registered twice without a matcher, or an event name that is not a string literal.

The validator accepts the shape of the hooks `register.ts` registers: each a top-level function in `register.ts`, registered there with `addHook`, sharing one module-level `lifecycle`. A new hook keeps that shape.

Anthropic's plugin directory reads the bundle `cmod publish` writes and flags:

- A name the bundle declares twice, when it is `$`, `register`'s first parameter, or a hook's third parameter. `mod.on` is a declaration of `on`, so `register`'s first parameter is `addHook`.
- `addHook` or `$` passed anywhere but as one whole argument to a function declared at the top of the same file.
- A hook on `tool.check`, `classic.PreToolUse`, or `classic.PermissionRequest` that answers anything but `next(e)` or a fixed `deny` or `ask`. `registerPermissionCheck` holds those three, so only a mod that decides permissions ships them.

The template's `tsconfig.json` repeats the JSX options, because Bun needs them before Claude Code first loads the mod and writes the `.claude-plugin/types/tsconfig.json` the template extends.

### Prove the change through `cmod check` and a live session
Run /repack-core, whose end gate runs the validator through `cmod check`. A change to what Claude Code loads or draws is also proven with /verify-live.
