import { expect, test } from 'bun:test'
import type { EngineInterface, HookFailure, On, RenderElement } from 'claude-code'
import { registerMod, registerPermissionCheck } from '../src/register.js'
import { commands, defineMod, sessions } from '../src/mod.js'
import { permissions } from '../src/jobs/permissions.js'
import { processEvents } from '../src/session/session.js'
import { Message } from '../src/session/context/turn/message/message.js'
import { ToolCall } from '../src/session/context/turn/message/tool-call.js'
import { conversationMethods } from '../src/runtime/sessions.js'
import { bundleDefines, scriptsSha256 } from '../src/records.js'
import { elements, textOf } from '../src/testing/fake-elements.js'
import { Text } from '../src/ui/elements.js'

type Registration = {
  readonly pattern: string
  readonly hasMatcher: boolean
  readonly hook: (...args: never[]) => unknown
  caught?: (...args: never[]) => unknown
}

function fakeOn() {
  const registrations: Registration[] = []
  const on = (pattern: unknown, matcherOrHook: unknown, hook?: unknown) => {
    if (typeof pattern !== 'string') throw new Error('the event name passed to on() is not a string literal')
    const hasMatcher = hook !== undefined
    const twin = registrations.find((registration) => registration.pattern === pattern && !registration.hasMatcher)
    if (!hasMatcher && twin !== undefined) throw new Error(`on("${pattern}") is registered twice without a matcher. Register each event once, or give the second a matcher.`)
    const registration: Registration = { pattern, hasMatcher, hook: (hasMatcher ? hook : matcherOrHook) as Registration['hook'] }
    registrations.push(registration)
    return {
      catch: (handler: (...args: never[]) => unknown) => void (registration.caught = handler),
    }
  }
  return {
    on: on as unknown as On,
    registrations,
    fail(event: string, $: EngineInterface, e: unknown, below: unknown, error: HookFailure, caller = 'engine'): Promise<unknown> {
      const caught = registrations.find((registration) => registration.pattern === event)?.caught
      if (caught === undefined) throw new Error(`on("${event}") has no .catch`)
      const next = Object.assign(async () => below, { event, error, called: false, origin: { plugin: caller } })
      return Promise.resolve((caught as (...args: unknown[]) => unknown)($, e, next))
    },
    dispatch(event: string, $: EngineInterface, e: unknown, below: unknown): Promise<unknown> {
      const chain = registrations.filter((registration) => registration.pattern === event)
      const call = async (index: number, current: unknown): Promise<unknown> => {
        const registration = chain[index]
        if (registration === undefined) return below
        const next = Object.assign((passed: unknown) => call(index + 1, passed), { event })
        return (registration.hook as (...args: unknown[]) => unknown)($, current, next)
      }
      return call(0, e)
    },
  }
}

function engine(files: Record<string, string>, env: Record<string, string> = { HOME: '/home/test' }) {
  const shown = { logs: [] as string[] }
  const store = new Map<string, unknown>()
  const under = (folder: string) => Object.keys(files).filter((path) => path.startsWith(`${folder}/`))
  const kindOf = (path: string) => (files[path] !== undefined ? 'file' : 'dir')
  const $ = {
    plugin: { name: 'demo', root: '/plugins/demo' },
    ui: {
      log: (text: string, options?: { to?: string }) => (options?.to === 'debug' ? undefined : shown.logs.push(text)),
      invalidate: () => undefined,
      resolve: () => elements,
    },
    fs: {
      exists: async (path: string) => files[path] !== undefined || under(path).length > 0,
      stat: async (path: string) => ({ kind: kindOf(path) }),
      read: async (path: string) => files[path],
      list: async (folder: string) => [...new Set(under(folder).map((path) => path.slice(folder.length + 1).split('/')[0] as string))].map((name) => ({ name, kind: kindOf(`${folder}/${name}`) })),
    },
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => store.set(key, value),
    },
    env: { get: async (name: string) => env[name] },
    session: { id: async () => 'session-1', root: async () => '/work/app', cwd: async () => '/work/app', model: async () => 'test-model', usage: async () => ({ startedAt: 0, context: { window: 200000 }, rateLimits: [] }) },
    clock: { now: async () => 0, every: () => ({ cancel: () => undefined }), after: () => ({ cancel: () => undefined }) },
  } as unknown as EngineInterface
  return { $, shown }
}

const demo = defineMod({
  name: 'demo',
  setup() {
    sessions.current.beforeToolBatch((batch) => ({ note: `demo saw ${batch.calls.map((call) => call.name).join(', ')}` }))
  },
})

const consentedSha = await scriptsSha256({ permissions: ['prompt'] }, { read: async () => undefined, list: async () => [] })

const files = {
  '/plugins/demo/.claude-plugin/plugin.json': '{ "name": "demo", "version": "1.0.0" }',
  '/plugins/demo/package.json': '{ "dependencies": { "@cmodjs/core": "^0.1.1" }, "cmod": { "permissions": { "prompt": true } } }',
  '/home/test/.local/share/cmod/consent.json': JSON.stringify({ demo: [consentedSha, 'prompt'] }),
  '/home/test/.local/share/cmod/records/demo.json': JSON.stringify({
    name: 'demo',
    version: '1.0.0',
    root: '/plugins/demo',
    installedAt: '2026-10-05T00:00:00.000Z',
    scriptsSha256: consentedSha,
    uninstall: null,
    program: null,
  }),
}

test('registerMod registers each Claude Code event once, and no permission check', () => {
  const fake = fakeOn()

  registerMod(fake.on, demo, {})

  expect(fake.registrations.map((registration) => registration.pattern)).toEqual([
    'session.start',
    'classic.Setup',
    'classic.SessionStart',
    'classic.SessionEnd',
    'classic.UserPromptSubmit',
    'classic.UserPromptExpansion',
    'classic.InstructionsLoaded',
    'classic.ConfigChange',
    'classic.DirectoryAdded',
    'classic.PreModelSwitch',
    'classic.PostModelSwitch',
    'classic.PermissionDenied',
    'classic.PostToolUse',
    'classic.PostToolUseFailure',
    'classic.PostToolBatch',
    'classic.MessageDisplay',
    'classic.SubagentStart',
    'classic.SubagentStop',
    'classic.TaskCreated',
    'classic.TaskCompleted',
    'classic.TeammateIdle',
    'classic.Elicitation',
    'classic.ElicitationResult',
    'classic.Notification',
    'classic.PreCompact',
    'classic.PostCompact',
    'classic.Stop',
    'classic.StopFailure',
    'classic.FileChanged',
    'classic.WorktreeCreate',
    'classic.WorktreeRemove',
    'tool.call',
    'prompt.submit',
    'prompt.context',
    'command.run',
    'session.measure',
    'skill.prompt',
    'ui.render',
    'ui.press',
    'ui.scroll',
    'ui.close',
    'cmod.call',
    'session.compact',
  ])
})

test('registerPermissionCheck registers tool.check and PermissionRequest once each', () => {
  const fake = fakeOn()

  registerMod(fake.on, demo, {})
  registerPermissionCheck(fake.on)

  expect(fake.registrations.map((registration) => registration.pattern).slice(-2)).toEqual(['tool.check', 'classic.PermissionRequest'])
})

test('every hook registerMod and registerPermissionCheck add after session.start carries a .catch', () => {
  const fake = fakeOn()

  registerMod(fake.on, demo, {})
  registerPermissionCheck(fake.on)

  expect(fake.registrations.filter((registration) => registration.caught === undefined).map((registration) => registration.pattern)).toEqual(['session.start'])
})

test('a hook Claude Code stopped shows its failure, and the event goes on as if the mod were not there', async () => {
  const fake = fakeOn()
  const { $ } = engine(files)
  await $.store.set('cmod:announced', { version: '1.0.0', added: [] })
  registerMod(fake.on, demo, {})
  await fake.dispatch('session.start', $, {}, {})
  const below = { additionalContext: ['from below'] }

  let redraws = 0
  Object.assign($.ui, { invalidate: () => void (redraws += 1) })

  const timedOut = await fake.fail('classic.PostToolBatch', $, {}, below, { kind: 'timeout', budget: 1000 })
  const drawnOnce = redraws
  await fake.fail('classic.PostToolBatch', $, {}, below, { kind: 'timeout', budget: 1000 })
  const reentered = await fake.fail('classic.Stop', $, {}, below, ({ kind: 're-entry', budget: 1000 } as unknown as HookFailure))
  const shown = textOf((await fake.dispatch('ui.render', $, abovePrompt, prompt)) as RenderElement)

  expect([timedOut, reentered]).toEqual([below, below])
  expect([drawnOnce > 0, redraws]).toEqual([true, drawnOnce])
  expect(shown).toContain('Claude Code stopped its PostToolBatch hook')
  expect(shown).not.toContain('Stop hook')
})

test('a before ask that reaches the mod inside its own hook answers nothing and shows no failure', async () => {
  const fake = fakeOn()
  const { $ } = engine(files)
  const guard = defineMod({ name: 'demo', setup: () => void sessions.current.beforeToolCall(() => undefined, { onFailure: 'refuse' }) })
  registerMod(fake.on, guard, {})
  await fake.dispatch('session.start', $, {}, {})
  const ask = { to: 'demo', method: conversationMethods.before, input: { session: 'session-1', event: ToolCall, change: { type: Message, message: { id: 't1', at: '', type: ToolCall, session: 'session-1', context: 1, callId: 't1', name: 'Bash', input: {}, cwd: '/work/app', files: { read: [], changed: [] } } } } }

  expect(await fake.fail('cmod.call', $, ask, { deny: 'unanswered' }, ({ kind: 're-entry', budget: 1000 } as unknown as HookFailure), 'cmod')).toEqual({ value: null })
  expect(textOf((await fake.dispatch('ui.render', $, abovePrompt, prompt)) as RenderElement)).not.toContain('stopped')
})

test('a permission check, a permission dialog, or a command whose hook Claude Code stopped is refused in its own answer, and the permissions job denies', async () => {
  const fake = fakeOn()
  const { $ } = engine(files)
  Object.assign($, { command: { list: async () => [{ name: 'deploy', source: 'plugin' }] } })
  const guard = defineMod({
    name: 'demo',
    setup() {
      sessions.current.beforePermissionCheck({ name: 'Bash', decision: 'allow' }, () => undefined, { onFailure: 'refuse' })
      sessions.current.beforePermissionRequest(() => undefined)
      commands.beforeRun({ name: 'deploy', source: 'plugin' }, () => undefined, { onFailure: 'refuse' })
    },
  })
  registerMod(fake.on, guard, {})
  registerPermissionCheck(fake.on)
  await fake.dispatch('session.start', $, {}, {})
  const stopped: HookFailure = { kind: 'timeout', budget: 1000 }
  const checked = (tool: string) => ({ tool, input: {}, tool_use_id: 'toolu_1' })

  expect(await fake.fail('tool.check', $, checked('Bash'), { decision: 'allow' }, stopped)).toEqual({ decision: 'deny', reason: 'demo: it ran past the 10 s Claude Code gives a hook' })
  expect(await fake.fail('tool.check', $, checked('Read'), { decision: 'allow' }, stopped)).toEqual({ decision: 'allow' })
  expect(await fake.fail('classic.PermissionRequest', $, { session_id: 'session-1', cwd: '/work/app', tool_name: 'Bash', tool_input: {} }, {}, stopped)).toEqual({ decision: { behavior: 'deny', message: 'demo: it ran past the 10 s Claude Code gives a hook' } })
  expect(await fake.fail('command.run', $, { command: 'deploy', args: '', origin: { kind: 'composer' } }, { text: 'Deployed' }, stopped)).toEqual({ text: 'demo: it ran past the 10 s Claude Code gives a hook' })
  expect(await fake.fail('command.run', $, { command: 'status', args: '', origin: { kind: 'composer' } }, { text: 'Clean' }, stopped)).toEqual({ text: 'Clean' })
})

test('a permissions job whose hook Claude Code stopped denies the call', async () => {
  const fake = fakeOn()
  const { $ } = engine(files)
  registerMod(fake.on, defineMod({ name: 'demo', setup: (mod) => mod.use(permissions({ deny: [{ command: 'git push --force' }] })) }), {})
  registerPermissionCheck(fake.on)
  await fake.dispatch('session.start', $, {}, {})

  expect(await fake.fail('tool.check', $, { tool: 'Read', input: {}, tool_use_id: 'toolu_1' }, { decision: 'allow' }, { kind: 'throw', message: 'its hooks worker ended', budget: 1000 })).toEqual({
    decision: 'deny',
    reason: 'Claude Code stopped the permissions job of demo, so it denies the call: its hooks worker ended',
  })
})

test("a before ask whose hook Claude Code stopped still refuses for a listener with onFailure: 'refuse'", async () => {
  const fake = fakeOn()
  const { $ } = engine(files)
  Object.assign($, { cmod: { call: async () => null } })
  const guard = defineMod({
    name: 'demo',
    setup() {
      sessions.current.beforeToolCall({ name: 'Bash' }, () => undefined, { onFailure: 'refuse' })
      sessions.current.beforeToolCall({ name: 'Read' }, () => undefined)
    },
  })
  registerMod(fake.on, guard, {})
  await fake.dispatch('session.start', $, {}, {})
  const ask = (name: string) => ({ to: 'demo', method: conversationMethods.before, input: { session: 'session-1', event: ToolCall, change: { type: Message, message: { id: 't1', at: '', type: ToolCall, session: 'session-1', context: 1, callId: 't1', name, input: {}, cwd: '/work/app', files: { read: [], changed: [] } } } } })

  const bash = await fake.fail('cmod.call', $, ask('Bash'), { deny: 'unanswered' }, { kind: 'throw', message: 'boom', budget: 1000 }, 'cmod')
  const read = await fake.fail('cmod.call', $, ask('Read'), { deny: 'unanswered' }, { kind: 'throw', message: 'boom', budget: 1000 }, 'cmod')

  expect([bash, read]).toEqual([{ value: { refuse: 'demo: boom' } }, { value: null }])
})

test("a model switch whose hook Claude Code stopped is refused for a beforeModelChange listener with onFailure: 'refuse'", async () => {
  const fake = fakeOn()
  const { $ } = engine(files)
  const keepsOpus = defineMod({ name: 'demo', setup: () => void sessions.current.beforeModelChange({ model: /haiku/ }, () => undefined, { onFailure: 'refuse' }) })
  registerMod(fake.on, keepsOpus, {})
  await fake.dispatch('session.start', $, {}, {})
  const switched = (to_model: string) => ({ session_id: 'session-1', cwd: '/work/app', from_model: 'opus', to_model, source: 'command', context_tokens: 0, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 0 })

  const toHaiku = await fake.fail('classic.PreModelSwitch', $, switched('haiku'), {}, { kind: 'timeout', budget: 1000 })
  const toSonnet = await fake.fail('classic.PreModelSwitch', $, switched('sonnet'), {}, { kind: 'timeout', budget: 1000 })

  expect([toHaiku, toSonnet]).toEqual([{ permissionDecision: 'deny', permissionDecisionReason: 'demo: it ran past the 10 s Claude Code gives a hook' }, {}])
})

test('session.start through the engine chain reads the plugin, runs setup, and announces the mod once', async () => {
  const fake = fakeOn()
  const { $, shown } = engine(files)
  registerMod(fake.on, demo, {})

  await fake.dispatch('session.start', $, {}, {})
  const answer = await fake.dispatch('classic.PostToolBatch', $, { hook_event_name: 'PostToolBatch', session_id: 'session-1', cwd: '/work/app', tool_calls: [{ tool_name: 'Edit', tool_input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, tool_response: {}, tool_use_id: 't' }] }, {})

  expect(answer).toEqual({ additionalContext: ['<demo_mod>\ndemo saw Edit\n</demo_mod>'] })
  expect(textOf((await fake.dispatch('ui.render', $, abovePrompt, prompt)) as RenderElement)).toStartWith('>\n✓  demo  Installed')
  expect(shown.logs).toEqual([])
})

test('a mod starts while the plugins below it start, so its start can wait on one of them', async () => {
  const fake = fakeOn()
  const { $ } = engine(files)
  let startBelow = () => undefined as void
  const isBelowStarted = new Promise<void>((resolve) => (startBelow = resolve))
  registerMod(fake.on, defineMod({ name: 'demo', setup: () => isBelowStarted }), {})
  fake.registrations.push({ pattern: 'session.start', hasMatcher: false, hook: (_$: never, e: never, next: (e: unknown) => unknown) => (startBelow(), next(e)) })

  await fake.dispatch('session.start', $, {}, {})

  expect(textOf((await fake.dispatch('ui.render', $, abovePrompt, prompt)) as RenderElement)).toStartWith('>\n✓  demo  Installed')
})

test('a pane opened during setup is drawn again once the mod is active', async () => {
  const fake = fakeOn()
  const { $ } = engine(files)
  const drawn: unknown[] = []
  const redraws: string[] = []
  Object.assign($.ui, {
    open: async () => {
      drawn.push(await fake.dispatch('ui.render', $, { surface: 'terminal', component: 'Pane', requestId: 'files', props: { id: 'files' } }, undefined))
      return { isPlaced: true }
    },
    invalidate: (event: string) => redraws.push(event),
    panes: async () => [],
  })
  const opensPane = defineMod({
    name: 'demo',
    async setup(mod) {
      await mod.ui.pane({ id: 'files', title: 'Files', render: () => Text({ children: 'src/' }) }).open()
    },
  })
  registerMod(fake.on, opensPane, {})

  await fake.dispatch('session.start', $, {}, {})

  expect(drawn).toEqual([undefined])
  expect(redraws).toContain('ui.render')
})

test('a mod that draws nothing hands the claude drawing back unchanged', async () => {
  const fake = fakeOn()
  const { $ } = engine(files)
  await $.store.set('cmod:announced', '1.0.0')
  registerMod(fake.on, demo, {})
  await fake.dispatch('session.start', $, {}, {})

  const drawn = await fake.dispatch('ui.render', $, abovePrompt, prompt)

  expect(drawn).toBe(prompt)
})

const abovePrompt = { surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false } }

const prompt = { type: 'Text', children: ['>'] }

const modSkill = { '/plugins/demo/skills/architecture-diagram/SKILL.md': '---\nname: architecture-diagram\n---\nThe mod text.\n' }

const userSkill = { '/home/test/.claude/cmods/demo/skills/architecture-diagram/SKILL.md': '---\nname: architecture-diagram\ndescription: My diagrams\n---\nMy own diagram rules.\n' }

async function registeredDemo(skillFiles: Record<string, string>, env?: Record<string, string>) {
  const fake = fakeOn()
  const all: Record<string, string> = { ...files, ...skillFiles }
  const { $ } = engine(all, env)
  registerMod(fake.on, demo, {})
  await fake.dispatch('session.start', $, {}, {})
  const expand = (skill: string, below: { text: string } = { text: `${baseLine}The mod text.\n` }) => fake.dispatch('skill.prompt', $, { skill, text: below.text }, below)
  return { expand, files: all }
}

const baseLine = 'Base directory for this skill: /plugins/demo/skills/architecture-diagram\n\n'

test("a Skill file in the mod's config folder replaces the Skill's text, without its frontmatter", async () => {
  const { expand } = await registeredDemo({ ...modSkill, ...userSkill })

  expect(await expand('demo:architecture-diagram')).toEqual({ text: `${baseLine}My own diagram rules.\n` })
})

test('the replacement keeps the base directory line', async () => {
  const { expand } = await registeredDemo({ ...modSkill, ...userSkill })

  const answer = (await expand('demo:architecture-diagram')) as { text: string }

  expect(answer.text.startsWith('Base directory for this skill: /plugins/demo/skills/architecture-diagram\n\n')).toBe(true)
})

test("without a file the Skill keeps the mod's text", async () => {
  const { expand } = await registeredDemo(modSkill)
  const below = { text: `${baseLine}The mod text.\n` }

  expect(await expand('demo:architecture-diagram', below)).toBe(below)
})

test("deleting the Skill file brings the mod's text back on the next expansion", async () => {
  const { expand, files: all } = await registeredDemo({ ...modSkill, ...userSkill })
  expect(await expand('demo:architecture-diagram')).toEqual({ text: `${baseLine}My own diagram rules.\n` })
  delete all['/home/test/.claude/cmods/demo/skills/architecture-diagram/SKILL.md']
  const below = { text: `${baseLine}The mod text.\n` }

  expect(await expand('demo:architecture-diagram', below)).toBe(below)
})

test('a Skill of another plugin with the same name is not replaced', async () => {
  const { expand } = await registeredDemo({ ...modSkill, ...userSkill })
  const below = { text: 'The other plugin text.' }

  expect(await expand('other:architecture-diagram', below)).toBe(below)
})

test('a Skill file for a Skill the mod does not ship replaces nothing', async () => {
  const { expand } = await registeredDemo({ ...modSkill, '/home/test/.claude/cmods/demo/skills/commit/SKILL.md': 'My own commit rules.\n' })
  const below = { text: 'The commit text.' }

  expect(await expand('demo:commit', below)).toBe(below)
})

test('a bare Skill name is never replaced', async () => {
  const { expand } = await registeredDemo({ ...modSkill, ...userSkill })
  const below = { text: 'A Skill of the same name from the user or a project.' }

  expect(await expand('architecture-diagram', below)).toBe(below)
})

test('a project Skill file overrides the system Skill file', async () => {
  const { expand } = await registeredDemo({ ...modSkill, ...userSkill, '/work/app/.claude/cmods/demo/skills/architecture-diagram/SKILL.md': 'The team diagram rules.\n' })

  expect(await expand('demo:architecture-diagram')).toEqual({ text: `${baseLine}The team diagram rules.\n` })
})

test('CLAUDE_CONFIG_DIR moves the system tier', async () => {
  const { expand } = await registeredDemo(
    { ...modSkill, ...userSkill, '/profiles/work/cmods/demo/skills/architecture-diagram/SKILL.md': 'Rules from the work profile.\n' },
    { HOME: '/home/test', CLAUDE_CONFIG_DIR: '/profiles/work' },
  )

  expect(await expand('demo:architecture-diagram')).toEqual({ text: `${baseLine}Rules from the work profile.\n` })
})

declare const Bun: {
  Glob: new (pattern: string) => { scan(options: { cwd: string }): AsyncIterable<string> }
  file(path: string): { text(): Promise<string> }
  write(path: string, text: string): Promise<number>
  build(options: { entrypoints: string[]; format: 'esm'; target: 'browser'; external: string[]; define: Record<string, string> }): Promise<{ outputs: { text(): Promise<string> }[] }>
}

test('no module a hook loads holds import(), which makes Claude Code refuse the whole hooks module', async () => {
  const src = `${import.meta.dir}/../src`
  const holding: string[] = []
  for await (const path of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: src })) {
    if (path === 'testing.ts' || path.startsWith('testing/')) continue
    if (/\bimport\s*\(/.test(await Bun.file(`${src}/${path}`).text())) holding.push(path)
  }

  expect(holding).toEqual([])
})

test('only registerPermissionCheck with the approve permission brings in an allow, so the bundle of a mod that only refuses passes the plugin directory', async () => {
  const bundled = async (name: string, body: string, permissions: readonly string[]) => {
    const entry = `${import.meta.dir}/../node_modules/.bundle-${name}.ts`
    await Bun.write(entry, `import { registerMod, registerPermissionCheck } from '${import.meta.dir}/../src/register.ts'\nexport function register(on) {\n  registerMod(on, { name: 'demo', setup() {} }, {})\n  ${body}\n}\n`)
    const built = await Bun.build({ entrypoints: [entry], format: 'esm', target: 'browser', external: ['claude-code'], define: bundleDefines(permissions) })
    return (await built.outputs[0]?.text()) ?? ''
  }
  const shape = (code: string) => ({
    hearsPermissions: /\(\s*"(tool\.check|PermissionRequest|classic\.PermissionRequest)",/.test(code),
    refuses: code.includes('decision: "deny"') && code.includes('behavior: "deny"'),
    allows: code.includes('decision: "allow"') || code.includes('behavior: "allow"') || code.includes('decision: "ask"') || code.includes('updatedPermissions'),
  })

  expect(shape(await bundled('plain', '', ['approve']))).toEqual({ hearsPermissions: false, refuses: false, allows: false })
  expect(shape(await bundled('refusing', 'registerPermissionCheck(on)', []))).toEqual({ hearsPermissions: true, refuses: true, allows: false })
  expect(shape(await bundled('approving', 'registerPermissionCheck(on)', ['approve']))).toEqual({ hearsPermissions: true, refuses: true, allows: true })
})

test("registerMod names each event as a string literal, which Claude Code's hooks loader requires, and registers every hook a mod hears", async () => {
  const source = await Bun.file(`${import.meta.dir}/../src/register.ts`).text()
  const fake = fakeOn()
  registerMod(fake.on, demo, {})
  registerPermissionCheck(fake.on)
  const classic = fake.registrations.map((registration) => registration.pattern).filter((pattern) => pattern.startsWith('classic.'))

  expect([...source.matchAll(/addHook\(\s*([^,]+),/g)].map((match) => match[1]).filter((name) => !/^'[a-zA-Z.]+'$/.test(name ?? ''))).toEqual([])
  const heard = Object.values(processEvents).flatMap((event): string[] => ['before' in event ? [event.on, event.before] : [event.on]].flat())
  expect([...heard, 'ConfigChange', 'FileChanged'].filter((hook) => !hook.includes('.') && hook !== 'CwdChanged' && !classic.includes(`classic.${hook}`))).toEqual([])
})
