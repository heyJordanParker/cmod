import type { Args, EngineInterface, EventResult, Frozen, Next, On } from 'claude-code'
import type { ModDefinition } from './mod.js'
import type { Claude } from './runtime/claude.js'
import type { RoutedEvent } from './runtime/hooks.js'
import { createLifecycle, readPlugin, type Lifecycle } from './runtime/lifecycle.js'

let lifecycle: Lifecycle<object>

let checksPermissions = false

async function startMod($: EngineInterface, eventInput: Frozen<Args<'session.start'>>, passOn: Next<'session.start'>): Promise<EventResult<'session.start'>> {
  const claude: Claude = {
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
  await lifecycle.start(claude, readPlugin)
  return passOn(eventInput)
}

function routeToMod<N extends RoutedEvent>(_$: EngineInterface, eventInput: Frozen<Args<N>>, passOn: Next<N>): Promise<EventResult<N>> {
  return lifecycle.route(passOn.event, eventInput, (passed: unknown) => passOn(passed as Args<N>) as Promise<EventResult<N>>)
}

export function registerMod<State extends object>(addHook: On, definition: ModDefinition<State>): void {
  checksPermissions = false
  lifecycle = createLifecycle(definition, () => checksPermissions)
  addHook('session.start', startMod)
  addHook('classic.SessionStart', routeToMod)
  addHook('classic.SessionEnd', routeToMod)
  addHook('classic.UserPromptSubmit', routeToMod)
  addHook('classic.InstructionsLoaded', routeToMod)
  addHook('classic.PermissionDenied', routeToMod)
  addHook('classic.PostToolUse', routeToMod)
  addHook('classic.PostToolUseFailure', routeToMod)
  addHook('classic.PostToolBatch', routeToMod)
  addHook('classic.SubagentStart', routeToMod)
  addHook('classic.SubagentStop', routeToMod)
  addHook('classic.Notification', routeToMod)
  addHook('classic.PreCompact', routeToMod)
  addHook('classic.Stop', routeToMod)
  addHook('classic.StopFailure', routeToMod)
  addHook('tool.call', routeToMod)
  addHook('prompt.submit', routeToMod)
  addHook('prompt.context', routeToMod)
  addHook('command.run', routeToMod)
  addHook('session.measure', routeToMod)
  addHook('skill.prompt', routeToMod)
  addHook('ui.render', routeToMod)
  addHook('ui.press', routeToMod)
  addHook('ui.close', routeToMod)
  addHook('cmod.call', routeToMod)
}

export function registerPermissionCheck(addHook: On): void {
  checksPermissions = true
  addHook('tool.check', routeToMod)
  addHook('classic.PreToolUse', routeToMod)
  addHook('classic.PermissionRequest', routeToMod)
}
