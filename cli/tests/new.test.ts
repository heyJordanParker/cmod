import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { cp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { version as coreVersion } from '@cmodjs/core/package.json'
import { listFiles } from '../src/files.js'
import { capture } from '../src/process.js'
import { cmod, deleteTemporaryHomes, temporaryHome, writeFiles } from './cmod.js'

setDefaultTimeout(15_000)
afterEach(deleteTemporaryHomes)

test('new writes the repository layout with a defineMod that has one hook and one pane, and installs its packages', async () => {
  const home = await temporaryHome()
  const root = join(home, 'my-mod')

  const result = await cmod(home, 'new', 'my-mod')

  expect(result.exitCode).toBe(0)
  for (const path of ['.claude-plugin/plugin.json', '.claude/CLAUDE.md', '.gitignore', '.oxlintrc.json', 'hooks/hooks.json', 'hooks/register.ts', 'skills/my-mod/SKILL.md', 'src/mod.tsx', 'tests/mod.test.ts', 'package.json', 'tsconfig.json', 'bun.lock', 'node_modules/@cmodjs/core/package.json']) {
    expect(existsSync(join(root, path))).toBe(true)
  }
  expect(existsSync(join(root, '.gitattributes'))).toBe(false)
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n.claude-plugin/types/\n')
  expect(JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'))).toEqual({
    extends: './.claude-plugin/types/tsconfig.json',
    compilerOptions: { jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment' },
    include: ['hooks', 'src', 'tests', 'types', 'node_modules/bun-types/test.d.ts'],
  })
  const manifest = JSON.parse(await readFile(join(root, '.claude-plugin/plugin.json'), 'utf8'))
  expect(manifest).toEqual({ name: 'my-mod', version: '0.1.0', description: 'my-mod, a Claude Code mod', author: expect.objectContaining({ name: expect.any(String) }), dependencies: ['cmod'] })
  const mod = await readFile(join(root, 'src/mod.tsx'), 'utf8')
  expect(mod).toContain('export const myMod = defineMod({')
  expect(mod).toContain("mod.on('UserPromptSubmit'")
  expect(mod).not.toContain('mod.ui.toast')
  expect(mod).not.toContain('additionalContext')
  expect(await readFile(join(root, 'hooks/register.ts'), 'utf8')).toContain('registerMod(addHook, myMod)')
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
  expect(mod).toContain("import { Box } from '../node_modules/@cmodjs/core/ui/elements.js'")
  expect(mod).toContain('hasSurvey ? <Default /> : <Box flexDirection="column"><Default /><PromptCount count={mod.state.session.prompts} /></Box>)')
  const tests = await read('tests/mod.test.ts')
  expect(tests).toContain("test('the band shows the prompt count on its last line'")
  expect(tests).toContain("test('the band leaves the prompt count out during a survey'")
  expect(tests).not.toContain("'  hasSurvey: false',")
  expect(await read('skills/my-mod/SKILL.md')).toContain('shows the count in its pane and above the prompt.')
  expect(await read('hooks/register.ts')).toContain("import { myMod } from '../src/mod.js'")
  expect(await read('src/state.ts')).toBe('export type MyModState = { session: { prompts: number } }\n\nexport const initialState: MyModState = { session: { prompts: 0 } }\n')
  expect(await read('src/panes/prompts.tsx')).toContain('render: (mod) => <PromptCount count={mod.state.session.prompts} />,')
  expect(await read('src/components/prompt-count.tsx')).toContain('export function PromptCount({ count }: { readonly count: number }): RenderElement {')
  expect(existsSync(join(root, 'src/prompts-pane.tsx'))).toBe(false)
  const facts = await read('.claude/CLAUDE.md')
  expect(facts.split('\n').find((line) => line.startsWith('- '))).toBe('- `node_modules/@cmodjs/core/docs/` holds the docs of the installed `@cmodjs/core`. They match this version, and training data does not. Read the doc for the part you change, starting at `index.md`, before Claude Mod Manager (cmod) work.')
  expect(facts).toContain('- `tsc` reads `.claude-plugin/types/`, which Claude Code writes when it loads the mod. `cmod check` writes it when it is missing, so run `cmod check` before `tsc` in a fresh clone.\n')
  expect(facts).toContain("- `src/mod.tsx` holds the mod's `defineMod`.")
  expect(facts).toContain('- `src/panes/` holds one `definePane` per file.\n')
  expect(facts).toContain('- `src/components/` holds the components panes and slot renders draw with.\n')
})

test('a new mod runs its tests before Claude Code has loaded it', async () => {
  const home = await temporaryHome()
  const root = join(home, 'my-mod')
  await cmod(home, 'new', 'my-mod')

  const tests = Bun.spawn([process.execPath, 'test'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [output, exitCode] = await Promise.all([new Response(tests.stderr).text(), tests.exited])

  expect(existsSync(join(root, '.claude-plugin/types'))).toBe(false)
  expect(output).toContain(' 3 pass\n 0 fail\n')
  expect(exitCode).toBe(0)
})

test('a new mod runs its tests through bun run test', async () => {
  const home = await temporaryHome()
  const root = join(home, 'my-mod')
  await cmod(home, 'new', 'my-mod')

  const tests = Bun.spawn([process.execPath, 'run', 'test'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [output, exitCode] = await Promise.all([new Response(tests.stderr).text(), tests.exited])

  expect(output).toContain(' 3 pass\n 0 fail\n')
  expect(exitCode).toBe(0)
})

test("a new mod's tests pass the type check", async () => {
  const home = await temporaryHome()
  const root = join(home, 'my-mod')
  await cmod(home, 'new', 'my-mod')

  const result = await typeCheck(root)

  expect(result).toEqual({ output: '', exitCode: 0 })
})

test("a new mod's type check fails on a test that misuses expect", async () => {
  const home = await temporaryHome()
  const root = join(home, 'my-mod')
  await cmod(home, 'new', 'my-mod')
  await writeFiles(root, { 'tests/count.test.ts': "import { expect, test } from 'bun:test'\n\ntest('a count is a number', () => {\n  expect(1).toBe('one')\n})\n" })

  const result = await typeCheck(root)

  expect(result.output).toContain('tests/count.test.ts(4,18): error TS2769: No overload matches this call.')
  expect(result.output).toContain("Argument of type 'string' is not assignable to parameter of type 'number'.")
  expect(result.exitCode).toBe(1)
})

test('cmod new with CMOD_CORE set names its value when the install fails', async () => {
  const home = await temporaryHome()
  const main = join(import.meta.dir, '..', 'src', 'main.ts')
  const tarball = join(home, 'cmodjs-core-0.1.1.tgz')
  const created = Bun.spawn([process.execPath, main, 'new', 'my-mod'], {
    cwd: home,
    env: { ...process.env, HOME: home, CMOD_CORE: `file:${tarball}` },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stderr, exitCode] = await Promise.all([new Response(created.stderr).text(), created.exited])

  expect(exitCode).toBe(1)
  expect(existsSync(join(home, 'my-mod'))).toBe(false)
  expect(stderr).toContain(`CMOD_CORE is file:${tarball}, and bun could not install it. Point CMOD_CORE at a @cmodjs/core tarball, such as CMOD_CORE=file:<cmod checkout>/core/cmodjs-core-${coreVersion}.tgz, then run cmod new again.`)
  expect(stderr).not.toContain('set CMOD_CORE')
})

test("a new mod's survey test fails when the band's survey render throws", async () => {
  const home = await temporaryHome()
  const root = join(home, 'my-mod')
  await cmod(home, 'new', 'my-mod')
  const mod = join(root, 'src/mod.tsx')
  await Bun.write(mod, (await readFile(mod, 'utf8')).replace('hasSurvey ? <Default /> :', "hasSurvey ? (() => { throw new Error('the survey render broke') })() :"))

  const tests = Bun.spawn([process.execPath, 'test'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [output, exitCode] = await Promise.all([new Response(tests.stderr).text(), tests.exited])

  expect(output).toContain('(fail) the band leaves the prompt count out during a survey')
  expect(output).toContain(' 2 pass\n 1 fail\n')
  expect(exitCode).toBe(1)
})

test("the README's 30-second mod is the template", async () => {
  const home = await temporaryHome()
  const source = join(home, 'my-mod/src')
  await cmod(home, 'new', 'my-mod')
  const readme = await readFile(join(import.meta.dir, '..', '..', 'README.md'), 'utf8')
  const start = readme.indexOf('## Make a mod in 30 seconds')
  const section = readme.slice(start, readme.indexOf('\n## ', start))
  const template = await Promise.all((await listFiles(source)).map((path) => readFile(join(source, path), 'utf8')))

  const blocks = [...section.matchAll(/```tsx?\n([\s\S]*?)```/g)].map((match) => match[1] as string)

  expect(blocks).not.toEqual([])
  for (const block of blocks) expect({ block, isInTemplate: template.some((file) => file.includes(block)) }).toEqual({ block, isInTemplate: true })
})

test('new --project writes the plugin into .claude/skills/<name>/ of the repository in the current folder', async () => {
  const home = await temporaryHome()
  await Bun.spawn(['git', 'init', '-q', home]).exited

  const result = await cmod(home, 'new', '--project', 'rules')

  expect(result.exitCode).toBe(0)
  const root = join(home, '.claude/skills/rules')
  for (const path of ['.claude-plugin/plugin.json', '.gitignore', 'hooks/register.ts', 'src/mod.tsx', 'package.json', 'node_modules/@cmodjs/core/package.json']) {
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

async function typeCheck(root: string): Promise<{ output: string; exitCode: number }> {
  const checkout = join(import.meta.dir, '..', '..')
  const types = join(checkout, '.claude-plugin', 'types')
  if (!existsSync(types)) throw new Error(`${types} is missing. Claude Code writes it when it first loads the checkout: run claude --plugin-dir . -p ok in ${checkout}, then run the tests again.`)
  await cp(types, join(root, '.claude-plugin', 'types'), { recursive: true })
  const { stdout, exitCode } = await capture([process.execPath, join(import.meta.dir, '..', 'node_modules', '.bin', 'tsc'), '--noEmit'], { cwd: root })
  return { output: stdout, exitCode }
}
