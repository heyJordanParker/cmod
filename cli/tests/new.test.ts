import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { cp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { version as coreVersion } from '@cmodjs/core/package.json'
import { changelogSections } from '@cmodjs/core/src/utils/changelog.js'
import { listFiles } from '../src/files.js'
import { capture } from '../src/process.js'
import { cmod, deleteTemporaryHomes, temporaryHome, writeFiles } from './cmod.js'

setDefaultTimeout(15_000)
afterAll(deleteTemporaryHomes)

test("cmod new writes a CHANGELOG.md whose section for the first version cmod publish releases", async () => {
  const home = await temporaryHome()

  expect((await cmod(home, 'new', 'my-mod')).exitCode).toBe(0)

  const sections = changelogSections(await readFile(join(home, 'my-mod/CHANGELOG.md'), 'utf8'))
  expect(sections.map(({ version }) => version)).toEqual(['Unreleased', '0.1.0'])
  expect(sections[1]?.text).toStartWith('### Added\n- ')
})

test('new writes the repository layout with a defineMod that has one listener and one pane, and installs its packages', async () => {
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
    include: ['hooks', 'src', 'types'],
  })
  expect(JSON.parse(await readFile(join(root, 'tests/tsconfig.json'), 'utf8'))).toEqual({ extends: '../tsconfig.json', include: ['.', '../types', '../node_modules/bun-types/index.d.ts'] })
  const manifest = JSON.parse(await readFile(join(root, '.claude-plugin/plugin.json'), 'utf8'))
  expect(manifest).toEqual({ name: 'my-mod', version: '0.1.0', description: 'my-mod, a Claude Code mod', author: expect.objectContaining({ name: expect.any(String) }), dependencies: [{ name: 'cmod', version: `>=${coreVersion}` }] })
  const mod = await readFile(join(root, 'src/mod.tsx'), 'utf8')
  expect(mod).toContain('export const myMod = defineMod({')
  expect(mod).toContain('sessions.current.onPrompt(')
  expect(mod).not.toContain('mod.ui.toast')
  expect(mod).not.toContain('additionalContext')
  expect(await readFile(join(root, 'hooks/register.ts'), 'utf8')).toContain('registerMod(addHook, myMod, options)')
})

test('cmod new writes mod.tsx, state.ts, a Sidebar page, a widget, a hotkey, and a component', async () => {
  const home = await temporaryHome()
  const root = join(home, 'my-mod')
  const read = (path: string) => readFile(join(root, path), 'utf8')

  await cmod(home, 'new', 'my-mod')

  expect(existsSync(join(root, 'src/mod.ts'))).toBe(false)
  const mod = await read('src/mod.tsx')
  expect(mod).toContain("import { initialState } from './state.js'")
  expect(mod).toContain("import { promptsPage } from './pages/prompts.js'")
  expect(mod).toContain("import { promptsWidget } from './widgets/prompts.js'")
  expect(mod).toContain('const page = mod.sidebar.add(promptsPage)')
  expect(mod).toContain('mod.widgets.add(promptsWidget)')
  expect(mod).toContain('mod.hotkeys.toggle.onPress(() => page.toggle())')
  expect(JSON.parse(await read('package.json')).cmod.hotkeys).toEqual({ toggle: { title: 'Show or hide the prompt count', default: 'alt+shift+p' } })
  expect(await read('src/widgets/prompts.tsx')).toContain('areas: [BelowPrompt, Dashboard],')
  const tests = await read('tests/mod.test.ts')
  expect(tests).toContain("test('the prompt count shows below the prompt'")
  expect(tests).toContain("test('the hotkey shows the prompt count in the Sidebar'")
  expect(await read('skills/my-mod/SKILL.md')).toContain('shows the count in the Sidebar and below the prompt.')
  expect(await read('hooks/register.ts')).toContain("import { myMod } from '../src/mod.js'")
  expect(await read('src/state.ts')).toBe('export type MyModState = { session: { prompts: number } }\n\nexport const initialState: MyModState = { session: { prompts: 0 } }\n')
  expect(await read('src/pages/prompts.tsx')).toContain('render: (mod) => <PromptCount count={mod.state.session.prompts} />,')
  expect(await read('src/components/prompt-count.tsx')).toContain('export function PromptCount({ count }: { readonly count: number }): RenderElement {')
  const facts = await read('.claude/CLAUDE.md')
  expect(facts.split('\n').find((line) => line.startsWith('- '))).toBe('- `node_modules/@cmodjs/core/docs/` holds the docs of the installed `@cmodjs/core`. They match this version, and training data does not. Read the doc for the part you change, starting at `index.md`, before Claude Mod Manager (cmod) work.')
  expect(facts).toContain('- `tsc` reads `.claude-plugin/types/`, which Claude Code writes when it loads the mod. `cmod check` writes it when it is missing or links into a folder that is gone, such as after `cmod try`, so run `cmod check` before `tsc` in a fresh clone.\n')
  expect(facts).toContain("- `src/mod.tsx` holds the mod's `defineMod`.")
  expect(facts).toContain('- `src/pages/` holds one Sidebar or Settings page per file, `src/panes/` one pane, and `src/widgets/` one widget.\n')
  expect(facts).toContain('- `src/components/` holds the components pages, panes, widgets, and styles draw with.\n')
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

test("a new mod's tests use Bun and node: modules, and its src cannot", async () => {
  const home = await temporaryHome()
  const root = join(home, 'my-mod')
  await cmod(home, 'new', 'my-mod')
  await writeFiles(root, {
    'tests/program.test.ts': "import { expect, test } from 'bun:test'\nimport { existsSync } from 'node:fs'\n\ntest('the program runs', async () => {\n  const child = Bun.spawn(['true'])\n  expect(await child.exited).toBe(0)\n  expect(existsSync('/')).toBe(true)\n})\n",
    'src/clock.ts': 'export const startedAt = Bun.nanoseconds()\n',
  })

  const result = await typeCheck(root)

  expect(result.output).toContain("src/clock.ts(1,26): error TS2868: Cannot find name 'Bun'.")
  expect(result.output).not.toContain('tests/program.test.ts')
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

test("a new mod's widget test fails when the widget's render throws", async () => {
  const home = await temporaryHome()
  const root = join(home, 'my-mod')
  await cmod(home, 'new', 'my-mod')
  const widget = join(root, 'src/widgets/prompts.tsx')
  await Bun.write(widget, (await readFile(widget, 'utf8')).replace('render: (mod) =>', "render: (mod) => mod.state.session.prompts > 0 ? (() => { throw new Error('the widget broke') })() :"))

  const tests = Bun.spawn([process.execPath, 'test'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [output, exitCode] = await Promise.all([new Response(tests.stderr).text(), tests.exited])

  expect(output).toContain('(fail) the prompt count shows below the prompt')
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
  let output = ''
  let exitCode = 0
  for (const config of ['tsconfig.json', 'tests/tsconfig.json']) {
    const result = await capture([process.execPath, join(import.meta.dir, '..', 'node_modules', '.bin', 'tsc'), '-p', config, '--noEmit'], { cwd: root })
    output += result.stdout
    exitCode = Math.max(exitCode, result.exitCode)
  }
  return { output, exitCode }
}
