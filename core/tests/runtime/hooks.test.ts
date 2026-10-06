import { expect, test } from 'bun:test'
import { defineMod } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'

function fileWatcher(cwd = '/work', files: string[] = []) {
  const seen: { event: string; files: unknown }[] = []
  const tested = testMod(
    defineMod({
      name: 'file-watcher',
      setup(mod) {
        mod.on('PreToolUse', (input) => void seen.push({ event: 'PreToolUse', files: input.files }))
        mod.on('PostToolUse', (input) => void seen.push({ event: 'PostToolUse', files: input.files }))
        mod.on('PostToolUseFailure', (input) => void seen.push({ event: 'PostToolUseFailure', files: input.files }))
      },
    }),
    { cwd, files: Object.fromEntries(files.map((path) => [path, ''])) },
  )
  return { tested, seen }
}

function call(tool_name: string, tool_input: Record<string, unknown>) {
  return { tool_name, tool_input, tool_use_id: 'toolu_1' }
}

function toolCall({ tool_name, tool_input, tool_use_id }: ReturnType<typeof call>) {
  return { ...tool_input, tool: tool_name, tool_use_id } as never
}

test("an Edit's file is in files.changed", async () => {
  const { tested, seen } = fileWatcher()
  const edit = call('Edit', { file_path: '/work/src/app.ts', old_string: 'a', new_string: 'b' })

  await tested.fire('PreToolUse', edit)
  await tested.fire('PostToolUse', { ...edit, tool_response: {} })
  await tested.fire('PostToolUseFailure', { ...edit, error: 'old_string was not found' })

  const files = { read: [], changed: ['/work/src/app.ts'] }
  expect(seen).toEqual([
    { event: 'PreToolUse', files },
    { event: 'PostToolUse', files },
    { event: 'PostToolUseFailure', files },
  ])
})

test("a NotebookEdit's notebook is in files.changed", async () => {
  const { tested, seen } = fileWatcher()

  await tested.fire('PostToolUse', { ...call('NotebookEdit', { notebook_path: '/work/analysis.ipynb', new_source: 'print(1)' }), tool_response: {} })

  expect(seen).toEqual([{ event: 'PostToolUse', files: { read: [], changed: ['/work/analysis.ipynb'] } }])
})

test('a Bash sed -i edit lists the file in files.changed', async () => {
  const { tested, seen } = fileWatcher()

  await tested.fire('PostToolUse', { ...call('Bash', { command: "sed -i 's/draft/final/' notes.md" }), tool_response: {} })

  expect(seen).toEqual([{ event: 'PostToolUse', files: { read: [], changed: ['/work/notes.md'] } }])
})

test('a Bash mv lists both files', async () => {
  const { tested, seen } = fileWatcher()

  await tested.fire('PostToolUse', { ...call('Bash', { command: 'mv notes.md archive' }), tool_response: {} })

  expect(seen).toEqual([{ event: 'PostToolUse', files: { read: [], changed: ['/work/notes.md', '/work/archive/notes.md', '/work/archive'] } }])
})

test("a Grep call's files lists no folder", async () => {
  const { tested, seen } = fileWatcher()

  await tested.fire('PreToolUse', call('Grep', { pattern: 'TODO', path: 'src' }))
  await tested.fire('PostToolUse', { ...call('Grep', { pattern: 'TODO', path: 'src' }), tool_response: {} })

  expect(seen).toEqual([
    { event: 'PreToolUse', files: { read: [], changed: [] } },
    { event: 'PostToolUse', files: { read: [], changed: [] } },
  ])
})

test("a Glob call's files lists no folder", async () => {
  const { tested, seen } = fileWatcher()

  await tested.fire('PostToolUse', { ...call('Glob', { pattern: '**/*.ts', path: 'src' }), tool_response: {} })
  await tested.fire('PostToolUse', { ...call('Glob', { pattern: '**/*.md' }), tool_response: {} })

  expect(seen).toEqual([
    { event: 'PostToolUse', files: { read: [], changed: [] } },
    { event: 'PostToolUse', files: { read: [], changed: [] } },
  ])
})

test('a Grep of one file lists that file in files.read', async () => {
  const { tested, seen } = fileWatcher('/work', ['/work/src/app.ts'])

  await tested.fire('PostToolUse', { ...call('Grep', { pattern: 'TODO', path: 'src/app.ts' }), tool_response: {} })

  expect(seen).toEqual([{ event: 'PostToolUse', files: { read: ['/work/src/app.ts'], changed: [] } }])
})

test('a Bash grep of a folder lists no folder in files.read', async () => {
  const { tested, seen } = fileWatcher('/work', ['/work/src/button.tsx'])

  await tested.fire('PostToolUse', { ...call('Bash', { command: 'grep -r button src' }), tool_response: {} })
  await tested.fire('PostToolUse', { ...call('Bash', { command: 'rg button src' }), tool_response: {} })

  expect(seen).toEqual([
    { event: 'PostToolUse', files: { read: [], changed: [] } },
    { event: 'PostToolUse', files: { read: [], changed: [] } },
  ])
})

test('a Bash cat of a file lists that file in files.read', async () => {
  const { tested, seen } = fileWatcher('/work', ['/work/notes.md'])

  await tested.fire('PostToolUse', { ...call('Bash', { command: 'cat notes.md' }), tool_response: {} })

  expect(seen).toEqual([{ event: 'PostToolUse', files: { read: ['/work/notes.md'], changed: [] } }])
})

test('a Bash read of a path that is not there lists nothing in files.read', async () => {
  const { tested, seen } = fileWatcher()

  await tested.fire('PostToolUse', { ...call('Bash', { command: 'cat missing.md' }), tool_response: {} })

  expect(seen).toEqual([{ event: 'PostToolUse', files: { read: [], changed: [] } }])
})

test("a relative path resolves against the shell's folder", async () => {
  const { tested, seen } = fileWatcher('/work/app', ['/work/app/lib/a.ts', '/test/home/notes.md'])

  await tested.fire('PreToolUse', call('Bash', { command: 'cat lib/a.ts ~/notes.md > ../summary.md' }))

  expect(seen).toEqual([{ event: 'PreToolUse', files: { read: ['/work/app/lib/a.ts', '/test/home/notes.md'], changed: ['/work/summary.md'] } }])
})

test('a shell line naming a file through a variable lists only the files the SDK could identify', async () => {
  const { tested, seen } = fileWatcher('/work', ['/work/draft.md'])

  await tested.fire('PostToolUse', { ...call('Bash', { command: 'name=notes.md; cat "$name" draft.md > `date`.log' }), tool_response: {} })

  expect(seen).toEqual([{ event: 'PostToolUse', files: { read: ['/work/draft.md'], changed: [] } }])
})

test('a file named with a dollar sign outside the shell stays in files', async () => {
  const { tested, seen } = fileWatcher('/work', ['/work/build/Foo$Bar.class'])

  await tested.fire('PostToolUse', { ...call('Read', { file_path: '/work/build/Foo$Bar.class' }), tool_response: {} })

  expect(seen).toEqual([{ event: 'PostToolUse', files: { read: ['/work/build/Foo$Bar.class'], changed: [] } }])
})

test('a tool the SDK does not know gives empty files and the hook still runs', async () => {
  const { tested, seen } = fileWatcher()

  const answer = await tested.fire('PreToolUse', call('mcp__notes__save', { title: 'standup' }))

  expect(answer).toEqual({})
  expect(seen).toEqual([{ event: 'PreToolUse', files: { read: [], changed: [] } }])
})

test('an input the SDK cannot read gives empty files and the PreToolUse hook still runs', async () => {
  const { tested, seen } = fileWatcher()

  const answer = await tested.fire('PreToolUse', call('Edit', { old_string: 'a', new_string: 'b' }))

  expect(answer).toEqual({})
  expect(seen).toEqual([{ event: 'PreToolUse', files: { read: [], changed: [] } }])
})

test('files is the same on PreToolUse and PostToolUse for one call', async () => {
  const { tested, seen } = fileWatcher('/work', ['/work/todo.md'])
  const move = call('Bash', { command: 'cat todo.md && mv notes.md archive' })

  await tested.fire('PreToolUse', move)
  await tested.fire('PostToolUse', { ...move, tool_response: {} })

  const files = { read: ['/work/todo.md'], changed: ['/work/notes.md', '/work/archive/notes.md', '/work/archive'] }
  expect(seen).toEqual([
    { event: 'PreToolUse', files },
    { event: 'PostToolUse', files },
  ])
})

test("a cd inside a Bash line resolves the same on PreToolUse and PostToolUse when the shell's folder moved", async () => {
  const { tested, seen } = fileWatcher()
  const edit = call('Bash', { command: 'cd app && sed -i s/a/b/ notes.md' })

  await tested.fire('PreToolUse', edit)
  await tested.fire('tool.call', toolCall(edit))
  await tested.fire('PostToolUse', { ...edit, cwd: '/work/app', tool_response: {} })

  const files = { read: [], changed: ['/work/app/notes.md'] }
  expect(seen).toEqual([
    { event: 'PreToolUse', files },
    { event: 'PostToolUse', files },
  ])
})

test('a call with no Post event is forgotten once 100 newer calls are recorded', async () => {
  const { tested, seen } = fileWatcher()
  const edit = call('Bash', { command: 'sed -i s/a/b/ notes.md' })

  await tested.fire('tool.call', toolCall(edit))
  for (let index = 0; index < 100; index += 1) await tested.fire('tool.call', toolCall({ ...call('Read', { file_path: '/work/a.ts' }), tool_use_id: `toolu_newer_${index}` }))
  await tested.fire('PostToolUseFailure', { ...edit, cwd: '/work/app', error: 'sed failed' })

  expect(seen.at(-1)).toEqual({ event: 'PostToolUseFailure', files: { read: [], changed: ['/work/app/notes.md'] } })
})

test('a PostToolUseFailure resolves against the folder its tool.call recorded, then frees it', async () => {
  const { tested, seen } = fileWatcher()
  const edit = call('Bash', { command: 'sed -i s/a/b/ notes.md' })

  await tested.fire('PreToolUse', edit)
  await tested.fire('tool.call', toolCall(edit))
  await tested.fire('PostToolUseFailure', { ...edit, cwd: '/work/app', error: 'sed failed' })
  await tested.fire('PostToolUseFailure', { ...edit, cwd: '/work/app', error: 'sed failed' })

  expect(seen).toEqual([
    { event: 'PreToolUse', files: { read: [], changed: ['/work/notes.md'] } },
    { event: 'PostToolUseFailure', files: { read: [], changed: ['/work/notes.md'] } },
    { event: 'PostToolUseFailure', files: { read: [], changed: ['/work/app/notes.md'] } },
  ])
})
