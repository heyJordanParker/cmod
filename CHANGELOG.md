# Changelog

What changed in each version of cmod, for the people who build and use mods. Releases before 1.0.0 have their notes on GitHub.

## [Unreleased]

## [5.0.1] - 2026-10-29

### Fixed
- A mod that depends on cmod, or on another mod, installs on a computer without a GitHub SSH key. Claude Code looked up the dependency's version tags over SSH, failed, and stopped with `Dependency "cmod@<mod>" has no git tag satisfying >=5.0.0`. `cmod publish` and `cmod link` now list each dependency by its HTTPS address, which Claude Code reads without a key. A mod published before this release gets the fix at its next `cmod publish`.

## [5.0.0] - 2026-10-29

### Removed
- The permission system is gone. A mod reaches any host, runs any program, writes any file, changes any Claude Code setting, reads other sessions, and adds text Claude reads, with nothing declared, and the person is asked nothing at install or update. Every mod could already reach Claude Code directly from its own `hooks/register.ts`, so the checks stopped only honest authors. Delete `"permissions"` from package.json "cmod". `cmod check` fails on a mod built on `@cmodjs/core` 5.0.0 that still has it, and names the fix.
- `mod.permissions`, the `permissions` option of `testMod`, and `cmod permission` are gone, with the permission rows of the install page and Settings, the `Ask before an update adds a permission` preference, and the permissions an update toast named.

### Changed
- A mod that approves Claude's tool calls declares `"approve": true` directly in package.json "cmod", instead of inside `"permissions"`. `cmod check` writes it there when the mod's code needs it. `cmod publish` still leaves the approving code out of a mod without it, so the mod can be listed in Anthropic's plugin directory.
- `cmod check` writes a mod's `cmod` dependency as `>=` the oldest cmod its `@cmodjs/core` runs on, 5.0.0 for this release, instead of `>=` the `@cmodjs/core` version itself. A later library release raises it only when the library needs something new from cmod, so a mod no longer forces everyone onto the newest cmod.

### Fixed
- A mod that depends on another mod loads when installed from its published marketplace. Claude Code looks for a bare dependency only in the mod's own marketplace, so `cmod publish` now lists each mod the `plugin.json` depends on there, from the GitHub `repository` in that mod's installed `plugin.json`, as it lists cmod. Write the dependency bare, such as `{ "name": "oneclaude", "version": ">=0.9.0" }`, which also resolves in the marketplace `cmod link` writes. The cmod plugin keeps the copies of each plugin at one version, as it does for cmod.

Mods built on any 4.x `@cmodjs/core` keep running unchanged: cmod grants them everything they declare, without asking.

## [4.3.4] - 2026-10-29

### Fixed
- A linked mod whose `plugin.json` asks for a newer cmod than the one installed, such as after `cmod check` raised it to `>=4.3.3`, no longer stays off with nothing on screen. Claude Code turns it off at the next reload. cmod now updates itself as soon as `cmod watch` sees the edit, and checks again at each session start, and the reload after the update turns the mod back on. If no newer cmod fixes it, the `<mod> is off` toast says why, as it does for an installed mod.
- `cmod check` no longer writes a `cmod` dependency that the cmod on your machine does not meet, which turned a linked mod off in every session. Before it writes `>=` your `@cmodjs/core`, it compares that version with each cmod plugin Claude Code installed, and updates an older one as `cmod update cmod` does. When no cmod Claude Code can install is new enough, the check fails, keeps the old dependency, and says which `@cmodjs/core` to install instead, such as `Install @cmodjs/core 4.3.2 with bun add @cmodjs/core@4.3.2, then run cmod check again.` When a cmod linked from a checkout is older, the check fails too, and says to pull that checkout.
- A plugin Claude Code installed from git, such as the cmod a linked mod's marketplace lists, counts at the version its `plugin.json` holds, as Claude Code counts it, not at the version with a commit that `claude plugin list` shows, such as `4.3.3-8b9188b04241`. Before, `cmod check` judged that cmod older than 4.3.3 and failed, and the corner toast after an update read `cmod updated to 4.3.3-8b9188b04241` and waited 10 seconds without naming the permissions the update granted.
- A check `cmod check` cannot run, such as one that needs Claude Code on a machine without it, fails with the reason, such as `claude is not on PATH`, and every later check still runs. Before, `cmod check` stopped there.
- A `Markdown` element with `dimColor`, `onLinkPress`, or `pressableLinks` keeps them in every part a markdown style draws through `Default`, on a Sidebar page, in a widget, and in a pane another mod's style draws, as it already did in a mod's own pane. Before, those parts drew at full color, and Claude Code opened their links itself instead of running `onLinkPress`. A `Markdown` a style draws itself in place of `Default` keeps them too, on every surface, the mod's own pane included, unless it sets them itself. Each part without a key of its own also takes the element's `key`, the first as it is and each later one with `:1`, `:2`, and so on, because Claude Code needs a key on a `Markdown` with `onLinkPress`, so the test kit's `press(key, link)` presses a link in the first part by the key the mod wrote. Styling mods built on any 4.x `@cmodjs/core` need no change.

## [4.3.3] - 2026-10-28

### Fixed
- The test kit refuses a page, pane, widget area, or style that draws two `Input`, `Select`, `Markdown`, `Client`, `Raster`, or `Image` elements with one key, as Claude Code 2.1.312 does, with Claude Code's own text, such as `cmod: returned a tree Pane refuses: Markdown "notes/all:item-text:0" is drawn twice; each takes its own key`. Such a test passed before, while Claude Code drew the whole Sidebar blank.
- Two blocks drawn by one markdown style, such as two lists in one note, drew that style's keys twice, such as two `item-text:0`, and Claude Code refused the whole Sidebar, pane, or reply. Now cmod puts each block's place in front of every key its style draws: `<mod>/markdown:<scope>:<block>:<key>` in a page, a widget, or another mod's pane, `<scope>:<block>:<key>` in the mod's own pane, and `<block>:<key>` in a reply. `<block>` is the block's number in its markdown, and `<scope>` is the `key` of the `Markdown` element that holds it, or its number among the ones without a key. So a style's keys need be unique only within the one block it draws, and stay the same each time the block draws there, so an `Input` keeps what the person typed.
- The test kit draws a page's keys and a markdown style's keys with the prefixes the cmod plugin gives them, `<mod>/<page>:` and `<mod>/markdown:<scope>:<block>:`, so one key in a page and in its markdown style draws, as it does in a session. A `Button` press on a page gets that full key in `e.element`, as in a session. `press`, `input`, and `select` still take the key the mod wrote.
- A markdown style may call `Default` once per part, such as once per list item. In a mod's pane, each `Default` drew Claude Code's `Markdown` with the key of the `Markdown` element the pane drew, so a second `Default`, or a block with text around it, drew one key twice, and Claude Code refused the whole pane. Now the first `Default` takes that key and each later one takes it with `:1`, `:2`, and so on. A style that calls `Default` once in a block of its own draws the same tree as before.
- When a mod does not answer a draw of its page, its widget, or its markdown style, cmod reports `<what> drew nothing` to the Log, such as `The markdown style of diagrams drew nothing` with the reason. Before, the reason reached only Claude Code's debug log, while the page showed an error, the widget disappeared, or Claude Code's own markdown showed in place of the style.

## [4.3.2] - 2026-10-28

### Fixed
- `cmod check` builds the release as `cmod publish` builds it, with your `"files"` list and the bundled hooks module, and validates that release with `claude plugin validate --strict`. So a path `plugin.json` names that `"files"` leaves out, such as `"types": "./types/index.d.ts"` without `types` in `"files"`, fails `cmod check` instead of the release workflow. A `"files"` path that matches no file in the mod fails it too. The `Bundling the hooks` and `Validating with Claude Code` checks are now one check, `Building and validating the release`.
- `cmod publish` and `cmod check` print every line Claude Code's validator writes when it refuses the release, instead of only its last lines, such as `✘ Validation failed`.
- `cmod publish --dry-run` builds from the working tree, uncommitted changes included, instead of from the last commit.

## [4.3.1] - 2026-10-26

### Fixed
- Settings shows a linked mod as on while it runs. The copy `cmod link` turned off no longer marks it off.
- An unbound hotkey's combo in Settings reads `none`, instead of a sample combo that looked bound.
- After a cmod update, the `cmod watch` an older cmod started stops within seconds and the new cmod's watcher takes over, so a linked mod is no longer reported as `<mod> does not build` by an older cmod's rules. A build failure an older watcher left is checked again and goes once the mod builds.

## [4.3.0] - 2026-10-26

### Added
- A hotkey can leave out `default`, as `hotkeys: { next: { title: 'Open the next inbox item' } }`. It starts unbound, binds nothing at install and asks no consent, and Settings lists it as unbound until the person binds it there or with `cmod hotkey`.
- A Log in Settings, on cmod's page, lists the newest 100 errors of your mods from every session, newest first, each with its mod, time, and message, and `Copy` and `Report`. The same error again updates its entry.
- The switch `Show errors from installed mods`, in Settings on cmod's page under Preferences and off at first, shows every error of an installed mod as a toast again.

### Changed
- An update that adds a permission no longer stops to ask in the Install tab. cmod grants the new permission, and the update's toast names it. The switch `Ask before an update adds a permission`, in Settings on cmod's page under Preferences and off at first, brings the question back. A permission you turned off stays off across updates, and an update never asks for it again. A changed install step or a new hotkey still asks, as before. A mod set up before 4.3.0 asks as before at its next update, including for a permission you turned off, and from then on follows these rules.
- Each session reloads its plugins by itself when a plugin is installed, updated, turned on or off, removed, linked, or unlinked, once the changes have stopped for 2 seconds, so an update of many plugins reloads once. The `Plugins changed` toast and its `Reload` button are gone. A session in the middle of a turn reloads when the turn ends, and the prompt you are typing stays.
- After a reload, each plugin whose version changed shows a short toast in the corner, such as `notes updated to 1.3.0`. An update that granted a permission always has its own toast, followed by each permission it granted. More than 3 others show one toast, such as `5 plugins updated`. An edit to a linked mod keeps its version and shows nothing.
- A mod no longer shows its own `Updated to <version>` toast, because the corner toast names the new version. Its changelog stays in Settings, and the `Installed` toast stays.
- An error of a mod you installed from a marketplace goes to the Log in Settings instead of a toast. A mod you run from its checkout, linked with `cmod link` or loaded with `--plugin-dir`, still shows its errors as toasts, and so does any mod whose install or setup failed, whose program stopped, or whose button or hotkey you pressed failed. A toast keeps its form: it stays, with `Copy` and `Report`.
- An error for a permission you turned off shows no toast, and its toast's `Settings` button is gone. It goes to the Log and to Claude Code's debug log. Under a cmod older than 4.3.0 it still shows its toast.

### Fixed
- A listener under one of Claude's tasks hears that task's subtasks again after `/clear` moves it to the new session.
- A mod that uses a permission it never declared is told the declaration to add to its package.json, instead of being told to turn on a grant, so a linked mod's author sees it as a toast.

## [4.2.0] - 2026-10-26

### Added
- `isDeferred` on `tool`. `isDeferred: false` puts the tool in Claude's tool list from the first turn, so Claude calls a tool it uses in most turns without searching for it first. Left out, Claude Code keeps the tool behind ToolSearch, as before.

## [4.1.1] - 2026-10-24

### Added
- `color` on every `Session`: the color the person last picked with `/color`, such as `cyan`, absent when they never picked one or reset it. `sessions.current.color` follows each `/color` in every mod, with or without the `conversation` permission. The test kit takes it on a `FakeSession`, as it takes `title`, and `tested.type('/color cyan')` runs `/color`. The conversation index is `history-11.sqlite`, and cmod deletes `history-10.sqlite` and reads every conversation again.

### Changed
- cmod no longer runs `/reload-plugins` in your sessions. When a plugin is installed, updated, turned on or off, removed, linked, or unlinked, each session shows a `Plugins changed` toast, and its `Reload` button reloads that session only.
- The `×` that closes a Sidebar tab draws as a filled button, and the key bar of a Sidebar you are not in says to click it instead of naming a two-key shortcut.
- When Claude Code lists its commands, about 190 of them, the cmod plugin's code runs only for the hotkey commands, instead of for every one.
- A call from one mod to another runs only in the mod it calls, instead of passing through every mod in the session.
- A session no longer redraws its widget rows each time another session writes to the cmod store but leaves the widget layout as it was.
- A mod without a pane no longer redraws the whole screen each time a mod that styles markdown starts or changes its parts.

### Fixed
- Every session no longer reloads every few seconds while a mod is linked. Claude Code writes `.claude-plugin/types/` into a linked checkout each time it loads the mod, and `cmod watch` took that for an edit. `cmod watch` now skips every change to a file git ignores.
- A press on a button Claude Code had already redrawn no longer shows a `Claude Code stopped its ui.press hook` toast from every mod in the session. A mod now shows a hook failure only when its own hook failed, never when it passed on a failure from beneath it. A press on a page its mod drew before it restarted no longer shows `<mod> did not take the press`. The page draws again, and the next press works.
- A Sidebar or Settings page no longer jumps back to its top when you click into the Sidebar or its width changes. The page keeps its drawing while its mod draws it again, instead of a one-line `Drawing…` that Claude Code scrolled to the top.
- A mod's hotkey commands, such as `/cmod--sidebar`, no longer show in the slash command menu. Claude Code names a command's plugin with its marketplace, such as `cmod@cmod`, so cmod never matched them, and it lists the commands before the cmod plugin starts, so cmod now asks it to list them again once it has.
- A widget row above or below a prompt narrower than its indent no longer fails with `Box prop "width" must be a finite number between 0 and 10000`.
- An update that only drops a hotkey or a permission no longer opens a blank `Install <mod>` tab in every session. cmod now asks again only for a changed command or script file, a new hotkey or default combo, or a new permission, and lists only those. A mod you approved before this version asks nothing new either, once any `cmod` command has run before its next update. The `Install <mod>` tab now names the program a mod installs, so a consent whose only change is the program lists it.

## [4.1.0] - 2026-10-24

### Added
- A mod hands work to another agent four ways: `startTask`, a fresh subagent; `fork`, a subagent that keeps this conversation; `clone`, a new background session with a copy of this conversation; and `startTask({ isBackground: true })`, a fresh background session that keeps running after this one ends. Each returns a `Task` in this session's goal, a background one with `isBackground` and an owner that is that session, and a fork's and a clone's owner names this session in `forkedFrom`. Each works on another running session too, and a background task ends at that session's first answer.
- `place` on a widget: `side: 'right'` lands a new widget at the right of its row until you move it in Settings, and `size: 'fill'` lets it give up width when the row runs short, while every `fit` widget, the default, keeps its full width. A row stays one line, and no widget breaks a clock into "00:" and "03" or a button into one letter per line any more.
- `{ note }` in four more answers, each read by Claude: `beforeToolCall`, after the tool's result; `beforeTurnEnd` and a task's `beforeTurnEnd`, which keeps Claude working with the note; `beforeProjectSetup`; and `beforeModelChange`, after the switch. A note needs the `prompt` permission.
- `AttachedFile`, a file Claude Code attaches by itself: one you mention with `@`, one it puts back after a compaction, or a change to a file Claude read. `onAttachedFile` hears it, and `beforeAttachedFile` rewrites what Claude reads with `{ text }` or keeps it out with `{ refuse }`.
- `Raster`, `Svg`, and `Client` in `ui/elements.js`. A style gets `surface`, `columns`, and `id`, and a pane gets `surface`, so a mod draws for the app that shows it.
- `usage()` names the account's rate limits: `rateLimits: { type, percent, resetsAt? }[]`.
- `beforeTaskStart` answers `{ prompt?, title?, owner?: { agentType?, model?, cwd? }, isAsync? }`, so a mod rewrites a task's prompt, picks its agent, model, and folder, and runs a subagent while Claude goes on.
- A running task of `sessions.current` holds its `status`, its teammate `name`, and `spawnedBy`, the plugin that started it.
- Claude gets two tools from the cmod plugin: `compact`, which compacts the conversation once Claude's answer ends and then prompts Claude to carry on, and `start_background_agent`, which starts a task in a new background session.
- `cmod task start` starts a task in a new background Claude Code session, as `claude --bg` does, for the cmod plugin.
- The test kit's `tested.startTask` starts a fork with `forkedFrom` and a background task with `isBackground`, and `tested.endTurn({ … }, { task })` ends a task owner's turn.
- A fork Claude starts with its Agent tool reads as a task whose owner is `forkedFrom` the session, with no `agentType`, instead of an owner of the agent type `fork`. The conversation index rebuilds once for it.
- `fakes.session.surfaces` in the test kit fakes which Claude apps show the session. `async () => []` tests a session such as `claude -p`. `fakes.session.usage` fakes its usage.
- The test kit draws a mod's own markdown styles in its pages and widgets.
- `program({ singleInstance: true })` runs one copy of a program on the computer however many sessions load the mod, such as a server that must be the only writer of its data. Every session's `ready()` resolves that copy's address, and when the session running it ends, another open session starts a new copy and `ready()` resolves the new address. `cmod program` runs the copy and elects the session that owns it.

### Changed
- `Tabs` no longer numbers its tabs, so a page's tabs never take the Sidebar's `0` to `9`. Give a tab `hotkey: 'o'` for a key of its own, drawn as `o: Open`.
- A mod you link with `cmod link` loads into every running session without a restart. cmod lists the checkout in a marketplace it keeps in the checkout's parent folder, installs it from there, and turns off the installed copy until `cmod unlink`. A checkout an older cmod linked moves over at the next `cmod setup` or `cmod watch`. `cmod try` loads its mods with `--plugin-dir`.
- A mod's install consent, its options, and its setup steps open as its `Install <mod>` tab in the Sidebar, instead of a pane of their own. Two mods that install at once each get a tab. The `×` on the tab is Not now, and Escape hides the Sidebar while the question waits in its tab and its toast. A step's `render` gets a page's props, `params`, `isFocused`, and `columns`.
- A widget or toast change from cmod redraws only what cmod draws: the band above the prompt, the prompt hint, the mode labels, the spinner, the turn's duration line, and the Sidebar. It no longer redraws Claude Code's notices and every other row on screen, and a mod that lists a new widget redraws them once instead of twice.
- The Sidebar's tabs sit on a raised bar with Settings at its right end, and the shown tab is a raised block in the accent color. Every tab keeps its width whether it shows or not, so switching tabs moves no other tab, and every page tab has its `×`. The tabs wrap on a narrow Sidebar. A key bar at the bottom of the Sidebar names the keys that work now.
- An empty Dashboard has an `Arrange widgets` button that opens cmod's Widgets in Settings.
- The rows and buttons of cmod's Widgets in Settings wrap on a narrow Sidebar.
- Settings lists the mods in a Mods panel, the selected one highlighted, beside a panel for that mod, or above it on a narrow Sidebar. Each mod has a dot: dim when it runs, in the warning color when it needs setup, and hollow when it is off. Turn off and Remove are buttons beside the mod's version, Keep is the main button when you remove a mod, and the shown section is highlighted.
- Every Sidebar tab draws in panels that fill the Sidebar's height: the Dashboard's widgets, a mod's page in a panel titled with the mod's name, and Settings. A mod's install consent, options, and setup steps put the main button first: Accept, Next, or Finish, then Not now.
- The buttons of the Sidebar, Settings, and a mod's install page are filled blocks: the main one in the accent color, the others in the bar's gray.
- `Panel` draws its title in its top border, as `╭─ Changed files ──╮`, and is never narrower than its title.
- cmod's own `/reload-plugins` leaves no row in any session once it ends. A `/reload-plugins` you type still shows.
- An error toast shows the time it last happened beside its buttons, and its Report details carry the exact time.
- The slash command menu waits on no mod but cmod, which hides every mod's hotkey commands.
- A mod whose state changes asks cmod to redraw its widgets and Sidebar pages only when one of them draws differently, so a session no longer redraws every widget area on each state change.
- `fs.onChange` checks a path that does not exist every 2 seconds instead of every 500 ms.
- A machine runs one `cmod watch` however many sessions are open, instead of one waiting process per session.
- A Markdown element draws through every mod's markdown styles wherever it shows: in panes, pages, widgets, the Dashboard, Settings, and changelogs, as in Claude's replies.
- A mod you linked with `cmod link` reloads in every session once, after its checkout has been quiet for 2 seconds and builds, instead of on every save. An agent's half-written file no longer prints a reload row or a "does not parse" error. A change that still doesn't build after 10 seconds shows its error in one toast, which goes once it builds. A checkout linked before 4.1.0 switches over by itself in the next session you start.
- Each session checks only two files every 500 ms: cmod's `store-changed`, which every cmod writer updates, and Claude Code's `installed_plugins.json`. It hears a change to your user settings from Claude Code instead of reading the file.
- cmod adds its PATH line to Claude's Bash environment once per session, instead of once more at every start, resume, clear, and compaction.
- A loading toast spins for 10 seconds, then shows `…` and stops redrawing the prompt area.

### Fixed
- A mod that waits on its install question, was declined with Not now, or failed to install starts on its own within a second once another cmod installs it, such as `cmod install <mod> --yes` in a terminal, `cmod link`, or Accept in another session. Its `Install <mod>` tab and its toast close, and it shows Installed. Before, it kept asking for consent you had already given, or kept showing "Not installed" until your next prompt.
- Not now and Accept on a mod's `Install <mod>` tab work on the first press after the mod reloads with its question open. The tab kept the drawing of the module that reloaded, so each press failed with "is installing" until something else drew the tab again.
- A mod's install no longer stays stuck on "is installing." after its mod reloads, after a setup step fails, or after the mod fails to start once you saved its settings.
- A press on a button drawn before a mod reloaded never runs a button of the reloaded mod.
- Claude's call to a mod's tool right after the mod reloads waits for the mod to start, then answers. It failed with "registered the tool but no tool.call hook answered this call". A call while the mod installs says it is installing and when to try again.
- A Sidebar page a mod opens with `params` draws. It stayed on "Drawing <page>…", because the cmod plugin sent its own copy of the params, which could not cross to the mod.
- A mod's note after a compaction reaches Claude in the window that compaction opens, and its title, Skill reload, and first prompt apply at that compaction. Before, they waited for the next compaction. cmod's note about a mod's changed rules no longer shows as a prompt you typed.
- Installing a plugin reloads each running session once. Claude Code writes your settings and then its plugin list, and cmod reloaded again for the second write although the first reload had already loaded it.
- A widget or page that fails to draw shows one error toast, not a second "Claude Code stopped its cmod.call hook" toast for the same failure.
- Pressing a button in the Sidebar while another mod is slow to answer an earlier press no longer fails with "Claude Code stopped its ui.press hook".
- A mod that sets a Claude Code setting to the value it already has no longer rewrites `settings.json`, so the other running sessions don't reload their settings.
- `claude -p` prints Claude's answer again when a plugin changes during the run. cmod no longer reloads a session no app shows.
- A subagent's first prompt reaches `beforePrompt` listeners on its task, so a mod hears every subagent start.
- A pane the person closes, with Escape or its ✕, reports `isOpen` and `isShown` false, so the next `toggle()` opens it. Before, after Escape hid the Sidebar, the first press of `meta+0` or `meta+m` did nothing and only a second press showed it.
- Finish setup in Settings no longer fails after 10 seconds while the person fills in the step.
- A linked mod's new version runs its install step again with its new program, after `cmod link` builds it.
- A mod keeps hearing its session, and its `before` listeners keep answering, after the cmod plugin updates in a running session. Before, a cmod update in a session left every mod deaf to that session until the mod itself reloaded, so a `beforeContextEnd` listener never ran at the next compaction.
- A Sidebar or Settings page whose mod fails to draw it shows the mod's error, instead of "Drawing…" forever.
- A Sidebar page keeps its drawing, and where you scrolled it, while its mod reloads.
- The test kit draws `Svg`, gives a markdown style the surface and width the cmod plugin gives it, and keeps a task's `beforePrompt` note to its subagent in `shown.notes`.
- The test kit counts a Box's right padding in its width, and draws a Box's border and a child placed with `position: 'absolute'` and `top` over it, as Claude Code does, so `lines()` shows a `Panel` with its title in its border. `shown.pane.lines({ columns })` draws a pane at that width, as it already did for a page.
- A `beforeModelChange` note reaches Claude only after the switch it answered, never after a later one.
- Two subagents of one type started at once each get their own first prompt in `beforePrompt`.
- A linked mod that does not build is named by its own name, not its checkout folder's.
- Another mod's markdown drawing no longer flickers back to Claude Code's each time a mod's pages or widgets change.
- A hotkey or slash command that opens a Sidebar page with `void page.open()`, closes one with `void page.close()`, or opens Settings with `void mod.settings.open()` does it at once at any width, as it does when the handler returns the promise. Before, the page showed a second late, and on a terminal narrower than 144 columns it never showed. The test kit's cmod plugin now holds a page request only while its own command or press runs, as the real one does, so a test catches a request that misses it.

## [4.0.3] - 2026-10-22

### Changed
- The Sidebar's hotkey is `meta+0`, as `⌘0` shows or hides the navigator in Xcode, and Settings' hotkey is `meta+m`, for `/mods`. `ctrl+q` quits most apps, and `meta+s` is a common tmux prefix. A machine that already bound `ctrl+q` and `meta+s` keeps them, and Settings, under cmod, Hotkeys, changes them.

## [4.0.2] - 2026-10-22

### Fixed
- Every running session loads a plugin change at once, whatever made it: a `cmod` command, `/plugin`, `claude plugin`, or Claude Code's automatic update. Before, only a `cmod` command reloaded the sessions. The reload keeps the prompt cache.
- The cmod plugin now updates by itself. Claude Code updates a plugin only when its marketplace has automatic updates on, which is off for every marketplace that is not Anthropic's, so a cmod plugin stayed at the version first installed. Installing the cmod plugin, and `cmod update`, now turn on automatic updates for the `cmod` marketplace, unless you chose otherwise in `/plugin`, Marketplaces. A cmod plugin older than 4.0.2 still needs one `cmod update cmod`.

## [4.0.1] - 2026-10-21

### Fixed
- `cmod try` places a mod's rules before the session starts, so Claude has them from the first turn, also under `claude -p`, and takes them out when the session ends.
- `cmod check` reads the imports of a script whose first line is a shebang, such as a Skill's `scripts/*.mjs`, instead of failing to parse it.
- Two buttons pressed so that their handlers overlap no longer stop the mod's pages and widgets from redrawing for the rest of the session.
- A page shown again with params it drew with before keeps working buttons, and a button the mod no longer knows makes the page draw again.
- Picking another mod in Settings draws that mod's page without the last mod's params, and tells the mod which page it shows.
- A Sidebar page keeps its last drawing on screen through several redraws in a row, instead of showing "Drawing…".
- The "is off" toast leaves once Claude Code turns the mod back on.
- An update whose new hotkey defaults to a combo you rebound keeps your combo.
- Several mods that each need a newer cmod run one update at a time.

## [4.0.0] - 2026-10-21

cmod 4.0 gives every mod one place on screen, the Sidebar, with Settings inside it, hotkeys the person can change, and widgets the person places around the prompt. Every part a mod adds is one `add` call that returns the part, and every message that asks the person to do something carries a button that does it. From 4.0 on, every newer cmod runs every mod built on an older `@cmodjs/core`, so a person can run mods built on different versions side by side.

### Added
- A mod names the oldest cmod it runs on, and runs with every newer cmod. `cmod check` writes the `cmod` dependency in `.claude-plugin/plugin.json` as `>=` the `@cmodjs/core` the mod bundles, and `cmod publish` refuses any other range. A mod still on `@cmodjs/core` 3 keeps its own range.
- When a mod needs a newer cmod than Claude Code installed, or two mods' marketplaces hold different versions of cmod, cmod updates itself and reloads the mods. A mod Claude Code still turns off shows Claude Code's reason in an error toast.
- `cmod list` says why Claude Code turned a mod off, and `cmod list --json` prints the list as JSON.
- The Sidebar: one pane beside the conversation with a tab for the Dashboard, each page a mod opened, and Settings. `ctrl+q` shows or hides it, `0` to `9` switch tabs, and `×` closes a page.
- `mod.sidebar.add({ id, title, render })` adds a page, and the returned `Page` opens, toggles, closes, and scrolls it. `open({ params })` shows the page for one thing, such as a run, and `render` reads it as `props.params`.
- Settings, in the Sidebar, lists every mod with its own pages, options, permissions, hotkeys, and changelog, and turns a mod off or removes it. `meta+s` and `/mods` open it. `mod.settings.add(page)` adds a page to the mod's entry, and `mod.settings.open()` shows it.
- Hotkeys: `defineMod({ hotkeys: { toggle: { title, default: 'alt+shift+p' } } })` declares one, and `mod.hotkeys.toggle.onPress(listener)` hears it. The install question lists each combo, the person changes it in Settings, and an update keeps their combo. A page a hotkey opens shows at any terminal width.
- `cmod hotkey <mod> <hotkey> <combo>` binds a hotkey to a new combo.
- Widgets: `mod.widgets.add({ id, title, areas, render })` adds one. `areas` lists where it may draw: `AbovePrompt`, `BelowPrompt`, `Working` under the spinner, `TurnEnd` under each turn that ends, and the Sidebar's `Dashboard`. The person arranges every mod's widgets in Settings, under cmod, Widgets.
- A failure caused by a permission the person turned off has a `Settings` button that opens the mod's Permissions. A call to a mod that is not installed has a `Plugins` button, and a secret option has an `Open /config` button.
- `tested.hotkey(name)` presses a hotkey, `tested.shown.page` and `tested.shown.pane` read and press what the mod shows, `tested.lines(area)` draws widgets, and `tested.api` calls the methods `setup` returned.

### Changed
- `setup` returns the mod's API, the methods other mods call, as a VS Code extension's `activate` does. `api` in `defineMod` is gone.
- `mod.panes.add(pane)` adds a pane, and takes the plain object `definePane` took. The returned `Pane` takes `open({ params })` and has `params`, `scrollTo`, and `remove()`.
- `mod.styles.add({ kind, render })` changes how Claude Code draws a kind of row or a markdown block, in place of `mod.ui.render(place, Component)`. `render` gets the mod first, then the props with `Default`. The `Spinner` and `TurnDuration` kinds are now `Working` and `TurnEnd`.
- `mod.toast` and `mod.ask` replace `mod.ui.toast` and `mod.ui.ask`. `clipboard.write(text)`, imported from `mod.js`, replaces `mod.ui.copy`. `sessions.current.scrollTo(message)` and `sessions.current.caption(toolCall, text)` replace `mod.ui.scroll` and `mod.ui.notice`, and a page or pane scrolls with its own `scrollTo`.
- Every `on` and `before` method, `fs.onChange`, `settings.beforeFileChange`, `commands.onRun`, and `commands.beforeRun` return a `Subscription`, whose `remove()` replaces `dispose()`. `slashCommand`, `tool`, and `reserveName` return handles with `remove()` too.
- `mod.every` and `mod.after` return a `Timer` with `isRunning` and `stop()`.
- `installer` takes plain step objects, `{ id, title, render, isDone }`, and `defineMod` checks them.
- `fs.onChange` works from anywhere, not only `setup`, and for a path that does not exist yet. cmod checks the paths twice a second, and stops a call that watches more than 2000 files with an error toast.
- A mod that loads while a session runs, after `/reload-plugins` or `/plugin install`, runs its `onSessionStart` listeners before the next prompt, with the source `resume`.
- A mod reports its widgets every time it starts, so a widget it removed leaves the screen, and the widgets of a mod turned off leave at the reload that follows.
- A setup that throws keeps its stack in the error toast's `Copy the error`.
- `cmod link` says a new session loads the checkout, because Claude Code reads linked folders only when a session starts.
- A linked mod whose install steps did not change keeps running while its new version builds in the background, and the other sessions wait for that one build. A failed build's toast shows the build's own error, and the build runs again only once a file in the program's folder changes, with or without git.
- A `cmod` command that fails partway still tells running sessions to reload. A reload in a session you stopped with Escape waits for your next prompt instead of failing.
- A slash command a mod or the cmod plugin runs, such as cmod's `/reload-plugins`, is no longer a `Prompt`. Hear it with `commands.onRun`.
- `cmod install` that adds the cmod plugin says to run `/reload-plugins` once in a session that is already open, because that session has no cmod plugin yet to notice the install.
- The conversation index is `history-8.sqlite`. cmod deletes `history-7.sqlite` and reads every conversation again.
- `cmod new` writes a Sidebar page, a widget, and a hotkey that shows the page.

### Removed
- `mod.ui` is gone, with `PaneHandle`, `Disposable`, `definePane`, `defineStep`, `Place`, `PlaceProps`, `ui/define-pane.js`, and `ui/places.js`.
- `mod.settings.page` is gone. Use `mod.settings.add`.
- `"keys"` in `package.json` `"cmod"` is gone. Declare `hotkeys` in `defineMod`, and `cmod check` writes them into `package.json`.
- `/dashboard` is gone. The Dashboard is the Sidebar's first tab.
- The `statusLine` job, `jobs/status-line.js`, and `tested.shown.statuses` are gone. Add a widget.
- The `AbovePrompt`, `PromptHint`, and `SessionMode` places are gone. Move a render there to a widget in `AbovePrompt` or `BelowPrompt`.
- `tested.lines(paneId)`, `tested.press(paneId, key)`, `tested.input`, and `tested.select` are gone. Use `tested.shown.pane` or `tested.shown.page`.

### Fixed
- The row Claude Code writes when the person stops a turn, `[Request interrupted by user]`, is no longer a `Prompt`, so `onPrompt` listeners and prompt counts skip it.
- A mod runs only the cmod program the cmod plugin installed, so an older `cmod` elsewhere on PATH no longer answers it, and cmod runs the Claude Code that started it, even when `claude` is not on PATH, or the `claude` on PATH once Claude Code's updater deleted that version.
- An install question Claude Code holds back in a terminal narrower than 144 columns shows a toast with an `Answer` button that opens it.
- `cmod install` of a mod says nothing about a cmod plugin that is already installed, and turns on one the person turned off.
- A session running an older cmod refuses a request from a newer cmod in another session by name, instead of running it as a different request.

### Update a mod from 3.x

Raise `@cmodjs/core` to `^4.0.0` in `package.json`, then run `cmod check`, which writes the `cmod` dependency in `.claude-plugin/plugin.json` as `>=4.0.0`. A 3.x mod's `^3` range keeps Claude Code from updating cmod to 4.0 on a computer that has it, so release the 4.0 build of every mod you publish. Then change each call:

```diff
- api: { signatures: (input) => … },
- setup(mod) { … },
+ setup(mod) {
+   …
+   return { signatures: (input) => … }
+ },

- export const notesPane = definePane<NotesState>({ id: 'notes', title: 'Notes', render })
+ export const notesPage: PageInit<NotesState> = { id: 'notes', title: 'Notes', render }
- const pane = mod.ui.pane(notesPane)
+ const page = mod.sidebar.add(notesPage)

- mod.ui.render(AbovePrompt, ({ hasSurvey, Default }) => …)
+ mod.widgets.add({ id, title, areas: [AbovePrompt], render })
- mod.ui.render(PromptHint, ({ Default }) => …)
- mod.use(statusLine({ text: (usage) => … }))
+ mod.widgets.add({ id, title, areas: [BelowPrompt], render })
+ sessions.current.onUsageChange((usage) => void (mod.state.session.usage = usage))

- mod.ui.render(TurnDuration, ({ Default }) => <Default />)
+ mod.styles.add({ kind: TurnEnd, render: (mod, { Default }) => <Default /> })

- mod.ui.toast('Saved')
+ mod.toast('Saved')
- await mod.ui.ask('Commit?')
+ await mod.ask('Commit?')
- await mod.ui.copy(text)
+ await clipboard.write(text)
- mod.ui.notice(callId, 'checked')
+ sessions.current.caption(toolCall, 'checked')
- mod.settings.page(definePane({ … }))
+ mod.settings.add({ … })

- const watching = sessions.current.onPrompt(listener)
- watching.dispose()
+ watching.remove()
- const timer = mod.every(1000, tick)
- timer.dispose()
+ timer.stop()

- "cmod": { "keys": { "alt+n": "/notes" } }
+ hotkeys: { toggle: { title: 'Show or hide the notes', default: 'alt+n' } },
+ mod.hotkeys.toggle.onPress(() => page.toggle())

- const signIn = defineStep({ id, title, render, isDone })
+ const signIn: Step = { id, title, render, isDone }

- expect(await tested.lines(AbovePrompt, band)).toContain(…)
+ expect(await tested.lines(AbovePrompt)).toContain(…)
- expect(await tested.lines('notes')).toEqual([…])
+ expect(await tested.shown.page.lines()).toEqual([…])
- await tested.press('notes', 'save')
+ await tested.shown.page.press('save')
```

A widget draws only its own row, so its `render` takes no `Default`, and nothing draws there while Claude Code shows a survey. A page shows in the Sidebar. Keep a pane with `mod.panes.add` only when it must show on its own. Delete `src/panes/` and the `"keys"` block once nothing uses them.

Run `cmod check`. It writes the hotkeys into `package.json`. Fix the imports it names first, because a render whose import fails loses its types, and then the type check names every call left to change. Replace each message that asks the person to type a command with a `Button` that does it. When a person updates, cmod moves the key a 3.x mod bound, such as `alt+n` to `/notes`, onto the hotkey that declares that combo.

## [3.1.0] - 2026-10-18

cmod 3.1 lets Anthropic's plugin directory list a mod that hears Claude Code's permission check and only refuses.

### Changed
- `cmod publish` leaves the code that allows and asks on Claude Code's permission check out of the bundle of a mod without `"approve": true`, so a mod that only refuses, such as one that blocks `rm -rf`, holds no hook that can approve a tool call, and the plugin directory can list it.
- `cmod check` adds `"approve": true` only to a mod that allows or asks, and no longer to one that only refuses. For a mod that declares it, `cmod check` says Anthropic's plugin directory does not list a mod that approves Claude's tool calls.

## [3.0.0] - 2026-10-18

cmod 3.0 tells a mod which of its notes Claude got, gives a subagent its own note after a compaction, and keeps a mod's gates working when Claude Code stops one of its hooks.

### Added
- `sessions.current.goal.beforeSessionStart` hears the main agent's starts and every agent's compaction, a subagent's with its id in `task`, and its note reaches the window of the agent that compacted.
- Every note a mod gives Claude becomes a `Note` from that mod, so `onNote({ from: { type: 'mod', name: 'tracer' } })` hears each note of tracer's that Claude got.
- `tested.fakes.clock.now` gives a test its own time, so it can test a deadline.

### Changed
- Claude reads each mod's note inside the mod's tag, such as `<tracer_mod>…</tracer_mod>`. A test that reads what Claude Code receives, through `claudeCodeOf(tested).fire`, sees the tag. What `tested.raise` returns is the mod's own text, as before.
- `sessions.current.beforeSessionStart` hears the main agent's compaction only, and its payload carries the `model` and the `contextTokenCount` the compaction left. Read a subagent's with `sessions.current.goal.beforeSessionStart`.
- The conversation index is `history-7.sqlite`, and cmod deletes `history-6.sqlite`, so the next read indexes every mod note already in a transcript.

### Fixed
- A subagent's compaction no longer gets the main agent's compaction note. Claude Code names no agent on that SessionStart, so cmod now answers it from the compaction itself.
- When Claude Code stops a mod's hook, because the hook threw or its own code ran past 10 seconds, the toast `Claude Code stopped its <hook> hook` shows it, and every gate still holds: a `before` listener or `commands.beforeRun` listener with `onFailure: 'refuse'` refuses, a `beforePermissionRequest` listener refuses the dialog, and the `permissions` job denies the call. Before, Claude Code skipped the hook in silence and the gate let the event through.
- A `before` listener with `onFailure: 'refuse'` in another session refuses what its matcher matches when that session does not answer in time. Before, the event went through. The answers of other sessions now share one wait, so they no longer add up past the time Claude Code gives the cmod plugin's hook.
- A note a mod sends to another session is a `Note` from that mod. Before, the other session recorded it as the cmod plugin's.
- `cmod check` reads a mod's source the way it runs, so a commented-out line or a type-only import no longer fails the permission or import checks.

## [2.1.0] - 2026-10-18

### Added
- `tested.raise.beforeContextEnd({ task })` tests a mod's answer to the compaction of a task's context.
- `cmod check` fails a mod whose `src/` hears permissions while `hooks/register.ts` does not call `registerPermissionCheck`.

### Changed
- `cmod check` adds `"approve": true` only for a mod that answers the permission check, with a `before` method or the `permissions` job. A mod that only listens with `onPermissionCheck` or `onPermissionRequest` no longer asks the person to let it approve tool calls.

### Fixed
- A mod that never calls `registerPermissionCheck` carries no permission hook at all. On 2.0.1 every mod's bundle registered one that only passed the check on, and Anthropic's plugin directory refused it as unable to show that the mod leaves each permission decision with the person.
- `onPermissionCheck`, `beforePermissionCheck`, `onPermissionRequest`, `beforePermissionRequest`, and `mod.use(permissions(…))` throw where they are called when `hooks/register.ts` does not call `registerPermissionCheck`, and name the line to add. On 2.0.1 one added after `setup` heard nothing and said nothing.
- `tested.raise.beforeToolResult` hands the listener its `output` as given, so a test can give what a tool answers Claude Code, such as Edit's `structuredPatch`. On 2.0.1 it turned the output into text.

## [2.0.1] - 2026-10-17

cmod 2.0.1 fixes what mods ran into on 2.0.0 and makes cmod lighter: a prompt no longer waits on a cmod process, and nothing it reads blocks for minutes behind the conversation index.

### Fixed
- A mod that names a version range on cmod, such as `"version": "^2.0.0"`, installs on a computer without cmod. Claude Code installs a dependency's range only from a tag named `<name>--v<version>`, which cmod's releases now carry, back to 0.1.5. `cmod publish` pushes that tag on each release of your mod too, for a marketplace that lists your mod from its git repository.
- In an interactive session, a mod's listeners on its own session work again. On 2.0.0 the cmod plugin did not yet know its session when a mod set up, so it refused them for lacking the conversation grant and showed three error toasts.
- A mod that decides no permissions passes Anthropic's plugin directory check again. Only a mod that calls `registerPermissionCheck` carries the code that answers a permission.
- A `beforeSessionStart` note reaches Claude in `claude -p` and the SDK, where Claude Code runs SessionStart before mods start.
- `onInstructionFile` and `beforeInstructionFile` name the file's `path` for every instruction file Claude Code adds as it runs.
- `beforeToolCall`'s `cwd` is the folder a subagent runs in, for a task started with its own `cwd`.
- A message the conversation index is writing no longer makes a read of the running session wait up to two minutes and then fail with "database is locked". The index writes a large session in steps.
- `cmod setup`, `link`, `install`, `update`, and `try` say a mod "is already set up" when its install step has nothing to run, instead of "Installing".
- Two `before` listeners that each answer a `note` both reach Claude.

### Changed
- A prompt no longer waits for `cmod rules`. The cmod plugin runs it only when a file it reads changed, and `cmod rules --json` lists those files as `watched`.
- The cmod launcher starts faster, and frees the disk space of each older cmod build once it installs a newer one. What ran the older build runs the newer one.
- Checking whether another session still runs reads only the running sessions, once for every waiting call.
- The conversation index finds deleted transcripts with one listing per folder, and reads each transcript row once per query.
- A mod with no `state.session` does no session bookkeeping at session start.
- cmod waiting for a newer cmod checks every 10 seconds after the first minute.

## [2.0.0] - 2026-10-17

cmod 2.0 gives a mod one way to hear and change Claude Code: a named `on` or `before` method for each moment, on the part of the conversation it happens in. `mod.on` and Claude Code's raw hook inputs and answers are gone, and the docs' session.md lists every method.

### Added
- Every moment of a session is a method on `sessions.current`, with a typed payload and answer: `onSessionStart` and `beforeSessionStart` with a `note`, `beforeModelChange`, `onCwdChange`, `beforePermissionCheck` and `beforePermissionRequest`, `beforeToolBatch`, `beforeTodoCreate`, `beforeReplyDisplay`, worktrees, elicitations, and notifications.
- `commands` hears, changes, and runs every slash command, built-ins such as `/compact` included: `commands.beforeRun` rewrites a command's arguments, answers in its place, or refuses it, `commands.onRun` hears it ran, `commands.run` runs one, and `commands.list` lists them all.
- Every `on` and `before` method takes `{ timeoutMs }`, and its listener gets a `deadline` and an `AbortSignal` that aborts then. `onFailure: 'refuse'` makes a `before` gate that breaks refuse instead of letting the moment through.
- A tool call and its result list the files they read and change, as `files: { read, changed }`, Bash command lines included.
- A tool result names its call's tool and input.
- A turn that ends says why: Claude's `answer`, or a `failure` with its type. `turn.abort()` stops a running turn.
- `beforePrompt` adds a `note` beside a prompt and names the session with `title`, and a task's first prompt takes a `note` its subagent reads before its first step. `beforeToolResult` adds a `note` beside a result, or marks it an error.
- `fs.onChange` hears the files that change under a path, and `settings.beforeFileChange` refuses an edit to a settings file while the session runs.
- `mod.log(text, { to: 'transcript' })` writes a dim line the person reads in the conversation.
- `InstructionFile` has `isRule`, true for a rule file. The `Engine` sender marks Claude Code's own continuation prompt.
- The test kit raises any method with `tested.raise.<method>(payload)`, starts a new session with `tested.startSession({ source, id })`, and ends a turn with an `answer` or a `failure`.

### Changed
- A session is one agent: `sessions.current`'s listeners hear the main agent only, `sessions.current.goal` hears every agent in the session, and `task.owner` hears one subagent. A task's `owner` is a `TaskOwner`, without `startTask` and `callTool`.
- `on(Event, …)` and `before(Event, …)` are named methods: `onReply(…)` for `on(Reply, …)`, `beforeToolCall(…)` for `before(ToolCall, …)`. `sessions` has `on` methods only, and a `before` method on another session changes what happens there.
- `session.goal` is a property that follows the session, as `sessions.current` does, and `goal.text()` reads its text. Write `sessions.current.goal.tasks()` for `(await sessions.current.goal()).tasks()`.
- `search` streams: it returns an `AsyncIterable` newest first and takes a matcher. Loop with `for await` and `break` instead of `limit`, and pass `before` to continue a loop that broke.
- `search` covers what the part's listeners hear: a session's `search` its own agent's messages, its goal's every agent's, and a task's its owner's and every task below it.
- `cmod history search --goal` is `--agent`, which keeps the main agent's messages, or with `--task` that task's own.
- `ToolResult.text` is `output`, and `beforeToolResult` answers `{ output }`.
- `Document` is `InstructionFile`, `clients()` is `surfaces()`, and `usage()`'s `context: { tokens, window }` is `contextWindow: { tokenCount, size }`.
- `settings.list()` is `config.list()`, and `Setting` is `ConfigRow`.
- `startTask` takes a `title`, and `name` is the address a teammate's `SendMessage` reaches it by.
- A `slashCommand` reply's `context` is `note`.
- A built-in command such as `/model` no longer reaches `beforePrompt`: `commands.beforeRun` hears every command, and `beforePrompt` hears a command Claude Code sends as a prompt.
- A task about to end is `task.owner.beforeTurnEnd`.
- `statusLine` redraws when the usage or the mod's state changes. A line that follows a clock sets the state from `mod.every`.
- The conversation index is `history-6.sqlite`, and cmod deletes `history-5.sqlite`.
- A mod built on `@cmodjs/core` 2.0 reads conversations through the cmod plugin 2.0, so update the cmod plugin with `/plugin` before such a mod.

### Removed
- `mod.on`, the 33 hook constants such as `PreToolUse` and `Stop`, and `HookInput`, `HookAnswer`, `HookListener`, and `HookOptions`. Each hook's job is a method: `sessions.current.onToolResult` for `PostToolUse`, `sessions.current.beforeToolCall` for `PreToolUse`, `sessions.current.beforeTurnEnd` for `Stop`, `sessions.current.beforeSessionStart` for `SessionStart`, and `sessions.current.onPrompt` or `beforePrompt` for `UserPromptSubmit`.
- `beforeTaskEnd`. Use `task.owner.beforeTurnEnd`.
- `prompt`'s `when`. Add the note with `sessions.current.beforePrompt({ text: /pattern/ }, () => ({ note }))`.
- `statusLine`'s `interval`.
- `tested.fire` for Claude Code's hooks, and `TestInput`. Use `tested.raise`, and `tested.add`, `endTurn`, `compact`, `startTask`, and `startSession` to build the conversation. `fire` keeps `tool.check`, `prompt.context`, `cmod.call`, and the `ui` events.
- The `SessionEvent`, `SessionPayload`, `BeforeEvent`, `BeforeAnswer`, and `UsageChange` exports, and the event constants such as `TurnEnd` and `TaskStart`. The methods carry their payload types.

## [1.6.0] - 2026-10-16

### Added
- A mod changes one value inside a setting and leaves the rest alone: `settings.user.update({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' } })` keeps every other variable in `env` and the file's comments. Removing the mod takes out only that value, and only while it still holds what the mod set.
- A `config` permission names a key path: `"config": ["env.ANTHROPIC_BASE_URL"]` covers that one value, and `"config": ["env"]` covers every key in `env`.

### Changed
- `settings.<source>.update` merges an object into the object already there, at every depth, instead of replacing it. `null` still removes a key, and an array or any other value still replaces it. To replace a whole object, read it and set each key you drop to `null`.
- A mod that declares a `config` permission waits for cmod 1.6.0, because an older cmod replaces the whole object.

### Fixed
- A mod whose installed folder was deleted no longer stops `cmod link` and `cmod rules` from linking every other mod's rules.
- A cmod release ships the `@cmodjs/core` and `@cmodjs/cli` it just published. The cmod plugin 1.5.1 shipped with `@cmodjs/core` 1.5.0.

## [1.5.1] - 2026-10-14

### Fixed
- `Retry` keeps the failure toast where it is while it runs. The progress shows in place of the toast's description, or of its buttons when it has none, so nothing moves until the try ends.
- While a mod's install popup waits for the person's answer, its toast no longer spins. Each spin redrew the popup, and a press that landed during a redraw was lost.
- Two builds of one checkout take turns, so a linked mod's build no longer clears the output of a `cmod publish` running at the same time.

## [1.5.0] - 2026-10-14

### Added
- `before` changes or refuses what is about to happen: rewrite or refuse a prompt, a slash command, or another session's message, rewrite a note, a Skill, a reply, a tool result, or a notice, leave out a `CLAUDE.md` file, rewrite, answer, or refuse a tool call, pick the model a task runs on or refuse it, and keep a task, a turn, or a context from ending.
- `sessions`, every session, its goal, a task, a context, and a turn each have `search`, `on`, and `before`, and each hears what happens inside it, so `turn.on(Reply, …)` hears that turn's replies and `sessions.on(Prompt, …)` hears every running session's prompts.
- Every session action works on every running session, not only the current one: `send`, `startTask`, the new `callTool`, `usage`, and the new `clients`. `usage` reads an ended session's model and tokens from its transcript.
- A task's `owner` is the session doing its work, with its own goal, turns, messages, `agentType`, and `model`. A session has `agentType`, `context()`, and `turn()`.
- `UsageChange` hears a session's new usage.
- A mod's `rules/` folder of Claude Code rules applies while the mod is on and has the `prompt` permission, and stays out of a project that turned the mod off. A rule that applies everywhere reaches a running session as a note, a rule taken out is withdrawn by a note, and the Installed toast lists the rules.
- All 33 of Claude Code's hooks are constants, among them `MessageDisplay`, `WorktreeCreate`, `PreModelSwitch`, and `TodoCreated` and `TodoCompleted` for its todo checklist. `HookAnswer` takes `displayContent` and `worktreePath`.
- A pane's handle says whether the pane `isShown` and `isFocused`.
- `settings.list()` lists every `/config` row.
- `fs` reads `$HOME` and `$CLAUDE_CONFIG_DIR` paths.
- `cmod history search --session` searches one conversation, or one task, turn, context, or goal in it. `cmod history usage` prints a session's model and tokens, and `--task` reads a task's owner like a session. `cmod rules` links the mods' rules. `cmod history follow --running` follows every running session of the project, and each one that starts later.
- `testMod`'s `startTask` takes a `parent`, to start a subtask.
- Every failure toast has `Retry` where running the step again can work, `Report`, and `Hide`. `Report` opens its choices inside the toast, with the keys on the first: ask Claude to report the failure to the mod's author, open a filled-in GitHub issue or email, or copy the error. `Hide` keeps the same failure hidden in later sessions.
- A failed install that waiting can fix retries in the background, from 2 seconds up to every 128 seconds, and clears its toast once it works: a linked checkout's failed build, once the checkout changed, and a release download that got 404 or no answer, as right after a release is published.
- A mod the person declined has an `Install` button that asks again.

### Changed
- No message sends the person to a terminal. A call to a mod that is not set up says `<mod> is not set up. Its toast says why.`, and one to a mod that is not installed says `<mod> is not installed. Add it with /plugin.`
- `cmod publish` creates the GitHub release with every file before it pushes `marketplace.json`, so no update reaches a release without its files.
- One compaction moves a context once, for the session and for each task, and `ContextEnd` reaches the mods when a session compacts.
- A guard registered by a session that ended without closing, such as a crashed one, no longer fails every later prompt. It is cleared.
- Each mod's install and consent popup is its own, so one mod no longer draws another mod's popup.
- A background install retry keeps the consent the person gave, instead of asking again.
- A task's `agentType` and `model` moved to its `owner`.
- A task's messages name their own turn.
- A matcher's `RegExp` no longer matches a key the payload lacks.
- The cmod plugin asks for the `prompt` permission, to add the notes of the mods' rules.
- The conversation index is `history-5.sqlite`, rebuilt from the transcripts on first use.
- `sessions.on` and `sessions.before` reach every running session of the current project, including those that start later, and no other project's.

## [1.0.0] - 2026-10-13

### Added
- `sessions` reads every saved conversation as contexts, turns, messages, a goal, and tasks: `sessions.current`, `sessions.list()`, and `sessions.search()`, which answers in under 0.3 s on 800,000 messages.
- `session.on` hears each new message, turn, context, task, and goal change, in this session or another running one, with a matcher on its fields. `session.send` gives another session a Prompt or a Note, and `session.startTask` starts a task beside Claude.
- `cmod history` reads sessions, turns, contexts, tasks, goals, and messages in a terminal, searches them, and `follow` streams another session's changes.
- `mod.ui.toast` draws toasts above the prompt: success, info, warning, error, loading, and promise, each with an optional action button. `mod.ui.copy` puts text on the clipboard.
- Every failure cmod catches for a mod is an error toast with a Copy button that copies the versions, the message, the whole cause chain, and the stack. A failed install has a Retry button.
- An Installed toast says what a mod adds, what its setup did, and what you allowed it. An Updated toast shows what changed since the version you had, from the mod's `CHANGELOG.md`. Neither shows on a reload or a new session.
- A mod's `CHANGELOG.md` is its release notes: `cmod publish` releases the version's section, the Updated toast shows it, and /mods has a Changelog page.
- `settings.user`, `settings.project`, and `settings.local` change Claude Code settings. The `config` permission lists the setting names a mod may change, and `cmod teardown` puts back each value the mod changed.
- `mod.ui.scroll` scrolls the transcript to a message.
- A conversation forked into a new Claude Code process keeps every mod's session values.
- A mod that failed or was declined starts on your next prompt once `cmod install <mod>` sets it up, with no `/reload-plugins`.
- `cmod new` writes a `CHANGELOG.md` and pins the cmod plugin to `^1.0.0` in `plugin.json`.

### Changed
- What Claude Code or your computer owns is an import from `mod.js`: `sessions`, `settings`, `model`, `fs`, `metadata`, `process`, and `http`. Every `Mod` member is the mod's own.
- Hooks and places are constants from `mod.js`, such as `mod.on(UserPromptSubmit, …)` and `mod.ui.render(AbovePrompt, …)`. Slots are places. The markdown places, such as `CodeBlock`, come from `ui/markdown.js`, so a mod that draws no markdown never loads the markdown reader.
- `mod.on`, `mod.ui.render`, `slashCommand`, and `tool` return a `Disposable`.
- A mod built on `@cmodjs/core` 1.0 pins the cmod plugin in `.claude-plugin/plugin.json` with `"dependencies": [{ "name": "cmod", "version": "^1.0.0" }]`, so Claude Code turns it off with a clear error beside an older cmod plugin.
- One word per idea: `type` replaces `kind`, the `agents` permission is `tasks`, `SlotProps` is `PlaceProps`, the slash command reply type is `CommandReply`, and a schedule's entry is a `ScheduledPrompt`.
- The `config` permission is a list of setting names, such as `"config": ["cleanupPeriodDays"]`, instead of `true`.
- A session value lasts as long as Claude Code keeps the conversation, instead of the 20 newest sessions.
- `cmod try` links its mods into the home it runs in, as `cmod link` does, so /mods and a mod's first-start questions set their options there too.
- The cmod plugin indexes conversations only while a mod holds the `conversation` permission, and turning that permission off stops the mod's `session.on` listeners from the next prompt.

### Removed
- `mod.fs`, `mod.process`, `mod.http`, `mod.model`, and `mod.metadata`. Import `fs`, `process`, `http`, `model`, and `metadata` from `mod.js`.
- `mod.history` and `mod.session`. Read `sessions` from `mod.js`, and `sessions.current` for the session the mod runs in.
- `mod.projectRoot` and `mod.cwd`. Read `sessions.current.project` and `sessions.current.cwd`.
- `mod.claude`, Claude Code's raw API. Each use has its own replacement: a slash command is `mod.use(slashCommand(…))`, which works after setup too, `ui.scroll` is `mod.ui.scroll`, `ui.log` is `mod.log`, and `session.id()` is `sessions.current.id`.
- `ui/slots.js`. Use the place constants from `mod.js` and the markdown places from `ui/markdown.js`.
- `mod.ui.progress`, `ProgressStep`, and `ProgressBar`. Use a loading toast and `Progress`.
- The Breaking changes list `cmod publish` built from commit messages. The changelog section replaces it.

### Fixed
- A call to another mod resolves with its answer and rejects with the reason it was refused, instead of resolving with `{ value }` or `{ deny }`.
- `cmod check` compiles mods on current Claude Code again.
- An installer step whose `isDone` throws counts as not done and shows in the installer, instead of stopping it.
- `cmod link --option` and `cmod try --option` set a linked mod's options, under the id Claude Code lists for the checkout.
- A linked checkout whose version moved past its last release sets up: setup builds its program from the checkout instead of downloading a release that does not exist.
