import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { instanceFolder, readRecord, recordPath, storeFolder, type InstallRecord, type RunnerEvent } from '@cmodjs/core/src/records.js'
import { formatExit } from '@cmodjs/core/src/utils/text.js'
import { readText, tilde } from '../files.js'
import { runStep } from '../process.js'
import { removeData, removeProgram } from '../program.js'
import { startProgress, type Progress } from '../progress.js'
import { unlinkRules } from '../rules.js'
import { modBindings, restoreSettings, unbindKeys } from '../settings.js'
import { modLock, revokeApprovals, storePath, takeLock } from '../store.js'
import { holdSignals, printEvent, printFailure, stepEnvironment, uninterruptible } from './setup.js'

export const summary = "Run a removed mod's saved uninstall step."

export const help = `Usage: cmod teardown <plugin-name> [--events]

${summary}

Runs the mod's saved uninstall step, then removes the key bindings it added
that still run its commands and the Claude Code settings it set that still
hold its values, and deletes its install record, the saved step,
every version of its program with its links, its data
folder, and the addresses of its single-instance programs, and forgets the scripts you approved for it, so installing it again asks
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
              failed <exit code>\\t<what failed and its fix>      exit 1`

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { events: { type: 'boolean', default: false } } })
  if (positionals.length !== 1) throw new Error(`cmod teardown takes one plugin name.\n\n${help}`)
  const name = positionals[0] as string
  return values.events ? tearDown(name, printEvent).catch(printFailure) : teardownInTerminal(name, startProgress())
}

export async function teardownInTerminal(name: string, progress: Progress): Promise<number> {
  using hold = holdSignals()
  const record = await readRecord(readText, storeFolder(process.env), name)
  const heading = `Uninstalling ${name}`
  if (record !== undefined) progress.step(heading)
  let isAnswered = false as boolean
  const code = await tearDown(name, (event) => {
    if (event.type === 'progress') progress.update(heading, event.done, event.total, event.label)
    if (event.type === 'log') progress.log(event.text)
    if (event.type === 'missing') progress.skip(`${name} has no install record, so there is nothing to tear down. cmod list shows the mods cmod set up.`)
    if (event.type === 'failed') progress.fail(event.message)
    if (event.type === 'done') progress.succeed(record?.uninstall ? `Ran the uninstall step of ${name} and removed what cmod set up for it` : `Removed what cmod set up for ${name}`)
    isAnswered ||= event.type === 'missing' || event.type === 'failed' || event.type === 'done'
  })
  if (!isAnswered) progress.fail(`Cancelled uninstalling ${name} on ${hold.signal}, before its uninstall step started. Run cmod teardown ${name} to finish.`)
  return code
}

async function tearDown(name: string, emit: (event: RunnerEvent) => void): Promise<number> {
  using hold = holdSignals()
  await using lock = await takeLock(modLock(name), hold.abortSignal)
  if (lock === undefined) return 1
  const store = storeFolder(process.env)
  await rm(instanceFolder(store, name), { recursive: true, force: true })
  const record = await readRecord(readText, store, name)
  if (record === undefined) {
    await removeData(name)
    await revokeApprovals(name)
    emit({ type: 'missing', name })
    return 0
  }
  const code = await removeSetup(record, emit)
  if (code === 0) emit({ type: 'done', name })
  return code
}

async function removeSetup(record: InstallRecord, emit: (event: RunnerEvent) => void): Promise<number> {
  const store = storeFolder(process.env)
  const folder = storePath('uninstall', record.name)
  if (record.uninstall !== null) {
    const { exitCode, lastError } = await runStep(uninterruptible(['sh', record.uninstall]), folder, await stepEnvironment(join(folder, 'root'), record.name, record.version), emit)
    if (exitCode !== 0) {
      emit({ type: 'failed', code: exitCode, message: `The uninstall step of ${record.name} ${formatExit(exitCode, lastError)}. Fix ${tilde(record.uninstall)}, then run cmod teardown ${record.name}.` })
      return 1
    }
  }
  await unbindKeys(await modBindings(record.name, record.keys))
  await restoreSettings(record.name)
  if (record.program !== null) await removeProgram(record.program)
  await removeData(record.name)
  await unlinkRules(record.name)
  await revokeApprovals(record.name)
  await rm(recordPath(store, record.name))
  await rm(folder, { recursive: true, force: true })
  return 0
}
