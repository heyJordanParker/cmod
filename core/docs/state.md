# State

`mod.state` holds the mod's values. Claude Mod Manager (cmod) saves them, redraws the mod's panes and slot renders when one changes, and lets a person change the starting values without touching the mod's code.

## Declare the state

`defineMod`'s `state` groups the starting values by how long they last:

| Group | How long a value lasts | Saved |
| --- | --- | --- |
| `memory` | Until `/clear`, `--resume`, `/branch`, or a reload of Claude Code or its plugins. A compaction keeps it. | No |
| `session` | This conversation. It comes back on `--resume`, starts over on `/clear`, and `/branch` copies it. | Yes |
| `project` | This project, in every conversation. | Yes |
| `global` | Every project. | Yes |

cmod keeps each `session` value for the 20 sessions that wrote it last, and each `project` value for the 20 projects that wrote it last. A session or project past those 20 starts that value over from its starting value.

Put values the mod works out again on every prompt, such as a git status, in `memory`.

Declare the state in its own file with its type, as `cmod new` does:

```ts
export type TasksState = {
  memory: { changedFiles: readonly string[] }
  session: { prompts: number }
  project: { isFrozen: boolean }
  global: { defaultCommitPolicy: 'ask' | 'never' }
}

export const initialState: TasksState = {
  memory: { changedFiles: [] },
  session: { prompts: 0 },
  project: { isFrozen: false },
  global: { defaultCommitPolicy: 'ask' },
}
```

Then pass it to `defineMod`:

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { initialState } from './state.js'

export const tasks = defineMod({
  name: 'tasks',
  state: initialState,
  setup(mod) {
    mod.on('UserPromptSubmit', () => {
      mod.state.session.prompts += 1
    })
  },
})
```

A group other than `memory`, `session`, `project`, and `global` throws `<mod>: state.<group> is not a lifetime.` when the mod starts. A group that is not an object of values throws too.

## Change a value

Assign to a key. cmod saves the new value and redraws the mod.

- A key the state does not declare throws `<mod>: mod.state.<group>.<key> is not declared. Add it to state.<group> in defineMod with its starting value.`
- An object or an array in the state is frozen. Changing it in place throws `<mod>: mod.state.<path> cannot change in place.` Assign a new value instead:

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'

export const reads = defineMod({
  name: 'reads',
  state: { memory: { readFiles: [] as readonly string[] } },
  setup(mod) {
    mod.on('PostToolUse', (input) => {
      mod.state.memory.readFiles = [...mod.state.memory.readFiles, ...input.files.read]
    })
  },
})
```

- Keep only JSON data in a saved group. A value cmod cannot save logs `<mod> could not keep state.<group>.<key>: <error>. Keep only JSON data in mod.state.`
- cmod saves values one at a time in the order they were assigned.

## Where the values come from

When the mod starts, each value is the value the mod saved for this session, this project, or globally, or else the starting value in `defineMod`. After a `/cd` to another project, cmod loads that project's `project` values.

`mod.state` holds what the mod owns and changes as it runs. What a person sets, such as a token or a branch to watch, is an option ([options.md](options.md)).

## Let a person replace a Skill's text

Each mod has two config folders, outside its code:

```text
~/.claude/cmods/<mod>/              the person's own, in every project
<project>/.claude/cmods/<mod>/      the team's, committed with the repository
```

`CLAUDE_CONFIG_DIR` moves `~/.claude`. Removing the mod keeps both folders. The project folder also holds the team's options, in `options.json` ([options.md](options.md)).

A person replaces the text of a Skill the mod ships by putting a file at the same path in a config folder:

```text
~/.claude/cmods/<mod>/skills/<skill>/SKILL.md
<project>/.claude/cmods/<mod>/skills/<skill>/SKILL.md
```

- Claude reads that file in place of the mod's from the next time the Skill loads, and updates of the mod keep it.
- The project file wins over the person's file.
- cmod drops the file's frontmatter, so the mod's own name and description stay.
- Only a Skill the mod ships in `skills/<skill>/` is replaced, and only when it loads as `<mod>:<skill>`.
- Deleting the file brings the mod's text back.

## Test state

`testMod(mod, { state: { session: { prompts: 3 } } })` starts the tested mod with those values over the declared ones. `tested.state` reads the values after a test step. [testing.md](testing.md) covers both.
