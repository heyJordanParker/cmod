import { afterAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readDevice } from '@cmodjs/core/src/runtime/device.js'
import { capture } from '../src/process.js'
import { claudeAnswering, cmod, deleteTemporaryHomes, temporaryHome, writeFiles } from './cmod.js'

afterAll(deleteTemporaryHomes)

const userConfig = {
  folders: { type: 'string', multiple: true, title: 'Folders', description: 'The folders it reads' },
  depth: { type: 'number', title: 'Depth', description: 'How deep it looks', min: 1 },
  token: { type: 'string', sensitive: true, title: 'Token', description: 'The token' },
}

async function demoHome() {
  const home = await temporaryHome()
  const listed = [{ id: 'demo@market', version: '1.0.0', scope: 'user', enabled: true, installPath: join(home, 'plugins/demo') }]
  await writeFiles(home, {
    'bin/claude': claudeAnswering(listed),
    'plugins/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0', userConfig }),
    '.claude/settings.json': JSON.stringify({ pluginConfigs: { 'demo@market': { options: { folders: ['~/notes'], token: 'kept-out' } } } }),
    'repo/.claude/cmods/demo/options.json': JSON.stringify({ folders: ['plans'], depth: 0, branch: 'main' }),
    'repo/src/index.ts': '',
    'loose/.claude/cmods/demo/options.json': JSON.stringify({ depth: 3 }),
  })
  expect((await capture(['git', 'init', '-q', join(home, 'repo')])).exitCode).toBe(0)
  return home
}

test("cmod options prints your values and each project's, keyed by the project's git root, and leaves out secrets and entries the mod would ignore", async () => {
  const home = await demoHome()

  const { exitCode, stdout, stderr } = await cmod(home, 'options', 'demo', '--project', join(home, 'repo/src'), '--project', join(home, 'loose'), '--json')

  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout)).toEqual({ person: { folders: ['~/notes'] }, projects: { [join(home, 'repo')]: { folders: ['plans'] }, [join(home, 'loose')]: { depth: 3 } } })
  expect(stderr).toContain('sets depth to 0, and Depth takes 1 or more.')
  expect(stderr).toContain('sets branch, which demo does not declare.')
})

test('cmod options with no --project reads every project the conversation index holds a session of', async () => {
  const home = await demoHome()
  const row = { type: 'user', cwd: join(home, 'repo'), sessionId: 'session-1', timestamp: '2026-11-03T09:00:00.000Z', uuid: 'row-1', message: { role: 'user', content: 'hi' } }
  await writeFiles(home, { [`.claude/projects/${join(home, 'repo').replace(/[^A-Za-z0-9]/g, '-')}/session-1.jsonl`]: `${JSON.stringify(row)}\n` })
  expect((await cmod(home, 'history', 'index')).exitCode).toBe(0)

  const { exitCode, stdout } = await cmod(home, 'options', 'demo', '--json')

  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout)).toEqual({ person: { folders: ['~/notes'] }, projects: { [join(home, 'repo')]: { folders: ['plans'] } } })
})

test('cmod options runs git only for a project with an options.json in its folder or a folder above it', async () => {
  const home = await demoHome()
  await writeFiles(home, { 'bin/git': `#!/bin/sh\necho "$2" >> "$HOME/git.log"\nexec ${Bun.which('git')} "$@"\n`, 'plain/README.md': '' })

  const { exitCode, stdout } = await cmod(home, 'options', 'demo', '--project', join(home, 'repo/src'), '--project', join(home, 'plain'), '--project', join(home, 'loose'), '--json')

  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout).projects).toEqual({ [join(home, 'repo')]: { folders: ['plans'] }, [join(home, 'loose')]: { depth: 3 } })
  expect(await Bun.file(join(home, 'git.log')).text()).toBe(`${join(home, 'repo/src')}\n${join(home, 'loose')}\n`)
})

test('cmod options names the installed plugins when no plugin has the name', async () => {
  const home = await demoHome()

  const { exitCode, stderr } = await cmod(home, 'options', 'nothere', '--json')

  expect(exitCode).toBe(1)
  expect(stderr).toBe('cmod options: No installed plugin is named nothere. cmod list shows the installed plugins.\n')
})

test('cmod device prints the device a mod reads with device.read()', async () => {
  const home = await temporaryHome()

  const { exitCode, stdout } = await cmod(home, 'device', '--json')
  const read = await readDevice({ process: { run: (argv) => capture([...argv]) }, fs: { read: (path) => Bun.file(path).text() } })

  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout)).toEqual(read)
  expect(read.id).toMatch(/^[0-9a-f]{32}$/)
})
