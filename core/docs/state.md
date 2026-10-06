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

When the mod starts, each value is, in order of precedence:

1. The value the mod saved for this session, this project, or globally.
2. The value in the project's `state.json`.
3. The value in the person's own `state.json`.
4. The starting value in `defineMod`.

After a `/cd` to another project, cmod loads that project's `project` values and reads its `state.json` again.

## Let a person change the starting values

Each mod has two config folders, outside its code:

```text
~/.claude/cmods/<mod>/              the person's own, in every project
<project>/.claude/cmods/<mod>/      the team's, committed with the repository
```

`CLAUDE_CONFIG_DIR` moves `~/.claude`. Removing the mod keeps both folders.

A `state.json` in either folder lists only the values to change:

```json
{ "global": { "defaultCommitPolicy": "never" }, "session": { "prompts": 10 } }
```

- A `session` value is what each new conversation starts with. A `project` value is what each project starts with.
- A file in the project folder wins over the same value in the person's folder.
- A project `state.json` cannot set `global` values, because one repository cannot change a value for every project.
- A file cannot set `memory` values.

cmod ignores each entry it cannot use and logs one line naming the file, the entry, and the fix:

- a file that is not JSON, or not a JSON object
- a group the mod does not declare
- a key the mod does not declare
- a value whose type differs from the starting value's
- a `global` value in a project file
- a `memory` value

## Let a person replace a Skill's text

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
