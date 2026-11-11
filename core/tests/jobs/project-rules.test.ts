import { describe, expect, test } from 'bun:test'
import type { EventResult } from 'claude-code'
import { testMod } from '../../src/testing.js'
import { claudeCodeOf } from '../../src/testing/claude-code.js'
import { projectRules } from './project-rules-mod.js'

type Use = { tool: string; input: Record<string, unknown> }

const root = '/work/app'
const home = '/test/home'
const files = {
  [`${root}/.git/HEAD`]: 'ref: refs/heads/main\n',
  [`${root}/.git/worktrees/design/commondir`]: '../..\n',
  [`${root}/worktrees/design/.git`]: `gitdir: ${root}/.git/worktrees/design\n`,
  [`${root}/worktrees/design/CHANGELOG.md`]: '# Changelog\n',
  [`${root}/CHANGELOG.md`]: '# Changelog\n',
  [`${root}/.claude/skills/demo/src/mod.ts`]: 'export {}\n',
  [`${root}/app/cart.test.ts`]: "test('adds', () => {})\n",
  [`${root}/app/cart.ts`]: 'export {}\n',
  [`${home}/elsewhere/.git/HEAD`]: 'ref: refs/heads/master\n',
  [`${home}/elsewhere/CHANGELOG.md`]: '# Changelog\n',
  [`${home}/elsewhere/a.ts`]: 'a\n',
}
const allowed: EventResult<'tool.check'> = { decision: 'allow' }
const answered = { result: { filePath: `${root}/app/cart.ts` }, text: 'The file was updated.' } as Extract<EventResult<'tool.call'>, { result: unknown; isError?: undefined }>

function projectSession(gitStatus = '') {
  const tested = testMod(projectRules, { scope: 'project', projectRoot: root, files })
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: gitStatus, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  let calls = 0
  const decide = (use: Use) => claudeCodeOf(tested).fire('tool.check', { ...use, tool_use_id: `toolu_${(calls += 1)}` } as never, allowed)
  const after = (use: Use) => claudeCodeOf(tested).fire('tool.call', { tool: use.tool, ...use.input, tool_use_id: `toolu_${(calls += 1)}` } as never, answered)
  const runs = () => tested.calls.filter((call) => call.call === 'process.run').map((call) => call.args)
  return { tested, decide, after, runs }
}

const bash = (command: string): Use => ({ tool: 'Bash', input: { command } })
const edit = (path: string, oldString: string, newString: string): Use => ({ tool: 'Edit', input: { file_path: path, old_string: oldString, new_string: newString } })
const write = (path: string, content: string): Use => ({ tool: 'Write', input: { file_path: path, content } })

describe('a mod that guards one project', () => {
  test('loads through testMod and lists what it added', async () => {
    const { tested } = projectSession()
    await tested.start()
    expect(tested.shown.toasts.find(({ message }) => message === 'Installed')?.description).toContain('Adds 8 permission rules and a check after edits to **/*.ts, **/*.tsx and **/*.php.')
  })

  test.each([
    ['bun add zod', 'Ask before you change the packages.'],
    ['cd app && bun install', 'Ask before you change the packages.'],
    ['npx tsc --noEmit', 'Use the project wrapper: bun run <script>.'],
    ['node -v', 'Use the project wrapper: bun run <script>.'],
    ['php artisan migrate', 'Use the project wrapper: bun run <script>.'],
    ['bun test 2>&1 | tail -5', 'Read the whole report: bun test --report=json.'],
    ['bun test | grep FAIL', 'Read the whole report: bun test --report=json.'],
    ['sed -i s/test/test.skip/ app/cart.test.ts', 'Change test files with Edit or Write, so the test gate can read the change.'],
    ['echo {} > tests/baseline.json', 'The test gate does not change.'],
  ])('denies %p', async (line, reason) => {
    expect(await projectSession().decide(bash(line))).toEqual({ decision: 'deny', reason })
  })

  test.each([['bun pm ls'], ['bun run check'], ['command -v node'], ['bun test --report=json'], ['git status'], ['cd ~/elsewhere && bun add zod']])('allows %p', async (line) => {
    expect(await projectSession().decide(bash(line))).toEqual(allowed)
  })

  test('denies a change to the test gate files', async () => {
    const { decide } = projectSession()
    expect(await decide(edit(`${root}/tests/baseline.json`, '1', '2'))).toEqual({ decision: 'deny', reason: 'The test gate does not change.' })
    expect(await decide(write(`${root}/.claude/skills/demo/src/mod.ts`, ''))).toEqual({ decision: 'deny', reason: 'The test gate does not change.' })
  })

  test('denies an Edit that skips a test, and allows one that fixes it', async () => {
    const { decide } = projectSession()
    expect(await decide(edit(`${root}/app/cart.test.ts`, "test('adds'", "test.skip('adds'"))).toEqual({ decision: 'deny', reason: 'Fix the test. Do not skip it.' })
    expect(await decide(edit(`${root}/app/cart.test.ts`, '{}', '{ expect(1).toBe(1) }'))).toEqual(allowed)
  })

  test('denies a CHANGELOG.md edit while code changes are uncommitted, in the main tree and in the design worktree', async () => {
    const withCode = projectSession(' M app/cart.ts\n M CHANGELOG.md\n')
    const denied: EventResult<'tool.check'> = { decision: 'deny', reason: 'Edit CHANGELOG.md in its own change.' }
    expect(await withCode.decide(edit(`${root}/CHANGELOG.md`, '#', '##'))).toEqual(denied)
    expect(await withCode.decide(edit(`${root}/worktrees/design/CHANGELOG.md`, '#', '##'))).toEqual(denied)
    expect(await withCode.decide(edit(`${home}/elsewhere/CHANGELOG.md`, '#', '##'))).toEqual(allowed)
    expect(await projectSession(' M CHANGELOG.md\n').decide(edit(`${root}/CHANGELOG.md`, '#', '##'))).toEqual(allowed)
    expect(withCode.runs().map(([, init]) => init)).toEqual([{ cwd: root }, { cwd: `${root}/worktrees/design` }])
  })

  test('denies a CHANGELOG.md edit when git status passes its deadline, because the rule gives its own decision', async () => {
    const { tested, decide } = projectSession()
    tested.fakes.process.run = () => new Promise(() => undefined)
    tested.fakes.clock.after = (_ms, fire) => {
      void Promise.resolve().then(fire)
      return { cancel: () => undefined }
    }
    expect(await decide(edit(`${root}/CHANGELOG.md`, '#', '##'))).toEqual({
      decision: 'deny',
      reason: 'Edit CHANGELOG.md in its own change. Its when check failed: it passed the 2 s deadline of permissions',
    })
  })

  test('denies a second migration for one table', async () => {
    const { decide } = projectSession('?? database/migrations/2026_10_04_create_carts_table.php\n')
    expect(await decide(write(`${root}/database/migrations/2026_10_05_create_carts_table.php`, '<?php'))).toEqual({ decision: 'deny', reason: 'Edit the uncommitted migration for this table.' })
    expect(await decide(write(`${root}/database/migrations/2026_10_05_create_users_table.php`, '<?php'))).toEqual(allowed)
  })

  test('runs the project check on a changed TypeScript file, in the work tree that holds it', async () => {
    const { after, runs } = projectSession()
    await after(edit(`${root}/app/cart.ts`, '{}', '{ }'))
    expect(runs()).toEqual([[['bun', 'run', 'check', `${root}/app/cart.ts`], { cwd: root, timeoutMs: 60000 }]])
  })

  test('runs no check for a file it does not check, or for a file outside the project', async () => {
    const { after, runs } = projectSession()
    await after(edit(`${root}/CHANGELOG.md`, '#', '##'))
    await after(edit(`${home}/elsewhere/a.ts`, 'a', 'b'))
    expect(runs()).toEqual([])
  })
})
