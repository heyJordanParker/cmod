# Options

An option is a value a person sets for a mod and the mod reads, such as a token, a URL, or how often to check. The mod declares its options in `defineMod`, and `mod.options` holds their values, typed from the declaration. Claude Code stores them: it shows each one in `/config`, keeps a secret in the system keychain, and reloads the mod when one changes.

`mod.state` is the other kind of value: what the mod owns and changes as it runs ([state.md](state.md)).

## Declare the options

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { option } from '../node_modules/@cmodjs/core/options.js'

export const ciWatch = defineMod({
  name: 'ci-watch',
  options: {
    githubToken: option.secret({ title: 'GitHub token', description: 'Reads your CI runs' }),
    every: option.number({ title: 'Check every', description: 'Minutes between checks', default: 10, min: 1 }),
    branch: option.text({ title: 'Branch', description: 'The branch to watch', default: 'main' }),
  },
  setup(mod) {
    mod.ui.toast(`Watching ${mod.options.branch} every ${mod.options.every} minutes`)
  },
})
```

`mod.options.every` is a `number` and `mod.options.branch` a `string`, so `tsc` catches a typo or a wrong type.

| Helper | The value | Claude Code shows it as |
| --- | --- | --- |
| `option.text({ title, description, default? })` | `string` | a text field |
| `option.secret({ title, description })` | `string` | a masked field, kept in the keychain |
| `option.number({ title, description, default?, min?, max? })` | `number` | a number field |
| `option.toggle({ title, description, default? })` | `boolean`, `false` unless `default` says otherwise | a toggle |
| `option.choice(choices, { title, description, default? })` | one of `choices` | a picker |
| `option.folder({ title, description, default? })` | `string`, a folder path | a folder field |
| `option.file({ title, description, default? })` | `string`, a file path | a file field |
| `option.list({ title, description, default? })` | `readonly string[]` | a list of text |

- An option name is letters, digits, and `_`, starting with a letter, because Claude Code passes each option on as `CLAUDE_PLUGIN_OPTION_<NAME>`. `defineMod` throws for another name.
- `title` is the label `/config` shows. `description` is the help text under it.
- A secret has no default, so a token never ships in the mod.

## Where the values come from

Each value is, in order of precedence:

1. A value the person's organization set in managed settings. `/config` shows it locked.
2. The value in the project's `options.json`.
3. The value the person set in `/config`.
4. The `default` in the declaration.

An option with no default and no value is asked before `setup` runs, on a page of the installer pane: one field per option, each saved to `/config` through `cmod option` as the person submits it. A secret is set in `/config` itself, where Claude Code keeps it in the keychain, and the page says so. When the person chooses Not now, or no one can answer, as in `claude -p`, the mod does not start: its progress line says `it needs <title>` and `Set it in /config.`, and Claude Code reloads the mod once the value is set.

`cmod install`, `cmod link`, and `cmod try` set options from the terminal with `--option key=value`, once per option ([commands.md](commands.md)).

`mod.options` follows the values while the session runs. Read an option where you use it, as in `mod.options.branch`, so a change applies at once. A change in `/config` reloads the mod, and a `/cd` reads the new project's `options.json`.

## Set options for a team

A project sets options for everyone who works in it with an `options.json` in its config folder, committed with the repository:

```text
<project>/.claude/cmods/<mod>/options.json
```

```json
{ "branch": "release", "every": 5 }
```

cmod ignores each entry it cannot use and logs one line naming the file, the entry, and the fix:

- a file that is not JSON, or not a JSON object
- an option the mod does not declare
- a secret, because the file is committed for everyone to read
- a value the option does not take, such as `0` for an option with `min: 1`

## plugin.json userConfig

Claude Code reads a plugin's options from `userConfig` in `.claude-plugin/plugin.json` before it loads the mod. `cmod check` writes `userConfig` from the options `defineMod` declares, so the declaration is the one place to change them. `cmod publish` refuses a `plugin.json` whose `userConfig` differs: run `cmod check`, then commit `.claude-plugin/plugin.json`.

`cmod check` never writes `required`, because Claude Code refuses to load a mod while a required option has no value. cmod asks for an option with no default instead.

`userConfigOf(options)`, exported from `options.js`, returns the `userConfig` for a declaration.

## Test options

`testMod(mod, { options: { githubToken: 'ghp_test' } })` starts the tested mod with those values, as Claude Code passes them. Each option left out gets its default. A test that leaves out an option with no default fails with `<mod> needs <title>, which a person sets in /config. Give it to the tested mod: testMod(mod, { options: { <key>: … } }).` `fakes.config.list` answers the `/config` rows, so a test can lock a value as managed settings do ([testing.md](testing.md)).

```ts
const tested = testMod(ciWatch, { options: { githubToken: 'ghp_test', branch: 'develop' } })
await tested.start()
expect(tested.shown.toasts).toContain('Watching develop every 10 minutes')
```
