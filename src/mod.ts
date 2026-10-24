import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import { defineMod, fs, longestMs, messageOf, process, sessions, settings, type Mod } from '../node_modules/@cmodjs/core/mod.js'
import { buildFailuresPath, hasLinkedMods, linksPath, parseEvent, parseLinks, pluginsChangedPath, storeChangedPath } from '../node_modules/@cmodjs/core/records.js'
import { engineOf } from '../node_modules/@cmodjs/core/runtime/engine.js'
import { cmodError, runCmod } from '../node_modules/@cmodjs/core/runtime/programs.js'
import { ifMissing } from '../node_modules/@cmodjs/core/utils/paths.js'
import { formatExit } from '../node_modules/@cmodjs/core/utils/text.js'
import { sessionsWith } from '../node_modules/@cmodjs/core/runtime/state.js'
import { configRootOf, readConsent, settings as settingsView, settingsMemory, settingsSession, storeOf, type SettingsState } from './settings.js'
import { sidebar, sidebarSession, type SidebarState } from './sidebar.js'
import { addClaudeTools } from './tools.js'

export type CmodPluginState = {
  readonly global: { installedPlugins: readonly string[] | null; areHotkeysBound: boolean; pluginsCheckedAt: number | null }
  readonly session: { tip: string | null } & SidebarState['session'] & SettingsState['session']
  readonly memory: SettingsState['memory']
}

const cmodGlobal: CmodPluginState['global'] = { installedPlugins: null, areHotkeysBound: false, pluginsCheckedAt: null }

type Listed = { readonly name: string; readonly version: string; readonly state: string; readonly unsatisfied: readonly string[] }

const cmodSession: CmodPluginState['session'] = { tip: null, ...sidebarSession, ...settingsSession }

const newestMessages = 8

const reloadDelayMs = 500

const watchCheckMs = 10_000

const watchStaleMs = 15_000

const reloadEcho = '<command-name>/reload-plugins</command-name>'

const reloadNote = '<local-command-caveat>cmod reloaded the plugins.</local-command-caveat>'

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
    const hidingReload = `cmod:hiding-reload:${await claude.session.id()}`
    let seenChange = await pluginsState()
    let isReloading = false
    let isWaitingForInput = false
    const reloadIfChanged = async () => {
      const change = await pluginsState()
      if (change === seenChange || isReloading) return
      seenChange = change
      if ((await claude.session.surfaces()).length === 0) return
      isReloading = true
      mod.after(reloadDelayMs, reload)
    }
    const reload = async () => {
      try {
        seenChange = await pluginsState()
        await claude.store.set(hidingReload, true)
        await claude.command.run({ command: 'reload-plugins' })
        isWaitingForInput = false
        await widgets.recheck()
      } catch (error) {
        await claude.store.delete(hidingReload)
        const wasPromptRetry = isWaitingForInput
        if (wasPromptRetry) report({ id: 'reload', message: 'Could not reload the mods', error })
        isWaitingForInput = !wasPromptRetry
      } finally {
        isReloading = isWaitingForInput
      }
      if (!isReloading) await reloadIfChanged()
    }
    sessions.current.onPrompt(() => {
      if (isWaitingForInput) mod.after(reloadDelayMs, reload)
    })
    router.add('session.append', async (e, next) => {
      if (e.door !== 'command' || e.message.isMeta === true || (await claude.store.get(hidingReload)) !== true) return next(e)
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
    const keepCmodCurrent = async (): Promise<void> => {
      if (pluginsFile === undefined || isCheckingPlugins) return
      const at = await modifiedAt(pluginsFile)
      if (at === null || at === mod.state.global.pluginsCheckedAt) return
      isCheckingPlugins = true
      let checked: number | null = at
      try {
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
          checked = await modifiedAt(pluginsFile)
          off = needing(await listed())
        }
        if (reason === '') await claude.store.delete(updatedFor)
        if (off.length > 0) report({ id: 'needs-cmod', message: `${off.map((row) => row.name).join(', ')} ${off.length === 1 ? 'is' : 'are'} off`, description: off.map((row) => row.state).join('\n'), retry: updateAgain })
        else mod.toast.dismiss('needs-cmod')
        mod.state.global.pluginsCheckedAt = checked
      } finally {
        isCheckingPlugins = false
      }
      if ((await modifiedAt(pluginsFile)) !== checked) await keepCmodCurrent()
    }
    const checkPlugins = () => void keepCmodCurrent().catch((error: unknown) => report({ id: 'needs-cmod', message: 'Could not update cmod for the mods that need a newer one', error, retry: updateAgain }))
    const updateAgain = async () => {
      await claude.store.delete(updatedFor)
      mod.state.global.pluginsCheckedAt = null
      checkPlugins()
    }
    checkPlugins()

    const failuresFile = buildFailuresPath(store)
    let shownFailures: readonly string[] = []
    const showBuildFailures = async () => {
      const failures = JSON.parse(await fs.read(failuresFile).catch(ifMissing('{}'))) as Record<string, string>
      for (const name of shownFailures) if (!Object.hasOwn(failures, name)) mod.toast.dismiss(`build:${name}`)
      for (const [name, error] of Object.entries(failures)) report({ id: `build:${name}`, message: `${name} does not build`, description: error })
      shownFailures = Object.keys(failures)
    }
    const followBuildFailures = () => showBuildFailures().catch((error: unknown) => report({ id: 'build-failures', message: 'Could not read which linked mods fail to build', error }))
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
        .catch((error: unknown) => report({ id: 'watch', message: 'Stopped reloading the linked mods', error }))
        .finally(() => void (isWatchRunning = false))
    }
    const linksFile = linksPath(store)
    const knownMarketplaces = configRoot === undefined ? undefined : `${configRoot}/plugins/known_marketplaces.json`
    const readJsonFile = async (path: string): Promise<unknown> => {
      const text = await fs.read(path).catch(ifMissing(undefined))
      return text === undefined ? undefined : JSON.parse(text)
    }
    let isWatching = false
    const watchIfLinked = async () => {
      if (isWatching || knownMarketplaces === undefined || (await claude.session.surfaces()).length === 0) return
      if (!hasLinkedMods(await readJsonFile(knownMarketplaces), parseLinks(await readJsonFile(linksFile), linksFile))) return
      isWatching = true
      const watchAgain = () => void keepWatching().catch((error: unknown) => report({ id: 'watch', message: 'Could not check that a cmod watch runs', error }))
      watchAgain()
      claude.clock.every(watchCheckMs, watchAgain)
    }
    const startWatching = () => void watchIfLinked().catch((error: unknown) => report({ id: 'watch', message: 'Could not read which mods are linked', error }))
    startWatching()

    fs.onChange({ path: [storeChangedPath(store), ...(pluginsFile === undefined ? [] : [pluginsFile])] }, ({ path }) => {
      startWatching()
      if (path === pluginsFile) {
        checkPlugins()
        return reloadIfChanged()
      }
      void followBuildFailures()
      return Promise.all([widgets.reload(), reloadIfChanged()])
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
      else if (outcome.type === 'failed') report({ id: `teardown:${name}`, message: `Could not uninstall ${name}`, description: outcome.message })
      else if (exitCode !== 0) report({ id: `teardown:${name}`, message: `Could not uninstall ${name}`, description: `cmod teardown ${formatExit(exitCode, cmodError(stderr, 'teardown'))}` })
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
        void tearDown(name).catch((error: unknown) => report({ id: `teardown:${name}`, message: `Could not uninstall ${name}`, error }))
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
    }
  },
})
