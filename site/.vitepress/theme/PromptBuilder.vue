<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const examples = [
  'Stop Claude from ever force-pushing',
  'Show my CI status next to the chat',
  'Hide API keys before Claude reads a file',
  'Make Claude run the tests before it says it is done',
  'Show a tree of every file Claude touched',
  'Approve npm test for me so I stop clicking Allow',
]

const wish = ref('')
const placeholder = ref(examples[0])
const status = ref<'idle' | 'copied' | 'empty' | 'blocked'>('idle')
const isNudged = ref(false)
const input = ref<HTMLTextAreaElement>()
const peek = ref<HTMLDetailsElement>()
let typing: ReturnType<typeof setTimeout> | undefined

const prompt = computed(() =>
  [
    'Build a Claude Code mod with Claude Mod Manager (cmod), https://claudemodmanager.com',
    '',
    `The mod should: ${wish.value.trim()}`,
    '',
    '1. If `cmod --version` fails, install cmod with `npm i -g @cmodjs/cli`.',
    '2. Pick a short name for the mod (lowercase letters, digits, and dashes), run `cmod new <name>`, and work inside the new folder.',
    '3. Read `node_modules/@cmodjs/core/docs/index.md`, then the doc for each part you use. They match the installed cmod version, and your training data does not.',
    '4. Build the mod, with tests for what it does.',
    '5. Run `cmod check` after every change, and fix what it reports until it passes.',
    '6. Run `cmod link`, then tell me to run /reload-plugins and how to try the mod.',
    '',
    'When the description leaves something open, pick the simplest option and tell me what you picked.',
  ].join('\n'),
)

async function copy(): Promise<void> {
  if (!wish.value.trim()) {
    status.value = 'empty'
    isNudged.value = true
    input.value?.focus()
    return
  }
  try {
    await navigator.clipboard.writeText(prompt.value)
    status.value = 'copied'
  } catch {
    status.value = 'blocked'
    if (peek.value) peek.value.open = true
  }
}

function typeExamples(example = 0, length = 0): void {
  const text = examples[example]
  placeholder.value = text.slice(0, length) || '​'
  const isDone = length === text.length
  typing = setTimeout(
    () => (isDone ? typeExamples((example + 1) % examples.length, 0) : typeExamples(example, length + 1)),
    isDone ? 2200 : 45,
  )
}

function focusOnBuildLink(): void {
  if (location.hash === '#build') input.value?.focus({ preventScroll: true })
}

onMounted(() => {
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) typeExamples()
  focusOnBuildLink()
  window.addEventListener('hashchange', focusOnBuildLink)
})

onBeforeUnmount(() => {
  clearTimeout(typing)
  window.removeEventListener('hashchange', focusOnBuildLink)
})
</script>

<template>
  <form id="build" class="builder" @submit.prevent="copy">
    <label class="builder__label" for="build-wish">Make Claude behave <em>exactly</em> as you want</label>
    <textarea
      id="build-wish"
      ref="input"
      v-model="wish"
      class="builder__wish"
      rows="3"
      :placeholder="placeholder"
      :data-nudged="isNudged"
      @animationend="isNudged = false"
      @input="status = 'idle'"
      @keydown.meta.enter.prevent="copy"
      @keydown.ctrl.enter.prevent="copy"
    />
    <div class="builder__actions">
      <button class="button button--primary one-up" type="submit" :data-copied="status === 'copied'">Copy the prompt</button>
      <p class="builder__status" aria-live="polite" :data-status="status">
        <template v-if="status === 'copied'">Copied. Paste it into Claude Code and go get a coffee.</template>
        <template v-else-if="status === 'empty'">Tell it what you want first. Claude is good, not psychic.</template>
        <template v-else-if="status === 'blocked'">Your browser said no to the clipboard. Copy it from the box below.</template>
        <template v-else>Say it like you'd say it to a coworker.</template>
      </p>
    </div>
    <details ref="peek" class="builder__peek">
      <summary class="builder__peek-toggle">What gets copied</summary>
      <pre class="builder__prompt" tabindex="0">{{ prompt }}</pre>
    </details>
  </form>
</template>

<style>
.builder {
  display: grid;
  gap: 1rem;
  padding: 1rem;
  color: var(--cm-text-2);
  font-size: 0.875rem;
}

.builder__label {
  color: var(--cm-text-1);
  font-family: var(--cm-font-display);
  font-size: 1.125rem;
  font-variant-ligatures: none;
  line-height: 1.3;
}

.builder__label em {
  color: var(--cm-coral);
}

.builder__wish {
  width: 100%;
  min-height: 6.5rem;
  padding: 0.75rem 1rem;
  border-radius: var(--cm-radius);
  background: var(--cm-navy-800);
  box-shadow: var(--cm-shadow-subtle);
  color: var(--cm-text-1);
  caret-color: var(--cm-green);
  font-family: var(--vp-font-family-mono);
  font-size: 0.875rem;
  line-height: 1.6;
  resize: vertical;
  transition: box-shadow 150ms ease;
}

.builder__wish::placeholder {
  color: var(--cm-text-3);
}

.builder__wish:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--cm-blue-400);
}

.builder__wish[data-nudged='true'] {
  animation: builder-nudge 300ms var(--cm-ease);
}

.builder__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1rem;
}

.builder__status {
  flex: 1 1 14rem;
  color: var(--cm-text-3);
  font-size: 0.75rem;
}

.builder__status[data-status='copied'] {
  color: var(--cm-green);
}

.builder__status[data-status='empty'],
.builder__status[data-status='blocked'] {
  color: var(--cm-coral);
}

.builder__peek {
  color: var(--cm-text-3);
  font-size: 0.75rem;
}

.builder__peek-toggle {
  width: fit-content;
  cursor: pointer;
}

.builder__peek-toggle:focus-visible {
  outline: 2px solid var(--cm-blue-400);
  outline-offset: 2px;
}

.builder__prompt {
  max-height: 9rem;
  margin: 0.5rem 0 0;
  padding: 0.75rem;
  overflow: auto;
  border-radius: var(--cm-radius);
  background: var(--cm-navy-800);
  color: var(--cm-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  line-height: 1.5;
  white-space: pre-wrap;
}

.builder__prompt:focus-visible {
  outline: 2px solid var(--cm-blue-400);
  outline-offset: -2px;
}

@keyframes builder-nudge {
  25% { translate: -0.375rem 0; }
  50% { translate: 0.375rem 0; }
  75% { translate: -0.25rem 0; }
}

@media (prefers-reduced-motion: reduce) {
  .builder__wish[data-nudged='true'] {
    animation: none;
  }
}
</style>
