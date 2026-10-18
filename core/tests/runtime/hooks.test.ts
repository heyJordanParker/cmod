import { expect, test } from 'bun:test'
import { defineMod, sessions, ToolCall } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'
import { fakeFiles } from '../../src/testing/fake-files.js'

function fileWatcher(cwd = '/work', files: string[] = []) {
  const seen: { event: string; files: unknown }[] = []
  const tested = testMod(
    defineMod({
      name: 'file-watcher',
      setup() {
        sessions.current.beforeToolCall((call) => void seen.push({ event: 'ToolCall', files: call.files }))
        sessions.current.beforeToolResult((result) => void seen.push({ event: 'ToolResult', files: result.files }))
      },
    }),
    { cwd, files: Object.fromEntries(files.map((path) => [path, ''])) },
  )
  return { tested, seen }
}

type Tested = ReturnType<typeof fileWatcher>['tested']

async function called(tested: Tested, name: string, input: Record<string, unknown>) {
  await tested.raise.beforeToolCall({ name, input, callId: 'toolu_1' })
}

async function ran(tested: Tested, name: string, input: Record<string, unknown>, isError = false) {
  await called(tested, name, input)
  await tested.add({ type: ToolCall, name, input, callId: 'toolu_1' })
  await tested.raise.beforeToolResult({ callId: 'toolu_1', output: '', ...(isError ? { isError } : {}) })
}

test("raise.beforeToolResult hands the listener the tool's raw answer, as Claude Code does", async () => {
  const outputs: unknown[] = []
  const tested = testMod(defineMod({ name: 'patch-reader', setup: () => void sessions.current.beforeToolResult((result) => void outputs.push(result.output)) }))
  const answered = { filePath: '/work/src/app.ts', structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-a', '+b'] }] }

  await tested.add({ type: ToolCall, name: 'Edit', input: { file_path: '/work/src/app.ts', old_string: 'a', new_string: 'b' }, callId: 'toolu_1' })
  await tested.raise.beforeToolResult({ callId: 'toolu_1', output: answered })

  expect(outputs).toEqual([answered])
})

test("an Edit's file is in files.changed on its call and on its result, failed or not", async () => {
  const { tested, seen } = fileWatcher()
  const edit = { file_path: '/work/src/app.ts', old_string: 'a', new_string: 'b' }

  await ran(tested, 'Edit', edit)
  await ran(tested, 'Edit', edit, true)

  const files = { read: [], changed: ['/work/src/app.ts'] }
  expect(seen).toEqual([
    { event: 'ToolCall', files },
    { event: 'ToolResult', files },
    { event: 'ToolCall', files },
    { event: 'ToolResult', files },
  ])
})

test("a NotebookEdit's notebook is in files.changed", async () => {
  const { tested, seen } = fileWatcher()

  await called(tested, 'NotebookEdit', { notebook_path: '/work/analysis.ipynb', new_source: 'print(1)' })

  expect(seen).toEqual([{ event: 'ToolCall', files: { read: [], changed: ['/work/analysis.ipynb'] } }])
})

test('a Bash sed -i edit lists the file in files.changed', async () => {
  const { tested, seen } = fileWatcher()

  await called(tested, 'Bash', { command: "sed -i 's/draft/final/' notes.md" })

  expect(seen).toEqual([{ event: 'ToolCall', files: { read: [], changed: ['/work/notes.md'] } }])
})

test('a Bash mv lists both files', async () => {
  const { tested, seen } = fileWatcher()

  await called(tested, 'Bash', { command: 'mv notes.md archive' })

  expect(seen).toEqual([{ event: 'ToolCall', files: { read: [], changed: ['/work/notes.md', '/work/archive/notes.md', '/work/archive'] } }])
})

test("a Grep or Glob call's files lists no folder", async () => {
  const { tested, seen } = fileWatcher()

  await called(tested, 'Grep', { pattern: 'TODO', path: 'src' })
  await called(tested, 'Glob', { pattern: '**/*.ts', path: 'src' })
  await called(tested, 'Glob', { pattern: '**/*.md' })

  expect(seen).toEqual([
    { event: 'ToolCall', files: { read: [], changed: [] } },
    { event: 'ToolCall', files: { read: [], changed: [] } },
    { event: 'ToolCall', files: { read: [], changed: [] } },
  ])
})

test('a Grep of one file lists that file in files.read', async () => {
  const { tested, seen } = fileWatcher('/work', ['/work/src/app.ts'])

  await called(tested, 'Grep', { pattern: 'TODO', path: 'src/app.ts' })

  expect(seen).toEqual([{ event: 'ToolCall', files: { read: ['/work/src/app.ts'], changed: [] } }])
})

test('a Bash grep of a folder lists no folder in files.read', async () => {
  const { tested, seen } = fileWatcher('/work', ['/work/src/button.tsx'])

  await called(tested, 'Bash', { command: 'grep -r button src' })
  await called(tested, 'Bash', { command: 'rg button src' })

  expect(seen).toEqual([
    { event: 'ToolCall', files: { read: [], changed: [] } },
    { event: 'ToolCall', files: { read: [], changed: [] } },
  ])
})

test('a Bash cat of a file lists that file in files.read', async () => {
  const { tested, seen } = fileWatcher('/work', ['/work/notes.md'])

  await called(tested, 'Bash', { command: 'cat notes.md' })

  expect(seen).toEqual([{ event: 'ToolCall', files: { read: ['/work/notes.md'], changed: [] } }])
})

test('a Bash read of a path cmod cannot check keeps the other files and logs that path at debug level', async () => {
  const { tested, seen } = fileWatcher('/work', ['/work/notes.md', '/work/secret.md'])
  const { stat } = fakeFiles({ '/work/notes.md': '' })
  tested.fakes.fs.stat = async (path, options) => (path === '/work/secret.md' ? Promise.reject(new Error("EACCES: permission denied, stat '/work/secret.md'")) : stat(path, options))

  await called(tested, 'Bash', { command: 'cat notes.md secret.md' })

  expect(seen).toEqual([{ event: 'ToolCall', files: { read: ['/work/notes.md'], changed: [] } }])
  expect(tested.shown.debug).toContain("file-watcher: the Bash call reads /work/secret.md, which could not be checked: EACCES: permission denied, stat '/work/secret.md'")
})

test('a Bash read of a path that is not there lists nothing in files.read', async () => {
  const { tested, seen } = fileWatcher()

  await called(tested, 'Bash', { command: 'cat missing.md' })

  expect(seen).toEqual([{ event: 'ToolCall', files: { read: [], changed: [] } }])
})

test("a relative path resolves against the shell's folder", async () => {
  const { tested, seen } = fileWatcher('/work/app', ['/work/app/lib/a.ts', '/test/home/notes.md'])

  await called(tested, 'Bash', { command: 'cat lib/a.ts ~/notes.md > ../summary.md' })

  expect(seen).toEqual([{ event: 'ToolCall', files: { read: ['/work/app/lib/a.ts', '/test/home/notes.md'], changed: ['/work/summary.md'] } }])
})

test('a shell line naming a file through a variable lists only the files cmod could identify', async () => {
  const { tested, seen } = fileWatcher('/work', ['/work/draft.md'])

  await called(tested, 'Bash', { command: 'name=notes.md; cat "$name" draft.md > `date`.log' })

  expect(seen).toEqual([{ event: 'ToolCall', files: { read: ['/work/draft.md'], changed: [] } }])
})

test('a file named with a dollar sign outside the shell stays in files', async () => {
  const { tested, seen } = fileWatcher('/work', ['/work/build/Foo$Bar.class'])

  await called(tested, 'Read', { file_path: '/work/build/Foo$Bar.class' })

  expect(seen).toEqual([{ event: 'ToolCall', files: { read: ['/work/build/Foo$Bar.class'], changed: [] } }])
})

test('a tool cmod does not know, or an input it cannot read, gives empty files and the listener still runs', async () => {
  const { tested, seen } = fileWatcher()

  expect(await tested.raise.beforeToolCall({ name: 'mcp__notes__save', input: { title: 'standup' } })).toBeUndefined()
  expect(await tested.raise.beforeToolCall({ name: 'Edit', input: { old_string: 'a', new_string: 'b' } })).toBeUndefined()

  expect(seen).toEqual([
    { event: 'ToolCall', files: { read: [], changed: [] } },
    { event: 'ToolCall', files: { read: [], changed: [] } },
  ])
})

test('files is the same on a call and its result', async () => {
  const { tested, seen } = fileWatcher('/work', ['/work/todo.md'])

  await ran(tested, 'Bash', { command: 'cat todo.md && mv notes.md archive' })

  const files = { read: ['/work/todo.md'], changed: ['/work/notes.md', '/work/archive/notes.md', '/work/archive'] }
  expect(seen).toEqual([
    { event: 'ToolCall', files },
    { event: 'ToolResult', files },
  ])
})

test('a result resolves against the folder its call ran in, though a cd inside the call moved the shell', async () => {
  const { tested, seen } = fileWatcher()
  const edit = { command: 'cd app && sed -i s/a/b/ notes.md' }

  await called(tested, 'Bash', edit)
  await tested.add({ type: ToolCall, name: 'Bash', input: edit, callId: 'toolu_1' })
  await tested.moveTo('/test/project', '/work/app')
  seen.length = 1
  await tested.raise.beforeToolResult({ callId: 'toolu_1', output: '' })

  const files = { read: [], changed: ['/work/app/notes.md'] }
  expect(seen).toEqual([
    { event: 'ToolCall', files },
    { event: 'ToolResult', files },
  ])
})
