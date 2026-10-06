<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const invader = [
  '..X.....X..',
  '...X...X...',
  '..XXXXXXX..',
  '.XX.XXX.XX.',
  'XXXXXXXXXXX',
  'X.XXXXXXX.X',
  'X.X.....X.X',
  '...XX.XX...',
]
const invaderPath = invader
  .flatMap((row, y) => [...row].map((pixel, x) => (pixel === 'X' ? `M${x} ${y}h1v1h-1z` : '')))
  .join('')

const cheats = [
  { keys: ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'], run: toggleArcade },
  { keys: [...'iddqd'], run: () => say('Degreelessness mode on. Claude still asks before it runs rm -rf.') },
  { keys: [...'idkfa'], run: () => say('All keys added. Not the API kind.') },
  { keys: [...'xyzzy'], run: () => say('Nothing happens. Try /plugin.') },
]

const message = ref('')
let pressed: string[] = []
let hiding: ReturnType<typeof setTimeout> | undefined

function say(text: string): void {
  message.value = text
  clearTimeout(hiding)
  hiding = setTimeout(() => (message.value = ''), 3600)
}

function toggleArcade(): void {
  const root = document.documentElement
  const isOn = root.dataset.arcade !== 'true'
  root.dataset.arcade = String(isOn)
  say(isOn ? '+30 lives. Arcade mode on.' : 'Arcade mode off. Back to work.')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable]')) return
  pressed = [...pressed, event.key.toLowerCase()].slice(-10)
  const cheat = cheats.find(({ keys }) => keys.every((key, index) => pressed[pressed.length - keys.length + index] === key))
  if (!cheat) return
  pressed = []
  cheat.run()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  console.log(
    '%cCLAUDE MOD MANAGER%c\nYou opened DevTools. Respect.\nThe source: https://github.com/heyJordanParker/cmod\nThe code that matters: ↑ ↑ ↓ ↓ ← → ← → B A',
    'color:#e8805f;font:700 20px monospace;letter-spacing:4px',
    'color:inherit;font:12px/1.6 monospace',
  )
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  clearTimeout(hiding)
})
</script>

<template>
  <div class="arcade">
    <p class="arcade__toast" role="status" :data-shown="message !== ''">{{ message }}</p>
    <svg class="arcade__invader" viewBox="0 0 11 8" aria-hidden="true"><path :d="invaderPath" /></svg>
  </div>
</template>
