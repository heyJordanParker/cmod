import { existsSync, watch } from 'node:fs'
import { mkdir, open, readdir, rm, utimes } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { instancePath, serviceLogPath, storeFolder } from '@cmodjs/core/src/records.js'
import { ifMissing, readJson, readText, writeAtomically } from '../files.js'
import { readLines, spawn } from '../process.js'
import { killMs, programsFolder, stopCopy, type Instance } from '../program.js'
import { removeService, startService } from '../service.js'
import { isHolding, modLock, startTime, takeLock } from '../store.js'

export const summary = "Run one copy of a mod's program for every session."

export const help = `Usage: cmod program <mod> [--no-wait | --service [--env <name>]... | --remove-service] -- <command…>

${summary}

Each session runs it for a program job with singleInstance. The first one
holds instances/<mod>/<program>.json.lock in the cmod store, runs the command
without CLAUDE_CODE_SESSION_ID, because the copy serves every session, writes the command's first line on standard output, its address, to
instances/<mod>/<program>.json, and prints it. It touches its file in the lock
every 5 seconds, so a session can tell a live holder from a killed one. Every
other one prints the address in that file, then each new one, and takes over
once the holder exits. With --no-wait, another one touches the holder's file,
prints held, and exits 0, and the session follows the instance file itself.
The holder stops the command on SIGTERM, SIGINT, or SIGHUP, and when its parent
process exits, and exits with the command's exit code when the command exits on
its own. The cmod command that replaces the command's file in the store's
programs folder, as cmod setup does for a new version, cmod link and cmod watch
for a linked checkout's changed build, and cmod download, sends the copy the
instance file names SIGTERM, then SIGKILL after 5 seconds, whatever cmod
program holds it, and the holder exits with the copy. The next cmod program
starts the new file. Every session runs one once the instance file is gone, and
a service's manager runs one at once. A copy an earlier holder left running gets
SIGTERM, then SIGKILL after 5 seconds, before the new holder starts its own.

With --service, which a session passes for a program job with isService, it
makes the holder a service of the computer, com.claudemodmanager.<mod>.<program>:
a launchd agent in ~/Library/LaunchAgents on macOS, and a systemd user service
in ~/.config/systemd/user on Linux. The service runs cmod program <mod> --
<command…> at login and again whenever it exits, with HOME, XDG_DATA_HOME,
CLAUDE_CONFIG_DIR, a PATH of the store's programs folder and the system
folders, CLAUDE_CODE_EXECPATH naming this session's Claude Code by the path
its updates keep, such as ~/.local/bin/claude, and each --env variable, and
cmod records it in services/<mod>/<program>.json. On macOS the service writes
its standard error to services/<mod>/<program>.log, which each holder cuts to
the last whole lines of its last 512 KiB once it passes 1 MiB, and Linux keeps
it in the journal. Holding the mod's lock in the cmod store, it loads the
service when it is new, changed, or not loaded, waits up to 15 seconds for the
program to print its address, prints held, and exits 0. A service whose
program printed none by then, and whose lock no holder holds, is removed as
cmod remove does, and it fails. When the computer does not take the service,
it deletes the service's file and record and runs as --no-wait does. When the
computer took the service and could not start it, it stops, disables, and
deletes the service and its record, as cmod remove does, and fails with the
error. Both failures keep the log and name it, or the journalctl command on
Linux.

With --remove-service, which a session passes for each service in
services/<mod>/ that the mod's setup no longer adds, it stops the program's
service, deletes its unit, its record, and its log, and exits 0. A program
with no service changes nothing.`

const checkMs = 5000

const serviceStartMs = 15_000

const logBytes = 1_048_576

const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

export async function run(argv: string[]): Promise<number> {
  const [mod, ...rest] = argv
  const separator = rest.indexOf('--')
  const [executable, ...args] = separator === -1 ? [] : rest.slice(separator + 1)
  if (mod === undefined || executable === undefined) throw new Error(`cmod program takes a mod's name, --, and the program's command.\n\n${help}`)
  const { values } = parseArgs({ args: rest.slice(0, separator), options: { 'no-wait': { type: 'boolean', default: false }, service: { type: 'boolean', default: false }, env: { type: 'string', multiple: true, default: [] }, 'remove-service': { type: 'boolean', default: false } } })
  if (values['remove-service']) {
    const lock = await takeLock(modLock(mod))
    try {
      await removeService(mod, basename(executable))
    } finally {
      await lock[Symbol.asyncDispose]()
    }
    return 0
  }
  const file = instancePath(storeFolder(process.env), mod, basename(executable))
  const lockPath = `${file}.lock`
  await mkdir(dirname(file), { recursive: true })
  if (values.service) {
    const lock = await takeLock(modLock(mod))
    try {
      const service = await startService(mod, [executable, ...args], values.env)
      if (service !== undefined) {
        if (!(await isStartedWithin(file, serviceStartMs))) {
          await removeService(mod, basename(executable), { keepsLog: true })
          throw new Error(`the ${service.label} service did not start ${executable} within ${serviceStartMs / 1000} seconds, so cmod removed it. ${service.status} shows why.`)
        }
        process.stdout.write('held\n')
        return 0
      }
    } finally {
      await lock[Symbol.asyncDispose]()
    }
  }
  const isNoWait = values['no-wait'] || values.service
  const ending = new AbortController()
  let wake = () => undefined as void
  const end = () => {
    ending.abort()
    wake()
  }
  const parent = process.ppid
  const parentCheck = setInterval(() => {
    if (process.ppid !== parent) end()
  }, checkMs)
  for (const signal of signals) process.on(signal, end)
  const watcher = watch(dirname(file), (_event, name) => {
    if (name?.endsWith('.tmp') !== true) wake()
  })
  try {
    let printed: string | undefined
    while (!ending.signal.aborted) {
      const lock = await takeLock(lockPath, AbortSignal.abort())
      if (lock !== undefined) {
        try {
          return await hold(file, serviceLogPath(storeFolder(process.env), mod, basename(executable)), executable, args, ending.signal)
        } finally {
          await lock[Symbol.asyncDispose]()
        }
      }
      if (isNoWait) {
        await touchHolders(lockPath)
        process.stdout.write('held\n')
        return 0
      }
      const address = ((await readJson(file)) as Instance | undefined)?.address
      if (address !== undefined && address !== printed) {
        printed = address
        process.stdout.write(`${address}\n`)
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, checkMs)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
        if (ending.signal.aborted) wake()
      })
    }
    return 0
  } finally {
    watcher.close()
    clearInterval(parentCheck)
    for (const signal of signals) process.off(signal, end)
  }
}

async function hold(file: string, log: string, executable: string, args: readonly string[], ending: AbortSignal): Promise<number> {
  const left = (await readJson(file)) as Instance | undefined
  if (left !== undefined) await stopCopy(left.pid, left.started)
  await rm(file, { force: true })
  await trimLog(log)
  const linked = join(programsFolder(), executable)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'CLAUDE_CODE_SESSION_ID'))
  const child = spawn([existsSync(linked) ? linked : executable, ...args], { env, stdout: 'pipe', stderr: 'inherit' })
  const stopping = () => {
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), killMs).unref()
  }
  ending.addEventListener('abort', stopping)
  if (ending.aborted) stopping()
  const ticking = setInterval(() => void touchHolders(`${file}.lock`), checkMs)
  try {
    const started = await startTime(child.pid)
    let shown: Promise<void> | undefined
    await readLines(child.stdout, (line) => {
      const address = line.trim()
      shown ??= writeAtomically(file, `${JSON.stringify({ address, pid: child.pid, started } satisfies Instance)}\n`).then(() => void process.stdout.write(`${address}\n`))
    })
    await shown
    const code = await child.exited
    return ending.aborted ? 0 : code
  } catch (error) {
    stopping()
    throw error
  } finally {
    clearInterval(ticking)
    ending.removeEventListener('abort', stopping)
    await rm(file, { force: true })
  }
}

async function isStartedWithin(file: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  do {
    const instance = (await readJson(file)) as Instance | undefined
    if (instance !== undefined && (await isHolding(instance.pid, instance.started))) return true
    await Bun.sleep(100)
  } while (Date.now() < deadline)
  for (const holder of await readdir(`${file}.lock`).catch(ifMissing([]))) if (await isHolding(Number(holder), await readText(join(`${file}.lock`, holder)))) return true
  return false
}

async function trimLog(path: string): Promise<void> {
  const log = await open(path, 'r+').catch(ifMissing(undefined))
  if (log === undefined) return
  try {
    const { size } = await log.stat()
    if (size <= logBytes) return
    const tail = Buffer.alloc(logBytes / 2)
    await log.read(tail, 0, tail.length, size - tail.length)
    const kept = tail.subarray(tail.indexOf('\n') + 1)
    await log.truncate(0)
    await log.write(kept, 0, kept.length, 0)
  } finally {
    await log.close()
  }
}

async function touchHolders(lock: string): Promise<void> {
  const now = new Date()
  for (const holder of await readdir(lock).catch(ifMissing([]))) await utimes(join(lock, holder), now, now).catch(ifMissing(undefined))
}
