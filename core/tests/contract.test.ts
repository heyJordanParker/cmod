import { expect, test } from 'bun:test'
import { defineMod } from '../src/mod.js'
import { formatEvent, parseEvent, scriptsSha256, type RunnerEvent, type Steps } from '../src/records.js'
import { testMod } from '../src/testing.js'
import { claudeCodeOf } from '../src/testing/claude-code.js'

const linesSince400: readonly (readonly [RunnerEvent, string])[] = [
  [{ type: 'progress', done: 1, total: 4, label: 'Installing trash' }, 'progress 1 4 Installing trash'],
  [{ type: 'log', text: 'Bound shift+tab to Switch mode' }, 'log Bound shift+tab to Switch mode'],
  [
    { type: 'needs-consent', sha256: 'abc123', install: './setup/install.sh', uninstall: './setup/uninstall.sh', hotkeys: 'shift+tab to Switch mode', permissions: ['network:api.github.com', 'model'] },
    'needs-consent abc123\t./setup/install.sh\t./setup/uninstall.sh\tshift+tab to Switch mode\tnetwork:api.github.com\tmodel',
  ],
  [{ type: 'needs-consent', sha256: 'abc123', install: '', uninstall: '', hotkeys: '', permissions: [] }, 'needs-consent abc123\t\t\t'],
  [{ type: 'done', name: 'safe-delete', version: '0.2.0' }, 'done safe-delete 0.2.0'],
  [{ type: 'missing', name: 'safe-delete' }, 'missing safe-delete'],
  [{ type: 'failed', code: 2, message: 'The install step of safe-delete exited 2: no Homebrew.' }, 'failed 2\tThe install step of safe-delete exited 2: no Homebrew.'],
  [{ type: 'retries', when: 'later' }, 'retries later'],
]

test('each event line keeps the shape @cmodjs/core 4.0.0 reads, because a newer cmod program sets up every older mod', () => {
  for (const [event, line] of linesSince400) {
    expect(formatEvent(event)).toBe(line)
    expect(parseEvent(line)).toEqual(event)
  }
})

test('a line type a newer cmod adds reads as a log line, so an older mod skips it', () => {
  expect(parseEvent('restarts soon')).toEqual({ type: 'log', text: 'restarts soon' })
})

test('the consent hash of the same steps and scripts stays what @cmodjs/core 4.0.0 computes, so an update never asks again for what the person approved', async () => {
  const scripts: Record<string, string> = { 'setup/install.sh': 'brew install trash\n', 'setup/uninstall.sh': 'brew uninstall trash\n' }
  const steps: Steps = { install: './setup/install.sh', uninstall: './setup/uninstall.sh', program: 'trash', hotkeys: { cycle: { title: 'Switch mode', default: 'shift+tab' } }, permissions: ['prompt', 'network:api.github.com'] }
  const files = { read: async (path: string) => scripts[path.replace(/^\.\//, '')], list: async (folder: string) => Object.keys(scripts).filter((path) => path.startsWith(`${folder.replace(/^\.\//, '')}/`)).map((path) => path.slice(path.lastIndexOf('/') + 1)) }

  expect(await scriptsSha256(steps, files)).toBe('96f736d098a5ad1de83771adb885122f09b9dffd27ece7de603d86d1b0769934')
  scripts['setup/install.sh'] = 'brew install trash-cli\n'
  expect(await scriptsSha256(steps, files)).not.toBe('96f736d098a5ad1de83771adb885122f09b9dffd27ece7de603d86d1b0769934')
})

test('a mod answers every method the cmod plugin of @cmodjs/core 4.0.0, 4.1.0, and 4.1.1 calls on it', async () => {
  const tested = testMod(defineMod({ name: 'notes', setup() {} }))
  await tested.start()
  const methods = ['cmod:changed', 'cmod:before', 'cmod:parts', 'cmod:draw', 'cmod:press', 'cmod:shown', 'cmod:pendingSteps', 'cmod:finishSteps', 'cmod:markdownStylers', 'cmod:sessionColor']

  const refusal = async (method: string) => {
    const answer = await claudeCodeOf(tested)
      .fire('cmod.call', { to: 'notes', method, input: {}, caller: 'cmod' } as never)
      .catch((error: unknown) => ({ deny: String(error) }))
    return (answer as { deny?: string }).deny ?? ''
  }

  expect(await refusal('cmod:unheard')).toContain('has no method')
  for (const method of methods) expect(await refusal(method)).not.toContain('has no method')
})
