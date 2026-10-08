import { expect, test } from 'bun:test'
import { formatOf, readMetadata, writeMetadata } from '../../src/utils/metadata.js'

const markdown = { kind: 'frontmatter' } as const
const shell = { kind: 'comment', prefix: '#' } as const
const sidecar = { kind: 'sidecar' } as const

test('formatOf picks frontmatter for Markdown, a comment block for scripts and config, and a sidecar for the rest', () => {
  expect(formatOf('/a/SKILL.md', undefined)).toEqual(markdown)
  expect(formatOf('/a/lint.sh', undefined)).toEqual(shell)
  expect(formatOf('/a/hook.ts', undefined)).toEqual({ kind: 'comment', prefix: '//' })
  expect(formatOf('/a/query.sql', undefined)).toEqual({ kind: 'comment', prefix: '--' })
  expect(formatOf('/a/deploy', '#!/bin/sh')).toEqual(shell)
  expect(formatOf('/a/settings.json', undefined)).toEqual(sidecar)
  expect(formatOf('/a/logo.png', undefined)).toEqual(sidecar)
})

test('readMetadata reads block, flow, quoted, and commented maps, and the frontmatter name', () => {
  const block = ['---', 'name: commit', 'description: Commit the staged work', 'metadata:', '  modes.mode: build review  # where it runs', "  modes.note: 'it''s fine'", '---', 'Body'].join('\n')
  const flow = ['---', 'metadata: { modes.mode: build, other.key: "a, b" }', '---'].join('\n')

  expect(readMetadata(block, markdown)).toEqual({ metadata: { 'modes.mode': 'build review', 'modes.note': "it's fine" }, name: 'commit' })
  expect(readMetadata(flow, markdown)).toEqual({ metadata: { 'modes.mode': 'build', 'other.key': 'a, b' } })
  expect(readMetadata('# Title\n', markdown)).toEqual({ metadata: {} })
})

test('readMetadata reads the comment block after a shebang, and a sidecar map', () => {
  expect(readMetadata('#!/bin/sh\n# /// metadata\n# modes.mode: build\n# ///\necho hi\n', shell)).toEqual({ metadata: { 'modes.mode': 'build' } })
  expect(readMetadata('metadata:\n  modes.mode: review\n', sidecar)).toEqual({ metadata: { 'modes.mode': 'review' } })
})

test('readMetadata names the line it cannot read', () => {
  expect(() => readMetadata('---\nmetadata:\n  modes.mode:\n    - build\n---\n', markdown)).toThrow('line 4: a metadata value holds a list or a map.')
  expect(() => readMetadata('---\nmetadata: { modes.mode: build\n---\n', markdown)).toThrow('line 2: the metadata map starts with { and does not end on the same line.')
  expect(() => readMetadata('---\nmetadata:\n  modes.mode "build"\n---\n', markdown)).toThrow('line 3: "modes.mode "build"" has no ":".')
  expect(() => readMetadata('# /// metadata\n# modes.mode: build\n', shell)).toThrow('line 1: the metadata block never ends.')
})

test('writeMetadata changes only the metadata block and keeps every other line', () => {
  const skill = ['---', 'name: commit', 'metadata:', '  other.key: kept', '  modes.mode: build', 'allowed-tools: Read', '---', 'Body', ''].join('\n')

  expect(writeMetadata(skill, markdown, { 'other.key': 'kept', 'modes.mode': 'build review' })).toBe(['---', 'name: commit', 'metadata:', '  other.key: kept', '  modes.mode: build review', 'allowed-tools: Read', '---', 'Body', ''].join('\n'))
  expect(writeMetadata('Body\n', markdown, { 'modes.mode': 'yes' })).toBe('---\nmetadata:\n  modes.mode: "yes"\n---\nBody\n')
  expect(writeMetadata('---\nmetadata:\n  modes.mode: build\n---\nBody\n', markdown, {})).toBe('Body\n')
  expect(writeMetadata('#!/bin/sh\necho hi\n', shell, { 'modes.mode': 'build' })).toBe('#!/bin/sh\n# /// metadata\n# modes.mode: build\n# ///\necho hi\n')
  expect(writeMetadata('', sidecar, { 'modes.mode': 'a: b' })).toBe('metadata:\n  modes.mode: "a: b"\n')
})

test('a value writeMetadata quotes reads back as the same text', () => {
  for (const value of ['true', '3', 'a: b', 'x #y', '"quoted"', '', '@at', '- dash', 'build review']) {
    const written = writeMetadata('', sidecar, { 'modes.mode': value })
    expect(readMetadata(written, sidecar).metadata['modes.mode']).toBe(value)
  }
})
