import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import { defineMod, longestMs, messageOf, process, sessions, settings, type Mod } from '../node_modules/@cmodjs/core/mod.js'
import { parseEvent } from '../node_modules/@cmodjs/core/records.js'
import { engineOf } from '../node_modules/@cmodjs/core/runtime/engine.js'
import { cmodError, runCmod } from '../node_modules/@cmodjs/core/runtime/programs.js'
import { formatExit } from '../node_modules/@cmodjs/core/utils/text.js'
import { sessionsWith } from '../node_modules/@cmodjs/core/runtime/state.js'
import { modsMemory, modsPanel, readConsent, type ModsState } from './mods.js'

export type CmodPluginState = { readonly global: { installedPlugins: readonly string[] | null }; readonly session: { tip: string | null } } & ModsState

const cmodGlobal: CmodPluginState['global'] = { installedPlugins: null }

const cmodSession: CmodPluginState['session'] = { tip: null }

const newestMessages = 8

type SyncedRules = {
  readonly linked: readonly { readonly mod: string; readonly rules: readonly { readonly name: string; readonly isGlobal: boolean; readonly text: string }[] }[]
  readonly placed: readonly string[]
  readonly removed: readonly string[]
}

async function tipOf(mod: Mod<CmodPluginState>): Promise<string | null> {
  const messages = await engineOf(mod).claude.session.messages()
  if (messages.length === 0) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([messages.length, messages.slice(-newestMessages)])))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const panels = new WeakMap<object, ReturnType<typeof modsPanel<CmodPluginState>>>()


export const cmodPlugin = defineMod({
  name: 'cmod',
  state: { global: cmodGlobal, session: cmodSession, memory: modsMemory },

  api: {
    async forkParent(_input: null, mod) {
      const tip = await tipOf(mod)
      if (tip === null) return null
      const { claude } = engineOf(mod)
      const current = await claude.session.id()
      return (await sessionsWith(claude, mod.name, 'tip', tip)).find((session) => session !== current) ?? null
    },
    async openSettings(input: { readonly mod: string; readonly page?: string }, mod) {
      const panel = panels.get(mod)
      if (panel === undefined) throw new Error('cmod has not started its /mods panel yet.')
      await panel.open(input.mod, input.page)
      return null
    },
    async updateSettings(input: { readonly mod: string; readonly source: string; readonly project: string; readonly values: Readonly<Record<string, unknown>> }, mod) {
      const { claude } = engineOf(mod)
      await runCmod(claude, ['settings', input.mod, input.source, JSON.stringify(input.values), '--project', input.project], await claude.session.id())
      return null
    },
  },

  setup(mod) {
    const triedRemovals = new Set<string>()
    const mods = modsPanel(mod)
    panels.set(mod, mods)

    mod.use(
      slashCommand({
        name: 'mods',
        description: 'See your mods, turn them off or remove them, and change their options, permissions, keys, and pages',
        argumentHint: '[mod] [page]',
        immediate: true,
        async reply({ positionals }) {
          const [name, page] = positionals
          await mods.open(name, page)
        },
      }),
    )

    const { claude, report } = engineOf(mod)

    void readConsent(mod)
      .then(async (consent) => (Object.entries(consent).some(([name, granted]) => name !== mod.name && granted.includes('conversation')) ? runCmod(claude, ['history', 'index'], await claude.session.id()) : undefined))
      .catch((error: unknown) => mod.log(messageOf(error)))

    const tearDown = async (name: string) => {
      const { exitCode, stdout, stderr } = await process.run(['cmod', 'teardown', name, '--events'], { timeoutMs: longestMs })
      const outcome = parseEvent(stdout.trim().split('\n').at(-1) ?? '')
      const isAnswered = outcome.type === 'done' || outcome.type === 'missing' || outcome.type === 'failed'
      if (isAnswered) mod.state.global.installedPlugins = (mod.state.global.installedPlugins ?? []).filter((installed) => installed !== name)
      if (outcome.type === 'done') mod.ui.toast.success(`${name} is uninstalled`, { description: 'A session that still runs it stops after /reload-plugins.' })
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
    const followRules = async () => {
      const synced = JSON.parse(await runCmod(claude, ['rules', '--project', await claude.session.root(), '--json'], await claude.session.id())) as SyncedRules
      const now = new Map(synced.linked.map(({ mod: name, rules }) => [name, new Map(rules.filter((rule) => rule.isGlobal).map((rule) => [rule.name, rule.text]))]))
      const notes = [...now].flatMap(([name, globals]) => {
        const before = applied === undefined ? (synced.placed.includes(name) ? undefined : globals) : applied.get(name)
        const changed = [...globals].filter(([rule, text]) => before?.get(rule) !== text).map(([, text]) => text)
        const withdrawn = [...(before ?? [])].filter(([rule]) => !globals.has(rule)).map(([, text]) => text)
        return [
          ...(changed.length === 0 ? [] : [[before === undefined ? `The ${name} mod adds these rules from now on:` : `The ${name} mod changed these rules, which apply from now on:`, ...changed].join('\n\n')]),
          ...(withdrawn.length === 0 ? [] : [[`These rules of the ${name} mod no longer apply:`, ...withdrawn].join('\n\n')]),
        ]
      })
      const gone = applied === undefined ? synced.removed : [...applied.keys()].filter((name) => !now.has(name))
      applied = now
      for (const text of [...notes, ...gone.map((name) => `The ${name} mod's rules no longer apply.`)]) {
        const added = await claude.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
        if (added.deny !== undefined) mod.log(`Claude Code refused the rules note: ${added.deny}`)
      }
    }
    const keepRules = async () => {
      following = following.then(followRules).catch((error: unknown) => report({ id: 'rules', message: "Could not link the mods' rules", error }))
      await following
    }
    sessions.current.beforeSessionStart(keepRules)
    sessions.current.beforePrompt(keepRules, { timeoutMs: 60_000 })

    sessions.current.onTurnEnd(async () => {
      mod.state.session.tip = await tipOf(mod)
    })
  },
})
