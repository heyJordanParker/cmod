# CMod

CMod is the Claude Mod Manager. A mod is a Claude Code plugin built with cmod-sdk. It can add hooks, panes, commands, and tools, and it can run its own install step. CMod installs mods, runs their install and uninstall steps, and helps you build and publish your own.

## Install a mod

In Claude Code, add the mod's marketplace and install the mod:

```text
/plugin marketplace add <owner>/<repo>
/plugin install <mod>@<marketplace>
```

Claude Code installs the CMod plugin with the mod. CMod then fetches the cmod program, and the mod runs its install step. A progress bar shows each step. A notice tells you when the mod is ready.

When you remove a mod with `/plugin uninstall`, CMod runs the mod's uninstall step at the next session start or prompt. If Claude Code quits before the uninstall step finishes, the next session runs it again. The mod keeps running in a session that is already open until you run `/reload-plugins` there.

In a terminal, one command does the same:

```sh
cmod install <owner>/<repo>
```

The CMod plugin puts `cmod` in `~/.local/bin` the first time it runs. `cmod list` shows every mod and whether it is set up.

## Change a mod

Your changes to a mod live in its config folders, outside the mod's code. Each mod has two:

```text
~/.claude/cmods/<mod>/              yours, in every project
<project>/.claude/cmods/<mod>/      your team's, committed with the repository
```

A file in the project folder wins over the same file in yours. `CLAUDE_CONFIG_DIR` moves `~/.claude`, and removing the mod keeps both folders.

To change what a mod's values start as, write a `state.json` that lists only the values to change:

```json
{ "global": { "defaultCommitPolicy": "never" } }
```

A `session` value is what each conversation starts with, a `project` value is what each project starts with, and a `global` value is the same in every project. A value the mod saved wins over the file. A project `state.json` cannot set `global` values. The mod ignores a key it does not have and a value of the wrong type, and logs one line naming the file, the key, and the fix. CMod reads both files when the mod starts, and the project's file again after a `/cd`.

To replace the text of a Skill a mod ships, put your own file at the same path in a config folder:

```text
~/.claude/cmods/<mod>/skills/<skill>/SKILL.md
```

Claude reads your text in place of the mod's from the next time the Skill loads, and updates keep it. CMod drops the file's frontmatter, so the mod's own name and description stay. Delete the file to get the mod's text back.

## Make a mod in 30 seconds

```sh
cmod new my-mod
cd my-mod
cmod link
```

`cmod new` writes the mod and installs its packages. `cmod link` loads it in every new Claude Code session. The mod lives in `src/`:

```text
src/
├── mod.tsx                     defineMod, and the mappings: the pane, the slot renders, the hooks
├── state.ts                    the starting state, grouped by how long it lasts
├── panes/
│   └── prompts.tsx             one definePane per file
└── components/
    └── prompt-count.tsx        what the pane and the slot render draw with
```

`src/mod.tsx` attaches each part to Claude Code with one line:

```tsx
import { defineMod } from '../node_modules/cmod-sdk/mod.js'
import { Box } from '../node_modules/cmod-sdk/ui/elements.js'
import { slots } from '../node_modules/cmod-sdk/ui/slots.js'
import { PromptCount } from './components/prompt-count.js'
import { promptsPane } from './panes/prompts.js'
import { initialState } from './state.js'

export const myMod = defineMod({
  name: 'my-mod',
  state: initialState,

  setup(mod) {
    mod.ui.pane(promptsPane)
    mod.ui.render(slots.AbovePrompt, ({ hasSurvey, Default }) =>
      hasSurvey ? <Default /> : <Box flexDirection="column"><Default /><PromptCount count={mod.state.session.prompts} /></Box>)

    mod.on('UserPromptSubmit', () => {
      mod.state.session.prompts += 1
    })
  },
})
```

`src/state.ts` holds the starting state:

```ts
export type MyModState = { session: { prompts: number } }

export const initialState: MyModState = { session: { prompts: 0 } }
```

The `AbovePrompt` render draws the prompt count under `<Default />`, which is what Claude Code and the other mods drew in the band above the prompt. A render adds to the band, so other mods' lines stay. While Claude Code shows a survey, the render gives the whole band back to `Default`.

`slots.ToolUse` changes a tool's own row, but a group of calls shows a condensed row (`slots.ToolGroup`) that Claude Code builds from the stored message, so a mod that hides a tool's input also sets `isExpanded` on `slots.ToolGroup` to unfold the group into `ToolUse` rows. No render reaches the permission dialog.

`src/panes/prompts.tsx` is the mod's pane:

```tsx
export const promptsPane = definePane<MyModState>({
  id: 'my-mod',
  title: 'my-mod',
  render: (mod) => <PromptCount count={mod.state.session.prompts} />,
})
```

`src/components/prompt-count.tsx` is what the pane and the band draw:

```tsx
export function PromptCount({ count }: { readonly count: number }): RenderElement {
  return <Text>{`Prompts this session: ${count}`}</Text>
}
```

`state` groups the mod's values by how long they last: `memory` until `/clear`, `--resume`, `/branch`, or a reload of Claude Code or its plugins, `session` for this conversation, `project` for this project, and `global` for every project. CMod saves every value except `memory`. A `session` value comes back on `--resume`, starts over on `/clear`, and is copied by `/branch`. Put values the mod works out again on every prompt, such as a git status, in `memory`.

Start `claude`, and the mod runs on every prompt. `cmod check` runs every check. `cmod publish` releases the mod on GitHub.

## Call another mod

A mod offers methods to other mods in `api`. Each method gets the caller's input and the mod, and returns its result. Inputs and results are plain JSON data.

```ts
export const tracer = defineMod({
  name: 'tracer',
  api: {
    signatures: async ({ path }: { path: string }, mod) =>
      (await mod.fs.read(path)).split('\n').flatMap((text, index) => {
        const name = /^export function (\w+)/.exec(text)?.[1]
        return name === undefined ? [] : [{ name, line: index + 1 }]
      }),
  },
  setup() {},
})
```

The mod types its `api` in `types/index.d.ts`, and its `.claude-plugin/plugin.json` names that file as `"types": "./types/index.d.ts"`. The file adds the mod to `CmodDependencies`, which the CMod plugin declares on `claude-code`:

```ts
export type TracerSignature = { name: string; line: number }

export type Tracer = {
  signatures(input: { path: string }): Promise<TracerSignature[]>
}

declare module 'claude-code' {
  interface CmodDependencies {
    tracer: Tracer
  }
}
```

`tsc` then checks the mod's own `api` against `Tracer`, so a method that returns another shape fails `cmod check`.

A mod that calls it lists it in its own `.claude-plugin/plugin.json`, and Claude Code installs it with the mod:

```json
"dependencies": ["cmod", "tracer"]
```

Then the call is typed from tracer's file:

```ts
const signatures = await mod.dependencies.tracer.signatures({ path: 'src/app.ts' })
```

A call that cannot answer fails with one of these messages:

```text
tracer is not installed. Run cmod install tracer.
tracer is installing. Try again when it's ready.
tracer has no method signatures.
tracer: <the message of the error the method threw>
```

When tracer is disabled, Claude Code unloads the mod that lists it and reports its own error, `Dependency "tracer" is disabled — enable it or remove the dependency`. "tracer is not installed" covers a dependency whose code did not load.

A call runs inside the deadline of the slash command, tool, or other job that makes it, and 30 seconds anywhere else. In tests, `testMod(myMod, { dependencies: { tracer: { signatures: async () => [] } } })` answers for tracer.

## What is in this repository

- The root is the CMod plugin. It fetches the cmod program, runs the uninstall step of each mod Claude Code removes, and carries calls from one mod to another.
- [sdk/](sdk/) is cmod-sdk, the library every mod is built with.
- [cli/](cli/) is the cmod program.

## License

MIT. See [LICENSE](LICENSE).
