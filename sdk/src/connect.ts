import type { Args, EngineInterface, EventResult, Frozen, Next, On } from 'claude-code'
import type { ModDefinition } from './mod.js'
import type { Claude } from './runtime/claude.js'
import type { RoutedEvent } from './runtime/hooks.js'
import { createLifecycle, readPlugin, type Lifecycle } from './runtime/lifecycle.js'

let lifecycle: Lifecycle<object>

async function start($: EngineInterface, e: Frozen<Args<'session.start'>>, next: Next<'session.start'>): Promise<EventResult<'session.start'>> {
  await lifecycle.start(claudeOf($), readPlugin)
  return next(e)
}

function route<N extends RoutedEvent>(_$: EngineInterface, e: Frozen<Args<N>>, next: Next<N>): Promise<EventResult<N>> {
  return lifecycle.route(next.event, e, (passed: unknown) => next(passed as Args<N>) as Promise<EventResult<N>>)
}

function claudeOf($: EngineInterface): Claude {
  return {
    plugin: { name: $.plugin.name, root: $.plugin.root },
    ui: {
      toast: (text, options) => $.ui.toast(text, options),
      status: (text) => $.ui.status(text),
      log: (text, options) => $.ui.log(text, options),
      notice: (toolUseId, text) => $.ui.notice(toolUseId, text),
      invalidate: (event) => $.ui.invalidate(event),
      ask: (question, options) => $.ui.ask(question, options),
      open: (pane) => $.ui.open(pane),
      close: (pane) => $.ui.close(pane),
      panes: () => $.ui.panes(),
      resolve: (render) => $.ui.resolve(render),
    },
    process: {
      run: (argv, init) => $.process.run(argv, init),
      spawn: (request) => $.process.spawn(request),
    },
    fs: {
      read: (path) => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      list: (path) => $.fs.list(path),
      exists: (path) => $.fs.exists(path),
      stat: (path, options) => $.fs.stat(path, options),
    },
    http: { fetch: (url, init) => $.http.fetch(url, init) },
    settings: { read: (args) => $.settings.read(args) },
    store: {
      get: (key) => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
      delete: (key) => $.store.delete(key),
      keys: () => $.store.keys(),
    },
    clock: {
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
    },
    session: {
      id: () => $.session.id(),
      root: () => $.session.root(),
      cwd: () => $.session.cwd(),
      model: () => $.session.model(),
      usage: () => $.session.usage(),
      surfaces: () => $.session.surfaces(),
    },
    command: { register: (command) => $.command.register(command) },
    tool: { register: (tool) => $.tool.register(tool) },
    agent: { list: () => $.agent.list() },
    env: {
      home: () => $.env.get('HOME'),
      dataHome: () => $.env.get('XDG_DATA_HOME'),
      configHome: () => $.env.get('CLAUDE_CONFIG_DIR'),
    },
    cmod: { call: (input) => $.cmod.call(input) },
  }
}

export function connect<State extends object>(on: On, definition: ModDefinition<State>): void {
  lifecycle = createLifecycle(definition)
  on('session.start', start)
  on('classic.SessionStart', route)
  on('classic.SessionEnd', route)
  on('classic.UserPromptSubmit', route)
  on('classic.InstructionsLoaded', route)
  on('classic.PreToolUse', route)
  on('classic.PermissionRequest', route)
  on('classic.PermissionDenied', route)
  on('classic.PostToolUse', route)
  on('classic.PostToolUseFailure', route)
  on('classic.PostToolBatch', route)
  on('classic.SubagentStart', route)
  on('classic.SubagentStop', route)
  on('classic.Notification', route)
  on('classic.PreCompact', route)
  on('classic.Stop', route)
  on('classic.StopFailure', route)
  on('tool.check', route)
  on('tool.call', route)
  on('prompt.submit', route)
  on('prompt.context', route)
  on('command.run', route)
  on('session.measure', route)
  on('skill.prompt', route)
  on('ui.render', route)
  on('ui.press', route)
  on('ui.close', route)
  on('cmod.call', route)
}
