import type { Args, EventResult, Frozen, HookBudget, PluginOptions, RenderElement, Timer } from 'claude-code'
import type { Step } from '../installer.js'
import { ConfigChange, FileChanged, hooks, PreToolUse, SessionStart, type Allowed, type FileChange, type Disposable, type Hook, type HookInput, type HookListener, type HookOptions, type Imports, type Mod, type ModDefinition, type PaneHandle, type SettingsFile, type SettingsFileChange, type SettingsFileChangeListener, type Toast } from '../mod.js'
import type { Options, OptionValues } from '../options.js'
import { changelogPage, consentPath, dataFolder, finishStepsMethod, isAtLeast, marketplaceOf, oldestCmodFor, openPageMethod, parseConsent, pendingStepsMethod, parseEvent, permissionWords, readRecord, readSteps, recordPath, scriptsSha256, settingsPagesMethod, storeFolder, updatesToTurnOn, type ReadFile, type RunnerEvent, type Steps } from '../records.js'
import { homePrefix, ifMissing, relativePath } from '../utils/paths.js'
import { firstLine, formatExit, listed, messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import { beforeDeadline } from './deadline.js'
import { announcedOf, announcementMs, announcementOf } from './announce.js'
import { bind } from './bound.js'
import { serveConversations } from './conversations.js'
import { answerCall, answeringOwnCalls, cmodPluginName, dependencyCalls, withBareRefusals } from './dependencies.js'
import { keepEngine } from './engine.js'
import { classicHook, heldDecisionHook, permissionEvents, preToolUseHook, userSkillHook, type HeldDecisions, type RoutedEvent } from './hooks.js'
import { checkedAnswer, checkingGrants, checkSettings, checksAnswers, checkWrite, isCovered, itemOf, passedDown, programAddresses, type AnswerCheck, type Grants } from './grants.js'
import { cmodError, lastLineOf, locatingPrograms, readLines, type Programs } from './programs.js'
import { createModFiles, resolvedPath, type Places } from './metadata.js'
import { fitsOption } from '../options.js'
import { createInstaller } from './installer.js'
import { createOptions, MissingOptions } from './options.js'
import { createRouter, type Router, type RouterNext } from './router.js'
import { conversationMethods, createSessionsClient } from './sessions.js'
import type { SessionChange } from '../session/conversation.js'
import type { BeforeEvent } from '../session/session.js'
import { matches } from '../utils/matcher.js'
import { createState } from './state.js'
import { createToaster, type Failure, type ShownToast, type Toaster } from './toaster.js'
import { toolCalls } from './tool-calls.js'
import { createUi } from './ui.js'
import { Progress } from '../ui/components.js'
import { Box, Text } from '../ui/elements.js'

export type Plugin = {
  readonly name: string
  readonly root: string
  readonly version: string | undefined
  readonly store: string
  readonly isInstalled: boolean
  readonly shouldRecord: boolean
  readonly steps: Steps
  readonly granted: readonly string[]
}

export type Phase = 'starting' | 'installing' | 'waiting' | 'declined' | 'failed' | 'ready' | 'active'

export type Lifecycle<State extends object> = {
  readonly phase: Phase
  readonly mod: Mod<State> | undefined
  readonly failure: unknown
  readonly toasts: readonly ShownToast[]
  start(claude: Claude, read: (claude: Claude) => Promise<Plugin>): Promise<void>
  route<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, next: RouterNext<N>): Promise<EventResult<N>>
}

type ModRuntime = {
  readonly claude: Claude
  readonly router: Router
  readonly toaster: Toaster
  readonly dataFolder: string
  readonly store: string
  readonly steps: Steps
  readonly granted: ReadonlySet<string>
  readonly refreshGrants: () => Promise<void>
  readonly checksPermissions: () => boolean
  readonly options: PluginOptions
}

type ActiveMod<State extends object, Declared extends Options> = {
  readonly mod: Mod<State, Declared>
  readonly added: readonly string[]
  readonly imports: Imports
}


const announcedKey = 'cmod:announced'

const installId = 'cmod:install'

const installRetrySeconds = [2, 4, 8, 16, 32, 64, 128] as const

const cmodCheckMs = 1000

const cmodWaitMs = 60_000

const startHoldMs = (10_000 satisfies HookBudget['ms']) - 1_000

const dependencyCallMs = 30_000

const cannotStart = /failed to start: /

const shellTools: readonly string[] = ['Bash', 'PowerShell']

export async function readPlugin(claude: Claude): Promise<Plugin> {
  const { name, root } = claude.plugin
  const read: ReadFile = async (path) => {
    const stat = await claude.fs.stat(path).catch(ifMissing(undefined))
    return stat?.kind === 'file' ? claude.fs.read(path) : undefined
  }
  const manifest = (await readJson(read, `${root}/.claude-plugin/plugin.json`)) as { version?: unknown } | undefined
  const version = typeof manifest?.version === 'string' ? manifest.version : undefined
  const store = storeFolder({ HOME: await claude.env.home(), XDG_DATA_HOME: await claude.env.dataHome() })
  const steps = readSteps(await readJson(read, `${root}/package.json`)) ?? {}
  const declared = steps.permissions ?? []
  if (name === cmodPluginName) {
    const installed = await cmodVersion(claude)
    return { name, root, version, store, steps, granted: declared, isInstalled: version !== undefined && installed !== undefined && isAtLeast(installed, version), shouldRecord: false }
  }
  const approved = parseConsent(await readJson(read, consentPath(store)), consentPath(store))[name] ?? []
  const plugin = { name, root, version, store, steps, granted: declared.filter((item) => approved.includes(item)) }
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
    throw new Error(`${path} is not JSON (${messageOf(error)}). Fix it, then press Retry.`)
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

export function createLifecycle<State extends object, Declared extends Options = Options>(
  definition: ModDefinition<State, string, Declared>,
  checksPermissions: () => boolean = () => true,
  options: PluginOptions = {},
  asksPerson = true,
): Lifecycle<State> {
  let router: Router = createRouter()
  let phase: Phase = 'starting'
  let runtime: Pick<ModRuntime, 'claude' | 'toaster'> | undefined
  let programs: Programs | undefined
  let plugin: Plugin | undefined
  const granted = new Set<string>()
  let activation: Promise<void> | undefined
  let mod: Mod<State> | undefined
  let imports: Imports | undefined
  let failure: unknown
  let pluginOptions = options
  const installer = createInstaller(definition.name, () => claude())
  let shouldRecord = false
  let recording: Promise<void> | undefined
  let missedSessionStart: Frozen<Args<'classic.SessionStart'>> | undefined
  let settleStart: () => void = () => undefined
  const startSettled = new Promise<void>((resolve) => (settleStart = resolve))

  const claude = () => {
    if (runtime === undefined) throw new Error(`${definition.name}: the lifecycle has not started. registerMod(addHook, mod, options) starts it at session.start.`)
    return runtime.claude
  }

  const installing = (description?: string | RenderElement) => runtime?.toaster.toast.loading('Installing', { id: installId, ...(description === undefined ? {} : { description }) })

  const toastFailure = (shown: Failure) => runtime?.toaster.fail(shown)

  const fail = (reason: string, fix: string | undefined, retry?: () => Promise<void>) => {
    phase = 'failed'
    failure ??= new Error(`${definition.name}: ${reason}${/[.!?]$/.test(reason) ? '' : '.'}${fix === undefined ? '' : ` ${fix}`}`)
    const again = retry === undefined ? {} : { retry: () => ((failure = undefined), stopRetrying(), retry().catch(report)) }
    toastFailure({ id: installId, message: reason, ...(fix === undefined ? {} : { description: fix }), ...again })
  }

  let consented: string | undefined
  const installAgain = () => install(consented)

  type Retrying = { readonly when: 'changed' | 'later'; readonly tries: number; readonly checkout: string | undefined; readonly reason: string; readonly timer: Timer }
  let retrying: Retrying | undefined

  const retryLater = (next: Omit<Retrying, 'timer'>) => {
    const seconds = installRetrySeconds[Math.min(next.tries, installRetrySeconds.length - 1)] as number
    retrying?.timer.cancel()
    retrying = { ...next, tries: next.tries + 1, timer: claude().clock.after(seconds * 1000, () => void retryInBackground().catch(report)) }
    fail(next.reason, `Trying again in ${seconds} s.`, installAgain)
  }

  const stopRetrying = () => {
    retrying?.timer.cancel()
    retrying = undefined
  }

  const checkoutState = async (): Promise<string | undefined> => {
    if (plugin === undefined) return undefined
    const lines: string[] = []
    const { code } = await readLines(claude().process.spawn({ argv: ['sh', '-c', 'git rev-parse HEAD && git status --porcelain=v1 -uall && git diff HEAD'], cwd: plugin.root }), (text) => void lines.push(text))
    return code === 0 ? lines.join('\n') : undefined
  }

  const failInstall = async (reason: string, when: 'changed' | 'later' | undefined) => {
    if (when === undefined) {
      stopRetrying()
      return fail(reason, undefined, installAgain)
    }
    retryLater({ when, tries: retrying?.when === when ? retrying.tries : 0, checkout: when === 'changed' ? await checkoutState() : undefined, reason })
  }

  const retryInBackground = async () => {
    const waiting = retrying
    if (phase !== 'failed' || waiting === undefined) return
    if (await recover()) {
      stopRetrying()
      return whenActive()
    }
    if (waiting.when === 'changed' && waiting.checkout !== undefined && (await checkoutState()) === waiting.checkout) return retryLater(waiting)
    await install(consented, true)
    await whenActive()
  }

  const finish = async () => {
    await programs?.refresh()
    phase = 'ready'
    claude().ui.invalidate('ui.render')
  }

  const recordThroughCmod = async () => {
    if (plugin === undefined || (await cmodVersion(claude())) === undefined) return
    const { code, lastError } = await readLines(claude().process.spawn({ argv: ['cmod', 'setup', plugin.root, '--events'] }), (text) => {
      if (parseEvent(text).type === 'done') shouldRecord = false
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

  const saveOption = async (key: string, text: string): Promise<string | undefined> => {
    const option = (definition.options as Options | undefined)?.[key]
    if (option === undefined || plugin === undefined) return `${definition.name} has no option ${key}.`
    const value = option.type === 'number' ? Number(text) : option.type === 'toggle' ? text.trim() === 'true' : option.type === 'list' ? text.split(',').map((item) => item.trim()).filter((item) => item !== '') : text
    const misfit = option.type === 'toggle' && !['true', 'false'].includes(text.trim()) ? 'takes true or false' : fitsOption(option, value)
    if (misfit !== undefined) return `${option.title} ${misfit}.`
    const saved = await claude().process.run(['cmod', 'option', plugin.name, key, Array.isArray(value) ? value.join(',') : String(value)])
    return saved.exitCode === 0 ? undefined : cmodError(saved.stderr, 'option') || `cmod option ${formatExit(saved.exitCode, '')}.`
  }

  const askOptions = async (missing: MissingOptions): Promise<boolean> => {
    if (!asksPerson || plugin === undefined || (await claude().session.surfaces()).length === 0) return false
    const declared: Options = definition.options ?? {}
    const asked = missing.keys.flatMap((key) => {
      const option = declared[key]
      return option === undefined ? [] : [[key, option] as const]
    })
    if (!(await installer.options(asked, saveOption))) return false
    const prefix = `${plugin.name}.`
    const rows = await claude().config.list()
    pluginOptions = { ...pluginOptions, ...Object.fromEntries(rows.filter((row) => row.key.startsWith(prefix)).map((row) => [row.key.slice(prefix.length), row.value])) }
    return true
  }

  const isStepDone = async (active: Mod<State>, step: Step<State>) => {
    try {
      return await step.isDone(active)
    } catch (error) {
      toastFailure({ id: `step:${step.title}`, message: `The ${step.title} step's isDone failed`, error })
      return false
    }
  }

  const pendingSteps = async (active: Mod<State>) => {
    const pending: string[] = []
    for (const step of definition.installer ?? []) if (!(await isStepDone(active, step))) pending.push(step.title)
    return pending
  }

  const runSteps = async (active: Mod<State>) => {
    const steps = asksPerson ? (definition.installer ?? []) : []
    for (const [index, step] of steps.entries()) {
      if (await isStepDone(active, step)) continue
      const isAnswered = (await claude().session.surfaces()).length > 0 && (await installer.step(active, step, index + 1, steps.length))
      if (!isAnswered) {
        runtime?.toaster.toast.warning(steps.length - index === 1 ? 'Needs one more step' : `Needs ${steps.length - index} more steps`, {
          id: 'cmod:steps',
          description: `Starting with ${step.title}. Finish them in /mods ${definition.name}.`,
          duration: Infinity,
          action: { label: 'Finish', onClick: () => active.settings.open() },
        })
        break
      }
    }
    await installer.close()
  }

  const activate = async (): Promise<void> => {
    if (runtime === undefined || plugin === undefined) return
    const activeRouter = createRouter()
    const active = await createMod(definition, { ...runtime, router: activeRouter, dataFolder: dataFolder(plugin.store, plugin.name), store: plugin.store, steps: plugin.steps, granted, refreshGrants, checksPermissions, options: pluginOptions }).catch(async (error: unknown) => {
      if (error instanceof MissingOptions && (await askOptions(error))) return undefined
      fail(messageOf(error), error instanceof MissingOptions ? `Set ${error.keys.length === 1 ? 'it' : 'them'} in /config.` : undefined, begin)
      throw error
    })
    if (active === undefined) return activate()
    const { added } = active
    mod = active.mod
    imports = active.imports
    router = activeRouter
    phase = 'active'
    runtime.claude.ui.invalidate('ui.render')
    void runSteps(active.mod).catch((error: unknown) => toastFailure({ id: 'cmod:steps', message: 'Its installer stopped', error }))
    const missed = missedSessionStart
    missedSessionStart = undefined
    const lateAnswer = missed === undefined ? {} : await activeRouter.dispatch('classic.SessionStart', missed, async () => ({})).catch((error: unknown) => {
      toastFailure({ id: 'classic.SessionStart', message: 'The SessionStart hook failed', error })
      return {}
    })
    if (Object.keys(lateAnswer).length > 0) {
      runtime.claude.ui.log(`${definition.name} started after Claude Code's SessionStart, so Claude Code did not read the answer of its SessionStart hooks.`, { to: 'debug' })
    }
    const version = plugin.version ?? ''
    const announced = announcedOf(await runtime.claude.store.get(announcedKey))
    if (announced?.version === version) {
      runtime.toaster.toast.dismiss(installId)
      return
    }
    await runtime.claude.store.set(announcedKey, { version, added })
    const { toaster } = runtime
    void announcementOf(runtime.claude, plugin, granted, added, announced)
      .then(({ message, ...options }) => toaster.toast.success(message, { id: installId, duration: announcementMs, ...options }))
      .catch((error: unknown) => toastFailure({ id: installId, message: 'Could not say what it installed', error }))
  }

  const updatesToShow = async () => {
    const [home, configHome] = await Promise.all([claude().env.home(), claude().env.configHome()])
    const configRoot = configHome ?? `${home ?? ''}/.claude`
    const known = await claude()
      .fs.read(`${configRoot}/plugins/known_marketplaces.json`)
      .then((text): unknown => JSON.parse(text))
      .catch(ifMissing(undefined))
    return updatesToTurnOn(marketplaceOf(claude().plugin.root, claude().plugin.name), await claude().settings.read({ source: 'user' }), known)
  }

  const askConsent = async (event: Extract<RunnerEvent, { type: 'needs-consent' }>) => {
    const name = definition.name
    if ((await claude().session.surfaces()).length === 0) {
      claude().ui.log(`${name} waits for consent to run ${event.install}. Run cmod install ${name} in a terminal.`)
      return
    }
    runtime?.toaster.toast.info('Installing', { id: installId, description: 'Waiting for your answer', duration: Infinity })
    const updates = await updatesToShow().catch((error: unknown) => {
      toastFailure({ id: 'cmod:updates', message: 'Could not read whether its marketplace updates automatically', error })
      return undefined
    })
    const isAccepted = await installer.consent({ ...event, updates })
    await installer.close()
    if (isAccepted) {
      consented = event.sha256
      return install(consented)
    }
    phase = 'declined'
    runtime?.toaster.toast('Not installed', { id: installId, description: 'Install it whenever you like.', duration: Infinity, action: { label: 'Install', onClick: () => install().catch(report) } })
  }

  const install = async (consent?: string, isQuiet = false): Promise<void> => {
    if (plugin === undefined) return
    if (plugin.name === cmodPluginName) return bootstrap(plugin.root)
    phase = 'installing'
    const found = await cmodVersion(claude())
    if (!fits(found)) return waitForcmod(found)
    if (!isQuiet) installing()
    let outcome: RunnerEvent | undefined
    let retries: 'changed' | 'later' | undefined
    const argv = ['cmod', 'setup', plugin.root, '--events', ...(consent === undefined ? [] : ['--consent', consent])]
    const { code, lastError } = await readLines(claude().process.spawn({ argv }), (text) => {
      const event = parseEvent(text)
      if (event.type === 'progress' && !isQuiet) installing(progressOf(event))
      if (event.type === 'retries') retries = event.when
      if (event.type === 'done' || event.type === 'failed' || event.type === 'needs-consent') outcome = event
    })
    if (outcome?.type === 'done') {
      stopRetrying()
      for (const item of plugin.steps.permissions ?? []) granted.add(item)
      return finish()
    }
    if (outcome?.type === 'needs-consent') return askConsent(outcome)
    return failInstall(outcome?.type === 'failed' ? outcome.message : `cmod setup ${formatExit(code, lastError)}`, retries)
  }

  const fits = (found: string | undefined): found is string => found !== undefined && isAtLeast(found, oldestCmodFor(plugin?.steps ?? {}))

  const waitForcmod = (found: string | undefined) => {
    phase = 'waiting'
    installing('Waiting for cmod')
    let latest = found
    let check: Promise<void> | undefined
    const stop = () => {
      timer.cancel()
      longWait.cancel()
    }
    const timer = claude().clock.every(cmodCheckMs, () => {
      check ??= cmodVersion(claude())
        .then((version) => {
          check = undefined
          latest = version
          if (!fits(version)) return
          stop()
          return install()
        })
        .catch((error: unknown) => {
          stop()
          report(error)
        })
    })
    const longWait = claude().clock.after(cmodWaitMs, () =>
      installing(
        latest === undefined
          ? "Still waiting for cmod to download cmod. See cmod's own line."
          : `PATH finds cmod ${latest}, and ${definition.name} needs cmod ${oldestCmodFor(plugin?.steps ?? {})} or later. Run npm i -g @cmodjs/cli, or put ~/.local/bin ahead of the old cmod on PATH.`,
      ),
    )
  }

  const bootstrap = async (root: string) => {
    installing()
    phase = 'installing'
    const { code, lastError } = await readLines(claude().process.spawn({ argv: ['sh', '-c', './setup/bootstrap.sh'], cwd: root }), (text) => {
      const event = parseEvent(text)
      if (event.type === 'progress') installing(progressOf(event))
    })
    if (code === 0) return finish()
    fail(`bootstrap ${formatExit(code, lastError)}`, undefined, () => bootstrap(root))
  }

  const begin = async (): Promise<void> => {
    if (readStarted === undefined) return
    const started = await readStarted(claude())
    plugin = started
    for (const item of started.granted) granted.add(item)
    consentMs = await stampOf(consentPath(started.store))
    recordMs = await stampOf(recordPath(started.store, started.name))
    if (started.isInstalled) {
      shouldRecord = started.shouldRecord
      if (shouldRecord) record()
      activation = undefined
      return activate()
    }
    if (started.version === undefined) return fail('no version to install', 'Its author adds "version" to .claude-plugin/plugin.json.')
    void install().catch(report)
  }

  const report = (error: unknown) => {
    failure = error
    if (phase !== 'failed') fail(messageOf(error), undefined, begin)
  }

  let consentMs = 0
  const stampOf = async (path: string) => {
    const stat = await claude().fs.stat(path).catch(ifMissing(undefined))
    return stat?.kind === 'file' ? stat.mtimeMs : 0
  }
  let recordMs = 0
  let readStarted: ((claude: Claude) => Promise<Plugin>) | undefined
  const recover = async (): Promise<boolean> => {
    if (plugin === undefined || readStarted === undefined || (phase !== 'failed' && phase !== 'declined')) return false
    const modifiedMs = await stampOf(recordPath(plugin.store, plugin.name))
    if (modifiedMs === recordMs) return false
    recordMs = modifiedMs
    const current = await readStarted(claude())
    if (!current.isInstalled) return false
    plugin = current
    failure = undefined
    activation = undefined
    await refreshGrants()
    await finish()
    return true
  }

  const refreshGrants = async () => {
    if (plugin === undefined || plugin.name === cmodPluginName) return
    const path = consentPath(plugin.store)
    const modifiedMs = await stampOf(path)
    if (modifiedMs === consentMs) return
    consentMs = modifiedMs
    const approved = modifiedMs === 0 ? [] : (parseConsent(JSON.parse(await claude().fs.read(path)), path)[plugin.name] ?? [])
    granted.clear()
    for (const item of plugin.steps.permissions ?? []) {
      if (approved.includes(item)) granted.add(item)
    }
  }

  const droppedParts = new Set<string>()
  const answerCheck: AnswerCheck = {
    get plugin() {
      return plugin?.name ?? definition.name
    },
    isGranted: (item) => isCovered(granted, item, undefined),
    dropped(item, part) {
      if (droppedParts.has(item)) return
      droppedParts.add(item)
      const declared = plugin?.steps.permissions ?? []
      const fix = declared.includes(item) ? `Turn it on in /mods ${definition.name}.` : `It needs "permissions": { "${item}": true } in package.json "cmod".`
      runtime?.toaster.toast.warning(`Answered ${part} without your grant to "${permissionWords(item)}", so cmod dropped it`, { id: `dropped:${item}`, description: fix, duration: Infinity })
    },
  }

  const checkedRoute = async <N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, next: RouterNext<N>): Promise<EventResult<N>> => {
    let below: Promise<EventResult<N>> | undefined
    const passOn: RouterNext<N> = (passed) => (below ??= next(passedDown(event, e, passed, answerCheck) as Frozen<Args<N>>))
    const answer = await router.dispatch(event, e, passOn)
    return (await checkedAnswer(event, e, answer, () => passOn(e), answerCheck)) as EventResult<N>
  }

  const whenActive = async () => {
    if (phase === 'ready') activation ??= activate().catch(report)
    if (activation !== undefined && phase !== 'active') await activation
  }

  const holdUntilStarted = (): Promise<void> =>
    runtime === undefined
      ? startSettled.then(whenActive)
      : new Promise<void>((resolve) => {
          const limit = claude().clock.after(startHoldMs, resolve)
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
    get toasts() {
      return runtime?.toaster.shown ?? []
    },
    async start(claudeCalls, read) {
      if (runtime !== undefined) return
      programs = locatingPrograms(claudeCalls)
      runtime = { claude: programs.claude, toaster: createToaster(claudeCalls, definition.name, () => plugin?.version) }
      readStarted = read
      try {
        await programs.refresh()
        await begin().catch(report)
      } finally {
        settleStart()
      }
    },
    async route<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, next: RouterNext<N>): Promise<EventResult<N>> {
      if (imports !== undefined) bind(imports)
      if (event === 'ui.render' && installer.draws(e as Frozen<Args<'ui.render'>>)) return installer.draw(e as Frozen<Args<'ui.render'>>) as EventResult<N>
      if (event === 'ui.close') installer.closed((e as Frozen<Args<'ui.close'>>).id)
      if (event === 'classic.SessionStart') missedSessionStart = undefined
      if (event === 'classic.SessionStart' && runtime === undefined) {
        missedSessionStart = e as Frozen<Args<'classic.SessionStart'>>
        return next(e)
      }
      if (shouldRecord && event === 'classic.UserPromptSubmit') record()
      if (event === 'classic.UserPromptSubmit' || event === 'classic.SessionStart') await recover().catch((error: unknown) => claude().ui.log(`${definition.name} stays stopped: ${messageOf(error)}`, { to: 'debug' }))
      const isCallToThisMod = event === 'cmod.call' && (e as Frozen<Args<'cmod.call'>>).to === definition.name
      if (event === 'cmod.call' && !isCallToThisMod) return next(e)
      await (event === 'classic.SessionStart' || isCallToThisMod ? holdUntilStarted() : whenActive())
      if (event === 'classic.SessionStart' && phase !== 'active') missedSessionStart = e as Frozen<Args<'classic.SessionStart'>>
      if (isCallToThisMod && phase !== 'active') {
        const isStopped = phase === 'declined' || phase === 'failed'
        return { deny: isStopped ? `${definition.name} is not set up. Its toast says why.` : `${definition.name} is installing. Try again when it's ready.` } as EventResult<N>
      }
      const call = e as Frozen<Args<'cmod.call'>>
      if (event === 'cmod.call' && call.to === definition.name && mod !== undefined) {
        if (call.method === pendingStepsMethod) return { value: await pendingSteps(mod) } as EventResult<N>
        if (call.method === finishStepsMethod) return (await runSteps(mod), { value: null }) as EventResult<N>
      }
      if (event === 'classic.UserPromptSubmit' || event === 'classic.SessionStart') await refreshGrants().catch((error: unknown) => claude().ui.log(`${definition.name} keeps its grants from before: ${messageOf(error)}`, { to: 'debug' }))
      if (checksAnswers(event) && phase === 'active' && definition.name !== cmodPluginName) return checkedRoute(event, e, next)
      const answer = router.dispatch(event, e, next)
      const render = e as Frozen<Args<'ui.render'>>
      if (event !== 'ui.render' || render.component !== 'AbovePrompt' || runtime === undefined) return answer
      return runtime.toaster.draw((await answer) as EventResult<'ui.render'>, runtime.claude.ui.resolve(render), render.props, render.requestId) as EventResult<N>
    },
  }
}

async function createMod<State extends object, Declared extends Options>(definition: ModDefinition<State, string, Declared>, runtime: ModRuntime): Promise<ActiveMod<State, Declared>> {
  const { router, toaster } = runtime
  const report = (failure: Failure) => void toaster.fail(failure)
  const claude = answeringOwnCalls(withBareRefusals(checkingKeys(runtime.claude, toaster.toast, runtime.steps.keys ?? {})), router)
  const added: string[] = []
  const hooksAdded: Hook[] = []
  const announce = (feature: string) => {
    added.push(feature)
  }
  const [session, root, startCwd, home, configHome] = await Promise.all([claude.session.id(), claude.session.root(), claude.session.cwd(), claude.env.home(), claude.env.configHome()])
  const { granted } = runtime
  const configRoot = configHome ?? (home === undefined ? undefined : `${home}/.claude`)
  const grants: Grants = {
    name: definition.name,
    declared: runtime.steps.permissions ?? [],
    granted: () => granted,
    refresh: runtime.refreshGrants,
    home,
    configRoot,
    projectRoot: () => modState.root,
    freeFolders: () => [modState.root, runtime.dataFolder],
    freeAddresses: () => programAddresses(mod),
  }
  const checked = checkingGrants(claude, grants)
  const places: Places = { home, configRoot, projectRoot: () => modState.root }
  const files = createModFiles({
    name: definition.name,
    claude,
    places,
    checkWrite: (path) => checkWrite(grants, `metadata.update(${path})`, path),
    report,
  })
  const pages = new Map<string, { readonly title: string; readonly handle: PaneHandle }>()
  const settingsPages: Mod<State>['settings'] = {
    page(page) {
      if (pages.has(page.id)) throw new Error(`${definition.name}: the settings page "${page.id}" is already added. Give each page its own id.`)
      if (page.id === changelogPage) throw new Error(`${definition.name}: the settings page id "${changelogPage}" opens the mod's CHANGELOG.md in /mods. Give the page another id.`)
      pages.set(page.id, { title: page.title, handle: area.ui.pane(page) })
    },
    async open(pageId) {
      if (pageId === undefined) {
        await claude.cmod.call({ to: cmodPluginName, method: 'openSettings', input: { mod: definition.name } })
        return
      }
      const page = pages.get(pageId)
      if (page === undefined) throw new Error(`${definition.name} has no settings page "${pageId}". It has: ${[...pages.keys()].join(', ') || 'none'}.`)
      await page.handle.open({ focus: true })
    },
  }
  let cwd = startCwd
  let loadedCwd = startCwd
  let staleCwd: string | undefined
  let forkedFrom: string | undefined
  let parentAsked: Promise<string | undefined> | undefined
  let hasEarlierPrompts = true
  let agentType: string | undefined
  const area = createUi<State>({ name: definition.name, claude, router, toaster, report, announce, mod: () => mod })
  const askParent = async (): Promise<string | undefined> => {
    if (definition.name === cmodPluginName) return undefined
    try {
      const parent = await claude.cmod.call({ to: cmodPluginName, method: 'forkParent', input: null })
      return typeof parent === 'string' ? parent : undefined
    } catch (error) {
      claude.ui.log(`${definition.name} starts without the session values of the conversation it was forked from: ${messageOf(error)}`, { to: 'debug' })
      return undefined
    }
  }
  const forkParent = () =>
    (parentAsked ??= askParent().then((parent) => {
      forkedFrom = parent
      return parent
    }))
  const modState = createState<State>({ name: definition.name, initial: definition.state ?? {}, session, root, claude, report, changed: area.changed, forkParent })
  const modOptions = createOptions({ name: definition.name, declared: definition.options ?? {}, fromClaude: runtime.options, claude, report, changed: modState.changed })
  const held: HeldDecisions | undefined = runtime.checksPermissions() ? new Map() : undefined
  const expand = (path: string) => (homePrefix.test(path) ? resolvedPath(path, places) : path)
  const settingsFile = (source: 'user' | 'project' | 'local'): SettingsFile => ({
    read: () => checked.settings.read({ source }),
    async update(values) {
      await checkSettings(grants, source, values)
      await claude.cmod.call({ to: cmodPluginName, method: 'updateSettings', input: { mod: definition.name, source, project: modState.root, values } })
    },
  })
  const client = createSessionsClient({
    name: definition.name,
    claude: checked,
    report: (id, message, error) => report({ id, message, error }),
    isGranted: (permission) => flag(permission),
    hookOn: (hook, listener) => mod.on(hook as Hook, listener as HookListener<Hook>),
    routeOn: (event, hook) => router.add(event, hook as never),
  })
  let followed: Parameters<typeof client.follow>[0] | undefined
  let isSetUp = false
  const watches = new Set<{ readonly paths: readonly string[]; readonly listener: (change: FileChange) => unknown }>()
  const followFolders = (project: string, folder: string) => {
    if (followed === undefined) return
    followed = { ...followed, project, cwd: folder }
    client.follow(followed)
  }
  const imports: Imports = {
    sessions: client.sessions,
    settings: {
      list: async () =>
        (await checked.config.list()).map(({ key, label, description, kind, value, options, provider, isLocked }) => ({
          key,
          label,
          kind,
          value,
          isLocked,
          ...(description === undefined ? {} : { description }),
          ...(options === undefined ? {} : { options }),
          ...(provider.plugin === 'engine' ? {} : { plugin: provider.plugin }),
        })),
      user: settingsFile('user'),
      project: settingsFile('project'),
      local: settingsFile('local'),
      beforeFileChange: (matcherOrListener: unknown, maybeListener?: SettingsFileChangeListener) => {
        const listener = (maybeListener ?? matcherOrListener) as SettingsFileChangeListener
        const matcher = maybeListener === undefined ? undefined : matcherOrListener
        return mod.on(ConfigChange, async ({ source, file_path }) => {
          const change: SettingsFileChange = { source: source === 'skills' ? 'skills' : (source.replace('_settings', '') as SettingsFileChange['source']), ...(file_path === undefined ? {} : { path: file_path }) }
          if (matcher !== undefined && !matches(change, matcher)) return undefined
          const answer = await listener(change)
          return answer === undefined ? undefined : { decision: 'block', reason: answer.refuse }
        })
      },
    },
    model: { complete: (completion, options) => checked.model.complete(completion, options) },
    fs: {
      read: (path) => checked.fs.read(expand(path)),
      write: (path, text) => checked.fs.write(expand(path), text),
      exists: (path) => checked.fs.exists(expand(path)),
      find: (glob) => files.find(glob),
      list: async (path) => (await checked.fs.list(path === undefined ? undefined : expand(path))).map(({ name, kind, size, mtimeMs, isLink }) => ({ name, isFile: kind === 'file', isFolder: kind === 'dir', isLink, size, modifiedAt: mtimeMs })),
      async stat(path, options) {
        const { kind, size, mtimeMs, isLink, realPath } = await checked.fs.stat(expand(path), options)
        return { isFile: kind === 'file', isFolder: kind === 'dir', isLink, size, modifiedAt: mtimeMs, ...(realPath === undefined ? {} : { realPath }) }
      },
      onChange({ path }, listener) {
        if (isSetUp) throw new Error(`${definition.name}: fs.onChange works only in setup, because Claude Code reads the paths it watches when a session starts.`)
        const paths = [path].flat().map((each) => resolvedPath(each, places))
        const watch = { paths, listener }
        watches.add(watch)
        if (watches.size === 1) {
          mod.on(SessionStart, () => ({ hookSpecificOutput: { hookEventName: SessionStart, watchPaths: [...new Set([...watches].flatMap((each) => each.paths))] } }))
          mod.on(FileChanged, ({ file_path, event }) => {
            for (const each of watches) if (each.paths.some((watched) => relativePath(watched, file_path) !== undefined)) void Promise.resolve(each.listener({ path: file_path, type: event })).catch((error: unknown) => report({ id: 'fs:onChange', message: 'The fs.onChange listener failed', error }))
          })
        }
        return { dispose: () => void watches.delete(watch) }
      },
    },
    metadata: {
      read: (path) => files.read(path),
      update: (path, change) => files.update(path, change),
    },
    process: {
      run: (argv, init) => checked.process.run(argv, init),
      spawn: (argv, init) => checked.process.spawn({ ...init, argv }),
    },
    http: { fetch: (url, init) => checked.http.fetch(url, init) },
  }
  const allowed = (permission: string): Allowed => ({ allows: (value) => isCovered(granted, itemOf(permission, value), home) })
  const flag = (permission: string) => isCovered(granted, permission, home)
  const timer = (ms: number, subject: string, start: (ms: number, run: () => void) => { cancel(): void }, listener: () => unknown): Disposable => {
    let isRunning = false
    const started = start(checkedMs(definition.name, `mod.${subject}`, ms), () => {
      if (isRunning) return
      isRunning = true
      void Promise.resolve()
        .then(() => {
          bind(imports)
          return listener()
        })
        .catch((error: unknown) => report({ id: `${subject}:${ms}`, message: `The ${subject} ${ms} ms timer failed`, error }))
        .finally(() => {
          isRunning = false
        })
    })
    return { dispose: () => started.cancel() }
  }
  const mod: Mod<State, Declared> = {
    name: definition.name,
    folder: claude.plugin.root,
    dataFolder: runtime.dataFolder,
    state: modState.state,
    get options() {
      return modOptions.values as OptionValues<Declared>
    },
    permissions: {
      get conversation() {
        return flag('conversation')
      },
      get prompt() {
        return flag('prompt')
      },
      get model() {
        return flag('model')
      },
      get tasks() {
        return flag('tasks')
      },
      get tools() {
        return flag('tools')
      },
      get approve() {
        return flag('approve')
      },
      network: allowed('network'),
      run: allowed('run'),
      files: allowed('files'),
      config: allowed('config'),
    },
    on(hook: Hook, matcherOrListener: unknown, listenerOrOptions?: unknown, maybeOptions?: HookOptions): Disposable {
      const hasMatcher = typeof listenerOrOptions === 'function'
      const listener = (hasMatcher ? listenerOrOptions : matcherOrListener) as HookListener<Hook>
      const matcher = hasMatcher ? matcherOrListener : undefined
      const options = (hasMatcher ? maybeOptions : listenerOrOptions) as HookOptions | undefined
      if (!hooks.includes(hook)) throw new Error(`${definition.name}: mod.on takes one of Claude Code's hooks, such as PreToolUse, not ${String(hook)}.`)
      const matched: HookListener<Hook> = matcher === undefined ? listener : (input) => (matches(input, matcher) ? listener(input) : undefined)
      const bounded = options?.timeoutMs === undefined ? matched : timedHook(hook, matched, checkedMs(definition.name, `the ${hook} hook's timeoutMs`, options.timeoutMs), claude, toaster.toast)
      if (!hooksAdded.includes(hook)) hooksAdded.push(hook)
      if (hook === PreToolUse) return router.add('tool.call', preToolUseHook(definition.name, bounded as HookListener<typeof PreToolUse>, claude, agents, held))
      const classic: Exclude<Hook, typeof PreToolUse> = hook
      return router.add(`classic.${classic}`, classicHook(definition.name, classic, bounded as HookListener<typeof classic>, claude, agents, report))
    },
    every: (ms, listener) => timer(ms, 'every', claude.clock.every, listener),
    after: (ms, listener) => timer(ms, 'after', claude.clock.after, listener),
    use: (job) => job({ mod, announce, reserveName }),
    log: (text, options) => claude.ui.log(`${definition.name}: ${text}`, { to: options?.to ?? 'debug' }),
    ui: { ...area.ui, notice: (callId, text) => claude.ui.notice(callId, text) },
    settings: settingsPages,
    dependencies: dependencyCalls(claude, (call, task) => beforeDeadline(claude, { ms: dependencyCallMs }, call, task)),
  }
  bind(imports)
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
      followFolders(nextRoot, nextCwd)
      await modState.moveTo(nextRoot).catch((error: unknown) => {
        if (cwd === nextCwd) cwd = loadedCwd
        followFolders(modState.root, cwd)
        throw error
      })
      if (hasMovedRoot) await modOptions.load(nextRoot)
      loadedCwd = nextCwd
      if (!hasMovedRoot) area.changed()
      if (nextCwd === oldCwd) return
      const moved: HookInput<'CwdChanged'> = { session_id: await claude.session.id(), cwd: nextCwd, hook_event_name: 'CwdChanged', old_cwd: oldCwd, new_cwd: nextCwd }
      await router.dispatch('classic.CwdChanged', moved as Frozen<Args<'classic.CwdChanged'>>, async () => ({}))
    } catch (error) {
      report({ id: 'cmod:follow', message: `Keeps the state of ${modState.root} until the next prompt or folder move`, error })
    }
  }
  const followCurrent = async (title: string | undefined) => {
    const [id, model, usage] = await Promise.all([claude.session.id(), claude.session.model(), claude.session.usage()])
    followed = { id, title: title ?? '', project: modState.root, cwd, model, startedAt: new Date(usage.startedAt).toISOString(), ...(forkedFrom === undefined ? {} : { forkedFrom }), ...(agentType === undefined ? {} : { agentType }) }
    client.follow(followed)
  }
  router.add('classic.SessionStart', async (e, next) => {
    agentType = e.agent_id === undefined ? e.agent_type : agentType
    const previous = followed?.id
    if (e.source === 'fork' && previous !== undefined && previous !== e.session_id) forkedFrom = previous
    else if (e.session_id !== previous) {
      forkedFrom = undefined
      parentAsked = undefined
    }
    hasEarlierPrompts = e.source !== 'startup' && e.source !== 'clear'
    await modState.switchSession(e.session_id, e.source, e.transcript_path).catch((error: unknown) => {
      report({ id: 'cmod:session', message: `Kept its session values from before the ${e.source}`, error })
    })
    await followCurrent(e.session_title).catch((error: unknown) => report({ id: 'cmod:current', message: 'Kept the details of the session from before', error }))
    return next(e)
  })
  router.add('classic.UserPromptSubmit', async (e, next) => {
    staleCwd = undefined
    await followSession()
    const isPerson = e.source === undefined || e.source === 'user' || e.source === 'sdk'
    await followCurrent(e.session_title || (isPerson && !hasEarlierPrompts && client.sessions.current.title === '' ? firstLine(e.prompt) : undefined)).catch((error: unknown) => report({ id: 'cmod:current', message: 'Kept the details of the session from before', error }))
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
    if (e.command === 'cd') {
      await followSession(true)
      conversations?.moved()
    }
    return answer
  })
  router.add('skill.prompt', userSkillHook(claude))
  const api = Object.fromEntries(Object.entries(definition.api ?? {}).map(([method, run]) => [method, (input: never) => run(input, mod)]))
  const conversations = definition.name === cmodPluginName ? serveConversations({ claude, router, store: runtime.store, project: () => modState.root, report: (id, message, error) => report({ id, message, error }) }) : undefined
  router.add('cmod.call', async (e, next) => {
    if (e.to !== definition.name) return next(e)
    const call = e as typeof e & { readonly caller?: string }
    if (e.method === conversationMethods.changed && call.caller === cmodPluginName) {
      const { session: changedSession, change, isInProject } = e.input as { readonly session: string; readonly change: SessionChange; readonly isInProject?: boolean }
      if (changedSession !== client.sessions.current.id && !flag('conversation')) return { value: null }
      client.changed(changedSession, change, isInProject !== false)
      return { value: null }
    }
    if (e.method === conversationMethods.before && call.caller === cmodPluginName) {
      const { session: asking, event, change, isInProject } = e.input as { readonly session: string; readonly event: BeforeEvent; readonly change: SessionChange; readonly isInProject?: boolean }
      return { value: (await client.answerBefore(asking, event, change, isInProject !== false)) ?? null }
    }
    if (e.method === settingsPagesMethod) return { value: [...pages].map(([id, { title }]) => ({ id, title })) }
    if (e.method === openPageMethod) {
      await settingsPages.open(String(e.input))
      return { value: null }
    }
    const served = await conversations?.answer(call)
    return served ?? answerCall(definition.name, api, e)
  })
  const agents = toolCalls(claude, router)
  keepEngine(mod, { claude: checked, router, toolCalls: agents, report })
  const names = new Set<string>()
  const reserveName = (type: string, name: string, taken: string): Disposable => {
    const key = `${type}:${name}`
    if (names.has(key)) throw new Error(taken)
    names.add(key)
    return { dispose: () => void names.delete(key) }
  }
  await failsAs('its state did not load', () => modState.load())
  await failsAs('its options did not load', () => modOptions.load(root))
  const missing = modOptions.missing
  if (missing.length > 0) throw new MissingOptions(missing, missing.map((key) => definition.options?.[key]?.title ?? key))
  await failsAs('the details of its session did not load', () => followCurrent(undefined))
  await failsAs('its setup function threw', () => definition.setup(mod))
  isSetUp = true
  const permissionHooks = permissionEvents.filter((event) => router.has(event))
  if (permissionHooks.length > 0 && !runtime.checksPermissions()) {
    throw new Error(`it decides permissions on ${listed(permissionHooks)}, so hooks/register.ts must call registerPermissionCheck(addHook) after registerMod`)
  }
  if (held !== undefined && hooksAdded.includes(PreToolUse)) router.add('tool.check', heldDecisionHook(held))
  await failsAs('its open panes did not load', () => area.restorePanes())
  if (hooksAdded.length > 0) added.push(`${hooksAdded.length === 1 ? 'a hook' : 'hooks'} on ${listed(hooksAdded)}`)
  return { mod, added, imports }
}

function checkingKeys(claude: Claude, toast: Toast, keys: Readonly<Record<string, string>>): Claude {
  const bound = Object.entries(keys)
  if (bound.length === 0) return claude
  const register: Claude['command']['register'] = (command) => {
    for (const [key, commandName] of bound) {
      if (commandName === command.name && command.immediate !== true) {
        toast.warning(`${key} runs /${command.name}, which waits for Claude's turn to end`, { id: `key:${key}`, description: `It adds a row to the conversation. Give /${command.name} immediate: true.`, duration: Infinity })
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

function timedHook<H extends Hook>(event: H, hook: HookListener<H>, ms: number, claude: Claude, toast: Toast): HookListener<H> {
  return (input) =>
    new Promise((resolve, reject) => {
      const timer = claude.clock.after(ms, () => {
        toast.warning(`The ${event} hook passed its ${ms / 1000} s timeout`, { id: `timeout:${event}` })
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

function progressOf({ done, total, label }: Extract<RunnerEvent, { type: 'progress' }>): RenderElement {
  return Box({ gap: 2, children: [Progress({ value: total > 0 ? (done / total) * 100 : 0 }), Text({ dimColor: true, wrap: 'truncate-end', children: label })] })
}
