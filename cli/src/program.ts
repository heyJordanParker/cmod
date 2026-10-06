import { existsSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readlink, rename, rm, symlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { isObject, pluginName, type InstallRecord, type RunnerEvent } from '@cmodjs/core/src/records.js'
import { formatExit, messageOf } from '@cmodjs/core/src/utils/text.js'
import { home, readJson, readText, tilde } from './files.js'
import type { Plugin } from './plugin.js'
import { capture, runStep } from './process.js'
import type { Progress } from './progress.js'
import { storePath } from './store.js'

export type Program = { name: string; folder: string; build: string; output: string }

export const programSteps = 3

export const machine = `${process.platform}-${process.arch}`

export function releaseDownloads(repository: string): string {
  return `${repository.replace(/\/$/, '')}/releases/download`
}

export async function readProgram(plugin: Plugin): Promise<Program | undefined> {
  const folder = join(plugin.root, 'cli')
  const packageJson = await readJson(join(folder, 'package.json'))
  const cargo = await readText(join(folder, 'Cargo.toml'))
  const manifest = isObject(packageJson) ? packageJson : cargo === undefined ? undefined : (Bun.TOML.parse(cargo) as Record<string, unknown>)['package']
  if (!isObject(manifest)) return undefined
  const metadata = manifest['metadata']
  const declared = isObject(packageJson) ? manifest['cmod'] : isObject(metadata) ? metadata['cmod'] : undefined
  if (declared === undefined) return undefined
  if (!isObject(declared) || typeof declared['build'] !== 'string' || typeof declared['output'] !== 'string') {
    throw new Error(`${tilde(folder)} declares a "cmod" build without "build" and "output". Write "cmod": { "build": "<command>", "output": "<folder>" }.`)
  }
  const name = manifest['name']
  if (typeof name !== 'string' || !pluginName.test(name)) throw new Error(`${tilde(folder)} names its program "${String(name)}". The manifest's "name" is the command, such as "hello".`)
  return { name, folder, build: declared['build'], output: declared['output'] }
}

export async function buildProgram(program: Program, progress: Progress): Promise<string[]> {
  const heading = `Building ${program.name}`
  progress.step(heading)
  const result = await runStep(['sh', '-c', program.build], program.folder, process.env, (event) => {
    if (event.kind === 'progress') progress.update(heading, event.done, event.total, event.label)
    else progress.log(event.text)
  })
  if (result.exitCode !== 0) {
    progress.fail(`Building ${program.name} with "${program.build}" ${formatExit(result.exitCode, result.lastError)}.`)
    throw new Error(`Fix the build in ${tilde(program.folder)}, then run the command again.`)
  }
  const folder = join(program.folder, program.output)
  const outputs = existsSync(folder) ? (await readdir(folder)).sort().map((entry) => join(folder, entry)) : []
  if (outputs.length === 0) throw new Error(`The build of ${program.name} left nothing in ${tilde(folder)}. Point "output" at the folder the build writes.`)
  progress.succeed(`Built ${program.name}: ${outputs.map((output) => basename(output)).join(', ')}`)
  return outputs
}

export async function installProgram(program: Program, version: string, progress: Progress): Promise<void> {
  await refuseTakenCommand(program.name)
  const platform = `${program.name}-${machine}`
  const built = (await buildProgram(program, progress)).find((output) => basename(output) === platform)
  if (built === undefined) throw new Error(`The build of ${program.name} wrote no ${platform} in ${tilde(join(program.folder, program.output))}. Name each build <program>-<os>-<arch>, as release downloads are named.`)

  const target = storePath('bin', program.name, version, program.name)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(built, `${target}.${process.pid}.tmp`)
  await chmod(`${target}.${process.pid}.tmp`, 0o755)
  await rename(`${target}.${process.pid}.tmp`, target)

  const entry = await linkProgram(program.name, target)
  progress.succeed(`Installed ${program.name} ${version}: ${tilde(entry)} runs ${tilde(target)}`)
  if (!(process.env['PATH'] ?? '').split(':').includes(dirname(entry))) progress.note(`Add ~/.local/bin to PATH to run ${program.name} in a terminal.`)
}

export async function fetchProgram(plugin: Plugin, name: string, emit: (event: RunnerEvent) => void): Promise<void> {
  await refuseTakenCommand(name)
  const target = storePath('bin', name, plugin.version, name)
  if (!existsSync(target)) {
    if (plugin.repository === undefined) throw new Error(`${plugin.root}/.claude-plugin/plugin.json names no "repository", so CMod has no release to download ${name} from. Add "repository": "https://github.com/<owner>/<repo>".`)
    const release = `${releaseDownloads(plugin.repository)}/v${plugin.version}`
    const url = `${release}/${name}-${machine}`
    const attach = (file: string) => `Attach ${file} to the v${plugin.version} release, as cmod publish does.`
    emit({ kind: 'progress', done: 0, total: programSteps, label: `Downloading ${name} ${plugin.version}` })
    const sums = new TextDecoder().decode(await download(`${release}/SHA256SUMS`, attach('SHA256SUMS')))
    const expected = sums.split('\n').map((line) => /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim())).find((match) => match?.[2] === basename(url))?.[1]
    if (expected === undefined) throw new Error(`${release}/SHA256SUMS lists no ${basename(url)}, so CMod cannot check the download. Publish the release with cmod publish, which lists every build.`)
    const build = await download(url, attach(basename(url)))
    const actual = new Bun.CryptoHasher('sha256').update(build).digest('hex')
    if (actual !== expected) throw new Error(`${url} has SHA-256 ${actual}, but SHA256SUMS lists ${expected}, so CMod installed nothing. Publish the release again with cmod publish.`)
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
  emit({ kind: 'progress', done: 2, total: programSteps, label: `Linking ~/.local/bin/${name}` })
  await linkProgram(name, target)
  emit({ kind: 'progress', done: programSteps, total: programSteps, label: `${name} ${plugin.version} is installed` })
}

export async function removeProgram(name: string): Promise<boolean> {
  const entry = commandEntry(name)
  const isLinked = await isLinkedFromStore(entry, name)
  if (isLinked) await rm(entry)
  await rm(storePath('bin', name), { recursive: true, force: true })
  return isLinked
}

export async function restoreProgram(name: string, record: InstallRecord | undefined): Promise<void> {
  if (record?.program === name) await linkProgram(name, storePath('bin', name, record.version, name))
  else await removeProgram(name)
}

async function refuseTakenCommand(name: string): Promise<void> {
  const entry = commandEntry(name)
  if ((await lstat(entry).catch(() => undefined)) !== undefined && !(await isLinkedFromStore(entry, name))) {
    throw new Error(`${tilde(entry)} exists and CMod did not make it, so CMod will not replace it with the ${name} program. Move it out of ~/.local/bin, then run the command again.`)
  }
  const found = Bun.which(name)
  if (found !== null && resolve(dirname(found)) !== dirname(entry)) {
    throw new Error(`PATH already finds ${name} at ${tilde(found)}, so the ${name} program CMod installs would never run. Remove that ${name} from PATH, then run the command again.`)
  }
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

async function linkProgram(name: string, target: string): Promise<string> {
  const entry = commandEntry(name)
  const partial = `${entry}.${process.pid}.tmp`
  await mkdir(dirname(entry), { recursive: true })
  await rm(partial, { force: true })
  await symlink(target, partial)
  await rename(partial, entry)
  return entry
}
