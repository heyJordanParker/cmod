---
name: release
description: Release a new cmod version, so npm, the GitHub release, and the cmod plugin carry it and the GitHub release says what changed. TRIGGER on "release", "publish", "ship", "cut a version", and after a /commit the Architect asked to release. DO NOT TRIGGER for a mod's own release; `cmod publish` in that mod's folder does it.
---

# Release

A person reads the GitHub release to learn what a version lets them do, and what they must change in their mod before they update. `cmod publish` creates it with GitHub's generated notes, which hold only a compare link, opened by a `## Breaking changes` list it builds from the commits. So every release gets a changelog written from its commits.

- `cmod publish` lists each `BREAKING CHANGE:` footer paragraph of a commit since the last `v` tag, and the subject of each commit typed with `!`, such as `feat!:`.

- `.claude-plugin/plugin.json`, `core/package.json`, and `cli/package.json` share one version.
- Pushing to `main` runs `.github/workflows/release.yml`, which publishes both npm packages, commits `bun.lock` and `marketplace.json`, tags `v<version>`, and creates the GitHub release.
- npm can take minutes to serve a version it accepted. The workflow's last step loops on `bun install` until it does.

## 1. Raise the version

Raise the version in all three files to the same new version, and the root `package.json`'s `@cmodjs/cli` and `@cmodjs/core` ranges to `^<version>`.

IF a commit since the last release changes or removes anything a mod author writes: an export, a `Mod` member, a `ModDefinition` key, a `package.json` `cmod` key, a `cmod` command or flag, or what a hook answer does:
### Raise the minor version while the version is below 1.0.0, and mark the commit breaking
Type the commit with `!`, such as `feat!:`, and end its body with a `BREAKING CHANGE:` paragraph, before the file tree, naming what the author changes, in one paragraph with no blank line: `BREAKING CHANGE: mod.claudeSettings.read moved to mod.claude.settings.read. Rename each call.`
Never: a breaking commit with neither the `!` nor the footer, because `cmod publish` then leaves it out of the release notes.

## 2. Pass the gate, commit, and push

Run the /repack-core end gate, commit with /commit, then `git push origin main`.

## 3. Watch the release to its end

Run `gh run watch <run id> --exit-status` on the run the push started. Then `git pull --ff-only`, which brings the release bot's commits.

## 4. Write the changelog

Read every commit since the last release, `git log --format=%B v<last>..v<version>`. Skip the bot's `chore: the cmod plugin installs …` and `release v…` commits.

### Open with the breaking changes and how to update
A mod author reads this section before updating `@cmodjs/core`. Keep `## Breaking changes` first, and expand each line `cmod publish` wrote into what changed, the code before and after, and what to run, such as `cmod check`. Leave the section out when the release has none.

### Write what a person can do now, never the files
Group the changes by the Capability they give, largest effect on the person first, from the commit bodies' groups. Leave out file trees, test names, and internal names a mod author never types.
Template:
    ## Breaking changes

    ### <What changed, in the author's words>

    <why, in one sentence>

    ```diff
    - <the author's code before>
    + <the author's code after>
    ```

    ## <What a person can do now>

    - <the change, and the Problem it solves>

    **Full Changelog**: https://github.com/heyJordanParker/cmod/compare/v<last>...v<version>

## 5. Put the changelog on the release, then read it back

Write the notes to a file, run `gh release edit v<version> --repo heyJordanParker/cmod --notes-file <file>`, and check `gh release view v<version> --repo heyJordanParker/cmod` shows them.

### Prove the release reached people
`npm view @cmodjs/core@<version> version` and `npm view @cmodjs/cli@<version> version` print the version. The release lists `cmod-<version>.zip`, `SHA256SUMS`, and a `cmod-<os>-<arch>` build for `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`.
