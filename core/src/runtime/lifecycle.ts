import type { Args, Caught, ClassicHookInputs, EventResult, Frozen, HookBudget, PluginOptions, RenderElement, Timer } from 'claude-code'
import type { Step } from '../installer.js'

import type { Allowed, Imports, Mod, ModDefinition, Reservation, SettingsFile, SettingsFileChange, SettingsFileChangeListener, Subscription, Timer as ModTimer } from '../mod.js'
import type { Options, OptionValues } from '../options.js'
import { consentPath, dataFolder, finishStepsMethod, grantFix, coreVersion, isAtLeast, isProgramNewer, marketplaceOf, parseConsent, pendingStepsMethod, parseEvent, permissionWords, programPath, readCmodVersion, readRecord, readSteps, recordPath, scriptsSha256, storeFolder, updatesToTurnOn, type ReadFile, type RunnerEvent, type Steps } from '../records.js'
import { homePrefix, ifMissing, relativePath } from '../utils/paths.js'
import { firstLine, formatExit, messageOf } from '../utils/text.js'
import type { Claude } from './claude.js'
import { beforeDeadline } from './deadline.js'
import { announcementMs, announcementOf } from './announce.js'
import { bind } from './bound.js'
import { serveConversations } from './conversations.js'
import { answerCall, answeringOwnCalls, cmodPluginName, dependencyCalls, withBareRefusals } from './dependencies.js'
import { keepEngine } from './engine.js'
import { classicFailure, classicHook, userSkillHook, type Hook, type HookFields, type HookListener, type RoutedEvent } from './hooks.js'
import type { PermissionRoutes } from './permission-check.js'
import { checkedAnswer, checkingGrants, checkRun, checkSettings, checksAnswers, checkWrite, isCovered, itemOf, passedDown, programAddresses, refusal, type AnswerCheck, type Grants } from './grants.js'
import { cmodError, locatingPrograms, readLines, spawnCmod, type Programs } from './programs.js'
import { createModFiles, resolvedPath, type Places } from './metadata.js'
import { fitsOption } from '../options.js'
import { createInstaller } from './installer.js'
import { createOptions, MissingOptions } from './options.js'
import { createRouter, type Router, type RouterNext } from './router.js'
import { conversationMethods, createSessionsClient, type SessionColor, type SessionsClient } from './sessions.js'
import type { SessionChange, TurnData } from '../session/conversation.js'
import type { BeforeEvent } from '../session/session.js'
import { matches } from '../utils/matcher.js'
import { createState } from './state.js'
import { createToaster, type Failure, type ShownToast, type Toaster } from './toaster.js'
import { toolCalls } from './tool-calls.js'
import { createHotkeys } from './hotkeys.js'
import { servePages, type Pages } from './pages.js'
import { drawnParts, type DrawnParts } from './parts.js'
import { createWatches } from './watches.js'
import { createUi, partMethods, type BorrowedMarkdown, type PartDraw, type PartPress, type PartsUpdate, type ShownPages, type UiArea } from './ui.js'
import { serveWidgets } from './widgets.js'
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
  caught<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, next: RouterNext<N>, failure: Caught): Promise<EventResult<N>>
  raise(method: string, payload: Readonly<Record<string, unknown>>): Promise<unknown>
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
  readonly permissionRoutes: () => PermissionRoutes | undefined
  readonly options: PluginOptions
  readonly nextDraw: () => number
}

type ActiveMod<State extends object, Declared extends Options> = {
  readonly mod: Mod<State, Declared>
  readonly added: readonly string[]
  readonly imports: Imports
  readonly raise: SessionsClient['raise']
  readonly area: UiArea<State>
}


const announcedKey = 'cmod:announced'

const cmodUpdatedKey = 'cmod:cmod-updated-for'

const installId = 'cmod:install'
const askingId = 'cmod:asking'

const recordId = 'cmod:record'

const installRetrySeconds = [2, 4, 8, 16, 32, 64, 128] as const

const cmodCheckMs = 1000

const recordCheckMs = 1000

const drawsPerMs = 1000

const cmodWaitMs = 60_000

const cmodSlowCheckMs = 10_000

const hookMs = 10_000 satisfies HookBudget['ms']

const startHoldMs = hookMs - 1_000

const dependencyCallMs = 30_000


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
  if (version === undefined || record?.scriptsSha256 !== scripts) return { ...plugin, isInstalled: false, shouldRecord: false }
  const isInstalled = record.version === version || record.root === root
  const programModifiedMs = record.program === null ? undefined : (await claude.fs.stat(programPath(store, record.program, record.version)).catch(ifMissing(undefined)))?.mtimeMs
  return { ...plugin, isInstalled, shouldRecord: isInstalled && (record.version !== version || isProgramNewer(record, programModifiedMs)) }
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
  const store = storeFolder({ HOME: await claude.env.home(), XDG_DATA_HOME: await claude.env.dataHome() })
  return readCmodVersion(
    {
      list: async (folder) => (await claude.fs.list(folder).catch(ifMissing([]))).map((entry) => entry.name),
      exists: async (path) => (await claude.fs.stat(path).catch(ifMissing(undefined))) !== undefined,
    },
    store,
  )
}

export function createLifecycle<State extends object, Declared extends Options = Options>(
  definition: ModDefinition<State, string, Declared>,
  permissionRoutes: () => PermissionRoutes | undefined = () => undefined,
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
  const openSettings = async () => {
    await claude().cmod.call({ to: cmodPluginName, method: partMethods.changed, input: { requests: [{ settings: true }], isAsked: true } })
  }
  let imports: Imports | undefined
  let raise: SessionsClient['raise'] | undefined
  let failure: unknown
  let pluginOptions = options
  let drawCount = 0
  const nextDraw = () => (drawCount += 1)
  const installer = createInstaller(
    definition.name,
    () => claude(),
    {
      show: (open) => {
        if (phase !== 'active') runtime?.toaster.toast.dismiss(installId)
        runtime?.toaster.toast.info('Installing', { id: askingId, description: 'Waiting for your answer', duration: Infinity, action: { label: 'Answer', onClick: open } })
      },
      hide: () => runtime?.toaster.toast.dismiss(askingId),
    },
    nextDraw,
  )
  let shouldRecord = false
  let recording: Promise<void> | undefined
  let missedSessionStart: Frozen<Args<'classic.SessionStart'>> | undefined
  let hasHeardSessionStart = false
  let settleStart: () => void = () => undefined
  const startSettled = new Promise<void>((resolve) => (settleStart = resolve))

  const claude = () => {
    if (runtime === undefined) throw new Error(`${definition.name}: the lifecycle has not started. registerMod(addHook, mod, options) starts it at session.start.`)
    return runtime.claude
  }

  const installing = (description?: string | RenderElement) => runtime?.toaster.toast.loading('Installing', { id: installId, ...(description === undefined ? {} : { description }) })

  const toastFailure = (shown: Failure) => runtime?.toaster.fail(shown)

  const fail = (reason: string, fix: string | undefined, retry?: () => Promise<void>, error?: unknown) => {
    phase = 'failed'
    failure ??= new Error(`${definition.name}: ${reason}${/[.!?]$/.test(reason) ? '' : '.'}${fix === undefined ? '' : ` ${fix}`}`, { cause: error })
    const again = retry === undefined ? {} : { retry: () => ((failure = undefined), stopRetrying(), retry().catch(report)) }
    toastFailure({ id: installId, message: reason, ...(fix === undefined ? {} : { description: fix }), ...(error === undefined ? {} : { error }), ...again, isCritical: true })
    watchRecord()
  }

  let consented: string | undefined
  const installAgain = () => install(consented)
  const updateAgain = () => claude().store.delete(cmodUpdatedKey).then(installAgain)

  type Retrying = { readonly when: 'changed' | 'later'; readonly tries: number; readonly reason: string; readonly timer: Timer }
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

  const failInstall = (reason: string, when: 'changed' | 'later' | undefined) => {
    if (when === undefined) {
      stopRetrying()
      return fail(reason, undefined, installAgain)
    }
    retryLater({ when, tries: retrying?.when === when ? retrying.tries : 0, reason })
  }

  const retryInBackground = async () => {
    if (phase !== 'failed' || retrying === undefined) return
    if (await recover()) {
      stopRetrying()
      return whenActive()
    }
    await install(consented, true)
    await whenActive()
  }

  const finish = async () => {
    await programs?.refresh()
    phase = 'ready'
    activation ??= new Promise<void>((resolve) => claude().clock.after(0, () => resolve(activate().catch(report))))
    claude().ui.invalidate('ui.render')
  }

  const recordThroughCmod = async () => {
    if (plugin === undefined || (await cmodVersion(claude())) === undefined) return
    let failed: string | undefined
    const { code, lastError } = await readLines(claude().process.spawn({ argv: ['cmod', 'setup', plugin.root, '--events'] }), (text) => {
      const event = parseEvent(text)
      if (event.type === 'done') shouldRecord = false
      if (event.type === 'failed') failed = event.message
    })
    if (!shouldRecord) {
      runtime?.toaster.toast.dismiss(recordId)
      return programs?.refresh()
    }
    if (failed !== undefined) return void toastFailure({ id: recordId, message: failed, retry: record, isCritical: true })
    throw new Error(`cmod setup ${formatExit(code, lastError)}`)
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
    try {
      for (const [index, step] of steps.entries()) {
        if (await isStepDone(active, step)) continue
        const isAnswered = (await claude().session.surfaces()).length > 0 && (await installer.step(active, step, index + 1, steps.length))
        if (!isAnswered) {
          runtime?.toaster.toast.warning(steps.length - index === 1 ? 'Needs one more step' : `Needs ${steps.length - index} more steps`, {
            id: 'cmod:steps',
            description: `Starting with ${step.title}.`,
            duration: Infinity,
            action: { label: 'Finish', onClick: () => runSteps(active) },
          })
          break
        }
      }
    } finally {
      await installer.close()
    }
  }

  const activate = async (): Promise<void> => {
    if (runtime === undefined || plugin === undefined) return
    const activeRouter = createRouter()
    const active = await createMod(definition, { ...runtime, router: activeRouter, dataFolder: dataFolder(plugin.store, plugin.name), store: plugin.store, steps: plugin.steps, granted, refreshGrants, permissionRoutes, options: pluginOptions, nextDraw }).catch(async (error: unknown) => {
      if (error instanceof MissingOptions && (await askOptions(error))) return undefined
      await installer.close()
      fail(messageOf(error), error instanceof MissingOptions ? `Retry asks for ${error.keys.length === 1 ? 'it' : 'them'}.` : undefined, begin, error)
      throw error
    })
    if (active === undefined) return activate()
    const { added } = active
    mod = active.mod
    imports = active.imports
    raise = active.raise
    router = activeRouter
    phase = 'active'
    stopWatchingRecord()
    runtime.claude.ui.invalidate('ui.render')
    if (definition.name === cmodPluginName) runtime.claude.ui.invalidate('command.describe')
    void runSteps(active.mod).catch((error: unknown) => toastFailure({ id: 'cmod:steps', message: 'Its installer stopped', error, isCritical: true }))
    const missed = missedSessionStart
    missedSessionStart = undefined
    if (missed !== undefined) await replaySessionStart(missed)
    if ((await runtime.claude.store.get(announcedKey)) !== undefined) {
      runtime.toaster.toast.dismiss(installId)
      return
    }
    await runtime.claude.store.set(announcedKey, { version: plugin.version ?? '' })
    const { toaster } = runtime
    void announcementOf(runtime.claude, plugin, granted, added, openSettings)
      .then(({ message, ...options }) => toaster.toast.success(message, { id: installId, duration: announcementMs, ...options }))
      .catch((error: unknown) => toastFailure({ id: installId, message: 'Could not say what it installed', error }))
  }

  const replaySessionStart = async (e: Frozen<Args<'classic.SessionStart'>>) => {
    hasHeardSessionStart = true
    const ran = definition.name === cmodPluginName ? router.dispatch('classic.SessionStart', e, async () => ({})) : checkedRoute('classic.SessionStart', e, async () => ({}))
    const answer = await ran.catch((error: unknown) => {
      toastFailure({ id: 'classic.SessionStart', message: 'The SessionStart hook failed', error })
      return {}
    })
    const { additionalContext, ...unread } = answer as { readonly additionalContext?: readonly string[] } & Record<string, unknown>
    for (const text of additionalContext ?? []) {
      const added = await claude().session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      if (added.deny !== undefined) claude().ui.log(`${definition.name}: Claude Code refused its SessionStart note: ${added.deny}`, { to: 'debug' })
    }
    if (Object.keys(unread).length > 0) {
      claude().ui.log(`${definition.name} started after Claude Code's SessionStart, so Claude Code did not read ${Object.keys(unread).join(', ')} from its SessionStart hooks.`, { to: 'debug' })
    }
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
    const updates = await updatesToShow().catch((error: unknown) => {
      toastFailure({ id: 'cmod:updates', message: 'Could not read whether its marketplace updates automatically', error })
      return undefined
    })
    const installedElsewhere = new Promise<'installed'>((resolve) => (settleAsked = () => resolve('installed')))
    watchRecord()
    const answer = await Promise.race([installer.consent({ ...event, program: plugin?.steps.program ?? '', updates }), installedElsewhere]).finally(() => {
      settleAsked = undefined
    })
    await installer.close()
    if (answer === 'installed') return startInstalled()
    if (answer) {
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

  const fits = (found: string | undefined): found is string => found !== undefined && isAtLeast(found, coreVersion)

  const waitForcmod = (found: string | undefined) => {
    phase = 'waiting'
    installing('Waiting for cmod')
    let latest = found
    let check: Promise<void> | undefined
    const stop = () => {
      timer.cancel()
      longWait.cancel()
    }
    const poll = (ms: number) =>
      claude().clock.every(ms, () => {
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
    let timer = poll(cmodCheckMs)
    const longWait = claude().clock.after(cmodWaitMs, () => {
      timer.cancel()
      timer = poll(cmodSlowCheckMs)
      if (latest === undefined) return installing("Still waiting for cmod to download cmod. See cmod's own line.")
      const found = latest
      const tried = `${found} to ${coreVersion}`
      return claude()
        .store.get(cmodUpdatedKey)
        .then(async (updated) => {
          if (updated === tried) {
            stop()
            return fail(`${definition.name} needs cmod ${coreVersion} or later, and the newest cmod is ${found}.`, undefined, updateAgain)
          }
          await claude().store.set(cmodUpdatedKey, tried)
          installing(`${definition.name} needs cmod ${coreVersion} or later, and this computer has cmod ${found}, so cmod is updating itself.`)
          const { code, lastError } = await readLines(claude().process.spawn({ argv: ['cmod', 'update', 'cmod'] }), () => undefined)
          if (code === 0) return
          stop()
          fail(`${definition.name} needs cmod ${coreVersion} or later, and updating cmod ${found} ${formatExit(code, lastError)}`, undefined, updateAgain)
        })
        .catch(report)
    })
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
    if (phase !== 'failed') fail(messageOf(error), undefined, begin, error)
  }

  let consentMs = 0
  const stampOf = async (path: string) => {
    const stat = await claude().fs.stat(path).catch(ifMissing(undefined))
    return stat?.kind === 'file' ? stat.mtimeMs : 0
  }
  let recordMs = 0
  let readStarted: ((claude: Claude) => Promise<Plugin>) | undefined
  const isNewlyInstalled = async (): Promise<boolean> => {
    if (plugin === undefined || readStarted === undefined) return false
    const modifiedMs = await stampOf(recordPath(plugin.store, plugin.name))
    if (modifiedMs === recordMs) return false
    recordMs = modifiedMs
    const current = await readStarted(claude())
    if (!current.isInstalled) return false
    plugin = current
    return true
  }
  const startInstalled = async () => {
    failure = undefined
    activation = undefined
    await refreshGrants()
    await finish()
  }
  let settleAsked: (() => void) | undefined
  const recover = async (): Promise<boolean> => {
    if ((settleAsked === undefined && phase !== 'failed' && phase !== 'declined') || !(await isNewlyInstalled())) return false
    if (settleAsked === undefined) await startInstalled()
    else settleAsked()
    return true
  }
  let recordCheck: Timer | undefined
  let checking: Promise<void> | undefined
  const watchRecord = () => {
    recordCheck ??= claude().clock.every(recordCheckMs, () => {
      checking ??= recover()
        .then(() => undefined)
        .catch((error: unknown) => claude().ui.log(`${definition.name} could not read whether another cmod installed it: ${messageOf(error)}`, { to: 'debug' }))
        .finally(() => {
          checking = undefined
        })
    })
  }
  const stopWatchingRecord = () => {
    recordCheck?.cancel()
    recordCheck = undefined
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
      const isDeclared = (plugin?.steps.permissions ?? []).includes(item)
      toastFailure({
        id: `dropped:${item}`,
        message: `Answered ${part} without your grant to "${permissionWords(item)}", so cmod dropped it`,
        description: isDeclared ? grantFix : `It needs "permissions": { "${item}": true } in package.json "cmod".`,
      })
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
    async raise(method, payload) {
      if (raise === undefined || imports === undefined) throw new Error(`${definition.name} has not started, so ${method} has no listener yet.`)
      bind(imports)
      return raise(method, payload)
    },
    async start(claudeCalls, read) {
      if (runtime !== undefined) return
      programs = locatingPrograms(claudeCalls)
      const callingCmod: Claude = {
        ...claudeCalls,
        cmod: {
          async call(input) {
            if (input.to === definition.name) await holdUntilStarted()
            return answeringOwnCalls(claudeCalls, router).cmod.call(input)
          },
        },
      }
      runtime = { claude: programs.claude, toaster: createToaster(callingCmod, definition.name, () => plugin?.version) }
      readStarted = read
      try {
        drawCount = (await claudeCalls.clock.now()) * drawsPerMs
        await programs.refresh()
        await begin().catch(report)
      } finally {
        settleStart()
      }
    },
    async route<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, next: RouterNext<N>): Promise<EventResult<N>> {
      if (imports !== undefined) bind(imports)
      const asked = e as Frozen<Args<'cmod.call'>> & { readonly caller?: string }
      if (event === 'cmod.call' && asked.to === definition.name && asked.caller === cmodPluginName) {
        if (asked.method === partMethods.shown) installer.hear(asked.input as ShownPages)
        const answered = installer.answer(asked.method, asked.input)
        if (answered !== undefined) return (await answered.catch((error: unknown) => ({ deny: `${definition.name}: ${messageOf(error)}` }))) as EventResult<N>
        if (asked.method === partMethods.shown && phase !== 'active') return { value: null } as EventResult<N>
      }
      if (event === 'classic.SessionStart') {
        missedSessionStart = undefined
        hasHeardSessionStart = true
      }
      if (event === 'classic.SessionStart' && runtime === undefined) {
        missedSessionStart = e as Frozen<Args<'classic.SessionStart'>>
        return next(e)
      }
      if (shouldRecord && event === 'classic.UserPromptSubmit') record()
      if (event === 'classic.UserPromptSubmit' || event === 'classic.SessionStart') await recover().catch((error: unknown) => claude().ui.log(`${definition.name} stays stopped: ${messageOf(error)}`, { to: 'debug' }))
      const tool = (e as { readonly tool?: unknown }).tool
      const isCallToThisMod = (event === 'cmod.call' && (e as Frozen<Args<'cmod.call'>>).to === definition.name) || (event === 'tool.call' && typeof tool === 'string' && tool.startsWith(`mcp__${definition.name}__`))
      if (event === 'cmod.call' && !isCallToThisMod) return next(e)
      await (event === 'classic.SessionStart' || event === 'session.append' || isCallToThisMod ? holdUntilStarted() : whenActive())
      if (event === 'classic.SessionStart' && phase !== 'active') {
        missedSessionStart = e as Frozen<Args<'classic.SessionStart'>>
        return next(e)
      }
      if (isCallToThisMod && phase !== 'active') {
        const isStopped = phase === 'declined' || phase === 'failed'
        return { deny: isStopped ? `${definition.name} is not set up. Its toast says why.` : `${definition.name} is installing. Try again when it's ready.` } as EventResult<N>
      }
      const call = e as Frozen<Args<'cmod.call'>>
      if (event === 'cmod.call' && call.to === definition.name && mod !== undefined) {
        if (call.method === pendingStepsMethod) return { value: await pendingSteps(mod) } as EventResult<N>
        if (call.method === finishStepsMethod) {
          const active = mod
          const opened = await installer.collect(() => Promise.race([runSteps(active).catch((error: unknown) => void toastFailure({ id: 'cmod:steps', message: 'Could not finish the setup', error, isCritical: true })), installer.shown()]))
          return { value: opened } as EventResult<N>
        }
      }
      if (event === 'classic.UserPromptSubmit' || event === 'classic.SessionStart') await refreshGrants().catch((error: unknown) => claude().ui.log(`${definition.name} keeps its grants from before: ${messageOf(error)}`, { to: 'debug' }))
      if (event === 'classic.UserPromptSubmit' && phase === 'active' && !hasHeardSessionStart) {
        const { session_id, transcript_path, cwd } = e as Frozen<Args<'classic.UserPromptSubmit'>>
        await replaySessionStart({ session_id, transcript_path, cwd, hook_event_name: 'SessionStart', source: 'resume' })
      }
      if (checksAnswers(event) && phase === 'active' && definition.name !== cmodPluginName) return checkedRoute(event, e, next)
      const answer = router.dispatch(event, e, next)
      const render = e as Frozen<Args<'ui.render'>>
      if (event !== 'ui.render' || render.component !== 'AbovePrompt' || runtime === undefined) return answer
      return runtime.toaster.draw((await answer) as EventResult<'ui.render'>, runtime.claude.ui.resolve(render), render.props, render.requestId) as EventResult<N>
    },
    async caught<N extends RoutedEvent>(event: N, e: Frozen<Args<N>>, next: RouterNext<N>, { error: { kind, message }, called }: Caught): Promise<EventResult<N>> {
      const call = e as Frozen<Args<'cmod.call'>>
      const isAsk = event === 'cmod.call' && call.to === definition.name && beforeAskOf(call) !== undefined
      const reasons: Readonly<Record<string, string>> = { timeout: `it ran past the ${hookMs / 1000} s Claude Code gives a hook`, throw: message ?? 'it threw' }
      const reason = reasons[kind]
      if (reason === undefined) return isAsk ? ({ value: null } as EventResult<N>) : next(e)
      const error = new Error(reason)
      const failedBeneath = called && kind === 'throw' ? await next(e).then(() => undefined, messageOf) : undefined
      if (failedBeneath === undefined || failedBeneath !== message) toastFailure({ id: `stopped:${event}`, message: `Claude Code stopped its ${event.replace(/^classic\./, '')} hook`, error })
      return router.dispatchFailure(event, e, error, next)
    },
  }
}

async function createMod<State extends object, Declared extends Options>(definition: ModDefinition<State, string, Declared>, runtime: ModRuntime): Promise<ActiveMod<State, Declared>> {
  const { router, toaster } = runtime
  const report = (failure: Failure) => void toaster.fail(failure)
  const claude = answeringOwnCalls(withBareRefusals(runtime.claude), router)
  const added: string[] = []
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
    freeFolders: () => [modState.root, definition.name === cmodPluginName ? runtime.store : runtime.dataFolder],
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
  let cwd = startCwd
  let loadedCwd = startCwd
  let staleCwd: string | undefined
  let forkedFrom: string | undefined
  let parentAsked: Promise<string | undefined> | undefined
  let hasEarlierPrompts = true
  let agentType: string | undefined
  let parts: DrawnParts | undefined
  const borrowed: BorrowedMarkdown = (styler, cached, input, scope) => {
    const name = `The markdown style of ${styler}`
    void parts?.fill(styler, cached, input, name)?.then(() => claude.ui.invalidate('ui.render'))
    return parts?.element(styler, cached, `${styler}/markdown:${scope}:`, name, `markdown:${styler}`)
  }
  const area = createUi<State>({ name: definition.name, claude, router, report, announce, mod: () => mod, borrowed, nextDraw: runtime.nextDraw })
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
  const hookOn = <H extends Hook>(hook: H, listener: HookListener<H>, failed?: (input: ClassicHookInputs[H], error: Error) => HookFields | undefined): Subscription =>
    router.add(`classic.${hook}`, classicHook(hook, listener, report), failed === undefined ? undefined : classicFailure(failed))
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
    permissionRefusal: (call, permission) => refusal(grants, call, permission),
    hookOn: (hook, listener, failed) => hookOn(hook as Hook, listener as HookListener<Hook>, failed),
    routeOn: (event: RoutedEvent, hook: unknown, failed?: unknown) => router.add(event, hook as never, failed as never),
    permissionRoutes: runtime.permissionRoutes,
  })
  let followed: Parameters<typeof client.follow>[0] | undefined
  const watches = createWatches(claude, report)
  const followFolders = (project: string, folder: string) => {
    if (followed === undefined) return
    followed = { ...followed, project, cwd: folder }
    client.follow(followed)
  }
  const imports: Imports = {
    sessions: client.sessions,
    commands: {
      list: async () => (await checked.command.list()).map(({ name, description, source, plugin }) => ({ name, description, source, ...(plugin === undefined ? {} : { plugin }) })),
      run: async (command, args) => {
        const { text, context } = await checked.command.run({ command, ...(args === undefined ? {} : { args }) })
        return { ...(text === undefined ? {} : { text }), ...(context === undefined || context.length === 0 ? {} : { note: context.join('\n') }) }
      },
      beforeRun: (...args: unknown[]) => client.listen('beforeRun', args),
      onRun: (...args: unknown[]) => client.listen('onRun', args),
    },
    config: {
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
    },
    settings: {
      user: settingsFile('user'),
      project: settingsFile('project'),
      local: settingsFile('local'),
      beforeFileChange: (matcherOrListener: unknown, maybeListener?: SettingsFileChangeListener) => {
        const listener = (maybeListener ?? matcherOrListener) as SettingsFileChangeListener
        const matcher = maybeListener === undefined ? undefined : matcherOrListener
        return hookOn('ConfigChange', async ({ source, file_path }) => {
          const change: SettingsFileChange = { source: source === 'skills' ? 'skills' : (source.replace('_settings', '') as SettingsFileChange['source']), ...(file_path === undefined ? {} : { path: file_path }) }
          if (matcher !== undefined && !matches(change, matcher)) return undefined
          const refuse = (await listener(change))?.refuse
          return typeof refuse === 'string' ? { block: refuse } : undefined
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
      onChange: ({ path }, listener) => watches.add([path].flat().map((each) => resolvedPath(each, places)), (change) => {
        bind(imports)
        return listener(change)
      }),
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
    clipboard: {
      async write(text) {
        await toaster.copy(text)
      },
    },
  }
  const allowed = (permission: string): Allowed => ({ allows: (value) => isCovered(granted, itemOf(permission, value), home) })
  const flag = (permission: string) => isCovered(granted, permission, home)
  const timer = (ms: number, subject: string, repeats: boolean, listener: () => unknown): ModTimer => {
    let isFiring = false
    let isRunning = true
    const fire = () => {
      if (!repeats) isRunning = false
      if (isFiring) return
      isFiring = true
      void Promise.resolve()
        .then(() => {
          bind(imports)
          return listener()
        })
        .catch((error: unknown) => report({ id: `${subject}:${ms}`, message: `The ${subject} ${ms} ms timer failed`, error }))
        .finally(() => {
          isFiring = false
        })
    }
    const checked = checkedMs(definition.name, `mod.${subject}`, ms)
    const started = repeats ? claude.clock.every(checked, fire) : claude.clock.after(checked, fire)
    return {
      get isRunning() {
        return isRunning
      },
      stop() {
        isRunning = false
        started.cancel()
      },
    }
  }
  const hotkeys = await createHotkeys({ name: definition.name, declared: definition.hotkeys ?? {}, configRoot, claude, router, answerInput: area.answerInput, report })
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
    hotkeys,
    every: (ms, listener) => timer(ms, 'every', true, listener),
    after: (ms, listener) => timer(ms, 'after', false, listener),
    use: (job) => job({ mod, announce, reserveName }),
    log: (text, options) => claude.ui.log(`${definition.name}: ${text}`, { to: options?.to ?? 'debug' }),
    panes: area.panes,
    sidebar: area.sidebar,
    settings: area.settings,
    widgets: area.widgets,
    styles: area.styles,
    toast: toaster.toast,
    ask: (question, options) => claude.ui.ask(question, options),
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
      const moved = { session_id: await claude.session.id(), cwd: nextCwd, hook_event_name: 'CwdChanged', old_cwd: oldCwd, new_cwd: nextCwd }
      await router.dispatch('classic.CwdChanged', moved as unknown as Frozen<Args<'classic.CwdChanged'>>, async () => ({}))
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
  router.add('ui.press', (e, next) => area.asked(() => next(e)))
  let api: Readonly<Record<string, (input: never) => unknown>> = {}
  const conversations = definition.name === cmodPluginName ? serveConversations({ claude, router, store: runtime.store, project: () => modState.root, report: (id, message, error) => report({ id, message, error }), clear: (id) => toaster.toast.dismiss(id) }) : undefined
  let pages: Pages | undefined
  const reportPart = (id: string, message: string, error: unknown) => report({ id, message, error })
  const pressElsewhere = (to: string, input: PartPress) =>
    void claude.cmod.call({ to, method: partMethods.press, input }).catch((error: unknown) => {
      parts?.forget(to)
      claude.ui.invalidate('ui.render')
      reportPart(`press:${to}`, `${to} did not take the press`, error)
    })
  parts = drawnParts({ claude, report: reportPart, press: (to, input) => (pages === undefined ? pressElsewhere(to, input) : pages.press(to, input)) })
  const widgets = conversations === undefined ? undefined : serveWidgets({ claude, router, store: runtime.store, report: reportPart, turnClosedBy: (rowId) => conversations.turnClosedBy(rowId), parts, markdownIn: area.markdownIn })
  pages = widgets === undefined ? undefined : servePages({ claude, router, report: reportPart, widgets, parts, tellStylers: area.restyled })
  const tellColor = (to: string, told: SessionColor) => {
    if (told.session === '' || to === cmodPluginName) return
    claude.clock.after(0, () => void claude.cmod.call({ to, method: conversationMethods.sessionColor, input: told }).catch((error: unknown) => claude.ui.log(`cmod: ${to} did not hear the session's color: ${messageOf(error)}`, { to: 'debug' })))
  }
  conversations?.onColor((told) => {
    client.recolor(told)
    for (const { mod: to } of pages?.declared() ?? []) tellColor(to, told)
  })
  router.add('cmod.call', async (e, next) => {
    if (e.to !== definition.name) return next(e)
    const call = e as typeof e & { readonly caller?: string }
    if (e.method === conversationMethods.changed && call.caller === cmodPluginName) {
      const { session: changedSession, change, isInProject } = e.input as { readonly session: string; readonly change: SessionChange; readonly isInProject?: boolean }
      if (changedSession !== client.sessions.current.id && !flag('conversation')) return { value: null }
      client.changed(changedSession, change, isInProject !== false)
      return { value: null }
    }
    if (e.method === conversationMethods.sessionColor && call.caller === cmodPluginName) {
      client.recolor(e.input as SessionColor)
      return { value: null }
    }
    const ask = beforeAskOf(call)
    if (ask !== undefined) return { value: (await client.answerBefore(ask.session, ask.event, ask.change, ask.isInProject)) ?? null }
    if (e.method === partMethods.changed && call.caller !== undefined && pages !== undefined) {
      const update = e.input as PartsUpdate
      if (update.parts !== undefined && conversations !== undefined) tellColor(call.caller, conversations.color())
      return { value: { isHeld: pages.update(call.caller, update), stylers: pages.stylers() } }
    }
    if (call.caller !== undefined) {
      const turn = e.method === partMethods.draw ? (e.input as { readonly turn?: TurnData }).turn : undefined
      const answered = area.answer(e.method, turn === undefined ? e.input : { ...(e.input as PartDraw), turn: client.turn(turn) }, call.caller)
      if (answered !== undefined) return answered.catch((error: unknown) => ({ deny: `${definition.name}: ${messageOf(error)}` }))
    }
    const served = await conversations?.answer(call)
    return served ?? answerCall(definition.name, api, e)
  }, (e, error) => {
    if (e.to !== definition.name) return undefined
    const ask = beforeAskOf(e)
    return ask === undefined ? { deny: `${definition.name}: ${error.message}` } : { value: client.failedBefore(ask.session, ask.event, ask.change, ask.isInProject, error) ?? null }
  })
  const agents = toolCalls(claude, router)
  keepEngine(mod, {
    claude: checked,
    router,
    toolCalls: agents,
    report,
    hasPermissionCheck: () => runtime.permissionRoutes() !== undefined,
    answerInput: area.answerInput,
    spawnCmod: async (args, program) => {
      await checkRun(grants, 'process.spawn', program.argv)
      return spawnCmod(claude, args, session, program.env)
    },
    ...(widgets === undefined ? {} : { widgets }),
    ...(pages === undefined ? {} : { pages }),
  })
  const names = new Set<string>()
  const reserveName = (type: string, name: string, taken: string): Reservation => {
    const key = `${type}:${name}`
    if (names.has(key)) throw new Error(taken)
    names.add(key)
    return { remove: () => void names.delete(key) }
  }
  await failsAs('its state did not load', () => modState.load())
  await failsAs('its options did not load', () => modOptions.load(root))
  const missing = modOptions.missing
  if (missing.length > 0) throw new MissingOptions(missing, missing.map((key) => definition.options?.[key]?.title ?? key))
  await failsAs('the details of its session did not load', () => followCurrent(undefined))
  const returned = await failsAs('its setup function threw', () => definition.setup(mod))
  api = apiOf(definition.name, returned)
  await failsAs('its open panes did not load', () => area.restorePanes())
  area.started()
  return { mod, added, imports, raise: client.raise, area }
}

function apiOf(name: string, returned: unknown): Readonly<Record<string, (input: never) => unknown>> {
  if (returned === undefined || returned === null) return {}
  if (typeof returned !== 'object' || !Object.values(returned).every((method) => typeof method === 'function')) throw new Error(`${name}: setup returns its API, an object of methods other mods call, or nothing. It returned ${typeof returned === 'object' ? 'an object with values that are not methods' : typeof returned}.`)
  return returned as Readonly<Record<string, (input: never) => unknown>>
}

const longestTimerMs = 2_147_483_647

function checkedMs(name: string, subject: string, ms: number): number {
  if (!Number.isInteger(ms) || ms <= 0 || ms > longestTimerMs) throw new Error(`${name}: ${subject} is ${ms}. Give a whole number of milliseconds above 0 and at most ${longestTimerMs}.`)
  return ms
}

type BeforeAsk = { readonly session: string; readonly event: BeforeEvent; readonly change: SessionChange; readonly isInProject: boolean }

function beforeAskOf(call: Frozen<Args<'cmod.call'>> & { readonly caller?: string }): BeforeAsk | undefined {
  if (call.method !== conversationMethods.before || call.caller !== cmodPluginName) return undefined
  const { session, event, change, isInProject } = call.input as Omit<BeforeAsk, 'isInProject'> & { readonly isInProject?: boolean }
  return { session, event, change, isInProject: isInProject !== false }
}

async function failsAs<Value>(subject: string, step: () => Value | Promise<Value>): Promise<Value> {
  try {
    return await step()
  } catch (error) {
    throw new Error(`${subject}: ${messageOf(error)}`, { cause: error })
  }
}

function progressOf({ done, total, label }: Extract<RunnerEvent, { type: 'progress' }>): RenderElement {
  return Box({ gap: 2, children: [Progress({ value: total > 0 ? (done / total) * 100 : 0 }), Text({ dimColor: true, wrap: 'truncate-end', children: label })] })
}
