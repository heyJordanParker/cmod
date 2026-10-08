import { expect, test } from 'bun:test'
import { defineMod, type Mod } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'

const skill = (name: string, mode: string) => ['---', `name: ${name}`, 'description: A skill', 'metadata:', `  modes.mode: ${mode}`, '---', 'Do it.', ''].join('\n')

async function started(options: Parameters<typeof testMod>[1]) {
  let mod: Mod | undefined
  const tested = testMod(defineMod({ name: 'modes', setup: (started) => void (mod = started) }), options)
  await tested.start()
  return { tested, mod: mod as Mod }
}

test("find returns each matching file with its frontmatter name and this mod's bare keys", async () => {
  const { mod } = await started({
    projectRoot: '/work/app',
    files: {
      '/test/home/.claude/agents/reviewer.md': ['---', 'name: code-reviewer', 'metadata: { modes.mode: review, other.mode: x }', '---', ''].join('\n'),
      '/test/home/.claude/agents/plain.md': '---\nname: plain\n---\n',
      '/work/app/.claude/skills/commit/SKILL.md': skill('commit', 'build'),
    },
  })

  expect(await mod.fs.find(['~/.claude/agents/**/*.md', '.claude/skills/*/SKILL.md'])).toEqual([
    { path: '/test/home/.claude/agents/plain.md', name: 'plain', metadata: {} },
    { path: '/test/home/.claude/agents/reviewer.md', name: 'code-reviewer', metadata: { mode: 'review' } },
    { path: '/work/app/.claude/skills/commit/SKILL.md', name: 'commit', metadata: { mode: 'build' } },
  ])
})

test('find descends through a linked folder and returns a linked file under the path the glob matched', async () => {
  const { mod } = await started({
    files: { '/test/home/.agents/agents/reviewer.md': skill('reviewer', 'review'), '/shared/notes.md': skill('notes', 'build') },
    links: { '/test/home/.claude/agents': '/test/home/.agents/agents', '/test/home/.claude/skills/notes.md': '/shared/notes.md' },
  })

  const found = await mod.fs.find(['~/.claude/agents/*.md', '~/.claude/skills/*.md'])

  expect(found.map(({ path, metadata }) => [path, metadata['mode']])).toEqual([
    ['/test/home/.claude/agents/reviewer.md', 'review'],
    ['/test/home/.claude/skills/notes.md', 'build'],
  ])
})

test('update writes through a link to its target, keeps the link, and leaves the rest of the file as it was', async () => {
  const { tested, mod } = await started({
    files: { '/test/home/.agents/agents/reviewer.md': skill('reviewer', 'review') },
    links: { '/test/home/.claude/agents': '/test/home/.agents/agents' },
    permissions: ['files:~/.claude/agents'],
  })

  await mod.metadata.update('~/.claude/agents/reviewer.md', (metadata) => {
    metadata['mode'] = 'build review'
  })

  expect(await tested.fakes.fs.read?.('/test/home/.agents/agents/reviewer.md')).toBe(skill('reviewer', 'build review'))
  expect(await mod.metadata.read('~/.claude/agents/reviewer.md')).toEqual({ mode: 'build review' })
})

test("update keeps other mods' keys, deletes a key the change removes, and writes nothing when nothing changed", async () => {
  const path = '/work/app/.claude/agents/a.md'
  const { tested, mod } = await started({ projectRoot: '/work/app', files: { [path]: '---\nmetadata:\n  other.x: 1\n  modes.mode: build\n  modes.draft: yes\n---\n' } })

  await mod.metadata.update(path, (metadata) => {
    delete metadata['draft']
  })
  const writes = tested.calls.filter((call) => call.call === 'fs.write').length
  await mod.metadata.update(path, () => undefined)

  expect(await tested.fakes.fs.read?.(path)).toBe('---\nmetadata:\n  other.x: "1"\n  modes.mode: build\n---\n')
  expect(tested.calls.filter((call) => call.call === 'fs.write')).toHaveLength(writes)
})

test('a script keeps its metadata in a comment block, and a JSON file in a sidecar beside it', async () => {
  const { tested, mod } = await started({ projectRoot: '/work/app', files: { '/work/app/lint.sh': '#!/bin/sh\necho lint\n', '/work/app/settings.json': '{}' } })

  await mod.metadata.update('lint.sh', (metadata) => void (metadata['mode'] = 'build'))
  await mod.metadata.update('settings.json', (metadata) => void (metadata['mode'] = 'review'))

  expect(await tested.fakes.fs.read?.('/work/app/lint.sh')).toBe('#!/bin/sh\n# /// metadata\n# modes.mode: build\n# ///\necho lint\n')
  expect(await tested.fakes.fs.read?.('/work/app/settings.json')).toBe('{}')
  expect(await tested.fakes.fs.read?.('/work/app/settings.json.meta')).toBe('metadata:\n  modes.mode: review\n')
  expect((await mod.fs.find('*')).map(({ path, metadata }) => [path, metadata['mode']])).toEqual([
    ['/work/app/lint.sh', 'build'],
    ['/work/app/settings.json', 'review'],
  ])
})

test('a file cmod cannot read comes back with the line, read throws it, and cmod logs it once', async () => {
  const path = '/work/app/.claude/agents/broken.md'
  const { tested, mod } = await started({ projectRoot: '/work/app', files: { [path]: '---\nmetadata:\n  modes.mode:\n    - build\n---\n' } })

  const [found] = await mod.fs.find('.claude/agents/*.md')
  await mod.fs.find('.claude/agents/*.md')

  expect(found).toEqual({ path, metadata: {}, error: `${path} line 4: a metadata value holds a list or a map. Each value is one line of text, and a list is one space-separated text.` })
  await expect(mod.metadata.read(path)).rejects.toThrow(`modes: ${path} line 4:`)
  expect(tested.shown.logs.filter((line) => line.includes('line 4'))).toHaveLength(1)
})

test('update outside the project needs the files permission that covers the path', async () => {
  const { mod } = await started({ files: { '/test/home/notes/a.md': 'Body\n' }, permissions: [] })

  await expect(mod.metadata.update('~/notes/a.md', (metadata) => void (metadata['mode'] = 'build'))).rejects.toThrow('"permissions": { "files": ["~/notes/a.md"] }')
})

test('a value that is not one line of text is refused before anything is written', async () => {
  const { mod } = await started({ projectRoot: '/work/app', files: { '/work/app/a.md': 'Body\n' } })

  await expect(mod.metadata.update('a.md', (metadata) => void (metadata['mode'] = ['build'] as never))).rejects.toThrow('modes: the metadata key "mode" holds ["build"]. Each value is text')
  await expect(mod.metadata.update('a.md', (metadata) => void (metadata['bad key'] = 'x'))).rejects.toThrow('the metadata key "bad key" is not a name')
})
