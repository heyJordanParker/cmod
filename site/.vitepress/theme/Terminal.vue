<script setup lang="ts">
export type TerminalLine = {
  readonly kind: 'prompt' | 'input' | 'ok' | 'fail' | 'fix' | 'out'
  readonly text: string
}

withDefaults(defineProps<{ title: string; lines: readonly TerminalLine[]; isTyped?: boolean }>(), { isTyped: false })

const marks: Record<TerminalLine['kind'], string> = { prompt: '$', input: '>', ok: '✔', fail: '✘', fix: '→', out: ' ' }
</script>

<template>
  <figure class="terminal" :data-typed="isTyped">
    <figcaption class="terminal__title">{{ title }}</figcaption>
    <pre class="terminal__body" tabindex="0"><code><span
      v-for="(line, index) in lines"
      :key="index"
      class="terminal__line"
      :data-kind="line.kind"
      :style="{ '--line': index }"
    ><span class="terminal__mark" aria-hidden="true">{{ marks[line.kind] }}</span>{{ line.text }}
</span></code></pre>
  </figure>
</template>

<style>
.terminal {
  display: grid;
  grid-template-rows: auto 1fr;
  min-width: 0;
  border-radius: calc(var(--cm-radius) + 0.25rem);
  background: var(--cm-navy-900);
  box-shadow: var(--cm-shadow-subtle);
  overflow: hidden;
}

.terminal__title {
  padding-block: 0.625rem;
  padding-inline: 1rem;
  background: var(--cm-navy-800);
  color: var(--cm-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
}

.terminal__body {
  margin: 0;
  padding: 1rem;
  overflow-x: auto;
  color: var(--cm-text-2);
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  line-height: 1.7;
}

.terminal__body:focus-visible {
  outline: 2px solid var(--cm-blue-400);
  outline-offset: -2px;
}

.terminal__line {
  display: block;
}

.terminal__mark {
  display: inline-block;
  width: 2ch;
}

.terminal__line[data-kind='prompt'],
.terminal__line[data-kind='input'] {
  color: var(--cm-text-1);
}

.terminal__line[data-kind='prompt'] .terminal__mark,
.terminal__line[data-kind='input'] .terminal__mark {
  color: var(--cm-coral);
}

.terminal__line[data-kind='ok'] .terminal__mark {
  color: var(--cm-green);
}

.terminal__line[data-kind='fail'] .terminal__mark {
  color: var(--cm-coral);
}

.terminal__line[data-kind='fix'] {
  color: var(--cm-beige-300);
}

.terminal[data-typed='true'] .terminal__line {
  animation: terminal-line 1ms step-end backwards;
  animation-delay: calc(400ms + var(--line) * 260ms);
}

@keyframes terminal-line {
  from {
    visibility: hidden;
  }
}

@media (prefers-reduced-motion: reduce) {
  .terminal[data-typed='true'] .terminal__line {
    animation: none;
  }
}
</style>
