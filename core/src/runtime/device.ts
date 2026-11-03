import type { Device } from '../session/context/turn/device.js'
import { ifMissing } from '../utils/paths.js'
import { formatExit } from '../utils/text.js'

const cmodAppId = '1fd8a8ee972047c4a89640fd51048522'

const sha256Block = 64

const systems: Readonly<Record<string, Device['os']>> = { Darwin: 'darwin', Linux: 'linux' }

const machines: Readonly<Record<string, Device['arch']>> = { arm64: 'arm64', aarch64: 'arm64', x86_64: 'x64', amd64: 'x64' }

const platformUuid = /"IOPlatformUUID" = "([0-9A-Fa-f-]{36})"/

const machineId = /^[0-9a-f]{32}$/

const machineIdFiles = ['/etc/machine-id', '/var/lib/dbus/machine-id'] as const

export class MissingMachineId extends Error {}

export type DeviceSources = {
  readonly process: { run(argv: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> }
  readonly fs: { read(path: string): Promise<string> }
}

export async function readDevice(claude: DeviceSources): Promise<Device> {
  const output = async (argv: readonly string[]) => {
    const { exitCode, stdout, stderr } = await claude.process.run(argv)
    if (exitCode !== 0) throw new Error(`cmod could not read this computer: ${argv.join(' ')} ${formatExit(exitCode, stderr)}`)
    return stdout.trim()
  }
  const [system = '', node = '', machine = ''] = (await output(['uname', '-snm'])).split(/\s+/)
  const os = systems[system]
  const arch = machines[machine]
  if (os === undefined) throw new Error(`cmod reads the device of macOS and Linux, and this computer runs ${system}.`)
  if (arch === undefined) throw new Error(`cmod reads the device of arm64 and x64 computers, and this one is ${machine}.`)
  if (os === 'linux') return { id: await appSpecific(await linuxMachineId(claude.fs)), name: node, os, arch }
  const [platform, name] = await Promise.all([output(['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice']), output(['scutil', '--get', 'LocalHostName'])])
  const uuid = platformUuid.exec(platform)?.[1]
  if (uuid === undefined) throw new Error('cmod could not read this computer: ioreg -rd1 -c IOPlatformExpertDevice names no IOPlatformUUID.')
  return { id: await appSpecific(uuid.replaceAll('-', '').toLowerCase()), name, os, arch }
}

async function linuxMachineId(fs: DeviceSources['fs']): Promise<string> {
  for (const path of machineIdFiles) {
    const id = (await fs.read(path).catch(ifMissing(''))).trim()
    if (machineId.test(id)) return id
  }
  throw new MissingMachineId(`cmod could not read this computer: neither ${machineIdFiles.join(' nor ')} holds a machine id.`)
}

async function appSpecific(machine: string): Promise<string> {
  if (!machineId.test(machine)) throw new Error('cmod could not read this computer: its machine id is not 32 hex digits.')
  const id = (await hmacSha256(bytesOf(machine), bytesOf(cmodAppId))).slice(0, 16)
  id[6] = ((id[6] ?? 0) & 0x0f) | 0x40
  id[8] = ((id[8] ?? 0) & 0x3f) | 0x80
  return [...id].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const sha256 = async (...parts: readonly Uint8Array[]) => new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(parts.flatMap((part) => [...part]))))
  const padded = new Uint8Array(sha256Block)
  padded.set(key)
  return sha256(padded.map((byte) => byte ^ 0x5c), await sha256(padded.map((byte) => byte ^ 0x36), message))
}

function bytesOf(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))
}
