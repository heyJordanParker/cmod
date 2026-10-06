import { expect, test } from 'bun:test'
import { matchesGlob } from '../../src/utils/matches-glob.js'

test('matches dot files', () => {
  expect(matchesGlob('a/.env', '**/.env')).toBe(true)
  expect(matchesGlob('.claude/settings.json', '**/*.json')).toBe(true)
})

test('matches a glob anywhere in an absolute path', () => {
  expect(matchesGlob('/Users/jordan/app/.env', '**/.env')).toBe(true)
})

test('does not ignore case', () => {
  expect(matchesGlob('Domain.md', 'domain.md')).toBe(false)
})

test('a single star stays inside one folder', () => {
  expect(matchesGlob('database/migrations/x.php', 'database/migrations/*.php')).toBe(true)
  expect(matchesGlob('database/migrations/old/x.php', 'database/migrations/*.php')).toBe(false)
})

test('a glob in the path is text, not a pattern', () => {
  expect(matchesGlob('.e*', '**/.env')).toBe(false)
})
