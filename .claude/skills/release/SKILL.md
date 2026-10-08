---
name: release
description: Release a new cmod version, so npm, the GitHub release, and the cmod plugin carry it and the GitHub release says what changed. TRIGGER on "release", "publish", "ship", "cut a version", and after a /commit the Architect asked to release. DO NOT TRIGGER for a mod's own release; `cmod publish` in that mod's folder does it.
---

# Release

A person reads the GitHub release to learn what a version lets them do. `cmod publish` creates it with GitHub's generated notes, which hold only a compare link, so every release gets a changelog written from its commits.

- `.claude-plugin/plugin.json`, `core/package.json`, and `cli/package.json` share one version.
- Pushing to `main` runs `.github/workflows/release.yml`, which publishes both npm packages, commits `bun.lock` and `marketplace.json`, tags `v<version>`, and creates the GitHub release.
- npm can take minutes to serve a version it accepted. The workflow's last step loops on `bun install` until it does.

## 1. Raise the version

Raise the version in all three files to the same new version, and the root `package.json`'s `@cmodjs/cli` and `@cmodjs/core` ranges to `^<version>`.

## 2. Pass the gate, commit, and push

Run the /repack-core end gate, commit with /commit, then `git push origin main`.

## 3. Watch the release to its end

Run `gh run watch <run id> --exit-status` on the run the push started. Then `git pull --ff-only`, which brings the release bot's commits.

## 4. Write the changelog

Read every commit since the last release, `git log --format=%B v<last>..v<version>`. Skip the bot's `chore: the cmod plugin installs …` and `release v…` commits.

### Write what a person can do now, never the files
Group the changes by the Capability they give, largest effect on the person first, from the commit bodies' groups. Leave out file trees, test names, and internal names a mod author never types.
Template:
    ## <What a person can do now>

    - <the change, and the Problem it solves>

    **Full Changelog**: https://github.com/heyJordanParker/cmod/compare/v<last>...v<version>

## 5. Put the changelog on the release, then read it back

Write the notes to a file, run `gh release edit v<version> --repo heyJordanParker/cmod --notes-file <file>`, and check `gh release view v<version> --repo heyJordanParker/cmod` shows them.

### Prove the release reached people
`npm view @cmodjs/core@<version> version` and `npm view @cmodjs/cli@<version> version` print the version. The release lists `cmod-<version>.zip`, `SHA256SUMS`, and a `cmod-<os>-<arch>` build for `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`.
