import type { Timer } from 'claude-code'
import type { Claude } from '../runtime/claude.js'
import { elements } from './fake-elements.js'

export type TestCall = {
  readonly call: string
  readonly args: readonly unknown[]
}

export type Fakes = {
  process: { run?: Claude['process']['run']; spawn?: Claude['process']['spawn'] }
  fs: { read?: Claude['fs']['read']; write?: Claude['fs']['write']; list?: Claude['fs']['list']; exists?: Claude['fs']['exists']; stat?: Claude['fs']['stat'] }
  http: { fetch?: Claude['http']['fetch'] }
  settings: { read?: Claude['settings']['read'] }
  config: { list?: Claude['config']['list'] }
  ui: { ask?: Claude['ui']['ask']; open?: Claude['ui']['open']; scroll?: Claude['ui']['scroll'] }
  session: { messages?: Claude['session']['messages']; append?: Claude['session']['append'] }
  prompt: { submit?: Claude['prompt']['submit'] }
  model: { complete?: Claude['model']['complete'] }
  agent: { list?: Claude['agent']['list']; spawn?: Claude['agent']['spawn'] }
  clock: { after?: Claude['clock']['after']; every?: Claude['clock']['every'] }
  cmod: { call?: Claude['cmod']['call'] }
  tool: { call?: Claude['tool']['call'] }
}

export type ShownSchedule = { readonly id: string; readonly cron: string; readonly prompt: string }

export type Shown = {
  readonly toasts: string[]
  readonly notes: string[]
  readonly prompts: string[]
  readonly logs: string[]
  readonly debug: string[]
  readonly statuses: (string | undefined)[]
  readonly openPanes: Set<string>
  readonly commands: string[]
  readonly tools: string[]
  readonly schedules: ShownSchedule[]
}

export type FakeClaude = {
  readonly claude: Claude
  readonly calls: TestCall[]
  readonly fakes: Fakes
  readonly shown: Shown
  readonly store: Map<string, unknown>
  settle(): Promise<void>
}

export function fakeClaude(plugin: { readonly name: string; readonly root: string }): FakeClaude {
  const calls: TestCall[] = []
  const fakes: Fakes = { process: {}, fs: {}, http: {}, settings: {}, config: {}, ui: {}, session: {}, prompt: {}, model: {}, agent: {}, clock: {}, cmod: {}, tool: {} }
  const shown: Shown = { toasts: [], notes: [], prompts: [], logs: [], debug: [], statuses: [], openPanes: new Set(), commands: [], tools: [], schedules: [] }
  const unplacedPanes = new Set<string>()
  let focusedPane: string | undefined
  const store = new Map<string, unknown>()

  const faked = <Args extends readonly unknown[], Result>(call: string, answer: () => ((...args: Args) => Result) | undefined) => {
    return (...args: Args): Result => {
      calls.push({ call, args })
      const fake = answer()
      if (fake === undefined) {
        throw new Error(`${call}(${args.map((arg) => JSON.stringify(arg)).join(', ')}) has no fake answer. Set fakes.${call} on the tested mod.`)
      }
      return fake(...args)
    }
  }
  const rejected = <Args extends readonly unknown[], Result>(call: string, answer: () => ((...args: Args) => Promise<Result>) | undefined) => {
    const run = faked(call, answer)
    return async (...args: Args): Promise<Result> => run(...args)
  }

  const appendNote: Claude['session']['append'] = async ({ message }) => {
    shown.notes.push(message.content.map((block) => (typeof block['text'] === 'string' ? block['text'] : '')).join(''))
    return { message, uuid: `note-${shown.notes.length}` } as unknown as Awaited<ReturnType<Claude['session']['append']>>
  }
  const submitPrompt: Claude['prompt']['submit'] = async ({ text }) => {
    shown.prompts.push(text)
    return { text, origin: { kind: 'plugin', name: plugin.name } } as unknown as Awaited<ReturnType<Claude['prompt']['submit']>>
  }
  let scheduled = 0
  const scheduleTools = async (input: Record<string, unknown>): Promise<unknown> => {
    if (input['tool'] === 'CronCreate') {
      const created = { id: `cron-${(scheduled += 1)}`, cron: String(input['cron']), prompt: String(input['prompt']) }
      shown.schedules.push(created)
      return { result: { id: created.id, humanSchedule: created.cron, recurring: input['recurring'] !== false } }
    }
    if (input['tool'] === 'CronDelete') {
      const at = shown.schedules.findIndex((created) => created.id === input['id'])
      if (at === -1) return { result: { id: input['id'] }, text: `No job ${String(input['id'])}`, isError: true }
      shown.schedules.splice(at, 1)
      return { result: { id: input['id'] }, text: `Cancelled job ${String(input['id'])}.` }
    }
    if (input['tool'] === 'CronList') return { result: { jobs: shown.schedules.map(({ id, cron, prompt }) => ({ id, cron, humanSchedule: cron, prompt })) } }
    throw new Error(`tool.call(${JSON.stringify(input)}) has no fake answer. Set fakes.tool.call on the tested mod.`)
  }

  const claude: Claude = {
    plugin,
    ui: {
      toast: (text) => {
        shown.toasts.push(text)
      },
      status: (text) => {
        shown.statuses.push(text)
      },
      log: (text, options) => {
        const lines = options?.to === 'debug' ? shown.debug : shown.logs
        lines.push(text)
      },
      notice: () => undefined,
      invalidate: () => undefined,
      ask: rejected('ui.ask', () => fakes.ui.ask),
      open: async (pane) => {
        calls.push({ call: 'ui.open', args: [pane] })
        const answer = fakes.ui.open === undefined ? { isPlaced: true as const } : await fakes.ui.open(pane)
        if (answer.isPlaced) {
          shown.openPanes.add(pane.id)
          unplacedPanes.delete(pane.id)
          if (pane.focus === true) focusedPane = pane.id
        } else if (!shown.openPanes.has(pane.id)) {
          unplacedPanes.add(pane.id)
        }
        return answer
      },
      close: async (pane) => {
        calls.push({ call: 'ui.close', args: [pane] })
        shown.openPanes.delete(pane.id)
        unplacedPanes.delete(pane.id)
        if (focusedPane === pane.id) focusedPane = undefined
      },
      panes: async () => [
        ...[...shown.openPanes].map((id) => ({ id, title: id, isShown: true, isFocused: id === focusedPane, isPlaced: true })),
        ...[...unplacedPanes].map((id) => ({ id, title: id, isShown: false, isFocused: false, isPlaced: false })),
      ],
      scroll: rejected('ui.scroll', () => fakes.ui.scroll ?? (async () => ({}))),
      resolve: () => elements,
    },
    process: {
      run: rejected('process.run', () => fakes.process.run),
      spawn: faked('process.spawn', () => fakes.process.spawn),
    },
    fs: {
      read: rejected('fs.read', () => fakes.fs.read),
      write: rejected('fs.write', () => fakes.fs.write),
      list: rejected('fs.list', () => fakes.fs.list),
      exists: rejected('fs.exists', () => fakes.fs.exists ?? (async () => false)),
      stat: rejected('fs.stat', () => fakes.fs.stat),
    },
    http: { fetch: rejected('http.fetch', () => fakes.http.fetch) },
    settings: { read: rejected('settings.read', () => fakes.settings.read) },
    config: {
      list: rejected('config.list', () => fakes.config.list ?? (async () => [])),
    },
    agent: {
      list: rejected('agent.list', () => fakes.agent.list),
      spawn: rejected('agent.spawn', () => fakes.agent.spawn),
    },
    store: {
      get: async (key) => store.get(key),
      set: async (key, value) => {
        store.set(key, JSON.parse(JSON.stringify(value)))
      },
      delete: async (key) => {
        store.delete(key)
      },
      keys: async () => [...store.keys()],
    },
    clock: {
      now: async () => Date.now(),
      after: faked('clock.after', () => fakes.clock.after ?? realTimer),
      every: faked('clock.every', () => fakes.clock.every ?? idleInterval),
    },
    session: {
      id: async () => 'test-session',
      root: async () => plugin.root,
      cwd: async () => plugin.root,
      model: async () => 'test-model',
      usage: async () => ({ context: { window: 200000 }, rateLimits: {}, cost: { usd: 0 } }) as unknown as Awaited<ReturnType<Claude['session']['usage']>>,
      surfaces: async () => ['terminal'],
      messages: rejected('session.messages', () => fakes.session.messages as ((args?: unknown) => Promise<unknown>) | undefined) as Claude['session']['messages'],
      append: rejected('session.append', () => fakes.session.append ?? appendNote),
    },
    prompt: { submit: rejected('prompt.submit', () => fakes.prompt.submit ?? submitPrompt) },
    model: { complete: rejected('model.complete', () => fakes.model.complete) },
    command: {
      register: async (command) => {
        shown.commands.push(command.name)
        return { command: command.name }
      },
    },
    tool: {
      register: async (tool) => {
        shown.tools.push(tool.name)
        return { tool: `mcp__${plugin.name}__${tool.name}` }
      },
      call: rejected('tool.call', () => fakes.tool.call ?? scheduleTools) as Claude['tool']['call'],
    },
    env: {
      home: async () => '/test/home',
      dataHome: async () => undefined,
      configHome: async () => undefined,
    },
    cmod: { call: rejected('cmod.call', () => fakes.cmod.call) },
  }

  const settle = async () => {
    let seen: number
    do {
      seen = calls.length
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    } while (calls.length !== seen)
  }

  return { claude, calls, fakes, shown, store, settle }
}

declare function setTimeout(fn: () => void, ms: number): unknown
declare function clearTimeout(timeout: unknown): void

function realTimer(ms: number, fn: () => void): Timer {
  const timeout = setTimeout(fn, ms)
  return { cancel: () => clearTimeout(timeout) }
}

function idleInterval(): Timer {
  return { cancel: () => undefined }
}
