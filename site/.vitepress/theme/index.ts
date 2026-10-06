import '@fontsource-variable/pixelify-sans'
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/600.css'
import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme-without-fonts'
import CopyCommand from './CopyCommand.vue'
import Crt from './Crt.vue'
import Terminal from './Terminal.vue'
import './theme.css'
import './home.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('CopyCommand', CopyCommand)
    app.component('Crt', Crt)
    app.component('Terminal', Terminal)
  },
} satisfies Theme
