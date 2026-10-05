import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { dataFolder, readRecord, recordPath, storeFolder, type InstallRecord, type RunnerEvent } from 'cmod-sdk/src/records.js'
import { readText } from '../files.js'
import { runStep } from '../process.js'
import { removeProgram } from '../program.js'
import { startProgress, type Progress } from '../progress.js'
import { revokeApprovals, storePath, takeLock } from '../store.js'
import { deleteUnrecordedLeftovers, holdSignals, modLock, printEvent, printFailure, stepEnvironment, uninterruptible } from './setup.js'

export const summary = "Run a removed mod's saved uninstall step."

export const help = `Usage: cmod teardown <plugin-name> [--events]

${summary}

Runs the mod's saved uninstall step, then deletes its install record, the saved
step, every version of its program from ~/.local/bin and the store, and its data
folder, and forgets the scripts you approved for it, so installing it again asks
again. It keeps the mod's config folder, ~/.claude/cmods/<plugin-name>, because
the files there are yours. Claude Code has already deleted the plugin's folder by then. A mod with
no install record has only its data folder and approvals deleted. While a setup
or another teardown of the mod runs, a teardown waits for it. A teardown whose
process is gone is taken over at once. Ctrl+C, a closed terminal, or SIGTERM
while it waits stops it. Once it runs, they wait for the uninstall step and the
removal to finish. A failed uninstall step keeps the record, so the teardown
can run again.

Options:
  --events  Print one event per line for a program to read:
              progress <done> <total> <label>
              log <text>
              done <name>                                       exit 0
              missing <name>, when the mod has no record          exit 0
              failed <exit code>\\t<last line of stderr>          exit 1`

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { events: { type: 'boolean', default: false } } })
  if (positionals.length !== 1) throw new Error(`cmod teardown takes one plugin name.\n\n${help}`)
  const name = positionals[0] as string
  return values.events ? tearDown(name, printEvent).catch(printFailure) : teardownInTerminal(name, startProgress())
}

export async function teardownInTerminal(name: string, progress: Progress): Promise<number> {
  const record = await readRecord(readText, storeFolder(process.env), name)
  const heading = `Uninstalling ${name}`
  if (record !== undefined) progress.step(heading)
  return tearDown(name, (event) => {
    if (event.kind === 'progress') progress.update(heading, event.done, event.total, event.label)
    if (event.kind === 'log') progress.log(event.text)
    if (event.kind === 'missing') progress.skip(`${name} has no install record, so there is nothing to tear down. cmod list shows the mods CMod set up.`)
    if (event.kind === 'failed') progress.fail(`The uninstall step of ${name} exited ${event.code}${event.message ? `: ${event.message}` : ''}. Fix ${record?.uninstall}, then run cmod teardown ${name}.`)
    if (event.kind === 'done') progress.succeed(record?.uninstall ? `Ran the uninstall step of ${name} and removed what CMod set up for it` : `Removed what CMod set up for ${name}`)
  })
}

async function tearDown(name: string, emit: (event: RunnerEvent) => void): Promise<number> {
  using hold = holdSignals()
  await using lock = await takeLock(modLock(name), hold.abortSignal)
  if (lock === undefined) return 1
  const record = await readRecord(readText, storeFolder(process.env), name)
  if (record === undefined) {
    await deleteUnrecordedLeftovers(name, hold.abortSignal)
    emit({ kind: 'missing', name })
    return 0
  }
  const code = await removeSetup(record, emit, hold.abortSignal)
  if (code === 0) emit({ kind: 'done', name })
  return code
}

async function removeSetup(record: InstallRecord, emit: (event: RunnerEvent) => void, cancel: AbortSignal): Promise<number> {
  const store = storeFolder(process.env)
  const folder = storePath('uninstall', record.name)
  if (record.uninstall !== null) {
    const { exitCode, lastError } = await runStep(uninterruptible(['sh', record.uninstall]), folder, await stepEnvironment(join(folder, 'root'), record.name, record.version), emit)
    if (exitCode !== 0) {
      emit({ kind: 'failed', code: exitCode, message: lastError })
      return 1
    }
  }
  if (record.program !== null) await removeProgram(record.program)
  await rm(dataFolder(store, record.name), { recursive: true, force: true })
  await revokeApprovals(record.name, cancel)
  await rm(recordPath(store, record.name))
  await rm(folder, { recursive: true, force: true })
  return 0
}
