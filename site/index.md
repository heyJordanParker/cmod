---
layout: page
title: Claude Mod Manager
titleTemplate: Mods for Claude and Claude Code
description: Use Claude Mod Manager (cmod) to find, install, and create mods for Claude and Claude Code. Block what you never want run, and put what you need next to the chat.
---

<script setup>
const habits = [
  { kind: 'input', text: 'fix the login bug' },
  { kind: 'result', text: 'tests-first added: Run the tests before you say it works.' },
  { kind: 'claude', text: 'Fixed the expired token check in auth.ts.' },
  { kind: 'claude', text: 'Bash(bun test)' },
  { kind: 'result', text: '42 pass, 0 fail' },
  { kind: 'claude', text: 'Fixed, and all 42 tests pass.' },
]

const screen = [
  { kind: 'input', text: 'make the buttons rounder' },
  { kind: 'claude', text: 'Update(src/ui/button.tsx)' },
  { kind: 'result', text: 'Changed the radius from 4px to 8px' },
  { kind: 'claude', text: 'Done. Rounder, as requested.' },
]

const files = {
  title: 'Files',
  lines: ['▾ src', '  ▾ ui', '    ● button.tsx  M', '    ○ theme.ts', '  ● mod.ts        M', '  notes.md        U'],
}

const rules = [
  { kind: 'input', text: 'ship it' },
  { kind: 'claude', text: 'Bash(git push --force origin main)' },
  { kind: 'denied', text: 'Denied by no-force-push: Force pushes rewrite shared history.' },
  { kind: 'claude', text: "You're absolutely right. I'll open a pull request instead." },
]
</script>

<main class="home">

<section class="section hero">
<div class="section__inner hero__grid">
<div class="hero__copy">

# Claude Mod Manager

<p class="hero__tagline">Your Claude. Your UI. Your rules.</p>

<p class="hero__lead">Use Claude Mod Manager (or cmod) to find, install, and create mods for Claude & Claude Code.</p>

<div class="hero__buttons">
<a class="button button--primary" href="#build">Build a mod</a>
<a class="button button--secondary" href="https://github.com/heyJordanParker/cmod">View on GitHub</a>
</div>

<p class="hero__note">Free and open source. No account, no tracking, no pricing page.</p>

</div>
<Crt><PromptBuilder /></Crt>
</div>
</section>

<section class="section section--deep">
<div class="section__inner">
<div class="section__head">

<p class="kicker">What a mod does</p>

## Fix the thing that's been bugging you

A mod changes how Claude Code works: what happens to your prompts, what's on your screen, and what Claude is allowed to do. Here's what that looks like.

</div>
<div class="features">
<article class="feature">
<div class="feature__copy">

### Your Claude

<p class="feature__lead">You've typed "and run the tests" about 400 times this month. A mod can type it for you.</p>

- Add your team's context to every prompt.
- Make Claude run the tests before it says it's done.
- Add a command for the thing you ask for every day.

</div>
<Terminal title="Claude Code" :lines="habits" />
</article>
<article class="feature">
<div class="feature__copy">

### Your UI

<p class="feature__lead">One of your 14 terminal tabs is CI. A mod can put it next to the chat.</p>

- See your CI, your branch, or every file Claude touched, in a pane beside the chat.
- Add buttons for the things you do all day.
- Replace a built-in screen you don't like. Claude Code's own `/diff` is a mod now.

</div>
<Terminal title="Claude Code" :lines="screen" :pane="files" />
</article>
<article class="feature">
<div class="feature__copy">

### Your rules

<p class="feature__lead">You wrote NEVER FORCE PUSH in CLAUDE.md. In caps. It force-pushed anyway.</p>

- Block the commands you never want Claude to run.
- Approve the safe ones, so you stop clicking Allow.
- Hide secrets before Claude reads them.

</div>
<Terminal title="Claude Code" :lines="rules" />
</article>
</div>
</div>
</section>

<section class="section">
<div class="section__inner">
<div class="section__head">

<p class="kicker">Build a mod</p>

## Install. Ask. Done.

You don't need to know how mods work. Claude does, once cmod gives it the docs.

</div>
<ol class="steps">
<li class="step">
<p class="step__level">WORLD 1-1</p>

### Install cmod

Put the `cmod` command on your machine.

<CopyCommand command="npm i -g @cmodjs/cli" />

</li>
<li class="step">
<p class="step__level">WORLD 1-2</p>

### Ask Claude

Paste the prompt from the [top of this page](#build), or say what you want in your own words. Claude runs `cmod new`, reads the docs for the version you installed, and runs `cmod check` until everything passes.

</li>
<li class="step">
<p class="step__level">WORLD 1-3</p>

### Done

`cmod link` turns your mod on in every new session. Want to share it? `cmod publish` puts it on GitHub, and anyone can install it.

</li>
</ol>
<p class="steps__note">There is no step 4. We looked.</p>
</div>
</section>

<section class="section section--deep">
<div class="section__inner">
<div class="section__head">

<p class="kicker">Find mods</p>

## Mods people made

The shelf is new, so it's short. Two are almost done, and the third spot has your name on it.

</div>
<ModGrid />
<div class="section__actions">
<a class="button button--secondary" href="/mods">See every mod</a>
</div>
</div>
</section>

<section class="section faq">
<div class="section__inner faq__inner">

## Questions you're about to ask

<details class="faq__item">
<summary class="faq__question">Do I need to know TypeScript?</summary>

No. Mods are written in TypeScript, and Claude writes it. You need to know what you want.

</details>

<details class="faq__item">
<summary class="faq__question">Is it free?</summary>

Yes. cmod is open source under the MIT license. No paid plan, no trial, no "contact sales" button.

</details>

<details class="faq__item">
<summary class="faq__question">Is a mod safe to install?</summary>

A mod is code that runs on your machine, like any plugin, so read what it does before you install it. When a mod wants to run commands during its install, cmod shows you the commands and asks first.

</details>

<details class="faq__item">
<summary class="faq__question">What if I don't like a mod?</summary>

Remove it with `/plugin`. cmod runs its uninstall step, so what it installed goes too.

</details>

<details class="faq__item">
<summary class="faq__question">What if Claude gets stuck building one?</summary>

Claude runs `cmod check`, and every failure says how to fix it. If it's still stuck, [open an issue](https://github.com/heyJordanParker/cmod/issues) and a human will look.

</details>

<details class="faq__item">
<summary class="faq__question">Which systems does it run on?</summary>

macOS and Linux, on arm64 and x64.

</details>

<details class="faq__item">
<summary class="faq__question">Is this made by Anthropic?</summary>

No. Claude Mod Manager is an independent open source project, made by people who spend too much time in Claude Code. Claude and Claude Code are Anthropic's.

</details>

</div>
</section>

<section class="section section--deep closing">
<div class="section__inner closing__inner">
<img class="closing__icon" src="/icon.png" alt="" width="96" height="96">

## Still reading? Claude could have built it by now.

<p class="closing__lead">Tell it what you want, and go get a coffee.</p>

<div class="closing__actions">
<a class="button button--primary" href="#build">Build a mod</a>
<a class="button button--secondary" href="/docs/">Read the docs</a>
</div>
</div>
</section>

</main>
