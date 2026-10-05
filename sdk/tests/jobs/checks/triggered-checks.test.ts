import { expect, test } from 'bun:test'
import { triggeredChecks, type Check } from '../../../src/jobs/checks/triggered-checks.js'
import type { Workspace } from '../../../src/jobs/permissions/find-project-scope.js'
import type { ToolUse } from '../../../src/utils/call-effects.js'
import { fakeFileSystem } from '../fake-file-system.js'

const cwd = '/work/app'
const workspace: Workspace = {
  cwd,
  home: '/Users/me',
  scope: undefined,
  fs: fakeFileSystem({ '/work/app/src/a.ts': 'a', '/work/app/src/b.ts': 'b', '/work/app/README.md': 'r' }),
}
const lint: Check<null> = { write: ['**/*.ts', '**/*.php'], run: ['bun', 'cli/dnt.ts', 'check'] }
const smoke: Check<null> = { command: 'git commit', run: ['bun', 'run', 'test:smoke'] }

function bash(command: string): ToolUse {
  return { tool: 'Bash', input: { command } }
}

test('a write check runs its command with each matched path appended, as lint-staged does', async () => {
  const runs = await triggeredChecks([lint], { tool: 'Edit', input: { file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' } }, workspace)
  expect(runs).toEqual([{ check: lint, command: ['bun', 'cli/dnt.ts', 'check', '/work/app/src/a.ts'], folder: '/work/app/src' }])
})

test('a shell write that names several matching files runs one command with each file once', async () => {
  const runs = await triggeredChecks([lint], bash('sed -i s/a/b/ src/a.ts src/b.ts README.md src/a.ts'), workspace)
  expect(runs).toEqual([{ check: lint, command: ['bun', 'cli/dnt.ts', 'check', '/work/app/src/a.ts', '/work/app/src/b.ts'], folder: '/work/app/src' }])
})

test('a write check does not run when no matched path still exists', async () => {
  expect(await triggeredChecks([lint], bash('rm src/gone.ts'), workspace)).toEqual([])
})

test('a command check runs its command as written, in the folder the matched command runs in', async () => {
  expect(await triggeredChecks([lint, smoke], bash('git add -A && git commit -m "x"'), workspace)).toEqual([{ check: smoke, command: ['bun', 'run', 'test:smoke'], folder: cwd }])
  expect(await triggeredChecks([smoke], bash('cd packages/web && git commit -m "x"'), workspace)).toEqual([{ check: smoke, command: ['bun', 'run', 'test:smoke'], folder: `${cwd}/packages/web` }])
})

test('a check whose run is a function gets the call to run it with', async () => {
  const review: Check<null> = { write: '**/*.md', run: (call) => `Reread ${call.path}.` }
  const runs = await triggeredChecks([review], { tool: 'Write', input: { file_path: '/work/app/README.md', content: 'x' } }, workspace)
  const outputs = await Promise.all(runs.map(async (run) => ('call' in run ? { call: run.call, folder: run.folder, output: await run.callback(run.call, null) } : run)))
  expect(outputs).toEqual([{ call: { tool: 'Write', path: '/work/app/README.md' }, folder: cwd, output: 'Reread /work/app/README.md.' }])
})

test('a call that matches no check triggers none', async () => {
  expect(await triggeredChecks([lint, smoke], bash('ls src'), workspace)).toEqual([])
  expect(await triggeredChecks([lint], { tool: 'Read', input: { file_path: '/work/app/src/a.ts' } }, workspace)).toEqual([])
})
