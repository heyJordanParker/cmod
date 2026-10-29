import { afterAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cmod, deleteTemporaryHomes, temporaryHome, writeFiles, writeLinked } from './cmod.js'
import { excludeRules } from '../src/settings.js'

afterAll(deleteTemporaryHomes)

const record = (root: string) => JSON.stringify({ name: 'house-style', version: '1.0.0', root, installedAt: '2026-10-14T10:00:00.000Z', scriptsSha256: '', uninstall: null, program: null, keys: {} })

async function modWithRules(home: string, enabled: Record<string, boolean>) {
  const root = join(home, 'mods/house-style')
  await writeFiles(home, {
    'mods/house-style/.claude-plugin/plugin.json': JSON.stringify({ name: 'house-style', version: '1.0.0' }),
    'mods/house-style/rules/tests.md': 'Write a test before each fix.\n',
    'mods/house-style/rules/sql.md': '---\npaths:\n  - "**/*.sql"\n---\nQuote every identifier.\n',
    '.local/share/cmod/records/house-style.json': record(root),
    '.claude/settings.json': JSON.stringify({ enabledPlugins: enabled }),
  })
  return root
}

test("cmod rules links a mod's rules into Claude Code's rules folder and prints them", async () => {
  const home = await temporaryHome()
  const root = await modWithRules(home, { 'house-style@market': true })

  const result = await cmod(home, 'rules', '--json')

  expect(result.exitCode).toBe(0)
  expect(await readlink(join(home, '.claude/rules/house-style'))).toBe(join(root, 'rules'))
  expect(JSON.parse(result.stdout).watched).toEqual(
    expect.arrayContaining([join(home, '.claude/settings.json'), join(home, '.local/share/cmod/records/house-style.json'), join(root, 'rules'), join(root, 'rules/tests.md'), join(root, 'rules/sql.md')]),
  )
  expect({ ...JSON.parse(result.stdout), watched: undefined }).toEqual({
    watched: undefined,
    linked: [
      {
        mod: 'house-style',
        folder: join(home, '.claude/rules/house-style'),
        rules: [
          { name: 'sql', isGlobal: false, text: 'Quote every identifier.' },
          { name: 'tests', isGlobal: true, text: 'Write a test before each fix.' },
        ],
      },
    ],
    placed: ['house-style'],
    removed: [],
  })
  expect(JSON.parse((await cmod(home, 'rules', '--json')).stdout)).toMatchObject({ placed: [], removed: [] })
})

test("a mod whose installed folder is gone leaves every other mod's rules linked", async () => {
  const home = await temporaryHome()
  const root = await modWithRules(home, { 'house-style@market': true })
  await writeFiles(home, { '.local/share/cmod/records/gone.json': record(join(home, 'deleted-folder')).replace('"house-style"', '"gone"') })
  await writeLinked(home, root)

  const result = await cmod(home, 'rules')

  expect(result.exitCode).toBe(0)
  expect(await readlink(join(home, '.claude/rules/house-style'))).toBe(join(root, 'rules'))
})

test("a mod that is off has no rules linked, and the link goes when it turns off", async () => {
  const home = await temporaryHome()
  await modWithRules(home, { 'house-style@market': true })
  await cmod(home, 'rules')

  await writeFiles(home, { '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'house-style@market': false } }) })

  expect(JSON.parse((await cmod(home, 'rules', '--json')).stdout)).toMatchObject({ linked: [], placed: [], removed: ['house-style'] })
  expect(existsSync(join(home, '.claude/rules/house-style'))).toBe(false)
})

test.each([
  ['a folder', 'notes/house-style'],
  ['nothing', 'personal/house-style/rules'],
])("cmod leaves a person's own rules link to %s under a mod's name, and says so", async (_, target) => {
  const home = await temporaryHome()
  await modWithRules(home, { 'house-style@market': true })
  await writeFiles(home, { 'notes/house-style/tabs.md': 'Indent with tabs.\n' })
  await mkdir(join(home, '.claude/rules'), { recursive: true })
  await symlink(join(home, target), join(home, '.claude/rules/house-style'))

  const placing = await cmod(home, 'rules')

  expect(placing.exitCode).toBe(1)
  expect(placing.stderr).toContain(`${join(home, '.claude/rules/house-style')} links to ${join(home, target)}, which cmod did not link, so cmod leaves it. Move it away, then run the command again.`)
  expect(await readlink(join(home, '.claude/rules/house-style'))).toBe(join(home, target))
})

test("a removed mod's rules leave every project, even one cmod never ran in since", async () => {
  const home = await temporaryHome()
  await modWithRules(home, {})
  const project = join(home, 'work/app')
  await writeFiles(home, { 'work/app/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'house-style@market': true } }) })
  await cmod(home, 'rules', '--project', project)
  await rm(join(home, '.local/share/cmod/records/house-style.json'))

  expect(JSON.parse((await cmod(home, 'rules', '--json')).stdout)).toMatchObject({ linked: [], placed: [], removed: ['house-style'] })
  expect(existsSync(join(project, '.claude/rules/house-style'))).toBe(false)
})

test('a mod on for the user but off for one project keeps its rules out of that project, and back in once it is on again', async () => {
  const home = await temporaryHome()
  await modWithRules(home, { 'house-style@market': true })
  const project = join(home, 'work/app')
  const local = join(project, '.claude/settings.local.json')
  await writeFiles(home, { 'work/app/.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'house-style@market': false } }) })

  expect(JSON.parse((await cmod(home, 'rules', '--project', project, '--json')).stdout)).toMatchObject({ linked: [], placed: ['house-style'] })
  expect(JSON.parse(await readFile(local, 'utf8'))).toEqual({ enabledPlugins: { 'house-style@market': false }, claudeMdExcludes: [`${join(home, '.claude/rules/house-style')}/**`] })

  await writeFiles(home, { 'work/app/.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'house-style@market': true }, claudeMdExcludes: [`${join(home, '.claude/rules/house-style')}/**`] }) })

  expect(JSON.parse((await cmod(home, 'rules', '--project', project, '--json')).stdout)).toMatchObject({ linked: [{ mod: 'house-style' }] })
  expect(JSON.parse(await readFile(local, 'utf8'))).toEqual({ enabledPlugins: { 'house-style@market': true } })
})

test("cmod leaves an exclusion the person wrote, after the mod is back on in the project", async () => {
  const home = await temporaryHome()
  await modWithRules(home, { 'house-style@market': true })
  const project = join(home, 'work/app')
  const local = join(project, '.claude/settings.local.json')
  const own = `${join(home, '.claude/rules/house-style')}/**`
  await writeFiles(home, { 'work/app/.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'house-style@market': false }, claudeMdExcludes: [own] }) })
  await cmod(home, 'rules', '--project', project)

  await writeFiles(home, { 'work/app/.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'house-style@market': true }, claudeMdExcludes: [own] }) })
  await cmod(home, 'rules', '--project', project)

  expect(JSON.parse(await readFile(local, 'utf8'))).toEqual({ enabledPlugins: { 'house-style@market': true }, claudeMdExcludes: [own] })
})

test('a rules exclusion waits for a settings change in progress and keeps it', async () => {
  const home = await temporaryHome()
  const local = join(home, 'work/app/.claude/settings.local.json')
  await writeFiles(home, { 'work/app/.claude/settings.local.json': '{}\n' })
  const before = process.env['HOME']
  process.env['HOME'] = home
  try {
    const holder = Bun.spawn(['bun', '-e', `const { storePath, takeLock } = await import(${JSON.stringify(join(import.meta.dir, '../src/store.ts'))}); await takeLock(storePath('settings.lock')); console.log('held'); await Bun.sleep(60000)`], { env: { ...process.env, HOME: home }, stdout: 'pipe' })
    await holder.stdout.getReader().read()
    const excluded = excludeRules(local, '/rules/house-style/**')
    await Bun.sleep(300)
    await writeFile(local, JSON.stringify({ model: 'haiku' }))
    holder.kill()
    await holder.exited

    expect(await excluded).toBe(true)
    expect(JSON.parse(await readFile(local, 'utf8'))).toEqual({ model: 'haiku', claudeMdExcludes: ['/rules/house-style/**'] })
  } finally {
    process.env['HOME'] = before
  }
})

test('a rule the person excluded with claudeMdExcludes never reaches the conversation as a note', async () => {
  const home = await temporaryHome()
  await modWithRules(home, { 'house-style@market': true })
  await writeFiles(home, { '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'house-style@market': true }, claudeMdExcludes: [`${join(home, '.claude/rules/house-style')}/tests.md`] }) })

  const result = JSON.parse((await cmod(home, 'rules', '--json')).stdout) as { linked: { rules: { name: string }[] }[] }

  expect(result.linked.flatMap((each) => each.rules.map((rule) => rule.name))).toEqual(['sql'])
})

test('a mod turned on for one project links its rules into that project', async () => {
  const home = await temporaryHome()
  const root = await modWithRules(home, {})
  const project = join(home, 'work/app')
  await writeFiles(home, { 'work/app/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'house-style@market': true } }) })

  await cmod(home, 'rules', '--project', project)

  expect(await readlink(join(project, '.claude/rules/house-style'))).toBe(join(root, 'rules'))
  expect(existsSync(join(home, '.claude/rules/house-style'))).toBe(false)
})
