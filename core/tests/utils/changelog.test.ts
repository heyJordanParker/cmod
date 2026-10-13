import { expect, test } from 'bun:test'
import { changeLines, changelogSections } from '../../src/utils/changelog.js'

test('a Keep a Changelog file reads as one section per version, with its date and without link references', () => {
  const sections = changelogSections('# Changelog\n\n## [Unreleased]\n\n- Next.\n\n## [1.4.0] - 2026-10-13\n\n### Added\n- /rollback.\n\n## 1.3.2\n\nFixed a slash.\n\n[1.4.0]: https://github.com/owner/mod/compare/v1.3.2...v1.4.0\n')

  expect(sections).toEqual([
    { version: 'Unreleased', text: '- Next.' },
    { version: '1.4.0', date: '2026-10-13', text: '### Added\n- /rollback.' },
    { version: '1.3.2', text: 'Fixed a slash.' },
  ])
})

test('change lines name each entry by its group, and keep a plain paragraph as it is', () => {
  expect(changeLines('### Added\n- /rollback.\n* /undo.\n\n### Fixed\n- A slash.')).toEqual(['Added: /rollback.', 'Added: /undo.', 'Fixed: A slash.'])
  expect(changeLines('Fixed a slash.')).toEqual(['Fixed a slash.'])
})
