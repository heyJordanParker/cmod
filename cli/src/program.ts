import { existsSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readlink, rename, rm, stat, symlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { dataFolder, isObject, pluginName, storeFolder, type InstallRecord, type RunnerEvent } from '@cmodjs/core/src/records.js'
import { formatExit, messageOf } from '@cmodjs/core/src/utils/text.js'
import { home, readJson, readText, tilde } from './files.js'
import type { Plugin } from './plugin.js'
import { capture, runStep } from './process.js'
import type { Progress } from './progress.js'
import { storePath } from './store.js'

export type Program = { name: string; folder: string; build: string; output: string }

export const programSteps = 3

export const machine = `${process.platform}-${process.arch}`

export const machines: readonly string[] = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']

const systemNames: Readonly<Record<string, string>> = { darwin: 'macOS', linux: 'Linux' }

export function declaredMachines(packageJson: Record<string, unknown> | undefined): string[] {
  return machines.filter((each) => {
    const [system, cpu] = each.split('-') as [string, string]
    return allows(packageJson?.['os'], system) && allows(packageJson?.['cpu'], cpu)
  })
}

export function unsupportedSystems(packageJson: Record<string, unknown> | undefined): string[] {
  const listed = (key: string) => (Array.isArray(packageJson?.[key]) ? (packageJson[key] as unknown[]) : []).map((entry) => String(entry).replace(/^!/, ''))
  const systems = new Set(machines.map((each) => each.split('-')[0]))
  const cpus = new Set(machines.map((each) => each.split('-')[1]))
  return [...listed('os').filter((system) => !systems.has(system)), ...listed('cpu').filter((cpu) => !cpus.has(cpu))]
}

export function machineWords(listed: readonly string[]): string {
  const systems = [...new Set(listed.map((each) => each.split('-')[0] as string))]
  const cpus = [...new Set(listed.map((each) => each.split('-')[1] as string))]
  const isEveryCpu = cpus.length === new Set(machines.map((each) => each.split('-')[1])).size
  return `${systems.map((system) => systemNames[system] ?? system).join(' and ')}${isEveryCpu ? '' : ` on ${cpus.join(' and ')}`}`
}

export function refuseThisMachine(plugin: Plugin): void {
  const declared = declaredMachines(plugin.packageJson)
  if (declared.includes(machine)) return
  const system = systemNames[process.platform] ?? process.platform
  const here = declared.some((each) => each.startsWith(`${process.platform}-`)) ? `${system} on ${process.arch}` : system
  throw new Error(`${plugin.name} runs on ${machineWords(declared)}, and this is ${here}, so cmod set up nothing.`)
}

function allows(list: unknown, value: string): boolean {
  if (!Array.isArray(list)) return true
  const entries = list.filter((entry): entry is string => typeof entry === 'string')
  if (entries.includes(`!${value}`)) return false
  const allowed = entries.filter((entry) => !entry.startsWith('!'))
  return allowed.length === 0 || allowed.includes(value)
}

export function releaseDownloads(repository: string): string {
  return `${repository.replace(/\/$/, '')}/releases/download`
}

export async function readProgram(plugin: Plugin): Promise<Program | undefined> {
  const folder = join(plugin.root, 'cli')
  const packageJson = await readJson(join(folder, 'package.json'))
  const cargo = await readText(join(folder, 'Cargo.toml'))
  const cargoManifest = cargo === undefined ? undefined : (Bun.TOML.parse(cargo) as Record<string, unknown>)
  const manifest = isObject(packageJson) ? packageJson : cargoManifest?.['package']
  if (!isObject(manifest)) return undefined
  const metadata = manifest['metadata']
  const declared = isObject(packageJson) ? manifest['cmod'] : isObject(metadata) ? metadata['cmod'] : undefined
  if (declared === undefined) return undefined
  if (!isObject(declared) || typeof declared['build'] !== 'string' || typeof declared['output'] !== 'string') {
    throw new Error(`${tilde(folder)} declares a "cmod" build without "build" and "output". Write "cmod": { "build": "<command>", "output": "<folder>" }.`)
  }
  const bins = isObject(packageJson) ? manifest['bin'] : cargoManifest?.['bin']
  const commands = Array.isArray(bins) ? bins.map((bin: unknown) => (isObject(bin) ? bin['name'] : undefined)) : isObject(bins) ? Object.keys(bins) : []
  const name = commands.length === 1 ? commands[0] : manifest['name']
  if (typeof name !== 'string' || !pluginName.test(name)) throw new Error(`${tilde(folder)} names its program "${String(name)}". The manifest's one "bin" command (one [[bin]] in Cargo.toml), or else its "name", is the command, such as "hello".`)
  return { name, folder, build: declared['build'], output: declared['output'] }
}

export async function buildProgram(program: Program, wanted: readonly string[], progress: Progress): Promise<string[]> {
  const heading = `Building ${program.name}`
  progress.step(heading)
  const startedAt = Math.floor(Date.now() / 1000) * 1000
  const result = await runStep(['sh', '-c', program.build], program.folder, { ...process.env, CMOD_MACHINES: wanted.join(' ') }, (event) => {
    if (event.kind === 'progress') progress.update(heading, event.done, event.total, event.label)
    else progress.log(event.text)
  })
  if (result.exitCode !== 0) {
    progress.fail(`Building ${program.name} with "${program.build}" ${formatExit(result.exitCode, result.lastError)}.`)
    throw new Error(`Fix the build in ${tilde(program.folder)}, then run the command again.`)
  }
  const folder = join(program.folder, program.output)
  const names = machines.map((each) => `${program.name}-${each}`)
  const written: string[] = []
  for (const entry of existsSync(folder) ? (await readdir(folder)).sort() : []) {
    if ((await stat(join(folder, entry))).mtimeMs >= startedAt) written.push(entry)
  }
  const misnamed = written.filter((entry) => !names.includes(entry))
  if (misnamed.length > 0) throw new Error(`The build of ${program.name} wrote ${misnamed.join(', ')}, which no machine downloads. Name each build <program>-<os>-<arch>: ${names.join(', ')}.`)
  const builds = written.filter((entry) => wanted.some((each) => entry === `${program.name}-${each}`)).map((entry) => join(folder, entry))
  if (builds.length === 0) throw new Error(`The build of ${program.name} wrote no ${wanted.map((each) => `${program.name}-${each}`).join(', ')} in ${tilde(folder)}. Point "output" at the folder the build writes, and build each machine CMOD_MACHINES names.`)
  const missing = wanted.filter((each) => !written.includes(`${program.name}-${each}`))
  if (missing.length > 0) throw new Error(`The build of ${program.name} wrote no ${missing.map((each) => `${program.name}-${each}`).join(', ')}, but the mod runs on ${machineWords(wanted)}. Build each machine CMOD_MACHINES names, or list only the machines it builds in the "os" and "cpu" keys of the mod's package.json, such as "os": ["darwin"].`)
  progress.succeed(`Built ${program.name}: ${builds.map((build) => basename(build)).join(', ')}`)
  return builds
}

export async function installProgram(program: Program, version: string, progress: Progress): Promise<void> {
  const built = (await buildProgram(program, [machine], progress))[0] as string

  const target = storePath('bin', program.name, version, program.name)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(built, `${target}.${process.pid}.tmp`)
  await chmod(`${target}.${process.pid}.tmp`, 0o755)
  await rename(`${target}.${process.pid}.tmp`, target)

  const entry = await linkProgram(program.name, target)
  progress.succeed(`Installed ${program.name} ${version}: Claude Code runs ${tilde(join(programsFolder(), program.name))}, which runs ${tilde(target)}`)
  const note = terminalNote(program.name, entry)
  if (note !== undefined) progress.note(note)
  else if (entry !== undefined && !(process.env['PATH'] ?? '').split(':').includes(dirname(entry))) progress.note(`Add ~/.local/bin to PATH to run ${program.name} in a terminal.`)
}

export async function fetchProgram(plugin: Plugin, name: string, emit: (event: RunnerEvent) => void): Promise<void> {
  const target = storePath('bin', name, plugin.version, name)
  if (!existsSync(target)) {
    if (plugin.repository === undefined) throw new Error(`${plugin.root}/.claude-plugin/plugin.json names no "repository", so cmod has no release to download ${name} from. Add "repository": "https://github.com/<owner>/<repo>".`)
    const release = `${releaseDownloads(plugin.repository)}/v${plugin.version}`
    const url = `${release}/${name}-${machine}`
    const attach = (file: string) => `Attach ${file} to the v${plugin.version} release, as cmod publish does.`
    emit({ kind: 'progress', done: 0, total: programSteps, label: `Downloading ${name} ${plugin.version}` })
    const sums = new TextDecoder().decode(await download(`${release}/SHA256SUMS`, attach('SHA256SUMS')))
    const expected = sums.split('\n').map((line) => /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim())).find((match) => match?.[2] === basename(url))?.[1]
    if (expected === undefined) throw new Error(`${release}/SHA256SUMS lists no ${basename(url)}, so cmod cannot check the download. Publish the release with cmod publish, which lists every build.`)
    const build = await download(url, attach(basename(url)))
    const actual = new Bun.CryptoHasher('sha256').update(build).digest('hex')
    if (actual !== expected) throw new Error(`${url} has SHA-256 ${actual}, but SHA256SUMS lists ${expected}, so cmod installed nothing. Publish the release again with cmod publish.`)
    const partial = `${target}.${process.pid}.tmp`
    await mkdir(dirname(target), { recursive: true })
    try {
      await Bun.write(partial, build)
      await chmod(partial, 0o755)
      emit({ kind: 'progress', done: 1, total: programSteps, label: `Checking ${name} ${plugin.version}` })
      const check = await capture([partial, '--version']).catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: messageOf(error) }))
      if (check.exitCode !== 0) {
        const detail = (check.stderr.trim() || check.stdout.trim()).split('\n').at(-1)
        throw new Error(`${url} downloaded, but ${name} --version ${formatExit(check.exitCode, detail ?? '')}. Attach the ${machine} build of ${name} to the v${plugin.version} release.`)
      }
      await rename(partial, target)
    } finally {
      await rm(partial, { force: true })
    }
  }
  emit({ kind: 'progress', done: 2, total: programSteps, label: `Linking ${name}` })
  const entry = await linkProgram(name, target)
  const note = terminalNote(name, entry)
  if (note !== undefined) emit({ kind: 'log', text: note })
  emit({ kind: 'progress', done: programSteps, total: programSteps, label: `${name} ${plugin.version} is installed` })
}

export async function removeProgram(name: string): Promise<boolean> {
  const entries = [join(programsFolder(), name), commandEntry(name)]
  const linked = []
  for (const entry of entries) if (await isLinkedFromStore(entry, name)) linked.push(entry)
  for (const entry of linked) await rm(entry)
  await rm(storePath('bin', name), { recursive: true, force: true })
  return linked.length > 0
}

export function programsFolder(): string {
  return storePath('programs')
}

export async function linkDownloaded(name: string, path: string): Promise<void> {
  await placeLink(join(programsFolder(), name), path)
}

export async function removeData(name: string): Promise<void> {
  const folder = dataFolder(storeFolder(process.env), name)
  for (const entry of await readdir(programsFolder()).catch(() => [])) {
    const target = await readlink(join(programsFolder(), entry)).catch(() => undefined)
    if (target?.startsWith(`${folder}/`)) await rm(join(programsFolder(), entry))
  }
  await rm(folder, { recursive: true, force: true })
}

export async function restoreProgram(name: string, record: InstallRecord | undefined): Promise<void> {
  if (record?.program === name) await linkProgram(name, storePath('bin', name, record.version, name))
  else await removeProgram(name)
}

function terminalNote(name: string, entry: string | undefined): string | undefined {
  if (entry === undefined) return `${tilde(commandEntry(name))} is not cmod's, so a terminal runs that ${name}. Claude Code runs cmod's.`
  const found = Bun.which(name, { PATH: process.env['PATH'] ?? '' })
  if (found !== null && resolve(found) !== entry) return `A terminal runs ${tilde(found)}, which PATH finds before ~/.local/bin. Claude Code runs cmod's ${name}.`
  return undefined
}

async function isLinkedFromStore(entry: string, name: string): Promise<boolean> {
  const target = await readlink(entry).catch(() => undefined)
  return target?.startsWith(`${storePath('bin', name)}/`) === true
}

function commandEntry(name: string): string {
  return join(home(), '.local', 'bin', name)
}

export async function download(url: string, fix: string, onProgress: (received: number, size: number) => void = () => {}): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Downloading ${url} returned ${response.status}. ${fix}`)
  const size = Number(response.headers.get('content-length'))
  const chunks: Uint8Array[] = []
  let received = 0
  for await (const chunk of response.body ?? []) {
    chunks.push(chunk)
    received += chunk.byteLength
    onProgress(received, size)
  }
  return Bun.concatArrayBuffers(chunks)
}

async function linkProgram(name: string, target: string): Promise<string | undefined> {
  await placeLink(join(programsFolder(), name), target)
  const entry = commandEntry(name)
  if ((await lstat(entry).catch(() => undefined)) !== undefined && !(await isLinkedFromStore(entry, name))) return undefined
  await placeLink(entry, target)
  return entry
}

async function placeLink(entry: string, target: string): Promise<void> {
  const partial = `${entry}.${process.pid}.tmp`
  await mkdir(dirname(entry), { recursive: true })
  await rm(partial, { force: true })
  await symlink(target, partial)
  await rename(partial, entry)
}
