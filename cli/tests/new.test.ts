import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cmod, deleteTemporaryHomes, temporaryHome } from './cmod.js'

afterEach(deleteTemporaryHomes)

test('new writes the repository layout with a defineMod that has one hook and one panel, and installs its packages', async () => {
  const home = await temporaryHome()
  const root = join(home, 'my-mod')

  const result = await cmod(home, 'new', 'my-mod')

  expect(result.exitCode).toBe(0)
  for (const path of ['.claude-plugin/plugin.json', '.claude/CLAUDE.md', '.gitignore', '.oxlintrc.json', 'hooks/hooks.json', 'hooks/register.ts', 'skills/my-mod/SKILL.md', 'src/mod.tsx', 'tests/mod.test.ts', 'package.json', 'tsconfig.json', 'bun.lock', 'node_modules/cmod-sdk/package.json']) {
    expect(existsSync(join(root, path))).toBe(true)
  }
  expect(existsSync(join(root, '.gitattributes'))).toBe(false)
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n.claude-plugin/types/\n')
  expect(JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'))).toEqual({ extends: './.claude-plugin/types/tsconfig.json', include: ['hooks', 'src', 'types'] })
  const manifest = JSON.parse(await readFile(join(root, '.claude-plugin/plugin.json'), 'utf8'))
  expect(manifest).toEqual({ name: 'my-mod', version: '0.1.0', description: 'my-mod, a Claude Code mod', author: expect.objectContaining({ name: expect.any(String) }), dependencies: ['cmod'] })
  const mod = await readFile(join(root, 'src/mod.tsx'), 'utf8')
  expect(mod).toContain('export const myMod = defineMod({')
  expect(mod).toContain("mod.on('UserPromptSubmit'")
  expect(mod).not.toContain('mod.ui.toast')
  expect(await readFile(join(root, 'hooks/register.ts'), 'utf8')).toContain('connect(on, myMod)')
})

test('cmod new writes mod.tsx, state.ts, a pane and a component', async () => {
  const home = await temporaryHome()
  const root = join(home, 'my-mod')
  const read = (path: string) => readFile(join(root, path), 'utf8')

  await cmod(home, 'new', 'my-mod')

  expect(existsSync(join(root, 'src/mod.ts'))).toBe(false)
  const mod = await read('src/mod.tsx')
  expect(mod).toContain("import { initialState } from './state.js'")
  expect(mod).toContain("import { promptsPane } from './panes/prompts.js'")
  expect(mod).toContain("import { PromptCount } from './components/prompt-count.js'")
  expect(mod).toContain('mod.ui.pane(promptsPane)')
  expect(mod).toContain('mod.ui.render(slots.AbovePrompt, ({ hasSurvey, Default }) => (hasSurvey ? <Default /> : <PromptCount count={mod.state.session.prompts} />))')
  expect(await read('hooks/register.ts')).toContain("import { myMod } from '../src/mod.js'")
  expect(await read('src/state.ts')).toBe('export type MyModState = { session: { prompts: number } }\n\nexport const initialState: MyModState = { session: { prompts: 0 } }\n')
  expect(await read('src/panes/prompts.tsx')).toContain('render: (mod) => <PromptCount count={mod.state.session.prompts} />,')
  expect(await read('src/components/prompt-count.tsx')).toContain('export function PromptCount({ count }: { readonly count: number }): RenderElement {')
  expect(existsSync(join(root, 'src/prompts-pane.tsx'))).toBe(false)
  const facts = await read('.claude/CLAUDE.md')
  expect(facts).toContain("- `src/mod.tsx` holds the mod's `defineMod`.")
  expect(facts).toContain('- `src/panes/` holds one `definePane` per file.\n')
  expect(facts).toContain('- `src/components/` holds the components panes and slot renders draw with.\n')
})

test('new --project writes the plugin into .claude/skills/<name>/ of the repository in the current folder', async () => {
  const home = await temporaryHome()
  await Bun.spawn(['git', 'init', '-q', home]).exited

  const result = await cmod(home, 'new', '--project', 'rules')

  expect(result.exitCode).toBe(0)
  const root = join(home, '.claude/skills/rules')
  for (const path of ['.claude-plugin/plugin.json', '.gitignore', 'hooks/register.ts', 'src/mod.tsx', 'package.json', 'node_modules/cmod-sdk/package.json']) {
    expect(existsSync(join(root, path))).toBe(true)
  }
  expect(existsSync(join(root, '.gitattributes'))).toBe(false)
  expect(existsSync(join(root, '.claude/CLAUDE.md'))).toBe(false)
})

test('new --project refuses a folder that is not a repository root', async () => {
  const home = await temporaryHome()

  const result = await cmod(home, 'new', '--project', 'rules')

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe('cmod new: cmod new --project runs in the root of the repository that uses the plugin, and this folder has no .git.\n')
})
