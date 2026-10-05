import { describe, expect, test } from 'bun:test'
import { decidePermission, type PermissionRules } from '../../../src/jobs/permissions/decide-permission.js'
import { findProjectScope, type Workspace } from '../../../src/jobs/permissions/find-project-scope.js'
import type { ToolUse } from '../../../src/utils/call-effects.js'
import { fakeFiles } from '../../../src/utils/fake-files.js'

const home = '/Users/jordan'
const root = '/work/dent'
const pluginRoot = `${root}/.claude/skills/dent`
const files = {
  [`${root}/.git/HEAD`]: 'ref: refs/heads/main\n',
  [`${root}/.git/worktrees/design/commondir`]: '../..\n',
  [`${root}/worktrees/design/.git`]: `gitdir: ${root}/.git/worktrees/design\n`,
  [`${root}/worktrees/design/Domain.md`]: '# Domain\n',
  [`${root}/worktrees/broken/.git`]: 'not a git file\n',
  [`${root}/vendor/lib/.git/HEAD`]: 'ref: refs/heads/main\n',
  [`${root}/Domain.md`]: '# Domain\n',
  [`${pluginRoot}/package.json`]: '{}',
  [`${home}/dotfiles/.git/HEAD`]: 'ref: refs/heads/master\n',
  [`${home}/dotfiles/Domain.md`]: '# Domain\n',
  [`${home}/.claude/skills/global/package.json`]: '{}',
}
const fs = fakeFiles(files)

async function dentWorkspace(cwd = root): Promise<Workspace> {
  return { root, cwd, home, fs, scope: await findProjectScope(pluginRoot, home, fs) }
}

function edit(path: string): ToolUse {
  return { tool: 'Edit', input: { file_path: path, old_string: '#', new_string: '##' } }
}

describe('findProjectScope', () => {
  test('a plugin in <root>/.claude/skills/<name>/ of a git work tree is project-scope', async () => {
    const scope = await findProjectScope(pluginRoot, home, fs)
    expect(await scope?.workTreeOf(`${root}/src/a.ts`)).toBe(root)
  })

  test('a linked worktree of the same repository is part of the project', async () => {
    const scope = await findProjectScope(pluginRoot, home, fs)
    expect(await scope?.workTreeOf(`${root}/worktrees/design/Domain.md`)).toBe(`${root}/worktrees/design`)
  })

  test('a path in a different repository, or in no repository, is outside the project', async () => {
    const scope = await findProjectScope(pluginRoot, home, fs)
    expect(await scope?.workTreeOf(`${home}/dotfiles/Domain.md`)).toBeUndefined()
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
  test("a path in <root>/worktrees/design/Domain.md matches write: 'Domain.md' relative to the design worktree, and /Users/jordan/dotfiles/Domain.md does not", async () => {
    const rules: PermissionRules<null> = { deny: [{ write: 'Domain.md' }] }
    const workspace = await dentWorkspace()
    expect(await decidePermission(rules, edit(`${root}/worktrees/design/Domain.md`), workspace, () => null)).toEqual({ decision: 'deny' })
    expect(await decidePermission(rules, edit(`${home}/dotfiles/Domain.md`), workspace, () => null)).toBeUndefined()
    expect(await decidePermission(rules, edit(`${root}/Domain.md`), workspace, () => null)).toEqual({ decision: 'deny' })
    expect(await decidePermission(rules, edit(`${root}/docs/Domain.md`), workspace, () => null)).toBeUndefined()
  })

  test('a glob that matches anywhere still matches only inside the project', async () => {
    const rules: PermissionRules<null> = { deny: [{ read: '**/.env' }] }
    const workspace = await dentWorkspace()
    expect(await decidePermission(rules, { tool: 'Read', input: { file_path: `${root}/app/.env` } }, workspace, () => null)).toEqual({ decision: 'deny' })
    expect(await decidePermission(rules, { tool: 'Read', input: { file_path: `${home}/dotfiles/.env` } }, workspace, () => null)).toBeUndefined()
  })

  test('a command rule matches only a command that runs in the project', async () => {
    const rules: PermissionRules<null> = { deny: [{ command: ['bun add', 'git push --force'] }] }
    const workspace = await dentWorkspace()
    const bash = (command: string): ToolUse => ({ tool: 'Bash', input: { command } })
    expect(await decidePermission(rules, bash('bun add zod'), workspace, () => null)).toEqual({ decision: 'deny' })
    expect(await decidePermission(rules, bash('cd worktrees/design && bun add zod'), workspace, () => null)).toEqual({ decision: 'deny' })
    expect(await decidePermission(rules, bash('cd ~/dotfiles && bun add zod'), workspace, () => null)).toBeUndefined()
    expect(await decidePermission(rules, bash(`git -C ${home}/dotfiles push --force`), workspace, () => null)).toBeUndefined()
    expect(await decidePermission(rules, bash(`git -C ${root}/worktrees/design push --force`), workspace, () => null)).toEqual({ decision: 'deny' })
  })

  test("a project-scope command '*' rule leaves a command in another repository alone", async () => {
    const rules: PermissionRules<null> = { ask: [{ command: '*' }] }
    const bash = (command: string): ToolUse => ({ tool: 'Bash', input: { command } })
    expect(await decidePermission(rules, bash(`git -C ${home}/dotfiles status`), await dentWorkspace(), () => null)).toBeUndefined()
    expect(await decidePermission(rules, bash('ls'), await dentWorkspace(`${home}/dotfiles`), () => null)).toBeUndefined()
    expect(await decidePermission(rules, bash('eval "$x"'), await dentWorkspace(`${home}/dotfiles`), () => null)).toBeUndefined()
    expect(await decidePermission(rules, bash(`git -C ${root}/worktrees/design status`), await dentWorkspace(`${home}/dotfiles`), () => null)).toEqual({ decision: 'ask' })
    expect(await decidePermission(rules, bash('ls'), await dentWorkspace(), () => null)).toEqual({ decision: 'ask' })
  })

  test('a project-scope read or write rule leaves an unparsed line in another repository alone', async () => {
    const rules: PermissionRules<null> = { deny: [{ read: '**/.env' }, { write: 'Domain.md' }] }
    const bash = (command: string): ToolUse => ({ tool: 'Bash', input: { command } })
    expect(await decidePermission(rules, bash('f=.env; cat "$f"'), await dentWorkspace(`${home}/dotfiles`), () => null)).toBeUndefined()
    expect(await decidePermission(rules, bash('f=Domain.md; echo x > "$f"'), await dentWorkspace(`${home}/dotfiles`), () => null)).toBeUndefined()
    expect(await decidePermission(rules, bash('f=.env; cat "$f"'), await dentWorkspace(), () => null)).toEqual({ decision: 'deny' })
    expect(await decidePermission(rules, bash('f=Domain.md; echo x > "$f"'), await dentWorkspace(), () => null)).toEqual({ decision: 'deny' })
  })
})
