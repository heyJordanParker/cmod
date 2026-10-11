import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cmod, deleteTemporaryHomes, hashOf, temporaryHome, writeFiles } from './cmod.js'

afterEach(deleteTemporaryHomes)

async function setUpKeeper(home: string): Promise<{ project: string }> {
  const root = join(home, 'keeper')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'keeper', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'keeper', cmod: { permissions: { config: ['cleanupPeriodDays', 'mcpServers', 'statusLine'] } } }),
  })
  expect((await cmod(home, 'setup', root, '--events', '--consent', await hashOf(root))).exitCode).toBe(0)
  return { project: join(home, 'work/app') }
}

const read = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'))

test('settings writes each key into the named settings file, keeps the rest of the file and its formatting, and puts project mcpServers in .mcp.json', async () => {
  const home = await temporaryHome()
  const { project } = await setUpKeeper(home)
  await writeFiles(home, { '.claude/settings.json': '{\n    "model": "opus"\n}\n' })

  const user = await cmod(home, 'settings', 'keeper', 'user', '{"cleanupPeriodDays":365}')
  const projectChange = await cmod(home, 'settings', 'keeper', 'project', '{"statusLine":{"type":"command","command":"keeper-line"},"mcpServers":{"keeper":{"command":"keeper-mcp"}}}', '--project', project)

  expect(user).toEqual({ exitCode: 0, stdout: 'Changed cleanupPeriodDays in ~/.claude/settings.json for keeper.\n', stderr: '' })
  expect(projectChange.stdout).toBe('Changed statusLine in ~/work/app/.claude/settings.json for keeper.\nChanged mcpServers in ~/work/app/.mcp.json for keeper.\n')
  expect(await readFile(join(home, '.claude/settings.json'), 'utf8')).toBe('{\n    "model": "opus",\n    "cleanupPeriodDays": 365\n}\n')
  expect(await read(join(project, '.claude/settings.json'))).toEqual({ statusLine: { type: 'command', command: 'keeper-line' } })
  expect(await read(join(project, '.mcp.json'))).toEqual({ mcpServers: { keeper: { command: 'keeper-mcp' } } })
})

test('settings refuses a key the mod has no grant for and names the line to add, changing nothing', async () => {
  const home = await temporaryHome()
  await setUpKeeper(home)

  const refused = await cmod(home, 'settings', 'keeper', 'user', '{"cleanupPeriodDays":365,"model":"haiku"}')

  expect(refused.exitCode).toBe(1)
  expect(refused.stderr).toContain('keeper has no grant to "Change model in your Claude Code settings". It needs "permissions": { "config": ["model"] } in package.json "cmod", turned on in /mods keeper.')
  expect(existsSync(join(home, '.claude/settings.json'))).toBe(false)
})

test('a null value removes the key, and teardown takes out only the values that still equal what the mod set', async () => {
  const home = await temporaryHome()
  const { project } = await setUpKeeper(home)
  await writeFiles(home, { '.claude/settings.json': '{ "model": "opus" }\n' })
  await cmod(home, 'settings', 'keeper', 'user', '{"cleanupPeriodDays":365,"statusLine":{"type":"command","command":"keeper-line"}}')
  await cmod(home, 'settings', 'keeper', 'project', '{"statusLine":{"type":"command","command":"keeper-line"}}', '--project', project)
  await cmod(home, 'settings', 'keeper', 'project', '{"statusLine":null}', '--project', project)
  const edited = (await read(join(home, '.claude/settings.json'))) as Record<string, unknown>
  await writeFiles(home, { '.claude/settings.json': JSON.stringify({ ...edited, cleanupPeriodDays: 90 }) })

  expect(await read(join(project, '.claude/settings.json'))).toEqual({})
  expect((await cmod(home, 'teardown', 'keeper')).exitCode).toBe(0)

  expect(await read(join(home, '.claude/settings.json'))).toEqual({ model: 'opus', cleanupPeriodDays: 90 })
  expect(existsSync(join(home, '.local/share/cmod/settings/keeper.json'))).toBe(false)
})
