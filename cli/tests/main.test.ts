import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { version } from '../package.json'
import { cmod, deleteTemporaryHomes, spawningTestLimitMs, temporaryHome } from './cmod.js'

setDefaultTimeout(spawningTestLimitMs)
afterAll(deleteTemporaryHomes)

const commandsFolder = join(import.meta.dir, '..', 'src', 'commands')

async function commands(): Promise<{ name: string; summary: string; help: string }[]> {
  const files = (await readdir(commandsFolder)).filter((file) => file.endsWith('.ts')).sort()
  return Promise.all(files.map(async (file) => ({ name: basename(file, '.ts'), ...((await import(join(commandsFolder, file))) as { summary: string; help: string }) })))
}

test('cmod --version prints the version', async () => {
  expect(await cmod(await temporaryHome(), '--version')).toEqual({ exitCode: 0, stdout: `${version}\n`, stderr: '' })
})

test('cmod --help lists every command with its summary', async () => {
  const { exitCode, stdout } = await cmod(await temporaryHome(), '--help')

  expect(exitCode).toBe(0)
  for (const { name, summary } of await commands()) expect(stdout).toContain(`\n  ${name.padEnd(12)}${summary}\n`)
})

test('cmod --help leaves out option, secret, history, and hotkey, which released sessions still run as options set, secrets, sessions, and hotkeys set', async () => {
  const { stdout } = await cmod(await temporaryHome(), '--help')

  for (const name of ['options', 'secrets', 'sessions', 'hotkeys', 'settings', 'rules']) expect(stdout).toContain(`\n  ${name.padEnd(12)}`)
  for (const name of ['option', 'secret', 'history', 'hotkey']) expect(stdout).not.toContain(`\n  ${name} `)
})

test('cmod with a name that is no command fails and lists the commands', async () => {
  const { exitCode, stdout, stderr } = await cmod(await temporaryHome(), 'nope')

  expect([exitCode, stdout]).toEqual([1, ''])
  expect(stderr).toStartWith('cmod: "nope" is not a command.\n\nUsage: cmod <command> [arguments]\n')
  expect(stderr).toContain(`\n  device      ${(await commands()).find(({ name }) => name === 'device')?.summary}\n`)
})

const runBySessions: Readonly<Record<string, readonly string[]>> = {
  setup: [],
  option: [],
  options: ['get', 'set'],
  update: [],
  list: [],
  enable: [],
  disable: [],
  remove: [],
  teardown: [],
  hotkey: [],
  hotkeys: ['set'],
  settings: ['update'],
  rules: ['sync'],
  watch: [],
  device: [],
  program: [],
  secret: ['store', 'get', 'delete'],
  secrets: ['store', 'get', 'delete'],
  task: ['start'],
  serve: [],
  web: ['serve'],
  history: ['sessions', 'follow', 'state', 'usage', 'search', 'messages', 'turns', 'contexts', 'tasks', 'goal', 'index'],
  sessions: ['list', 'search', 'read', 'follow', 'index'],
  ui: ['list', 'draw', 'press', 'open', 'close', 'show', 'follow'],
}

const renamedSubcommands: Readonly<Record<string, string>> = {
  'history sessions': 'list',
  'history state': 'read state',
  'history usage': 'read usage',
  'history messages': 'read messages',
  'history turns': 'read turns',
  'history contexts': 'read contexts',
  'history tasks': 'read tasks',
  'history goal': 'read goal',
}

test('every command and subcommand a released session runs is still a command, because every session runs the newest cmod program', async () => {
  const home = await temporaryHome()
  for (const [name, subcommands] of Object.entries(runBySessions)) {
    const { exitCode, stdout } = await cmod(home, name, '--help')
    const runs = /^Usage: cmod (\S+)/.exec(stdout)?.[1]
    expect([name, exitCode]).toEqual([name, 0])
    for (const subcommand of subcommands) expect(stdout).toContain(`cmod ${runs} ${renamedSubcommands[`${name} ${subcommand}`] ?? subcommand}`)
  }
})

test("cmod <command> --help prints that command's help, and a failing command names itself", async () => {
  const home = await temporaryHome()
  const { help } = (await commands()).find(({ name }) => name === 'device') as { help: string }

  expect(await cmod(home, 'device', '--help')).toEqual({ exitCode: 0, stdout: `${help}\n`, stderr: '' })
  expect(await cmod(home, 'device', 'extra')).toEqual({ exitCode: 1, stdout: '', stderr: `cmod device: cmod device takes no names.\n\n${help}\n` })
})
