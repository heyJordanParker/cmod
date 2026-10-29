import type { Job } from '../mod.js'
import { engineOf } from '../runtime/engine.js'
import { messageOf } from '../utils/text.js'
import { basename } from '../vendor.js'

export type Program = {
  readonly state: 'stopped' | 'starting' | 'running' | 'backoff' | 'fatal'
  ready(): Promise<{ url: string; socketPath?: string }>
}

type Address = Awaited<ReturnType<Program['ready']>>

const backoffSeconds = [1, 2, 4, 8, 16] as const

export function program(options: { readonly command: readonly string[]; readonly environment?: Record<string, string>; readonly singleInstance?: boolean }): Job<Program> {
  const { command, environment, singleInstance = false } = options
  return ({ mod, announce, reserveName }) => {
    const { claude, report, spawnCmod } = engineOf(mod)
    const [executable] = command
    if (executable === undefined) throw new Error(`${mod.name}: the program has no command. Name the program on PATH and its arguments, such as ['preview-server', '--port', '0'].`)
    if (singleInstance) reserveName('program', basename(executable), `${mod.name}: the single instance of ${executable} is already added. Give each singleInstance program its own executable.`)
    const request = { argv: command, ...(environment === undefined ? {} : { env: environment }) }
    let state: Program['state'] = 'stopped'
    let address: Address | undefined
    let failure: Error | undefined
    let exits = 0
    const waiting: { resolve: (address: Address) => void; reject: (error: Error) => void }[] = []

    const spawn = () => (singleInstance ? spawnCmod(['program', mod.name, '--', ...command], environment) : claude.process.spawn(request))

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

    const start = async () => {
      state = 'starting'
      let pending = ''
      let lastError = ''
      try {
        for await (const piece of await spawn()) {
          if (piece.stream === 'stderr') {
            lastError = piece.text.trim().split('\n').at(-1) ?? lastError
            continue
          }
          if (address !== undefined && !singleInstance) continue
          const lines = `${pending}${piece.text}`.split('\n')
          pending = lines.pop() ?? ''
          for (const line of singleInstance ? lines : lines.slice(0, 1)) {
            const next = addressOf(line.trim())
            if (next === undefined) {
              stop(`its first line is "${line.trim()}". Write 127.0.0.1:<port> or unix:<socket path> as the first line on standard output.`)
              return
            }
            show(next)
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
