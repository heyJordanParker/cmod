import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isObject, parsePreferences, parseTailnetRecord, preferencesPath, storeFolder, tailnetFolder, tailnetPath, type TailnetRecord } from '@cmodjs/core/src/records.js'
import { formatExit, messageOf } from '@cmodjs/core/src/utils/text.js'
import { ifMissing, readJson, writeAtomically } from './files.js'
import { capture } from './process.js'

export type Tailnet = { readonly command: string; readonly name: string; readonly login: string }

export type TailnetState = Tailnet | { readonly reason: string }

const appCommand = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

const withinAMinute = 'and cmod puts the web app on your tailnet within a minute.'

export const offReason = 'Off in Settings, under cmod, Preferences.'

export async function isServingTailnet(): Promise<boolean> {
  const path = preferencesPath(storeFolder(process.env))
  return parsePreferences(await readJson(path), path).servesTailnet
}

function tailscaleCommand(): string | undefined {
  return Bun.which('tailscale', { PATH: process.env['PATH'] ?? '' }) ?? (existsSync(appCommand) ? appCommand : undefined)
}

export async function readTailnet(): Promise<TailnetState> {
  if (!(await isServingTailnet())) return { reason: offReason }
  const command = tailscaleCommand()
  if (command === undefined) return { reason: `Tailscale is not installed. Install it from tailscale.com and sign in, ${withinAMinute}` }
  const { exitCode, stdout, stderr } = await capture([command, 'status', '--json'])
  if (exitCode !== 0) return { reason: `tailscale status ${formatExit(exitCode, stderr.trim().split('\n').at(-1) ?? '')}. Start Tailscale and sign in, ${withinAMinute}` }
  const status: unknown = JSON.parse(stdout)
  const self = isObject(status) && isObject(status['Self']) ? status['Self'] : {}
  const users = isObject(status) && isObject(status['User']) ? status['User'] : {}
  const user = users[String(self['UserID'])]
  const name = typeof self['DNSName'] === 'string' ? self['DNSName'].replace(/\.$/, '') : ''
  const login = isObject(user) && typeof user['LoginName'] === 'string' ? user['LoginName'] : ''
  if (!isObject(status) || status['BackendState'] !== 'Running' || name === '') return { reason: `Tailscale is not signed in on this computer. Sign in, ${withinAMinute}` }
  if (!Array.isArray(status['CertDomains']) || !status['CertDomains'].includes(name)) return { reason: `HTTPS is off on your tailnet. Turn on HTTPS Certificates on the DNS page of the Tailscale admin console, ${withinAMinute}` }
  if (login === '') return { reason: 'This computer is tagged in Tailscale, so it has no login a web app can check requests against.' }
  return { command, name, login }
}

export async function hasTailnetChanged(started: TailnetState, isDueForTailscale: boolean): Promise<boolean> {
  const wasOn = !('reason' in started && started.reason === offReason)
  const isOn = await isServingTailnet()
  if (isOn !== wasOn) return true
  return isOn && 'reason' in started && isDueForTailscale && !('reason' in (await readTailnet().catch((error: unknown) => ({ reason: messageOf(error) }))))
}

export function tailnetEnvironment(tailnet: TailnetState): Record<string, string> {
  return 'reason' in tailnet ? {} : { CMOD_TAILNET_NAME: tailnet.name, CMOD_TAILNET_LOGIN: tailnet.login }
}

export async function serveOnTailnet(tailnet: TailnetState, mod: string, executable: string, address: string): Promise<string | undefined> {
  const path = tailnetPath(storeFolder(process.env), mod, executable)
  const saved = parseTailnetRecord(await readJson(path), path)
  const mapped = await mapOnTailnet(tailnet, executable, address, saved?.port ?? null)
  await writeAtomically(path, `${JSON.stringify(mapped, null, 2)}\n`)
  return mapped.url ?? undefined
}

async function mapOnTailnet(tailnet: TailnetState, executable: string, address: string, savedPort: number | null): Promise<TailnetRecord> {
  if ('reason' in tailnet) return { port: savedPort, url: null, reason: tailnet.reason }
  const local = /^127\.0\.0\.1:(\d{1,5})$/.exec(address)?.[1]
  if (local === undefined) return { port: savedPort, url: null, reason: `${executable} listens on ${address}, and Tailscale serves only a TCP port.` }
  const port = savedPort ?? Number(local)
  if (savedPort === null && (await isServed(tailnet, port))) return { port: null, url: null, reason: `Port ${port} of ${tailnet.name} already serves something else on your tailnet.` }
  const served = await capture([tailnet.command, 'serve', '--bg', `--https=${port}`, `http://127.0.0.1:${local}`])
  if (served.exitCode !== 0) return { port, url: null, reason: `tailscale serve ${formatExit(served.exitCode, served.stderr.trim().split('\n').at(-1) ?? '')}.` }
  return { port, url: `https://${tailnet.name}:${port}/`, reason: null }
}

export async function stopServing(mod: string, executable: string): Promise<void> {
  const path = tailnetPath(storeFolder(process.env), mod, executable)
  const saved = parseTailnetRecord(await readJson(path), path)
  if (saved?.url == null || saved.port === null) return
  await unmap(saved.port)
  await writeAtomically(path, `${JSON.stringify({ port: saved.port, url: null, reason: null } satisfies TailnetRecord, null, 2)}\n`)
}

export async function removeTailnet(mod: string): Promise<void> {
  const folder = tailnetFolder(storeFolder(process.env), mod)
  for (const entry of (await readdir(folder).catch(ifMissing([]))).filter((each) => each.endsWith('.json'))) {
    const path = join(folder, entry)
    const record = parseTailnetRecord(await readJson(path), path)
    if (record?.url != null && record.port !== null) await unmap(record.port)
  }
  await rm(folder, { recursive: true, force: true })
}

async function unmap(port: number): Promise<void> {
  const command = tailscaleCommand()
  if (command === undefined) return
  const { exitCode, stderr } = await capture([command, 'serve', `--https=${port}`, 'off'])
  if (exitCode !== 0) process.stderr.write(`cmod: tailscale serve --https=${port} off ${formatExit(exitCode, stderr.trim().split('\n').at(-1) ?? '')}\n`)
}

async function isServed(tailnet: Tailnet, port: number): Promise<boolean> {
  const { exitCode, stdout } = await capture([tailnet.command, 'serve', 'status', '--json'])
  if (exitCode !== 0 || stdout.trim() === '') return false
  const config: unknown = JSON.parse(stdout)
  const tcp = isObject(config) && isObject(config['TCP']) ? config['TCP'] : {}
  return String(port) in tcp
}
