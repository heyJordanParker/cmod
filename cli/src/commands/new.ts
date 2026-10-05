import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { version as sdkVersion } from 'cmod-sdk/package.json'
import { writeAtomically } from '../files.js'
import { preparePackages, readPlugin } from '../plugin.js'
import { capture } from '../process.js'
import { startProgress } from '../progress.js'

export const summary = 'Create a mod, or a project plugin with --project.'

export const help = `Usage: cmod new <name> [--project]

${summary}

Creates a mod in ./<name>: a defineMod with one hook, one panel, and one render
of the band above the prompt, a Skill, and a test. Then installs its packages.

Options:
  --project  Create a project-scope plugin in ./.claude/skills/<name>/ of the
             repository in the current folder, which loads for everyone who
             trusts the repository

Environment:
  CMOD_SDK   The cmod-sdk dependency to write, such as
             file:/path/to/cmod-sdk-0.1.0.tgz (default: ^${sdkVersion})`

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
  await preparePackages(await readPlugin(root))
  progress.succeed(`Installed packages for ${name}`)
  const next = values.project
    ? `start claude in this repository and trust it, and Claude Code loads ${name}`
    : `run cmod link in ${relative(process.cwd(), root)}, then start claude`
  process.stdout.write(`\nNext: ${next}. cmod check runs every check.\n`)
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
    '.gitignore': 'node_modules/\ntarget/\n.claude-plugin/types/\n',
    '.oxlintrc.json': json({ ignorePatterns: ['.claude-plugin/types/**'] }),
    'hooks/hooks.json': json({ description: `${name} hooks module`, modules: ['./register.ts'] }),
    'hooks/register.ts': `import type { Register } from 'claude-code'
import { connect } from '../node_modules/cmod-sdk/connect.js'
import { ${definition} } from '../src/mod.js'

export const register: Register = (on) => {
  connect(on, ${definition})
}
`,
    'src/mod.tsx': `import { defineMod } from '../node_modules/cmod-sdk/mod.js'
import { slots } from '../node_modules/cmod-sdk/ui/slots.js'
import { PromptCount } from './components/prompt-count.js'
import { promptsPane } from './panes/prompts.js'
import { initialState } from './state.js'

export const ${definition} = defineMod({
  name: '${name}',
  state: initialState,

  setup(mod) {
    mod.ui.pane(promptsPane)
    mod.ui.render(slots.AbovePrompt, ({ hasSurvey, Default }) => (hasSurvey ? <Default /> : <PromptCount count={mod.state.session.prompts} />))

    mod.on('UserPromptSubmit', () => {
      mod.state.session.prompts += 1
      const prompts = mod.state.session.prompts === 1 ? '1 prompt' : \`\${mod.state.session.prompts} prompts\`
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: \`The ${name} mod is loaded. It has seen \${prompts} this session.\` } }
    })
  },
})
`,
    'src/state.ts': `export type ${state} = { session: { prompts: number } }

export const initialState: ${state} = { session: { prompts: 0 } }
`,
    'src/panes/prompts.tsx': `import { definePane } from '../../node_modules/cmod-sdk/ui/define-pane.js'
import { PromptCount } from '../components/prompt-count.js'
import type { ${state} } from '../state.js'

export const promptsPane = definePane<${state}>({
  id: '${name}',
  title: '${name}',
  render: (mod) => <PromptCount count={mod.state.session.prompts} />,
})
`,
    'src/components/prompt-count.tsx': `import type { RenderElement } from 'claude-code'
import { Text } from '../../node_modules/cmod-sdk/ui/elements.js'

export function PromptCount({ count }: { readonly count: number }): RenderElement {
  return <Text>{\`Prompts this session: \${count}\`}</Text>
}
`,
    'tests/mod.test.ts': `import { expect, test } from 'bun:test'
import { testMod } from '../node_modules/cmod-sdk/testing.js'
import { ${definition} } from '../src/mod.js'

test('each prompt adds the count to the context', async () => {
  const tested = testMod(${definition})
  const answer = await tested.fire('UserPromptSubmit', { prompt: 'hello' })
  expect(tested.state.session.prompts).toBe(1)
  expect(JSON.stringify(answer)).toContain('It has seen 1 prompt this session.')
})
`,
    [`skills/${name}/SKILL.md`]: `---
name: ${name}
description: Explains what the ${name} mod does. Use when the user asks about the ${name} mod.
---

The ${name} mod counts the prompts of this session and shows the count in its panel and above the prompt.
`,
    'package.json': json({ name, private: true, type: 'module', dependencies: { 'cmod-sdk': process.env['CMOD_SDK'] || `^${sdkVersion}` } }),
    'tsconfig.json': json({ extends: './.claude-plugin/types/tsconfig.json', compilerOptions: { jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment' }, include: ['hooks', 'src'] }),
  }
  if (!isProject) {
    files['.claude/CLAUDE.md'] = `# ${name}

- \`src/mod.tsx\` holds the mod's \`defineMod\`. \`hooks/register.ts\` only connects it to Claude Code.
- \`src/panes/\` holds one \`definePane\` per file.
- \`src/components/\` holds the components panes and slot renders draw with.
- \`cmod link\` loads this checkout in every new Claude Code session. \`cmod unlink\` stops it.
- \`cmod check\` runs every check. \`cmod publish --dry-run\` builds the release without pushing.
`
  }
  return files
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
