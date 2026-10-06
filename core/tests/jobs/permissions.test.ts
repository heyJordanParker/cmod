import { expect, test } from 'bun:test'
import type { EventResult } from 'claude-code'
import { permissions, type PermissionRules } from '../../src/jobs/permissions.js'
import { defineMod, type Job } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'

const bashCheck = (command: string, toolUseId: string) => ({ tool: 'Bash', input: { command }, tool_use_id: toolUseId })
const allowedInBypassMode: EventResult<'tool.check'> = { decision: 'allow' }

test('a deny rule refuses a Bash call in bypassPermissions mode, and its reason reaches the answer', async () => {
  const tested = testMod(
    defineMod({
      name: 'no-force-push',
      setup(mod) {
        mod.use(permissions({ deny: [{ command: 'git push --force', reason: 'Force pushes rewrite shared history.' }] }))
      },
    }),
  )

  const answer = await tested.fire('tool.check', bashCheck('git push --force origin main', 'toolu_1'), allowedInBypassMode)

  expect(answer).toEqual({ decision: 'deny', reason: 'Force pushes rewrite shared history.' })
  expect(await tested.fire('tool.check', bashCheck('git push origin main', 'toolu_2'), allowedInBypassMode)).toEqual(allowedInBypassMode)
  expect(tested.shown.logs).toEqual(['no-force-push added 1 permission rule.'])
})

test("a when rule on agentType refuses an explorer subagent's call, joined through tool.call's agentId, and allows the same call on the main loop", async () => {
  let reachBelow: () => void = () => undefined
  let finishCall: () => void = () => undefined
  const reachedBelow = new Promise<void>((resolve) => (reachBelow = resolve))
  const callFinished = new Promise<void>((resolve) => (finishCall = resolve))
  const coreBeneath: Job<void> = (job) => {
    job.on('tool.call', async (e, next) => {
      reachBelow()
      await callFinished
      return next(e)
    })
  }
  const tested = testMod(
    defineMod({
      name: 'read-only-explorers',
      setup(mod) {
        mod.use(permissions({ deny: [{ command: '*', when: (call) => call.agentType === 'explorer', reason: 'Explorers only read.' }] }))
        mod.use(coreBeneath)
      },
    }),
  )
  tested.fakes.agent.list = async () => [{ id: 'a4aa369514be1f5cc', type: 'explorer', description: 'Map the router', status: 'running' }]

  const subagentCall = tested.fire('tool.call', { tool: 'Bash', command: 'rm -rf build', tool_use_id: 'toolu_sub', agentId: 'a4aa369514be1f5cc' }, { deny: 'refused' })
  await reachedBelow
  const inSubagent = await tested.fire('tool.check', bashCheck('rm -rf build', 'toolu_sub'), allowedInBypassMode)
  finishCall()
  await subagentCall
  const afterTheCall = await tested.fire('tool.check', bashCheck('rm -rf build', 'toolu_sub'), allowedInBypassMode)
  const onMainLoop = await tested.fire('tool.check', bashCheck('rm -rf build', 'toolu_main'), allowedInBypassMode)

  expect(inSubagent).toEqual({ decision: 'deny', reason: 'Explorers only read.' })
  expect(afterTheCall).toEqual(allowedInBypassMode)
  expect(onMainLoop).toEqual(allowedInBypassMode)
})

test("a when check gets the mod's own typed state, so a rule follows state without capturing the mod from setup", async () => {
  const tested = testMod(
    defineMod({
      name: 'freeze',
      state: { project: { frozen: true } },
      setup(mod) {
        mod.use(permissions({ deny: [{ command: 'git push', when: (_call, mod) => mod.state.project.frozen, reason: 'Pushes are frozen.' }] }))
      },
    }),
  )

  expect(await tested.fire('tool.check', bashCheck('git push origin main', 'toolu_1'), allowedInBypassMode)).toEqual({ decision: 'deny', reason: 'Pushes are frozen.' })
  tested.state.project.frozen = false
  expect(await tested.fire('tool.check', bashCheck('git push origin main', 'toolu_2'), allowedInBypassMode)).toEqual(allowedInBypassMode)
})

test("the main loop's agentType is the session's Agent, read from the classic hook input", async () => {
  const seen: (string | undefined)[] = []
  const tested = testMod(
    defineMod({
      name: 'agent-reader',
      setup(mod) {
        mod.use(permissions({ ask: [{ command: '*', when: (call) => (seen.push(call.agentType), false) }] }))
      },
    }),
  )

  await tested.fire('UserPromptSubmit', { prompt: 'hi', agent_type: 'cto' })
  await tested.fire('tool.check', bashCheck('ls', 'toolu_1'), allowedInBypassMode)

  expect(seen).toEqual(['cto'])
})

test('a when check whose mod.process.run passes the 2 s deadline gives the rule its own decision', async () => {
  const tested = testMod(
    defineMod({
      name: 'clean-tree',
      setup(mod) {
        mod.use(permissions({ deny: [{ command: 'git commit', when: async (_call, mod) => (await mod.process.run(['git', 'status'])).stdout !== '', reason: 'Commit a clean tree.' }] }))
      },
    }),
  )
  const timers: number[] = []
  tested.fakes.process.run = () => new Promise(() => undefined)
  tested.fakes.clock.after = (ms, fire) => {
    timers.push(ms)
    void Promise.resolve().then(fire)
    return { cancel: () => undefined }
  }

  const answer = await tested.fire('tool.check', bashCheck('git commit -m x', 'toolu_1'), allowedInBypassMode)

  expect(answer).toEqual({ decision: 'deny', reason: 'Commit a clean tree. Its when check failed: mod.process.run passed the 2 s deadline of permissions' })
  expect(timers).toEqual([2000])
  expect(tested.calls.find((call) => call.call === 'process.run')?.args).toEqual([['git', 'status'], { timeoutMs: 2000 }])
})

const project = '/work/dent'
const files = {
  [`${project}/.git/HEAD`]: 'ref: refs/heads/main\n',
  [`${project}/.git/worktrees/design/commondir`]: '../..\n',
  [`${project}/worktrees/design/.git`]: `gitdir: ${project}/.git/worktrees/design\n`,
  [`${project}/worktrees/design/Domain.md`]: '# Domain\n',
  [`${project}/Domain.md`]: '# Domain\n',
  [`${project}/docs/Domain.md`]: '# Domain\n',
  ['/test/home/dotfiles/.git/HEAD']: 'ref: refs/heads/master\n',
  ['/test/home/dotfiles/Domain.md']: '# Domain\n',
}

function inProject(rules: PermissionRules) {
  const tested = testMod(
    defineMod({
      name: 'dent',
      setup(mod) {
        mod.use(permissions(rules))
      },
    }),
    { scope: 'project', projectRoot: project, files },
  )
  tested.fakes.clock.after = () => ({ cancel: () => undefined })
  return tested
}

const editCheck = (path: string, toolUseId: string) => ({ tool: 'Edit', input: { file_path: path, old_string: '#', new_string: '##' }, tool_use_id: toolUseId })

test('a project-scope rule matches Domain.md inside the project and not outside it', async () => {
  const tested = inProject({ deny: [{ write: 'Domain.md', reason: 'Edit Domain.md with the Architect.' }] })
  const denied: EventResult<'tool.check'> = { decision: 'deny', reason: 'Edit Domain.md with the Architect.' }

  expect(await tested.fire('tool.check', editCheck(`${project}/Domain.md`, 'toolu_1'), allowedInBypassMode)).toEqual(denied)
  expect(await tested.fire('tool.check', editCheck(`${project}/worktrees/design/Domain.md`, 'toolu_2'), allowedInBypassMode)).toEqual(denied)
  expect(await tested.fire('tool.check', editCheck(`${project}/docs/Domain.md`, 'toolu_3'), allowedInBypassMode)).toEqual(allowedInBypassMode)
  expect(await tested.fire('tool.check', editCheck('/test/home/dotfiles/Domain.md', 'toolu_4'), allowedInBypassMode)).toEqual(allowedInBypassMode)
})

test('a user-scope deny on Domain.md still denies after Claude runs cd docs', async () => {
  const tested = testMod(
    defineMod({
      name: 'guard',
      setup(mod) {
        mod.use(permissions({ deny: [{ write: 'Domain.md', reason: 'Edit Domain.md with the Architect.' }] }))
      },
    }),
    { projectRoot: '/work/app', cwd: '/work/app/docs' },
  )

  expect(await tested.fire('tool.check', editCheck('/work/app/Domain.md', 'toolu_1'), allowedInBypassMode)).toEqual({ decision: 'deny', reason: 'Edit Domain.md with the Architect.' })
  expect(await tested.fire('tool.check', editCheck('/work/app/docs/Domain.md', 'toolu_2'), allowedInBypassMode)).toEqual(allowedInBypassMode)
})

test("a command rule's when runs in the folder the command cds into", async () => {
  const tested = inProject({ deny: [{ command: 'git commit', when: async (_call, mod) => (await mod.process.run(['git', 'status'])).stdout !== '', reason: 'Commit a clean tree.' }] })
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  await tested.fire('tool.check', bashCheck('cd worktrees/design && git commit -m x', 'toolu_1'), allowedInBypassMode)
  await tested.fire('tool.check', bashCheck('git commit -m x', 'toolu_2'), allowedInBypassMode)

  expect(tested.calls.filter((call) => call.call === 'process.run').map((call) => call.args[1])).toEqual([
    { cwd: `${project}/worktrees/design`, timeoutMs: 2000 },
    { cwd: project, timeoutMs: 2000 },
  ])
})

test('a rule with no target key throws in setup with the keys it accepts', async () => {
  expect(() => permissions({ deny: [{ reason: 'x' } as never] })).toThrow('A rule names exactly one of command, read, write, fetch, subagent, tool')
  expect(() => permissions({})).toThrow('permissions: give it a deny or an ask rule, or remove it from setup.')
})
