import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { pluginName } from '@cmodjs/core/src/records.js'
import { run as runCommand } from '../process.js'
import { download, linkDownloaded, machine } from '../program.js'
import { printEvent } from './setup.js'

export const summary = 'Download a program for an install script: fetch, check, unpack.'

export const help = `Usage: cmod download <program> <machine> <url> <sha256> [<machine> <url> <sha256> …]

${summary}

A mod's install script runs it, and cmod setup sets the CMOD_DATA it needs.
It picks the download listed for this machine, ${machine}, checks its SHA-256,
unpacks a .tar.gz or .zip or takes the file as is, and moves the file named
<program> to $CMOD_DATA/bin/<program>. A download whose SHA-256 differs
installs nothing. It prints progress lines that cmod setup shows in its bar.

Machines are <os>-<arch>: darwin-arm64, darwin-x64, linux-arm64, linux-x64.

Example:
  cmod download mermaid-ascii \\
    darwin-arm64 https://example.com/mermaid-ascii_Darwin_arm64.tar.gz <sha256> \\
    linux-x64    https://example.com/mermaid-ascii_Linux_x86_64.tar.gz <sha256>`

const steps = 7

export async function run(argv: string[]): Promise<number> {
  const [program, ...listed] = parseArgs({ args: argv, allowPositionals: true }).positionals
  if (program === undefined || listed.length === 0 || listed.length % 3 !== 0) throw new Error(`cmod download takes a program, then one or more <machine> <url> <sha256> triples.\n\n${help}`)
  if (!pluginName.test(program)) throw new Error(`"${program}" is not a program name: use letters, digits, ".", "_", and "-", starting with a letter or digit.`)
  const downloads = Array.from({ length: listed.length / 3 }, (_, index) => {
    const [listedMachine, url, sha256] = listed.slice(index * 3, index * 3 + 3) as [string, string, string]
    if (!URL.canParse(url)) throw new Error(`"${url}" for ${listedMachine} is not a URL.`)
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`"${sha256}" for ${listedMachine} is not a SHA-256. Write the 64 lowercase hex characters shasum -a 256 prints.`)
    return { machine: listedMachine, url, sha256 }
  })
  const data = process.env['CMOD_DATA']
  if (!data) throw new Error("CMOD_DATA is not set. Run this from a mod's install script; cmod setup sets CMOD_DATA.")
  const chosen = downloads.find((entry) => entry.machine === machine)
  if (chosen === undefined) throw new Error(`${program} has no download for this machine, ${machine}. The install script lists ${downloads.map((entry) => entry.machine).join(', ')}.`)

  const emit = (done: number, label: string) => printEvent({ kind: 'progress', done, total: steps, label })
  emit(0, `Downloading ${program} for ${machine}`)
  let quarter = 0
  const bytes = await download(chosen.url, 'The install script lists a download that is gone, so the mod needs an update.', (received, size) => {
    const reached = size > 0 ? Math.min(4, Math.floor((received * 4) / size)) : 0
    if (reached <= quarter) return
    quarter = reached
    emit(reached, `Downloading ${program}: ${megabytes(received)} of ${megabytes(size)} MB`)
  })

  emit(5, `Checking ${program}'s SHA-256`)
  const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  if (actual !== chosen.sha256) {
    throw new Error(`${chosen.url} has SHA-256 ${actual}, but the install script lists ${chosen.sha256}, so cmod installed nothing. Run the install again. If it repeats, the file at that link changed, and the mod needs an update.`)
  }

  const bin = join(data, 'bin')
  await mkdir(bin, { recursive: true })
  const work = await mkdtemp(join(data, 'download-'))
  try {
    const name = basename(new URL(chosen.url).pathname)
    const file = join(work, 'download')
    const unpacked = join(work, 'unpacked')
    await Bun.write(file, bytes)
    await mkdir(unpacked)
    const unpack = /\.(tar\.gz|tgz)$/.test(name) ? ['tar', '-xzf', file, '-C', unpacked] : name.endsWith('.zip') ? ['unzip', '-q', file, '-d', unpacked] : undefined
    if (unpack === undefined) await rename(file, join(unpacked, program))
    else {
      emit(6, `Unpacking ${program}`)
      await runCommand(unpack)
    }
    const found = await findFile(unpacked, program)
    if (found === undefined) throw new Error(`${name} holds no file named ${program}, so cmod installed nothing. Name the program the archive holds.`)
    await chmod(found, 0o755)
    await rename(found, join(bin, program))
  } finally {
    await rm(work, { recursive: true, force: true })
  }
  await linkDownloaded(program, join(bin, program))
  emit(steps, `${program} is installed`)
  return 0
}

async function findFile(folder: string, name: string): Promise<string | undefined> {
  const paths = (await readdir(folder, { recursive: true })).filter((path) => basename(path) === name).sort((a, b) => a.length - b.length)
  for (const path of paths) if ((await lstat(join(folder, path))).isFile()) return join(folder, path)
  return undefined
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}
