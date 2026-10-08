import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatEvent, type RunnerEvent } from '@cmodjs/core/src/records.js'

const folder = await mkdtemp(join(tmpdir(), 'cmod-released-core-'))

afterAll(() => rm(folder, { recursive: true, force: true }))

const events: readonly RunnerEvent[] = [
  { kind: 'progress', done: 1, total: 4, label: 'Installing trash' },
  { kind: 'log', text: 'Bound shift+tab to /mode' },
  { kind: 'needs-consent', sha256: 'abc123', install: './setup/install.sh', uninstall: './setup/uninstall.sh', keys: 'shift+tab to /mode', permissions: ['network:api.github.com', 'model'] },
  { kind: 'needs-consent', sha256: 'abc123', install: '', uninstall: '', keys: '', permissions: [] },
  { kind: 'done', name: 'safe-delete', version: '0.2.0' },
  { kind: 'missing', name: 'safe-delete' },
  { kind: 'failed', code: 2, message: 'The install step of safe-delete exited 2: no Homebrew.' },
]

test('each event line this cmod prints reads the same in the last @cmodjs/core on npm, so a mod built on it still sets up', async () => {
  const installed = Bun.spawnSync(['bun', 'add', '--no-save', '@cmodjs/core@latest'], { cwd: folder, stdout: 'pipe', stderr: 'pipe' })
  expect(installed.stderr.toString()).not.toContain('error:')
  const released = (await import(join(folder, 'node_modules/@cmodjs/core/records.js'))) as { parseEvent(line: string): RunnerEvent }

  for (const event of events) expect(released.parseEvent(formatEvent(event))).toEqual(event)
}, 60000)
