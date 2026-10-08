import { describe, expect, test } from 'bun:test'
import type { EventResult } from 'claude-code'
import { testMod } from '../../src/testing.js'
import { dent } from './dent-mod.js'

type Use = { tool: string; input: Record<string, unknown> }

const root = '/work/dent'
const home = '/test/home'
const files = {
  [`${root}/.git/HEAD`]: 'ref: refs/heads/main\n',
  [`${root}/.git/worktrees/design/commondir`]: '../..\n',
  [`${root}/worktrees/design/.git`]: `gitdir: ${root}/.git/worktrees/design\n`,
  [`${root}/worktrees/design/Domain.md`]: '# Domain\n',
  [`${root}/Domain.md`]: '# Domain\n',
  [`${root}/.claude/skills/dent/src/mod.ts`]: 'export {}\n',
  [`${root}/app/cart.test.ts`]: "test('adds', () => {})\n",
  [`${root}/app/cart.ts`]: 'export {}\n',
  [`${home}/dotfiles/.git/HEAD`]: 'ref: refs/heads/master\n',
  [`${home}/dotfiles/Domain.md`]: '# Domain\n',
  [`${home}/dotfiles/a.ts`]: 'a\n',
}
const allowed: EventResult<'tool.check'> = { decision: 'allow' }
const answered = { result: { filePath: `${root}/app/cart.ts` }, text: 'The file was updated.' } as Extract<EventResult<'tool.call'>, { result: unknown; isError?: undefined }>

function dentSession(gitStatus = '') {
  const tested = testMod(dent, { scope: 'project', projectRoot: root, files, permissions: ['run:git', 'run:bun'] })
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: gitStatus, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  let calls = 0
  const decide = (use: Use) => tested.fire('tool.check', { ...use, tool_use_id: `toolu_${(calls += 1)}` } as never, allowed)
  const after = (use: Use) => tested.fire('tool.call', { tool: use.tool, ...use.input, tool_use_id: `toolu_${(calls += 1)}` } as never, answered)
  const runs = () => tested.calls.filter((call) => call.call === 'process.run').map((call) => call.args)
  return { tested, decide, after, runs }
}

const bash = (command: string): Use => ({ tool: 'Bash', input: { command } })
const edit = (path: string, oldString: string, newString: string): Use => ({ tool: 'Edit', input: { file_path: path, old_string: oldString, new_string: newString } })
const write = (path: string, content: string): Use => ({ tool: 'Write', input: { file_path: path, content } })

describe('the Dent mod of sdk-domain.md', () => {
  test('loads through testMod and lists what it added', async () => {
    const { tested } = dentSession()
    await tested.start()
    expect(tested.shown.logs).toEqual(['dent added 8 permission rules and a check after edits to **/*.ts, **/*.tsx and **/*.php.'])
  })

  test.each([
    ['bun add zod', 'Install inside the container: lando bun add.'],
    ['cd app && bun install', 'Install inside the container: lando bun add.'],
    ['npx tsc --noEmit', 'Use the project wrapper: bun run <script>.'],
    ['node -v', 'Use the project wrapper: bun run <script>.'],
    ['php artisan migrate', 'Use the project wrapper: bun run <script>.'],
    ['bun test 2>&1 | tail -5', 'Read the whole report: bun test --report=json.'],
    ['bun test | grep FAIL', 'Read the whole report: bun test --report=json.'],
    ['sed -i s/test/test.skip/ app/cart.test.ts', 'Change test files with Edit or Write, so the test gate can read the change.'],
    ['echo {} > tests/budgets.json', 'The test gate does not change.'],
  ])('denies %p', async (line, reason) => {
    expect(await dentSession().decide(bash(line))).toEqual({ decision: 'deny', reason })
  })

  test.each([['lando bun add zod'], ['bun run check'], ['command -v node'], ['bun test --report=json'], ['git status'], ['cd ~/dotfiles && bun add zod']])('allows %p', async (line) => {
    expect(await dentSession().decide(bash(line))).toEqual(allowed)
  })

  test('denies a change to the test gate files', async () => {
    const { decide } = dentSession()
    expect(await decide(edit(`${root}/tests/budgets.json`, '1', '2'))).toEqual({ decision: 'deny', reason: 'The test gate does not change.' })
    expect(await decide(write(`${root}/.claude/skills/dent/src/mod.ts`, ''))).toEqual({ decision: 'deny', reason: 'The test gate does not change.' })
  })

  test('denies an Edit that skips a test, and allows one that fixes it', async () => {
    const { decide } = dentSession()
    expect(await decide(edit(`${root}/app/cart.test.ts`, "test('adds'", "test.skip('adds'"))).toEqual({ decision: 'deny', reason: 'Fix the test. Do not skip it.' })
    expect(await decide(edit(`${root}/app/cart.test.ts`, '{}', '{ expect(1).toBe(1) }'))).toEqual(allowed)
  })

  test('denies a Domain.md edit while code changes are uncommitted, in the main tree and in the design worktree', async () => {
    const withCode = dentSession(' M app/cart.ts\n M Domain.md\n')
    const denied: EventResult<'tool.check'> = { decision: 'deny', reason: 'Edit Domain.md in its own change, with the Architect.' }
    expect(await withCode.decide(edit(`${root}/Domain.md`, '#', '##'))).toEqual(denied)
    expect(await withCode.decide(edit(`${root}/worktrees/design/Domain.md`, '#', '##'))).toEqual(denied)
    expect(await withCode.decide(edit(`${home}/dotfiles/Domain.md`, '#', '##'))).toEqual(allowed)
    expect(await dentSession(' M Domain.md\n').decide(edit(`${root}/Domain.md`, '#', '##'))).toEqual(allowed)
    expect(withCode.runs().map(([, init]) => init)).toEqual([
      { cwd: root, timeoutMs: 2000 },
      { cwd: `${root}/worktrees/design`, timeoutMs: 2000 },
    ])
  })

  test('denies a Domain.md edit when git status passes its deadline, because the rule gives its own decision', async () => {
    const { tested, decide } = dentSession()
    tested.fakes.process.run = () => new Promise(() => undefined)
    tested.fakes.clock.after = (_ms, fire) => {
      void Promise.resolve().then(fire)
      return { cancel: () => undefined }
    }
    expect(await decide(edit(`${root}/Domain.md`, '#', '##'))).toEqual({
      decision: 'deny',
      reason: 'Edit Domain.md in its own change, with the Architect. Its when check failed: mod.process.run passed the 2 s deadline of permissions',
    })
  })

  test('denies a second migration for one table', async () => {
    const { decide } = dentSession('?? database/migrations/2026_10_04_create_carts_table.php\n')
    expect(await decide(write(`${root}/database/migrations/2026_10_05_create_carts_table.php`, '<?php'))).toEqual({ decision: 'deny', reason: 'Edit the uncommitted migration for this table.' })
    expect(await decide(write(`${root}/database/migrations/2026_10_05_create_users_table.php`, '<?php'))).toEqual(allowed)
  })

  test('runs dnt check on a changed TypeScript file, in the work tree that holds it', async () => {
    const { after, runs } = dentSession()
    await after(edit(`${root}/app/cart.ts`, '{}', '{ }'))
    expect(runs()).toEqual([[['bun', 'cli/dnt.ts', 'check', `${root}/app/cart.ts`], { cwd: root, timeoutMs: 60000 }]])
  })

  test('runs no check for a file it does not check, or for a file outside the project', async () => {
    const { after, runs } = dentSession()
    await after(edit(`${root}/Domain.md`, '#', '##'))
    await after(edit(`${home}/dotfiles/a.ts`, 'a', 'b'))
    expect(runs()).toEqual([])
  })
})
