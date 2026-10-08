# Permissions

A mod declares what it does beyond drawing and answering hooks: the hosts it connects to, the programs it runs, the files it changes outside its project, and whether it reads the conversation, adds text Claude reads, asks a model, starts agents, uses Claude's tools, changes Claude Code's settings, or approves tool calls. The person sees each permission as one sentence when they install the mod, turns each one on or off in `/mods`, and cmod checks every call and every answer against what they granted.

Permissions bind every mod built on `@cmodjs/core`, and the plugin directory reads them from `package.json`. They are a contract, not a sandbox: a Claude Code plugin can skip cmod and call Claude Code directly.

## Declare the permissions

They sit in the `package.json` `cmod` key, beside `install` and `keys`, because the person reads them before any of the mod's code runs:

```json
"cmod": {
  "permissions": { "network": ["api.github.com"], "run": ["gh"], "prompt": true, "model": true }
}
```

| Permission | The person reads | cmod checks |
| --- | --- | --- |
| `"network": ["api.github.com"]` | Connect to api.github.com | `mod.http.fetch` to that host. A path starting with `/` or `~/` names a socket, such as `"~/.docker/run/docker.sock"` |
| `"run": ["gh"]`, or `"run": "*"` | Run gh on your computer | `mod.process.run`, `mod.process.spawn`, and the `program` and `check` jobs. A program matches by its file name, so `"mermaid-ascii"` covers `${mod.dataFolder}/bin/mermaid-ascii` and the copy in cmod's programs folder |
| `"files": ["~/.zshrc"]` | Change ~/.zshrc | `mod.fs.write` and `mod.metadata.update` outside the project and the mod's data folder. A folder covers every file below it |
| `"conversation": true` | Read this conversation | `mod.session.messages`, and reading Claude Code's transcript files |
| `"prompt": true` | Add text Claude reads and start turns | `mod.session.append`, `mod.session.submit`, the `prompt` and `schedule` jobs, and the hook answers listed below |
| `"model": true` | Ask a model, which uses your plan | `mod.model.complete` |
| `"agents": true` | Start agents | `mod.agent.spawn` |
| `"tools": true` | Use and change Claude's tool calls | `mod.claude.tool.call`, and a hook that changes a tool call's input |
| `"config": true` | Change your Claude Code settings | writes to `.claude/settings.json`, `.claude/settings.local.json`, and `.mcp.json` |
| `"approve": true` | Approve Claude's tool calls for you | an allow or an ask from the mod's permission rules or hooks, and a `retry`. A deny needs no permission |

Reading files, drawing panes and slot renders, toasts, slash commands, tools of the mod's own, and hooks need no permission.

`cmod check` adds `"approve": true` to `package.json` when `hooks/register.ts` calls `registerPermissionCheck` and the line is missing, and says so.

## What the person sees

The install opens the installer pane in Claude Code and lists every permission in `permissions`, with the install step, the program, and the keys. An update asks again only when it adds a permission, and lists only the new ones. Removing the mod revokes everything it was granted.

`/mods <mod>` lists the same permissions as toggles. A toggle runs `cmod permission <mod> <name> [value] on|off`, and the mod sees the change before its next call, with no reload.

`cmod check` prints the sentences, so you read what the person will see:

```text
✔ At install the person grants: Connect to api.github.com; Run gh on your computer; Ask a model, which uses your plan
```

## Check a permission before a feature uses it

```ts
mod.permissions.has(name: 'network' | 'run' | 'files', value: string): boolean
mod.permissions.has(name: 'conversation' | 'prompt' | 'model' | 'agents' | 'tools' | 'config' | 'approve'): boolean
```

`has` says whether the person has the permission turned on, so a mod hides a feature instead of failing it:

```ts
if (mod.permissions.has('model')) {
  const verdict = await mod.model.complete({ prompt: 'Is this reply a waste of time?' })
}
```

## When a call has no grant

The call rejects, and the error names the fix:

- An undeclared call names the line to add: `ci-watch calls http.fetch(https://api.github.com/repos), which needs "permissions": { "network": ["api.github.com"] } in package.json "cmod".`
- A declared call the person turned off names where to turn it on: `ci-watch calls model.complete without your grant to "Ask a model, which uses your plan". Turn it on in /mods ci-watch.`
- A `program` job without its grant stops at once with the same line, with no restarts.

## When a hook answer has no grant

cmod checks the answer each hook returns, part by part. A part without its grant is dropped, and cmod logs once per permission which part it dropped and how to fix it:

```text
ci-watch answered additionalContext without your grant to "Add text Claude reads and start turns", so cmod dropped it. Turn it on in /mods ci-watch.
```

| Answer part | Permission |
| --- | --- |
| `additionalContext`, `initialUserMessage`, `suppressOriginalPrompt`, `updatedToolOutput`, a `prompt` job's text | `prompt` |
| a Stop or PostToolUse block | `prompt` |
| `updatedInput`, and a changed tool input passed down the chain | `tools` |
| an allow or an ask, and `retry` | `approve` |

A deny needs no permission. A tool of the mod's own, `mcp__<mod>__*`, answers freely.

## Test permissions

`testMod` grants what the mod's `package.json` declares, so tests run as an installed mod does. An undeclared call fails the test with the line to add. `testMod(mod, { permissions: ['network:api.github.com'] })` grants exactly the list instead, so a test checks what happens with a permission turned off ([testing.md](testing.md)).
