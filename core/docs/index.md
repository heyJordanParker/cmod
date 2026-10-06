# Claude Mod Manager docs

These are the docs of the `@cmodjs/core` version installed beside them. Read them before you write mod code. They match this version, and memory of another version does not.

## What a mod is

A mod is a Claude Code plugin built with `@cmodjs/core`. Claude Mod Manager (CMod) installs mods, runs their install and uninstall steps with the person's consent, and builds and publishes new ones. The `cmod` command does that work in a terminal.

`cmod new my-mod` writes this layout:

```text
my-mod/
├── .claude-plugin/plugin.json          name, version, and "dependencies": ["cmod"]
├── .claude/CLAUDE.md                   facts for coding agents, starting with these docs
├── .gitignore                          node_modules/ and .claude-plugin/types/
├── .oxlintrc.json                      leaves .claude-plugin/types/ out of the lint
├── hooks/hooks.json                    names hooks/register.ts as the hooks module
├── hooks/register.ts                   connect(on, myMod), and nothing else
├── src/mod.tsx                         defineMod: the state, the setup, the hooks, the panes
├── src/state.ts                        the starting state
├── src/panes/prompts.tsx               one definePane per file
├── src/components/prompt-count.tsx     what the panes and slot renders draw with
├── skills/my-mod/SKILL.md              a Skill the mod ships
├── tests/mod.test.ts                   testMod tests, run with bun test
├── package.json                        depends on @cmodjs/core
└── tsconfig.json                       extends .claude-plugin/types/tsconfig.json, with the JSX options
```

`cmod new --project` writes the same files, less `.claude/CLAUDE.md`, into `.claude/skills/<name>/` of the repository.

The template is a working example to replace. It counts the prompts of the session in `state.session.prompts`, shows the count in a pane titled with the mod's name and above the prompt, and tests both. Replace the counter, the pane, the component, the Skill, and the tests with the mod's own.

A mod imports `@cmodjs/core` by path, such as `../node_modules/@cmodjs/core/mod.js`, because Claude Code loads a plugin's own files only. Types such as `RenderElement` and `On` come from the `claude-code` module.

## Type-check after the first session

Claude Code writes `.claude-plugin/types/` the first time a session loads the mod. That folder holds the `tsconfig.json` the mod's own extends, the `claude-code` module, and the `h` JSX global. Until it exists, `tsc` fails, and `cmod check` skips its type check. Run `cmod link`, start `claude` once, then type-check. A project plugin needs no link: start `claude` in its repository and trust it.

## Where a mod runs

Mod code runs inside Claude Code's hooks environment, not in Node or Bun. It has no Node or Bun modules, no DOM, and no `import()`. `mod.fs` reaches files, `mod.process` runs programs, and `mod.http` reaches the network ([mod.md](mod.md)). A job of your own also reaches the plugin's folder through `claude.plugin.root` and timers through `claude.clock` ([jobs.md](jobs.md)).

`cmod check` fails a mod that breaks this:

- a file in `src/` that imports a Node module, `bun`, or a `bun:` module. Tests in `tests/` run under `bun test` and may import `bun:test`.
- a file that imports from `cli/`, which the release leaves out
- `devDependencies` in `package.json`. Claude Code installs them for every person, so move each into `dependencies` or drop it.
- a `bin/` or `target/` folder at the mod's root
- a prebuilt binary in the mod, outside `cli/`, `node_modules/`, `.git/`, `target/`, `.target/`, and `.claude-plugin/types/`

A program the mod needs lives as source in `cli/`. `cmod publish` builds it and attaches the builds to the release ([install-steps.md](install-steps.md)).

## Which file answers which question

| Question | File |
| --- | --- |
| How do I define a mod, and what can `mod` call? | [mod.md](mod.md) |
| How do I keep values across prompts, sessions, and projects? How does a person change them? | [state.md](state.md) |
| How do I react to a Claude Code event, and what can a hook answer? | [hooks.md](hooks.md) |
| How do I draw a pane, change a row Claude Code draws, or ask the person something? | [ui.md](ui.md) |
| How do I add a slash command, a tool, a permission rule, a check, a prompt, a status line, or a background program? | [jobs.md](jobs.md) |
| How does one mod call another? | [dependencies.md](dependencies.md) |
| How does a mod change the machine, ship a program, or clean up after itself? | [install-steps.md](install-steps.md) |
| How do I test a mod without Claude Code? | [testing.md](testing.md) |
| Which `cmod` command links, checks, tries, or publishes a mod? | [commands.md](commands.md) |

## The Public API

A mod imports from the files below, and every other file in this package is internal. A few of their exports serve the library itself, and their docs say so, such as `drawWith` in [ui.md](ui.md).

| Import | Exports | Docs |
| --- | --- | --- |
| `mod.js` | `defineMod`, `ModDefinition`, `Mod`, `JobContext`, `Job`, `ProgressStep`, `PaneHandle`, `longestMs`, `messageOf` | [mod.md](mod.md), [jobs.md](jobs.md), [ui.md](ui.md) |
| `mod.js` | `Claude`, `RoutedEvent`, `RoutedHook`, `ToolCalls` | [jobs.md](jobs.md) |
| `mod.js` | `ModEvent`, `ModHook`, `HookAnswer` | [hooks.md](hooks.md) |
| `mod.js` | `notInstalled` | [dependencies.md](dependencies.md) |
| `connect.js` | `connect` | [mod.md](mod.md) |
| `testing.js` | `testMod`, `TestOptions`, `TestInput`, `TestedMod`, `Fakes`, `Shown`, `TestCall` | [testing.md](testing.md) |
| `ui/define-pane.js` | `definePane`, `Pane` | [ui.md](ui.md) |
| `ui/elements.js` | `Box`, `Text`, `Button`, `Link`, `Code`, `Markdown`, `Input`, `Select`, `Image`, `drawWith` | [ui.md](ui.md) |
| `ui/slots.js` | `slots`, `Slot`, `SlotProps` | [ui.md](ui.md) |
| `ui/markdown.js` | `markdownSlots`, `markdownBlocks`, `MarkdownKind`, `MarkdownReader`, `MarkdownPiece` | [ui.md](ui.md) |
| `jobs/slash-command.js` | `slashCommand`, `Reply` | [jobs.md](jobs.md) |
| `jobs/tool.js` | `tool` | [jobs.md](jobs.md) |
| `jobs/permissions.js` | `permissions`, `Rule`, `PermissionRules`, `Target`, `CommandCall`, `FileCall`, `FetchCall`, `ToolCall` | [jobs.md](jobs.md) |
| `jobs/check.js` | `check` | [jobs.md](jobs.md) |
| `jobs/prompt.js` | `prompt` | [jobs.md](jobs.md) |
| `jobs/status-line.js` | `statusLine`, `Usage` | [jobs.md](jobs.md) |
| `jobs/program.js` | `program`, `Program` | [jobs.md](jobs.md) |
| `jobs/context.js` | `afterCall`, `modWithin`, `modOf`, `workspaceReader` | [jobs.md](jobs.md) |
| `jobs/permissions/decide-permission.js` | `decidePermission`, `stricterVerdict`, `Rule`, `PermissionRules`, `Decision`, `Verdict` | [jobs.md](jobs.md) |
| `jobs/permissions/find-project-scope.js` | `findProjectScope`, `ProjectScope`, `Workspace` | [jobs.md](jobs.md) |

`jobs/permissions.js` and `jobs/permissions/decide-permission.js` each export a `Rule` and a `PermissionRules`, and the two pairs differ:

- The `jobs/permissions.js` pair takes the mod's state type. Its `when` gets a `Mod<State>`, so `Rule<State>` is `decide-permission.js`'s `Rule<Mod<State>>`. A mod writes its rules with this pair.
- The `decide-permission.js` pair takes the type of `when`'s second argument itself, for code that decides permissions without a mod.

## Check your work

Run `cmod check` in the mod's folder. It installs the packages, checks the layout and the imports, validates the mod with Claude Code, type-checks it once `.claude-plugin/types/` exists, lints it, and runs its tests. Each failure names its fix. [commands.md](commands.md) lists every step.
