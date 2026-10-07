# Install steps

A mod that changes the machine, such as by adding a shell alias or downloading a program, names its install and uninstall steps in its `package.json`. The cmod program of Claude Mod Manager (cmod) runs them with the person's consent, and runs the uninstall step after the person removes the mod. The library never runs them.

## The cmod key

```json
{
  "cmod": {
    "install": "./setup/install.sh",
    "uninstall": "./setup/uninstall.sh",
    "program": "hello"
  }
}
```

Each key is optional.

- `install` is one shell command that sets the mod up.
- `uninstall` is one shell command that undoes it.
- `program` is the name of a program cmod downloads from the mod's GitHub release into `~/.local/bin`. [Ship a program](#ship-a-program) explains it.

cmod refuses a `cmod` key that breaks these rules, with the fix in the message:

- `cmod` is an object.
- `install` and `uninstall` are each one command on one line, with no tab.
- Each names at least one script file inside the mod, and no script at the mod's root. cmod asks consent for the whole folder of each script, so put the scripts in a folder, such as `setup/`.
- A symbolic link in a script folder points at a file.
- `program` is a command name: letters, digits, `.`, `_`, and `-`, starting with a letter or digit.
- `.claude-plugin/plugin.json` has a `version`.

## Consent

Before a step runs for the first time, cmod shows the person the commands and asks to run them. cmod hashes the commands and every file in each script folder, and remembers the hash the person approved. A change to any of those files asks again.

- In Claude Code, the mod asks `<mod> runs <install> to install, and <uninstall> when you remove it. Run it now?` with `Install` and `Not now`. A progress line above the prompt shows the install.
- In a session with no screen, such as `claude -p`, the mod waits and logs `<mod> waits for consent to run <install>. Run cmod install <mod> in a terminal.`
- In a terminal, `cmod install`, `cmod link`, `cmod try`, and `cmod update` print the commands and ask `Run them? [y/N]`. `--yes` approves without asking.
- `Not now` leaves the mod off and logs `<mod> is not installed. Run cmod install <mod> to install it.`

The mod starts only once its install step has run ([mod.md](mod.md)).

## How a step runs

cmod runs a step with `sh -c "<command>"` in the mod's folder. So `./setup/install.sh` runs the script itself, and the script must be executable: `chmod +x setup/*.sh`.

The step gets these environment variables:

| Variable | Value |
| --- | --- |
| `CMOD_PLUGIN_ROOT` | The mod's folder |
| `CMOD_DATA` | The mod's data folder, which cmod creates first. It is the folder `mod.dataFolder` names. |
| `CMOD_VERSION` | The mod's version from `plugin.json` |
| `PATH` | The person's `PATH`, with the cmod program's own folder first, so the step can run `cmod download` |

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

An install script runs `cmod download` to fetch a program built by someone else. It picks the download for this machine, checks its SHA-256, unpacks a `.tar.gz` or a `.zip` or takes the file as it is, and moves the file named `<program>` to `$CMOD_DATA/bin/<program>`. A download whose SHA-256 differs installs nothing. Machines are `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`.

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

2. The build writes one file per machine into `output`, each named `<program>-<os>-<arch>`, such as `hello-darwin-arm64`. cmod runs it with `CMOD_MACHINES` set to the machines it needs, separated by spaces: `cmod link` names this machine alone, and `cmod publish` names all four. A build that ignores `CMOD_MACHINES` and builds every machine works too, only slower to link. cmod takes only the files the build wrote in that run, so a build left from an earlier run is never released.

3. The mod's own `package.json` names the program: `"cmod": { "program": "hello" }`. `.claude-plugin/plugin.json` names the GitHub `repository`.

Then:

- `cmod link` builds the program and links this machine's build to `~/.local/bin/<program>`.
- `cmod publish` builds every machine's file and attaches each to the GitHub release `v<version>`, with a `SHA256SUMS` file. It refuses a `cli/` program that the `package.json` `program` key does not name.
- On install, cmod downloads `<repository>/releases/download/v<version>/<program>-<machine>`, checks it against `SHA256SUMS`, runs `<program> --version`, and links it to `~/.local/bin/<program>`.
- cmod refuses to replace a `~/.local/bin/<program>` it did not make, and a program `PATH` finds in a folder ahead of `~/.local/bin`.
- `cmod unlink` and the uninstall remove the program.

The cmod repository ships the `cmod` program this way. Its `package.json` holds `"cmod": { "program": "cmod" }`, and its `cli/package.json` holds `"cmod": { "build": "bun run build", "output": "dist" }`.
