<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

export type TerminalLine = {
  readonly kind: 'input' | 'claude' | 'result' | 'denied'
  readonly text: string
}

export type TerminalPane = {
  readonly title: string
  readonly lines: readonly string[]
}

defineProps<{ title: string; lines: readonly TerminalLine[]; pane?: TerminalPane }>()

const marks: Record<TerminalLine['kind'], string> = { input: '>', claude: '●', result: '⎿', denied: '⎿' }
const figure = ref<HTMLElement>()
const state = ref<'shown' | 'waiting' | 'playing'>('shown')
let observer: IntersectionObserver | undefined

onMounted(() => {
  if (!figure.value || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  state.value = 'waiting'
  observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting) return
      state.value = 'playing'
      observer?.disconnect()
    },
    { threshold: 0.5 },
  )
  observer.observe(figure.value)
})

onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <figure ref="figure" class="terminal" :data-state="state">
    <figcaption class="terminal__title">{{ title }}</figcaption>
    <div class="terminal__screen">
      <pre class="terminal__body" tabindex="0"><code><span
        v-for="(line, index) in lines"
        :key="index"
        class="terminal__line"
        :data-kind="line.kind"
        :style="{ '--line': index }"
      ><span class="terminal__mark" aria-hidden="true">{{ marks[line.kind] }}</span>{{ line.text }}
</span></code></pre>
      <aside v-if="pane" class="terminal__pane" :aria-label="pane.title">
        <p class="terminal__pane-title">{{ pane.title }}</p>
        <pre class="terminal__pane-body">{{ pane.lines.join('\n') }}</pre>
      </aside>
    </div>
  </figure>
</template>

<style>
.terminal {
  container-type: inline-size;
  display: grid;
  grid-template-rows: auto 1fr;
  min-width: 0;
  border-radius: calc(var(--cm-radius) + 0.25rem);
  background: var(--cm-navy-900);
  box-shadow: var(--cm-shadow-elevated);
  overflow: hidden;
}

.terminal__title {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding-block: 0.625rem;
  padding-inline: 1rem;
  background: var(--cm-navy-800);
  color: var(--cm-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
}

.terminal__title::before {
  content: '';
  width: 2.25rem;
  height: 0.5rem;
  background:
    radial-gradient(circle at 0.25rem 50%, var(--cm-coral) 0.25rem, transparent 0.26rem),
    radial-gradient(circle at 1.125rem 50%, var(--cm-beige-500) 0.25rem, transparent 0.26rem),
    radial-gradient(circle at 2rem 50%, var(--cm-green) 0.25rem, transparent 0.26rem);
}

.terminal__screen {
  display: grid;
  min-width: 0;
}

.terminal__body {
  min-width: 0;
  margin: 0;
  padding: 1rem;
  overflow-x: auto;
  color: var(--cm-text-2);
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  line-height: 1.7;
  white-space: pre-wrap;
}

.terminal__body:focus-visible {
  outline: 2px solid var(--cm-blue-400);
  outline-offset: -2px;
}

.terminal__line {
  display: block;
  padding-inline-start: 2ch;
  text-indent: -2ch;
}

.terminal__mark {
  display: inline-block;
  width: 2ch;
  text-indent: 0;
}

.terminal__line[data-kind='input'] {
  color: var(--cm-text-1);
}

.terminal__line[data-kind='input'] .terminal__mark {
  color: var(--cm-coral);
}

.terminal__line[data-kind='claude'] {
  color: var(--cm-text-1);
}

.terminal__line[data-kind='claude'] .terminal__mark {
  color: var(--cm-beige-300);
}

.terminal__line[data-kind='result'],
.terminal__line[data-kind='denied'] {
  padding-inline-start: 4ch;
  text-indent: -2ch;
  color: var(--cm-text-3);
}

.terminal__line[data-kind='denied'] {
  color: var(--cm-coral);
}

.terminal__pane {
  display: grid;
  align-content: start;
  gap: 0.5rem;
  padding: 1rem;
  background: oklch(from var(--cm-navy-800) l c h / 0.6);
}

.terminal__pane-title {
  color: var(--cm-blue-400);
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  font-weight: 600;
}

.terminal__pane-body {
  margin: 0;
  color: var(--cm-text-2);
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  line-height: 1.7;
}

.terminal[data-state='waiting'] .terminal__line {
  visibility: hidden;
}

.terminal[data-state='playing'] .terminal__line {
  animation: terminal-line 1ms step-end backwards;
  animation-delay: calc(200ms + var(--line) * 450ms);
}

@container (width > 30rem) {
  .terminal__screen:has(.terminal__pane) {
    grid-template-columns: 1fr 13rem;
  }
}

@keyframes terminal-line {
  from {
    visibility: hidden;
  }
}
</style>
