import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { cmod, deleteTemporaryHomes, temporaryHome, writeFiles } from './cmod.js'

afterEach(deleteTemporaryHomes)

test('try starts claude with the checkout loaded through --plugin-dir and passes the arguments after --', async () => {
  const home = await temporaryHome()
  await writeFiles(home, {
    'bin/claude': '#!/bin/sh\necho "claude $*"\n',
    'demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
  })

  const result = await cmod(home, 'try', join(home, 'demo'), '--', '-p', 'hello')

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toEndWith(`claude --plugin-dir ${join(home, 'demo')} -p hello\n`)
})
