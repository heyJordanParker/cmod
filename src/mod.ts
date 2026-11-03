import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import { defineMod, device, fs, longestMs, messageOf, process, sessions, settings, type Mod, type Timer } from '../node_modules/@cmodjs/core/mod.js'
import { buildFailuresPath, hasLinkedMods, linksPath, parseEvent, parseLinks, pluginsChangedPath, storeChangedPath } from '../node_modules/@cmodjs/core/records.js'
import { heldInput } from '../node_modules/@cmodjs/core/runtime/claude.js'
import { loadedMethod } from '../node_modules/@cmodjs/core/runtime/dependencies.js'
import { engineOf } from '../node_modules/@cmodjs/core/runtime/engine.js'
import type { Pages } from '../node_modules/@cmodjs/core/runtime/pages.js'
import { MissingMachineId } from '../node_modules/@cmodjs/core/runtime/device.js'
import { deviceNote } from '../node_modules/@cmodjs/core/session/context/turn/device.js'
import { failedMethod } from '../node_modules/@cmodjs/core/runtime/toaster.js'
import { cmodError, isHeld, runCmod } from '../node_modules/@cmodjs/core/runtime/programs.js'
import { ifMissing } from '../node_modules/@cmodjs/core/utils/paths.js'
import { formatExit } from '../node_modules/@cmodjs/core/utils/text.js'
import { sessionKeyOf, sessionsWith } from '../node_modules/@cmodjs/core/runtime/state.js'
import { configRootOf, failureLog, readJson, refreshPreferences, setUpMods, settings as settingsView, settingsMemory, settingsSession, storeOf, type SettingsState } from './settings.js'
import { sidebar, sidebarSession, type SidebarState } from './sidebar.js'
import { addClaudeTools } from './tools.js'

export type CmodPluginState = {
  readonly global: { installedPlugins: readonly string[] | null; areHotkeysBound: boolean; pluginsCheckedAt: readonly [number | null, number | null] | null }
  readonly session: { tip: string | null } & SidebarState['session'] & SettingsState['session']
  readonly memory: SettingsState['memory']
}

const cmodGlobal: CmodPluginState['global'] = { installedPlugins: null, areHotkeysBound: false, pluginsCheckedAt: null }

type Listed = { readonly name: string; readonly version: string; readonly state: string; readonly unsatisfied: readonly string[] }

const cmodSession: CmodPluginState['session'] = { tip: null, ...sidebarSession, ...settingsSession }

type InstalledCopy = { readonly version: string; readonly installPath: string; readonly projectPath?: string }

type Versions = Readonly<Record<string, string>>

const nameOf = (id: string) => id.replace(/@[^@]*$/, '')

let loaded: Versions = {}

const unloaded = new Set<string>()

let toldParts: Pick<Pages, 'declared'> | undefined

let loading: Promise<unknown> = Promise.resolve()

export const isLoaded = async (name: string): Promise<boolean> => {
  await loading
  return Object.keys(loaded).some((id) => nameOf(id) === name) || (!unloaded.has(name) && toldParts?.declared().some((told) => told.mod === name) === true)
}

const newestMessages = 8

const reloadDelayMs = 500

const changesQuietMs = 2000

const watchCheckMs = 10_000

const watchStaleMs = 15_000

const reloadEcho = '<command-name>/reload-plugins</command-name>'

const reloadNote = '<local-command-caveat>cmod reloaded the plugins.</local-command-caveat>'

const reloadToast = 'reload'

const oldReloadKey = /^cmod:(hiding-reload|versions-before-reload):/

const shownUpdates = 3

type SyncedRules = {
  readonly linked: readonly { readonly mod: string; readonly rules: readonly { readonly name: string; readonly isGlobal: boolean; readonly text: string }[] }[]
  readonly placed: readonly string[]
  readonly removed: readonly string[]
  readonly watched: readonly string[]
}

async function tipOf(mod: Mod<CmodPluginState>): Promise<string | null> {
  const messages = await engineOf(mod).claude.session.messages()
  if (messages.length === 0) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([messages.length, messages.slice(-newestMessages)])))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const cmodPlugin = defineMod({
  name: 'cmod',
  state: { global: cmodGlobal, session: cmodSession, memory: settingsMemory },
  hotkeys: {
    sidebar: { title: 'Show or hide the Sidebar', default: 'meta+0' },
    settings: { title: 'Show or hide Settings', default: 'meta+m' },
  },

  async setup(mod) {
    const triedRemovals = new Set<string>()
    const { claude, router, report, widgets, pages } = engineOf(mod)
    if (widgets === undefined) throw new Error('cmod draws no widgets, because the cmod plugin started without them.')
    toldParts = pages
    loaded = {}
    unloaded.clear()

    addClaudeTools(mod)
    const shown = sidebar(mod, settingsView(mod))
    mod.hotkeys.sidebar.onPress(() => shown.toggle())
    mod.hotkeys.settings.onPress(() => shown.toggleSettings())

    mod.use(
      slashCommand({
        name: 'mods',
        description: 'Open Settings, where you turn your mods off or remove them, and change their options, hotkeys, pages, and widgets',
        argumentHint: '[mod]',
        immediate: true,
        reply: ({ positionals }) => shown.openSettings(positionals[0]),
      }),
    )

    const bindHotkeys = async () => {
      let isBound = true
      for (const [name, hotkey] of Object.entries(cmodPlugin.hotkeys ?? {})) {
        if (mod.hotkeys[name as keyof typeof mod.hotkeys].combo !== undefined) continue
        const { exitCode, stderr } = await process.run(['cmod', 'hotkey', claude.plugin.root, name, hotkey.default])
        if (exitCode === 0) continue
        isBound = false
        report({ id: `hotkey:${name}`, message: `Could not bind ${hotkey.default} to ${hotkey.title}`, description: `cmod hotkey ${formatExit(exitCode, cmodError(stderr, 'hotkey'))}` })
      }
      mod.state.global.areHotkeysBound = isBound
    }
    if (!mod.state.global.areHotkeysBound) void bindHotkeys().catch((error: unknown) => report({ id: 'hotkeys', message: 'Could not bind the hotkeys', error }))

    const store = await storeOf(mod)
    const changed = pluginsChangedPath(store)
    const configRoot = await configRootOf(mod)
    const pluginsFile = configRoot === undefined ? undefined : `${configRoot}/plugins/installed_plugins.json`
    const pluginsState = async () =>
      JSON.stringify([
        await fs.read(changed).catch(ifMissing('')),
        pluginsFile === undefined ? '' : await fs.read(pluginsFile).catch(ifMissing('')),
        (await settings.user.read())['enabledPlugins'] ?? null,
      ])
    const sessionKey = async (name: 'hidingReload' | 'versionsBeforeReload') => sessionKeyOf(mod.name, name, await claude.session.id())
    const forgetOldReloadKeys = async () => {
      for (const key of await claude.store.keys()) if (oldReloadKey.test(key)) await claude.store.delete(key)
    }
    void forgetOldReloadKeys().catch((error: unknown) => claude.ui.warn('reload:old-keys', `cmod: kept the reload keys of ended sessions: ${messageOf(error)}`))
    const loadedVersions = async (): Promise<Versions> => {
      if (pluginsFile === undefined) return {}
      const installed = JSON.parse(await fs.read(pluginsFile).catch(ifMissing('{}'))) as { readonly plugins?: Readonly<Record<string, readonly InstalledCopy[]>> }
      const enabled = (await claude.settings.read())['enabledPlugins'] as Readonly<Record<string, unknown>> | undefined
      const root = await claude.session.root()
      const versions = await Promise.all(
        Object.entries(installed.plugins ?? {}).map(async ([id, copies]) => {
          const loaded = copies.find((copy) => copy.projectPath === root) ?? copies.find((copy) => copy.projectPath === undefined)
          if (enabled?.[id] !== true || loaded === undefined) return []
          const manifest = JSON.parse(await fs.read(`${loaded.installPath}/.claude-plugin/plugin.json`).catch(ifMissing('{}'))) as { readonly version?: unknown }
          return [[id, typeof manifest.version === 'string' ? manifest.version : loaded.version] as const]
        }),
      )
      return Object.fromEntries(versions.flat())
    }
    const takeVersionsBeforeReload = async () => {
      const key = await sessionKey('versionsBeforeReload')
      const before = (await claude.store.get(key)) as Versions | undefined
      await claude.store.delete(key)
      return before
    }
    const showUpdates = async (isAfterOwnReload: boolean) => {
      const before = await takeVersionsBeforeReload()
      const previous = loaded
      loaded = await loadedVersions()
      for (const id of Object.keys(previous)) if (!Object.hasOwn(loaded, id)) unloaded.add(nameOf(id))
      for (const id of Object.keys(loaded)) unloaded.delete(nameOf(id))
      if (!isAfterOwnReload || before === undefined) return
      const updates = Object.entries(loaded)
        .filter(([id, version]) => before[id] !== undefined && before[id] !== version)
        .map(([id, version]) => `${nameOf(id)} updated to ${version}`)
      if (updates.length > shownUpdates) claude.ui.toast(`${updates.length} plugins updated`)
      else for (const update of updates) claude.ui.toast(update)
    }
    const announceUpdates = (isAfterOwnReload: boolean) => showUpdates(isAfterOwnReload).catch((error: unknown) => report({ id: 'updates', message: 'Could not show which plugins updated', error }))
    loading = announceUpdates((await claude.store.get(await sessionKey('hidingReload'))) === true)

    let seenChange = await pluginsState()
    let isReloadDue = false
    let quietWait: Timer | undefined
    const reloadAfter = (ms: number) => {
      quietWait?.stop()
      quietWait = mod.after(ms, reloadWhenIdle)
    }
    let reloading = Promise.resolve()
    let isWorking = false
    const reloadWhenIdle = () => {
      reloading = reloading
        .then(async () => {
          if (!isReloadDue || isWorking) return
          isReloadDue = false
          await reload()
        })
        .catch((error: unknown) => report({ id: reloadToast, message: 'Could not reload the plugins', error, retry: reload, isCritical: true }))
    }
    const reloadIfChanged = async () => {
      const change = await pluginsState()
      if (change === seenChange) return
      seenChange = change
      if ((await claude.session.surfaces()).length === 0) return
      isReloadDue = true
      reloadAfter(changesQuietMs)
    }
    const reload = async () => {
      mod.toast.dismiss(reloadToast)
      try {
        seenChange = await pluginsState()
        await claude.store.set(await sessionKey('versionsBeforeReload'), loaded)
        await claude.store.set(await sessionKey('hidingReload'), true)
        await claude.command.run({ command: 'reload-plugins' })
        await widgets.recheck()
        void announceUpdates(true)
      } catch (error) {
        await claude.store.delete(await sessionKey('hidingReload'))
        await takeVersionsBeforeReload()
        if (messageOf(error).includes(heldInput)) isReloadDue = true
        else report({ id: reloadToast, message: 'Could not reload the plugins', error, retry: reload, isCritical: true })
      }
    }
    const stopWorking = () => {
      isWorking = false
      if (isReloadDue && quietWait?.isRunning !== true) reloadAfter(reloadDelayMs)
    }
    sessions.current.onTurnEnd(stopWorking)
    router.add('turn.start', async (e, next) => {
      if ((e as typeof e & { readonly agentId?: string }).agentId === undefined) isWorking = true
      return next(e)
    })
    router.add('turn.complete', async (e, next) => {
      const completed = await next(e)
      if (e.agentId === undefined) stopWorking()
      return completed
    })
    router.add('session.append', async (e, next) => {
      if (e.door !== 'command' || e.message.isMeta === true) return next(e)
      const hidingReload = await sessionKey('hidingReload')
      if ((await claude.store.get(hidingReload)) !== true) return next(e)
      const isOwnReload = e.origin.kind === 'plugin' && 'name' in e.origin && e.origin.name === mod.name && JSON.stringify(e.message.content).includes(reloadEcho)
      if (!isOwnReload) {
        await claude.store.delete(hidingReload).catch((error: unknown) => claude.ui.warn('reload:hide', `cmod: kept hiding /reload-plugins rows, because Claude Code's store refused the change: ${messageOf(error)}`))
        if (e.message.type !== 'system') return next(e)
      }
      return next({ ...e, message: { ...e.message, content: [{ type: 'text', text: reloadNote }] } })
    })

    const isCmod = (id: string) => nameOf(id) === mod.name
    const updatedFor = 'cmod:cmod-updated-for'
    let isCheckingPlugins = false
    const modifiedAt = async (path: string) => (await claude.fs.stat(path).catch(ifMissing(undefined)))?.mtimeMs ?? null
    const pluginsChangedAt = async (file: string) => [await modifiedAt(file), await modifiedAt(changed)] as const
    const keepPluginsCurrent = async ({ isForced }: { readonly isForced: boolean }): Promise<void> => {
      if (pluginsFile === undefined || isCheckingPlugins) return
      isCheckingPlugins = true
      let checked: CmodPluginState['global']['pluginsCheckedAt']
      try {
        checked = await pluginsChangedAt(pluginsFile)
        if (checked[0] === null || (!isForced && JSON.stringify(checked) === JSON.stringify(mod.state.global.pluginsCheckedAt))) return
        const session = await claude.session.id()
        const listed = async () => JSON.parse(await runCmod(claude, ['list', '--json'], session)) as readonly Listed[]
        const needing = (rows: readonly Listed[]) => rows.filter((row) => row.unsatisfied.some(isCmod))
        const before = await listed()
        const versionsOf = (name: string) => [...new Set(before.filter((row) => nameOf(row.name) === name).map((row) => row.version))].toSorted()
        const hasDifferingCopies = (name: string) => versionsOf(name).length > 1
        let off = needing(before)
        const others = [...new Set(before.map((row) => nameOf(row.name)))].filter((name) => name !== mod.name && hasDifferingCopies(name)).toSorted()
        const outdated = [...(off.length > 0 || hasDifferingCopies(mod.name) ? [mod.name] : []), ...others]
        const reason = outdated.length > 0 ? JSON.stringify([off.map((row) => row.name).toSorted(), outdated.map((name) => [name, versionsOf(name)])]) : ''
        if (reason !== '' && reason !== (await claude.store.get(updatedFor))) {
          await claude.store.set(updatedFor, reason)
          for (const name of outdated) await runCmod(claude, ['update', name], session)
          checked = await pluginsChangedAt(pluginsFile)
          off = needing(await listed())
        }
        if (reason === '') await claude.store.delete(updatedFor)
        if (off.length > 0) report({ id: 'needs-cmod', message: `${off.map((row) => row.name).join(', ')} ${off.length === 1 ? 'is' : 'are'} off`, description: off.map((row) => row.state).join('\n'), retry: updateAgain, isCritical: true })
        else mod.toast.dismiss('needs-cmod')
        mod.state.global.pluginsCheckedAt = checked
      } finally {
        isCheckingPlugins = false
      }
      if (JSON.stringify(await pluginsChangedAt(pluginsFile)) !== JSON.stringify(checked)) await keepPluginsCurrent({ isForced: false })
    }
    const checkPlugins = (asked: { readonly isForced: boolean }) => void keepPluginsCurrent(asked).catch((error: unknown) => report({ id: 'needs-cmod', message: 'Could not update cmod for the mods that need a newer one', error, retry: updateAgain, isCritical: true }))
    const updateAgain = async () => {
      await claude.store.delete(updatedFor)
      checkPlugins({ isForced: true })
    }
    checkPlugins({ isForced: (await claude.session.surfaces()).length > 0 })

    const failuresFile = buildFailuresPath(store)
    let shownFailures: readonly string[] = []
    const showBuildFailures = async () => {
      const failures = JSON.parse(await fs.read(failuresFile).catch(ifMissing('{}'))) as Record<string, string>
      for (const name of shownFailures) if (!Object.hasOwn(failures, name)) mod.toast.dismiss(`build:${name}`)
      for (const [name, error] of Object.entries(failures)) report({ id: `build:${name}`, message: `${name} does not build`, description: error, isCritical: true })
      shownFailures = Object.keys(failures)
    }
    const followBuildFailures = () => showBuildFailures().catch((error: unknown) => report({ id: 'build-failures', message: 'Could not read which linked mods fail to build', error, isCritical: true }))
    void followBuildFailures()
    const watchLock = `${store}/watch.lock`
    let isWatchRunning = false
    const keepWatching = async () => {
      if (isWatchRunning || (await isHeld(claude, watchLock, watchStaleMs))) return
      isWatchRunning = true
      void runCmod(claude, ['watch'], await claude.session.id())
        .catch((error: unknown) => report({ id: 'watch', message: 'Stopped reloading the linked mods', error, isCritical: true }))
        .finally(() => void (isWatchRunning = false))
    }
    const linksFile = linksPath(store)
    const knownMarketplaces = configRoot === undefined ? undefined : `${configRoot}/plugins/known_marketplaces.json`
    let isWatching = false
    const watchIfLinked = async () => {
      if (isWatching || knownMarketplaces === undefined || (await claude.session.surfaces()).length === 0) return
      if (!hasLinkedMods(await readJson(knownMarketplaces), parseLinks(await readJson(linksFile), linksFile))) return
      isWatching = true
      const watchAgain = () => void keepWatching().catch((error: unknown) => report({ id: 'watch', message: 'Could not check that a cmod watch runs', error }))
      watchAgain()
      claude.clock.every(watchCheckMs, watchAgain)
    }
    const startWatching = () => void watchIfLinked().catch((error: unknown) => report({ id: 'watch', message: 'Could not read which mods are linked', error }))
    startWatching()

    fs.onChange({ path: [storeChangedPath(store), ...(pluginsFile === undefined ? [] : [pluginsFile])] }, ({ path }) => {
      startWatching()
      checkPlugins({ isForced: false })
      if (path === pluginsFile) return reloadIfChanged()
      void followBuildFailures()
      return Promise.all([widgets.reload(), reloadIfChanged(), refreshPreferences(mod)])
    })
    settings.beforeFileChange({ source: 'user' }, () => void mod.after(reloadDelayMs, reloadIfChanged))
    sessions.current.onPrompt(() => reloadIfChanged())

    void setUpMods(mod)
      .then(async (mods) => (mods.length > 0 ? runCmod(claude, ['history', 'index'], await claude.session.id()) : undefined))
      .catch((error: unknown) => claude.ui.warn('history:index', `cmod: the conversation index did not catch up: ${messageOf(error)}`))

    const tearDown = async (name: string) => {
      const { exitCode, stdout, stderr } = await process.run(['cmod', 'teardown', name, '--events'], { timeoutMs: longestMs })
      const outcome = parseEvent(stdout.trim().split('\n').at(-1) ?? '')
      const isAnswered = outcome.type === 'done' || outcome.type === 'missing' || outcome.type === 'failed'
      if (isAnswered) mod.state.global.installedPlugins = (mod.state.global.installedPlugins ?? []).filter((installed) => installed !== name)
      if (outcome.type === 'done') mod.toast.success(`${name} is uninstalled`)
      else if (outcome.type === 'failed') report({ id: `teardown:${name}`, message: `Could not uninstall ${name}`, description: outcome.message, isCritical: true })
      else if (exitCode !== 0) report({ id: `teardown:${name}`, message: `Could not uninstall ${name}`, description: `cmod teardown ${formatExit(exitCode, cmodError(stderr, 'teardown'))}`, isCritical: true })
    }

    const watchRemovals = async () => {
      const enabledPlugins = (await settings.user.read())['enabledPlugins'] as Record<string, unknown> | undefined
      const current = [...new Set(Object.keys(enabledPlugins ?? {}).map(nameOf))]
      const previous = mod.state.global.installedPlugins
      const removed = (previous ?? []).filter((name) => !current.includes(name))
      const installed = [...current, ...removed]
      if (previous === null || previous.length !== installed.length || !installed.every((name) => previous.includes(name))) mod.state.global.installedPlugins = installed
      for (const name of removed) {
        if (triedRemovals.has(name)) continue
        triedRemovals.add(name)
        void tearDown(name).catch((error: unknown) => report({ id: `teardown:${name}`, message: `Could not uninstall ${name}`, error, isCritical: true }))
      }
    }

    sessions.current.onSessionStart(watchRemovals)
    sessions.current.onPrompt(watchRemovals)

    let applied: ReadonlyMap<string, ReadonlyMap<string, string>> | undefined
    let following = Promise.resolve()
    let synced: { readonly project: string; readonly watched: readonly string[]; readonly stamp: string } | undefined
    const changedAt = async (paths: readonly string[]) => Promise.all(paths.map(async (path) => (await claude.fs.stat(path).catch(ifMissing(undefined)))?.mtimeMs ?? 0))
    const followRules = async (): Promise<string[]> => {
      const project = await claude.session.root()
      if (synced?.project === project && (await changedAt(synced.watched)).join(',') === synced.stamp) return []
      const startedAt = await claude.clock.now()
      const result = JSON.parse(await runCmod(claude, ['rules', '--project', project, '--json'], await claude.session.id())) as SyncedRules
      const times = await changedAt(result.watched)
      synced = { project, watched: result.watched, stamp: times.some((at) => at >= startedAt - 1000) ? '' : times.join(',') }
      return rulesNotes(result)
    }
    const rulesNotes = (result: SyncedRules): string[] => {
      const now = new Map(result.linked.map(({ mod: name, rules }) => [name, new Map(rules.filter((rule) => rule.isGlobal).map((rule) => [rule.name, rule.text]))]))
      const notes = [...now].flatMap(([name, globals]) => {
        const before = applied === undefined ? (result.placed.includes(name) ? undefined : globals) : applied.get(name)
        const changed = [...globals].filter(([rule, text]) => before?.get(rule) !== text).map(([, text]) => text)
        const withdrawn = [...(before ?? [])].filter(([rule]) => !globals.has(rule)).map(([, text]) => text)
        return [
          ...(changed.length === 0 ? [] : [[before === undefined ? `The ${name} mod adds these rules from now on:` : `The ${name} mod changed these rules, which apply from now on:`, ...changed].join('\n\n')]),
          ...(withdrawn.length === 0 ? [] : [[`These rules of the ${name} mod no longer apply:`, ...withdrawn].join('\n\n')]),
        ]
      })
      const gone = applied === undefined ? result.removed : [...applied.keys()].filter((name) => !now.has(name))
      applied = now
      return [...notes, ...gone.map((name) => `The ${name} mod's rules no longer apply.`)]
    }
    const keepRules = async (): Promise<readonly string[]> => {
      let notes: readonly string[] = []
      following = following.then(async () => void (notes = await followRules())).catch((error: unknown) => report({ id: 'rules', message: "Could not link the mods' rules", error }))
      await following
      return notes
    }
    const rulesNote = async () => {
      const notes = await keepRules()
      return notes.length === 0 ? undefined : { note: notes.join('\n\n') }
    }
    sessions.current.beforeSessionStart(async () => {
      try {
        return { note: deviceNote(await device.read(), new Date(await claude.clock.now()).toISOString()) }
      } catch (error) {
        if (!(error instanceof MissingMachineId)) throw error
        mod.log(`this start's note names no device, because ${error.message}`)
        return undefined
      }
    })
    sessions.current.beforeSessionStart(rulesNote)
    sessions.current.beforePrompt(rulesNote, { timeoutMs: 60_000 })

    sessions.current.onTurnEnd(async () => {
      mod.state.session.tip = await tipOf(mod)
    })

    return {
      async forkParent() {
        const tip = await tipOf(mod)
        if (tip === null) return null
        const current = await claude.session.id()
        return (await sessionsWith(claude, mod.name, 'tip', tip)).find((session) => session !== current) ?? null
      },
      async updateSettings(input: { readonly mod: string; readonly source: string; readonly project: string; readonly values: Readonly<Record<string, unknown>> }) {
        await runCmod(claude, ['settings', input.mod, input.source, JSON.stringify(input.values), '--project', input.project], await claude.session.id())
        return null
      },
      [failedMethod]: failureLog(mod),
      async [loadedMethod](input: { readonly name?: unknown }) {
        if (typeof input.name !== 'string') throw new Error(`${loadedMethod} takes the name of a mod, as { name: 'anyhost' }.`)
        return isLoaded(input.name)
      },
    }
  },
})
