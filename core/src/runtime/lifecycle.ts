import type { Args, EventResult, Frozen, HookBudget, HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import type { HookInput, Mod, ModDefinition, ModEvent, ModHook } from '../mod.js'
import { dataFolder, isAtLeast, parseEvent, readRecord, readSteps, scriptsSha256, storeFolder, type ReadFile, type RunnerEvent } from '../records.js'
import { relativePath } from '../utils/paths.js'
import { formatExit, listed, messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import { beforeDeadline } from './deadline.js'
import { answerCall, dependencyCalls, notInstalled } from './dependencies.js'
import { classicHook, heldDecisionHook, permissionEvents, preToolUseHook, userSkillHook, type HeldDecisions, type RoutedEvent } from './hooks.js'
import { createRouter, type Router, type RouterNext } from './router.js'
import { createState } from './state.js'
import { toolCalls } from './tool-calls.js'
import { createProgress, createUi, type Progress, type ProgressLine } from './ui.js'

export type Plugin = {
  readonly name: string
  readonly root: string
  readonly version: string | undefined
  readonly store: string
  readonly isInstalled: boolean
  readonly shouldRecord: boolean
  readonly keys: Readonly<Record<string, string>>
}

export type Phase = 'starting' | 'installing' | 'waiting' | 'declined' | 'failed' | 'ready' | 'active'

export type Lifecycle<State extends object> = {
  readonly phase: Phase
  readonly mod: Mod<State> | undefined
  readonly failure: unknown
  start(claude: Claude, read: (claude: Claude) => Promise<Plugin>): Promise<void>
  route<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, next: RouterNext<N>): Promise<EventResult<N>>
}

type ModRuntime = {
  readonly claude: Claude
  readonly router: Router
  readonly progress: Progress
  readonly dataFolder: string
  readonly keys: Readonly<Record<string, string>>
  readonly checksPermissions: () => boolean
}

type ActiveMod<State extends object> = {
  readonly mod: Mod<State>
  readonly added: readonly string[]
}

const cmodPluginName = 'cmod'

const announcedKey = 'cmod:announced'

const cmodCheckMs = 1000

const cmodWaitMs = 60_000

const sessionStartHoldMs = (10_000 satisfies HookBudget['ms']) - 1_000

const dependencyCallMs = 30_000

const cannotStart = /failed to start: /

const missingPath = /(?:^|: )(?:ENOENT|ENOTDIR)\b/

const shellTools: readonly string[] = ['Bash', 'PowerShell']

export async function readPlugin(claude: Claude): Promise<Plugin> {
  const { name, root } = claude.plugin
  const read: ReadFile = async (path) => {
    const stat = await claude.fs.stat(path).catch((error: unknown) => {
      if (missingPath.test(messageOf(error))) return undefined
      throw error
    })
    return stat?.kind === 'file' ? claude.fs.read(path) : undefined
  }
  const manifest = (await readJson(read, `${root}/.claude-plugin/plugin.json`)) as { version?: unknown } | undefined
  const version = typeof manifest?.version === 'string' ? manifest.version : undefined
  const store = storeFolder({ HOME: await claude.env.home(), XDG_DATA_HOME: await claude.env.dataHome() })
  if (name === cmodPluginName) {
    const installed = await cmodVersion(claude)
    return { name, root, version, store, keys: {}, isInstalled: version !== undefined && installed !== undefined && isAtLeast(installed, version), shouldRecord: false }
  }
  const steps = readSteps(await readJson(read, `${root}/package.json`)) ?? {}
  const plugin = { name, root, version, store, keys: steps.keys ?? {} }
  const record = await readRecord(read, store, name)
  if (Object.keys(steps).length === 0) return { ...plugin, isInstalled: true, shouldRecord: record?.version !== version }
  const scripts = await scriptsSha256(steps, {
    read: (path) => read(`${root}/${path}`),
    list: (folder) => filesBelow(claude, `${root}/${folder}`),
  })
  return { ...plugin, isInstalled: version !== undefined && record?.version === version && record.scriptsSha256 === scripts, shouldRecord: false }
}

async function filesBelow(claude: Claude, folder: string): Promise<string[]> {
  const entries = await claude.fs.list(folder)
  const paths = await Promise.all(
    entries.map(async ({ name, kind, isLink }) => {
      if (kind === 'file' || isLink) return [name]
      if (kind === 'dir') return (await filesBelow(claude, `${folder}/${name}`)).map((path) => `${name}/${path}`)
      return []
    }),
  )
  return paths.flat()
}

async function readJson(read: ReadFile, path: string): Promise<unknown> {
  const text = await read(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} is not JSON (${messageOf(error)}). Fix the file, then run /reload-plugins.`)
  }
}

async function cmodVersion(claude: Claude): Promise<string | undefined> {
  const result = await claude.process.run(['cmod', '--version']).catch((error: unknown) => {
    if (cannotStart.test(messageOf(error))) return undefined
    throw error
  })
  if (result === undefined) return undefined
  if (result.exitCode !== 0) throw new Error(`cmod --version ${formatExit(result.exitCode, lastLineOf(result.stderr) ?? '')}`)
  return result.stdout.trim().split(/\s+/).at(-1)
}

export function createLifecycle<State extends object>(definition: ModDefinition<State>, checksPermissions: () => boolean = () => true): Lifecycle<State> {
  let router: Router = createRouter()
  let phase: Phase = 'starting'
  let runtime: Pick<ModRuntime, 'claude' | 'progress'> | undefined
  let plugin: Plugin | undefined
  let line: ProgressLine | undefined
  let activation: Promise<void> | undefined
  let mod: Mod<State> | undefined
  let failure: unknown
  let shouldRecord = false
  let recording: Promise<void> | undefined
  let missedSessionStart: Frozen<Args<'classic.SessionStart'>> | undefined
  let settleStart: () => void = () => undefined
  const startSettled = new Promise<void>((resolve) => (settleStart = resolve))

  const claude = () => {
    if (runtime === undefined) throw new Error(`${definition.name}: the lifecycle has not started. registerMod(addHook, mod) starts it at session.start.`)
    return runtime.claude
  }

  const showLine = () => {
    line ??= runtime?.progress.start(`Installing ${definition.name}`)
    return line as ProgressLine
  }

  const endLine = () => {
    line?.end()
    line = undefined
  }

  const fail = (reason: string, fix: string) => {
    phase = 'failed'
    failure ??= new Error(`${definition.name}: ${reason}${/[.!?]$/.test(reason) ? '' : '.'} ${fix}`)
    showLine().fail(reason, fix)
  }

  const finish = () => {
    phase = 'ready'
    claude().ui.invalidate('ui.render')
  }

  const recordThroughCmod = async () => {
    if (plugin === undefined || (await cmodVersion(claude())) === undefined) return
    const { code, lastError } = await readLines(claude().process.spawn({ argv: ['cmod', 'setup', plugin.root, '--events'] }), (text) => {
      if (parseEvent(text).kind === 'done') shouldRecord = false
    })
    if (shouldRecord) throw new Error(`cmod setup ${formatExit(code, lastError)}`)
  }

  const record = () => {
    recording ??= recordThroughCmod()
      .catch((error: unknown) => claude().ui.log(`${definition.name} has no cmod record yet: ${messageOf(error)}`, { to: 'debug' }))
      .finally(() => {
        recording = undefined
      })
  }

  const activate = async () => {
    if (runtime === undefined || plugin === undefined) return
    const activeRouter = createRouter()
    const active = await createMod(definition, { ...runtime, router: activeRouter, dataFolder: dataFolder(plugin.store, plugin.name), keys: plugin.keys, checksPermissions }).catch((error: unknown) => {
      fail(messageOf(error), 'Fix it, then run /reload-plugins.')
      throw error
    })
    const { added } = active
    mod = active.mod
    router = activeRouter
    phase = 'active'
    runtime.claude.ui.invalidate('ui.render')
    endLine()
    const missed = missedSessionStart
    missedSessionStart = undefined
    const lateAnswer = missed === undefined ? {} : await activeRouter.dispatch('classic.SessionStart', missed, async () => ({})).catch((error: unknown) => {
      claude().ui.log(`${definition.name}: the SessionStart hook failed: ${messageOf(error)}`)
      return {}
    })
    if (Object.keys(lateAnswer).length > 0) {
      runtime.claude.ui.log(`${definition.name} started after Claude Code's SessionStart, so Claude Code did not read the answer of its SessionStart hooks.`, { to: 'debug' })
    }
    const version = plugin.version ?? ''
    if ((await runtime.claude.store.get(announcedKey)) === version) return
    await runtime.claude.store.set(announcedKey, version)
    runtime.claude.ui.toast(`${definition.name} is ready`)
    if (added.length > 0) runtime.claude.ui.log(`${definition.name} added ${listed(added)}.`)
  }

  const askConsent = async (event: Extract<RunnerEvent, { kind: 'needs-consent' }>) => {
    const name = definition.name
    if ((await claude().session.surfaces()).length === 0) {
      showLine().wait(`Waiting for consent: run cmod install ${name}`)
      claude().ui.log(`${name} waits for consent to run ${event.install}. Run cmod install ${name} in a terminal.`)
      return
    }
    showLine().wait('Waiting for your answer')
    const actions = [
      ...(event.install === '' ? [] : [`runs ${event.install} to install`]),
      ...(event.uninstall === '' ? [] : [`runs ${event.uninstall} when you remove it`]),
      ...(event.keys === '' ? [] : [`binds ${event.keys}`]),
    ]
    const answer = await claude().ui.ask(`${name} ${listed(actions)}. Install it now?`, { options: ['Install', 'Not now'], header: 'Install' })
    if (answer === 'Install') return install(event.sha256)
    phase = 'declined'
    endLine()
    claude().ui.log(`${name} is not installed. Run cmod install ${name} to install it.`)
  }

  const install = async (consent?: string): Promise<void> => {
    if (plugin === undefined) return
    if (plugin.name === cmodPluginName) return bootstrap(plugin.root)
    phase = 'installing'
    if ((await cmodVersion(claude())) === undefined) return waitForcmod()
    endLine()
    const progress = showLine()
    let outcome: RunnerEvent | undefined
    const argv = ['cmod', 'setup', plugin.root, '--events', ...(consent === undefined ? [] : ['--consent', consent])]
    const { code, lastError } = await readLines(claude().process.spawn({ argv }), (text) => {
      const event = parseEvent(text)
      if (event.kind === 'progress') progress.report(event)
      if (event.kind === 'done' || event.kind === 'failed' || event.kind === 'needs-consent') outcome = event
    })
    if (outcome?.kind === 'done') return finish()
    if (outcome?.kind === 'needs-consent') return askConsent(outcome)
    const reason = outcome?.kind === 'failed' ? outcome.message : `cmod setup ${formatExit(code, lastError)}`
    fail(reason, `Fix the cause, then run: cmod install ${definition.name}`)
  }

  const waitForcmod = () => {
    phase = 'waiting'
    showLine().wait('Waiting for cmod')
    let check: Promise<void> | undefined
    const stop = () => {
      timer.cancel()
      longWait.cancel()
    }
    const timer = claude().clock.every(cmodCheckMs, () => {
      check ??= cmodVersion(claude())
        .then((version) => {
          check = undefined
          if (version === undefined) return
          stop()
          return install()
        })
        .catch((error: unknown) => {
          stop()
          report(error)
        })
    })
    const longWait = claude().clock.after(cmodWaitMs, () => showLine().wait("Still waiting for cmod to download cmod. See cmod's own line."))
  }

  const bootstrap = async (root: string) => {
    const progress = showLine()
    phase = 'installing'
    const { code, lastError } = await readLines(claude().process.spawn({ argv: ['sh', '-c', './setup/bootstrap.sh'], cwd: root }), (text) => {
      const event = parseEvent(text)
      if (event.kind === 'progress') progress.report(event)
    })
    if (code === 0) return finish()
    fail(`bootstrap ${formatExit(code, lastError)}`, `Run ./setup/bootstrap.sh in ${root} to see the whole log.`)
  }

  const report = (error: unknown) => {
    failure = error
    if (phase !== 'failed') fail(messageOf(error), `Run cmod install ${definition.name} in a terminal to see the whole log.`)
  }

  const whenActive = async () => {
    if (phase === 'ready') activation ??= activate().catch(report)
    if (activation !== undefined && phase !== 'active') await activation
  }

  const holdSessionStart = () =>
    new Promise<void>((resolve) => {
      const limit = claude().clock.after(sessionStartHoldMs, resolve)
      void startSettled.then(whenActive).then(() => {
        limit.cancel()
        resolve()
      })
    })

  return {
    get phase() {
      return phase
    },
    get mod() {
      return mod
    },
    get failure() {
      return failure
    },
    async start(claudeCalls, read) {
      if (runtime !== undefined) return
      runtime = { claude: claudeCalls, progress: createProgress(claudeCalls) }
      try {
        const started = await read(claudeCalls).catch((error: unknown) => {
          report(error)
          return undefined
        })
        if (started === undefined) return
        plugin = started
        if (started.isInstalled) {
          shouldRecord = started.shouldRecord
          if (shouldRecord) record()
          return await activate().catch(report)
        }
        if (started.version === undefined) return fail('no version to install', 'Add "version" to .claude-plugin/plugin.json, then run /reload-plugins.')
        void install().catch(report)
      } finally {
        settleStart()
      }
    },
    async route<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, next: RouterNext<N>): Promise<EventResult<N>> {
      if (event === 'classic.SessionStart') missedSessionStart = undefined
      if (event === 'classic.SessionStart' && runtime === undefined) {
        missedSessionStart = e as Frozen<Args<'classic.SessionStart'>>
        return next(e)
      }
      if (shouldRecord && event === 'classic.UserPromptSubmit') record()
      await (event === 'classic.SessionStart' ? holdSessionStart() : whenActive())
      if (event === 'classic.SessionStart' && phase !== 'active') missedSessionStart = e as Frozen<Args<'classic.SessionStart'>>
      if (event === 'cmod.call' && phase !== 'active' && (e as Frozen<Args<'cmod.call'>>).to === definition.name) {
        const isStopped = phase === 'declined' || phase === 'failed'
        return { deny: isStopped ? notInstalled(definition.name) : `${definition.name} is installing. Try again when it's ready.` } as EventResult<N>
      }
      const answer = router.dispatch(event, e, next)
      const render = e as Frozen<Args<'ui.render'>>
      if (event !== 'ui.render' || render.component !== 'AbovePrompt' || runtime === undefined || !runtime.progress.isShown) return answer as Promise<EventResult<N>>
      return runtime.progress.draw((await answer) as EventResult<'ui.render'>, runtime.claude.ui.resolve(render), render.viewport?.columns) as EventResult<N>
    },
  }
}

async function createMod<State extends object>(definition: ModDefinition<State>, runtime: ModRuntime): Promise<ActiveMod<State>> {
  const { router, progress } = runtime
  const claude = checkingKeys(runtime.claude, definition.name, runtime.keys)
  const added: string[] = []
  const hookEvents: ModEvent[] = []
  const announce = (feature: string) => {
    added.push(feature)
  }
  const [session, root, startCwd] = await Promise.all([claude.session.id(), claude.session.root(), claude.session.cwd()])
  let cwd = startCwd
  let loadedCwd = startCwd
  let staleCwd: string | undefined
  const area = createUi<State>({ name: definition.name, claude, router, progress, announce, mod: () => mod })
  const modState = createState<State>({ name: definition.name, initial: definition.state ?? {}, session, root, claude, changed: area.changed })
  const held: HeldDecisions | undefined = runtime.checksPermissions() ? new Map() : undefined
  const mod: Mod<State> = {
    name: definition.name,
    state: modState.state,
    dataFolder: runtime.dataFolder,
    on(event, hook, options) {
      const bounded = options?.timeoutMs === undefined ? hook : timedHook(definition.name, event, hook, checkedMs(definition.name, `the ${event} hook's timeoutMs`, options.timeoutMs), claude)
      if (!hookEvents.includes(event)) hookEvents.push(event)
      if (event === 'PreToolUse') router.add('tool.call', preToolUseHook(definition.name, bounded as ModHook<'PreToolUse'>, claude, agents, held))
      else router.add(`classic.${event as Exclude<ModEvent, 'PreToolUse'>}`, classicHook(definition.name, event as Exclude<ModEvent, 'PreToolUse'>, bounded as ModHook<Exclude<ModEvent, 'PreToolUse'>>, claude, agents))
    },
    use: (job) => job({ mod, claude, on: (event, hook) => router.add(event, hook), announce, reserveName, toolCalls: agents }),
    every(ms, hook) {
      let isRunning = false
      return claude.clock.every(checkedMs(definition.name, 'mod.every', ms), () => {
        if (isRunning) return
        isRunning = true
        void Promise.resolve()
          .then(hook)
          .catch((error: unknown) => claude.ui.log(`${definition.name}: the every ${ms} ms hook failed: ${messageOf(error)}`))
          .finally(() => {
            isRunning = false
          })
      })
    },
    ui: area.ui,
    process: {
      run: (argv, init) => claude.process.run(argv, init),
      spawn: (argv, init) => claude.process.spawn({ ...init, argv }),
    },
    fs: {
      read: (path) => claude.fs.read(path),
      write: (path, text) => claude.fs.write(path, text),
      list: (path) => claude.fs.list(path),
      exists: (path) => claude.fs.exists(path),
      stat: (path, options) => claude.fs.stat(path, options),
    },
    http: { fetch: (url, init) => claude.http.fetch(url, init) },
    settings: { read: (args) => claude.settings.read(args) },
    session: {
      messages: claude.session.messages,
      async append(text) {
        const added = await claude.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
        if (added.deny !== undefined) throw new Error(`${definition.name}: Claude Code refused the note: ${added.deny}`)
      },
      async submit(text) {
        const submitted = await claude.prompt.submit({ text })
        if ('drop' in submitted && typeof submitted.drop === 'string') throw new Error(`${definition.name}: Claude Code dropped the prompt: ${submitted.drop}`)
      },
    },
    agent: { spawn: (args) => claude.agent.spawn(args) },
    model: { complete: (request, options) => claude.model.complete(request, options) },
    get projectRoot() {
      return modState.root
    },
    get cwd() {
      return cwd
    },
    dependencies: dependencyCalls(claude, (call, task) => beforeDeadline(claude, { ms: dependencyCallMs }, call, task)),
  }
  const followSession = async (isAfterCd = false) => {
    try {
      const [nextRoot, reportedCwd] = await Promise.all([claude.session.root(), claude.session.cwd()])
      const oldCwd = cwd
      const hasMovedRoot = nextRoot !== modState.root
      if (isAfterCd && hasMovedRoot && relativePath(nextRoot, reportedCwd) === undefined) staleCwd = reportedCwd
      if (reportedCwd !== staleCwd) staleCwd = undefined
      const nextCwd = staleCwd === undefined ? reportedCwd : nextRoot
      if (!hasMovedRoot && nextCwd === oldCwd) return
      cwd = nextCwd
      await modState.moveTo(nextRoot).catch((error: unknown) => {
        if (cwd === nextCwd) cwd = loadedCwd
        throw error
      })
      loadedCwd = nextCwd
      if (!hasMovedRoot) area.changed()
      if (nextCwd === oldCwd) return
      const moved: HookInput<'CwdChanged'> = { session_id: await claude.session.id(), cwd: nextCwd, hook_event_name: 'CwdChanged', old_cwd: oldCwd, new_cwd: nextCwd }
      await router.dispatch('classic.CwdChanged', moved as Frozen<Args<'classic.CwdChanged'>>, async () => ({}))
    } catch (error) {
      claude.ui.log(`${definition.name} keeps the state of ${modState.root} until the next prompt or folder move: ${messageOf(error)}`)
    }
  }
  router.add('classic.SessionStart', async (e, next) => {
    await modState.switchSession(e.session_id, e.source).catch((error: unknown) => {
      claude.ui.log(`${definition.name} kept its session values from before the ${e.source}: ${messageOf(error)}`)
    })
    return next(e)
  })
  router.add('classic.UserPromptSubmit', async (e, next) => {
    staleCwd = undefined
    await followSession()
    return next(e)
  })
  for (const event of ['classic.PostToolUse', 'classic.PostToolUseFailure'] as const) {
    router.add(event, async (e, next) => {
      if (shellTools.includes(e.tool_name)) await followSession()
      return next(e)
    })
  }
  router.add('command.run', async (e, next) => {
    const answer = await next(e)
    if (e.command === 'cd') await followSession(true)
    return answer
  })
  router.add('skill.prompt', userSkillHook(claude))
  const api = Object.fromEntries(Object.entries(definition.api ?? {}).map(([method, run]) => [method, (input: never) => run(input, mod)]))
  router.add('cmod.call', (e, next) => (e.to === definition.name ? answerCall(definition.name, api, e) : next(e)))
  const agents = toolCalls(claude, router)
  const names = new Set<string>()
  const reserveName = (kind: string, name: string, taken: string) => {
    const key = `${kind}:${name}`
    if (names.has(key)) throw new Error(taken)
    names.add(key)
  }
  await failsAs('its state did not load', () => modState.load())
  await failsAs('its setup function threw', () => definition.setup(mod))
  const permissionHooks = permissionEvents.filter((event) => router.has(event))
  if (permissionHooks.length > 0 && !runtime.checksPermissions()) {
    throw new Error(`it decides permissions on ${listed(permissionHooks)}, so hooks/register.ts must call registerPermissionCheck(addHook) after registerMod`)
  }
  if (held !== undefined && hookEvents.includes('PreToolUse')) router.add('tool.check', heldDecisionHook(held))
  await failsAs('its open panes did not load', () => area.restorePanes())
  if (hookEvents.length > 0) added.push(`${hookEvents.length === 1 ? 'a hook' : 'hooks'} on ${listed(hookEvents)}`)
  return { mod, added }
}

function checkingKeys(claude: Claude, name: string, keys: Readonly<Record<string, string>>): Claude {
  const bound = Object.entries(keys)
  if (bound.length === 0) return claude
  const register: Claude['command']['register'] = (command) => {
    for (const [key, commandName] of bound) {
      if (commandName === command.name && command.immediate !== true) {
        claude.ui.log(`${name}: ${key} runs /${command.name}, which waits for Claude's turn to end and adds a row to the conversation. Give /${command.name} immediate: true.`)
      }
    }
    return claude.command.register(command)
  }
  return { ...claude, command: { ...claude.command, register } }
}

const longestTimerMs = 2_147_483_647

function checkedMs(name: string, subject: string, ms: number): number {
  if (!Number.isInteger(ms) || ms <= 0 || ms > longestTimerMs) throw new Error(`${name}: ${subject} is ${ms}. Give a whole number of milliseconds above 0 and at most ${longestTimerMs}.`)
  return ms
}

function timedHook<E extends ModEvent>(name: string, event: E, hook: ModHook<E>, ms: number, claude: Claude): ModHook<E> {
  return (input) =>
    new Promise((resolve, reject) => {
      const timer = claude.clock.after(ms, () => {
        claude.ui.log(`${name}: the ${event} hook passed its ${ms / 1000} s timeout`)
        resolve(undefined)
      })
      Promise.resolve()
        .then(() => hook(input))
        .then(
          (answer) => {
            timer.cancel()
            resolve(answer)
          },
          (error: unknown) => {
            timer.cancel()
            reject(error)
          },
        )
    })
}

async function failsAs(subject: string, step: () => unknown): Promise<void> {
  try {
    await step()
  } catch (error) {
    throw new Error(`${subject}: ${messageOf(error)}`, { cause: error })
  }
}

async function readLines(stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>, onLine: (text: string) => void): Promise<{ code: number | null; lastError: string }> {
  let pending = ''
  let lastError = ''
  let piece = await stream.next()
  while (piece.done !== true) {
    if (piece.value.stream === 'stderr') {
      lastError = lastLineOf(piece.value.text) ?? lastError
    } else {
      const lines = `${pending}${piece.value.text}`.split('\n')
      pending = lines.pop() ?? ''
      for (const text of lines) onLine(text)
    }
    piece = await stream.next()
  }
  if (pending !== '') onLine(pending)
  return { code: piece.value.code, lastError }
}

function lastLineOf(text: string): string | undefined {
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed.slice(trimmed.lastIndexOf('\n') + 1).trim()
}
