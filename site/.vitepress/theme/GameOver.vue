<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Crt from './Crt.vue'

const count = ref(9)
let ticking: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  ticking = setInterval(() => {
    count.value -= 1
    if (count.value === 0) clearInterval(ticking)
  }, 1000)
})

onBeforeUnmount(() => clearInterval(ticking))
</script>

<template>
  <main class="game-over">
    <Crt>
      <div class="game-over__screen">
        <h1 class="game-over__title">GAME OVER</h1>
        <p class="game-over__text">This page doesn't exist. Maybe Claude renamed it.</p>
        <p class="game-over__continue" :data-ended="count === 0">
          <span class="game-over__count">CONTINUE? {{ count }}</span>
          <span class="game-over__thanks">THANKS FOR PLAYING</span>
        </p>
        <div class="game-over__actions">
          <a class="button button--primary" href="/">Continue</a>
          <a class="button button--secondary" href="/docs/">Read the docs</a>
        </div>
      </div>
    </Crt>
  </main>
</template>

<style>
.game-over {
  display: grid;
  place-items: center;
  min-height: calc(100svh - var(--vp-nav-height));
  padding-block: 3rem;
  padding-inline: clamp(1.25rem, 5vw, 3rem);
}

.game-over .crt {
  width: min(100%, 36rem);
}

.game-over__screen {
  display: grid;
  gap: 1.25rem;
  justify-items: center;
  padding-block: 2.5rem 2rem;
  padding-inline: 1rem;
  text-align: center;
}

.game-over__title {
  color: var(--cm-coral);
  font-family: var(--cm-font-display);
  font-size: clamp(2.25rem, 1.4rem + 3.2vw, 3.75rem);
  font-variant-ligatures: none;
  line-height: 1;
}

.game-over__text {
  color: var(--cm-text-2);
}

.game-over__continue {
  display: grid;
  color: var(--cm-text-1);
  font-family: var(--cm-font-display);
  font-size: 1.125rem;
  font-variant-ligatures: none;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.15em;
}

.game-over__count,
.game-over__thanks {
  grid-area: 1 / 1;
}

.game-over__count {
  animation: game-over-blink 1s steps(1, end) infinite;
}

.game-over__thanks,
.game-over__continue[data-ended='true'] .game-over__count {
  visibility: hidden;
}

.game-over__continue[data-ended='true'] .game-over__thanks {
  visibility: visible;
}

.game-over__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.75rem;
}

@keyframes game-over-blink {
  50% {
    opacity: 0.3;
  }
}

@media (prefers-reduced-motion: reduce) {
  .game-over__count {
    animation: none;
  }
}
</style>
