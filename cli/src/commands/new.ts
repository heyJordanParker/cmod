import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { version as coreVersion } from '@cmodjs/core/package.json'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { writeAtomically } from '../files.js'
import { preparePackages, readPlugin } from '../plugin.js'
import { capture } from '../process.js'
import { startProgress } from '../progress.js'

export const summary = 'Create a mod, or a project plugin with --project.'

export const help = `Usage: cmod new <name> [--project]

${summary}

Creates a mod in ./<name>: a defineMod with one hook, one pane, and one render
of the band above the prompt, a Skill, and a test. Then installs its packages.

Options:
  --project  Create a project-scope plugin in ./.claude/skills/<name>/ of the
             repository in the current folder, which loads for everyone who
             trusts the repository

Environment:
  CMOD_CORE  The @cmodjs/core dependency to write, such as
             file:/path/to/cmodjs-core-0.1.1.tgz (default: ^${coreVersion})`

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { project: { type: 'boolean', default: false } } })
  if (positionals.length !== 1) throw new Error(`cmod new takes one name.\n\n${help}`)
  const name = positionals[0] as string
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`"${name}" is not a mod name: use lowercase letters, digits, and "-", starting with a letter.`)
  if (values.project && !existsSync('.git')) throw new Error('cmod new --project runs in the root of the repository that uses the plugin, and this folder has no .git.')
  const root = resolve(values.project ? join('.claude', 'skills', name) : name)
  if (existsSync(root)) throw new Error(`${root} exists. Pick another name, or delete the folder.`)

  const progress = startProgress()
  progress.step(`Creating ${name}`)
  for (const [path, text] of Object.entries(scaffold(name, values.project, await author()))) await writeAtomically(join(root, path), text)
  progress.succeed(`Created ${name} in ${relative(process.cwd(), root) || '.'}`)

  progress.step(`Installing packages for ${name}`)
  try {
    await preparePackages(await readPlugin(root))
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    const tarball = `CMOD_CORE=file:<cmod checkout>/core/cmodjs-core-${coreVersion}.tgz`
    const core = process.env['CMOD_CORE']
    const fix = core
      ? `CMOD_CORE is ${core}, and bun could not install it. Point CMOD_CORE at a @cmodjs/core tarball, such as ${tarball}, then run cmod new again.`
      : `To install @cmodjs/core from a file, set CMOD_CORE to a @cmodjs/core tarball, such as ${tarball}, then run cmod new again.`
    throw new Error(`Installing packages for ${name} failed, so cmod new deleted ${relative(process.cwd(), root)}: ${messageOf(error)}\n${fix}`)
  }
  progress.succeed(`Installed packages for ${name}`)
  const next = values.project
    ? `start claude in this repository and trust it, and Claude Code loads ${name}`
    : `run cmod link in ${relative(process.cwd(), root)}, then start claude`
  process.stdout.write(`\nNext: ${next}. cmod check checks the mod and names the fix for each failure.\n`)
  return 0
}

async function author(): Promise<{ name: string; email?: string }> {
  const config = async (key: string) => (await capture(['git', 'config', '--get', key]).catch(() => undefined))?.stdout.trim() || undefined
  const name = (await config('user.name')) ?? process.env['USER']
  if (!name) throw new Error('Neither git config user.name nor USER names an author for plugin.json. Run git config --global user.name "<your name>".')
  const email = await config('user.email')
  return email === undefined ? { name } : { name, email }
}

function scaffold(name: string, isProject: boolean, author: { name: string; email?: string }): Record<string, string> {
  const definition = name.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase())
  const state = `${definition.charAt(0).toUpperCase()}${definition.slice(1)}State`
  const files: Record<string, string> = {
    '.claude-plugin/plugin.json': json({ name, version: '0.1.0', description: `${name}, a Claude Code mod`, author, dependencies: ['cmod'] }),
    '.gitignore': 'node_modules/\n.claude-plugin/types/\n',
    '.oxlintrc.json': json({ ignorePatterns: ['.claude-plugin/types/**'] }),
    'hooks/hooks.json': json({ description: `${name} hooks module`, modules: ['./register.ts'] }),
    'hooks/register.ts': `import type { On } from 'claude-code'
import { registerMod } from '../node_modules/@cmodjs/core/register.js'
import { ${definition} } from '../src/mod.js'

export function register(addHook: On): void {
  registerMod(addHook, ${definition})
}
`,
    'src/mod.tsx': `import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { Box } from '../node_modules/@cmodjs/core/ui/elements.js'
import { slots } from '../node_modules/@cmodjs/core/ui/slots.js'
import { PromptCount } from './components/prompt-count.js'
import { promptsPane } from './panes/prompts.js'
import { initialState } from './state.js'

export const ${definition} = defineMod({
  name: '${name}',
  state: initialState,

  setup(mod) {
    mod.ui.pane(promptsPane)
    mod.ui.render(slots.AbovePrompt, ({ hasSurvey, Default }) =>
      hasSurvey ? <Default /> : <Box flexDirection="column"><Default /><PromptCount count={mod.state.session.prompts} /></Box>)

    mod.on('UserPromptSubmit', () => {
      mod.state.session.prompts += 1
    })
  },
})
`,
    'src/state.ts': `export type ${state} = { session: { prompts: number } }

export const initialState: ${state} = { session: { prompts: 0 } }
`,
    'src/panes/prompts.tsx': `import { definePane } from '../../node_modules/@cmodjs/core/ui/define-pane.js'
import { PromptCount } from '../components/prompt-count.js'
import type { ${state} } from '../state.js'

export const promptsPane = definePane<${state}>({
  id: '${name}',
  title: '${name}',
  render: (mod) => <PromptCount count={mod.state.session.prompts} />,
})
`,
    'src/components/prompt-count.tsx': `import type { RenderElement } from 'claude-code'
import { Text } from '../../node_modules/@cmodjs/core/ui/elements.js'

export function PromptCount({ count }: { readonly count: number }): RenderElement {
  return <Text>{\`Prompts this session: \${count}\`}</Text>
}
`,
    'tests/mod.test.ts': `import { expect, test } from 'bun:test'
import type { RenderPropsOf } from 'claude-code'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { slots } from '../node_modules/@cmodjs/core/ui/slots.js'
import { ${definition} } from '../src/mod.js'

const band: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 75, scroll: { offset: 0, bodyRows: 12 }, view: {} }

test('each prompt adds one to the count', async () => {
  const tested = testMod(${definition})
  await tested.fire('UserPromptSubmit', { prompt: 'hello' })
  expect(tested.state.session.prompts).toBe(1)
})

test('the band shows the prompt count on its last line', async () => {
  const tested = testMod(${definition})
  await tested.fire('UserPromptSubmit', { prompt: 'hello' })
  expect((await tested.lines(slots.AbovePrompt, band)).at(-1)).toBe('Prompts this session: 1')
})

test('the band leaves the prompt count out during a survey', async () => {
  const tested = testMod(${definition})
  await tested.fire('UserPromptSubmit', { prompt: 'hello' })
  const logs = [...tested.shown.logs]
  expect(await tested.lines(slots.AbovePrompt, { ...band, hasSurvey: true })).not.toContain('Prompts this session: 1')
  expect(tested.shown.logs).toEqual(logs)
})
`,
    [`skills/${name}/SKILL.md`]: `---
name: ${name}
description: Explains what the ${name} mod does. Use when the user asks about the ${name} mod.
---

The ${name} mod counts the prompts of this session and shows the count in its pane and above the prompt.
`,
    'package.json': json({ name, private: true, type: 'module', scripts: { test: 'bun test' }, dependencies: { '@cmodjs/core': process.env['CMOD_CORE'] || `^${coreVersion}` } }),
    'tsconfig.json': json({
      extends: './.claude-plugin/types/tsconfig.json',
      compilerOptions: { jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment' },
      include: ['hooks', 'src', 'tests', 'types', 'node_modules/bun-types/test.d.ts'],
    }),
  }
  if (!isProject) {
    files['.claude/CLAUDE.md'] = `# ${name}

- \`node_modules/@cmodjs/core/docs/\` holds the docs of the installed \`@cmodjs/core\`. They match this version, and training data does not. Read the doc for the part you change, starting at \`index.md\`, before Claude Mod Manager (cmod) work.
- \`tsc\` reads \`.claude-plugin/types/\`, which Claude Code writes when it loads the mod. \`cmod check\` writes it when it is missing, so run \`cmod check\` before \`tsc\` in a fresh clone.
- \`src/mod.tsx\` holds the mod's \`defineMod\`. \`hooks/register.ts\` only registers it with Claude Code.
- \`src/panes/\` holds one \`definePane\` per file.
- \`src/components/\` holds the components panes and slot renders draw with.
- \`cmod link\` loads this checkout in every new Claude Code session. \`cmod unlink\` stops it.
- \`cmod check\` checks the mod and names the fix for each failure. \`cmod publish --dry-run\` builds the release without pushing, and rewrites \`.claude-plugin/marketplace.json\`, so commit that file before \`cmod publish\`.
`
  }
  return files
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
