import type { Job } from '../mod.js'
import { instancePath, storeFolder } from '../records.js'
import { engineOf } from '../runtime/engine.js'
import { isHeld } from '../runtime/programs.js'
import { ifMissing } from '../utils/paths.js'
import { messageOf } from '../utils/text.js'
import { basename } from '../vendor.js'

export type Program = {
  readonly state: 'stopped' | 'starting' | 'running' | 'backoff' | 'fatal'
  ready(): Promise<{ url: string; socketPath?: string }>
}

type Address = Awaited<ReturnType<Program['ready']>>

const backoffSeconds = [1, 2, 4, 8, 16] as const

const leaseCheckMs = 5000

const staleMs = 15_000

const retryWithinMs = 1000

export function program(options: { readonly command: readonly string[]; readonly environment?: Record<string, string>; readonly singleInstance?: boolean; readonly isService?: boolean }): Job<Program> {
  const { command, environment, singleInstance = false, isService = false } = options
  return ({ mod, announce, reserveName }) => {
    const { claude, report, spawnCmod, watches } = engineOf(mod)
    const [executable] = command
    if (executable === undefined) throw new Error(`${mod.name}: the program has no command. Name the program on PATH and its arguments, such as ['preview-server', '--port', '0'].`)
    if (isService) reserveName('program', basename(executable), `${mod.name}: the service ${executable} is already added. Give each isService program its own executable.`)
    else if (singleInstance) reserveName('program', basename(executable), `${mod.name}: the single instance of ${executable} is already added. Give each singleInstance program its own executable.`)
    const isElected = singleInstance || isService
    const request = { argv: command, ...(environment === undefined ? {} : { env: environment }) }
    let state: Program['state'] = 'stopped'
    let address: Address | undefined
    let failure: Error | undefined
    let exits = 0
    const waiting: { resolve: (address: Address) => void; reject: (error: Error) => void }[] = []
    let isFollowing = false
    let isWatching = false
    let instance: Promise<string> | undefined
    let leaseCheck: Promise<void> | undefined

    const spawn = () => {
      if (isService) return spawnCmod(['program', mod.name, '--service', ...Object.keys(environment ?? {}).flatMap((name) => ['--env', name]), '--', ...command], environment)
      return singleInstance ? spawnCmod(['program', mod.name, '--no-wait', '--', ...command], environment) : claude.process.spawn(request)
    }

    const instanceFile = () =>
      (instance ??= Promise.all([claude.env.home(), claude.env.dataHome()]).then(([home, dataHome]) => instancePath(storeFolder({ HOME: home, XDG_DATA_HOME: dataHome }), mod.name, basename(executable))))

    const following = (run: Promise<unknown>) => void run.catch((error: unknown) => report({ id: `program:${executable}:follow`, message: `Could not follow the ${executable} program`, error }))

    const stop = (reason: string) => {
      address = undefined
      state = 'fatal'
      failure = new Error(`${mod.name}: the ${executable} program stopped: ${reason}`)
      const retry = () => {
        exits = 0
        failure = undefined
        void start()
      }
      report({ id: `program:${executable}`, message: `The ${executable} program stopped`, description: reason, retry, isCritical: true })
      for (const waiter of waiting.splice(0)) waiter.reject(failure)
    }

    const show = (next: Address) => {
      address = next
      state = 'running'
      exits = 0
      for (const waiter of waiting.splice(0)) waiter.resolve(next)
    }

    const checkLease = (file: string) =>
      (leaseCheck ??= (async () => {
        if (!isFollowing || (await isHeld(claude, `${file}.lock`, staleMs))) return
        isFollowing = false
        void start()
      })().finally(() => {
        leaseCheck = undefined
      }))

    const track = async (file: string) => {
      if (!isFollowing) return
      const recorded = await claude.fs.read(file).catch(ifMissing(undefined))
      const next = recorded === undefined ? undefined : addressOf(String((JSON.parse(recorded) as { readonly address?: unknown }).address).trim())
      if (next !== undefined) return show(next)
      address = undefined
      state = 'starting'
      claude.clock.after(Math.random() * retryWithinMs, () => following(checkLease(file)))
    }

    const follow = async (file: string) => {
      isFollowing = true
      if (!isWatching) {
        isWatching = true
        watches.add([file], () => following(track(file)))
        claude.clock.every(leaseCheckMs, () => following(checkLease(file)))
      }
      await track(file)
    }

    const start = async () => {
      isFollowing = false
      address = undefined
      state = 'starting'
      let pending = ''
      let lastError = ''
      let isShown = false
      try {
        if (singleInstance) {
          const file = await instanceFile()
          if (await isHeld(claude, `${file}.lock`, staleMs)) return await follow(file)
        }
        for await (const piece of await spawn()) {
          if (piece.stream === 'stderr') {
            lastError = piece.text.trim().split('\n').at(-1) ?? lastError
            continue
          }
          if (isShown) continue
          const lines = `${pending}${piece.text}`.split('\n')
          pending = lines.pop() ?? ''
          for (const line of lines.slice(0, 1)) {
            if (isElected && line.trim() === 'held') return await follow(await instanceFile())
            const next = addressOf(line.trim())
            if (next === undefined) {
              stop(`its first line is "${line.trim()}". Write 127.0.0.1:<port> or unix:<socket path> as the first line on standard output.`)
              return
            }
            show(next)
            isShown = true
          }
        }
      } catch (error) {
        lastError = messageOf(error)
      }
      address = undefined
      exits += 1
      const wait = backoffSeconds[exits - 1]
      if (wait === undefined) {
        stop(`it did not start again after ${backoffSeconds.length} tries: ${lastError === '' ? 'no standard error' : lastError}.`)
        return
      }
      state = 'backoff'
      claude.clock.after(wait * 1000, () => void start())
    }

    announce(`the ${executable} program`)
    void claude.session.surfaces().then((surfaces) => {
      if (surfaces.length > 0 && state === 'stopped') void start()
    })

    return {
      get state() {
        return state
      },
      ready() {
        if (state === 'running' && address !== undefined) return Promise.resolve(address)
        if (state === 'fatal') return Promise.reject(failure)
        if (state === 'stopped') void start()
        return new Promise((resolve, reject) => waiting.push({ resolve, reject }))
      },
    }
  }
}

function addressOf(line: string): Address | undefined {
  const tcp = /^127\.0\.0\.1:(\d{1,5})$/.exec(line)
  if (tcp !== null) return { url: `http://127.0.0.1:${tcp[1]}` }
  const unix = /^unix:(\/.+)$/.exec(line)
  if (unix?.[1] !== undefined) return { url: 'http://localhost', socketPath: unix[1] }
  return undefined
}
