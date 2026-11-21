import type { InterfaceName, InterfaceProvider, Job } from '../mod.js'
import { instancePath, processTypes, type ProcessType } from '../records.js'
import { cmodPluginName, isUnanswered } from '../runtime/dependencies.js'
import { engineOf } from '../runtime/engine.js'
import { interfaceMethods, type ProviderIdentity } from '../runtime/interfaces.js'
import { cmodStore, isHeld } from '../runtime/programs.js'
import { ifMissing } from '../utils/paths.js'
import { messageOf } from '../utils/text.js'
import { basename } from '../vendor.js'

export type Program = {
  readonly state: 'stopped' | 'starting' | 'running' | 'backoff' | 'fatal'
  ready(): Promise<{ url: string; socketPath?: string; tailnetUrl?: string }>
  provider<Name extends InterfaceName>(name: Name): Promise<InterfaceProvider<Name>>
}

type Address = Awaited<ReturnType<Program['ready']>>

const backoffSeconds = [1, 2, 4, 8, 16] as const

const leaseCheckMs = 5000

const staleMs = 15_000

const retryWithinMs = 1000

export function program(options: {
  readonly command: readonly string[]
  readonly environment?: Record<string, string>
  readonly singleInstance?: boolean
  readonly isService?: boolean
  readonly isWebApp?: boolean
  readonly processType?: ProcessType
}): Job<Program> {
  const { command, environment, singleInstance = false, isService = false, isWebApp = false, processType } = options
  return ({ mod, announce, reserveName }) => {
    const { claude, report, spawnCmod, isInstalledCopy, watches, interfaces } = engineOf(mod)
    const [executable] = command
    if (executable === undefined) throw new Error(`${mod.name}: the program has no command. Name the program on PATH and its arguments, such as ['preview-server', '--port', '0'].`)
    if (isService) for (const type of ['program', 'service']) reserveName(type, basename(executable), `${mod.name}: the service ${executable} is already added. Give each isService program its own executable.`)
    else if (singleInstance) reserveName('program', basename(executable), `${mod.name}: the single instance of ${executable} is already added. Give each singleInstance program its own executable.`)
    const isElected = singleInstance || isService
    if (isWebApp && !isElected) throw new Error(`${mod.name}: the web app ${executable} runs a copy per session, and your tailnet reaches one copy per computer. Add singleInstance: true or isService: true.`)
    if (processType !== undefined && !(processTypes as readonly string[]).includes(processType)) throw new Error(`${mod.name}: ${executable}'s processType is ${String(processType)}. Give ${processTypes.join(' or ')}.`)
    if (processType !== undefined && !isService) throw new Error(`${mod.name}: ${executable}'s processType names the launchd class of a service. Add isService: true.`)
    const holderFlags = isWebApp ? ['--web-app'] : []
    const serviceClass = processType === undefined ? [] : ['--process-type', processType]
    const request = { argv: command, env: { CMOD_DATA: mod.dataFolder, CMOD_CACHE: mod.cacheFolder, ...environment } }
    let state: Program['state'] = 'stopped'
    let address: Address | undefined
    let failure: Error | undefined
    let exits = 0
    const waiting: { resolve: (address: Address) => void; reject: (error: Error) => void }[] = []
    const failing = new Set<(error: Error) => void>()
    let isFollowing = false
    let isWatching = false
    let instance: Promise<string> | undefined
    let leaseCheck: Promise<void> | undefined

    const spawn = (isOwnService: boolean) => {
      if (isOwnService) return spawnCmod(['program', mod.name, ...holderFlags, '--service', ...serviceClass, ...Object.keys(environment ?? {}).flatMap((name) => ['--env', name]), '--', ...command], environment)
      return isElected ? spawnCmod(['program', mod.name, ...holderFlags, '--no-wait', '--', ...command], environment) : claude.process.spawn(request)
    }

    const instanceFile = () =>
      (instance ??= cmodStore(claude).then((store) => instancePath(store, mod.name, basename(executable))))

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
      report({ id: `program:${executable}`, message: `The ${executable} program stopped`, description: reason, retry })
      for (const waiter of waiting.splice(0)) waiter.reject(failure)
      for (const fail of failing) fail(failure)
      failing.clear()
    }

    const ownProvider = async (name: string) => {
      const found = (await claude.cmod.call({ to: cmodPluginName, method: interfaceMethods.provider, input: { interface: name, mod: mod.name, program: basename(executable) } })) as ProviderIdentity | null
      if (found === null) return undefined
      return (await interfaces.providers(name)).find((each) => each['mod'] === found.mod && each['program'] === found.program && (each['device'] as ProviderIdentity['device'])?.id === found.device?.id)
    }

    const providedHere = async (name: string): Promise<unknown> => {
      while (state !== 'fatal') {
        const own = await ownProvider(name).catch((error: unknown) => {
          if (isUnanswered(error)) return undefined
          throw error
        })
        if (own !== undefined) return own
      }
      throw failure
    }

    const recordedInstance = async (file: string): Promise<{ readonly address?: Address } | undefined> => {
      const recorded = await claude.fs.read(file).catch(ifMissing(undefined))
      if (recorded === undefined) return undefined
      const instance = JSON.parse(recorded) as { readonly address?: unknown; readonly tailnetUrl?: unknown }
      const next = typeof instance.address === 'string' ? addressOf(instance.address.trim()) : undefined
      if (next === undefined) return {}
      return { address: typeof instance.tailnetUrl === 'string' ? { ...next, tailnetUrl: instance.tailnetUrl } : next }
    }

    const show = (next: Address) => {
      address = next
      state = 'running'
      exits = 0
      for (const waiter of waiting.splice(0)) waiter.resolve(next)
    }

    const noAddress = () => new Error(`${mod.name}: the ${executable} program printed no address, because it only provides interfaces. Reach them through provider(name).`)

    const started = () => {
      if (state !== 'starting') return
      state = 'running'
      exits = 0
      for (const waiter of waiting.splice(0)) waiter.reject(noAddress())
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
      const instance = await recordedInstance(file)
      if (instance?.address !== undefined) return show(instance.address)
      if (instance !== undefined) return started()
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
        const isOwnService = isService && (await isInstalledCopy())
        if (isElected && !isOwnService) {
          const file = await instanceFile()
          if (await isHeld(claude, `${file}.lock`, staleMs)) return await follow(file)
        }
        for await (const piece of spawn(isOwnService)) {
          if (piece.stream === 'stderr') {
            lastError = piece.text.trim().split('\n').at(-1) ?? lastError
            continue
          }
          if (isShown) continue
          const lines = `${pending}${piece.text}`.split('\n')
          pending = lines.pop() ?? ''
          for (const line of lines.slice(0, 1)) {
            if (isElected && line.trim() === 'held') return await follow(await instanceFile())
            isShown = true
            const next = addressOf(line.trim())
            if (isElected && line.trim() === 'provided') started()
            else if (next === undefined) {
              stop(`its first line is "${line.trim()}". Write 127.0.0.1:<port> or unix:<socket path> as the first line on standard output.`)
              return
            } else show(isWebApp ? ((await recordedInstance(await instanceFile()))?.address ?? next) : next)
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

    const answer = (): Promise<Address> => {
      if (state === 'running') return address === undefined ? Promise.reject(noAddress()) : Promise.resolve(address)
      if (state === 'fatal') return Promise.reject(failure)
      if (state === 'stopped') void start()
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }))
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
        return state === 'running' && isFollowing ? instanceFile().then(track).then(answer) : answer()
      },
      provider<Name extends InterfaceName>(name: Name) {
        if (!isElected) return Promise.reject(new Error(`${mod.name}: provider(${name}) needs the ${executable} program to run as singleInstance or isService, because only one copy of a program can provide an interface.`))
        if (state === 'fatal') return Promise.reject(failure)
        if (state === 'stopped') void start()
        return new Promise<InterfaceProvider<Name>>((resolve, reject) => {
          failing.add(reject)
          void providedHere(name)
            .then((own) => resolve(own as InterfaceProvider<Name>), reject)
            .finally(() => failing.delete(reject))
        })
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
