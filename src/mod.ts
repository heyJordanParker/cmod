import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import { defineMod, fs, longestMs, messageOf, process, sessions, settings, type Mod, type Timer } from '../node_modules/@cmodjs/core/mod.js'
import { buildFailuresPath, hasLinkedMods, linksPath, parseEvent, parseLinks, permissionWords, pluginsChangedPath, readRecord, storeChangedPath } from '../node_modules/@cmodjs/core/records.js'
import { engineOf } from '../node_modules/@cmodjs/core/runtime/engine.js'
import { failedMethod } from '../node_modules/@cmodjs/core/runtime/toaster.js'
import { cmodError, runCmod } from '../node_modules/@cmodjs/core/runtime/programs.js'
import { ifMissing } from '../node_modules/@cmodjs/core/utils/paths.js'
import { formatExit } from '../node_modules/@cmodjs/core/utils/text.js'
import { sessionsWith } from '../node_modules/@cmodjs/core/runtime/state.js'
import { configRootOf, failureLog, readConsent, readJson, refreshPreferences, settings as settingsView, settingsMemory, settingsSession, storeOf, type SettingsState } from './settings.js'
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

const newestMessages = 8

const reloadDelayMs = 500

const changesQuietMs = 2000

const watchCheckMs = 10_000

const watchStaleMs = 15_000

const reloadEcho = '<command-name>/reload-plugins</command-name>'

const reloadNote = '<local-command-caveat>cmod reloaded the plugins.</local-command-caveat>'

const reloadToast = 'reload'

const shownUpdates = 3

const setupWaitMs = 10_000

const recordCheckMs = 500

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
    const { claude, router, report, widgets } = engineOf(mod)
    if (widgets === undefined) throw new Error('cmod draws no widgets, because the cmod plugin started without them.')

    addClaudeTools(mod)
    const shown = sidebar(mod, settingsView(mod))
    mod.hotkeys.sidebar.onPress(() => shown.toggle())
    mod.hotkeys.settings.onPress(() => shown.toggleSettings())

    mod.use(
      slashCommand({
        name: 'mods',
        description: 'Open Settings, where you turn your mods off or remove them, and change their options, permissions, hotkeys, pages, and widgets',
        argumentHint: '[mod]',
        immediate: true,
        reply: ({ positionals }) => shown.openSettings(positionals[0]),
      }),
    )

    const bindHotkeys = async () => {
      let isBound = true
      for (const [name, hotkey] of Object.entries(cmodPlugin.hotkeys ?? {})) {
        if (mod.hotkeys[name as keyof typeof mod.hotkeys].combo !== undefined) continue
        const { exitCode, stderr } = await process.run(['cmod', 'hotkey', mod.name, name, hotkey.default])
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
    const sessionKey = async (name: string) => `cmod:${name}:${await claude.session.id()}`
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
    const grantedWords = async (name: string, version: string): Promise<string[]> => {
      for (let waitedMs = 0; ; waitedMs += recordCheckMs) {
        const record = await readRecord((path) => fs.read(path).catch(ifMissing(undefined)), store, name)
        if (record?.version === version) return record.grantedOnUpdate.map(permissionWords)
        if (record === undefined || waitedMs >= setupWaitMs) return []
        await new Promise<void>((resolve) => mod.after(recordCheckMs, resolve))
      }
    }
    let loaded: Versions = {}
    const takeVersionsBeforeReload = async () => {
      const key = await sessionKey('versions-before-reload')
      const before = (await claude.store.get(key)) as Versions | undefined
      await claude.store.delete(key)
      return before
    }
    const showUpdates = async (isAfterOwnReload: boolean) => {
      const before = await takeVersionsBeforeReload()
      loaded = await loadedVersions()
      if (!isAfterOwnReload || before === undefined) return
      const updates = await Promise.all(
        Object.entries(loaded)
          .filter(([id, version]) => before[id] !== undefined && before[id] !== version)
          .map(async ([id, version]) => {
            const name = id.replace(/@[^@]*$/, '')
            return { line: `${name} updated to ${version}`, words: await grantedWords(name, version) }
          }),
      )
      const rest = updates.filter(({ words }) => words.length === 0)
      for (const { line, words } of updates) if (words.length > 0) claude.ui.toast([line, ...words].join(' · '))
      if (rest.length > shownUpdates) claude.ui.toast(`${rest.length} plugins updated`)
      else for (const { line } of rest) claude.ui.toast(line)
    }
    const announceUpdates = (isAfterOwnReload: boolean) => void showUpdates(isAfterOwnReload).catch((error: unknown) => report({ id: 'updates', message: 'Could not show which plugins updated', error }))
    announceUpdates((await claude.store.get(await sessionKey('hiding-reload'))) === true)

    let seenChange = await pluginsState()
    let isReloadDue = false
    let quietWait: Timer | undefined
    const reloadAfter = (ms: number) => {
      quietWait?.stop()
      quietWait = mod.after(ms, reloadWhenIdle)
    }
    let reloading = Promise.resolve()
    const reloadWhenIdle = () => {
      reloading = reloading
        .then(async () => {
          if (!isReloadDue || (await sessions.current.turn()) !== undefined) return
          isReloadDue = false
          await reload()
        })
        .catch((error: unknown) => report({ id: reloadToast, message: 'Could not tell whether a turn runs, so the plugins did not reload', error, retry: reload, isCritical: true }))
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
        await claude.store.set(await sessionKey('versions-before-reload'), loaded)
        await claude.store.set(await sessionKey('hiding-reload'), true)
        await claude.command.run({ command: 'reload-plugins' })
        await widgets.recheck()
        announceUpdates(true)
      } catch (error) {
        await claude.store.delete(await sessionKey('hiding-reload'))
        await takeVersionsBeforeReload()
        report({ id: reloadToast, message: 'Could not reload the plugins', error, retry: reload, isCritical: true })
      }
    }
    sessions.current.onTurnEnd(() => {
      if (isReloadDue && quietWait?.isRunning !== true) reloadAfter(reloadDelayMs)
    })
    router.add('session.append', async (e, next) => {
      if (e.door !== 'command' || e.message.isMeta === true) return next(e)
      const hidingReload = await sessionKey('hiding-reload')
      if ((await claude.store.get(hidingReload)) !== true) return next(e)
      const isOwnReload = e.origin.kind === 'plugin' && 'name' in e.origin && e.origin.name === mod.name && JSON.stringify(e.message.content).includes(reloadEcho)
      if (!isOwnReload) {
        await claude.store.delete(hidingReload)
        if (e.message.type !== 'system') return next(e)
      }
      return next({ ...e, message: { ...e.message, content: [{ type: 'text', text: reloadNote }] } })
    })

    const isCmod = (id: string) => id.replace(/@[^@]*$/, '') === mod.name
    const updatedFor = 'cmod:cmod-updated-for'
    let isCheckingPlugins = false
    const modifiedAt = async (path: string) => (await claude.fs.stat(path).catch(ifMissing(undefined)))?.mtimeMs ?? null
    const pluginsChangedAt = async (file: string) => [await modifiedAt(file), await modifiedAt(changed)] as const
    const keepCmodCurrent = async ({ isForced }: { readonly isForced: boolean }): Promise<void> => {
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
        const copies = new Set(before.filter((row) => isCmod(row.name)).map((row) => row.version))
        let off = needing(before)
        const reason = off.length > 0 || copies.size > 1 ? JSON.stringify([off.map((row) => row.name).toSorted(), [...copies].toSorted()]) : ''
        if (reason !== '' && reason !== (await claude.store.get(updatedFor))) {
          await claude.store.set(updatedFor, reason)
          await runCmod(claude, ['update', mod.name], session)
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
      if (JSON.stringify(await pluginsChangedAt(pluginsFile)) !== JSON.stringify(checked)) await keepCmodCurrent({ isForced: false })
    }
    const checkPlugins = (asked: { readonly isForced: boolean }) => void keepCmodCurrent(asked).catch((error: unknown) => report({ id: 'needs-cmod', message: 'Could not update cmod for the mods that need a newer one', error, retry: updateAgain, isCritical: true }))
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
      if (isWatchRunning) return
      const now = await claude.clock.now()
      const holders = await claude.fs.list(watchLock).catch(ifMissing([]))
      const touched = await Promise.all(holders.map(async ({ name }) => (await claude.fs.stat(`${watchLock}/${name}`).catch(ifMissing(undefined)))?.mtimeMs ?? 0))
      if (touched.some((at) => now - at < watchStaleMs)) return
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

    void readConsent(mod)
      .then(async (consent) => (Object.entries(consent).some(([name, granted]) => name !== mod.name && granted.includes('conversation')) ? runCmod(claude, ['history', 'index'], await claude.session.id()) : undefined))
      .catch((error: unknown) => mod.log(messageOf(error)))

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
      const current = [...new Set(Object.keys(enabledPlugins ?? {}).map((key) => key.replace(/@[^@]*$/, '')))]
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
    }
  },
})
