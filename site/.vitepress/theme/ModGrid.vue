<script setup lang="ts">
import listed from '../../mods.json'
import CopyCommand from './CopyCommand.vue'

type Mod = {
  readonly name: string
  readonly description: string
  readonly author: string
  readonly repository?: string
  readonly isComingSoon?: boolean
}

withDefaults(defineProps<{ heading?: 'h2' | 'h3' }>(), { heading: 'h3' })

const mods: readonly Mod[] = listed
</script>

<template>
  <ul class="mods">
    <li v-for="mod in mods" :key="mod.name" class="mod">
      <p v-if="mod.isComingSoon" class="mod__badge">Coming soon</p>
      <component :is="heading" class="mod__name">{{ mod.name }}</component>
      <p class="mod__description">{{ mod.description }}</p>
      <p class="mod__author">by {{ mod.author }}</p>
      <div v-if="mod.repository" class="mod__install">
        <CopyCommand :command="`cmod install ${mod.repository}`" />
        <a class="mod__link" :href="`https://github.com/${mod.repository}`">See it on GitHub</a>
      </div>
    </li>
    <li class="mod mod--yours">
      <a class="mod__start" href="/#build">
        <span class="mod__player">2P</span>
        <span class="mod__name">Your mod here</span>
        <span class="mod__press">PRESS START</span>
      </a>
    </li>
  </ul>
</template>

<style>
.mods {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr));
  gap: 1rem;
  padding: 0;
  list-style: none;
}

.mod {
  display: grid;
  align-content: start;
  gap: 0.75rem;
  padding: 1.5rem;
  border-radius: calc(var(--cm-radius) + 0.25rem);
  background: var(--cm-navy-700);
  box-shadow: var(--cm-shadow-subtle);
  transition: translate 200ms var(--cm-ease), box-shadow 200ms ease;
}

.mod__badge {
  width: fit-content;
  padding: 0.125rem 0.5rem;
  border-radius: calc(var(--cm-radius) - 0.25rem);
  background: oklch(from var(--cm-coral) l c h / 0.16);
  color: var(--cm-coral);
  font-family: var(--cm-font-display);
  font-size: 0.75rem;
  font-variant-ligatures: none;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.mods .mod__name {
  color: var(--cm-text-1);
  font-family: var(--cm-font-display);
  font-size: 1.125rem;
  font-variant-ligatures: none;
  font-weight: 600;
}

.mod__description {
  color: var(--cm-text-2);
}

.mod__author {
  color: var(--cm-text-3);
  font-size: 0.75rem;
}

.mod__install {
  display: grid;
  gap: 0.75rem;
}

.mod--yours {
  padding: 0;
  background: transparent;
  box-shadow: inset 0 0 0 2px oklch(1 0 0 / 0.12);
}

.mod__start {
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 0.75rem;
  min-height: 12rem;
  padding: 1.5rem;
  border-radius: inherit;
  text-align: center;
  text-decoration: none;
}

.mod__start:focus-visible {
  outline: 2px solid var(--cm-blue-400);
  outline-offset: 2px;
}

.mod__player {
  color: var(--cm-blue-400);
  font-family: var(--cm-font-display);
  font-size: 0.875rem;
  font-variant-ligatures: none;
}

.mod__press {
  color: var(--cm-green);
  font-family: var(--cm-font-display);
  font-size: 0.875rem;
  font-variant-ligatures: none;
  letter-spacing: 0.15em;
  animation: mod-blink 1.2s steps(1, end) infinite;
}

@keyframes mod-blink {
  50% {
    opacity: 0.3;
  }
}

@media (hover: hover) and (pointer: fine) {
  .mod:hover {
    translate: 0 -0.125rem;
    box-shadow: var(--cm-shadow-elevated);
  }

  .mod--yours:hover {
    box-shadow: inset 0 0 0 2px var(--cm-green);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mod {
    transition: none;
  }

  .mod__press {
    animation: none;
  }
}
</style>
