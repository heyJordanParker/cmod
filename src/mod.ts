import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import { defineMod, longestMs, messageOf, type Mod } from '../node_modules/@cmodjs/core/mod.js'
import { parseEvent } from '../node_modules/@cmodjs/core/records.js'
import { formatExit } from '../node_modules/@cmodjs/core/utils/text.js'
import type { HistoryRequest } from '../node_modules/@cmodjs/core/runtime/history.js'
import { sessionsWith } from '../node_modules/@cmodjs/core/runtime/state.js'
import { modsMemory, modsPanel, type ModsState } from './mods.js'

export type CmodPluginState = { readonly global: { installedPlugins: readonly string[] | null }; readonly session: { tip: string | null } } & ModsState

const cmodGlobal: CmodPluginState['global'] = { installedPlugins: null }

const cmodSession: CmodPluginState['session'] = { tip: null }

const newestMessages = 8

async function tipOf(mod: Mod<CmodPluginState>): Promise<string | null> {
  const messages = await mod.claude.session.messages()
  if (messages.length === 0) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([messages.length, messages.slice(-newestMessages)])))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const panels = new WeakMap<object, ReturnType<typeof modsPanel<CmodPluginState>>>()

function historyArguments(request: HistoryRequest): string[] {
  const scope = (since: string | undefined, everyProject: boolean | undefined) => [...(since === undefined ? [] : ['--since', since]), ...(everyProject === true ? ['--all'] : [])]
  const common = ['--json', '--project', request.project]
  if (request.command === 'sessions') return ['history', 'sessions', ...common, ...scope(request.since, request.everyProject)]
  if (request.command === 'search') return ['history', 'search', request.text, ...common, ...scope(request.since, request.everyProject)]
  const { session, agent, after, last, limit } = request
  return ['history', 'messages', session, ...common, ...(agent === undefined ? [] : ['--agent', agent]), ...(after === undefined ? [] : ['--after', after]), ...(last === undefined ? [] : ['--last', String(last)]), '--limit', String(limit)]
}

async function runCmod(mod: Mod<CmodPluginState>, args: readonly string[]): Promise<string> {
  const stream = mod.process.spawn(['cmod', ...args], { env: { CLAUDE_CODE_SESSION_ID: await mod.claude.session.id() } })
  let stdout = ''
  let stderr = ''
  for await (const piece of stream) {
    if (piece.stream === 'stdout') stdout += piece.text
    else stderr += piece.text
  }
  const { code } = await stream.result
  const lastError = stderr.trim().split('\n').at(-1) ?? ''
  if (code !== 0) throw new Error(lastError === '' ? `${args.slice(0, 2).join(' ')} ${formatExit(code, '')}.` : lastError)
  return stdout
}

export const cmodPlugin = defineMod({
  name: 'cmod',
  state: { global: cmodGlobal, session: cmodSession, memory: modsMemory },

  api: {
    async forkParent(_input: null, mod) {
      const tip = await tipOf(mod)
      if (tip === null) return null
      const current = await mod.claude.session.id()
      return (await sessionsWith(mod.claude, mod.name, 'tip', tip)).find((session) => session !== current) ?? null
    },
    async openSettings(input: { readonly mod: string; readonly page?: string }, mod) {
      const panel = panels.get(mod)
      if (panel === undefined) throw new Error('cmod has not started its /mods panel yet.')
      await panel.open(input.mod, input.page)
      return null
    },
    async history(request: HistoryRequest, mod) {
      return JSON.parse(await runCmod(mod, historyArguments(request))) as unknown
    },
    async updateSettings(input: { readonly mod: string; readonly source: string; readonly project: string; readonly values: Readonly<Record<string, unknown>> }, mod) {
      await runCmod(mod,['settings', input.mod, input.source, JSON.stringify(input.values), '--project', input.project])
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

    void runCmod(mod, ['history', 'index']).catch((error: unknown) => mod.claude.ui.log(`cmod: ${messageOf(error)}`, { to: 'debug' }))

    const tearDown = async (name: string) => {
      const { exitCode, stdout, stderr } = await mod.process.run(['cmod', 'teardown', name, '--events'], { timeoutMs: longestMs })
      const outcome = parseEvent(stdout.trim().split('\n').at(-1) ?? '')
      const isAnswered = outcome.kind === 'done' || outcome.kind === 'missing' || outcome.kind === 'failed'
      if (isAnswered) mod.state.global.installedPlugins = (mod.state.global.installedPlugins ?? []).filter((installed) => installed !== name)
      if (outcome.kind === 'done') mod.ui.toast(`${name} is uninstalled. A session that still runs it stops after /reload-plugins.`)
      else if (outcome.kind === 'failed') mod.ui.toast(outcome.message)
      else if (exitCode !== 0) mod.ui.toast(`cmod teardown ${name} exited ${exitCode}: ${stderr.trim().split('\n').at(-1)}`)
    }

    const watchRemovals = async () => {
      const enabledPlugins = (await mod.claude.settings.read({ source: 'user' }))['enabledPlugins'] as Record<string, unknown> | undefined
      const current = [...new Set(Object.keys(enabledPlugins ?? {}).map((key) => key.replace(/@[^@]*$/, '')))]
      const previous = mod.state.global.installedPlugins
      const removed = (previous ?? []).filter((name) => !current.includes(name))
      const installed = [...current, ...removed]
      if (previous === null || previous.length !== installed.length || !installed.every((name) => previous.includes(name))) mod.state.global.installedPlugins = installed
      for (const name of removed) {
        if (triedRemovals.has(name)) continue
        triedRemovals.add(name)
        void tearDown(name).catch((error: unknown) => {
          mod.ui.toast(`cmod teardown ${name} did not run: ${messageOf(error)}`)
        })
      }
    }

    mod.on('SessionStart', watchRemovals)
    mod.on('UserPromptSubmit', watchRemovals)

    const keepTip = async () => {
      mod.state.session.tip = await tipOf(mod)
    }
    mod.on('Stop', keepTip)
    mod.on('StopFailure', keepTip)
  },
})
