import '@fontsource-variable/pixelify-sans'
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/600.css'
import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme-without-fonts'
import { h } from 'vue'
import Arcade from './Arcade.vue'
import CopyCommand from './CopyCommand.vue'
import Crt from './Crt.vue'
import GameOver from './GameOver.vue'
import ModGrid from './ModGrid.vue'
import PromptBuilder from './PromptBuilder.vue'
import Terminal from './Terminal.vue'
import './theme.css'
import './home.css'
import './arcade.css'

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { 'not-found': () => h(GameOver), 'layout-bottom': () => h(Arcade) }),
  enhanceApp({ app }) {
    app.component('CopyCommand', CopyCommand)
    app.component('Crt', Crt)
    app.component('ModGrid', ModGrid)
    app.component('PromptBuilder', PromptBuilder)
    app.component('Terminal', Terminal)
  },
} satisfies Theme
