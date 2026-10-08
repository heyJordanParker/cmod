import { existsSync } from 'node:fs'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { dataFolder, formatEvent, keyWords, permissionWords, readRecord, recordPath, scriptPaths, scriptsSha256, storeFolder, writeRecord, type RunnerEvent } from '@cmodjs/core/src/records.js'
import { formatExit, messageOf } from '@cmodjs/core/src/utils/text.js'
import { readPlugin, type Plugin } from '../plugin.js'
import { runStep } from '../process.js'
import { fetchProgram, programsFolder, programSteps, refuseThisMachine, removeData, removeProgram, restoreProgram } from '../program.js'
import { listFiles, readText, tilde, writeAtomically } from '../files.js'
import { paint, startProgress, type Progress } from '../progress.js'
import { bindKeys, keybindingsPath, settingsPath, turnOnUpdates, unbindKeys, updatesToTurnOnFor } from '../settings.js'
import { approvals, approve, modLock, revokeApprovals, storePath, takeLock } from '../store.js'

export const summary = "Run a mod's install step and record it."

export const help = `Usage: cmod setup <plugin-root> [--events] [--consent <sha256>] [--yes]

${summary}

Refuses a machine its package.json "os" and "cpu" leave out. Downloads
the program its package.json "cmod.program" names, which Claude Code
then runs by its name, and links it into ~/.local/bin for a terminal,
runs the mod's install step from its package.json "cmod" key,
saves its uninstall step, binds the keys its "cmod.keys" names in Claude
Code's keybindings.json, and records the mod as set up. A key you already
bound to something else stays yours, and the setup prints the line to add. An unchanged mod runs
nothing. While a setup or teardown of the mod runs, another setup waits for it,
then checks the mod again; a mod whose scripts changed meanwhile asks consent
again. A setup whose process is gone is taken over at once. Ctrl+C, a closed
terminal, or SIGTERM while it waits or before the install step starts stops the
setup and removes what it set up. When the install step of a mod that is not
set up fails or is stopped, the setup runs the mod's uninstall step, then
removes what it set up. When the install step of an upgrade fails or is
stopped, the setup keeps the version the record names. Once the install step
has finished, the setup records the mod, then exits.

Options:
  --events            Print one event per line for a program to read:
                        needs-consent <sha256>\\t<install>\\t<uninstall>\\t<keys>[\\t<permission>…]   exit 10
                        progress <done> <total> <label>
                        log <text>
                        done <name> <version>                          exit 0
                        failed <exit code>\\t<what failed>               exit 1
  --consent <sha256>  Approve the scripts whose hash a needs-consent event named
  --yes               Approve the scripts without asking`

type SetupState = { sha256: string; isCurrent: boolean; needsConsent: boolean; missing: readonly string[]; updates: string | undefined }

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { events: { type: 'boolean', default: false }, consent: { type: 'string' }, yes: { type: 'boolean', default: false } },
  })
  if (positionals.length !== 1) throw new Error(`cmod setup takes one plugin root.\n\n${help}`)
  const root = positionals[0] as string
  if (values.events) return setupWithEvents(root, values.consent)
  const plugin = await readPlugin(root)
  const progress = startProgress()
  const code = await setupInTerminal(plugin, { yes: values.yes, consent: values.consent }, progress)
  if (code === 0) noteNextStep(plugin, progress)
  return code
}

async function setupWithEvents(root: string, consent: string | undefined): Promise<number> {
  try {
    const plugin = await readPlugin(root)
    const code = await runSetup(plugin, consent, printEvent)
    if (code === 0) printEvent({ kind: 'done', name: plugin.name, version: plugin.version })
    return code
  } catch (error) {
    return printFailure(error)
  }
}

export function printEvent(event: RunnerEvent): void {
  process.stdout.write(`${formatEvent(event)}\n`)
}

export function printFailure(error: unknown): number {
  printEvent({ kind: 'failed', code: 1, message: messageOf(error) })
  return 1
}

export async function setupInTerminal(plugin: Plugin, options: { yes: boolean; consent?: string | undefined }, progress: Progress): Promise<number> {
  using hold = holdSignals()
  const heading = `Installing ${plugin.name}`
  const failure = { code: 0, message: '' }
  let code = 10
  while (code === 10) {
    const { sha256, needsConsent, missing, updates } = await checkSetup(plugin)
    const answer = !needsConsent || options.yes || options.consent === sha256 || (await askConsent(plugin, missing, updates, hold.abortSignal))
    if (answer !== true) {
      progress.fail(answer === false ? `${plugin.name} is not set up: it needs your consent. Run the command again with --yes after reading what it does.` : `Cancelled: ${plugin.name} is not set up.`)
      return 10
    }
    progress.step(heading)
    code = await runSetup(plugin, needsConsent ? sha256 : undefined, (event) => {
      if (event.kind === 'progress') progress.update(heading, event.done, event.total, event.label)
      if (event.kind === 'log') progress.log(event.text)
      if (event.kind === 'failed') Object.assign(failure, event)
    })
  }
  if (code === 0) progress.succeed(`${plugin.name} ${plugin.version} is ready`)
  else if (hold.signal === undefined) progress.fail(`${failure.message} Fix the install step, then run the command again.`)
  else if (failure.code === 0) progress.fail(`Cancelled setting up ${plugin.name} on ${hold.signal}, before its install step started.`)
  else progress.fail(`Cancelled on ${hold.signal}. ${failure.message}`)
  return code
}

const heldSignals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGHUP', 'SIGTERM']

export type SignalHold = { signal: NodeJS.Signals | undefined; readonly abortSignal: AbortSignal; [Symbol.dispose](): void }

const holds = new Map<SignalHold, AbortController>()

export function holdSignals(): SignalHold {
  if (holds.size === 0) for (const signal of heldSignals) process.on(signal, holdSignal)
  const held = [...holds.keys()].find((hold) => hold.signal !== undefined)?.signal
  const controller = new AbortController()
  if (held !== undefined) controller.abort()
  const hold: SignalHold = {
    signal: held,
    abortSignal: controller.signal,
    [Symbol.dispose]() {
      holds.delete(hold)
      if (holds.size > 0) return
      for (const signal of heldSignals) process.off(signal, holdSignal)
      if (hold.signal !== undefined) process.kill(process.pid, hold.signal)
    },
  }
  holds.set(hold, controller)
  return hold
}

function holdSignal(signal: NodeJS.Signals): void {
  for (const [hold, controller] of holds) {
    hold.signal ??= signal
    controller.abort()
  }
}

export function uninterruptible(argv: string[]): string[] {
  return ['sh', '-c', `trap '' ${heldSignals.map((signal) => signal.replace(/^SIG/, '')).join(' ')}; exec "$@"`, 'sh', ...argv]
}

async function checkSetup(plugin: Plugin): Promise<SetupState> {
  refuseThisMachine(plugin)
  const sha256 = await scriptsSha256(plugin.steps, { read: (path) => readText(join(plugin.root, path)), list: (folder) => listFiles(join(plugin.root, folder)) })
  const record = await readRecord(readText, storeFolder(process.env), plugin.name)
  const isCurrent = record !== undefined && record.version === plugin.version && record.scriptsSha256 === sha256
  const approved = await approvals(plugin.name)
  const missing = (plugin.steps.permissions ?? []).filter((item) => !approved.includes(item))
  const needsConsent = !isCurrent && Object.keys(plugin.steps).length > 0 && !approved.includes(sha256)
  return { sha256, isCurrent, needsConsent, missing, updates: await updatesToTurnOnFor(plugin.root, plugin.name) }
}

async function runSetup(plugin: Plugin, consent: string | undefined, emit: (event: RunnerEvent) => void): Promise<number> {
  using hold = holdSignals()
  await using lock = await takeLock(modLock(plugin.name), hold.abortSignal)
  if (lock === undefined) return 1
  const state = await checkSetup(plugin)
  if (state.isCurrent) return 0
  if (state.needsConsent && consent !== state.sha256) {
    emit({ kind: 'needs-consent', sha256: state.sha256, install: plugin.steps.install ?? '', uninstall: plugin.steps.uninstall ?? '', keys: keyWords(plugin.steps.keys), permissions: state.missing })
    return 10
  }
  const store = storeFolder(process.env)
  let code = 1
  try {
    code = await setUpMod(plugin, state, hold, emit)
    return code
  } finally {
    if (code !== 0 && state.needsConsent) await revokeApprovals(plugin.name, [state.sha256, ...state.missing])
    if (code !== 0 && !existsSync(recordPath(store, plugin.name))) await removeData(plugin.name)
  }
}

async function setUpMod(plugin: Plugin, state: SetupState, hold: SignalHold, emit: (event: RunnerEvent) => void): Promise<number> {
  if (hold.signal !== undefined) return 1
  const { install, uninstall, program } = plugin.steps
  const store = storeFolder(process.env)
  const previous = await readRecord(readText, store, plugin.name)
  if (state.needsConsent) await approve(plugin.name, [state.sha256, ...state.missing])
  if (program !== undefined) await fetchProgram(plugin, program, emit)
  const counted = program === undefined ? 0 : programSteps
  const folder = storePath('uninstall', plugin.name)
  const staged = `${folder}.tmp`
  const replaced = `${folder}.old`
  let hasUninstall = false
  let isRecorded = false
  let bound: Record<string, string> = {}
  try {
    if (hold.signal !== undefined) return 1
    if (install !== undefined) {
      const environment = await stepEnvironment(plugin.root, plugin.name, plugin.version)
      const result = await runStep(['sh', '-c', install], plugin.root, environment, (event) =>
        emit(event.kind === 'progress' ? { ...event, done: event.done + counted, total: event.total + counted } : event),
      )
      if (result.exitCode !== 0) {
        const sentences = [`The install step of ${plugin.name} ${formatExit(result.exitCode, result.lastError)}.`]
        if (uninstall !== undefined && previous === undefined) {
          const undone = await runStep(uninterruptible(['sh', '-c', uninstall]), plugin.root, environment, (event) => {
            if (event.kind === 'log') emit(event)
          })
          if (undone.exitCode === 0) emit({ kind: 'log', text: `The uninstall step of ${plugin.name} undid the install.` })
          else sentences.push(`The uninstall step then ${formatExit(undone.exitCode, undone.lastError)}, so parts of the install may remain.`)
        }
        emit({ kind: 'failed', code: result.exitCode, message: sentences.join(' ') })
        return 1
      }
    }
    hasUninstall = await saveUninstall(plugin, staged)
    if (hasUninstall) {
      await rm(replaced, { recursive: true, force: true })
      if (existsSync(folder)) await rename(folder, replaced)
      await rename(staged, folder)
    }
    await unbindKeys(previous?.keys ?? {})
    const keys = await bindKeys(plugin.steps.keys ?? {})
    bound = keys.bound
    for (const text of keys.kept) emit({ kind: 'log', text })
    await writeRecord(writeAtomically, store, {
      name: plugin.name,
      version: plugin.version,
      root: plugin.root,
      installedAt: new Date().toISOString(),
      scriptsSha256: state.sha256,
      uninstall: hasUninstall ? join(folder, 'uninstall.sh') : null,
      program: program ?? null,
      keys: bound,
    })
    isRecorded = true
    if (state.updates !== undefined) {
      await turnOnUpdates(state.updates)
      emit({ kind: 'log', text: `${plugin.name} now updates automatically from the ${state.updates} marketplace. Turn it off in /plugin, Marketplaces.` })
    }
  } finally {
    if (!isRecorded) {
      await unbindKeys(bound)
      await bindKeys(previous?.keys ?? {})
      if (program !== undefined) await restoreProgram(program, previous)
      if (previous === undefined) await rm(folder, { recursive: true, force: true })
    }
    await rm(staged, { recursive: true, force: true })
    await rm(replaced, { recursive: true, force: true })
  }
  if (!hasUninstall) await rm(folder, { recursive: true, force: true })
  if (previous?.program && previous.program !== program) await removeProgram(previous.program)
  return 0
}

export async function stepEnvironment(root: string, name: string, version: string): Promise<Record<string, string | undefined>> {
  const data = dataFolder(storeFolder(process.env), name)
  await mkdir(data, { recursive: true })
  const path = [dirname(process.execPath), programsFolder(), process.env['PATH']].filter(Boolean).join(':')
  return { ...process.env, PATH: path, CMOD_PLUGIN_ROOT: root, CMOD_DATA: data, CMOD_VERSION: version }
}

async function saveUninstall(plugin: Plugin, folder: string): Promise<boolean> {
  await rm(folder, { recursive: true, force: true })
  const { uninstall } = plugin.steps
  if (uninstall === undefined) return false
  const scriptFolders = new Set<string>()
  for (const path of scriptPaths(uninstall)) {
    if ((await stat(join(plugin.root, path)).catch(() => undefined))?.isFile()) scriptFolders.add(dirname(path))
  }
  await mkdir(join(folder, 'root'), { recursive: true })
  for (const scriptFolder of scriptFolders) {
    for (const path of await listFiles(join(plugin.root, scriptFolder))) {
      const target = join(folder, 'root', scriptFolder, path)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(join(plugin.root, scriptFolder, path), target)
    }
  }
  await Bun.write(join(folder, 'uninstall.sh'), `cd "$(dirname "$0")/root" || exit 1\n${uninstall}\n`)
  return true
}

async function askConsent(plugin: Plugin, missing: readonly string[], updates: string | undefined, cancel: AbortSignal): Promise<boolean | undefined> {
  const style = paint()
  const { install, uninstall, program, keys } = plugin.steps
  const lines = [
    '',
    `${style.bold(plugin.name)} ${plugin.version}`,
    ...(plugin.description === undefined ? [] : [`  ${style.dim(plugin.description)}`]),
    '',
    ...(install === undefined && uninstall === undefined
      ? []
      : [
          `  It runs these commands in ${tilde(plugin.root)}:`,
          `    install    ${install === undefined ? style.dim('none') : style.cyan(install)}`,
          `    uninstall  ${uninstall === undefined ? style.dim('none') : style.cyan(uninstall)}`,
        ]),
    ...(program === undefined ? [] : [`  It installs the program ${style.cyan(program)}, which Claude runs by its name.`]),
    ...(keys === undefined ? [] : [`  It binds keys in ${tilde(keybindingsPath())}:`, ...Object.entries(keys).map(([key, command]) => `    ${key.padEnd(10)} ${style.cyan(`/${command}`)}`)]),
    ...(missing.length === 0 ? [] : ['  It asks to:', ...missing.map((item) => `    ${style.cyan(permissionWords(item))}`)]),
    ...(updates === undefined ? [] : [`  It updates automatically from the ${style.cyan(updates)} marketplace, set in ${tilde(settingsPath())}.`]),
    '',
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  if (!process.stdin.isTTY) return false
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  prompt.on('SIGINT', () => process.kill(process.pid, 'SIGINT'))
  const closed = new Promise<undefined>((resolve) => prompt.once('close', () => resolve(undefined)))
  try {
    const answer = await Promise.race([prompt.question(`Set up ${plugin.name}? [y/N] `, { signal: cancel }), closed])
    return answer === undefined ? undefined : /^y(es)?$/i.test(answer.trim())
  } catch (error) {
    if ((error as Error).name === 'AbortError') return undefined
    throw error
  } finally {
    prompt.close()
  }
}

export function noteNextStep(plugin: Plugin, progress: Progress): void {
  progress.note(`Start Claude Code to use ${plugin.name}, or run /reload-plugins in a session that is running.`)
}
