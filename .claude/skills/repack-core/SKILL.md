---
name: repack-core
description: Get a change to the `@cmodjs/core` package in `core/` into the code that runs it, because every mod runs the packed tarball, never `core/src/`, so a green core suite proves nothing about them. TRIGGER after any change under `core/src/` or `core/package.json`, before a live run, and on "repack", "rebuild the SDK", "reinstall the SDK", "end gate". DO NOT TRIGGER for a change only in `cli/`, `src/`, or `hooks/`; run that folder's own suite.
---

# Repack Core

A consumer runs what was packed, never what is in `core/src/`. Prove the package, not the tree.

- The consumers are the Claude Mod Manager (cmod) plugin at the repository root and the sample mods. Each depends on `@cmodjs/core` from npm, so `bun install` gives them the published version, never this change.
- A mod reaches `@cmodjs/core` only as real files in its own `node_modules`, because Claude Code refuses a symbolic link there.
- The cmod program is the exception: `cli/` depends on the `core/` folder through those per-file links, so it reads `core/src/` edits with no repack.

## 1. Register a new source folder

IF the change adds a folder under `core/src/`:
### Add it to `core/package.json` `files`, `.gitignore`, and `core/.oxlintrc.json`
`tsc` writes `core/src/<folder>/` to `core/<folder>/`. Without the `files` entry the tarball leaves it out, and without the `core/<folder>/` line git sees the build output. Each `core/.oxlintrc.json` override lists the folders its layer may not import, so a folder missing from those lists is open to every layer, and a folder with no override of its own may import anything.

## 2. Delete the build output, then build

`tsc` never deletes the output of a module that was renamed, moved, or deleted, and the pack takes whatever lies in `core/`. The build output is every path `core/package.json` `files` names except `src/` and `docs/`, plus `core/*.tgz`.
The build reads Claude Code's types from `.claude-plugin/types/`, which git ignores and Claude Code writes when it first loads the checkout. In a checkout without it, such as a new worktree, run `claude --plugin-dir . -p ok` from the repository root first, as CONTRIBUTING.md's "Run cmod from a checkout" does.
Example: from the repository root, `rm -rf core/jobs core/runtime core/testing core/ui core/utils core/*.js core/*.d.ts core/*.d.ts.map core/*.tgz`, then `bun run --cwd core build`.

## 3. Pack, then read the tarball

Run `env -C core bun pm pack`. It writes `core/cmodjs-core-<version>.tgz`.

### Check the tarball's file list against the change
`tar -tzf core/cmodjs-core-<version>.tgz` lists each module the change added under `package/`, and no module it renamed or deleted.

## 4. Unpack the tarball into every consumer

The consumers, from the repository root, are `.`, `../file-tree`, and `../architecture-diagrams`. Unpacking replaces the installed `@cmodjs/core` and leaves `package.json` and `bun.lock` on the npm version. `bun add` of the tarball fails with a dependency loop.
Template:
    tar -xzf core/cmodjs-core-<version>.tgz -C <consumer>/node_modules/@cmodjs/core --strip-components=1

IF the change edits `dependencies` in `core/package.json`:
### Run `bun add --cwd <consumer> --no-save <dependency>@<range>` for each new dependency
Unpacking copies files only, so a dependency the published version lacks is missing until the next npm release.

IF the work is done with the change:
### Run `bun install --cwd <consumer> --force` to put the npm version back

### Check each consumer holds the new build
`diff -rq core/runtime <consumer>/node_modules/@cmodjs/core/runtime` prints nothing.

## 5. Run the end gate

The shell's `bun` is a function that turns `bun test` into `bun run test`, and the repository root and the samples have no `test` script. `env -C <folder> bun …` runs Bun itself. `cmod check` fetches `tsc` and `oxlint` into the cmod store under `HOME`, so it runs with a scratch `HOME`.

From the repository root, every command passes:
    env -C core bun test
    bun run --cwd core check
    bun run --cwd cli test
    bun run --cwd cli check
    env -C . bun test
    env -C . bun x tsc --noEmit
    env -C <sample> bun test                                         (each sample)
    env -C <sample> bun x tsc --noEmit                               (each sample)
    env HOME=<scratch home> bun run cli/src/main.ts check <mod>      (a mod on the tarball)

### Count `cmod check` as the gate's only run of Claude Code's validator
`cmod check` runs `claude plugin validate --strict`, which nothing else in the gate runs. It is also the only way a build-mode Agent reaches the validator, because the Harness refuses `claude` itself in build mode.

### Run `cmod check` on a mod whose `@cmodjs/core` is the tarball
`cmod check` runs `bun install` first, which puts the npm version back over an unpacked sample. So in a scratch folder outside the clone, run `env CMOD_CORE=file:<clone>/core/cmodjs-core-<version>.tgz bun run <clone>/cli/src/main.ts new <name>`, use the changed API in its `src/mod.tsx`, and check that mod.
