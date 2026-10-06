import { expect, test } from 'bun:test'
import type { EngineInterface, On } from 'claude-code'
import { registerMod, registerPermissionCheck } from '../src/register.js'
import { defineMod } from '../src/mod.js'
import { Text } from '../src/ui/elements.js'

type Registration = {
  readonly pattern: string
  readonly hasMatcher: boolean
  readonly hook: (...args: never[]) => unknown
}

function fakeOn() {
  const registrations: Registration[] = []
  const on = (pattern: unknown, matcherOrHook: unknown, hook?: unknown) => {
    if (typeof pattern !== 'string') throw new Error('the event name passed to on() is not a string literal')
    const hasMatcher = hook !== undefined
    const twin = registrations.find((registration) => registration.pattern === pattern && !registration.hasMatcher)
    if (!hasMatcher && twin !== undefined) throw new Error(`on("${pattern}") is registered twice without a matcher. Register each event once, or give the second a matcher.`)
    registrations.push({ pattern, hasMatcher, hook: (hasMatcher ? hook : matcherOrHook) as Registration['hook'] })
    return { catch: () => undefined }
  }
  return {
    on: on as unknown as On,
    registrations,
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
  const shown = { toasts: [] as string[], logs: [] as string[] }
  const store = new Map<string, unknown>()
  const under = (folder: string) => Object.keys(files).filter((path) => path.startsWith(`${folder}/`))
  const kindOf = (path: string) => (files[path] !== undefined ? 'file' : 'dir')
  const $ = {
    plugin: { name: 'demo', root: '/plugins/demo' },
    ui: {
      toast: (text: string) => shown.toasts.push(text),
      log: (text: string) => shown.logs.push(text),
      invalidate: () => undefined,
      resolve: () => ({}),
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
    session: { id: async () => 'session-1', root: async () => '/work/app', cwd: async () => '/work/app' },
    clock: { every: () => ({ cancel: () => undefined }) },
  } as unknown as EngineInterface
  return { $, shown }
}

const demo = defineMod({
  name: 'demo',
  setup(mod) {
    mod.on('PostToolUse', (input) => ({ hookSpecificOutput: { additionalContext: `demo saw ${input.tool_name}` } }))
  },
})

const files = {
  '/plugins/demo/.claude-plugin/plugin.json': '{ "name": "demo", "version": "1.0.0" }',
  '/plugins/demo/package.json': '{ "dependencies": { "@cmodjs/core": "^0.1.1" } }',
  '/home/test/.local/share/cmod/records/demo.json': JSON.stringify({
    name: 'demo',
    version: '1.0.0',
    root: '/plugins/demo',
    installedAt: '2026-10-05T00:00:00.000Z',
    scriptsSha256: 'none',
    uninstall: null,
    program: null,
  }),
}

test('registerMod registers each Claude Code event once, and no permission check', () => {
  const fake = fakeOn()

  registerMod(fake.on, demo)

  expect(fake.registrations.map((registration) => registration.pattern)).toEqual([
    'session.start',
    'classic.SessionStart',
    'classic.SessionEnd',
    'classic.UserPromptSubmit',
    'classic.InstructionsLoaded',
    'classic.PermissionDenied',
    'classic.PostToolUse',
    'classic.PostToolUseFailure',
    'classic.PostToolBatch',
    'classic.SubagentStart',
    'classic.SubagentStop',
    'classic.Notification',
    'classic.PreCompact',
    'classic.Stop',
    'classic.StopFailure',
    'tool.call',
    'prompt.submit',
    'prompt.context',
    'command.run',
    'session.measure',
    'skill.prompt',
    'ui.render',
    'ui.press',
    'ui.close',
    'cmod.call',
  ])
})

test('registerPermissionCheck registers tool.check, PreToolUse, and PermissionRequest once each', () => {
  const fake = fakeOn()

  registerMod(fake.on, demo)
  registerPermissionCheck(fake.on)

  expect(fake.registrations.map((registration) => registration.pattern).slice(-3)).toEqual(['tool.check', 'classic.PreToolUse', 'classic.PermissionRequest'])
})

test('a permission rule answers tool.check once registerPermissionCheck ran', async () => {
  const fake = fakeOn()
  const { $ } = engine(files)
  const guard = defineMod({
    name: 'demo',
    setup(mod) {
      mod.on('PreToolUse', () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'No edits here.' } }))
    },
  })
  registerMod(fake.on, guard)
  registerPermissionCheck(fake.on)
  await fake.dispatch('session.start', $, {}, {})

  const answer = await fake.dispatch('classic.PreToolUse', $, { tool: 'Edit', tool_use_id: 't', file_path: 'a.ts' }, {})

  expect(answer).toEqual({ deny: 'No edits here.' })
})

test('session.start through the engine chain reads the plugin, runs setup, and announces the mod once', async () => {
  const fake = fakeOn()
  const { $, shown } = engine(files)
  registerMod(fake.on,demo)

  await fake.dispatch('session.start', $, {}, {})
  const answer = await fake.dispatch('classic.PostToolUse', $, { hook_event_name: 'PostToolUse', cwd: '/work/app', tool_name: 'Edit', tool_input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, tool_response: {}, tool_use_id: 't' }, {})

  expect(answer).toEqual({ additionalContext: ['demo saw Edit'] })
  expect(shown.toasts).toEqual(['demo is ready'])
  expect(shown.logs).toEqual(['demo added a hook on PostToolUse.'])
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
  registerMod(fake.on,opensPane)

  await fake.dispatch('session.start', $, {}, {})

  expect(drawn).toEqual([undefined])
  expect(redraws).toEqual(['ui.render'])
})

test('a mod that draws nothing hands the claude drawing back unchanged', async () => {
  const fake = fakeOn()
  const { $ } = engine(files)
  registerMod(fake.on,demo)
  await fake.dispatch('session.start', $, {}, {})
  const drawing = { type: 'Box', children: [] }

  const drawn = await fake.dispatch('ui.render', $, { surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: {} }, drawing)

  expect(drawn).toBe(drawing)
})

const modSkill = { '/plugins/demo/skills/architecture-diagram/SKILL.md': '---\nname: architecture-diagram\n---\nThe mod text.\n' }

const userSkill = { '/home/test/.claude/cmods/demo/skills/architecture-diagram/SKILL.md': '---\nname: architecture-diagram\ndescription: My diagrams\n---\nMy own diagram rules.\n' }

async function registeredDemo(skillFiles: Record<string, string>, env?: Record<string, string>) {
  const fake = fakeOn()
  const all: Record<string, string> = { ...files, ...skillFiles }
  const { $ } = engine(all, env)
  registerMod(fake.on,demo)
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
