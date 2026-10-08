import { parseEvent, type RunnerEvent } from '@cmodjs/core/src/records.js'

type Line = { stream: 'stdout' | 'stderr'; text: string }

export type RunOptions = { cwd?: string; env?: Record<string, string | undefined>; stdin?: 'inherit' | 'ignore' | { readonly text: string } }

export async function runStep(argv: string[], cwd: string, env: Record<string, string | undefined>, emit: (event: Extract<RunnerEvent, { kind: 'progress' | 'log' }>) => void): Promise<{ exitCode: number; lastError: string }> {
  let lastError = ''
  const exitCode = await runLines(argv, { cwd, env }, (line) => {
    if (line.stream === 'stderr' && line.text.trim() !== '') lastError = line.text
    const event = line.stream === 'stdout' ? parseEvent(line.text) : undefined
    emit(event?.kind === 'progress' ? event : { kind: 'log', text: line.text })
  })
  return { exitCode, lastError }
}

async function runLines(argv: string[], options: RunOptions, onLine: (line: Line) => void): Promise<number> {
  const child = spawn(argv, { ...options, stdout: 'pipe', stderr: 'pipe' })
  await Promise.all([readLines(child.stdout, (text) => onLine({ stream: 'stdout', text })), readLines(child.stderr, (text) => onLine({ stream: 'stderr', text }))])
  return child.exited
}

export async function capture(argv: string[], options: RunOptions = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawn(argv, { ...options, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { exitCode, stdout, stderr }
}

export async function run(argv: string[], options: RunOptions = {}): Promise<string> {
  const result = await capture(argv, options)
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-5).join('\n')
    throw new Error(`${argv.join(' ')} exited ${result.exitCode}${detail ? `:\n${detail}` : ''}`)
  }
  return result.stdout
}

export async function runAttached(argv: string[], options: RunOptions = {}): Promise<number> {
  return spawn(argv, { ...options, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' }).exited
}

export function bunArgv(...args: string[]): { argv: string[]; env: Record<string, string | undefined> } {
  return { argv: [process.execPath, ...args], env: { ...process.env, BUN_BE_BUN: '1' } }
}

export function spawn<Out extends 'pipe' | 'inherit' | 'ignore'>(argv: string[], options: RunOptions & { stdout: Out; stderr: Out }) {
  try {
    return Bun.spawn(argv, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env ?? process.env,
      stdin: typeof options.stdin === 'object' ? new TextEncoder().encode(options.stdin.text) : (options.stdin ?? 'ignore'),
      stdout: options.stdout,
      stderr: options.stderr,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${argv[0]} is not on PATH. Install it, then run the command again.`)
    throw error
  }
}

async function readLines(stream: ReadableStream<Uint8Array> | number | undefined, onLine: (text: string) => void): Promise<void> {
  if (!(stream instanceof ReadableStream)) return
  const decoder = new TextDecoder()
  let pending = ''
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) onLine(line.replace(/\r$/, ''))
  }
  pending += decoder.decode()
  if (pending !== '') onLine(pending)
}
