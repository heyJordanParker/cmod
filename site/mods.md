---
layout: page
title: Mods
description: Find mods for Claude and Claude Code, install them from Claude Code, and list the mod you built.
---

<script setup>
const installing = [
  { kind: 'input', text: '/plugin marketplace add owner/repo' },
  { kind: 'input', text: '/plugin install my-mod@my-marketplace' },
]
</script>

<main class="home">

<section class="section hero">
<div class="section__inner">
<div class="section__head">

<p class="kicker">Mods</p>

# Find a mod

Here's every mod we know about. It's a short list. We're working on it, and so is Claude.

</div>
<ModGrid heading="h2" />
</div>
</section>

<section class="section section--deep">
<div class="section__inner split">
<div class="split__copy">

## Install one

Type two commands in Claude Code, with the mod's GitHub repository in place of `owner/repo`. Claude Code installs cmod along with it.

Rather use a terminal? `cmod install owner/repo` does the same.

</div>
<Terminal title="Claude Code" :lines="installing" />
</div>
</section>

<section class="section">
<div class="section__inner closing__inner">

## Built one? Put it here.

<p class="closing__lead">Add your mod to <code>site/mods.json</code> in a pull request, and it shows up on this page.</p>

<div class="closing__actions">
<a class="button button--primary" href="https://github.com/heyJordanParker/cmod/edit/main/site/mods.json">Add your mod</a>
<a class="button button--secondary" href="/#build">Build one first</a>
</div>
</div>
</section>

</main>
