import { expect, test } from 'bun:test'
import { slashCommand } from '../src/jobs/slash-command.js'
import { defineMod } from '../src/mod.js'
import { option, userConfigOf } from '../src/options.js'
import { testMod } from '../src/testing.js'

const ciWatch = defineMod({
  name: 'ci-watch',
  options: {
    githubToken: option.secret({ title: 'GitHub token', description: 'Reads your CI runs' }),
    every: option.number({ title: 'Check every', description: 'Minutes between checks', default: 10, min: 1 }),
    branch: option.text({ title: 'Branch', description: 'The branch to watch', default: 'main' }),
    isVerbose: option.toggle({ title: 'Verbose', description: 'Logs each check' }),
    level: option.choice(['low', 'high'], { title: 'Level', description: 'How loud', default: 'low' }),
  },
  setup(mod) {
    mod.ui.toast(`watching ${mod.options.branch} every ${mod.options.every} minutes as ${mod.options.githubToken.slice(0, 4)}`)
  },
})

test('mod.options holds the values Claude Code passes, typed, with each default filled in', async () => {
  const tested = testMod(ciWatch, { options: { githubToken: 'ghp_secret' } })

  await tested.start()

  expect(tested.shown.toasts).toContain('watching main every 10 minutes as ghp_')
})

test("a project's options.json beats the person's own value, and a secret in it is refused", async () => {
  const tested = testMod(ciWatch, {
    options: { githubToken: 'ghp_secret', branch: 'develop' },
    files: { '/test/project/.claude/cmods/ci-watch/options.json': JSON.stringify({ branch: 'release', every: 0, githubToken: 'leaked' }) },
    projectRoot: '/test/project',
  })

  await tested.start()

  expect(tested.shown.toasts).toContain('watching release every 10 minutes as ghp_')
  expect(tested.shown.logs).toEqual([
    '/test/project/.claude/cmods/ci-watch/options.json sets every to 0, and Check every takes 1 or more.',
    '/test/project/.claude/cmods/ci-watch/options.json sets githubToken, a secret, and a project file is committed for everyone to read. Remove it, and set it in /config.',
  ])
})

test("after a /cd the new project's options.json applies at once", async () => {
  const branch = defineMod({
    name: 'ci-watch',
    options: { branch: option.text({ title: 'Branch', description: 'The branch to watch', default: 'main' }) },
    setup(mod) {
      mod.use(slashCommand({ name: 'branch', description: 'Names the watched branch', reply: () => `on ${mod.options.branch}` }))
    },
  })
  const tested = testMod(branch, { projectRoot: '/work/a', files: { '/work/b/.claude/cmods/ci-watch/options.json': JSON.stringify({ branch: 'release' }) } })
  expect(await tested.type('/branch')).toEqual({ text: 'on main' })

  await tested.moveTo('/work/b')

  expect(await tested.type('/branch')).toEqual({ text: 'on release' })
})

test('a value the organization locks in managed settings wins over the project file', async () => {
  const tested = testMod(ciWatch, {
    options: { githubToken: 'ghp_secret', branch: 'locked-main' },
    files: { '/test/project/.claude/cmods/ci-watch/options.json': JSON.stringify({ branch: 'release' }) },
    projectRoot: '/test/project',
  })
  tested.fakes.config.list = async () => [{ key: 'ci-watch.branch', label: 'Branch', kind: 'text', value: 'locked-main', provider: { plugin: 'ci-watch', tier: 'plugin' }, isLocked: true }] as never

  await tested.start()

  expect(tested.shown.toasts).toContain('watching locked-main every 10 minutes as ghp_')
})

test('a mod does not start while an option with no default has no value, and names it', async () => {
  const tested = testMod(ciWatch)

  await expect(tested.start()).rejects.toThrow('ci-watch needs GitHub token, which a person sets in /config. Give it to the tested mod: testMod(mod, { options: { githubToken: … } }).')})

test('defineMod refuses an option name Claude Code cannot pass on, and a choice default that is not a choice', () => {
  expect(() => defineMod({ name: 'bad', options: { 'my-key': option.text({ title: 'Key', description: '' }) }, setup() {} })).toThrow('bad: options.my-key is not an option name.')
  expect(() => defineMod({ name: 'bad', options: { level: option.choice(['a', 'b'], { title: 'Level', description: '', default: 'c' as 'a' }) }, setup() {} })).toThrow(
    'bad: options.level defaults to c, which is not one of its choices: a, b.',
  )
})

test('userConfigOf writes the options as Claude Code userConfig, never required, secrets sensitive', () => {
  expect(userConfigOf(ciWatch.options ?? {})).toEqual({
    githubToken: { type: 'string', title: 'GitHub token', description: 'Reads your CI runs', sensitive: true },
    every: { type: 'number', title: 'Check every', description: 'Minutes between checks', default: 10, min: 1 },
    branch: { type: 'string', title: 'Branch', description: 'The branch to watch', default: 'main' },
    isVerbose: { type: 'boolean', title: 'Verbose', description: 'Logs each check', default: false },
    level: { type: 'string', title: 'Level', description: 'How loud', options: ['low', 'high'], default: 'low' },
  })
})
