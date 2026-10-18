import type { Args, Caught, EngineInterface, EventResult, Frozen, Next, On, PluginOptions, ToolCallArgs } from 'claude-code'
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

function routeFailure<N extends RoutedEvent>(_$: EngineInterface, eventInput: Frozen<Args<N>>, passOn: Next<N> & Caught): Promise<EventResult<N>> {
  return lifecycle.caught(passOn.event, eventInput, (passed: unknown) => passOn(passed as Args<N>) as Promise<EventResult<N>>, passOn.error)
}

const withCaller = (eventInput: Frozen<Args<'cmod.call'>>, passOn: Next<'cmod.call'>) => ({ ...eventInput, caller: passOn.origin.plugin }) as Frozen<Args<'cmod.call'>>

const withoutCaller = (passOn: Next<'cmod.call'>) => (passed: Frozen<Args<'cmod.call'>>) => passOn(Object.fromEntries(Object.entries(passed).filter(([key]) => key !== 'caller')) as Args<'cmod.call'>)

function routeCallToMod(_$: EngineInterface, eventInput: Frozen<Args<'cmod.call'>>, passOn: Next<'cmod.call'>): Promise<EventResult<'cmod.call'>> {
  return lifecycle.route('cmod.call', withCaller(eventInput, passOn), withoutCaller(passOn))
}

function routeCallFailure(_$: EngineInterface, eventInput: Frozen<Args<'cmod.call'>>, passOn: Next<'cmod.call'> & Caught): Promise<EventResult<'cmod.call'>> {
  return lifecycle.caught('cmod.call', withCaller(eventInput, passOn), withoutCaller(passOn), passOn.error)
}

export function registerMod<State extends object, Declared extends Options>(addHook: On, definition: ModDefinition<State, string, Declared>, options: PluginOptions): void {
  permissionCheck = undefined
  registered = definition as ModDefinition<object>
  lifecycle = createLifecycle(definition, () => permissionCheck, options)
  addHook('session.start', startMod)
  addHook('classic.Setup', routeToMod).catch(routeFailure)
  addHook('classic.SessionStart', routeToMod).catch(routeFailure)
  addHook('classic.SessionEnd', routeToMod).catch(routeFailure)
  addHook('classic.UserPromptSubmit', routeToMod).catch(routeFailure)
  addHook('classic.UserPromptExpansion', routeToMod).catch(routeFailure)
  addHook('classic.InstructionsLoaded', routeToMod).catch(routeFailure)
  addHook('classic.ConfigChange', routeToMod).catch(routeFailure)
  addHook('classic.DirectoryAdded', routeToMod).catch(routeFailure)
  addHook('classic.PreModelSwitch', routeToMod).catch(routeFailure)
  addHook('classic.PostModelSwitch', routeToMod).catch(routeFailure)
  addHook('classic.PermissionDenied', routeToMod).catch(routeFailure)
  addHook('classic.PostToolUse', routeToMod).catch(routeFailure)
  addHook('classic.PostToolUseFailure', routeToMod).catch(routeFailure)
  addHook('classic.PostToolBatch', routeToMod).catch(routeFailure)
  addHook('classic.MessageDisplay', routeToMod).catch(routeFailure)
  addHook('classic.SubagentStart', routeToMod).catch(routeFailure)
  addHook('classic.SubagentStop', routeToMod).catch(routeFailure)
  addHook('classic.TaskCreated', routeToMod).catch(routeFailure)
  addHook('classic.TaskCompleted', routeToMod).catch(routeFailure)
  addHook('classic.TeammateIdle', routeToMod).catch(routeFailure)
  addHook('classic.Elicitation', routeToMod).catch(routeFailure)
  addHook('classic.ElicitationResult', routeToMod).catch(routeFailure)
  addHook('classic.Notification', routeToMod).catch(routeFailure)
  addHook('classic.PreCompact', routeToMod).catch(routeFailure)
  addHook('classic.PostCompact', routeToMod).catch(routeFailure)
  addHook('classic.Stop', routeToMod).catch(routeFailure)
  addHook('classic.StopFailure', routeToMod).catch(routeFailure)
  addHook('classic.FileChanged', routeToMod).catch(routeFailure)
  addHook('classic.WorktreeCreate', routeToMod).catch(routeFailure)
  addHook('classic.WorktreeRemove', routeToMod).catch(routeFailure)
  addHook('tool.call', routeToMod).catch(routeFailure)
  addHook('prompt.submit', routeToMod).catch(routeFailure)
  addHook('prompt.context', routeToMod).catch(routeFailure)
  addHook('command.run', routeToMod).catch(routeFailure)
  addHook('session.measure', routeToMod).catch(routeFailure)
  addHook('skill.prompt', routeToMod).catch(routeFailure)
  addHook('ui.render', routeToMod).catch(routeFailure)
  addHook('ui.press', routeToMod).catch(routeFailure)
  addHook('ui.scroll', routeToMod).catch(routeFailure)
  addHook('ui.close', routeToMod).catch(routeFailure)
  addHook('cmod.call', routeCallToMod).catch(routeCallFailure)
  addHook('session.compact', routeToMod).catch(routeFailure)
  if (definition.name !== cmodPluginName) return
  addHook('session.append', routeToMod).catch(routeFailure)
  addHook('session.receive', routeToMod).catch(routeFailure)
  addHook('agent.spawn', routeToMod).catch(routeFailure)
  addHook('prompt.attachment', routeToMod).catch(routeFailure)
  addHook('turn.start', routeToMod).catch(routeFailure)
}

export function registerPermissionCheck(addHook: On): void {
  permissionCheck = permissionRoutes
  addHook('tool.check', routeToMod).catch(routeFailure)
  addHook('classic.PermissionRequest', routeToMod).catch(routeFailure)
}
