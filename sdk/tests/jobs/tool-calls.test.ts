import { expect, test } from 'bun:test'
import { findProjectScope, type Workspace } from '../../src/jobs/permissions/find-project-scope.js'
import { modOf, targetWords } from '../../src/jobs/tool-calls.js'
import { defineMod, type PartContext } from '../../src/mod.js'
import { toolCalls, type ToolCalls } from '../../src/runtime/tool-calls.js'
import { testMod } from '../../src/testing.js'
import { fakeFileSystem } from './fake-file-system.js'

const root = '/work/dent'
const home = '/Users/jordan'
const deadline = { ms: 2000, job: 'permissions' }
const fs = fakeFileSystem({
  [`${root}/.git/HEAD`]: 'ref: refs/heads/main\n',
  [`${root}/.git/worktrees/design/commondir`]: '../..\n',
  [`${root}/worktrees/design/.git`]: `gitdir: ${root}/.git/worktrees/design\n`,
  [`${root}/worktrees/design/Domain.md`]: '# Domain\n',
})

async function partFor() {
  let used: PartContext | undefined
  const tested = testMod(defineMod({ name: 'dent', setup: (mod) => mod.use((context) => void (used = context)) }), { projectRoot: root })
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  await tested.start()
  if (used === undefined) throw new Error('setup did not run')
  return { fake: tested, context: used }
}

test('every job of one mod shares one tool-call context', async () => {
  const contexts: ToolCalls[] = []
  const tested = testMod(defineMod({ name: 'dent', setup: (mod) => void contexts.push(mod.use(toolCalls), mod.use(toolCalls)) }))
  await tested.start()
  expect(contexts).toHaveLength(2)
  expect(contexts[0]).toBe(contexts[1])
})

test("in a project-scope plugin, a callback's mod.process.run runs in the work tree that holds the call's path", async () => {
  const { fake, context } = await partFor()
  const workspace: Workspace = { cwd: root, home, fs, scope: await findProjectScope(`${root}/.claude/skills/dent`, home, fs) }

  await modOf(context, { tool: 'Edit', path: `${root}/worktrees/design/Domain.md` }, root, workspace, deadline).process.run(['git', 'status'])
  await modOf(context, { tool: 'Bash', commands: [['git', 'commit']], isFullyParsed: true }, root, workspace, deadline).process.run(['git', 'status'])
  await modOf(context, { tool: 'Bash', commands: [['git', 'commit']], isFullyParsed: true }, `${root}/worktrees/design/app`, workspace, deadline).process.run(['git', 'status'])
  await modOf(context, { tool: 'Edit', path: `${root}/Domain.md` }, root, workspace, deadline).process.run(['git', 'status'], { cwd: '/tmp', timeoutMs: 9000 })

  expect(fake.calls.filter((call) => call.call === 'process.run').map((call) => call.args[1])).toEqual([
    { cwd: `${root}/worktrees/design`, timeoutMs: 2000 },
    { cwd: root, timeoutMs: 2000 },
    { cwd: `${root}/worktrees/design`, timeoutMs: 2000 },
    { cwd: '/tmp', timeoutMs: 2000 },
  ])
})

test("in any other plugin, a callback's mod.process.run runs in the session's folder", async () => {
  const { fake, context } = await partFor()
  const workspace: Workspace = { cwd: root, home, fs, scope: undefined }

  await modOf(context, { tool: 'Edit', path: `${root}/worktrees/design/Domain.md` }, root, workspace, deadline).process.run(['git', 'status'])

  expect(fake.calls.find((call) => call.call === 'process.run')?.args[1]).toEqual({ timeoutMs: 2000 })
})

test('targetWords names each target in words a user reads', () => {
  expect(targetWords({ write: '*.ts' })).toBe('edits to *.ts')
  expect(targetWords({ read: ['.env', '*.pem'] })).toBe('reads of .env and *.pem')
  expect(targetWords({ command: 'git commit' })).toBe('git commit')
  expect(targetWords({ command: '*' })).toBe('every shell command')
  expect(targetWords({ fetch: 'https://*.example/**' })).toBe('fetches of https://*.example/**')
  expect(targetWords({ subagent: 'explorer' })).toBe('the explorer subagent')
  expect(targetWords({ tool: 'mcp__github__*' })).toBe('the mcp__github__* tool')
})
