<script setup lang="ts">
import Terminal, { type TerminalLine } from './Terminal.vue'

defineProps<{ title: string; lines: readonly TerminalLine[] }>()
</script>

<template>
  <div class="crt">
    <div class="crt__screen">
      <Terminal :title="title" :lines="lines" is-typed />
    </div>
    <div class="crt__base" aria-hidden="true">
      <span class="crt__slot" />
      <span class="crt__light" />
    </div>
  </div>
</template>

<style>
.crt {
  --crt-padding: 1.25rem;

  display: grid;
  gap: 1rem;
  padding: var(--crt-padding);
  border-radius: calc(var(--cm-radius) + 0.75rem);
  background: linear-gradient(to bottom, var(--cm-beige-100), var(--cm-beige-300));
  box-shadow:
    inset 0 2px 0 oklch(1 0 0 / 0.6),
    inset 0 -3px 0 var(--cm-beige-500),
    var(--cm-shadow-floating);
}

.crt__screen {
  position: relative;
  padding: 0.75rem;
  border-radius: calc(var(--cm-radius) + 0.25rem);
  background: var(--cm-navy-900);
  box-shadow:
    inset 0 2px 8px oklch(0 0 0 / 0.6),
    0 0 0 3px var(--cm-beige-500);
}

.crt__screen::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: repeating-linear-gradient(to bottom, oklch(1 0 0 / 0.025) 0 1px, transparent 1px 3px);
  pointer-events: none;
}

.crt__screen .terminal {
  box-shadow: none;
  background: transparent;
}

.crt__screen .terminal__title {
  background: transparent;
}

.crt__base {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding-inline: 0.5rem;
}

.crt__slot {
  flex: 1;
  max-width: 14rem;
  height: 0.5rem;
  margin-inline-start: auto;
  border-radius: 999px;
  background: var(--cm-navy-800);
  box-shadow: inset 0 2px 2px oklch(0 0 0 / 0.5);
}

.crt__light {
  width: 0.5rem;
  aspect-ratio: 1;
  border-radius: 50%;
  background: var(--cm-green);
  box-shadow: 0 0 0.5rem var(--cm-green);
}
</style>
