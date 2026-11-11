import { describe, expect, test } from 'bun:test'
import { decidePermission, type PermissionRules } from '../../../src/jobs/permissions/decide-permission.js'
import { findProjectScope, type Workspace } from '../../../src/jobs/permissions/find-project-scope.js'
import type { Call } from '../../../src/utils/call-effects.js'
import { fakeFiles } from '../../../src/testing/fake-files.js'

const home = '/Users/me'
const root = '/work/app'
const pluginRoot = `${root}/.claude/skills/demo`
const files = {
  [`${root}/.git/HEAD`]: 'ref: refs/heads/main\n',
  [`${root}/.git/worktrees/design/commondir`]: '../..\n',
  [`${root}/worktrees/design/.git`]: `gitdir: ${root}/.git/worktrees/design\n`,
  [`${root}/worktrees/design/CHANGELOG.md`]: '# Changelog\n',
  [`${root}/worktrees/broken/.git`]: 'not a git file\n',
  [`${root}/vendor/lib/.git/HEAD`]: 'ref: refs/heads/main\n',
  [`${root}/CHANGELOG.md`]: '# Changelog\n',
  [`${pluginRoot}/package.json`]: '{}',
  [`${home}/elsewhere/.git/HEAD`]: 'ref: refs/heads/master\n',
  [`${home}/elsewhere/CHANGELOG.md`]: '# Changelog\n',
  [`${home}/.claude/skills/global/package.json`]: '{}',
}
const fs = fakeFiles(files)

async function projectWorkspace(cwd = root): Promise<Workspace> {
  return { projectRoot: root, cwd, home, fs, scope: await findProjectScope(pluginRoot, home, fs) }
}

function edit(path: string): Call {
  return { tool: 'Edit', input: { file_path: path, old_string: '#', new_string: '##' } }
}

describe('findProjectScope', () => {
  test('a plugin in <root>/.claude/skills/<name>/ of a git work tree is project-scope', async () => {
    const scope = await findProjectScope(pluginRoot, home, fs)
    expect(await scope?.workTreeOf(`${root}/src/a.ts`)).toBe(root)
  })

  test('a linked worktree of the same repository is part of the project', async () => {
    const scope = await findProjectScope(pluginRoot, home, fs)
    expect(await scope?.workTreeOf(`${root}/worktrees/design/CHANGELOG.md`)).toBe(`${root}/worktrees/design`)
  })

  test('a path in a different repository, or in no repository, is outside the project', async () => {
    const scope = await findProjectScope(pluginRoot, home, fs)
    expect(await scope?.workTreeOf(`${home}/elsewhere/CHANGELOG.md`)).toBeUndefined()
    expect(await scope?.workTreeOf(`${root}/vendor/lib/index.ts`)).toBeUndefined()
    expect(await scope?.workTreeOf('/tmp/x')).toBeUndefined()
  })

  test('a work tree whose layout cannot be read is not part of the project', async () => {
    const scope = await findProjectScope(pluginRoot, home, fs)
    expect(await scope?.workTreeOf(`${root}/worktrees/broken/a.ts`)).toBeUndefined()
  })

  test('a root whose layout cannot be read makes the project that root alone', async () => {
    const brokenRoot = fakeFiles({ '/repo/.git': 'not a git file\n', '/repo/.claude/skills/p/package.json': '{}' })
    const scope = await findProjectScope('/repo/.claude/skills/p', home, brokenRoot)
    expect(await scope?.workTreeOf('/repo/src/a.ts')).toBe('/repo')
  })

  test('other plugins act everywhere', async () => {
    expect(await findProjectScope(`${home}/.claude/skills/global`, home, fs)).toBeUndefined()
    expect(await findProjectScope(`${home}/.claude/plugins/cache/x/y`, home, fs)).toBeUndefined()
    expect(await findProjectScope('/tmp/no-repo/.claude/skills/p', home, fakeFiles({ '/tmp/no-repo/.claude/skills/p/package.json': '{}' }))).toBeUndefined()
  })
})

describe('a project-scope plugin acts only on its own repository', () => {
  test("a path in <root>/worktrees/design/CHANGELOG.md matches write: 'CHANGELOG.md' relative to the design worktree, and ~/elsewhere/CHANGELOG.md does not", async () => {
    const rules: PermissionRules<null> = { deny: [{ write: 'CHANGELOG.md' }] }
    const workspace = await projectWorkspace()
    expect(await decidePermission(rules, edit(`${root}/worktrees/design/CHANGELOG.md`), workspace, null, (run) => Promise.resolve(run()))).toEqual({ decision: 'deny' })
    expect(await decidePermission(rules, edit(`${home}/elsewhere/CHANGELOG.md`), workspace, null, (run) => Promise.resolve(run()))).toBeUndefined()
    expect(await decidePermission(rules, edit(`${root}/CHANGELOG.md`), workspace, null, (run) => Promise.resolve(run()))).toEqual({ decision: 'deny' })
    expect(await decidePermission(rules, edit(`${root}/docs/CHANGELOG.md`), workspace, null, (run) => Promise.resolve(run()))).toBeUndefined()
  })

  test('a glob that matches anywhere still matches only inside the project', async () => {
    const rules: PermissionRules<null> = { deny: [{ read: '**/.env' }] }
    const workspace = await projectWorkspace()
    expect(await decidePermission(rules, { tool: 'Read', input: { file_path: `${root}/app/.env` } }, workspace, null, (run) => Promise.resolve(run()))).toEqual({ decision: 'deny' })
    expect(await decidePermission(rules, { tool: 'Read', input: { file_path: `${home}/elsewhere/.env` } }, workspace, null, (run) => Promise.resolve(run()))).toBeUndefined()
  })

  test('a command rule matches only a command that runs in the project', async () => {
    const rules: PermissionRules<null> = { deny: [{ command: ['bun add', 'git push --force'] }] }
    const workspace = await projectWorkspace()
    const bash = (command: string): Call => ({ tool: 'Bash', input: { command } })
    expect(await decidePermission(rules, bash('bun add zod'), workspace, null, (run) => Promise.resolve(run()))).toEqual({ decision: 'deny' })
    expect(await decidePermission(rules, bash('cd worktrees/design && bun add zod'), workspace, null, (run) => Promise.resolve(run()))).toEqual({ decision: 'deny' })
    expect(await decidePermission(rules, bash('cd ~/elsewhere && bun add zod'), workspace, null, (run) => Promise.resolve(run()))).toBeUndefined()
    expect(await decidePermission(rules, bash(`git -C ${home}/elsewhere push --force`), workspace, null, (run) => Promise.resolve(run()))).toBeUndefined()
    expect(await decidePermission(rules, bash(`git -C ${root}/worktrees/design push --force`), workspace, null, (run) => Promise.resolve(run()))).toEqual({ decision: 'deny' })
  })

  test("a project-scope command '*' rule leaves a command in another repository alone", async () => {
    const rules: PermissionRules<null> = { ask: [{ command: '*' }] }
    const bash = (command: string): Call => ({ tool: 'Bash', input: { command } })
    expect(await decidePermission(rules, bash(`git -C ${home}/elsewhere status`), await projectWorkspace(), null, (run) => Promise.resolve(run()))).toBeUndefined()
    expect(await decidePermission(rules, bash('ls'), await projectWorkspace(`${home}/elsewhere`), null, (run) => Promise.resolve(run()))).toBeUndefined()
    expect(await decidePermission(rules, bash('eval "$x"'), await projectWorkspace(`${home}/elsewhere`), null, (run) => Promise.resolve(run()))).toBeUndefined()
    expect(await decidePermission(rules, bash(`git -C ${root}/worktrees/design status`), await projectWorkspace(`${home}/elsewhere`), null, (run) => Promise.resolve(run()))).toEqual({ decision: 'ask' })
    expect(await decidePermission(rules, bash('ls'), await projectWorkspace(), null, (run) => Promise.resolve(run()))).toEqual({ decision: 'ask' })
  })

  test('a project-scope read or write rule leaves an unparsed line in another repository alone', async () => {
    const rules: PermissionRules<null> = { deny: [{ read: '**/.env' }, { write: 'CHANGELOG.md' }] }
    const bash = (command: string): Call => ({ tool: 'Bash', input: { command } })
    expect(await decidePermission(rules, bash('f=.env; cat "$f"'), await projectWorkspace(`${home}/elsewhere`), null, (run) => Promise.resolve(run()))).toBeUndefined()
    expect(await decidePermission(rules, bash('f=CHANGELOG.md; echo x > "$f"'), await projectWorkspace(`${home}/elsewhere`), null, (run) => Promise.resolve(run()))).toBeUndefined()
    expect(await decidePermission(rules, bash('f=.env; cat "$f"'), await projectWorkspace(), null, (run) => Promise.resolve(run()))).toEqual({ decision: 'deny' })
    expect(await decidePermission(rules, bash('f=CHANGELOG.md; echo x > "$f"'), await projectWorkspace(), null, (run) => Promise.resolve(run()))).toEqual({ decision: 'deny' })
  })
})
