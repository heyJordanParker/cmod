---
name: release
description: Release a new cmod version, so npm, the GitHub release, and the cmod plugin carry it and the GitHub release says what changed. TRIGGER on "release", "publish", "ship", "cut a version", and after a /commit the Architect asked to release. DO NOT TRIGGER for a mod's own release; `cmod publish` in that mod's folder does it.
---

# Release

A person reads the GitHub release to learn what a version lets them do, and what they must change in their mod before they update. `cmod publish` writes the release's notes from the version's section of the root `CHANGELOG.md`, and refuses a version with no section. So the changelog is written before the release, by hand, for the people who use cmod.

- `.claude-plugin/plugin.json`, `core/package.json`, and `cli/package.json` share one version.
- Pushing to `main` runs `.github/workflows/release.yml`, which publishes both npm packages, commits `marketplace.json`, tags `v<version>` and the release commit `cmod--v<version>`, and creates the GitHub release through `cmod publish`.
- A mod's `"cmod"` dependency range installs only from a `cmod--v<version>` tag on the `release` branch commit, so a release without it breaks every fresh install of a mod that names a range.

## 1. Raise the version

Raise the version in all three files to the same new version.

IF a commit since the last release changes or removes anything a mod author writes: an export, a `Mod` member, a `ModDefinition` key, a `package.json` `cmod` key, a `cmod` command or flag, or what a hook answer does:
### Raise the major version, and mark the commit breaking
Type the commit with `!`, such as `feat!:`, and end its body with a `BREAKING CHANGE:` paragraph, before the file tree, naming what the author changes, in one paragraph with no blank line: `BREAKING CHANGE: mod.history moved to the sessions import. Read sessions.current.messages() for mod.history.messages().`

## 2. Write the version's section of CHANGELOG.md

Rename `## [Unreleased]` to `## [<version>] - <date>`, add an empty `## [Unreleased]` above it, and fill the section from every commit since the last release, `git log --format=%B v<last>..HEAD`.

### Write what a person can do now, never the files
Put each change under `### Added`, `### Changed`, `### Removed`, or `### Fixed`, largest effect on the person first. A breaking change goes under Changed or Removed and says what the author writes instead. Leave out file trees, test names, and internal names a mod author never types.
Example: `- mod.history is gone. Read sessions.current.messages() instead.` under `### Removed`.

## 3. Pass the gate, commit, and push

Run the /repack-core end gate, commit with /commit, then `git push origin main`.

### Date the version's section with the day you push
Set `<date>` in `## [<version>] - <date>` to today's date just before the release commit, even when the section was written on an earlier day.

## 4. Watch the release to its end

Run `gh run watch <run id> --exit-status` on the run the push started. Then `git pull --ff-only`, which brings the release bot's `marketplace.json` commit.

### Prove the release reached people
`gh release view v<version> --repo heyJordanParker/cmod` shows the changelog section. `git ls-remote origin refs/tags/cmod--v<version>` prints the same commit as `git ls-remote origin refs/heads/release`. `npm view @cmodjs/core@<version> version` and `npm view @cmodjs/cli@<version> version` print the version. The release lists `cmod-<version>.zip`, `SHA256SUMS`, and a `cmod-<os>-<arch>` build for `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`.

## 5. Clear the Log

`cmod log --json` lists every failure and warning any session on this computer met, newest first, with its mod, `count`, and the versions it ran on. An entry whose `versions.cmod` is older than the newest release on this computer happened before an update and needs no fix.

### Fix each failure the newest cmod still meets
A failure of `cmod` is yours: find its root cause and fix it before the next release. A failure of another mod goes to that mod's own session with the entry's text and count, through `SendMessage`, because its repository is not yours.
Never: edit another mod's repository, or hide a failure from the Log to quiet its toast.
