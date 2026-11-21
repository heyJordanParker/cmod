import { existsSync, watch } from 'node:fs'
import { mkdir, open, readdir, rm, utimes } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as after } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { instancePath, interfaceName, processTypes, serviceLogPath, storeFolder, type ProcessType, type ProgramInstance } from '@cmodjs/core/src/records.js'
import { connectServe } from '@cmodjs/core/src/runtime/bun.js'
import { providerActs } from '@cmodjs/core/src/runtime/interfaces.js'
import { isConnectionGone, RpcError, rpcCodes } from '@cmodjs/core/src/runtime/rpc.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { ifMissing, readJson, readText, writeAtomically } from '../files.js'
import { readLines, spawn } from '../process.js'
import { folderEnvironment, killMs, programsFolder, stopCopy } from '../program.js'
import { removeService, serviceNames, startService } from '../service.js'
import { isHolding, modLock, startTime, takeLock } from '../store.js'
import { hasTailnetChanged, readTailnet, serveOnTailnet, stopServing, tailnetEnvironment } from '../tailnet.js'

export const summary = "Run one copy of a mod's program for every session."

export const help = `Usage: cmod program <mod> [--web-app] [--no-wait | --service [--env <name>]... [--process-type <type>] | --remove-service] -- <command…>

${summary}

Each session runs it for a program job with singleInstance. The first one
holds instances/<mod>/<program>.json.lock in the cmod store, runs the command
without CLAUDE_CODE_SESSION_ID, because the copy serves every session, writes the command's first line on standard output, its address, to
instances/<mod>/<program>.json with the copy's pid and start time, and prints
it. For a command that prints nothing and only provides interfaces, it writes
the pid and start time there once cmod serve says the copy provided one, and
prints provided. The command gets CMOD_MOD, the
mod's name, and CMOD_PROGRAM, the program's, which connect() from
@cmodjs/core/rpc.js reads to provide interfaces, and CMOD_DATA and CMOD_CACHE,
the mod's data and cache folders, as an install step gets them. It touches its file in the lock
every 5 seconds, so a session can tell a live holder from a killed one. Every
other one prints the address in that file, then each new one, and takes over
once the holder exits. With --no-wait, another one touches the holder's file,
prints held, and exits 0, and the session follows the instance file itself.
A --no-wait run of a program with a service record does so with no holder too,
because the service's own holder takes the lock back.
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
XDG_CACHE_HOME, XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR, and HERDR_APP_HOME as the
session has them, so the program gets the session's CMOD_DATA and CMOD_CACHE,
a PATH of the store's programs folder and the system
folders, CLAUDE_CODE_EXECPATH naming this session's Claude Code by the path
its updates keep, such as ~/.local/bin/claude, and each --env variable, and
cmod records it in services/<mod>/<program>.json. On macOS the service writes
its standard error to services/<mod>/<program>.log, which each holder cuts to
the last whole lines of its last 512 KiB once it passes 1 MiB, and Linux keeps
it in the journal. Holding the mod's lock in the cmod store, it loads the
service when it is new, changed, or not loaded, waits up to 15 seconds for the
program to start, prints held, and exits 0. A program has started once it
printed its address, or once its connection to cmod serve provided an
interface. A service whose program did neither by then, and whose lock no
holder holds, is removed as cmod remove does, and it fails. When the computer does not take the service,
it deletes the service's file and record and runs as --no-wait does. When the
computer took the service and could not start it, it stops, disables, and
deletes the service and its record, as cmod remove does, and fails with the
error. Both failures keep the log and name it, or the journalctl command on
Linux.

With --web-app, which a session passes for a program job with isWebApp, the
holder puts the copy on your tailnet while servesTailnet in preferences.json
is on, its default, and Tailscale is signed in with HTTPS on. It gives the copy
CMOD_TAILNET_NAME, this computer's tailnet name, and CMOD_TAILNET_LOGIN, your
Tailscale login, and once the copy prints 127.0.0.1:<port>, runs tailscale
serve --bg --https=<tailnet port> before it writes the address. The tailnet
port is the first port the copy listened on, kept in tailnet/<mod>/<program>.json
with the address, https://<name>:<tailnet port>/, or the reason it is not on
the tailnet. The holder takes the mapping off when the copy exits, and stops
the copy, so it starts again, when servesTailnet changes or, checked every
minute, Tailscale becomes ready. cmod teardown takes every mapping of the mod off.

With --process-type, which a session passes for a program job with
processType, the launchd agent carries that ProcessType: Interactive runs the
program at the priority of an app, where launchd throttles a service with
none, and Background runs it at the lowest. systemd has no such class, so a Linux unit carries none.

With --remove-service, which a session passes for each service in
services/<mod>/ that the mod's setup no longer adds, it stops the program's
service, deletes its unit, its record, and its log, and exits 0. A program
with no service changes nothing.`

const checkMs = 5000

const tailnetChecks = 12

const serviceStartMs = 15_000

const logBytes = 1_048_576

const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

export async function run(argv: string[]): Promise<number> {
  const [mod, ...rest] = argv
  const separator = rest.indexOf('--')
  const [executable, ...args] = separator === -1 ? [] : rest.slice(separator + 1)
  if (mod === undefined || executable === undefined) throw new Error(`cmod program takes a mod's name, --, and the program's command.\n\n${help}`)
  const { values } = parseArgs({
    args: rest.slice(0, separator),
    options: {
      'no-wait': { type: 'boolean', default: false },
      service: { type: 'boolean', default: false },
      env: { type: 'string', multiple: true, default: [] },
      'remove-service': { type: 'boolean', default: false },
      'web-app': { type: 'boolean', default: false },
      provides: { type: 'string', multiple: true, default: [] },
      'process-type': { type: 'string' },
    },
  })
  const unnamed = values.provides.find((name) => !interfaceName.test(name))
  if (unnamed !== undefined) throw new Error(`cmod program --provides takes an interface name, <mod>/<Name>, such as cmod/Sessions, not ${unnamed}.`)
  const processType = values['process-type']
  if (processType !== undefined && !(processTypes as readonly string[]).includes(processType)) throw new Error(`cmod program --process-type takes ${processTypes.join(' or ')}, not ${processType}.`)
  if (processType !== undefined && !values.service) throw new Error('cmod program --process-type names the launchd class of a service, so it goes with --service.')
  const holderFlags = [...(values['web-app'] ? ['--web-app'] : []), ...values.provides.flatMap((name) => ['--provides', name])]
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
      const service = await startService(mod, [executable, ...args], values.env, holderFlags, processType as ProcessType | undefined)
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
  if (values['no-wait'] && (await serviceNames(mod)).includes(basename(executable))) {
    await touchHolders(lockPath)
    process.stdout.write('held\n')
    return 0
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
          return await hold(mod, file, serviceLogPath(storeFolder(process.env), mod, basename(executable)), executable, args, { isWebApp: values['web-app'], provides: values.provides }, ending.signal)
        } finally {
          await lock[Symbol.asyncDispose]()
        }
      }
      if (isNoWait) {
        await touchHolders(lockPath)
        process.stdout.write('held\n')
        return 0
      }
      const address = ((await readJson(file)) as ProgramInstance | undefined)?.address
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

async function hold(mod: string, file: string, log: string, executable: string, args: readonly string[], { isWebApp, provides }: { readonly isWebApp: boolean; readonly provides: readonly string[] }, ending: AbortSignal): Promise<number> {
  const left = (await readJson(file)) as ProgramInstance | undefined
  if (left !== undefined) await stopCopy(left.pid, left.started)
  await rm(file, { force: true })
  await trimLog(log)
  const tailnet = isWebApp ? await readTailnet().catch((error: unknown) => ({ reason: messageOf(error) })) : undefined
  const linked = join(programsFolder(), executable)
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'CLAUDE_CODE_SESSION_ID')), CMOD_MOD: mod, CMOD_PROGRAM: basename(executable), ...folderEnvironment(mod), ...(tailnet === undefined ? {} : tailnetEnvironment(tailnet)) }
  const child = spawn([existsSync(linked) ? linked : executable, ...args], { env, stdout: 'pipe', stderr: 'inherit' })
  const stopping = () => {
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), killMs).unref()
  }
  ending.addEventListener('abort', stopping)
  if (ending.aborted) stopping()
  let ticks = 0
  const ticking = setInterval(() => {
    ticks += 1
    void touchHolders(`${file}.lock`)
    if (tailnet !== undefined) {
      hasTailnetChanged(tailnet, ticks % tailnetChecks === 0).then(
        (isChanged) => isChanged && stopping(),
        (error: unknown) => void process.stderr.write(`cmod program: could not check whether ${executable} belongs on your tailnet: ${messageOf(error)}\n`),
      )
    }
  }, checkMs)
  const asking = new AbortController()
  let provided: Promise<void> = Promise.resolve()
  try {
    const started = await startTime(child.pid)
    let recorded: Promise<void> = Promise.resolve()
    const record = (instance: ProgramInstance) => (recorded = recorded.then(() => writeAtomically(file, `${JSON.stringify(instance)}\n`)))
    provided = isProvidedOnServe(mod, basename(executable), asking.signal)
      .catch((error: unknown) => {
        process.stderr.write(`cmod program: cmod serve did not tell whether ${executable} provides an interface: ${messageOf(error)}\n`)
        return false
      })
      .then(async (isProvided) => {
        if (!isProvided || asking.signal.aborted) return
        await record({ pid: child.pid, started })
        process.stdout.write('provided\n')
      })
    provided.catch(stopping)
    let shown: Promise<void> | undefined
    await readLines(child.stdout, (line) => {
      const address = line.trim()
      asking.abort()
      shown ??= (async () => {
        const tailnetUrl = tailnet === undefined ? undefined : await serveOnTailnet(tailnet, mod, executable, address)
        await record({ address, pid: child.pid, started, ...(tailnetUrl === undefined ? {} : { tailnetUrl }), ...(provides.length === 0 ? {} : { provides }) })
        process.stdout.write(`${address}\n`)
      })()
    })
    await shown
    const code = await child.exited
    asking.abort()
    await provided
    return ending.aborted ? 0 : code
  } catch (error) {
    stopping()
    throw error
  } finally {
    asking.abort()
    await Promise.allSettled([provided])
    clearInterval(ticking)
    ending.removeEventListener('abort', stopping)
    await rm(file, { force: true })
    if (tailnet !== undefined) await stopServing(mod, executable)
  }
}

async function isStartedWithin(file: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  do {
    const instance = (await readJson(file)) as ProgramInstance | undefined
    if (instance !== undefined && (await isHolding(instance.pid, instance.started))) return true
    await Bun.sleep(100)
  } while (Date.now() < deadline)
  for (const holder of await readdir(`${file}.lock`).catch(ifMissing([]))) if (await isHolding(Number(holder), await readText(join(`${file}.lock`, holder)))) return true
  return false
}

async function isProvidedOnServe(mod: string, program: string, signal: AbortSignal): Promise<boolean> {
  const serve = connectServe({ handle: (method) => Promise.reject(new RpcError(rpcCodes.methodNotFound, `cmod program answers no ${method}.`)) })
  try {
    while (!signal.aborted) {
      const isProvided = await serve.request(providerActs.provider, { mod, program }, signal).then(
        () => true,
        (error: unknown) => {
          if (signal.aborted || isConnectionGone(error)) return false
          throw error
        },
      )
      if (isProvided) return true
      await after(checkMs, undefined, { signal }).catch((error: unknown) => {
        if (!signal.aborted) throw error
      })
    }
    return false
  } finally {
    await serve.close()
  }
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
