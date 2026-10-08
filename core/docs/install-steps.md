# Install steps

A mod that changes the machine, such as by adding a shell alias or downloading a program, names its install and uninstall steps in its `package.json`. The cmod program of Claude Mod Manager (cmod) runs them with the person's consent, and runs the uninstall step after the person removes the mod. The library never runs them.

## The cmod key

```json
{
  "cmod": {
    "install": "./setup/install.sh",
    "uninstall": "./setup/uninstall.sh",
    "program": "hello",
    "keys": { "shift+tab": "/mode" }
  }
}
```

Each key is optional.

- `install` is one shell command that sets the mod up.
- `uninstall` is one shell command that undoes it.
- `program` is the name of a program cmod downloads from the mod's GitHub release, and Claude Code then runs by its name. [Ship a program](#ship-a-program) explains it.
- `keys` binds keys in Claude Code to the mod's slash commands. [Key bindings](#key-bindings) explains it.

cmod refuses a `cmod` key that breaks these rules, with the fix in the message:

- `cmod` is an object.
- `install` and `uninstall` are each one command on one line, with no tab.
- Each names at least one script file inside the mod, and no script at the mod's root. cmod asks consent for the whole folder of each script, so put the scripts in a folder, such as `setup/`.
- A symbolic link in a script folder points at a file.
- `program` is a command name: letters, digits, `.`, `_`, and `-`, starting with a letter or digit.
- `keys` binds at least one key, and each binds one of the mod's commands as `/<name>`.
- `.claude-plugin/plugin.json` has a `version`.

## Consent

Before a step runs for the first time, cmod shows the person the commands, the keys, and the permissions, and asks to run them. cmod hashes the commands, the keys, the permissions, and every file in each script folder, and remembers the hash the person approved with each permission. A change to any of those asks again, and an added permission is the only one it asks about ([permissions.md](permissions.md)).

- In Claude Code, the mod opens the installer pane, `Install <mod>`, focused. It lists `<mod> wants to:`, each permission as one sentence, then `and change your computer:` with `Run <install> now, and <uninstall> when you remove it` and `Bind shift+tab to /mode`, naming only what the mod has. `Accept` (a) runs the setup, and a progress line above the prompt shows the install. `Not now` (n) and Escape decline.
- In a session with no screen, such as `claude -p`, the mod waits and logs `<mod> waits for consent to run <install>. Run cmod install <mod> in a terminal.`
- In a terminal, `cmod install`, `cmod link`, `cmod try`, and `cmod update` print the commands, the program, the keys, and the permissions, and ask `Set up <mod>? [y/N]`. `--yes` approves without asking.
- `Not now` leaves the mod off and logs `<mod> is not installed. Run cmod install <mod> to install it.`

The mod starts only once its install step has run ([mod.md](mod.md)).

## Automatic updates

Claude Code updates a plugin by itself only when its marketplace has automatic updates on, and they are off for every marketplace that is not Anthropic's. So the setup of a mod installed from a marketplace turns them on, through `"autoUpdate": true` on that marketplace's `extraKnownMarketplaces` entry in `settings.json`. The consent lists it as `Update <mod> automatically from the <marketplace> marketplace`, and a mod with nothing to consent to logs it. The setup never changes a choice the person made, in `settings.json` or with the toggle under `/plugin` Marketplaces, and leaves a linked mod alone.

Claude Code downloads an update in the background and loads it at the next launch or `/reload-plugins`. An update whose scripts, keys, or permissions changed waits for consent again, so an update never runs a new install step unasked.

In Claude Code, the mod sets itself up through the `cmod` in cmod's programs folder, or else the one PATH finds, and only through one that knows every step it has. A mod with `keys` waits for cmod 0.1.12 or later, because an older cmod skips the keys, and a mod with `permissions` waits for cmod 0.2.0 or later, because an older cmod grants none of them. While PATH finds an older one, the line above the prompt says `PATH finds cmod <version>, and <mod> needs cmod 0.1.12 or later. Run npm i -g @cmodjs/cli, or put ~/.local/bin ahead of the old cmod on PATH.` The mod sets up as soon as a new enough cmod answers, such as the one the cmod plugin installs into `~/.local/bin` at its first start.

## Steps in Claude Code

Some setup only the person can do, such as signing in to a service. A mod lists those steps in `installer`, and the installer pane shows each one after the permissions and the options, once the mod has started:

```ts
import { defineStep } from '../node_modules/@cmodjs/core/installer.js'

const signIn = defineStep({
  id: 'sign-in',
  title: 'Sign in to GitHub',
  render: () => <Text>Run gh auth login in a terminal, then press Next.</Text>,
  isDone: async (mod) => (await mod.process.run(['gh', 'auth', 'status'])).exitCode === 0,
})

export const ciWatch = defineMod({ name: 'ci-watch', installer: [signIn], setup(mod) { … } })
```

```ts
defineStep<State>(step: { id: string; title: string; render(mod, props): RenderElement; isDone(mod): boolean | Promise<boolean> }): Step<State>
```

- `id` is 1 to 64 letters, digits, `_`, or `-`. `title` is the line above the step, with `(1 of 2)`. `defineStep` throws for either one missing.
- `render` draws the step's body, the way a pane's `render` does ([ui.md](ui.md)).
- `isDone` says whether the step is finished. A step that is done is skipped, so the pane opens only for what is left. `Next` checks `isDone`, and shows `Finish <title> first.` while it is false. The last step's button says `Finish`.
- `Not now` closes the pane and logs `<mod> needs one more step, starting with <title>. Run /mods <mod> to finish.` The mod keeps running. `/mods <mod>` shows `Needs setup: <title>` with a `Finish setup` button, which opens the pane on the first step left.

## Key bindings

A plugin cannot bind a key in Claude Code: Claude Code reads key bindings only from the person's `keybindings.json`. So cmod writes the mod's `keys` there, with consent, as the setup's last step:

```json
{ "bindings": [{ "context": "Chat", "bindings": { "shift+tab": "command:mode" } }] }
```

- cmod writes each key into the `Chat` bindings of `~/.claude/keybindings.json`, or of `$CLAUDE_CONFIG_DIR/keybindings.json` when that variable is set. When the file is a symbolic link, cmod writes the file it points to. Claude Code reads the change at once, with no restart.
- A key the person already bound to something else stays theirs. cmod logs `~/.claude/keybindings.json binds <key> to "<action>", so it stays. To use /<name> on <key>, put "<key>": "command:<name>" in its Chat bindings.`
- An upgrade that drops a key removes its binding. Removing the mod removes each binding it added that still runs its command, and a `Chat` block that leaves empty, and leaves a binding the person changed.
- A key's command takes `immediate: true` and a `reply` that returns `undefined`, so it works while Claude works and adds no row to the conversation ([jobs.md](jobs.md#slashcommand)). A key bound to `shift+tab` replaces Claude Code's own mode switch, and Claude Code then drops its `shift+tab` hint.

## How a step runs

cmod runs a step with `sh -c "<command>"` in the mod's folder. So `./setup/install.sh` runs the script itself, and the script must be executable: `chmod +x setup/*.sh`.

The step gets these environment variables:

| Variable | Value |
| --- | --- |
| `CMOD_PLUGIN_ROOT` | The mod's folder |
| `CMOD_DATA` | The mod's data folder, which cmod creates first. It is the folder `mod.dataFolder` names. |
| `CMOD_VERSION` | The mod's version from `plugin.json` |
| `PATH` | The person's `PATH`, with the cmod program's own folder first, so the step can run `cmod download`, then cmod's programs folder |

- A line `progress <done> <total> <label>` on standard output moves the progress bar.
- Every other line goes to the log.
- The last line on standard error names the failure when the step fails.

## When the install step runs again

The install step runs again on every new version of the mod and whenever its scripts change. An unchanged mod runs nothing. So the install step must work over an existing install.

## When the install step fails

- When the first install of a mod fails or is stopped, cmod runs the uninstall step to undo it. So the uninstall step must work on a partial install.
- When the install step of an upgrade fails or is stopped, cmod keeps the version it set up before.
- The failure shows on the mod's progress line with `Fix the cause, then run: cmod install <mod>`.

## The uninstall step

When the install step succeeds, cmod saves a copy of every script folder the uninstall step names. It runs the uninstall step from that copy, so it runs after the mod's own folder is gone.

- After the person removes the mod with `/plugin uninstall`, the cmod plugin runs the uninstall step at the next session start or prompt.
- `cmod remove <mod>` uninstalls the mod and runs the step at once.
- In the copy, `CMOD_PLUGIN_ROOT` is the copy's folder, and `CMOD_DATA` and `CMOD_VERSION` are the same as at install.
- After the step, cmod deletes the mod's install record, its program, its data folder, and the approvals of its scripts. It keeps the mod's config folders, because the files there are the person's.
- A failed uninstall step keeps the record. `cmod teardown <mod>` runs it again.

## Example

`setup/install.sh` works over an existing install. It writes the alias file again, and adds the line to `.zshrc` only when it is missing:

```sh
#!/bin/sh
set -e
echo 'progress 0 1 Writing the alias'
printf "alias gs='git status'\n" > "$CMOD_DATA/aliases.sh"
grep -qF "$CMOD_DATA/aliases.sh" "$HOME/.zshrc" 2>/dev/null || printf '. "%s"\n' "$CMOD_DATA/aliases.sh" >> "$HOME/.zshrc"
echo 'progress 1 1 Wrote the alias'
```

`setup/uninstall.sh` works on a partial install. It removes the line only from a `.zshrc` that exists, and writes the file in place, so a `.zshrc` that is a symbolic link stays one:

```sh
#!/bin/sh
set -e
[ -f "$HOME/.zshrc" ] || exit 0
kept=$(mktemp)
grep -vF "$CMOD_DATA/aliases.sh" "$HOME/.zshrc" > "$kept" || true
cat "$kept" > "$HOME/.zshrc"
rm "$kept"
```

cmod deletes `$CMOD_DATA` itself after the uninstall step.

## Download a program in an install step

```sh
cmod download <program> <machine> <url> <sha256> [<machine> <url> <sha256> …]
```

An install script runs `cmod download` to fetch a program built by someone else. It picks the download for this machine, checks its SHA-256, unpacks a `.tar.gz` or a `.zip` or takes the file as it is, and moves the file named `<program>` to `$CMOD_DATA/bin/<program>`, which Claude Code then runs by its name. A download whose SHA-256 differs installs nothing. Machines are `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`.

`$CMOD_DATA/bin/<program>` is `${mod.dataFolder}/bin/<program>` in mod code. That folder is not on `PATH`, so mod code names the program by that full path, such as `` mod.process.run([`${mod.dataFolder}/bin/mermaid-ascii`, '--help']) ``, and so does the `command` of a `program` job.

```sh
cmod download mermaid-ascii \
  darwin-arm64 https://example.com/mermaid-ascii_Darwin_arm64.tar.gz <sha256> \
  linux-x64    https://example.com/mermaid-ascii_Linux_x86_64.tar.gz <sha256>
```

## Ship a program

A mod that builds its own command-line program keeps its source in `cli/`, and cmod builds it, releases it, and puts it on the person's `PATH`.

1. `cli/package.json` declares the build:

   ```json
   {
     "name": "hello",
     "bin": { "hello": "bin/hello" },
     "cmod": { "build": "bun run build", "output": "dist" }
   }
   ```

   The program's name is the one `bin` command, or else `name`. A Rust program declares the same keys under `[package.metadata.cmod]` in `cli/Cargo.toml`, and its name is the one `[[bin]]` `name`, or else the `[package]` `name`.

2. The build writes one file per machine into `output`, each named `<program>-<os>-<arch>`, such as `hello-darwin-arm64`. cmod runs it with `CMOD_MACHINES` set to the machines it needs, separated by spaces: `cmod link` names this machine alone, and `cmod publish` names every machine the mod runs on ([Machines](#machines)), and fails when the build skips one. A build that ignores `CMOD_MACHINES` and builds every machine works too, only slower to link. cmod takes only the files the build wrote in that run, so a build left from an earlier run is never released.

3. The mod's own `package.json` names the program: `"cmod": { "program": "hello" }`. `.claude-plugin/plugin.json` names the GitHub `repository`.

Then:

- `cmod link` builds the program and links this machine's build into cmod's programs folder and `~/.local/bin`.
- `cmod publish` builds every machine's file and attaches each to the GitHub release `v<version>`, with a `SHA256SUMS` file. It refuses a `cli/` program that the `package.json` `program` key does not name.
- On install, cmod downloads `<repository>/releases/download/v<version>/<program>-<machine>`, checks it against `SHA256SUMS`, runs `<program> --version`, and links it into cmod's programs folder and `~/.local/bin`.
- `cmod unlink` and the uninstall remove the program and both links.

## Run a program by its name

cmod links every program it installs into its programs folder, `~/.local/share/cmod/programs/<program>` (under `$XDG_DATA_HOME` when it is set): the program `cmod.program` names, each program `cmod download` installs, and `cmod` itself. Claude Code runs the one there by its name, whatever else `PATH` holds, so a mod's `trace` wins over `/usr/bin/trace`:

- The cmod plugin's `SessionStart` hook puts the programs folder first on `PATH` for every Bash command Claude runs.
- `mod.process.run` and `mod.process.spawn` run `[name, ...args]` from the programs folder when it holds `name`. A path such as `/usr/bin/trace` runs as given.
- Install and uninstall steps find the programs folder on `PATH` after cmod's own `bun`.

cmod also links the program into `~/.local/bin/<program>` so a terminal runs it, unless a file there is not cmod's. Setup then logs which program a terminal runs, and changes nothing outside cmod's folders.

## Machines

A mod runs on macOS and Linux, on arm64 and x64, unless the `os` and `cpu` keys of its `package.json` say less. They read as npm reads them, and a `!` in front leaves a value out:

```json
{ "name": "safe-delete", "os": ["darwin"], "cpu": ["arm64"] }
```

- Setup refuses a machine the mod leaves out before any script runs, with `safe-delete runs on macOS on arm64, and this is Linux, so cmod set up nothing.`, in the terminal and in the mod's progress line in Claude Code.
- `cmod publish` builds the program for each machine the mod runs on.
- `cmod check` fails when a `cmod download` line in the install step has no download for one of those machines, and when `os` or `cpu` names a value cmod does not run mods on, such as `win32`.

Claude Code itself has no field for this, and installs the mod on any machine.

The cmod repository ships the `cmod` program this way. Its `package.json` holds `"cmod": { "program": "cmod" }`, and its `cli/package.json` holds `"cmod": { "build": "bun run build", "output": "dist" }`.
