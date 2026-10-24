import type { MessageOf } from './message.js'

export const AttachedFile = 'attachedFile'

export type AttachmentType = 'contents' | 'reference' | 'change'

export type AttachedFile = MessageOf<typeof AttachedFile> & {
  readonly path: string
  readonly attachmentType: AttachmentType
  readonly text: string
}

export const attachmentTypes: Readonly<Record<string, AttachmentType>> = {
  file: 'contents',
  compact_file_reference: 'reference',
  edited_text_file: 'change',
}

export function attachmentTypeOf(name: string | undefined): AttachmentType | undefined {
  return name !== undefined && Object.hasOwn(attachmentTypes, name) ? attachmentTypes[name] : undefined
}

export function attachmentNameOf(type: AttachmentType): string {
  const name = Object.keys(attachmentTypes).find((each) => attachmentTypes[each] === type)
  if (name === undefined) throw new Error(`Claude Code writes no attachment row for a ${type} file.`)
  return name
}

const readPath = /^Called the Read tool with the following input: \{.*?"file_path":\s*("(?:[^"\\]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*")/m

const noted = /^Note: (.+?) (?:was read before the last conversation was summarized|changed on disk since you last read it)/m

export function attachedPathOf(text: string): string {
  const read = readPath.exec(text)?.[1]
  return read === undefined ? (noted.exec(text)?.[1] ?? '') : (JSON.parse(read) as string)
}
