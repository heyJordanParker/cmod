import { rename, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { dataFolder, readRecord, recordPath, storeFolder, type InstallRecord, type RunnerEvent } from 'cmod-sdk/src/records.js'
import { readText } from '../files.js'
import { runStep } from '../process.js'
import { removeProgram } from '../program.js'
import { startProgress, type Progress } from '../progress.js'
import { abandonedClaimMs, revokeApprovals, storePath } from '../store.js'
import { deleteUnclaimedLeftovers, heldSignals, holdSignals, printEvent, printFailure, stepEnvironment } from './setup.js'

export const summary = "Run a removed mod's saved uninstall step."

export const help = `Usage: cmod teardown <plugin-name> [--events]

${summary}

Runs the mod's saved uninstall step, then deletes its install record, the saved
step, every version of its program from ~/.local/bin and the store, and its data
folder, and forgets the scripts you approved for it, so installing it again asks
again. It keeps the mod's config folder, ~/.claude/cmods/<plugin-name>, because
the files there are yours. Claude Code has already deleted the plugin's folder by then. A mod with
no install record has only its data folder and approvals deleted. While another
teardown or a setup of the mod runs, a teardown runs nothing. A teardown that
stopped more than 10 minutes ago without finishing is taken over by the next
one. Ctrl+C, a closed terminal, or SIGTERM waits for the uninstall step and the
removal to finish.

Options:
  --events  Print one event per line for a program to read:
              progress <done> <total> <label>
              log <text>
              done <name>                                       exit 0
              missing <name>, when the mod has no record          exit 0
              claimed <name>, when another teardown or a setup
                of the mod runs                                   exit 0
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
    if (event.kind === 'claimed') progress.skip(`Another cmod command is setting up or tearing down ${name}, so this teardown runs nothing.`)
    if (event.kind === 'failed') progress.fail(`The uninstall step of ${name} exited ${event.code}${event.message ? `: ${event.message}` : ''}. Fix ${record?.uninstall}, then run cmod teardown ${name}.`)
    if (event.kind === 'done') progress.succeed(record?.uninstall ? `Ran the uninstall step of ${name} and removed what CMod set up for it` : `Removed what CMod set up for ${name}`)
  })
}

async function tearDown(name: string, emit: (event: RunnerEvent) => void): Promise<number> {
  const hold = holdSignals()
  try {
    const record = await claimRecord(name)
    if (record === undefined) {
      emit({ kind: (await deleteUnclaimedLeftovers(name)) ? 'missing' : 'claimed', name })
      return 0
    }
    const code = await runTeardown(record, emit)
    if (code === 0) emit({ kind: 'done', name })
    return code
  } finally {
    hold[Symbol.dispose]()
  }
}

async function claimRecord(name: string): Promise<InstallRecord | undefined> {
  const store = storeFolder(process.env)
  const path = recordPath(store, name)
  const claimedAt = (await stat(`${path}.claim`).catch(() => undefined))?.mtimeMs
  if (claimedAt !== undefined && Date.now() - claimedAt > abandonedClaimMs) await ranOnFile(() => rename(`${path}.claim`, path))
  const record = await readRecord(readText, store, name)
  if (record === undefined) return undefined
  const now = new Date()
  const isClaimed = await ranOnFile(async () => {
    await utimes(path, now, now)
    await rename(path, `${path}.claim`)
  })
  return isClaimed ? record : undefined
}

async function ranOnFile(action: () => Promise<void>): Promise<boolean> {
  return action().then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )
}

async function runTeardown(record: InstallRecord, emit: (event: RunnerEvent) => void): Promise<number> {
  const path = recordPath(storeFolder(process.env), record.name)
  const code = await removeSetup(record, emit).catch(async (error: unknown) => {
    await rename(`${path}.claim`, path)
    throw error
  })
  if (code === 0) await rm(`${path}.claim`)
  else await rename(`${path}.claim`, path)
  return code
}

async function removeSetup(record: InstallRecord, emit: (event: RunnerEvent) => void): Promise<number> {
  const folder = storePath('uninstall', record.name)
  if (record.uninstall !== null) {
    const ignore = `trap '' ${heldSignals.map((signal) => signal.replace(/^SIG/, '')).join(' ')}; `
    const { exitCode, lastError } = await runStep(['sh', '-c', `${ignore}exec sh "$0"`, record.uninstall], folder, await stepEnvironment(join(folder, 'root'), record.name, record.version), emit)
    if (exitCode !== 0) {
      emit({ kind: 'failed', code: exitCode, message: lastError })
      return 1
    }
  }
  if (record.program !== null) await removeProgram(record.program)
  await rm(dataFolder(storeFolder(process.env), record.name), { recursive: true, force: true })
  await rm(folder, { recursive: true, force: true })
  await revokeApprovals(record.name)
  return 0
}
