import type { HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import { storeFolder } from '../records.js'
import { ifMissing } from '../utils/paths.js'
import { formatExit } from '../utils/text.js'
import type { Claude } from './claude.js'

export type Programs = { readonly claude: Claude; refresh(): Promise<void> }

export function lastLineOf(text: string): string | undefined {
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed.slice(trimmed.lastIndexOf('\n') + 1).trim()
}

export function cmodError(stderr: string, command: string | undefined): string {
  const line = lastLineOf(stderr) ?? ''
  const prefix = `cmod ${command}: `
  return line.startsWith(prefix) ? line.slice(prefix.length) : line
}

export async function readLines(stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>, onLine: (text: string) => void): Promise<{ code: number | null; lastError: string }> {
  let pending = ''
  let lastError = ''
  let piece = await stream.next()
  while (piece.done !== true) {
    if (piece.value.stream === 'stderr') {
      lastError = lastLineOf(piece.value.text) ?? lastError
    } else {
      const lines = `${pending}${piece.value.text}`.split('\n')
      pending = lines.pop() ?? ''
      for (const text of lines) onLine(text)
    }
    piece = await stream.next()
  }
  if (pending !== '') onLine(pending)
  return { code: piece.value.code, lastError }
}

export async function runCmod(claude: Claude, args: readonly string[], session: string): Promise<string> {
  const lines: string[] = []
  const { code, lastError } = await readLines(claude.process.spawn({ argv: ['cmod', ...args], env: { CLAUDE_CODE_SESSION_ID: session } }), (line) => void lines.push(line))
  if (code !== 0) throw new Error(cmodError(lastError, args[0]) || `cmod ${args.slice(0, 2).join(' ')} ${formatExit(code, '')}.`)
  return lines.join('\n')
}

export function locatingPrograms(claude: Claude): Programs {
  let folder: string | undefined
  let names: ReadonlySet<string> = new Set()
  const located = (argv: readonly string[]): readonly string[] => {
    const [name, ...rest] = argv
    return folder !== undefined && name !== undefined && names.has(name) ? [`${folder}/${name}`, ...rest] : argv
  }
  return {
    claude: {
      ...claude,
      process: {
        run: (argv, init) => claude.process.run(located(argv), init),
        spawn: (request) => claude.process.spawn({ ...request, argv: located(request.argv) }),
      },
    },
    async refresh() {
      const [home, dataHome] = await Promise.all([claude.env.home(), claude.env.dataHome()])
      const programs = `${storeFolder({ HOME: home, XDG_DATA_HOME: dataHome })}/programs`
      names = new Set((await claude.fs.list(programs).catch(ifMissing([]))).map((entry) => entry.name))
      folder = programs
    },
  }
}
