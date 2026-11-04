import { readdir, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isObject, serviceFolder, servicePath, storeFolder } from '@cmodjs/core/src/records.js'
import { formatExit, messageOf } from '@cmodjs/core/src/utils/text.js'
import { home, ifMissing, readJson, readText, writeAtomically } from './files.js'
import { capture, run } from './process.js'
import { programsFolder } from './program.js'

type Service = { readonly label: string; readonly unit: string }

type Manager = {
  unit(label: string): string
  text(mod: string, executable: string, label: string, argv: readonly string[], environment: Readonly<Record<string, string>>): string
  start(label: string, unit: string, isChanged: boolean): Promise<void>
  restart(label: string): Promise<void>
  remove(label: string, unit: string): Promise<void>
  status(label: string): string
}

const passedVariables = ['XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR']

const systemFolders = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

export async function startService(mod: string, command: readonly string[], variables: readonly string[]): Promise<{ readonly label: string; readonly status: string } | undefined> {
  const executable = basename(command[0] ?? '')
  const label = `com.claudemodmanager.${mod}.${executable}`
  const unit = manager.unit(label)
  const record = servicePath(storeFolder(process.env), mod, executable)
  const passed = Object.fromEntries([...passedVariables, ...variables].flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])))
  const environment = { HOME: home(), PATH: [programsFolder(), ...systemFolders].join(':'), ...passed }
  const text = manager.text(mod, executable, label, [join(programsFolder(), 'cmod'), 'program', mod, '--', ...command], environment)
  try {
    await writeAtomically(record, `${JSON.stringify({ label, unit } satisfies Service)}\n`)
    const isChanged = (await readText(unit)) !== text
    if (isChanged) await writeAtomically(unit, text, { mode: 0o600 })
    await manager.start(label, unit, isChanged)
    return { label, status: manager.status(label) }
  } catch (error) {
    await rm(unit, { force: true })
    await removeRecord(record)
    process.stderr.write(`cmod program: ${executable} of ${mod} runs only while a session is open, because this computer did not take it as a service: ${messageOf(error)}\n`)
    return undefined
  }
}

export async function restartServices(mod: string): Promise<string[]> {
  const services = await recordedServices(mod)
  for (const { label } of services) await manager.restart(label)
  return services.map(({ name }) => name)
}

export async function removeService(mod: string, program: string): Promise<void> {
  const record = servicePath(storeFolder(process.env), mod, program)
  const service = await readService(record)
  if (service === undefined) return
  await manager.remove(service.label, service.unit)
  await removeRecord(record)
}

export async function removeServices(mod: string): Promise<void> {
  for (const { label, unit } of await recordedServices(mod)) await manager.remove(label, unit)
  await rm(serviceFolder(storeFolder(process.env), mod), { recursive: true, force: true })
}

export async function serviceNames(mod: string): Promise<string[]> {
  return (await recordedServices(mod)).map(({ name }) => name)
}

async function recordedServices(mod: string): Promise<(Service & { readonly name: string })[]> {
  const folder = serviceFolder(storeFolder(process.env), mod)
  const entries = (await readdir(folder).catch(ifMissing([]))).filter((entry) => entry.endsWith('.json')).sort()
  const services = await Promise.all(entries.map(async (entry) => ({ name: entry.slice(0, -'.json'.length), service: await readService(join(folder, entry)) })))
  return services.flatMap(({ name, service }) => (service === undefined ? [] : [{ name, ...service }]))
}

async function readService(path: string): Promise<Service | undefined> {
  const service = await readJson(path)
  if (service === undefined) return undefined
  if (!isObject(service) || typeof service['label'] !== 'string' || typeof service['unit'] !== 'string') throw new Error(`${path} is not a cmod service record. Delete it, and the mod's next session writes it again.`)
  return { label: service['label'], unit: service['unit'] }
}

async function removeRecord(record: string): Promise<void> {
  await rm(record, { force: true })
  await rmdir(dirname(record)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
  })
}

const domain = () => `gui/${process.getuid?.() ?? 0}`

const bootOutMs = 10_000

async function isLoadedInLaunchd(label: string): Promise<boolean> {
  return (await capture(['launchctl', 'print', `${domain()}/${label}`])).exitCode === 0
}

async function bootOut(label: string): Promise<void> {
  const { exitCode, stderr } = await capture(['launchctl', 'bootout', `${domain()}/${label}`])
  const deadline = Date.now() + bootOutMs
  while (await isLoadedInLaunchd(label)) {
    if (Date.now() >= deadline) throw new Error(`launchctl bootout ${domain()}/${label} ${formatExit(exitCode, stderr)}, and launchd still runs the service ${bootOutMs / 1000} seconds later.`)
    await Bun.sleep(100)
  }
}

const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const launchd: Manager = {
  unit: (label) => join(home(), 'Library', 'LaunchAgents', `${label}.plist`),
  text: (_mod, _executable, label, argv, environment) =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      `  <string>${xml(label)}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      ...argv.map((each) => `    <string>${xml(each)}</string>`),
      '  </array>',
      '  <key>EnvironmentVariables</key>',
      '  <dict>',
      ...Object.entries(environment).flatMap(([name, value]) => [`    <key>${xml(name)}</key>`, `    <string>${xml(value)}</string>`]),
      '  </dict>',
      '  <key>RunAtLoad</key>',
      '  <true/>',
      '  <key>KeepAlive</key>',
      '  <true/>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  async start(label, unit, isChanged) {
    const isLoaded = await isLoadedInLaunchd(label)
    if (isLoaded && !isChanged) return
    if (isLoaded) await bootOut(label)
    await run(['launchctl', 'bootstrap', domain(), unit])
  },
  async restart(label) {
    await run(['launchctl', 'kickstart', '-k', `${domain()}/${label}`])
  },
  async remove(label, unit) {
    await bootOut(label)
    await rm(unit, { force: true })
  },
  status: (label) => `launchctl print ${domain()}/${label}`,
}

const quoted = (text: string) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('%', '%%')}"`

const systemd: Manager = {
  unit: (label) => join(process.env['XDG_CONFIG_HOME'] || join(home(), '.config'), 'systemd', 'user', `${label}.service`),
  text: (mod, executable, _label, argv, environment) =>
    [
      '[Unit]',
      `Description=${executable} of the ${mod} mod, which cmod runs`,
      '',
      '[Service]',
      `ExecStart=${argv.map((each) => quoted(each).replaceAll('$', '$$')).join(' ')}`,
      ...Object.entries(environment).map(([name, value]) => `Environment=${quoted(`${name}=${value}`)}`),
      'Restart=always',
      'RestartSec=10',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'),
  async start(label, _unit, isChanged) {
    if (!isChanged) {
      await run(['systemctl', '--user', 'start', `${label}.service`])
      return
    }
    await run(['systemctl', '--user', 'daemon-reload'])
    await run(['systemctl', '--user', 'enable', `${label}.service`])
    await run(['systemctl', '--user', 'restart', `${label}.service`])
  },
  async restart(label) {
    await run(['systemctl', '--user', 'restart', `${label}.service`])
  },
  async remove(label, unit) {
    await run(['systemctl', '--user', 'disable', '--now', `${label}.service`])
    await rm(unit, { force: true })
    await run(['systemctl', '--user', 'daemon-reload'])
  },
  status: (label) => `journalctl --user -u ${label}.service`,
}

const manager = process.platform === 'darwin' ? launchd : systemd
