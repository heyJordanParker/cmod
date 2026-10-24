# Claude Mod Manager docs

These are the docs of the `@cmodjs/core` version installed beside them. Read them before you write mod code. They match this version, and memory of another version does not.

## What a mod is

A mod is a Claude Code plugin built with `@cmodjs/core`. Claude Mod Manager (cmod) installs mods, runs their install and uninstall steps with the person's consent, and builds and publishes new ones. The `cmod` command does that work in a terminal.

`cmod new my-mod` writes this layout:

```text
my-mod/
├── .claude-plugin/plugin.json          name, version, and "dependencies": [{ "name": "cmod", "version": ">=4.0.0" }]
├── .claude/CLAUDE.md                   facts for coding agents, starting with these docs
├── .gitignore                          node_modules/ and .claude-plugin/types/
├── .oxlintrc.json                      leaves .claude-plugin/types/ out of the lint
├── hooks/hooks.json                    names hooks/register.ts as the hooks module
├── hooks/register.ts                   registerMod(addHook, myMod, options), and nothing else
├── src/mod.tsx                         defineMod: the state, the hotkeys, the setup, the listeners
├── src/state.ts                        the starting state
├── src/pages/prompts.tsx               one Sidebar page per file
├── src/widgets/prompts.tsx             one widget per file
├── src/components/prompt-count.tsx     what the page and the widget draw with
├── skills/my-mod/SKILL.md              a Skill the mod ships
├── rules/prompt-count.md               a rule Claude reads
├── tests/mod.test.ts                   testMod tests, run with bun test
├── package.json                        depends on @cmodjs/core, and lists the permissions and hotkeys
└── tsconfig.json                       extends .claude-plugin/types/tsconfig.json, with the JSX options
```

`cmod new --project` writes the same files, less `.claude/CLAUDE.md`, into `.claude/skills/<name>/` of the repository.

The template is a working example to replace. It counts the prompts of the session in `state.session.prompts`, shows the count below the prompt and in a Sidebar page that the `alt+shift+p` hotkey shows or hides, and tests all three. Replace the counter, the page, the widget, the component, the Skill, the rule, and the tests with the mod's own.

A mod imports `@cmodjs/core` by path, such as `../node_modules/@cmodjs/core/mod.js`, because Claude Code loads a plugin's own files only. Types such as `RenderElement` and `On` come from the `claude-code` module.

## Claude Code's API description

`.claude-plugin/types/` describes Claude Code's API to TypeScript: the `tsconfig.json` the mod's own extends, the `claude-code` module that `@cmodjs/core` imports, and the `h` JSX global. Claude Code writes it when it loads the mod, and git ignores it. `cmod check` has Claude Code write it when it is missing, so a fresh clone and CI compile the mod against Claude Code's API too. Until it exists, `tsc` alone fails, so run `cmod check` once first.

Claude Code links the types of each plugin the mod depends on, such as `cmod`, into the folder where that plugin is installed. `cmod try` installs the cmod plugin into a home it deletes when the session ends, which leaves those links leading nowhere, so `tsc` alone fails with `Cannot find type definition file for 'cmod'`. `cmod check` deletes a types folder with such a link and has Claude Code write it again.

## Where a mod runs

Mod code runs inside Claude Code's hooks environment, not in Node or Bun. It has no Node or Bun modules, no DOM, and no `import()`: Claude Code refuses a module that holds one. `fs` reaches files, `process` runs programs, `http` reaches the network, and `sessions` reads the conversations, each an import from `mod.js` ([mod.md](mod.md)). `mod.folder` is the plugin's own folder.

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
| How does a mod watch something outside Claude Code, tell Claude about it, or ask a model? | [mod.md](mod.md#mod-every-and-mod-after), [session.md](session.md#act-on-a-session) |
| How does a mod give Claude a prompt on a schedule, like `/loop`? | [jobs.md](jobs.md#schedule) |
| How do I keep values across prompts, sessions, and projects? | [state.md](state.md) |
| How does a person set a token, a URL, or a setting for my mod, for themselves or their team? | [options.md](options.md) |
| Which hosts, programs, and files may my mod reach, and how does the person grant them? | [permissions.md](permissions.md) |
| How does my mod find files and keep its own keys on each one, such as on a Skill? | [mod.md](mod.md#metadata-a-file-s-own-keys) |
| How does the person finish a setup step only they can do, such as signing in? | [install-steps.md](install-steps.md#steps-in-claude-code) |
| How do I add my mod's own page to Settings, or change Claude Code's settings? | [ui.md](ui.md#settings-pages), [mod.md](mod.md#settings-claude-code-s-settings-files) |
| How do I give my mod a hotkey the person can change? | [mod.md](mod.md#hotkeys) |
| How does my mod read and follow this conversation, its tasks, or earlier ones, search them, or start a task? | [session.md](session.md) |
| How does my mod hear a prompt, a tool call, a permission dialog, or a model switch, and change or refuse it? | [session.md](session.md#listen-to-a-record), [session.md](session.md#the-session-s-own-events) |
| How does my mod hear, change, or run any slash command, a built-in such as `/compact` included? | [mod.md](mod.md#commands-slash-commands) |
| How do I draw a page in the Sidebar, a pane, change how Claude Code draws a row, or ask the person something? | [ui.md](ui.md) |
| How do I show a status, such as the branch or a CI result, by the prompt, while Claude works, after each turn, or on the Dashboard? | [ui.md](ui.md#widgets) |
| How do I add a slash command, a tool, a permission rule, a check, a prompt, a schedule, or a background program? | [jobs.md](jobs.md) |
| How does one mod call another? | [dependencies.md](dependencies.md) |
| How does a mod change the machine, ship a program, or clean up after itself? | [install-steps.md](install-steps.md) |
| How do I test a mod without Claude Code? | [testing.md](testing.md) |
| Which `cmod` command links, checks, tries in a clean Claude Code, or publishes a mod? | [commands.md](commands.md) |

## The Public API

A mod imports from the files below, and every other file in this package is internal. A few of their exports serve the library itself, and their docs say so, such as `drawWith` in [ui.md](ui.md).

| Import | Exports | Docs |
| --- | --- | --- |
| `mod.js` | `defineMod`, `ModDefinition`, `Mod`, `Subscription`, `Timer`, `Reservation`, `Permissions`, `Allowed`, `JobContext`, `Job`, `SlashCommand`, `Tool`, `Step`, `longestMs`, `messageOf` | [mod.md](mod.md), [jobs.md](jobs.md), [install-steps.md](install-steps.md#steps-in-claude-code) |
| `mod.js` | `Hotkey`, `HotkeyInit`, `Combo`, `Key` | [mod.md](mod.md#hotkeys) |
| `mod.js` | `settings`, `SettingsFile`, `SettingsFileChange`, `SettingsFileChangeListener`, `config`, `ConfigRow`, `commands`, `CommandInfo`, `CommandRun`, `CommandRunAnswer`, `CommandRunResult`, `model`, `fs`, `Entry`, `Stat`, `FileMatch`, `FileChange`, `metadata`, `Metadata`, `process`, `http`, `clipboard`, `Imports` | [mod.md](mod.md) |
| `mod.js` | `sessions`, `Sessions`, `Session`, `CurrentSession`, `TaskOwner`, `RecordPart`, `OnMethods`, `BeforeMethods`, `Listener`, `ListenerTime`, `ReadOptions`, `AnswerOptions`, `Refusal`, `SearchOptions`, `SessionScope`, `SessionSend`, `TaskStartArgs`, `ToolCallArgs`, `Usage`, `RateLimit`, `TaskStatus`, `Surface`, `Matcher` | [session.md](session.md) |
| `mod.js` | `Placement`, `ProjectSetup`, `SessionStartAsked`, `SessionStarted`, `SessionEnded`, `ModelChange`, `CwdChange`, `DirectoryAdd`, `Worktree`, `Notification`, `Elicitation`, `ElicitationResponse`, `McpServer`, `PermissionUpdate`, `PermissionCheck`, `PermissionRequest`, `PermissionDenial`, `BatchedCall`, `ToolBatch`, `Todo`, `ReplyDisplay` | [session.md](session.md#the-session-s-own-events) |
| `mod.js` | `Message`, `MessageType`, `Prompt`, `Note`, `Reply`, `ToolCall`, `ToolResult`, `Skill`, `InstructionFile`, `AttachedFile`, `AttachmentType`, `Notice`, `Sender`, `SenderType`, `Person`, `Mod`, `Schedule`, `Channel`, `Sdk`, `Engine` | [session.md](session.md#message) |
| `mod.js` | `Context`, `Turn`, `Goal`, `Task` | [session.md](session.md#turn-context-goal-and-task) |
| `mod.js` | `Toast`, `ToastId`, `ToastType`, `ToastOptions` | [ui.md](ui.md#toasts) |
| `mod.js` | `PageInit`, `Page`, `PageProps`, `PaneInit`, `Pane`, `PaneProps`, `OpenOptions`, `ScrollTarget`, `ScrollOptions` | [ui.md](ui.md#the-sidebar-and-its-pages) |
| `mod.js` | `WidgetInit`, `Widget`, `WidgetContext`, `Area`, `AbovePrompt`, `BelowPrompt`, `Working`, `TurnEnd`, `Dashboard` | [ui.md](ui.md#widgets) |
| `mod.js` | `StyleInit`, `Style`, `StyleProps`, `Kind`, `Row`, `Block`, `ToolGroup`, `ToolProgress`, `CommandOutput`, `AskUserQuestion` | [ui.md](ui.md#styles-change-how-claude-code-draws) |
| `mod.js` | `notInstalled` | [dependencies.md](dependencies.md) |
| `register.js` | `registerMod`, `registerPermissionCheck`, `registeredMod` | [mod.md](mod.md) |
| `options.js` | `option`, `Option`, `Options`, `OptionValues`, `OptionValue`, `OptionType`, `UserConfigField`, `userConfigOf` | [options.md](options.md) |
| `shell.js` | `parseShell`, `ParsedShell`, `ShellCommand` | [mod.md](mod.md#shell-js-and-path-js-read-a-command-line) |
| `path.js` | `resolve`, `join`, `dirname`, `basename`, `extname`, `relative`, `isAbsolute`, `normalize` | [mod.md](mod.md#shell-js-and-path-js-read-a-command-line) |
| `testing.js` | `testMod`, `TestOptions`, `TestedMod`, `Raise`, `Fakes`, `Shown`, `ShownToast`, `TestCall`, `FakeSession`, `MessageDraft`, `RoutedEvent` | [testing.md](testing.md) |
| `ui/elements.js` | `Box`, `Text`, `Button`, `Link`, `Code`, `Markdown`, `Input`, `Select`, `Image`, `Raster`, `Svg`, `Client`, `drawWith` | [ui.md](ui.md) |
| `ui/components.js` | `Tabs`, `Tab`, `Split`, `Panel`, `Toggle`, `Tooltip`, `Help`, `Dialog`, `Pagination`, `Progress` | [ui.md](ui.md) |
| `ui/markdown.js` | `Heading`, `Paragraph`, `CodeBlock`, `BlockQuote`, `List`, `Table`, `ThematicBreak`, `HtmlBlock`, `Block`, `markdownBlocks`, `BlockProps`, `MarkdownReader`, `MarkdownPiece` | [ui.md](ui.md#markdown-blocks) |
| `jobs/slash-command.js` | `slashCommand`, `CommandReply` | [jobs.md](jobs.md) |
| `jobs/tool.js` | `tool` | [jobs.md](jobs.md) |
| `jobs/permissions.js` | `permissions`, `Rule`, `PermissionRules`, `Target`, `CommandCall`, `FileCall`, `FetchCall`, `Call` | [jobs.md](jobs.md) |
| `jobs/check.js` | `check` | [jobs.md](jobs.md) |
| `jobs/prompt.js` | `prompt` | [jobs.md](jobs.md) |
| `jobs/schedule.js` | `schedule`, `ScheduledPrompt` | [jobs.md](jobs.md) |
| `jobs/program.js` | `program`, `Program` | [jobs.md](jobs.md) |
| `jobs/context.js` | `afterCall`, `inFolder`, `withinDeadline`, `workspaceReader` | [jobs.md](jobs.md#the-building-blocks) |
| `jobs/permissions/decide-permission.js` | `decidePermission`, `stricterVerdict`, `Rule`, `PermissionRules`, `Decision`, `Verdict` | [jobs.md](jobs.md) |
| `jobs/permissions/find-project-scope.js` | `findProjectScope`, `ProjectScope`, `Workspace` | [jobs.md](jobs.md) |

`jobs/permissions.js` and `jobs/permissions/decide-permission.js` each export a `Rule` and a `PermissionRules`, and the two pairs differ:

- The `jobs/permissions.js` pair takes the mod's state type. Its `when` gets a `Mod<State>`, so `Rule<State>` is `decide-permission.js`'s `Rule<Mod<State>>`. A mod writes its rules with this pair.
- The `decide-permission.js` pair takes the type of `when`'s second argument itself, for code that decides permissions without a mod.

## Check your work

Run `cmod check` in the mod's folder. It installs the packages, checks the layout and the imports, validates the mod with Claude Code, compiles it against Claude Code's API, lints it, and runs its tests. Each failure names its fix. [commands.md](commands.md) lists every step.
