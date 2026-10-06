import { defineConfig } from 'vitepress'

const site = 'https://claudemodmanager.com'
const description = 'Build Claude Code mods with install steps, saved settings, terminal panes, permission rules, tests, and one-command releases. Free and open source.'

export default defineConfig({
  title: 'Claude Mod Manager',
  description,
  lang: 'en-US',
  appearance: 'force-dark',
  cleanUrls: true,
  srcExclude: ['README.md'],
  sitemap: { hostname: site },
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/icon.png' }],
    ['link', { rel: 'apple-touch-icon', href: '/icon.png' }],
    ['meta', { name: 'theme-color', content: '#1b2232' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Claude Mod Manager' }],
    ['meta', { property: 'og:image', content: `${site}/icon.png` }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
  ],
  themeConfig: {
    logo: { src: '/icon.png', alt: '' },
    siteTitle: 'Claude Mod Manager',
    nav: [
      { text: 'Docs', link: '/docs/', activeMatch: '^/docs/(?!commands)' },
      { text: 'Commands', link: '/docs/commands' },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/heyJordanParker/cmod', ariaLabel: 'CMod on GitHub' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/@cmodjs/cli', ariaLabel: '@cmodjs/cli on npm' },
    ],
    sidebar: {
      '/docs/': [
        {
          text: 'Build a mod',
          items: [
            { text: 'Overview', link: '/docs/' },
            { text: 'Define a mod', link: '/docs/mod' },
            { text: 'State', link: '/docs/state' },
            { text: 'Hooks', link: '/docs/hooks' },
            { text: 'UI', link: '/docs/ui' },
            { text: 'Jobs', link: '/docs/jobs' },
            { text: 'Call another mod', link: '/docs/dependencies' },
            { text: 'Install steps', link: '/docs/install-steps' },
            { text: 'Testing', link: '/docs/testing' },
          ],
        },
        {
          text: 'Reference',
          items: [{ text: 'cmod commands', link: '/docs/commands' }],
        },
      ],
    },
    outline: [2, 3],
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/heyJordanParker/cmod/edit/main/core/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'MIT licensed. Claude Mod Manager is an independent project, not made or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.',
    },
  },
})
