---
title: Privacy policy
---

# Privacy policy

Last updated October 7, 2026.

Claude Mod Manager (cmod) collects nothing about you. It has no accounts, no analytics, and no telemetry, and it never sends your code, your prompts, or your files anywhere.

## What cmod connects to

cmod only goes online to fetch what you asked for:

- **GitHub**, to download the cmod program and the mods you install, and to clone or push a repository when you run `cmod try` or `cmod publish`.
- **npm**, to install the packages a mod uses, and the type checker and linter that `cmod check` runs.

GitHub and npm see those requests the way they see any download, under the [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) and the [npm Privacy Policy](https://docs.npmjs.com/policies/privacy).

## What stays on your machine

cmod keeps the cmod program, each mod's data, the list of mods it set up, and the install steps you approved. All of it stays on your machine, in `~/.local/share/cmod/` and in Claude Code's own storage.

## Mods made by other people

A mod is its own software, and it can send data wherever its author wrote it to. Check what a mod does before you install it. When a mod wants to run commands on your machine, cmod shows you the commands and asks first.

## This website

claudemodmanager.com runs on GitHub Pages. It sets no cookies and runs no analytics, and its fonts and search load from this site. GitHub keeps its own server logs under the GitHub Privacy Statement.

## Changes and questions

Any change to this policy shows up on this page and in the [repository's history](https://github.com/heyJordanParker/cmod/commits/main/site/privacy.md). Ask anything by [opening an issue](https://github.com/heyJordanParker/cmod/issues).
