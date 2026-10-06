---
layout: page
title: Claude Mod Manager
titleTemplate: Build Claude Code mods with Claude
---

<script setup>
const built = [
  { kind: 'prompt', text: 'cmod new no-force-push' },
  { kind: 'ok', text: 'Created no-force-push in no-force-push' },
  { kind: 'ok', text: 'Installed packages for no-force-push' },
  { kind: 'prompt', text: 'cmod check' },
  { kind: 'ok', text: 'The layout fits a mod' },
  { kind: 'ok', text: 'Imports reach only the mod, its packages, and claude-code' },
  { kind: 'ok', text: 'claude plugin validate --strict passed' },
  { kind: 'ok', text: 'oxlint found no problems' },
  { kind: 'ok', text: 'bun test passed: 5 pass, 0 fail' },
  { kind: 'out', text: 'no-force-push: 8 passed, 0 failed, 3 skipped' },
]

const failed = [
  { kind: 'prompt', text: 'cmod check' },
  { kind: 'ok', text: 'Imports reach only the mod, its packages, and claude-code' },
  { kind: 'fail', text: 'tsc 7.0.2 found type errors:' },
  { kind: 'out', text: "  hooks/register.ts(2,29): error TS2307: Cannot find module '../node_modules/@cmodjs/core/register.js'" },
  { kind: 'fix', text: 'Fix each error, then run cmod check again.' },
]

const installed = [
  { kind: 'input', text: '/plugin marketplace add owner/repo' },
  { kind: 'input', text: '/plugin install my-mod@my-marketplace' },
]

const started = [
  { kind: 'prompt', text: 'npm i -g @cmodjs/cli' },
  { kind: 'prompt', text: 'cmod new my-mod' },
  { kind: 'ok', text: 'Created my-mod in my-mod' },
  { kind: 'ok', text: 'Installed packages for my-mod' },
  { kind: 'prompt', text: 'cd my-mod' },
  { kind: 'prompt', text: 'cmod link' },
]
</script>

<main class="home">

<section class="section hero">
<div class="section__inner hero__grid">
<div class="hero__copy">

<p class="kicker">Claude Mod Manager</p>

# Ask Claude for a mod. Get one people can install.

<p class="hero__lead">cmod is the library, docs, and command line your Claude builds Claude Code mods with. The install, the cleanup, the saved settings, the tests, and the release are already written. Claude writes only the part that is new.</p>

<div class="hero__actions">
<CopyCommand command="npm i -g @cmodjs/cli" />
<div class="hero__buttons">
<a class="button button--primary" href="/docs/">Read the docs</a>
<a class="button button--secondary" href="https://github.com/heyJordanParker/cmod">See the code on GitHub</a>
</div>
</div>

<p class="hero__note">Free and open source under MIT. Runs on macOS and Linux.</p>

</div>
<Crt title="~/mods" :lines="built" />
</div>
</section>

<section class="section section--deep parts">
<div class="section__inner">
<div class="section__head">

<p class="kicker">Why not from scratch</p>

## Every mod needs the same eight parts. cmod has all eight built and tested.

Claude can write each part on its own. Then each part is more code to review, to try by hand in a live session, and to fix when Claude Code changes. With cmod, each part is one line, and cmod keeps up with Claude Code so the mod does not have to.

</div>
<table class="parts__table">
<thead>
<tr><th scope="col">The part</th><th scope="col">From scratch</th><th scope="col">With cmod</th></tr>
</thead>
<tbody>
<tr class="part">
<th scope="row" class="part__job">Run an install script</th>
<td class="part__scratch">Ask before it runs. Ask again when a script changes. Show progress. Undo a first install that fails.</td>
<td class="part__cmod"><code>"install": "./setup/install.sh"</code></td>
</tr>
<tr class="part">
<th scope="row" class="part__job">Clean up when removed</th>
<td class="part__scratch">Notice the plugin is gone, then undo the install from a saved copy of its scripts, because the mod's folder is gone too.</td>
<td class="part__cmod"><code>"uninstall": "./setup/uninstall.sh"</code></td>
</tr>
<tr class="part">
<th scope="row" class="part__job">Keep settings</th>
<td class="part__scratch">Save values per session, per project, and per machine. Merge the person's overrides with the team's.</td>
<td class="part__cmod"><code>state: { project: { expanded: [] } }</code></td>
</tr>
<tr class="part">
<th scope="row" class="part__job">Draw in the terminal</th>
<td class="part__scratch">Learn the events and props Claude Code draws with, and redraw when a value changes.</td>
<td class="part__cmod"><code>mod.ui.pane(filesPane)</code></td>
</tr>
<tr class="part">
<th scope="row" class="part__job">Block a risky command</th>
<td class="part__scratch">Parse the shell: pipes, <code>&amp;&amp;</code> chains, <code>sudo</code>, <code>xargs</code>, and clustered short flags.</td>
<td class="part__cmod"><code>permissions({ deny: [{ command: 'git push --force' }] })</code></td>
</tr>
<tr class="part">
<th scope="row" class="part__job">Test without Claude Code</th>
<td class="part__scratch">Start a session and try each case by hand.</td>
<td class="part__cmod"><code>testMod(guard).fire('tool.check', call)</code></td>
</tr>
<tr class="part">
<th scope="row" class="part__job">Ship a command-line program</th>
<td class="part__scratch">Build it for each platform, attach it to a release, check its SHA-256 on install, and link it onto PATH.</td>
<td class="part__cmod"><code>"program": "hello"</code></td>
</tr>
<tr class="part">
<th scope="row" class="part__job">Release a version</th>
<td class="part__scratch">Bundle the code so Anthropic's plugin directory can read it, pass Claude Code's validator, and tag the release.</td>
<td class="part__cmod"><code>cmod publish</code></td>
</tr>
</tbody>
</table>
</div>
</section>

<section class="section agent">
<div class="section__inner split">
<div class="split__copy">

<p class="kicker">Built for the Claude that builds it</p>

## Claude reads the docs for the exact version it installed

Training data falls behind every release. So the docs ship inside `@cmodjs/core`, and each mod's `node_modules` holds the docs of the version it runs. `cmod new` writes a `CLAUDE.md` that sends Claude there before it changes anything.

`cmod check` gives Claude one command to run after every change. It checks the layout and the imports, runs Claude Code's own validator, type-checks, lints, and runs the tests. Each failure names its fix, so Claude keeps going until the mod passes.

</div>
<div class="split__visual">
<figure class="file">
<figcaption class="file__name">.claude/CLAUDE.md</figcaption>
<p class="file__text">- <code>node_modules/@cmodjs/core/docs/</code> holds the docs of the installed <code>@cmodjs/core</code>. They match this version, and training data does not. Read the doc for the part you change, starting at <code>index.md</code>, before Claude Mod Manager (cmod) work.</p>
</figure>
<Terminal title="cmod check" :lines="failed" />
</div>
</div>
</section>

<section class="section section--deep example">
<div class="section__inner split split--wide">
<div class="split__copy">

<p class="kicker">What Claude writes</p>

## This mod stops Claude Code from force-pushing

The rule, one line in `hooks/register.ts`, and a test are all Claude writes. cmod reads the whole command line, so a force push inside an `&&` chain or behind `sudo` is denied too, and Claude gets the reason.

The test runs in `bun test`, with no Claude Code session. All five cases pass.

</div>
<div class="split__visual vp-doc">
<p class="code-name">src/mod.ts</p>

```ts
import { permissions } from '../node_modules/@cmodjs/core/jobs/permissions.js'
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'

export const noForcePush = defineMod({
  name: 'no-force-push',
  setup(mod) {
    mod.use(
      permissions({
        deny: [
          { command: 'git push --force', reason: 'Force pushes rewrite shared history.' },
          { command: 'git push -f', reason: 'Force pushes rewrite shared history.' },
        ],
      }),
    )
  },
})
```

<p class="code-name">tests/mod.test.ts</p>

```ts
test('a force push inside an && chain is denied', async () => {
  expect(await check('npm test && git push --force')).toEqual(denied)
})

test('a plain push is left to Claude Code', async () => {
  expect(await check('git push origin main')).toEqual({ decision: 'allow' })
})
```

</div>
</div>
</section>

<section class="section installing">
<div class="section__inner">
<div class="section__head">

<p class="kicker">For people who install mods</p>

## A mod asks before it changes the machine, and cleans up after itself

Installing a mod takes two commands in Claude Code. Claude Code installs the cmod plugin with it.

</div>
<div class="installing__grid">
<Terminal title="Claude Code" :lines="installed" />
<div class="facts">
<div class="fact">
<h3 class="fact__title">It asks first</h3>
<p class="fact__text">Before an install step runs, the mod shows its commands and asks. A changed script asks again.</p>
</div>
<div class="fact">
<h3 class="fact__title">It cleans up</h3>
<p class="fact__text">Removing a mod runs its uninstall step at the next session start, and again if Claude Code quit partway.</p>
</div>
<div class="fact">
<h3 class="fact__title">Your changes stay</h3>
<p class="fact__text">Starting values and Skill text changed in <code>~/.claude/cmods/&lt;mod&gt;/</code> survive updates and removal.</p>
</div>
<div class="fact">
<h3 class="fact__title">Nothing leaves the machine</h3>
<p class="fact__text">The cmod plugin sends no data. Its one download is the <code>cmod</code> program, checked against the release's <code>SHA256SUMS</code>.</p>
</div>
</div>
</div>
</div>
</section>

<section class="section section--deep start">
<div class="section__inner split">
<div class="split__copy">

<p class="kicker">Get started</p>

## Start a mod in four commands

`cmod link` loads the mod in every new Claude Code session. The template already counts prompts and shows the count in a pane, so Claude starts from a mod that works. Start `claude` in the folder and describe the mod.

<div class="start__buttons">
<a class="button button--primary" href="/docs/">Read the docs</a>
<a class="button button--secondary" href="/docs/commands">See every command</a>
</div>

</div>
<div class="split__visual">
<Terminal title="~" :lines="started" />
</div>
</div>
</section>

<section class="section faq">
<div class="section__inner faq__inner">

## Questions

<details class="faq__item">
<summary class="faq__question">Is cmod free?</summary>

Yes. The `@cmodjs/core` library, the `cmod` command, and the cmod plugin are open source under the MIT license.

</details>

<details class="faq__item">
<summary class="faq__question">Can Claude build a mod without cmod?</summary>

Yes. A Claude Code plugin is a hooks file, and Claude writes one well. cmod adds the parts every shared mod needs on top of it: install steps, cleanup, saved settings, tests, and releases. Claude spends the session on what the mod does.

</details>

<details class="faq__item">
<summary class="faq__question">Do people need to install cmod before my mod?</summary>

No. Each mod lists cmod as a dependency, so Claude Code installs the cmod plugin with the mod. The plugin fetches the `cmod` program the first time it runs.

</details>

<details class="faq__item">
<summary class="faq__question">Which systems does cmod run on?</summary>

macOS and Linux, on arm64 and x64. Every release carries a `cmod` build for each.

</details>

<details class="faq__item">
<summary class="faq__question">Can cmod manage plugins that are not mods?</summary>

Yes. `cmod install`, `cmod update`, and `cmod remove` work on any Claude Code plugin. A plugin that is not a mod installs with no consent question.

</details>

<details class="faq__item">
<summary class="faq__question">Is cmod made by Anthropic?</summary>

No. Claude Mod Manager is an independent open source project. Claude and Claude Code are Anthropic's.

</details>

</div>
</section>

<section class="section section--deep closing">
<div class="section__inner closing__inner">
<img class="closing__icon" src="/icon.png" alt="" width="96" height="96">

## Build the mod Claude Code is missing

<p class="closing__lead">Install the command line, start a mod, and give Claude the rest.</p>

<div class="closing__actions">
<CopyCommand command="npm i -g @cmodjs/cli" />
<a class="button button--primary" href="/docs/">Read the docs</a>
</div>
</div>
</section>

</main>
