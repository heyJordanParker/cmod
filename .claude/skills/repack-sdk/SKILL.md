---
name: repack-sdk
description: Get a cmod-sdk change into the code that runs it, because every mod runs the packed tarball, never `sdk/src/`, so a green SDK suite proves nothing about them. TRIGGER after any change under `sdk/src/` or `sdk/package.json`, before a live run, and on "repack", "rebuild the SDK", "reinstall the SDK", "end gate". DO NOT TRIGGER for a change only in `cli/`, `src/`, or `hooks/`; run that folder's own suite.
---

# Repack SDK

A consumer runs what was packed, never what is in `sdk/src/`. Prove the package, not the tree.

- The consumers are the CMod plugin at the repository root and the sample mods `file-tree` and `architecture-diagrams`, checked out beside this repository. Each depends on `sdk/cmod-sdk-<version>.tgz`.
- A mod reaches cmod-sdk only as real files in its own `node_modules`, because Claude Code refuses a symbolic link there. A `file:` folder dependency installs one link per file, so every mod depends on the tarball.
- The cmod program is the exception: `cli/` depends on the `sdk/` folder and imports `cmod-sdk/src/` modules through those per-file links, so it reads `sdk/src/` edits with no repack.

## 1. Register a new source folder

IF the change adds a folder under `sdk/src/`:
### Add its build output to `sdk/package.json` `files` and to `.gitignore`
`tsc` writes `sdk/src/<folder>/` to `sdk/<folder>/`. Without the `files` entry the tarball leaves it out, and without the `sdk/<folder>/` line git sees the build output.

## 2. Delete the build output, then build

`tsc` never deletes the output of a module that was renamed, moved, or deleted, and the pack takes whatever lies in `sdk/`. The build output is every path `sdk/package.json` `files` names except `src/`, plus `sdk/*.tgz`.
The build reads Claude Code's types from `.claude-plugin/types/`, which git ignores and Claude Code writes when it first loads the checkout. In a checkout without it, such as a new worktree, run `claude --plugin-dir . -p ok` from the repository root first, as README.md's "Run CMod from a checkout" does.
Example: from the repository root, `rm -rf sdk/jobs sdk/runtime sdk/testing sdk/ui sdk/utils sdk/*.js sdk/*.d.ts sdk/*.d.ts.map sdk/*.tgz`, then `bun run --cwd sdk build`.

## 3. Pack, then read the tarball

Run `env -C sdk bun pm pack`. It writes `sdk/cmod-sdk-<version>.tgz`.

### Check the tarball's file list against the change
`tar -tzf sdk/cmod-sdk-<version>.tgz` lists each module the change added under `package/`, and no module it renamed or deleted.

## 4. Reinstall every consumer from an empty cache

The consumers, from the repository root, are `.`, `../file-tree`, and `../architecture-diagrams`. Bun caches a `file:` tarball by name and version, so `bun install --force` alone installs the stale copy again.
Template:
    bun install --cwd <consumer> --force --cache-dir <a new empty folder under /private/tmp>

### Check each consumer holds the new build
`diff -rq sdk/runtime <consumer>/node_modules/cmod-sdk/runtime` prints nothing.

## 5. Run the end gate

The shell's `bun` is a function that turns `bun test` into `bun run test`, and the repository root and the samples have no `test` script. `env -C <folder> bun …` runs Bun itself. `cmod check` fetches `tsc` and `oxlint` into the CMod store under `HOME`, so it runs with a scratch `HOME`.

From the repository root, every command passes:
    env -C sdk bun test
    bun run --cwd sdk check
    bun run --cwd cli test
    bun run --cwd cli check
    env -C . bun test
    env -C . bun x tsc --noEmit
    env -C <sample> bun test                                         (each sample)
    env -C <sample> bun x tsc --noEmit                               (each sample)
    env HOME=<scratch home> bun run cli/src/main.ts check <sample>   (each sample)

### Count `cmod check` as the gate's only run of Claude Code's validator
`cmod check` runs `claude plugin validate --strict`, which nothing else in the gate runs. It is also the only way a build-mode Agent reaches the validator, because the Harness refuses `claude` itself in build mode.
