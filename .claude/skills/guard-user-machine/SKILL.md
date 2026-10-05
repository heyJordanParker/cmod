---
name: guard-user-machine
description: Change code that acts on the User's machine (consent, a mod's install and uninstall steps, the program link, `cmod try`, teardown, and permission rules), where two parts of CMod that disagree open a hole the User never agreed to. TRIGGER when editing `sdk/src/records.ts`, `cli/src/files.ts`, `cli/src/program.ts`, `cli/src/commands/setup.ts`, `teardown.ts`, or `try.ts`, the CMod plugin's `src/mod.ts`, `readPlugin` in `sdk/src/runtime/lifecycle.ts`, or `sdk/src/jobs/permissions/`. DO NOT TRIGGER for what a mod author writes against; use /change-public-api.
---

# Guard User Machine

A mod runs its steps on the User's machine with the User's consent, and CMod cleans up after it. One function decides each trust question, and every part it relies on agrees with it. A hole opens where two parts disagree, or at a way a session ends that no test tries.

## 1. Change the one function that decides

- `scriptsSha256` in `sdk/src/records.ts` decides consent, for the cmod program (`cli/src/commands/setup.ts`, `cli/src/commands/check.ts`) and the SDK (`readPlugin` in `sdk/src/runtime/lifecycle.ts`) alike.
- `readSteps` in `sdk/src/records.ts` is the one parser of the `package.json` `cmod` key.
- `restoreProgram` in `cli/src/program.ts` decides which program version `~/.local/bin/<program>` points at.

### Change the decider, never a copy of it
A second check beside it disagrees with it on the first input nobody listed.

## 2. Make every reader and lister agree on what a file is

`listFiles` in `cli/src/files.ts`, `filesBelow` in `sdk/src/runtime/lifecycle.ts`, and the test kit's `fakeFiles` in `sdk/src/testing/fake-files.ts` each list a symbolic link. `scriptsSha256` hashes what `read` returns through the link, and `saveUninstall` copies through it.

### Change every lister and reader in the same change
Example: when the listers skipped links and `read` followed them, a changed file behind a link ran without consent.

## 3. Keep the four guarantees

### Make every cleanup survive every way a session ends
SIGINT, SIGHUP from a closed terminal, and SIGTERM each still run the cleanup. `cmod try` handles all three for the whole session it starts, so its teardown always runs.

### Never delete what an installed mod still uses
`cmod try` refuses when another root owns the mod's record. The CMod plugin decides a removal from the user-scope `enabledPlugins` alone (`mod.settings.read({ source: 'user' })`), because Claude Code keeps an uninstalled plugin's folder for 6 hours (`.orphaned_at`).

### Put the machine back to what the record names
Example: a failed upgrade relinks the program version the record names, through `restoreProgram`.

### Anchor a rule the User writes on what Claude cannot move
Permission patterns resolve against `projectRoot`, never `cwd`, which follows Claude's `cd`.

## 4. Test with the input that breaks it, red before green

Write each test with /write-test, and watch it fail on the code before the fix. Inputs that break this code: a changed file behind a symbolic link, SIGHUP to `cmod try` while the fake `claude` runs, a `cd` before the call, and an upgrade that fails after the new program is linked.
Never: a fake that does the work the code under test must do, such as a fake `claude` that runs setup itself.

### Prove session ends and installs in Claude Code with /verify-live
A teardown on the next prompt, a `cmod try` session that exits, and a consent dialog are proven only in a session.
