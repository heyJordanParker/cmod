---
name: guard-user-machine
description: Change code that acts on the User's machine (consent, permission grants, a mod's install and uninstall steps, the program link, `cmod try`, teardown, and permission rules), where two parts of cmod that disagree open a hole the User never agreed to. TRIGGER when editing `core/src/records.ts`, `core/src/runtime/grants.ts`, `cli/src/store.ts`, `cli/src/files.ts`, `cli/src/program.ts`, `cli/src/commands/setup.ts`, `grant.ts`, `teardown.ts`, or `try.ts`, the cmod plugin's `src/mod.ts`, `readPlugin` in `core/src/runtime/lifecycle.ts`, or `core/src/jobs/permissions/`. DO NOT TRIGGER for what a mod author writes against; use /change-public-api.
---

# Guard User Machine

A mod runs its steps on the User's machine with the User's consent, and cmod cleans up after it. One function decides each trust question, and every part it relies on agrees with it. A hole opens where two parts disagree, or at a way a session ends that no test tries.

## 1. Change the one function that decides

- `scriptsSha256` in `core/src/records.ts` decides consent, for the cmod program (`cli/src/commands/setup.ts`, `cli/src/commands/check.ts`) and the SDK (`readPlugin` in `core/src/runtime/lifecycle.ts`) alike.
- `readSteps` in `core/src/records.ts` is the one parser of the `package.json` `cmod` key, permissions included.
- `parseConsent` in `core/src/records.ts` is the one reader of `consent.json`, which maps each mod to its approved hashes and granted permissions, for the cmod program (`cli/src/store.ts`) and the SDK (`readPlugin`) alike.
- `isCovered` in `core/src/runtime/grants.ts` decides whether a grant covers a call, and `checkingGrants` there is the one gate every gated `mod` call passes.
- `restoreProgram` in `cli/src/program.ts` decides which program version the program's links point at, in cmod's programs folder and `~/.local/bin`. `linkProgram` there never replaces a `~/.local/bin` file cmod did not make.
- `refuseThisMachine` in `cli/src/program.ts` decides whether setup runs on this machine, from the `os` and `cpu` keys of the mod's `package.json`.
- `takeLock` in `cli/src/store.ts` decides which cmod command changes a mod. Setup and teardown take one lock per mod, `records/<name>.json.lock/<pid>` in the cmod store (`modLock` in `cli/src/store.ts`), and approvals change under `consent.json.lock/<pid>`. A lock whose holder's process is gone, or whose process ID now belongs to another process (its start time differs), is taken over at once.

### Change the decider, never a copy of it
A second check beside it disagrees with it on the first input nobody listed.

## 2. Make every reader and lister agree on what a file is

`listFiles` in `cli/src/files.ts`, `filesBelow` in `core/src/runtime/lifecycle.ts`, and the test kit's `fakeFiles` in `core/src/testing/fake-files.ts` each list a symbolic link. `scriptsSha256` hashes what `read` returns through the link, and `saveUninstall` copies through it.

### Change every lister and reader in the same change
Example: when the listers skipped links and `read` followed them, a changed file behind a link ran without consent.

## 3. Keep the four guarantees

### Make every cleanup survive every way a session ends
SIGINT, SIGHUP from a closed terminal, and SIGTERM each still run the cleanup. `holdSignals` in `cli/src/commands/setup.ts` holds all three. `setupInTerminal`, `teardownInTerminal`, both `--events` paths, `cmod unlink`, and `cmod try` for its whole session share one hold, and the signal is raised again when the last of them ends. Every uninstall step runs under `uninterruptible`, to its end.

### Never delete what an installed mod still uses
`cmod try` refuses when another root owns the mod's record. The cmod plugin decides a removal from the user-scope `enabledPlugins` alone (`mod.claude.settings.read({ source: 'user' })`), because Claude Code keeps an uninstalled plugin's folder for 6 hours (`.orphaned_at`).

### Put the machine back to what the record names
Example: a failed upgrade relinks the program version the record names, through `restoreProgram`.

### Anchor a rule the User writes on what Claude cannot move
Permission patterns resolve against `projectRoot`, never `cwd`, which follows Claude's `cd`.

## 4. Test with the input that breaks it, red before green

Write each test with /write-test, and watch it fail on the code before the fix. Inputs that break this code: a changed file behind a symbolic link, SIGHUP to `cmod try` while the fake `claude` runs, a `cd` before the call, an upgrade that fails after the new program is linked, two commands on one mod at once, and a lock whose holder's process is gone.
Never: a fake that does the work the code under test must do, such as a fake `claude` that runs setup itself.

### Prove session ends and installs in Claude Code with /verify-live
A teardown on the next prompt, a `cmod try` session that exits, and a consent dialog are proven only in a session.
