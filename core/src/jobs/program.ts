import type { Part } from '../mod.js'
import { messageOf } from '../utils/text.js'

export type Program = {
  readonly state: 'stopped' | 'starting' | 'running' | 'backoff' | 'fatal'
  ready(): Promise<{ url: string; socketPath?: string }>
}

type Address = Awaited<ReturnType<Program['ready']>>

const backoffSeconds = [1, 2, 4, 8, 16] as const

export function program(options: { readonly command: readonly string[]; readonly environment?: Record<string, string> }): Part<Program> {
  const { command, environment } = options
  return ({ mod, claude, announce }) => {
    const [executable] = command
    if (executable === undefined) throw new Error(`${mod.name}: the program has no command. Name the program on PATH and its arguments, such as ['preview-server', '--port', '0'].`)
    let state: Program['state'] = 'stopped'
    let address: Address | undefined
    let failure: Error | undefined
    let exits = 0
    const waiting: { resolve: (address: Address) => void; reject: (error: Error) => void }[] = []

    const stop = (reason: string) => {
      state = 'fatal'
      failure = new Error(`${mod.name}: the ${executable} program stopped: ${reason}`)
      claude.ui.log(failure.message)
      for (const waiter of waiting.splice(0)) waiter.reject(failure)
    }

    const start = async () => {
      state = 'starting'
      let stdout = ''
      let lastError = ''
      try {
        for await (const piece of claude.process.spawn({ argv: command, ...(environment === undefined ? {} : { env: environment }) })) {
          if (piece.stream === 'stderr') {
            lastError = piece.text.trim().split('\n').at(-1) ?? lastError
            continue
          }
          if (state !== 'starting') continue
          stdout += piece.text
          const end = stdout.indexOf('\n')
          if (end < 0) continue
          const first = stdout.slice(0, end).trim()
          address = addressOf(first)
          if (address === undefined) {
            stop(`its first line is "${first}". Write 127.0.0.1:<port> or unix:<socket path> as the first line on standard output.`)
            return
          }
          state = 'running'
          exits = 0
          for (const waiter of waiting.splice(0)) waiter.resolve(address)
        }
      } catch (error) {
        lastError = messageOf(error)
      }
      address = undefined
      exits += 1
      const wait = backoffSeconds[exits - 1]
      if (wait === undefined) {
        stop(`it did not start again after ${backoffSeconds.length} tries: ${lastError === '' ? 'no standard error' : lastError}. Fix it, then run /reload-plugins.`)
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
