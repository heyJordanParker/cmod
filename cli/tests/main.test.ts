import { afterAll, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { version } from '../package.json'
import { cmod, deleteTemporaryHomes, temporaryHome } from './cmod.js'

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

test('cmod with a name that is no command fails and lists the commands', async () => {
  const { exitCode, stdout, stderr } = await cmod(await temporaryHome(), 'nope')

  expect([exitCode, stdout]).toEqual([1, ''])
  expect(stderr).toStartWith('cmod: "nope" is not a command.\n\nUsage: cmod <command> [arguments]\n')
  expect(stderr).toContain(`\n  device      ${(await commands()).find(({ name }) => name === 'device')?.summary}\n`)
})

test("cmod <command> --help prints that command's help, and a failing command names itself", async () => {
  const home = await temporaryHome()
  const { help } = (await commands()).find(({ name }) => name === 'device') as { help: string }

  expect(await cmod(home, 'device', '--help')).toEqual({ exitCode: 0, stdout: `${help}\n`, stderr: '' })
  expect(await cmod(home, 'device', 'extra')).toEqual({ exitCode: 1, stdout: '', stderr: `cmod device: cmod device takes no names.\n\n${help}\n` })
})
