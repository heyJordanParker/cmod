import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { readDevice } from '@cmodjs/core/src/runtime/device.js'
import { captured, claudeAnswering, cmod, deleteTemporaryHomes, spawningTestLimitMs, temporaryHome, writeFiles } from './cmod.js'

setDefaultTimeout(spawningTestLimitMs)
afterAll(deleteTemporaryHomes)

const userConfig = {
  folders: { type: 'string', multiple: true, title: 'Folders', description: 'The folders it reads' },
  depth: { type: 'number', title: 'Depth', description: 'How deep it looks', min: 1 },
  token: { type: 'string', sensitive: true, title: 'Token', description: 'The token' },
  mode: { type: 'string', title: 'Mode', description: 'How it runs' },
}

const configuringClaude = `#!/bin/sh
case "$*" in
  "plugin configure "*" --values-stdin --json") exec "${process.execPath}" -e '
    const path = process.env.HOME + "/.claude/settings.json"
    const settings = await Bun.file(path).json()
    const config = settings.pluginConfigs[process.argv.at(-1)]
    config.options = { ...config.options, ...JSON.parse(await Bun.stdin.text()) }
    await Bun.write(path, JSON.stringify(settings))
  ' "$3" ;;
  *) exec "$HOME/bin/claude-listing" "$@" ;;
esac
`

async function demoHome() {
  const home = await temporaryHome()
  const listed = [{ id: 'demo@market', version: '1.0.0', scope: 'user', enabled: true, installPath: join(home, 'plugins/demo') }]
  await writeFiles(home, {
    'bin/claude': configuringClaude,
    'bin/claude-listing': claudeAnswering(listed),
    'plugins/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0', userConfig }),
    '.claude/settings.json': JSON.stringify({ pluginConfigs: { 'demo@market': { options: { folders: ['~/notes'], token: 'kept-out' } } } }),
    'repo/.claude/cmods/demo/options.json': JSON.stringify({ folders: ['plans'], depth: 0, branch: 'main' }),
    'repo/src/index.ts': '',
    'loose/.claude/cmods/demo/options.json': JSON.stringify({ depth: 3 }),
  })
  expect((await captured(['git', 'init', '-q', join(home, 'repo')])).exitCode).toBe(0)
  return home
}

test("cmod options get prints your values and each project's, keyed by the project's git root, and leaves out secrets and entries the mod would ignore", async () => {
  const home = await demoHome()

  const { exitCode, stdout, stderr } = await cmod(home, 'options', 'get', 'demo', '--project', join(home, 'repo/src'), '--project', join(home, 'loose'), '--json')

  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout)).toEqual({ person: { folders: ['~/notes'] }, projects: { [join(home, 'repo')]: { folders: ['plans'] }, [join(home, 'loose')]: { depth: 3 } } })
  expect(stderr).toContain('sets depth to 0, and Depth takes 1 or more.')
  expect(stderr).toContain('sets branch, which demo does not declare.')
})

test('cmod options get with no --project reads every project the conversation index holds a session of', async () => {
  const home = await demoHome()
  const row = { type: 'user', cwd: join(home, 'repo'), sessionId: 'session-1', timestamp: '2026-11-03T09:00:00.000Z', uuid: 'row-1', message: { role: 'user', content: 'hi' } }
  await writeFiles(home, { [`.claude/projects/${join(home, 'repo').replace(/[^A-Za-z0-9]/g, '-')}/session-1.jsonl`]: `${JSON.stringify(row)}\n` })
  expect((await cmod(home, 'sessions', 'index')).exitCode).toBe(0)

  const { exitCode, stdout } = await cmod(home, 'options', 'get', 'demo', '--json')

  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout)).toEqual({ person: { folders: ['~/notes'] }, projects: { [join(home, 'repo')]: { folders: ['plans'] } } })
})

test('cmod options set sets your value through Claude Code, and cmod options get then prints it', async () => {
  const home = await demoHome()

  const set = await cmod(home, 'options', 'set', 'demo', 'mode', 'fast')
  const { exitCode, stdout } = await cmod(home, 'options', 'get', 'demo', '--project', join(home, 'loose'), '--json')

  expect(set).toEqual({ exitCode: 0, stdout: 'Set mode for demo.\n', stderr: '' })
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout).person).toEqual({ folders: ['~/notes'], mode: 'fast' })
})

test('cmod options <mod> and cmod option <mod> <key> <value>, which released sessions run, still print and set the values', async () => {
  const home = await demoHome()

  const set = await cmod(home, 'option', 'demo', 'mode', 'fast')
  const { exitCode, stdout } = await cmod(home, 'options', 'demo', '--project', join(home, 'loose'), '--json')
  const missing = await cmod(home, 'option', 'demo', 'colour', 'red')

  expect(set).toEqual({ exitCode: 0, stdout: 'Set mode for demo.\n', stderr: '' })
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout).person).toEqual({ folders: ['~/notes'], mode: 'fast' })
  expect(missing).toEqual({ exitCode: 1, stdout: '', stderr: 'cmod option: demo has no option colour. Its options are: folders, depth, token, mode.\n' })
})

test('cmod options set without its arguments shows the help instead of reading a mod named set', async () => {
  const home = await demoHome()

  const bare = await cmod(home, 'options', 'set')

  expect(bare.exitCode).toBe(1)
  expect(bare.stderr).toStartWith('cmod options: cmod options takes get <mod>, or set <mod> <key> <value>.\n\nUsage: cmod options get <mod>')
})

test('cmod options get runs git only for a project with an options.json in its folder or a folder above it', async () => {
  const home = await demoHome()
  await writeFiles(home, { 'bin/git': `#!/bin/sh\necho "$2" >> "$HOME/git.log"\nexec ${Bun.which('git')} "$@"\n`, 'plain/README.md': '' })

  const { exitCode, stdout } = await cmod(home, 'options', 'get', 'demo', '--project', join(home, 'repo/src'), '--project', join(home, 'plain'), '--project', join(home, 'loose'), '--json')

  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout).projects).toEqual({ [join(home, 'repo')]: { folders: ['plans'] }, [join(home, 'loose')]: { depth: 3 } })
  expect(await Bun.file(join(home, 'git.log')).text()).toBe(`${join(home, 'repo/src')}\n${join(home, 'loose')}\n`)
})

test('cmod options get names the installed plugins when no plugin has the name', async () => {
  const home = await demoHome()

  const { exitCode, stderr } = await cmod(home, 'options', 'get', 'nothere', '--json')

  expect(exitCode).toBe(1)
  expect(stderr).toBe('cmod options: No installed plugin is named nothere. cmod list shows the installed plugins.\n')
})

test('cmod device prints the device a mod reads with device.read()', async () => {
  const home = await temporaryHome()

  const { exitCode, stdout } = await cmod(home, 'device', '--json')
  const read = await readDevice({ process: { run: (argv) => captured([...argv]) }, fs: { read: (path) => Bun.file(path).text() } }, join(home, '.local/share/cmod'))

  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout)).toEqual(read)
  expect(read.id).toMatch(/^[0-9a-f]{32}$/)
})
