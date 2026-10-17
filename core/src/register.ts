import type { Args, EngineInterface, EventResult, Frozen, Next, On, PluginOptions, ToolCallArgs } from 'claude-code'
import type { ModDefinition } from './mod.js'
import type { Options } from './options.js'
import type { Claude } from './runtime/claude.js'
import type { RoutedEvent } from './runtime/hooks.js'
import { cmodPluginName } from './runtime/dependencies.js'
import { createLifecycle, readPlugin, type Lifecycle } from './runtime/lifecycle.js'
import { permissionRoutes, type PermissionRoutes } from './runtime/permission-check.js'

let lifecycle: Lifecycle<object>

let permissionCheck: PermissionRoutes | undefined

let registered: ModDefinition<object> | undefined

export function registeredMod(): ModDefinition<object> | undefined {
  return registered
}

async function startMod($: EngineInterface, eventInput: Frozen<Args<'session.start'>>, passOn: Next<'session.start'>): Promise<EventResult<'session.start'>> {
  const claude: Claude = {
    plugin: { name: $.plugin.name, root: $.plugin.root },
    ui: {
      status: (text) => $.ui.status(text),
      log: (text, options) => $.ui.log(text, options),
      notice: (toolUseId, text) => $.ui.notice(toolUseId, text),
      invalidate: (event) => $.ui.invalidate(event),
      ask: (question, options) => $.ui.ask(question, options),
      open: (pane) => $.ui.open(pane),
      close: (pane) => $.ui.close(pane),
      panes: () => $.ui.panes(),
      scroll: (args) => $.ui.scroll(args),
      copy: (args) => $.ui.copy(args),
      focus: (args) => $.ui.focus(args),
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
    config: { list: () => $.config.list() },
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
      messages: ((args?: Parameters<Claude['session']['messages']>[0]) => (args === undefined ? $.session.messages() : $.session.messages(args))) as Claude['session']['messages'],
      append: (args) => $.session.append(args),
      send: (args) => $.session.send(args),
    },
    prompt: { submit: (args) => $.prompt.submit(args) },
    turn: { abort: (args) => $.turn.abort(args) },
    model: { complete: (request, options) => $.model.complete(request, options) },
    command: { register: (command) => $.command.register(command), list: () => $.command.list(), run: (args) => $.command.run(args) },
    tool: { register: (tool) => $.tool.register(tool), call: (input: ToolCallArgs) => $.tool.call(input) },
    agent: {
      list: () => $.agent.list(),
      spawn: (args) => $.agent.spawn(args),
    },
    env: {
      home: () => $.env.get('HOME'),
      dataHome: () => $.env.get('XDG_DATA_HOME'),
      configHome: () => $.env.get('CLAUDE_CONFIG_DIR'),
    },
    cmod: { call: (input) => $.cmod.call(input) },
  }
  const [, answer] = await Promise.all([lifecycle.start(claude, readPlugin), passOn(eventInput)])
  return answer
}

function routeToMod<N extends RoutedEvent>(_$: EngineInterface, eventInput: Frozen<Args<N>>, passOn: Next<N>): Promise<EventResult<N>> {
  return lifecycle.route(passOn.event, eventInput, (passed: unknown) => passOn(passed as Args<N>) as Promise<EventResult<N>>)
}

function routeCallToMod(_$: EngineInterface, eventInput: Frozen<Args<'cmod.call'>>, passOn: Next<'cmod.call'>): Promise<EventResult<'cmod.call'>> {
  const called = { ...eventInput, caller: passOn.origin.plugin } as Frozen<Args<'cmod.call'>>
  return lifecycle.route('cmod.call', called, (passed) => passOn(Object.fromEntries(Object.entries(passed).filter(([key]) => key !== 'caller')) as Args<'cmod.call'>))
}

export function registerMod<State extends object, Declared extends Options>(addHook: On, definition: ModDefinition<State, string, Declared>, options: PluginOptions): void {
  permissionCheck = undefined
  registered = definition as ModDefinition<object>
  lifecycle = createLifecycle(definition, () => permissionCheck, options)
  addHook('session.start', startMod)
  addHook('classic.Setup', routeToMod)
  addHook('classic.SessionStart', routeToMod)
  addHook('classic.SessionEnd', routeToMod)
  addHook('classic.UserPromptSubmit', routeToMod)
  addHook('classic.UserPromptExpansion', routeToMod)
  addHook('classic.InstructionsLoaded', routeToMod)
  addHook('classic.ConfigChange', routeToMod)
  addHook('classic.DirectoryAdded', routeToMod)
  addHook('classic.PreModelSwitch', routeToMod)
  addHook('classic.PostModelSwitch', routeToMod)
  addHook('classic.PermissionDenied', routeToMod)
  addHook('classic.PostToolUse', routeToMod)
  addHook('classic.PostToolUseFailure', routeToMod)
  addHook('classic.PostToolBatch', routeToMod)
  addHook('classic.MessageDisplay', routeToMod)
  addHook('classic.SubagentStart', routeToMod)
  addHook('classic.SubagentStop', routeToMod)
  addHook('classic.TaskCreated', routeToMod)
  addHook('classic.TaskCompleted', routeToMod)
  addHook('classic.TeammateIdle', routeToMod)
  addHook('classic.Elicitation', routeToMod)
  addHook('classic.ElicitationResult', routeToMod)
  addHook('classic.Notification', routeToMod)
  addHook('classic.PreCompact', routeToMod)
  addHook('classic.PostCompact', routeToMod)
  addHook('classic.Stop', routeToMod)
  addHook('classic.StopFailure', routeToMod)
  addHook('classic.FileChanged', routeToMod)
  addHook('classic.WorktreeCreate', routeToMod)
  addHook('classic.WorktreeRemove', routeToMod)
  addHook('tool.call', routeToMod)
  addHook('prompt.submit', routeToMod)
  addHook('prompt.context', routeToMod)
  addHook('command.run', routeToMod)
  addHook('session.measure', routeToMod)
  addHook('skill.prompt', routeToMod)
  addHook('ui.render', routeToMod)
  addHook('ui.press', routeToMod)
  addHook('ui.scroll', routeToMod)
  addHook('ui.close', routeToMod)
  addHook('cmod.call', routeCallToMod)
  if (definition.name !== cmodPluginName) return
  addHook('session.append', routeToMod)
  addHook('session.compact', routeToMod)
  addHook('session.receive', routeToMod)
  addHook('agent.spawn', routeToMod)
  addHook('prompt.attachment', routeToMod)
  addHook('turn.start', routeToMod)
}

export function registerPermissionCheck(addHook: On): void {
  permissionCheck = permissionRoutes
  addHook('tool.check', routeToMod)
  addHook('classic.PermissionRequest', routeToMod)
}
