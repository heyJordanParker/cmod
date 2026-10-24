import { existsSync, watch } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { instancePath, storeFolder } from '@cmodjs/core/src/records.js'
import { readJson, writeAtomically } from '../files.js'
import { readLines, spawn } from '../process.js'
import { programsFolder } from '../program.js'
import { isHolding, startTime, takeLock } from '../store.js'

export const summary = "Run one copy of a mod's program for every session."

export const help = `Usage: cmod program <mod> -- <command…>

${summary}

Each session runs it for a program job with singleInstance. The first one
holds instances/<mod>/<program>.json.lock in the cmod store, runs the command
without CLAUDE_CODE_SESSION_ID, because the copy serves every session, writes the command's first line on standard output, its address, to
instances/<mod>/<program>.json, and prints it. Every other one prints the
address in that file, then each new one, and takes over once the holder exits.
The holder stops the command on SIGTERM, SIGINT, or SIGHUP, and when its parent
process exits, and exits with the command's exit code when the command exits on
its own. A copy an earlier holder left running gets SIGTERM, then SIGKILL after
5 seconds, before the new holder starts its own.`

const checkMs = 5000

const killMs = 5000

const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

type Instance = { readonly address: string; readonly pid: number; readonly started: string }

export async function run(argv: string[]): Promise<number> {
  const [mod, separator, executable, ...args] = argv
  if (mod === undefined || separator !== '--' || executable === undefined) throw new Error(`cmod program takes a mod's name, --, and the program's command.\n\n${help}`)
  const file = instancePath(storeFolder(process.env), mod, basename(executable))
  await mkdir(dirname(file), { recursive: true })
  const ending = new AbortController()
  let wake = () => undefined as void
  const end = () => {
    ending.abort()
    wake()
  }
  const parent = process.ppid
  const parentStarted = await startTime(parent)
  const parentCheck = setInterval(() => {
    void isHolding(parent, parentStarted).then((isRunning) => {
      if (!isRunning) end()
    })
  }, checkMs)
  for (const signal of signals) process.on(signal, end)
  const watcher = watch(dirname(file), (_event, name) => {
    if (name?.endsWith('.tmp') !== true) wake()
  })
  try {
    let printed: string | undefined
    while (!ending.signal.aborted) {
      const lock = await takeLock(`${file}.lock`, AbortSignal.abort())
      if (lock !== undefined) {
        try {
          return await hold(file, executable, args, ending.signal)
        } finally {
          await lock[Symbol.asyncDispose]()
        }
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

async function hold(file: string, executable: string, args: readonly string[], ending: AbortSignal): Promise<number> {
  const left = (await readJson(file)) as Instance | undefined
  if (left !== undefined) await stopCopy(left.pid, left.started)
  await rm(file, { force: true })
  const linked = join(programsFolder(), executable)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'CLAUDE_CODE_SESSION_ID'))
  const child = spawn([existsSync(linked) ? linked : executable, ...args], { env, stdout: 'pipe', stderr: 'inherit' })
  const stopping = () => {
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), killMs).unref()
  }
  ending.addEventListener('abort', stopping)
  if (ending.aborted) stopping()
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
    ending.removeEventListener('abort', stopping)
    await rm(file, { force: true })
  }
}

async function stopCopy(pid: number, started: string): Promise<void> {
  if (!(await isHolding(pid, started))) return
  send(pid, 'SIGTERM')
  const killAt = Date.now() + killMs
  while (await isHolding(pid, started)) {
    if (Date.now() >= killAt) send(pid, 'SIGKILL')
    await Bun.sleep(100)
  }
}

function send(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
