import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { version as coreVersion } from '@cmodjs/core/package.json'
import { formatEvent, type RunnerEvent } from '@cmodjs/core/src/records.js'

const oldestCore = '4.0.0'

const folder = await mkdtemp(join(tmpdir(), 'cmod-oldest-core-'))

afterAll(() => rm(folder, { recursive: true, force: true }))

const events: readonly RunnerEvent[] = [
  { type: 'progress', done: 1, total: 4, label: 'Installing trash' },
  { type: 'log', text: 'Bound shift+tab to Switch mode' },
  { type: 'needs-consent', sha256: 'abc123', install: './setup/install.sh', uninstall: './setup/uninstall.sh', hotkeys: 'shift+tab to Switch mode', permissions: ['network:api.github.com', 'model'] },
  { type: 'needs-consent', sha256: 'abc123', install: '', uninstall: '', hotkeys: '', permissions: [] },
  { type: 'done', name: 'safe-delete', version: '0.2.0' },
  { type: 'missing', name: 'safe-delete' },
  { type: 'failed', code: 2, message: 'The install step of safe-delete exited 2: no Homebrew.' },
  { type: 'retries', when: 'later' },
]

test.skipIf(coreVersion === oldestCore)(`each event line this cmod prints reads the same in @cmodjs/core ${oldestCore} on npm, the oldest library every newer cmod runs`, async () => {
  const installed = Bun.spawnSync(['bun', 'add', '--no-save', `@cmodjs/core@${oldestCore}`], { cwd: folder, stdout: 'pipe', stderr: 'pipe' })
  expect(installed.stderr.toString()).not.toContain('error:')
  const oldest = (await import(join(folder, 'node_modules/@cmodjs/core/records.js'))) as { parseEvent(line: string): RunnerEvent }

  for (const event of events) expect(oldest.parseEvent(formatEvent(event))).toEqual(event)
}, 60000)
