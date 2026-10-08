import { expect, test } from 'bun:test'
import { defineMod, type Mod } from '../../src/mod.js'
import { testMod } from '../../src/testing.js'

const programs = '/test/home/.local/share/cmod/programs'
const ran = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

function started(files: Record<string, string>) {
  let mod: Mod | undefined
  const tested = testMod(defineMod({ name: 'tracer', setup: (started) => void (mod = started) }), { permissions: ['run:trace', 'run:git'], files })
  const argvs: (readonly string[])[] = []
  tested.fakes.process.run = async (argv) => (argvs.push(argv), ran)
  tested.fakes.process.spawn = (request) => {
    argvs.push(request.argv)
    return (async function* () {
      yield* []
      return { code: 0, signal: null }
    })() as never
  }
  return { tested, argvs, mod: () => mod as Mod }
}

test("a program cmod installed runs cmod's copy by its name, whatever PATH holds", async () => {
  const { tested, argvs, mod } = started({ [`${programs}/trace`]: '#!/bin/sh\n' })
  await tested.start()

  await mod().process.run(['trace', '--version'])
  for await (const piece of mod().process.spawn(['trace', 'serve'])) void piece

  expect(argvs).toEqual([
    [`${programs}/trace`, '--version'],
    [`${programs}/trace`, 'serve'],
  ])
})

test('a program cmod did not install, or one named by its path, runs as given', async () => {
  const { tested, argvs, mod } = started({ [`${programs}/trace`]: '#!/bin/sh\n' })
  await tested.start()

  await mod().process.run(['git', 'status'])
  await mod().process.run(['/usr/bin/trace', '-h'])

  expect(argvs).toEqual([
    ['git', 'status'],
    ['/usr/bin/trace', '-h'],
  ])
})
