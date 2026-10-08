# Contributing to Claude Mod Manager

This guide runs Claude Mod Manager (cmod) from a checkout, runs the gate every change passes, and releases a new version.

## Run cmod from a checkout

In the clone's folder:

```sh
bun install --cwd cli
bun install --cwd core
bun cli/src/main.ts link .
```

`cmod link .` builds the cmod program into `~/.local/bin` and loads the checkout as the cmod plugin in every new Claude Code session. The first time, it asks consent to put the cmod program in `~/.local/bin`: answer `y`. Link cmod before any mod, because `cmod link` of a mod first looks for the cmod plugin in Claude Code.

`cmod link .` refuses when `PATH` finds another `cmod` in a folder ahead of `~/.local/bin`, such as one `npm i -g @cmodjs/cli` installed: `PATH finds cmod at <path> ahead of ~/.local/bin, so the cmod program cmod installs would never run.` It also refuses a `~/.local/bin/cmod` that cmod did not make. Uninstall that `cmod`, such as with `npm uninstall -g @cmodjs/cli`, or put `~/.local/bin` before its folder in `PATH`, then run `bun cli/src/main.ts link .` again.

The build and the tests read Claude Code's types from `.claude-plugin/types/`, which git ignores. Claude Code writes the folder the first time a session loads the checkout. In a checkout without it, such as a new worktree, run this from the repository root first:

```sh
claude --plugin-dir . -p ok
```

To build a mod against library changes that are not on npm yet, run `bun run --cwd core build`, then `env -C core bun pm pack`, and set `CMOD_CORE=file:<clone>/core/cmodjs-core-<version>.tgz` before `cmod new`. Only a `.tgz` works: a folder installs as links into that folder, and `claude plugin validate --strict` refuses the mod. Then move out of the clone, such as with `cd ..`, before `cmod new`, so the new mod is not created inside the cmod checkout.

## Run the gate

Every command passes, from the repository root:

```sh
env -C core bun test
bun run --cwd core check
bun run --cwd cli test
bun run --cwd cli check
env -C . bun test
env -C . bun x tsc --noEmit
core/node_modules/.bin/oxlint --deny-warnings src hooks tests
```

Then, for each sample mod checked out beside this repository, `file-tree` and `architecture-diagrams`:

```sh
env -C <sample> bun test
env -C <sample> bun x tsc --noEmit
env HOME=<scratch home> bun run cli/src/main.ts check <sample>
```

- `cmod check` fetches `tsc` and `oxlint` into the cmod store under `HOME`, so it runs with a scratch `HOME`.
- `cmod check` runs `claude plugin validate --strict`, which nothing else in the gate runs.
- A sample runs the packed `@cmodjs/core`, never `core/src/`. Repack and unpack the library into each sample before its gate, as the `/repack-core` Skill in `.claude/skills/` does.

## Release

`.claude-plugin/plugin.json`, `core/package.json`, and `cli/package.json` share one version, which is the version of the cmod program too. To release:

1. Raise the version in all three files to the same new version.
2. Raise the root `package.json`'s `@cmodjs/cli` and `@cmodjs/core` ranges to `^<new version>`, so the cmod plugin installs the release.
3. Push to `main`.

The [release workflow](.github/workflows/release.yml) then runs on GitHub:

1. It fails when the three versions differ.
2. It installs Claude Code to write `.claude-plugin/types/`, then checks and tests `@cmodjs/core` and `@cmodjs/cli`, and builds `@cmodjs/core`.
3. It publishes `@cmodjs/core` and `@cmodjs/cli` to npm through npm trusted publishing, with provenance.
4. It releases the cmod plugin on GitHub with `cmod publish`, which builds the cmod program for each machine, attaches the builds to the release, and pushes the `release` branch that Anthropic's plugin directory follows.

Each step skips what is already done: a version npm already has, or a tag that already exists. So pushing again finishes a release that stopped halfway.

The workflow's GitHub release holds a link to the commits, opened by a `## Breaking changes` list that `cmod publish` builds from each `BREAKING CHANGE:` footer and each `!` commit, such as `feat!:`, since the last tag. A commit that changes what a mod author writes carries both. Once the workflow finishes, write what the version lets people do from the commits since the last tag, with each breaking change's before and after, and set it with `gh release edit v<version> --notes-file <file>`. The `/release` Skill in `.claude/skills/` runs every step, the changelog included.

A package never published before needs one manual publish, and npm trust for the workflow, before the workflow can publish it. Run these in the package's folder, `core/` or `cli/`:

```sh
npm publish
npm trust github <package> --repository heyJordanParker/cmod --file release.yml --allow-publish
```
