import { existsSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, rename, rm, stat, symlink } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { dataFolder, isObject, pluginName, programPath, storeFolder, type InstallRecord, type RunnerEvent } from '@cmodjs/core/src/records.js'
import { formatExit, messageOf } from '@cmodjs/core/src/utils/text.js'
import { home, ifMissing, readJson, readLink, readText, tilde, writeAtomically } from './files.js'
import type { Plugin } from './plugin.js'
import { capture, runStep } from './process.js'
import type { Progress } from './progress.js'
import { isLinked } from './settings.js'
import { storePath, takeLock } from './store.js'

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

export async function buildProgram(program: Program, wanted: readonly string[], progress: Progress, environment: Readonly<Record<string, string | undefined>> = process.env): Promise<string[]> {
  const lock = await takeLock(`${buildPath(program)}.lock`)
  try {
    const builds = await runBuild(program, wanted, progress, environment)
    await rm(`${buildPath(program)}.failed`, { force: true })
    return builds
  } finally {
    await lock[Symbol.asyncDispose]()
  }
}

function buildPath(program: Program): string {
  return storePath('builds', Bun.hash(resolve(program.folder)).toString(36))
}

async function buildUnlessFailed(program: Program, build: () => Promise<unknown>): Promise<void> {
  const failed = `${buildPath(program)}.failed`
  const before = await readText(failed)
  const sources = await sourcesStamp(program)
  if (before?.startsWith(`${sources}\n`) === true) throw new Error(before.slice(sources.length + 1))
  try {
    await build()
  } catch (error) {
    await writeAtomically(failed, `${sources}\n${messageOf(error)}`)
    throw error
  }
}

async function sourcesStamp(program: Program): Promise<string> {
  const skipped = new Set(['node_modules', '.git', program.output.split('/')[0]])
  const lines: string[] = []
  const visit = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory() && !skipped.has(entry.name)) await visit(path)
      else if (entry.isFile()) {
        const { mtimeMs, size } = await stat(path)
        lines.push(`${relative(program.folder, path)} ${mtimeMs} ${size}`)
      }
    }
  }
  await visit(program.folder)
  return Bun.hash(lines.sort().join('\n')).toString(36)
}

async function runBuild(program: Program, wanted: readonly string[], progress: Progress, environment: Readonly<Record<string, string | undefined>>): Promise<string[]> {
  const heading = `Building ${program.name}`
  progress.step(heading)
  const startedAt = Math.floor(Date.now() / 1000) * 1000
  const result = await runStep(['sh', '-c', program.build], program.folder, { ...environment, CMOD_MACHINES: wanted.join(' ') }, (event) => {
    if (event.type === 'progress') progress.update(heading, event.done, event.total, event.label)
    else progress.log(event.text)
  })
  if (result.exitCode !== 0) {
    progress.fail(`Could not build ${program.name}`)
    throw new Error(`Building ${program.name} with "${program.build}" ${formatExit(result.exitCode, result.lastError)}. Fix the build in ${tilde(program.folder)}, then save a file there or run the command again.`)
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

export async function installProgram(program: Program, version: string, progress: Progress, environment: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const target = await storeBuild(program, version, progress, environment)
  const entry = await linkProgram(program.name, target)
  progress.succeed(`Installed ${program.name} ${version}: Claude Code runs ${tilde(join(programsFolder(), program.name))}, which runs ${tilde(target)}`)
  const note = terminalNote(program.name, entry)
  if (note !== undefined) progress.note(note)
  else if (entry !== undefined && !(process.env['PATH'] ?? '').split(':').includes(dirname(entry))) progress.note(`Add ~/.local/bin to PATH to run ${program.name} in a terminal.`)
}

async function storeBuild(program: Program, version: string, progress: Progress, environment: Readonly<Record<string, string | undefined>>): Promise<string> {
  const built = (await buildProgram(program, [machine], progress, environment))[0] as string
  const target = programPath(storeFolder(process.env), program.name, version)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(built, `${target}.${process.pid}.tmp`)
  await chmod(`${target}.${process.pid}.tmp`, 0o755)
  await rename(`${target}.${process.pid}.tmp`, target)
  return target
}

export async function fetchProgram(plugin: Plugin, name: string, emit: (event: RunnerEvent) => void): Promise<void> {
  const target = programPath(storeFolder(process.env), name, plugin.version)
  const checkout = existsSync(target) || !(await isLinked(plugin.root)) ? undefined : await readProgram(plugin)
  if (checkout?.name === name) await buildUnlessFailed(checkout, () => storeBuild(checkout, plugin.version, reporting(emit), process.env))
  if (!existsSync(target)) {
    if (plugin.repository === undefined) throw new Error(`${plugin.root}/.claude-plugin/plugin.json names no "repository", so cmod has no release to download ${name} from. Add "repository": "https://github.com/<owner>/<repo>".`)
    const release = `${releaseDownloads(plugin.repository)}/v${plugin.version}`
    const url = `${release}/${name}-${machine}`
    const attach = (file: string) => `The v${plugin.version} release of ${plugin.name} has no ${file} yet. Its author attaches it with cmod publish.`
    emit({ type: 'progress', done: 0, total: programSteps, label: `Downloading ${name} ${plugin.version}` })
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
      emit({ type: 'progress', done: 1, total: programSteps, label: `Checking ${name} ${plugin.version}` })
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
  emit({ type: 'progress', done: 2, total: programSteps, label: `Linking ${name}` })
  const entry = await linkProgram(name, target)
  const note = terminalNote(name, entry)
  if (note !== undefined) emit({ type: 'log', text: note })
  emit({ type: 'progress', done: programSteps, total: programSteps, label: `${name} ${plugin.version} is installed` })
}

function reporting(emit: (event: RunnerEvent) => void): Progress {
  const log = (text: string) => emit({ type: 'log', text })
  return {
    step: (heading) => emit({ type: 'progress', done: 0, total: programSteps, label: heading }),
    update: (_heading, done, total, label) => emit({ type: 'progress', done, total, label }),
    log,
    succeed: log,
    skip: log,
    fail: log,
    note: log,
  }
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
  for (const entry of await readdir(programsFolder()).catch(ifMissing([]))) {
    const target = await readLink(join(programsFolder(), entry))
    if (target?.startsWith(`${folder}/`)) await rm(join(programsFolder(), entry))
  }
  await rm(folder, { recursive: true, force: true })
}

export async function restoreProgram(name: string, record: InstallRecord | undefined): Promise<void> {
  if (record?.program === name) await linkProgram(name, programPath(storeFolder(process.env), name, record.version))
  else await removeProgram(name)
}

function terminalNote(name: string, entry: string | undefined): string | undefined {
  if (entry === undefined) return `${tilde(commandEntry(name))} is not cmod's, so a terminal runs that ${name}. Claude Code runs cmod's.`
  const found = Bun.which(name, { PATH: process.env['PATH'] ?? '' })
  if (found !== null && resolve(found) !== entry) return `A terminal runs ${tilde(found)}, which PATH finds before ~/.local/bin. Claude Code runs cmod's ${name}.`
  return undefined
}

async function isLinkedFromStore(entry: string, name: string): Promise<boolean> {
  const target = await readLink(entry)
  return target?.startsWith(`${storePath('bin', name)}/`) === true
}

function commandEntry(name: string): string {
  return join(home(), '.local', 'bin', name)
}

export class DownloadFailed extends Error {}

export async function download(url: string, missing: string, onProgress: (received: number, size: number) => void = () => {}): Promise<ArrayBuffer> {
  const response = await fetch(url).catch((error: unknown) => {
    throw new DownloadFailed(`cmod could not reach ${new URL(url).host}: ${messageOf(error)}`)
  })
  if (response.status === 404) throw new DownloadFailed(missing)
  if (!response.ok) throw new DownloadFailed(`Downloading ${url} returned ${response.status}.`)
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
  if ((await lstat(entry).catch(ifMissing(undefined))) !== undefined && !(await isLinkedFromStore(entry, name))) return undefined
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
