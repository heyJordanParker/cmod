import type { Note } from './message/note.js'
import { Mod } from './message/sender.js'

export type Device = {
  readonly id: string
  readonly name: string
  readonly os: 'darwin' | 'linux'
  readonly arch: 'arm64' | 'x64'
}

const deviceLine = /^As of \S+, this session runs on (.+), a (darwin|linux) (arm64|x64) computer with the cmod device id ([0-9a-f]{32})\.$/m

export function deviceNote({ id, name, os, arch }: Device, at: string): string {
  return `As of ${at}, this session runs on ${name}, a ${os} ${arch} computer with the cmod device id ${id}.`
}

export function deviceOf(note: Pick<Note, 'from' | 'text'>): Device | undefined {
  if (note.from.type !== Mod) return undefined
  const [, name, os, arch, id] = deviceLine.exec(note.text) ?? []
  return name === undefined || id === undefined ? undefined : { id, name, os: os as Device['os'], arch: arch as Device['arch'] }
}
