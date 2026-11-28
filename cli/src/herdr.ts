import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isObject } from '@cmodjs/core/src/records.js'
import type { SessionTerminals } from '@cmodjs/core/src/runtime/interfaces.js'
import { RpcError, rpcCodes } from '@cmodjs/core/src/runtime/rpc.js'
import { runningEntries } from './history.js'
import { capture } from './process.js'
import mainJs from '../../herdr/cmod/main.js' with { type: 'text' }
import modJson from '../../herdr/cmod/mod.json' with { type: 'json' }
import panelJs from '../../herdr/cmod/panel.js' with { type: 'text' }
import { home, ifMissing, readJson, readText, writeAtomically } from './files.js'
import { storePath, takeLock } from './store.js'

const carried: Readonly<Record<string, string>> = { 'main.js': mainJs, 'panel.js': panelJs, 'mod.json': `${JSON.stringify(modJson)}\n` }

const writtenWhileRunning: readonly string[] = ['gpui-kit.d.ts', 'jsconfig.json', '.drawn']

type Placed = Record<string, Record<string, string>>

function herdrHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env['HERDR_APP_HOME'] || join(env['XDG_CONFIG_HOME'] || join(home(), '.config'), 'herdr-app')
}

export async function placeHerdrMod(): Promise<void> {
  const appHome = herdrHome()
  if (!existsSync(appHome)) return
  const folder = join(appHome, 'mods', 'cmod')
  await withPlaced(async (placed) => {
    const mine = placed[folder] ?? {}
    const found = Object.fromEntries(await Promise.all(Object.keys({ ...carried, ...mine }).map(async (name) => [name, await readText(join(folder, name))] as const)))
    const others = Object.keys(carried).filter((name) => found[name] !== undefined && found[name] !== carried[name] && hashOf(found[name]) !== mine[name])
    if (others.length > 0) throw new Error(`${others.map((name) => join(folder, name)).join(' and ')} ${others.length === 1 ? 'is' : 'are'} not the cmod Herdr mod cmod placed, so cmod leaves ${others.length === 1 ? 'it' : 'them'} and places no Herdr mod. Move ${folder} away, then start cmod serve again.`)
    for (const [name, text] of Object.entries(carried)) {
      if (found[name] !== text) await writeAtomically(join(folder, name), text)
      mine[name] = hashOf(text)
    }
    for (const name of Object.keys(mine).filter((each) => !Object.hasOwn(carried, each))) {
      if (found[name] !== undefined && hashOf(found[name]) === mine[name]) await rm(join(folder, name))
      delete mine[name]
    }
    placed[folder] = mine
  })
}

export async function removeHerdrMod(): Promise<void> {
  await withPlaced(async (placed) => {
    for (const [folder, files] of Object.entries(placed)) {
      for (const [name, hash] of Object.entries(files)) {
        const found = await readText(join(folder, name))
        if (found !== undefined && hashOf(found) === hash) await rm(join(folder, name))
      }
      const left = await readdir(folder).catch(ifMissing([]))
      if (left.every((name) => writtenWhileRunning.includes(name))) await rm(folder, { recursive: true, force: true })
      delete placed[folder]
    }
  })
}

const herdrCallMs = 10_000

const namedKeys: Readonly<Record<string, string>> = { '\r': 'enter', '\n': 'enter', '\t': 'tab', '\x1b': 'esc', '\x7f': 'backspace', ' ': 'space', '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left' }

export function keyNamesOf(typed: string): string[] {
  const keys: string[] = []
  for (let at = 0; at < typed.length; ) {
    const arrow = typed.slice(at, at + 3)
    const key = namedKeys[arrow] !== undefined && arrow.length === 3 ? arrow : String.fromCodePoint(typed.codePointAt(at) ?? 0)
    at += key.length
    keys.push(namedKeys[key] ?? (key < ' ' ? `ctrl+${String.fromCharCode(key.charCodeAt(0) + 96)}` : key === key.toLowerCase() ? key : `shift+${key.toLowerCase()}`))
  }
  return keys
}

type CoreTerminal = { readonly address: string; readonly pid?: number | null; readonly foreground?: { readonly pid?: number | null } | null }

function installed(program: string): string | undefined {
  return Bun.which(program, { PATH: `${process.env['PATH'] ?? ''}:${join(home(), '.local', 'bin')}` }) ?? undefined
}

async function herdrCore<Result>(method: string, params: Readonly<Record<string, unknown>>): Promise<Result> {
  const hc = installed('hc')
  if (hc === undefined) throw new Error('herdr-core is not installed on this computer.')
  const child = Bun.spawn([hc, 'connect'], { stdin: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`), stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), herdrCallMs)
  try {
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const line = stdout.split('\n').find((each) => each.includes('"id":1'))
    if (line === undefined) throw new Error(`herdr-core did not answer ${method}${child.signalCode === null ? `: ${(stderr || stdout).trim()}` : ` within ${herdrCallMs / 1000} s`}.`)
    const answer = JSON.parse(line) as { readonly result?: Result; readonly error?: { readonly message: string } }
    if (answer.error !== undefined) throw new Error(`herdr-core's ${method}: ${answer.error.message}`)
    return answer.result as Result
  } finally {
    clearTimeout(timer)
  }
}

export async function terminalRunning(session: string): Promise<string | undefined> {
  const pid = runningEntries().find((entry) => entry.session === session)?.pid
  const listed = pid === undefined || installed('hc') === undefined ? [] : (await herdrCore<{ readonly terminals: readonly CoreTerminal[] }>('terminal.list', {})).terminals
  return listed.find((terminal) => !terminal.address.includes('/') && (terminal.pid === pid || terminal.foreground?.pid === pid))?.address
}

async function terminalOf(session: string): Promise<string> {
  const found = await terminalRunning(session)
  if (found === undefined) throw new RpcError(rpcCodes.notHeld, `No session ${session} runs in a herdr-core terminal on this computer.`)
  return found
}

export async function runAsSubagent(parent: string, argv: readonly string[], cwd: string): Promise<string> {
  const hc = installed('hc')
  if (hc === undefined) throw new Error('herdr-core is not installed on this computer.')
  const { exitCode, stdout, stderr } = await capture([hc, 'run', '--bg', '--json', '--parent', parent, '--no-notify', '--outlive-parent', '--cwd', cwd, '--', ...argv])
  const started: unknown = exitCode === 0 ? JSON.parse(stdout) : undefined
  if (!isObject(started) || typeof started['address'] !== 'string') throw new Error(`hc run exited ${exitCode}: ${(stderr || stdout).trim()}`)
  return started['address']
}

async function herdrApp(...args: string[]): Promise<string> {
  const app = installed('herdr-app')
  if (app === undefined) throw new Error('The Herdr app is not installed on this computer, so no Herdr window shows the session.')
  const { exitCode, stdout, stderr } = await capture([app, ...args])
  if (exitCode !== 0) throw new Error(`herdr-app ${args.join(' ')} exited ${exitCode}: ${(stderr || stdout).trim()}`)
  return stdout
}

export const herdrTerminals: SessionTerminals = {
  screen: async (session) => (await herdrCore<{ readonly text: string }>('terminal.read', { terminal: await terminalOf(session) })).text,
  press: async (session, keys) => void (await herdrCore('terminal.keys', { terminal: await terminalOf(session), keys: keyNamesOf(keys) })),
  async show(session, place) {
    const terminal = await terminalOf(session)
    const say = (command: string, args: Readonly<Record<string, unknown>>) => herdrApp('do', command, JSON.stringify(args))
    const shown = JSON.parse(await herdrApp('ls')) as { readonly spaces: readonly { readonly tabs: readonly { readonly terminals: readonly { readonly terminal: string; readonly pane: string | null }[] }[] }[] }
    const pane = shown.spaces.flatMap(({ tabs }) => tabs).flatMap(({ terminals }) => terminals).find((each) => each.terminal === terminal)?.pane ?? null
    if (place === 'peek') return void (await say('terminal.peek', { terminal }))
    if (place === 'hide') return void (pane === null ? undefined : await say('terminal.park', { terminal }))
    if (pane === null) return void (await say('terminal.keep', { terminal, place: place === 'focus' ? 'tab' : place }))
    await say('agent.focus', { terminal })
  },
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function withPlaced(change: (placed: Placed) => Promise<void>): Promise<void> {
  const lock = await takeLock(storePath('herdr.lock'))
  try {
    const parsed = await readJson(storePath('herdr.json'))
    const placed: Placed = isObject(parsed) ? (parsed as Placed) : {}
    const before = JSON.stringify(placed)
    try {
      await change(placed)
    } finally {
      if (JSON.stringify(placed) !== before) await writeAtomically(storePath('herdr.json'), `${JSON.stringify(placed)}\n`)
    }
  } finally {
    await lock[Symbol.asyncDispose]()
  }
}
