import { afterAll, expect, test } from 'bun:test'
import { cmod, deleteTemporaryHomes, temporaryHome, writeFiles } from './cmod.js'

afterAll(deleteTemporaryHomes)

const versions = { mod: '1.2.0', core: '5.4.2', cmod: '5.4.2', program: '5.4.2', claudeCode: '2.1.317' }

const reloadFailure = { mod: 'cmod', id: 'reload', level: 'error', message: 'Could not reload the plugins', details: 'cmod: $.command.run: the session was stopped', at: '2026-11-03T21:10:00.000Z', firstAt: '2026-11-03T21:02:00.000Z', count: 3, session: 'session-b', versions }

async function homeWithLog() {
  const home = await temporaryHome()
  await writeFiles(home, {
    '.local/share/cmod/data/cmod/log/session-a.json': JSON.stringify([
      { mod: 'tracer', id: 'index', level: 'warning', message: 'tracer skipped an index', details: 'tracer: the index is locked', at: '2026-11-03T20:00:00.000Z', session: 'session-a', versions },
      { mod: 'cmod', id: 'reload', level: 'error', message: 'Could not reload the plugins', details: 'an older reload failure', at: '2026-11-03T19:00:00.000Z', session: 'session-a', versions },
    ]),
    '.local/share/cmod/data/cmod/log/session-b.json': JSON.stringify([reloadFailure]),
  })
  return home
}

test("cmod log prints each mod's newest failure and warning across sessions, newest first, with the versions it happened on", async () => {
  const home = await homeWithLog()

  const { exitCode, stdout } = await cmod(home, 'log')

  expect(exitCode).toBe(0)
  expect(stdout).toBe(
    [
      '2026-11-03T21:10:00.000Z  error  cmod  Could not reload the plugins',
      '  cmod: $.command.run: the session was stopped',
      '',
      '  mod 1.2.0 · @cmodjs/core 5.4.2 · cmod 5.4.2 · cmod program 5.4.2 · Claude Code 2.1.317',
      '  3 times in session session-b, first at 2026-11-03T21:02:00.000Z',
      '',
      '2026-11-03T20:00:00.000Z  warning  tracer  tracer skipped an index',
      '  tracer: the index is locked',
      '',
      '  mod 1.2.0 · @cmodjs/core 5.4.2 · cmod 5.4.2 · cmod program 5.4.2 · Claude Code 2.1.317',
      '',
    ].join('\n'),
  )
})

test("cmod log <mod> --json prints only that mod's entries as data", async () => {
  const home = await homeWithLog()

  const { exitCode, stdout } = await cmod(home, 'log', 'cmod', '--json')

  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout)).toEqual([reloadFailure])
})

test('cmod log says no mod has failed when the Log is empty', async () => {
  const home = await temporaryHome()

  const { exitCode, stdout } = await cmod(home, 'log')

  expect(exitCode).toBe(0)
  expect(stdout).toBe('No mod has failed.\n')
})
