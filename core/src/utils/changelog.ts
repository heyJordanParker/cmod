export type ChangelogSection = { readonly version: string; readonly date?: string; readonly text: string }

export const unreleased = 'Unreleased'

const heading = /^##\s+\[?([^\]\s]+)\]?(?:\s+-\s+(\S+))?\s*$/

const linkReference = /^\[[^\]]+\]:\s/

export function changelogSections(markdown: string): ChangelogSection[] {
  const sections: { readonly version: string; readonly date: string | undefined; readonly lines: string[] }[] = []
  for (const line of markdown.split('\n')) {
    const match = heading.exec(line)
    if (match !== null) sections.push({ version: match[1] as string, date: match[2], lines: [] })
    else if (!linkReference.test(line)) sections.at(-1)?.lines.push(line)
  }
  return sections.map(({ version, date, lines }) => ({ version, ...(date === undefined ? {} : { date }), text: lines.join('\n').trim() }))
}

export function changeLines(text: string): string[] {
  let group: string | undefined
  return text.split('\n').flatMap((line) => {
    const trimmed = line.trim()
    const subheading = /^###\s+(.+)$/.exec(trimmed)?.[1]
    if (subheading !== undefined) {
      group = subheading
      return []
    }
    const item = /^[-*]\s+(.+)$/.exec(trimmed)?.[1] ?? trimmed
    if (item === '') return []
    return [group === undefined ? item : `${group}: ${item}`]
  })
}
