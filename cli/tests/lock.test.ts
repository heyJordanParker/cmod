import { afterAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { readRecord } from '@cmodjs/core/src/records.js'
import { readText } from '../src/files.js'
import { takeLock } from '../src/store.js'
import { cmod, createMod, deleteTemporaryHomes, goneProcessId, hashOf, isGone, lockNotice, startCmod, startCmodInTerminal, startOf, temporaryHome, waitFor, writeFiles } from './cmod.js'

afterAll(deleteTemporaryHomes)

test.concurrent('concurrent setups of eight mods keep every approval', async () => {
  const home = await temporaryHome()
  const names = Array.from({ length: 8 }, (_, index) => `mod-${index}`)
  const roots = names.map((name) => join(home, name))
  for (const [index, name] of names.entries()) {
    await writeFiles(roots[index] as string, {
      '.claude-plugin/plugin.json': JSON.stringify({ name, version: '0.1.0' }),
      'package.json': JSON.stringify({ name, cmod: { install: './setup/install.sh' } }),
      'setup/install.sh': '#!/bin/sh\ntrue\n',
    })
  }
  const hashes = await Promise.all(roots.map((root) => hashOf(root)))

  const results = await Promise.all(roots.map((root) => cmod(home, 'setup', root, '--events')))

  expect(results.map((result) => result.exitCode)).toEqual(names.map(() => 0))
  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/consent.json'), 'utf8'))).toEqual(Object.fromEntries(names.map((name, index) => [name, [hashes[index]]])))
}, 15_000)

test.concurrent('six concurrent setups of one mod run the install step once and all exit 0', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\nsleep 0.3\necho ran >> "$CMOD_DATA/runs"\n')
  const store = join(home, '.local/share/cmod')

  const results = await Promise.all(Array.from({ length: 6 }, () => cmod(home, 'setup', root, '--events')))

  expect(results.map((result) => ({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr.replace(/^Waiting for .+, which process \d+ holds\.\n$/, '') }))).toEqual(Array.from({ length: 6 }, () => ({ exitCode: 0, stdout: 'done demo 0.1.0\n', stderr: '' })))
  expect(await readFile(join(store, 'data/demo/runs'), 'utf8')).toBe('ran\n')
  expect(await readdir(join(store, 'uninstall'))).toEqual(['demo'])
  expect(await readdir(join(store, 'records'))).toEqual(['demo.json'])
}, 15_000)

test.concurrent('a setup deletes the staged uninstall folders a killed setup left', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const store = join(home, '.local/share/cmod')
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  await writeFiles(store, { 'uninstall/demo.tmp/uninstall.sh': 'left by a killed setup\n', 'uninstall/demo.old/uninstall.sh': 'left by a killed setup\n' })
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }) })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toEndWith('done demo 0.2.0\n')
  expect(await readdir(join(store, 'uninstall'))).toEqual(['demo'])
})

test.concurrent('a setup takes over a lock whose process is gone', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const lock = join(home, '.local/share/cmod/records/demo.json.lock')
  await writeFiles(lock, { [String(await goneProcessId())]: '' })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toEndWith('done demo 0.1.0\n')
  expect(result.exitCode).toBe(0)
  expect(existsSync(lock)).toBe(false)
})

test.concurrent('a stale consent lock whose process is gone does not stall setup', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const lock = join(home, '.local/share/cmod/consent.json.lock')
  await writeFiles(lock, { [String(await goneProcessId())]: '' })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toEndWith('done demo 0.1.0\n')
  expect(result.exitCode).toBe(0)
  expect(existsSync(lock)).toBe(false)
}, 5_000)

test.concurrent('a lock held by a live process that is not its holder is taken over', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const lock = join(home, '.local/share/cmod/records/demo.json.lock')
  await writeFiles(lock, { '1': 'Thu Jan  1 00:00:00 2026' })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toEndWith('done demo 0.1.0\n')
  expect(existsSync(lock)).toBe(false)
})

test.concurrent('a setup that waits for a lock names the lock after a few seconds', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const holder = Bun.spawn(['sleep', '30'])
  await writeFiles(join(home, '.local/share/cmod/records/demo.json.lock'), { [String(holder.pid)]: await startOf(holder.pid) })
  const setup = startCmod(home, 'setup', root, '--events')
  await setup.waitForOutput(lockNotice)

  holder.kill()
  await holder.exited
  const result = await setup.done

  expect(result.stderr).toBe(`${lockNotice}, which process ${holder.pid} holds.\n`)
  expect(result.stdout).toEndWith('done demo 0.1.0\n')
}, 10_000)

test.concurrent('the spinner resumes after the lock-wait notice', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\n')
  const holder = Bun.spawn(['sleep', '30'])
  await writeFiles(join(home, '.local/share/cmod/records/demo.json.lock'), { [String(holder.pid)]: await startOf(holder.pid) })
  const setup = startCmodInTerminal(home, 'setup', root)
  await setup.waitForOutput(lockNotice)

  holder.kill()
  await holder.exited
  const { stdout } = await setup.done

  const shown = stripVTControlCharacters(stdout)
  expect(shown.slice(shown.indexOf('which process'))).toContain('Installing demo…')
}, 10_000)

test.concurrent('a lock whose holder recorded no start time is held while its process lives', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const holder = Bun.spawn(['sleep', '30'])
  await writeFiles(join(home, '.local/share/cmod/records/demo.json.lock'), { [String(holder.pid)]: '' })
  const setup = startCmod(home, 'setup', root, '--events')
  await setup.waitForOutput(lockNotice)

  holder.kill()
  await holder.exited
  const result = await setup.done

  expect(result.stderr).toBe(`${lockNotice}, which process ${holder.pid} holds.\n`)
  expect(result.stdout).toEndWith('done demo 0.1.0\n')
}, 10_000)

test.concurrent("a holder file with cmod's own process ID is not held", async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const lock = join(home, '.local/share/cmod/records/demo.json.lock')
  const holder = Bun.spawn(['sleep', '30'])
  await writeFiles(lock, { [String(holder.pid)]: await startOf(holder.pid) })
  const setup = startCmod(home, 'setup', root, '--events')
  await writeFiles(lock, { [String(setup.child.pid)]: '' })

  holder.kill()
  await holder.exited
  const result = await setup.done

  expect(result.stdout).toEndWith('done demo 0.1.0\n')
  expect(existsSync(lock)).toBe(false)
}, 10_000)

test.concurrent('a second take of a lock in the same process waits until the first releases it', async () => {
  const lock = join(await temporaryHome(), '.local/share/cmod/builds/demo.lock')
  const events: string[] = []
  const first = await takeLock(lock)
  const second = takeLock(lock).then((taken) => {
    events.push('second took')
    return taken
  })
  await Bun.sleep(300)

  events.push('first released')
  await first[Symbol.asyncDispose]()
  await (await second)[Symbol.asyncDispose]()

  expect(events).toEqual(['first released', 'second took'])
  expect(existsSync(lock)).toBe(false)
})

test.concurrent('four processes taking one lock over and over never take it from each other', async () => {
  const home = await temporaryHome()
  const lock = join(home, '.local/share/cmod/builds/demo.lock')
  const log = join(home, 'log')
  await writeFiles(home, {
    'taker.ts': `import { appendFileSync } from 'node:fs'\nimport { takeLock } from ${JSON.stringify(join(import.meta.dir, '../src/store.ts'))}\nfor (let round = 0; round < 500; round += 1) {\n  const held = await takeLock(${JSON.stringify(lock)})\n  appendFileSync(${JSON.stringify(log)}, 'in\\n')\n  await Bun.sleep(1)\n  appendFileSync(${JSON.stringify(log)}, 'out\\n')\n  await held[Symbol.asyncDispose]()\n}\n`,
  })
  const takers = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, join(home, 'taker.ts')], { env: { ...process.env, HOME: home }, stderr: 'pipe' }))

  const results = await Promise.all(takers.map(async (taker) => ({ exitCode: await taker.exited, stderr: (await new Response(taker.stderr).text()).replace(/^Waiting for .+, which process \d+ holds\.\n/gm, '') })))

  expect(results).toEqual(takers.map(() => ({ exitCode: 0, stderr: '' })))
  expect((await readFile(log, 'utf8')).replaceAll('in\nout\n', '')).toBe('')
}, 30_000)

test.concurrent('a take that does not wait gets nothing while its own process holds the lock', async () => {
  const lock = join(await temporaryHome(), '.local/share/cmod/watch.lock')
  const held = await takeLock(lock)

  const again = await takeLock(lock, AbortSignal.abort())
  await held[Symbol.asyncDispose]()

  expect(again).toBeUndefined()
  expect(existsSync(lock)).toBe(false)
})

test.concurrent('Ctrl+C while cmod remove waits for the lock prints a cancel line', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const store = join(home, '.local/share/cmod')
  expect((await cmod(home, 'setup', root)).exitCode).toBe(0)
  const holder = Bun.spawn(['sleep', '30'])
  await writeFiles(join(store, 'records/demo.json.lock'), { [String(holder.pid)]: await startOf(holder.pid) })
  const removal = startCmod(home, 'remove', 'demo')
  await removal.waitForOutput(lockNotice)

  removal.child.kill('SIGINT')
  const result = await removal.done
  holder.kill()

  expect(result.exitCode).toBe(130)
  expect(result.stdout).toContain('✘ Cancelled uninstalling demo on SIGINT, before its uninstall step started. Run cmod teardown demo to finish.')
  expect(existsSync(join(store, 'records/demo.json'))).toBe(true)
}, 15_000)

test.concurrent('Ctrl+C while cmod waits for a lock ends it at once', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const store = join(home, '.local/share/cmod')
  const holder = Bun.spawn(['sleep', '30'])
  await writeFiles(join(store, 'records/demo.json.lock'), { [String(holder.pid)]: await startOf(holder.pid) })
  const setup = startCmod(home, 'setup', root)
  await setup.waitForOutput(lockNotice)

  const cancelledAt = Date.now()
  setup.child.kill('SIGINT')
  const result = await setup.done
  const waitedMs = Date.now() - cancelledAt
  holder.kill()

  expect(result.exitCode).toBe(130)
  expect(waitedMs).toBeLessThan(1000)
  expect(result.stdout).toContain('Cancelled setting up demo on SIGINT, before its install step started.')
  expect(result.stdout).not.toContain('Cancelled on')
  for (const path of [join(store, 'data/demo'), join(store, 'records/demo.json'), join(store, 'uninstall/demo')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
}, 10_000)

test.concurrent('a mod whose scripts change while its setup waits runs the changed scripts once the first setup ends', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\ntouch "$HOME/installing"\nwhile [ -d "$HOME" ] && [ ! -e "$HOME/finish" ]; do sleep 0.01; done\necho ran >> "$CMOD_DATA/runs"\n')
  const first = startCmod(home, 'setup', root, '--events')
  await waitFor(join(home, 'installing'))
  const second = startCmod(home, 'setup', root, '--events')
  await second.waitForOutput(lockNotice)
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\necho "uninstalled again" >> "$HOME/uninstalls"\n' })
  const changed = await hashOf(root)
  await writeFiles(home, { finish: '' })

  const rerun = await second.done

  expect((await first.done).stdout).toBe('done demo 0.1.0\n')
  expect(rerun).toMatchObject({ stdout: expect.stringContaining('done demo 0.1.0\n'), exitCode: 0 })
  expect(await readFile(join(home, '.local/share/cmod/data/demo/runs'), 'utf8')).toBe('ran\nran\n')
  expect((await readRecord(readText, join(home, '.local/share/cmod'), 'demo'))?.scriptsSha256).toBe(changed)
}, 15_000)
