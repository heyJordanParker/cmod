---
name: mods
description: Install, update, configure, and fix Claude Code mods and plugins with the cmod command. Install or remove one, turn it on or off, set an option or a hotkey, keep a secret, read the Log of failures, and press any control in Settings or a mod's view. TRIGGER when the person wants a mod installed, changed, turned off, or fixed, when a mod's toast or failure shows up, or when a task needs a mod's setting. DO NOT TRIGGER to write a mod's code; use /cmod:build-mod.
allowed-tools: Bash(cmod list:*), Bash(cmod log:*), Bash(cmod options:*), Bash(cmod ui:*), Bash(cmod sessions list:*)
---

# Mods

- A mod is a Claude Code plugin built with `@cmodjs/core`. cmod runs its install and uninstall steps, and every `cmod` command here works on any plugin.
- The person never needs Settings: each change it makes, a `cmod` command makes, and `cmod ui` presses any control it shows.

## 1. See what is installed

`cmod list` prints every plugin Claude Code has, its version, and whether cmod set it up. `cmod data` prints each mod's data folder.

## 2. Install, update, or remove

Each command takes a mod's name:
- `cmod install <owner/repo>`, or `<folder>` for a checkout, installs it through Claude Code and runs its install step
- `cmod update [<name>]` updates it, or every plugin, and runs changed install steps
- `cmod enable <name>` and `cmod disable <name>` turn it on or off
- `cmod remove <name>` uninstalls it and runs its uninstall step

### Reload the sessions that should use the change
A running session keeps the plugins it loaded and offers Reload. Tell the person a reload is waiting, or run `/reload-plugins` in this session.

## 3. Configure

`cmod options get <mod>` prints each option's value at each level. `cmod options set <mod> <key> <value>` sets one of the person's. `cmod hotkeys set <mod> <hotkey> <combo>` binds a hotkey. `cmod secrets store <mod> <key>` keeps a secret it reads from stdin, never from its arguments.

## 4. Fix a failing mod

`cmod log [<mod>]` prints every failure and warning a mod met in any session, newest first, with how often it repeated and the versions it ran on.

### Fix only what the newest versions still meet
A failure whose versions are older than what `cmod list` shows happened before an update. Read the newest entries, then the mod's own docs or session for the fix.

## 5. Press a control

`cmod ui list views <session>` lists a session's views. `cmod ui draw <session> <mod> <id>` prints one as data, Settings is `cmod settings`, with a number on each control as `{ "$cmodHandler": <n> }`. `cmod ui press <session> <n>` presses it, as the person's click does.
Example: `cmod ui draw "$CLAUDE_CODE_SESSION_ID" cmod settings`, then `cmod ui press "$CLAUDE_CODE_SESSION_ID" 12`
