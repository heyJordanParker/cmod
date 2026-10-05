import { existsSync } from 'node:fs'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { dataFolder, formatEvent, readRecord, recordPath, scriptPaths, scriptsSha256, storeFolder, writeRecord, type RunnerEvent } from 'cmod-sdk/src/records.js'
import { messageOf } from 'cmod-sdk/src/utils/text.js'
import { readPlugin, type Plugin } from '../plugin.js'
import { runStep } from '../process.js'
import { fetchProgram, programSteps, restoreProgram } from '../program.js'
import { listFiles, readText, tilde, writeAtomically } from '../files.js'
import { paint, startProgress, type Progress } from '../progress.js'
import { approve, isApproved, revokeApprovals, storePath } from '../store.js'

export const summary = "Run a mod's install step and record it."

export const help = `Usage: cmod setup <plugin-root> [--events] [--consent <sha256>] [--yes]

${summary}

Downloads the program its package.json "cmod.program" names into
~/.local/bin, runs the mod's install step from its package.json "cmod" key,
saves its uninstall step, and records the mod as set up. An unchanged mod runs
nothing.

Options:
  --events            Print one event per line for a program to read:
                        needs-consent <sha256>\\t<install>\\t<uninstall>   exit 10
                        progress <done> <total> <label>
                        log <text>
                        done <name> <version>                          exit 0
                        failed <exit code>\\t<last line of stderr>       exit 1
  --consent <sha256>  Approve the scripts whose hash a needs-consent event named
  --yes               Approve the scripts without asking`

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
  const state = await checkSetup(plugin)
  if (!state.isCurrent && state.needsConsent) {
    if (consent !== state.sha256) {
      printEvent({ kind: 'needs-consent', sha256: state.sha256, install: plugin.steps.install ?? '', uninstall: plugin.steps.uninstall ?? '' })
      return 10
    }
    await approve(plugin.name, state.sha256)
  }
  const code = state.isCurrent ? 0 : await runSetup(plugin, state.sha256, printEvent).catch(printFailure)
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

export async function setupInTerminal(plugin: Plugin, options: { yes: boolean; consent?: string | undefined; onConsent?: () => void }, progress: Progress): Promise<number> {
  const state = await checkSetup(plugin)
  if (!state.isCurrent && state.needsConsent && !options.yes && options.consent !== state.sha256 && !askConsent(plugin)) {
    progress.fail(`${plugin.name} is not set up: its install step needs your consent. Run the command again with --yes after reading the commands.`)
    return 10
  }
  options.onConsent?.()
  if (state.isCurrent) {
    progress.succeed(`${plugin.name} ${plugin.version} is set up`)
    return 0
  }
  using hold = holdSignals()
  const heading = `Installing ${plugin.name}`
  const failure = { code: 0, message: '' }
  let code = 1
  try {
    if (state.needsConsent) await approve(plugin.name, state.sha256)
    progress.step(heading)
    code = await runSetup(plugin, state.sha256, (event) => {
      if (event.kind === 'progress') progress.update(heading, event.done, event.total, event.label)
      if (event.kind === 'log') progress.log(event.text)
      if (event.kind === 'failed') Object.assign(failure, event)
    })
  } finally {
    if (code !== 0) await deleteUnclaimedLeftovers(plugin.name)
  }
  if (code === 0) progress.succeed(`${plugin.name} ${plugin.version} is ready`)
  else if (hold.signal !== undefined) progress.fail(`Cancelled the install step of ${plugin.name} on ${hold.signal}.`)
  else progress.fail(`The install step of ${plugin.name} exited ${failure.code}${failure.message ? `: ${failure.message}` : ''}. Fix the step, then run cmod setup ${tilde(plugin.root)}.`)
  return code
}

export const heldSignals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGHUP', 'SIGTERM']

export type SignalHold = { signal: NodeJS.Signals | undefined; [Symbol.dispose](): void }

const holds = new Set<SignalHold>()

export function holdSignals(): SignalHold {
  if (holds.size === 0) for (const signal of heldSignals) process.on(signal, holdSignal)
  const hold: SignalHold = {
    signal: undefined,
    [Symbol.dispose]() {
      holds.delete(hold)
      if (holds.size > 0) return
      for (const signal of heldSignals) process.off(signal, holdSignal)
      if (hold.signal !== undefined) process.kill(process.pid, hold.signal)
    },
  }
  holds.add(hold)
  return hold
}

function holdSignal(signal: NodeJS.Signals): void {
  for (const hold of holds) hold.signal ??= signal
}

export async function deleteUnclaimedLeftovers(name: string): Promise<void> {
  const store = storeFolder(process.env)
  const path = recordPath(store, name)
  if (existsSync(`${path}.claim`) || existsSync(path)) return
  await rm(dataFolder(store, name), { recursive: true, force: true })
  await revokeApprovals(name)
}

async function checkSetup(plugin: Plugin): Promise<{ sha256: string; isCurrent: boolean; needsConsent: boolean }> {
  const { install, uninstall, program } = plugin.steps
  const sha256 = await scriptsSha256(plugin.steps, { read: (path) => readText(join(plugin.root, path)), list: (folder) => listFiles(join(plugin.root, folder)) })
  const record = await readRecord(readText, storeFolder(process.env), plugin.name)
  const isCurrent = record !== undefined && record.version === plugin.version && record.scriptsSha256 === sha256
  const needsConsent = (install ?? uninstall ?? program) !== undefined && !(await isApproved(plugin.name, sha256))
  return { sha256, isCurrent, needsConsent }
}

async function runSetup(plugin: Plugin, sha256: string, emit: (event: RunnerEvent) => void): Promise<number> {
  const { install, program } = plugin.steps
  if (program !== undefined) await fetchProgram(plugin, program, emit)
  const counted = program === undefined ? 0 : programSteps
  const folder = storePath('uninstall', plugin.name)
  const staged = `${folder}.${process.pid}.tmp`
  let hasUninstall = false
  let isRecorded = false
  try {
    if (install !== undefined) {
      const result = await runStep(['sh', '-c', install], plugin.root, await stepEnvironment(plugin.root, plugin.name, plugin.version), (event) =>
        emit(event.kind === 'progress' ? { ...event, done: event.done + counted, total: event.total + counted } : event),
      )
      if (result.exitCode !== 0) {
        emit({ kind: 'failed', code: result.exitCode, message: result.lastError })
        return 1
      }
    }
    hasUninstall = await saveUninstall(plugin, staged)
    await writeRecord(writeAtomically, storeFolder(process.env), {
      name: plugin.name,
      version: plugin.version,
      root: plugin.root,
      installedAt: new Date().toISOString(),
      scriptsSha256: sha256,
      uninstall: hasUninstall ? join(folder, 'uninstall.sh') : null,
      program: program ?? null,
    })
    isRecorded = true
  } finally {
    if (!isRecorded) {
      if (program !== undefined) await restoreProgram(program, await readRecord(readText, storeFolder(process.env), plugin.name))
      await rm(staged, { recursive: true, force: true })
    }
  }
  await rm(folder, { recursive: true, force: true })
  if (hasUninstall) await rename(staged, folder)
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

function askConsent(plugin: Plugin): boolean {
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
  return confirm('Run them?')
}

export function noteNextStep(plugin: Plugin, progress: Progress): void {
  progress.note(`Start Claude Code to use ${plugin.name}, or run /reload-plugins in a session that is running.`)
}
