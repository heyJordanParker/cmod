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
  for (const path of ['.claude-plugin/plugin.json', '.claude/CLAUDE.md', '.gitignore', '.oxlintrc.json', 'hooks/hooks.json', 'hooks/register.ts', 'skills/my-mod/SKILL.md', 'src/mod.ts', 'src/prompts-pane.tsx', 'tests/mod.test.ts', 'package.json', 'tsconfig.json', 'bun.lock', 'node_modules/cmod-sdk/package.json']) {
    expect(existsSync(join(root, path))).toBe(true)
  }
  expect(existsSync(join(root, '.gitattributes'))).toBe(false)
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\ntarget/\n.claude-plugin/types/\n')
  const manifest = JSON.parse(await readFile(join(root, '.claude-plugin/plugin.json'), 'utf8'))
  expect(manifest).toEqual({ name: 'my-mod', version: '0.1.0', description: 'my-mod, a Claude Code mod', author: expect.objectContaining({ name: expect.any(String) }), dependencies: ['cmod'] })
  const mod = await readFile(join(root, 'src/mod.ts'), 'utf8')
  expect(mod).toContain('export const myMod = defineMod({')
  expect(mod).toContain("mod.on('UserPromptSubmit'")
  expect(mod).toContain('mod.ui.pane(promptsPane)')
  expect(mod).not.toContain('mod.ui.toast')
  expect(await readFile(join(root, 'hooks/register.ts'), 'utf8')).toContain('connect(on, myMod)')
})

test('new --project writes the plugin into .claude/skills/<name>/ of the repository in the current folder', async () => {
  const home = await temporaryHome()
  await Bun.spawn(['git', 'init', '-q', home]).exited

  const result = await cmod(home, 'new', '--project', 'rules')

  expect(result.exitCode).toBe(0)
  const root = join(home, '.claude/skills/rules')
  for (const path of ['.claude-plugin/plugin.json', '.gitignore', 'hooks/register.ts', 'src/mod.ts', 'package.json', 'node_modules/cmod-sdk/package.json']) {
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
