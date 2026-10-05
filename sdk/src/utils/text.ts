export function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
