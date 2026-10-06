<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{ command: string }>()
const isCopied = ref(false)

async function copy(): Promise<void> {
  await navigator.clipboard.writeText(props.command)
  isCopied.value = true
  setTimeout(() => (isCopied.value = false), 1600)
}
</script>

<template>
  <div class="command">
    <code class="command__text"><span class="command__prompt" aria-hidden="true">$</span>{{ command }}</code>
    <button class="command__copy one-up" type="button" :data-copied="isCopied" :aria-label="`Copy ${command}`" @click="copy">
      <span class="command__label command__label--idle">Copy</span>
      <span class="command__label command__label--done" aria-live="polite">Copied</span>
    </button>
  </div>
</template>

<style>
.command {
  container-type: inline-size;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding-block: 0.5rem;
  padding-inline: 1rem 0.5rem;
  border-radius: calc(var(--cm-radius) + 0.25rem);
  background: var(--cm-navy-900);
  box-shadow: var(--cm-shadow-subtle);
  font-family: var(--vp-font-family-mono);
  font-size: 0.875rem;
}

.command .command__text {
  display: flex;
  flex: 1;
  gap: 0.75ch;
  min-width: 0;
  padding: 0;
  overflow-x: auto;
  background: none;
  color: var(--cm-text-1);
  font-size: 0.875rem;
  white-space: nowrap;
}

.command__prompt {
  color: var(--cm-coral);
  user-select: none;
}

.command__copy {
  display: grid;
  position: relative;
  padding-block: 0.375rem;
  padding-inline: 0.75rem;
  border-radius: var(--cm-radius);
  background: var(--cm-navy-700);
  color: var(--cm-text-2);
  font-family: var(--vp-font-family-base);
  font-size: 0.75rem;
  font-weight: 600;
  transition: background-color 150ms ease, color 150ms ease, scale 150ms ease-out;
}

.command__copy::after {
  content: '';
  position: absolute;
  inset: -0.5rem;
}

.command__copy:active {
  scale: 0.96;
}

.command__copy:focus-visible {
  outline: 2px solid var(--cm-blue-400);
  outline-offset: 2px;
}

.command__label {
  grid-area: 1 / 1;
  transition: opacity 150ms ease;
}

.command__label--done,
.command__copy[data-copied='true'] .command__label--idle {
  opacity: 0;
}

.command__copy[data-copied='true'] .command__label--done {
  opacity: 1;
  color: var(--cm-green);
}

@media (hover: hover) and (pointer: fine) {
  .command__copy:hover {
    background: var(--cm-navy-600);
    color: var(--cm-text-1);
  }
}
</style>
