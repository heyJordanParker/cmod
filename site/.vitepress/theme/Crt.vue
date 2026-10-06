<script setup lang="ts">
import { ref } from 'vue'

const credits = ref(0)

function insertCoin(): void {
  credits.value = Math.min(credits.value + 1, 99)
}
</script>

<template>
  <div class="crt">
    <div class="crt__screen">
      <slot />
    </div>
    <div class="crt__base">
      <span class="crt__credits" aria-live="polite" :data-shown="credits > 0">CREDIT {{ String(credits).padStart(2, '0') }}</span>
      <button class="crt__slot" type="button" aria-label="Insert coin" title="Insert coin" @click="insertCoin" />
      <span class="crt__light" aria-hidden="true" :data-lit="credits > 0" />
    </div>
  </div>
</template>

<style>
.crt {
  display: grid;
  gap: 1rem;
  padding: 1.25rem;
  border-radius: calc(var(--cm-radius) + 0.75rem);
  background: linear-gradient(to bottom, var(--cm-beige-100), var(--cm-beige-300));
  box-shadow:
    inset 0 2px 0 oklch(1 0 0 / 0.6),
    inset 0 -3px 0 var(--cm-beige-500),
    var(--cm-shadow-floating);
}

.crt__screen {
  position: relative;
  min-width: 0;
  padding: 0.75rem;
  border-radius: calc(var(--cm-radius) + 0.25rem);
  background: var(--cm-navy-900);
  box-shadow:
    inset 0 2px 8px oklch(0 0 0 / 0.6),
    0 0 0 3px var(--cm-beige-500);
  overflow: hidden;
}

.crt__screen::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: repeating-linear-gradient(to bottom, oklch(1 0 0 / 0.025) 0 1px, transparent 1px 3px);
  pointer-events: none;
}

.crt__base {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 1rem;
  padding-inline: 0.5rem;
}

.crt__credits {
  margin-inline-end: auto;
  color: var(--cm-navy-700);
  font-family: var(--cm-font-display);
  font-size: 0.75rem;
  font-variant-ligatures: none;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.15em;
  opacity: 0;
  transition: opacity 200ms ease;
}

.crt__credits[data-shown='true'] {
  opacity: 1;
}

.crt__slot {
  position: relative;
  width: min(14rem, 50%);
  height: 0.5rem;
  border-radius: 999px;
  background: var(--cm-navy-800);
  box-shadow: inset 0 2px 2px oklch(0 0 0 / 0.5);
  cursor: pointer;
  transition: background-color 150ms ease;
}

.crt__slot::after {
  content: '';
  position: absolute;
  inset: -1rem -0.5rem;
}

.crt__slot:focus-visible {
  outline: 2px solid var(--cm-blue-600);
  outline-offset: 4px;
}

.crt__light {
  width: 0.5rem;
  aspect-ratio: 1;
  border-radius: 50%;
  background: var(--cm-beige-500);
  transition: background-color 200ms ease, box-shadow 200ms ease;
}

.crt__light[data-lit='true'] {
  background: var(--cm-green);
  box-shadow: 0 0 0.5rem var(--cm-green);
}

@media (hover: hover) and (pointer: fine) {
  .crt__slot:hover {
    background: var(--cm-navy-700);
  }
}
</style>
