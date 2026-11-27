export function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

export function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
}

const summaryChars = 200

export function questionOf(input: Readonly<Record<string, unknown>>): string | undefined {
  const question = (input['questions'] as readonly { readonly question?: unknown }[] | undefined)?.[0]?.question
  return typeof question === 'string' ? question : undefined
}

export function callSummary(input: Readonly<Record<string, unknown>>): string {
  const named = [input['command'], input['file_path'], input['path'], input['pattern'], input['url'], input['query'], questionOf(input), input['description'], input['prompt']].find((value) => typeof value === 'string')
  return firstLine(typeof named === 'string' ? named : JSON.stringify(input)).slice(0, summaryChars)
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function formatExit(code: number | null, reason: string): string {
  const exit = code === null ? 'was stopped by a signal' : `exited ${code}`
  const clause = reason.trim().replace(/[.!?]+$/, '')
  return clause ? `${exit}: ${clause}` : exit
}
