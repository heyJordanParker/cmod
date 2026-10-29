import { expect, test } from 'bun:test'
import { defineMod, fs, metadata } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'
import { fakeFiles } from '../../src/testing/fake-files.js'

const skill = (name: string, mode: string) => ['---', `name: ${name}`, 'description: A skill', 'metadata:', `  modes.mode: ${mode}`, '---', 'Do it.', ''].join('\n')

async function started(options: Parameters<typeof testMod>[1]) {
  const tested = testMod(defineMod({ name: 'modes', setup() {} }), options)
  await tested.start()
  return { tested }
}

test("find returns each matching file with its frontmatter name and this mod's bare keys", async () => {
  await started({
    projectRoot: '/work/app',
    files: {
      '/test/home/.claude/agents/reviewer.md': ['---', 'name: code-reviewer', 'metadata: { modes.mode: review, other.mode: x }', '---', ''].join('\n'),
      '/test/home/.claude/agents/plain.md': '---\nname: plain\n---\n',
      '/work/app/.claude/skills/commit/SKILL.md': skill('commit', 'build'),
    },
  })

  expect(await fs.find(['~/.claude/agents/**/*.md', '.claude/skills/*/SKILL.md'])).toEqual([
    { path: '/test/home/.claude/agents/plain.md', name: 'plain', metadata: {} },
    { path: '/test/home/.claude/agents/reviewer.md', name: 'code-reviewer', metadata: { mode: 'review' } },
    { path: '/work/app/.claude/skills/commit/SKILL.md', name: 'commit', metadata: { mode: 'build' } },
  ])
})

test('find descends through a linked folder and returns a linked file under the path the glob matched', async () => {
  await started({
    files: { '/test/home/.agents/agents/reviewer.md': skill('reviewer', 'review'), '/shared/notes.md': skill('notes', 'build') },
    links: { '/test/home/.claude/agents': '/test/home/.agents/agents', '/test/home/.claude/skills/notes.md': '/shared/notes.md' },
  })

  const found = await fs.find(['~/.claude/agents/*.md', '~/.claude/skills/*.md'])

  expect(found.map(({ path, metadata }) => [path, metadata['mode']])).toEqual([
    ['/test/home/.claude/agents/reviewer.md', 'review'],
    ['/test/home/.claude/skills/notes.md', 'build'],
  ])
})

test('update writes through a link to its target, keeps the link, and leaves the rest of the file as it was', async () => {
  const { tested } = await started({
    files: { '/test/home/.agents/agents/reviewer.md': skill('reviewer', 'review') },
    links: { '/test/home/.claude/agents': '/test/home/.agents/agents' },
  })

  await metadata.update('~/.claude/agents/reviewer.md', (metadata) => {
    metadata['mode'] = 'build review'
  })

  expect(await tested.fakes.fs.read?.('/test/home/.agents/agents/reviewer.md')).toBe(skill('reviewer', 'build review'))
  expect(await metadata.read('~/.claude/agents/reviewer.md')).toEqual({ mode: 'build review' })
})

test("update keeps other mods' keys, deletes a key the change removes, and writes nothing when nothing changed", async () => {
  const path = '/work/app/.claude/agents/a.md'
  const { tested } = await started({ projectRoot: '/work/app', files: { [path]: '---\nmetadata:\n  other.x: 1\n  modes.mode: build\n  modes.draft: yes\n---\n' } })

  await metadata.update(path, (metadata) => {
    delete metadata['draft']
  })
  const writes = tested.calls.filter((call) => call.call === 'fs.write').length
  await metadata.update(path, () => undefined)

  expect(await tested.fakes.fs.read?.(path)).toBe('---\nmetadata:\n  other.x: "1"\n  modes.mode: build\n---\n')
  expect(tested.calls.filter((call) => call.call === 'fs.write')).toHaveLength(writes)
})

test('a script keeps its metadata in a comment block, and a JSON file in a sidecar beside it', async () => {
  const { tested } = await started({ projectRoot: '/work/app', files: { '/work/app/lint.sh': '#!/bin/sh\necho lint\n', '/work/app/settings.json': '{}' } })

  await metadata.update('lint.sh', (metadata) => void (metadata['mode'] = 'build'))
  await metadata.update('settings.json', (metadata) => void (metadata['mode'] = 'review'))

  expect(await tested.fakes.fs.read?.('/work/app/lint.sh')).toBe('#!/bin/sh\n# /// metadata\n# modes.mode: build\n# ///\necho lint\n')
  expect(await tested.fakes.fs.read?.('/work/app/settings.json')).toBe('{}')
  expect(await tested.fakes.fs.read?.('/work/app/settings.json.meta')).toBe('metadata:\n  modes.mode: review\n')
  expect((await fs.find('*')).map(({ path, metadata }) => [path, metadata['mode']])).toEqual([
    ['/work/app/lint.sh', 'build'],
    ['/work/app/settings.json', 'review'],
  ])
})

test('a file cmod cannot read comes back with the line, read throws it, and cmod shows it once', async () => {
  const path = '/work/app/.claude/agents/broken.md'
  const { tested } = await started({ projectRoot: '/work/app', files: { [path]: '---\nmetadata:\n  modes.mode:\n    - build\n---\n' } })

  const [found] = await fs.find('.claude/agents/*.md')
  await fs.find('.claude/agents/*.md')

  expect(found).toEqual({ path, metadata: {}, error: `${path} line 4: a metadata value holds a list or a map. Each value is one line of text, and a list is one space-separated text.` })
  await expect(metadata.read(path)).rejects.toThrow(`modes: ${path} line 4:`)
  await tested.settle()
  expect(tested.shown.toasts.filter(({ description }) => description?.includes('line 4') === true)).toEqual([
    { type: 'error', message: `Skips the metadata of ${path}`, description: `${path} line 4: a metadata value holds a list or a map. Each value is one line of text, and a list is one space-separated text.` },
  ])
})

test('find keeps the files it can read and logs once, at debug level, each folder it could not list', async () => {
  const files = fakeFiles({ '/work/app/a/one.md': skill('one', 'build'), '/work/app/b/two.md': skill('two', 'review') })
  const { tested } = await started({ projectRoot: '/work/app' })
  Object.assign(tested.fakes.fs, files)
  tested.fakes.fs.list = async (path) => (path === '/work/app/b' ? Promise.reject(new Error("EACCES: permission denied, list '/work/app/b'")) : files.list(path))

  const found = await fs.find('**/*.md')
  await fs.find('**/*.md')

  expect(found.map(({ path }) => path)).toEqual(['/work/app/a/one.md'])
  expect(tested.shown.debug.filter((line) => line.includes('/work/app/b'))).toEqual(["modes: fs.find skipped /work/app/b: EACCES: permission denied, list '/work/app/b'"])
})

test('a file cmod cannot open comes back from find with its error, and read and update reject without writing', async () => {
  const path = '/work/app/a.md'
  const files = fakeFiles({ [path]: skill('a', 'build') })
  const { tested } = await started({ projectRoot: '/work/app' })
  Object.assign(tested.fakes.fs, files)
  tested.fakes.fs.read = async (read) => (read === path ? Promise.reject(new Error(`EACCES: permission denied, read '${path}'`)) : files.read(read))

  expect(await fs.find('*.md')).toEqual([{ path, metadata: {}, error: `${path} EACCES: permission denied, read '${path}'` }])
  await expect(metadata.read(path)).rejects.toThrow(`EACCES: permission denied, read '${path}'`)
  await expect(metadata.update(path, (metadata) => void (metadata['mode'] = 'review'))).rejects.toThrow(`EACCES: permission denied, read '${path}'`)
  expect(tested.calls.filter((call) => call.call === 'fs.write')).toEqual([])
})

test('update writes a file outside the project', async () => {
  const { tested } = await started({ files: { '/test/home/notes/a.md': 'Body\n' } })

  await metadata.update('~/notes/a.md', (metadata) => void (metadata['mode'] = 'build'))

  expect(await tested.fakes.fs.read?.('/test/home/notes/a.md')).toBe('---\nmetadata:\n  modes.mode: build\n---\nBody\n')
})

test('a value that is not one line of text is refused before anything is written', async () => {
  await started({ projectRoot: '/work/app', files: { '/work/app/a.md': 'Body\n' } })

  await expect(metadata.update('a.md', (metadata) => void (metadata['mode'] = ['build'] as never))).rejects.toThrow('modes: the metadata key "mode" holds ["build"]. Each value is text')
  await expect(metadata.update('a.md', (metadata) => void (metadata['bad key'] = 'x'))).rejects.toThrow('the metadata key "bad key" is not a name')
})
