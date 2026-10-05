import { existsSync } from 'node:fs'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { dataFolder, formatEvent, readRecord, recordPath, scriptPaths, scriptsSha256, storeFolder, writeRecord, type RunnerEvent } from 'cmod-sdk/src/records.js'
import { messageOf } from 'cmod-sdk/src/utils/text.js'
import { readPlugin, type Plugin } from '../plugin.js'
import { runStep } from '../process.js'
import { fetchProgram, programSteps, removeProgram, restoreProgram } from '../program.js'
import { listFiles, readText, tilde, writeAtomically } from '../files.js'
import { paint, startProgress, type Progress } from '../progress.js'
import { approve, isApproved, modLock, revokeApprovals, storePath, takeLock } from '../store.js'

export const summary = "Run a mod's install step and record it."

export const help = `Usage: cmod setup <plugin-root> [--events] [--consent <sha256>] [--yes]

${summary}

Downloads the program its package.json "cmod.program" names into
~/.local/bin, runs the mod's install step from its package.json "cmod" key,
saves its uninstall step, and records the mod as set up. An unchanged mod runs
nothing. While a setup or teardown of the mod runs, another setup waits for it,
then checks the mod again; a mod whose scripts changed meanwhile asks consent
again. A setup whose process is gone is taken over at once. Ctrl+C, a closed
terminal, or SIGTERM while it waits or before the install step starts stops the
setup and removes what it set up. When one stops the install step of a mod
that is not set up, the setup runs the mod's uninstall step, then removes what
it set up. When one stops the install step of an upgrade, the setup keeps the
version the record names, as a failed upgrade does. Once the install step has
finished, the setup records the mod, then exits.

Options:
  --events            Print one event per line for a program to read:
                        needs-consent <sha256>\\t<install>\\t<uninstall>   exit 10
                        progress <done> <total> <label>
                        log <text>
                        done <name> <version>                          exit 0
                        failed <exit code>\\t<last line of stderr>       exit 1
  --consent <sha256>  Approve the scripts whose hash a needs-consent event named
  --yes               Approve the scripts without asking`

type SetupState = { sha256: string; isCurrent: boolean; needsConsent: boolean }

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { events: { type: 'boolean', default: false }, consent: { type: 'string' }, yes: { type: 'boolean', default: false } },
  })
  if (positionals.length !== 1) throw new Error(`cmod setup takes one plugin root.\n\n${help}`)
  const plugin = await readPlugin(positionals[0] as string)
  if (values.events) return setupWithEvents(plugin, values.consent)
  const progress = startProgress()
  const code = await setupInTerminal(plugin, { yes: values.yes, consent: values.consent }, progress)
  if (code === 0) noteNextStep(plugin, progress)
  return code
}

async function setupWithEvents(plugin: Plugin, consent: string | undefined): Promise<number> {
  const code = await runSetup(plugin, consent, printEvent).catch(printFailure)
  if (code === 0) printEvent({ kind: 'done', name: plugin.name, version: plugin.version })
  return code
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
    const { sha256, needsConsent } = await checkSetup(plugin)
    const answer = !needsConsent || options.yes || options.consent === sha256 || (await askConsent(plugin, hold.abortSignal))
    if (answer !== true) {
      progress.fail(answer === false ? `${plugin.name} is not set up: its install step needs your consent. Run the command again with --yes after reading the commands.` : `Cancelled: ${plugin.name} is not set up.`)
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
  else if (hold.signal === undefined) progress.fail(`The install step of ${plugin.name} exited ${failure.code}${failure.message ? `: ${failure.message}` : ''}. Fix the step, then run cmod setup ${tilde(plugin.root)}.`)
  else if (failure.code === 0) progress.fail(`Cancelled setting up ${plugin.name} on ${hold.signal}, before its install step started.`)
  else progress.fail(`Cancelled the install step of ${plugin.name} on ${hold.signal}.`)
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
  const { install, uninstall, program } = plugin.steps
  const sha256 = await scriptsSha256(plugin.steps, { read: (path) => readText(join(plugin.root, path)), list: (folder) => listFiles(join(plugin.root, folder)) })
  const record = await readRecord(readText, storeFolder(process.env), plugin.name)
  const isCurrent = record !== undefined && record.version === plugin.version && record.scriptsSha256 === sha256
  const needsConsent = !isCurrent && (install ?? uninstall ?? program) !== undefined && !(await isApproved(plugin.name, sha256))
  return { sha256, isCurrent, needsConsent }
}

async function runSetup(plugin: Plugin, consent: string | undefined, emit: (event: RunnerEvent) => void): Promise<number> {
  using hold = holdSignals()
  await using lock = await takeLock(modLock(plugin.name), hold.abortSignal)
  if (lock === undefined) return 1
  const state = await checkSetup(plugin)
  if (state.isCurrent) return 0
  if (state.needsConsent && consent !== state.sha256) {
    emit({ kind: 'needs-consent', sha256: state.sha256, install: plugin.steps.install ?? '', uninstall: plugin.steps.uninstall ?? '' })
    return 10
  }
  const store = storeFolder(process.env)
  let code = 1
  try {
    code = await setUpMod(plugin, state, hold, emit)
    return code
  } finally {
    if (code !== 0 && state.needsConsent) await revokeApprovals(plugin.name, state.sha256)
    if (code !== 0 && !existsSync(recordPath(store, plugin.name))) await rm(dataFolder(store, plugin.name), { recursive: true, force: true })
  }
}

async function setUpMod(plugin: Plugin, state: SetupState, hold: SignalHold, emit: (event: RunnerEvent) => void): Promise<number> {
  if (hold.signal !== undefined) return 1
  const { install, uninstall, program } = plugin.steps
  const store = storeFolder(process.env)
  const previous = await readRecord(readText, store, plugin.name)
  if (state.needsConsent) await approve(plugin.name, state.sha256)
  if (program !== undefined) await fetchProgram(plugin, program, emit)
  const counted = program === undefined ? 0 : programSteps
  const folder = storePath('uninstall', plugin.name)
  const staged = `${folder}.tmp`
  const replaced = `${folder}.old`
  let hasUninstall = false
  let isRecorded = false
  try {
    if (hold.signal !== undefined) return 1
    if (install !== undefined) {
      const environment = await stepEnvironment(plugin.root, plugin.name, plugin.version)
      const result = await runStep(['sh', '-c', install], plugin.root, environment, (event) =>
        emit(event.kind === 'progress' ? { ...event, done: event.done + counted, total: event.total + counted } : event),
      )
      if (result.exitCode !== 0) {
        const isCancelled = hold.signal !== undefined || heldSignals.some((signal) => result.exitCode === 128 + constants.signals[signal])
        if (isCancelled && uninstall !== undefined && previous === undefined) {
          const undone = await runStep(uninterruptible(['sh', '-c', uninstall]), plugin.root, environment, (event) => {
            if (event.kind === 'log') emit(event)
          })
          emit({ kind: 'log', text: `The uninstall step of ${plugin.name} exited ${undone.exitCode}.` })
        }
        emit({ kind: 'failed', code: result.exitCode, message: result.lastError })
        return 1
      }
    }
    hasUninstall = await saveUninstall(plugin, staged)
    if (hasUninstall) {
      await rm(replaced, { recursive: true, force: true })
      if (existsSync(folder)) await rename(folder, replaced)
      await rename(staged, folder)
    }
    await writeRecord(writeAtomically, store, {
      name: plugin.name,
      version: plugin.version,
      root: plugin.root,
      installedAt: new Date().toISOString(),
      scriptsSha256: state.sha256,
      uninstall: hasUninstall ? join(folder, 'uninstall.sh') : null,
      program: program ?? null,
    })
    isRecorded = true
  } finally {
    if (!isRecorded) {
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
  const path = [dirname(process.execPath), process.env['PATH']].filter(Boolean).join(':')
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

async function askConsent(plugin: Plugin, cancel: AbortSignal): Promise<boolean | undefined> {
  const style = paint()
  const { install, uninstall, program } = plugin.steps
  const lines = [
    '',
    `${style.bold(plugin.name)} ${plugin.version}`,
    ...(plugin.description === undefined ? [] : [`  ${style.dim(plugin.description)}`]),
    '',
    `  It runs these commands in ${tilde(plugin.root)}:`,
    `    install    ${install === undefined ? style.dim('none') : style.cyan(install)}`,
    `    uninstall  ${uninstall === undefined ? style.dim('none') : style.cyan(uninstall)}`,
    ...(program === undefined ? [] : [`  It downloads the program ${style.cyan(program)} into ~/.local/bin.`]),
    '',
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  if (!process.stdin.isTTY) return false
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  prompt.on('SIGINT', () => process.kill(process.pid, 'SIGINT'))
  const closed = new Promise<undefined>((resolve) => prompt.once('close', () => resolve(undefined)))
  try {
    const answer = await Promise.race([prompt.question('Run them? [y/N] ', { signal: cancel }), closed])
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
