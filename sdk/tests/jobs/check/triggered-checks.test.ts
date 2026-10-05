import { expect, test } from 'bun:test'
import { triggeredRun } from '../../../src/jobs/check/triggered-checks.js'
import type { Workspace } from '../../../src/jobs/permissions/find-project-scope.js'
import type { Target } from '../../../src/jobs/permissions/match-target.js'
import type { ToolUse } from '../../../src/utils/call-effects.js'
import { fakeFileSystem } from '../fake-file-system.js'

const cwd = '/work/app'
const workspace: Workspace = {
  cwd,
  home: '/Users/me',
  scope: undefined,
  fs: fakeFileSystem({ '/work/app/src/a.ts': 'a', '/work/app/src/b.ts': 'b', '/work/app/README.md': 'r' }),
}
const lint: Target[] = [{ write: ['**/*.ts', '**/*.php'] }]
const lintCommand = ['bun', 'cli/dnt.ts', 'check']
const smoke: Target[] = [{ command: 'git commit' }]
const smokeCommand = ['bun', 'run', 'test:smoke']

function bash(command: string): ToolUse {
  return { tool: 'Bash', input: { command } }
}

test('a write check runs its command with each matched path appended, as lint-staged does', async () => {
  const run = await triggeredRun(lint, lintCommand, { tool: 'Edit', input: { file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' } }, workspace)
  expect(run).toEqual({ command: ['bun', 'cli/dnt.ts', 'check', '/work/app/src/a.ts'], folder: '/work/app/src' })
})

test('a shell write that names several matching files runs one command with each file once', async () => {
  const run = await triggeredRun(lint, lintCommand, bash('sed -i s/a/b/ src/a.ts src/b.ts README.md src/a.ts'), workspace)
  expect(run).toEqual({ command: ['bun', 'cli/dnt.ts', 'check', '/work/app/src/a.ts', '/work/app/src/b.ts'], folder: '/work/app/src' })
})

test('a write check does not run when no matched path still exists', async () => {
  expect(await triggeredRun(lint, lintCommand, bash('rm src/gone.ts'), workspace)).toBeUndefined()
})

test('a command check runs its command as written, in the folder the matched command runs in', async () => {
  expect(await triggeredRun(smoke, smokeCommand, bash('git add -A && git commit -m "x"'), workspace)).toEqual({ command: smokeCommand, folder: cwd })
  expect(await triggeredRun(smoke, smokeCommand, bash('cd packages/web && git commit -m "x"'), workspace)).toEqual({ command: smokeCommand, folder: `${cwd}/packages/web` })
})

test('a call that matches no target triggers nothing', async () => {
  expect(await triggeredRun([...lint, ...smoke], lintCommand, bash('ls src'), workspace)).toBeUndefined()
  expect(await triggeredRun(lint, lintCommand, { tool: 'Read', input: { file_path: '/work/app/src/a.ts' } }, workspace)).toBeUndefined()
})
