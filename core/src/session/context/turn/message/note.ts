import { pluginName } from '../../../../records.js'
import type { MessageOf } from './message.js'
import type { Sender } from './sender.js'

export const Note = 'note'

export type Note = MessageOf<typeof Note> & {
  readonly text: string
  readonly from: Sender
}

export const modNoteBlock = new RegExp(`<(${pluginName.source.slice(1, -1)})_mod>\\n([\\s\\S]*?)\\n</\\1_mod>`, 'g')

export function modNote(mod: string, text: string): string {
  return `<${mod}_mod>\n${text}\n</${mod}_mod>`
}

export function modNotesIn(text: string): { readonly mod: string; readonly text: string }[] {
  return [...text.matchAll(modNoteBlock)].map((match) => ({ mod: match[1] as string, text: match[2] as string }))
}

export function untagged(text: string): string {
  const notes = modNotesIn(text)
  return notes.length === 0 ? text : notes.map((note) => note.text).join('\n\n')
}
