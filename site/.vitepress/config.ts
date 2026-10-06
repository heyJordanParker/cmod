import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type DefaultTheme, type HeadConfig } from 'vitepress'

const site = 'https://claudemodmanager.com'
const name = 'Claude Mod Manager'
const tagline = 'Your Claude. Your UI. Your rules.'
const description = 'Use Claude Mod Manager (cmod) to find, install, and create mods for Claude and Claude Code. Free and open source.'
const image = { url: `${site}/og.png`, alt: `${name}. ${tagline}` }
const repository = 'https://github.com/heyJordanParker/cmod'
const npm = 'https://www.npmjs.com/package/@cmodjs/cli'
const { version } = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'))

const docs: DefaultTheme.SidebarItem[] = [
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
]

const software = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name,
  alternateName: 'cmod',
  description,
  url: site,
  image: image.url,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'macOS, Linux',
  softwareVersion: version,
  license: 'https://opensource.org/licenses/MIT',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  author: { '@type': 'Person', name: 'Jordan Parker' },
  downloadUrl: npm,
  sameAs: [repository, npm],
}

function markdownBody(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
}

function summary(markdown: string): string {
  const paragraph = markdownBody(markdown)
    .split(/\n\s*\n/)
    .find((block) => /^[A-Za-z`*[]/.test(block)) ?? ''
  return paragraph
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
}

function pathOf(relativePath: string): string {
  return relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')
}

export default defineConfig({
  title: name,
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
    ['meta', { property: 'og:site_name', content: name }],
    ['meta', { property: 'og:image', content: image.url }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { property: 'og:image:alt', content: image.alt }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: image.url }],
    ['meta', { name: 'twitter:image:alt', content: image.alt }],
    ['link', { rel: 'alternate', type: 'text/plain', title: 'llms.txt', href: '/llms.txt' }],
  ],
  transformPageData(pageData, { siteConfig }) {
    if (pageData.description) return
    return { description: summary(readFileSync(join(siteConfig.srcDir, pageData.relativePath), 'utf8')) }
  },
  transformHead({ pageData }) {
    if (pageData.isNotFound) return
    const isHome = pageData.relativePath === 'index.md'
    const url = `${site}/${pathOf(pageData.relativePath)}`
    const title = isHome ? `${name}: ${tagline}` : `${pageData.title} | ${name}`
    const head: HeadConfig[] = [
      ['link', { rel: 'canonical', href: url }],
      ['meta', { property: 'og:url', content: url }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: pageData.description }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: pageData.description }],
    ]
    return isHome ? [...head, ['script', { type: 'application/ld+json' }, JSON.stringify(software)]] : head
  },
  buildEnd({ srcDir, outDir, pages }) {
    const sources = pages.filter((page) => page.startsWith('docs/'))
    for (const page of sources) writeFileSync(join(outDir, page), readFileSync(join(srcDir, page)))
    const linked = docs.flatMap((group) => group.items ?? [])
    const llms = [
      `# ${name}`,
      '',
      `> ${name} (cmod) finds, installs, and creates mods for Claude and Claude Code. A mod is a Claude Code plugin that changes how Claude Code works: it can rewrite prompts, add panes and buttons to the UI, replace built-in screens, and allow or block what Claude runs. Free and open source under MIT.`,
      '',
      'To build a mod, install cmod with `npm i -g @cmodjs/cli`, run `cmod new <name>`, read `node_modules/@cmodjs/core/docs/index.md` in the new folder, build the mod, run `cmod check` until it passes, then run `cmod link`. Each page below is Markdown, and it matches the latest release.',
      '',
      '## Docs',
      '',
      ...linked.map(({ text, link = '' }) => {
        const page = link.endsWith('/') ? `${link.slice(1)}index.md` : `${link.slice(1)}.md`
        return `- [${text}](${site}/${page}): ${summary(readFileSync(join(srcDir, page), 'utf8'))}`
      }),
      '',
      '## Optional',
      '',
      `- [Mods](${site}/mods): every mod listed on the site`,
      `- [Full docs](${site}/llms-full.txt): every docs page in one file`,
      `- [Source](${repository}): the cmod repository on GitHub`,
      '',
    ]
    writeFileSync(join(outDir, 'llms.txt'), llms.join('\n'))
    writeFileSync(
      join(outDir, 'llms-full.txt'),
      sources.map((page) => `<!-- ${site}/${page} -->\n\n${markdownBody(readFileSync(join(srcDir, page), 'utf8'))}\n`).join('\n'),
    )
  },
  themeConfig: {
    logo: { src: '/icon.png', alt: '' },
    siteTitle: name,
    nav: [
      { text: 'Mods', link: '/mods' },
      { text: 'Docs', link: '/docs/', activeMatch: '^/docs/(?!commands)' },
      { text: 'Commands', link: '/docs/commands' },
    ],
    socialLinks: [
      { icon: 'github', link: repository, ariaLabel: 'cmod on GitHub' },
      { icon: 'npm', link: npm, ariaLabel: '@cmodjs/cli on npm' },
    ],
    sidebar: { '/docs/': docs },
    outline: [2, 3],
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/heyJordanParker/cmod/edit/main/core/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: `Free and open source under MIT. <a href="/privacy">Privacy policy</a>. <a href="/terms">Terms of use</a>. <a href="${repository}/issues">Support</a>.`,
      copyright: 'Claude Mod Manager is an independent project, not made or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.',
    },
  },
})
