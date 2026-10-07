import { describe, expect, test } from 'bun:test'
import { decidePermission, stricterVerdict, type PermissionRules } from '../../../src/jobs/permissions/decide-permission.js'
import type { Workspace } from '../../../src/jobs/permissions/find-project-scope.js'
import type { ToolCall } from '../../../src/utils/call-effects.js'
import { fakeFiles } from '../../../src/testing/fake-files.js'

type TestMod = { name: string }

const mod: TestMod = { name: 'test-mod' }
const cwd = '/work/app'
const home = '/Users/me'
const readers = new Set(['cat', 'grep', 'ls', 'head'])
const allowListOnly = (call: { isFullyParsed: boolean; commands: [string, ...string[]][] }) =>
  !(call.isFullyParsed && call.commands.every(([program]) => readers.has(program)))

function workspaceWith(files: Record<string, string> = {}, links: Record<string, string> = {}): Workspace {
  const fs = fakeFiles(files, links)
  return { projectRoot: cwd, cwd, home, fs: { ...fs, stat: (path) => fs.stat(path, { resolve: true }) }, scope: undefined }
}

function bash(command: string): ToolCall {
  return { tool: 'Bash', input: { command } }
}

function decide(rules: PermissionRules<TestMod>, use: ToolCall, workspace = workspaceWith()) {
  return decidePermission(rules, use, workspace, () => mod)
}

function seenCalls(): { calls: ToolCall[]; when: (call: ToolCall) => boolean } {
  const calls: ToolCall[] = []
  return { calls, when: (call) => (calls.push(call), true) }
}

describe('the named behaviors', () => {
  test("eval \"$x\" is not fully parsed, and deny: [{ command: '*', when: allowListOnly }] denies it", async () => {
    const rules: PermissionRules<TestMod> = { deny: [{ command: '*', when: allowListOnly, reason: 'Readers only.' }] }
    expect(await decide(rules, bash('eval "$x"'))).toEqual({ decision: 'deny', reason: 'Readers only.' })
    expect(await decide(rules, bash('cat a | grep b'))).toBeUndefined()
  })

  test('cd app && sed -i s/a/b/ ../Domain.md writes <cwd>/Domain.md', async () => {
    const seen = seenCalls()
    await decide({ deny: [{ write: 'Domain.md', when: seen.when }] }, bash('cd app && sed -i s/a/b/ ../Domain.md'))
    expect(seen.calls).toEqual([{ tool: 'Bash', input: { command: 'cd app && sed -i s/a/b/ ../Domain.md' }, path: '/work/app/Domain.md' }])
  })

  test("cat .e* does not match read: '**/.env', and cat .env does", async () => {
    const rules: PermissionRules<TestMod> = { deny: [{ read: '**/.env' }] }
    expect(await decide(rules, bash('cat .e*'))).toBeUndefined()
    expect(await decide(rules, bash('cat .env'))).toEqual({ decision: 'deny' })
  })

  test("f=.env; cat \"$f\" is denied by read: '**/.env'", async () => {
    expect(await decide({ deny: [{ read: '**/.env' }] }, bash('f=.env; cat "$f"'))).toEqual({ decision: 'deny' })
  })

  test("echo .env | xargs cat is denied by read: '**/.env'", async () => {
    expect(await decide({ deny: [{ read: '**/.env' }] }, bash('echo .env | xargs cat'))).toEqual({ decision: 'deny' })
  })

  test('an Edit with replace_all: true produces the whole new file as content', async () => {
    const seen = seenCalls()
    const workspace = workspaceWith({ '/work/app/a.ts': 'let a = 1\nlet b = a + a\n' })
    const edit: ToolCall = { tool: 'Edit', input: { file_path: '/work/app/a.ts', old_string: 'a', new_string: 'x', replace_all: true } }
    await decide({ deny: [{ write: '**/*.ts', when: seen.when }] }, edit, workspace)
    expect(seen.calls).toEqual([{ ...edit, path: '/work/app/a.ts', content: 'let x = 1\nlet b = x + x\n', previousContent: 'let a = 1\nlet b = a + a\n' }])
  })

  test('a deny and an ask that both match return deny', async () => {
    const rules: PermissionRules<TestMod> = { ask: [{ command: 'git push', reason: 'Ask first.' }], deny: [{ command: 'git push --force', reason: 'Never force.' }] }
    expect(await decide(rules, bash('git push --force origin main'))).toEqual({ decision: 'deny', reason: 'Never force.' })
    expect(await decide(rules, bash('git push origin main'))).toEqual({ decision: 'ask', reason: 'Ask first.' })
  })

  test("when that throws gives the rule's own decision", async () => {
    const fails = () => {
      throw new Error('git status timed out')
    }
    expect(await decide({ deny: [{ command: 'git', when: fails, reason: 'No git.' }] }, bash('git status'))).toEqual({
      decision: 'deny',
      reason: 'No git. Its when check failed: git status timed out',
    })
    expect(await decide({ ask: [{ command: 'git', when: async () => Promise.reject(new Error('late')) }] }, bash('git status'))).toEqual({
      decision: 'ask',
      reason: 'Its when check failed: late',
    })
  })
})

describe('command targets', () => {
  test.each([
    ['git push --force', 'git push --force origin main', true],
    ['git push --force', 'git -C ../repo push origin main --force', true],
    ['git push --force', 'git push --force-with-lease', false],
    ['git push --force', 'git push origin main', false],
    ['git push', 'git log --oneline', false],
    ['rm -f', 'rm -rf build', true],
    ['rm -rf', 'rm -r -f build', true],
    ['rm -f', 'rm -- -f', false],
    ['bun add', 'bun add zod', true],
    ['bun add', 'bunx add', false],
    ['bun add', 'cd app && sudo bun add zod', true],
    ['git commit', 'git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)"', true],
    ['node', '/usr/local/bin/node -v', true],
    ['node', 'command -v node', false],
    ['php artisan', 'php artisan migrate', true],
  ])('%p matches %p: %p', async (pattern, line, isMatched) => {
    const verdict = await decide({ deny: [{ command: pattern }] }, bash(line))
    expect(verdict?.decision).toBe(isMatched ? 'deny' : undefined)
  })

  test("command: '*' matches every shell line and no other tool", async () => {
    const rules: PermissionRules<TestMod> = { ask: [{ command: '*' }] }
    expect(await decide(rules, bash('ls'))).toEqual({ decision: 'ask' })
    expect(await decide(rules, { tool: 'PowerShell', input: { command: 'Get-ChildItem' } })).toEqual({ decision: 'ask' })
    expect(await decide(rules, { tool: 'Read', input: { file_path: '/work/app/a' } })).toBeUndefined()
  })

  test('the call holds every command of the line, so when can judge the pipeline', async () => {
    const seen = seenCalls()
    await decide({ deny: [{ command: 'bun test', when: seen.when }] }, bash('bun test 2>&1 | tail -5'))
    expect(seen.calls).toEqual([{ ...bash('bun test 2>&1 | tail -5'), commands: [['bun', 'test'], ['tail', '-5']], isFullyParsed: true }])
  })

  test('a line the job cannot parse matches a command rule when it contains each word of the rule', async () => {
    const rules: PermissionRules<TestMod> = { deny: [{ command: 'git push' }] }
    expect(await decide(rules, bash('eval "git push origin"'))).toEqual({ decision: 'deny' })
    expect(await decide(rules, bash('eval "git pushx"'))).toBeUndefined()
    expect(await decide(rules, { tool: 'PowerShell', input: { command: 'git push origin' } })).toEqual({ decision: 'deny' })
  })
})

describe('path targets', () => {
  test.each([
    [{ tool: 'Read', input: { file_path: '/work/app/.env' } }],
    [{ tool: 'Grep', input: { pattern: 'KEY', path: '.env' } }],
    [{ tool: 'Glob', input: { pattern: '**/.env' } }],
    [{ tool: 'Bash', input: { command: 'head -n 5 config/.env' } }],
    [{ tool: 'Bash', input: { command: 'cp .env /tmp/x' } }],
    [{ tool: 'Bash', input: { command: 'wc -l < ~/.env' } }],
  ])('a read rule covers %p', async (use) => {
    expect(await decide({ deny: [{ read: '**/.env' }] }, use)).toEqual({ decision: 'deny' })
  })

  test.each([
    [{ tool: 'Edit', input: { file_path: '/work/app/tests/budgets.json', old_string: 'a', new_string: 'b' } }],
    [{ tool: 'Write', input: { file_path: '/work/app/tests/budgets.json', content: '{}' } }],
    [{ tool: 'NotebookEdit', input: { notebook_path: '/work/app/tests/budgets.json', new_source: 'x' } }],
    [{ tool: 'Bash', input: { command: 'echo {} > tests/budgets.json' } }],
    [{ tool: 'Bash', input: { command: 'rm tests/budgets.json' } }],
    [{ tool: 'Bash', input: { command: 'mv tests/budgets.json /tmp/' } }],
    [{ tool: 'Bash', input: { command: 'cp /tmp/b.json tests/budgets.json' } }],
    [{ tool: 'Bash', input: { command: 'echo {} | tee tests/budgets.json' } }],
    [{ tool: 'Bash', input: { command: 'cd tests && sed -i s/1/2/ budgets.json' } }],
  ])('a write rule covers %p', async (use) => {
    expect(await decide({ deny: [{ write: 'tests/budgets.json' }] }, use)).toEqual({ decision: 'deny' })
  })

  test('a relative pattern is relative to the working folder of the session', async () => {
    const rules: PermissionRules<TestMod> = { deny: [{ write: 'Domain.md' }] }
    expect(await decide(rules, bash('rm Domain.md'))).toEqual({ decision: 'deny' })
    expect(await decide(rules, bash('rm docs/Domain.md'))).toBeUndefined()
    expect(await decide(rules, bash('rm /elsewhere/Domain.md'))).toBeUndefined()
  })

  test('~ and absolute patterns match their own folders', async () => {
    expect(await decide({ deny: [{ read: '~/.ssh/**' }] }, bash('cat ~/.ssh/id_ed25519'))).toEqual({ decision: 'deny' })
    expect(await decide({ deny: [{ read: '~/.ssh/**' }] }, bash('cat $HOME/.ssh/id_ed25519'))).toEqual({ decision: 'deny' })
    expect(await decide({ deny: [{ read: '/etc/**' }] }, bash('cat /etc/../etc/hosts'))).toEqual({ decision: 'deny' })
  })

  test('matches ignore case', async () => {
    expect(await decide({ deny: [{ write: 'domain.MD' }] }, bash('rm DOMAIN.md'))).toEqual({ decision: 'deny' })
  })

  test('the rule matches the real path behind a symbolic link', async () => {
    const workspace = workspaceWith({ '/vault/secrets/key': 'k' }, { '/work/app/link': '/vault/secrets' })
    expect(await decide({ deny: [{ read: '/vault/secrets/**' }] }, bash('cat link/key'), workspace)).toEqual({ decision: 'deny' })
  })

  test('a new file gets the real path of its folder plus its name', async () => {
    const seen = seenCalls()
    const workspace = workspaceWith({ '/vault/secrets/key': 'k' }, { '/work/app/link': '/vault/secrets' })
    const write: ToolCall = { tool: 'Write', input: { file_path: '/work/app/link/new/file', content: 'x' } }
    await decide({ deny: [{ write: '/vault/**', when: seen.when }] }, write, workspace)
    expect(seen.calls).toEqual([{ ...write, path: '/vault/secrets/new/file', content: 'x' }])
  })

  test('when runs once for each path that matched', async () => {
    const seen = seenCalls()
    await decide({ deny: [{ write: '**/*.ts', when: (call) => (seen.when(call), false) }] }, bash('rm a.ts b.md c.ts'))
    expect(seen.calls.map((call) => ('path' in call ? call.path : undefined))).toEqual(['/work/app/a.ts', '/work/app/c.ts'])
  })

  test('a shell write has no content', async () => {
    const seen = seenCalls()
    await decide({ deny: [{ write: '**/*.test.ts', when: seen.when }] }, bash('sed -i s/a/b/ x.test.ts'))
    expect(seen.calls).toEqual([{ ...bash('sed -i s/a/b/ x.test.ts'), path: '/work/app/x.test.ts' }])
  })

  test('a line the job cannot parse matches a path rule when it holds the last segment of the glob', async () => {
    expect(await decide({ deny: [{ read: '**/.env' }] }, bash(`python -c 'open(".env")'`))).toEqual({ decision: 'deny' })
    expect(await decide({ deny: [{ read: '**/*.pem' }] }, bash(`python -c 'open("key.pem")'`))).toBeUndefined()
    expect(await decide({ deny: [{ write: 'tests/budgets.json' }] }, bash(`python -c 'open("tests/budgets.json", "w")'`))).toEqual({ decision: 'deny' })
  })
})

describe('content of an edit', () => {
  const file = { '/work/app/a.ts': 'one two one' }

  test.each([
    [{ old_string: 'one', new_string: '1' }, { content: '1 two one', previousContent: 'one two one' }],
    [{ old_string: 'one', new_string: '$&', replace_all: true }, { content: '$& two $&', previousContent: 'one two one' }],
    [{ old_string: 'three', new_string: '3' }, { previousContent: 'one two one' }],
  ])('Edit %p gives %p', async (edit, contents) => {
    const seen = seenCalls()
    const call: ToolCall = { tool: 'Edit', input: { file_path: '/work/app/a.ts', ...edit } }
    await decide({ deny: [{ write: '**', when: seen.when }] }, call, workspaceWith(file))
    expect(seen.calls).toEqual([{ ...call, path: '/work/app/a.ts', ...contents }])
  })

  test('an Edit with an empty old_string creates a new file', async () => {
    const seen = seenCalls()
    const call: ToolCall = { tool: 'Edit', input: { file_path: '/work/app/new.ts', old_string: '', new_string: 'x' } }
    await decide({ deny: [{ write: '**', when: seen.when }] }, call)
    expect(seen.calls).toEqual([{ ...call, path: '/work/app/new.ts', content: 'x' }])
  })

  test('a Write gives the content and the previous content', async () => {
    const seen = seenCalls()
    const call: ToolCall = { tool: 'Write', input: { file_path: '/work/app/a.ts', content: 'new' } }
    await decide({ deny: [{ write: '**', when: seen.when }] }, call, workspaceWith(file))
    expect(seen.calls).toEqual([{ ...call, path: '/work/app/a.ts', content: 'new', previousContent: 'one two one' }])
  })

  test('a NotebookEdit gives only the previous content', async () => {
    const seen = seenCalls()
    const notebook = { '/work/app/n.ipynb': '{"cells":[]}' }
    const call: ToolCall = { tool: 'NotebookEdit', input: { notebook_path: '/work/app/n.ipynb', new_source: 'x' } }
    await decide({ deny: [{ write: '**', when: seen.when }] }, call, workspaceWith(notebook))
    expect(seen.calls).toEqual([{ ...call, path: '/work/app/n.ipynb', previousContent: '{"cells":[]}' }])
  })

  test('the file is not read when no rule needs its content', async () => {
    const fs = fakeFiles({ '/work/app/a.ts': 'x' })
    const workspace: Workspace = { projectRoot: cwd, cwd, home, scope: undefined, fs: { ...fs, read: () => Promise.reject(new Error('read')) } }
    expect(await decide({ deny: [{ write: '**/*.ts' }] }, { tool: 'Edit', input: { file_path: '/work/app/a.ts', old_string: 'x', new_string: 'y' } }, workspace)).toEqual({ decision: 'deny' })
  })
})

describe('other targets', () => {
  test('a fetch rule matches the WebFetch URL', async () => {
    const rules: PermissionRules<TestMod> = { deny: [{ fetch: 'https://*.internal.example/**' }] }
    expect(await decide(rules, { tool: 'WebFetch', input: { url: 'https://wiki.internal.example/a', prompt: 'x' } })).toEqual({ decision: 'deny' })
    expect(await decide(rules, { tool: 'WebFetch', input: { url: 'https://example.com/a', prompt: 'x' } })).toBeUndefined()
  })

  test('a fetch rule matches each curl and wget URL, and when runs once for each', async () => {
    const line = 'curl -s https://wiki.internal.example/a && wget -O - http://api.internal.example/b'
    expect(await decide({ deny: [{ fetch: 'https://*.internal.example/**' }] }, bash(line))).toEqual({ decision: 'deny' })
    expect(await decide({ deny: [{ fetch: 'https://*.internal.example/**' }] }, bash('curl -o out https://example.com/a'))).toBeUndefined()
    const seen = seenCalls()
    await decide({ deny: [{ fetch: '*://*.internal.example/**', when: (call) => (seen.when(call), false) }] }, bash(line))
    expect(seen.calls).toEqual([
      { ...bash(line), url: 'https://wiki.internal.example/a' },
      { ...bash(line), url: 'http://api.internal.example/b' },
    ])
  })

  test('a subagent rule matches the Agent subagent_type, general-purpose when absent', async () => {
    const rules: PermissionRules<TestMod> = { ask: [{ subagent: ['general-purpose', 'cto'] }] }
    expect(await decide(rules, { tool: 'Agent', input: { prompt: 'x', description: 'x', subagent_type: 'cto' } })).toEqual({ decision: 'ask' })
    expect(await decide(rules, { tool: 'Agent', input: { prompt: 'x', description: 'x' } })).toEqual({ decision: 'ask' })
    expect(await decide(rules, { tool: 'Agent', input: { prompt: 'x', description: 'x', subagent_type: 'Explore' } })).toBeUndefined()
  })

  test('a tool rule matches any tool name by glob, MCP tools included', async () => {
    const rules: PermissionRules<TestMod> = { deny: [{ tool: 'mcp__github__*' }] }
    expect(await decide(rules, { tool: 'mcp__github__create_issue', input: {} })).toEqual({ decision: 'deny' })
    expect(await decide(rules, { tool: 'mcp__slack__post', input: {} })).toBeUndefined()
  })
})

describe('patterns that leave calls out', () => {
  test('a ! pattern leaves its files out of a path rule', async () => {
    const rules: PermissionRules<TestMod> = { deny: [{ write: ['**', '!docs/plans/**'], reason: 'Plans only.' }] }
    expect(await decide(rules, { tool: 'Write', input: { file_path: '/work/app/docs/plans/a.md', content: 'x' } })).toBeUndefined()
    expect(await decide(rules, { tool: 'Write', input: { file_path: '/work/app/src/a.ts', content: 'x' } })).toEqual({ decision: 'deny', reason: 'Plans only.' })
    expect(await decide({ deny: [{ read: ['**/.env*', '!**/.env.example'] }] }, bash('cat .env.example'))).toBeUndefined()
    expect(await decide({ deny: [{ read: ['**/.env*', '!**/.env.example'] }] }, bash('cat .env.local'))).toEqual({ decision: 'deny' })
  })

  test('a ! command pattern leaves its commands out, and a line matches when any other command matches', async () => {
    const rules: PermissionRules<TestMod> = { ask: [{ command: ['git', '!git status', '!git log'] }] }
    expect(await decide(rules, bash('git status'))).toBeUndefined()
    expect(await decide(rules, bash('git log --oneline'))).toBeUndefined()
    expect(await decide(rules, bash('git status && git push'))).toEqual({ decision: 'ask' })
    expect(await decide({ ask: [{ command: ['*', '!ls'] }] }, bash('ls'))).toBeUndefined()
    expect(await decide({ ask: [{ command: ['*', '!ls'] }] }, bash('rm a'))).toEqual({ decision: 'ask' })
  })

  test('a ! pattern leaves URLs, subagents, and tools out', async () => {
    expect(await decide({ deny: [{ fetch: ['https://**', '!https://docs.example.com/**'] }] }, { tool: 'WebFetch', input: { url: 'https://docs.example.com/a', prompt: 'x' } })).toBeUndefined()
    expect(await decide({ deny: [{ subagent: ['*', '!explorer'] }] }, { tool: 'Agent', input: { prompt: 'x', description: 'x', subagent_type: 'explorer' } })).toBeUndefined()
    expect(await decide({ deny: [{ tool: ['mcp__github__*', '!mcp__github__get_*'] }] }, { tool: 'mcp__github__get_issue', input: {} })).toBeUndefined()
    expect(await decide({ deny: [{ tool: ['mcp__github__*', '!mcp__github__get_*'] }] }, { tool: 'mcp__github__create_issue', input: {} })).toEqual({ decision: 'deny' })
  })

  test('a target of ! patterns alone denies the call and names the fix', async () => {
    expect(await decide({ deny: [{ write: '!docs/**' }] }, bash('rm a'))).toEqual({
      decision: 'deny',
      reason: `The permissions job failed, so it denies the call: A write target needs a pattern without "!" for its "!" patterns to leave calls out of, such as ['**', '!docs/**'].`,
    })
  })
})

describe('the decision', () => {
  test('the raw input, agentId, and agentType reach when', async () => {
    const seen = seenCalls()
    const call: ToolCall = { tool: 'Read', input: { file_path: '/a' }, agentId: 'a4aa369514be1f5cc', agentType: 'explorer' }
    await decide({ deny: [{ tool: 'Read', when: seen.when }] }, call)
    expect(seen.calls).toEqual([call])
  })

  test('a when that returns false leaves the decision to the next rule', async () => {
    const rules: PermissionRules<TestMod> = { deny: [{ command: 'rm', when: () => false }], ask: [{ command: 'rm' }] }
    expect(await decide(rules, bash('rm a'))).toEqual({ decision: 'ask' })
  })

  test('no matching rule gives no decision', async () => {
    expect(await decide({ deny: [{ command: 'rm' }] }, bash('ls'))).toBeUndefined()
  })

  test('when the job fails, it denies the call', async () => {
    expect(await decide({ deny: [{ command: 'rm' }] }, { tool: 'Bash', input: {} })).toEqual({
      decision: 'deny',
      reason: 'The permissions job failed, so it denies the call: The Bash call has no text field command.',
    })
    const twoKeys = { command: 'rm', read: 'a' } as unknown as { command: string }
    expect((await decide({ deny: [twoKeys] }, bash('rm a')))?.decision).toBe('deny')
  })

  test('the stricter verdict wins: deny over ask over allow', () => {
    expect(stricterVerdict({ decision: 'allow' }, { decision: 'ask', reason: 'mod' })).toEqual({ decision: 'ask', reason: 'mod' })
    expect(stricterVerdict({ decision: 'deny', reason: 'user' }, { decision: 'ask', reason: 'mod' })).toEqual({ decision: 'deny', reason: 'user' })
    expect(stricterVerdict({ decision: 'ask', reason: 'user' }, { decision: 'ask', reason: 'mod' })).toEqual({ decision: 'ask', reason: 'user' })
  })
})
